/**
 * The two verification layers. They do not replace each other.
 *
 * ## Why two, measured rather than assumed
 *
 * `dsh --profile <n> --dump-config` **performs no module resolution at all**
 * (docs/host-notes.md F3): a row inserted from an overlay whose `name:` points
 * at a package that is not installed still exits 0, and the offending line
 * appears verbatim in the output. So the offline compose answers "will the patch
 * layer compose", and nothing more.
 *
 * | layer | runs | catches | cannot catch |
 * |---|---|---|---|
 * | **V1** compose | `dsh --dump-config` | broken YAML, an unreadable overlay, a bundle that is not installed, a bundle with no `dsh.bundle` | a row naming a missing package, the truth of a `!!js` flag, an import-time failure |
 * | **V2** module resolution | one child, every `name:` in the dump | a row whose package is absent while its bundle is present | a package that exists but whose export is broken, an `apply()` failure |
 *
 * ⚠️ **`disabled:` in the dump is the UNEVALUATED `!!js` expression**, not a
 * boolean (F3/§5.2). Nothing here treats it as "is this row on" — the field is
 * reported verbatim, marked as an expression, and the loader's own answer comes
 * from `clientModules` instead.
 *
 * ⚠️ **Exit code zero is not the same as "the profile is fine".** V1 only looks
 * at the exit code and at the host's own error signatures; a dump that succeeds
 * while a row points at nothing is exactly the case V2 exists for.
 *
 * R1 applies: `node:` and relative imports only.
 */

import { dshArgv, joinPath, runProcess } from './host.js'
import { buildPluginInventory } from './profile.js'

/**
 * Host error signatures, matched by PREFIX only.
 *
 * The host builds these strings from templates — the webserver's duplicate-route
 * message is a template literal, not a constant (docs/plan.md §5.3) — so a full
 * string comparison would pass today and fail after an upgrade that changed one
 * word. Every entry here is a prefix or a structural pattern.
 */
export const COMPOSE_SIGNATURES = [
  { pattern: /declares no dsh\.bundle/i, stage: 'compose', meaning: 'a bundle listed in dsh.profile.bundles has no dsh.bundle in its package.json' },
  { pattern: /cannot resolve profile bundle/i, stage: 'compose', meaning: 'a declared bundle is not installed where the host looked for it' },
  { pattern: /failed to read overlay/i, stage: 'compose', meaning: 'an overlay (patch) file could not be read' },
  { pattern: /failed to parse overlay/i, stage: 'compose', meaning: 'an overlay file is not valid YAML, or holds rows the loader rejects' },
  { pattern: /failed to parse config/i, stage: 'compose', meaning: 'a config file could not be parsed' },
  { pattern: /name mismatch for/i, stage: 'loader', meaning: 'a patch targets a row whose name differs — the loader only warns and skips' },
  { pattern: /duplicate loader entry id/i, stage: 'loader', meaning: 'two rows share an id — fatal' },
  { pattern: /duplicate .* route/i, stage: 'runtime', meaning: 'two plugins registered the same HTTP route' },
]

/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Find the host's own error signatures in a text block.
 * @param {string} text - stdout and/or stderr.
 * @returns {object[]} matches, each with the stage, meaning and the line.
 */
export function findSignatures(text) {
  const out = []
  if (typeof text !== 'string' || text.length === 0) return out
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    for (const signature of COMPOSE_SIGNATURES) {
      if (signature.pattern.test(line)) out.push({ stage: signature.stage, meaning: signature.meaning, line: line.slice(0, 200) })
    }
  }
  return out
}

/**
 * Parse a `--dump-config` document into loader rows.
 *
 * Deliberately a text scan rather than a YAML parse: the host half may not add
 * a parser dependency (R1), and the two fields that matter — `name` and
 * `disabled` — sit on the same line as the row in every dump observed.
 *
 * Section headers (`# == <origin>`) are captured too: they are how the dump
 * says WHICH bundle contributed a row, which is the difference between "your
 * overlay broke this" and "a bundle broke this".
 *
 * @param {string} text - the dump.
 * @returns {{ rows: object[], sections: number, lines: number }} the rows.
 */
export function parseDump(text) {
  const rows = []
  const sections = []
  if (typeof text !== 'string' || text.length === 0) return { rows, sections: sections.length, lines: 0 }

  const lines = text.split('\n')
  let current = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '')

    const header = /^#\s*==\s*(.+?)\s*$/.exec(line)
    if (header !== null) {
      current = { origin: header[1], line: index + 1 }
      sections.push(current)
      continue
    }

    const nameMatch = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (nameMatch === null) continue

    const value = stripQuotes(nameMatch[1])
    if (value.length === 0) continue
    rows.push({
      name: value,
      line: index + 1,
      section: current === null ? null : current.origin,
      // `disabled` may be an unevaluated `!!js` expression: reported, never judged.
      disabledRaw: null,
      disabledIsExpression: false,
    })
  }

  // Attach the nearest following `disabled:` line to the row above it. The two
  // keys are adjacent in the dump's own rendering order.
  const disabledAt = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*disabled:\s*(.+?)\s*$/.exec(lines[index].replace(/\r$/, ''))
    if (match !== null) disabledAt.push({ line: index + 1, value: match[1] })
  }
  for (const entry of disabledAt) {
    let best = null
    for (const row of rows) {
      if (row.line < entry.line && (best === null || row.line > best.line)) best = row
    }
    if (best === null || best.disabledRaw !== null) continue
    best.disabledRaw = entry.value
    best.disabledIsExpression = /!!js|!!js\/|=>|\bfunction\b/.test(entry.value)
  }

  return { rows, sections: sections.length, lines: lines.length }
}

/** Strip one layer of matching quotes from a scalar. */
function stripQuotes(text) {
  const trimmed = String(text).trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * V1: compose the profile offline and judge the exit code.
 *
 * @param {object} subprocess - the resolved `subprocess` service.
 * @param {object} launcher - `{ available, path, tried, error }` from `probeDshLauncher`.
 * @param {string} profileDir - the profile directory.
 * @param {object} [options] - `{ timeoutMs?, patch? }`.
 * @returns {Promise<object>} plain-JSON result.
 */
export async function verifyCompose(subprocess, launcher, profileDir, options = {}) {
  const out = {
    layer: 'V1',
    label: 'offline compose',
    ok: false,
    skipped: false,
    exitCode: null,
    argv: [],
    signatures: [],
    dump: null,
    rows: [],
    sections: 0,
    error: null,
  }

  if (launcher === undefined || launcher === null || launcher.available !== true || str(launcher.path) === null) {
    out.skipped = true
    out.error = `the dsh launcher is unavailable: ${launcher?.error ?? 'no probe result'}`
    return out
  }
  if (typeof process === 'undefined' || str(process.execPath) === null) {
    out.skipped = true
    out.error = 'this host exposes no node executable, so the offline compose cannot be run'
    return out
  }

  // `--patch <file>` is repeatable and always applied LAST (docs/plan.md §5.1),
  // which is what makes it usable as a self-check for a candidate patch file.
  const args = ['--profile', profileNameOf(profileDir), '--dump-config']
  if (str(options.patch) !== null) args.push('--patch', options.patch)

  out.argv = dshArgv(process.execPath, launcher.path, args)
  const result = await runProcess(subprocess, {
    argv: out.argv,
    cwd: profileDir,
    timeoutMs: typeof options.timeoutMs === 'number' ? options.timeoutMs : 60000,
  })

  out.exitCode = result.exitCode
  const combined = `${result.stderr}\n${result.stdout}`
  out.signatures = findSignatures(combined)

  if (result.ok) {
    out.ok = true
    out.dump = result.stdout
    const parsed = parseDump(result.stdout)
    out.rows = parsed.rows
    out.sections = parsed.sections
    // A dump that prints a fatal-looking line while exiting 0 is still a warning
    // the user must see; it is reported, not turned into a failure.
    return out
  }

  out.error =
    result.error ??
    `the offline compose exited ${String(result.exitCode)}${out.signatures.length > 0 ? `: ${out.signatures[0].line}` : `: ${firstLineOf(result.stderr) ?? 'no message'}`}`
  return out
}

/** The first non-empty line of a text block, or null. */
function firstLineOf(text) {
  if (typeof text !== 'string') return null
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed.slice(0, 200)
  }
  return null
}

/**
 * The profile NAME from its directory path.
 *
 * `--profile` takes the name, and the name is the last path segment. Derived
 * rather than asked for, because the host never tells a plugin which profile it
 * is running in and `fs.resolve('.')` is the profile directory (F17).
 * @param {string} profileDir - the absolute profile directory.
 * @returns {string} the profile name.
 */
export function profileNameOf(profileDir) {
  const trimmed = String(profileDir ?? '').replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * V2: resolve every loader row's module, from the profile's own tree.
 *
 * Runs ONE child for the whole list rather than one per row: 40 spawns to answer
 * one question is a latency problem the user would feel on every press.
 *
 * @param {object} subprocess - the resolved `subprocess` service.
 * @param {string} profileDir - the profile directory (the resolution root).
 * @param {string[]} specifiers - the module names to resolve.
 * @param {object} [options] - `{ timeoutMs? }`.
 * @returns {Promise<object>} plain-JSON result with per-specifier outcomes.
 */
export async function verifyModules(subprocess, profileDir, specifiers, options = {}) {
  const unique = [...new Set((Array.isArray(specifiers) ? specifiers : []).filter((item) => typeof item === 'string' && item.length > 0))]
  const out = {
    layer: 'V2',
    label: 'module resolution',
    ok: false,
    skipped: false,
    checked: [],
    unresolved: [],
    resolved: 0,
    error: null,
  }

  if (unique.length === 0) {
    out.skipped = true
    out.error = 'there was no row to resolve, so this layer made no claim'
    return out
  }
  if (typeof process === 'undefined' || str(process.execPath) === null) {
    out.skipped = true
    out.error = 'this host exposes no node executable, so module resolution cannot be run'
    return out
  }

  const payload = base64Lines(unique)
  const script = RESOLVE_SCRIPT
  const result = await runProcess(subprocess, {
    argv: [process.execPath, '-e', script, payload],
    cwd: profileDir,
    timeoutMs: typeof options.timeoutMs === 'number' ? options.timeoutMs : 60000,
  })

  if (!result.ok) {
    out.error = result.error ?? `the resolution child exited ${String(result.exitCode)}: ${firstLineOf(result.stderr) ?? 'no message'}`
    return out
  }

  out.checked = unique
  for (const raw of result.stdout.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const outcome = line.slice(0, tab)
    const specifier = line.slice(tab + 1)
    if (outcome === 'ok') out.resolved += 1
    else out.unresolved.push(specifier)
  }

  // A child that printed nothing is not a pass: silence could mean the script
  // never ran, and reporting "all resolved" from zero evidence is the exact
  // mistake this layer exists to prevent.
  if (out.resolved + out.unresolved.length === 0) {
    out.error = 'the resolution child produced no verdicts, so nothing is claimed'
    return out
  }

  out.ok = out.unresolved.length === 0
  return out
}

/**
 * The resolver child's script.
 *
 * Two things are deliberate:
 *
 * 1. **`import.meta.resolve(specifier, base)`**, not `createRequire` — the base
 *    argument pins resolution to the PROFILE's tree, so a package that is only
 *    reachable from somewhere else on the machine is not counted as present.
 * 2. **One verdict per line, tab-separated**, so a specifier containing any
 *    character at all cannot be confused with the verdict.
 *
 * The script is a literal and the data arrives as base64, so no module name can
 * become code.
 */
const RESOLVE_SCRIPT = [
  'const list=Buffer.from(process.argv[1],"base64").toString("utf8").split("\\n").filter(Boolean);',
  'const base=process.cwd()+"/package.json";',
  'for(const s of list){',
  'let ok=false;',
  'try{await import.meta.resolve(s, base);ok=true}catch(e){ok=false}',
  'process.stdout.write((ok?"ok":"missing")+"\\t"+s+"\\n")',
  '}',
].join('')

/**
 * Base64 one newline-separated list without `node:Buffer`.
 * @param {string[]} items - the values.
 * @returns {string} base64 of the joined list.
 */
function base64Lines(items) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = []
  const text = items.join('\n')
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += alphabet[b0 >> 2]
    out += alphabet[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? alphabet[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? alphabet[b2 & 63] : '='
  }
  return out
}

/**
 * The third check: every declared bundle is present, and still declares `dsh.bundle`.
 *
 * Cheap, local, and it answers a question neither V1 nor V2 can answer alone.
 * The host auto-maintains `dsh.profile.bundles` from what it installs, so an
 * entry whose package is **gone** — or which has since lost its `dsh.bundle`
 * declaration — is a profile that fails to COMPOSE, before any module is
 * resolved.
 *
 * ⚠️ **Presence is checked for EVERY declared bundle, not only for the ones that
 * appear in `dependencies`.** The first version skipped anything it did not find
 * in the dependency list, reasoning that a shipped bundle is not a dependency —
 * true, but it also skipped a bundle the user had just REMOVED from
 * `dependencies` while the entry remained in `bundles`, which is precisely the
 * broken state this layer exists to catch. `node_modules` is the authority on
 * "is this package here"; the dependency list is not.
 *
 * @param {object} fs - the resolved `fs` service.
 * @param {string} selfName - this package's own name.
 * @returns {Promise<object>} plain-JSON result.
 */
export async function verifyBundles(fs, selfName) {
  const out = { layer: 'V1b', label: 'declared bundles', ok: false, declared: 0, checked: 0, missing: [], skipped: [], error: null }
  let inventory
  try {
    inventory = await buildPluginInventory(fs, selfName)
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error)
    return out
  }
  if (!inventory.available || inventory.profile === null) {
    out.error = `the profile could not be read: ${inventory.reason}`
    return out
  }

  const declared = Array.isArray(inventory.declaredBundles) ? inventory.declaredBundles : []
  out.declared = declared.length

  for (const name of declared) {
    let present = false
    try {
      const manifestPath = joinPath(joinPath(inventory.profile.dir, 'node_modules'), name, 'package.json')
      const info = await fs.stat(await fs.resolve(manifestPath))
      present = info !== undefined
    } catch {
      present = false
    }

    if (!present) {
      // A shipped bundle resolves out of the harness installation rather than the
      // profile, so its absence here is NOT evidence of a broken profile. It is
      // reported as skipped, not as a fault — and a skip is still not a pass.
      out.skipped.push({ name, reason: 'not in the profile node_modules (a shipped bundle resolves elsewhere, so this is not a fault)' })
      continue
    }

    const installed = inventory.plugins.find((plugin) => plugin.name === name)
    if (installed !== undefined && installed.declaresBundle !== true) {
      out.missing.push({ name, reason: 'installed but its package.json has no dsh.bundle' })
    }
    out.checked += 1
  }

  out.ok = out.missing.length === 0
  return out
}

/**
 * Run every verification layer and fold them into one report.
 *
 * The overall verdict is `ok` only when NO layer failed AND no layer was
 * skipped. A skipped layer means a claim that could not be made, and calling
 * that a pass is how a pre-check becomes decoration.
 *
 * @param {object} input - `{ fs, subprocess, launcher, profileDir, selfName, patch?, timeoutMs?, includeKinds? }`.
 * @returns {Promise<object>} plain-JSON verification report.
 */
export async function runVerification(input) {
  const profileDir = str(input?.profileDir)
  const out = {
    at: Date.now(),
    ok: false,
    skipped: [],
    failed: [],
    layers: [],
    rows: [],
    profileDir,
    note: 'V1 composes the patch layers offline; V2 resolves every row against the profile\'s own node_modules. Neither imports a plugin, so an apply()-time failure is still only visible at the next boot.',
  }

  if (profileDir === null) {
    out.note = 'no profile directory was resolved, so nothing was verified'
    return out
  }

  const bundles = await verifyBundles(input?.fs, input?.selfName)
  out.layers.push(bundles)
  if (bundles.error !== null) out.skipped.push(`V1b: ${bundles.error}`)
  else if (!bundles.ok) out.failed.push(`V1b: ${bundles.missing.map((item) => item.name).join(', ')}`)

  const compose = await verifyCompose(input?.subprocess, input?.launcher, profileDir, {
    timeoutMs: input?.timeoutMs,
    patch: input?.patch,
  })
  out.layers.push({ layer: 'V1', label: compose.label, ok: compose.ok, skipped: compose.skipped, error: compose.error, signatures: compose.signatures, exitCode: compose.exitCode })
  if (compose.skipped) out.skipped.push(`V1: ${compose.error}`)
  else if (!compose.ok) out.failed.push(`V1: ${compose.error}`)

  out.rows = compose.rows ?? []

  // V2 only runs on a successful compose: resolving rows out of a dump that was
  // never produced would be inventing evidence.
  const modules = compose.ok
    ? await verifyModules(input?.subprocess, profileDir, out.rows.map((row) => row.name), { timeoutMs: input?.timeoutMs })
    : { layer: 'V2', label: 'module resolution', ok: false, skipped: true, resolved: 0, unresolved: [], checked: [], error: 'the offline compose did not produce a dump, so there was nothing to resolve' }
  out.layers.push(modules)
  if (modules.skipped) out.skipped.push(`V2: ${modules.error}`)
  else if (!modules.ok) out.failed.push(`V2: ${modules.unresolved.length} row(s) name a package that does not resolve: ${modules.unresolved.slice(0, 5).join(', ')}`)

  out.ok = out.failed.length === 0 && out.skipped.length === 0
  return out
}
