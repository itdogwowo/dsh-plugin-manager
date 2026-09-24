/**
 * The change pipeline. **Every** profile mutation in this package goes through here.
 *
 * ```
 * ① verify          V1 offline compose + V1b declared bundles + V2 module resolution
 *       │ pass
 * ② snapshot        the profile's own state files, byte for byte
 *       │
 * ③ execute         `dsh plugin …`, or `git` for a checkout
 *       │
 * ④ verify          again
 *       │
 *  ├─ pass ────────→ done, and the change is named
 *  └─ fail ────────→ ⑤ rollback: restore ②, then prove the restore
 * ```
 *
 * ## Three rules this file exists to enforce
 *
 * 1. **Nothing runs before the snapshot succeeds.** A change that cannot be
 *    undone must not start, so a failed snapshot aborts rather than warning.
 * 2. **Exit code zero is not success.** Both `dsh plugin` and `git` can return 0
 *    without having changed the thing that was asked for (the reference
 *    implementation learned this the hard way). The spec is re-read afterwards
 *    and the outcome is judged on THAT, not on the exit code.
 * 3. **`--no-verify` exists and is loud.** Skipping the pre-check is sometimes
 *    the only way out of a bad profile, so the escape hatch stays — but the
 *    result carries `skippedVerification: true` and the panel shows it.
 *
 * R1 applies: `node:` and relative imports only.
 */

import { dshArgv, firstLine, runProcess } from './host.js'
import { kindOf } from './detect-report.js'
import { readGitState } from './detect.js'
import { locateGitDir, parseRemoteUrl } from './gitrefs.js'
import { describeSnapshot, loadSnapshot, restoreSnapshot, snapshotRoot, takeSnapshot, listSnapshots } from './snapshot.js'
import { runVerification } from './verify.js'

/** Registry-ish kinds whose update is a re-install with a new spec. */
const RESOLVABLE_KINDS = new Set(['registry', 'tarball-url', 'file'])

/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Find one installed plugin's inventory row.
 * @param {object} inventory - the result of `buildPluginInventory`.
 * @param {string} name - the package name.
 * @returns {object|null} the row, or null.
 */
export function findPlugin(inventory, name) {
  const wanted = str(name)
  if (wanted === null || inventory === null || !Array.isArray(inventory.plugins)) return null
  return inventory.plugins.find((plugin) => plugin.name === wanted) ?? null
}

/**
 * The working-tree root of an installed package, from its resolved manifest.
 * @param {object} plugin - an inventory row.
 * @returns {string|null} the directory, or null.
 */
export function checkoutRootOf(plugin) {
  const resolved = str(plugin?.resolvedDir)
  if (resolved === null) return null
  const trimmed = resolved.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut <= 0) return null
  return trimmed.slice(0, cut)
}

/**
 * Build the spec string for a new ref of an installable source.
 *
 * `github:owner/repo#v1.2.3` and `git+https://…#v1.2.3` are the two shapes pnpm
 * understands; a `link:` install is NOT one of them (its identity is the local
 * path), which is why a checkout is updated in place instead.
 * @param {string} spec - the current spec.
 * @param {string} ref - the requested ref name.
 * @returns {{ ok: boolean, spec: string|null, error: string|null }} the new spec.
 */
export function specWithRef(spec, ref) {
  const base = str(spec)
  const wanted = str(ref)
  if (base === null) return { ok: false, spec: null, error: 'this plugin records no spec, so there is nothing to point at a ref' }
  if (wanted === null) return { ok: false, spec: null, error: 'no ref was requested' }

  if (base.startsWith('link:') || base.startsWith('workspace:')) {
    return {
      ok: false,
      spec: null,
      error: `a ${base.startsWith('link:') ? 'link:' : 'workspace:'} install points at a local directory, so a ref cannot be added to the spec — the checkout itself has to move`,
    }
  }
  if (base.startsWith('file:')) {
    return { ok: false, spec: null, error: 'a file: install is a local archive; there is no ref to choose' }
  }

  const hash = base.indexOf('#')
  const bare = hash === -1 ? base : base.slice(0, hash)
  return { ok: true, spec: `${bare}#${wanted}`, error: null }
}

/**
 * Decide what an update of one plugin would do, without doing it.
 *
 * Pure with respect to the profile: it reads, and it says what it would run.
 * Every refusal carries the reason, because "nothing happens when I press the
 * button" is the failure mode this function exists to prevent.
 *
 * ⚠️ **The tool PROBE is an input, not something this function runs.** Whether
 * `git` exists on this machine cannot change while the process lives, so it is
 * answered once by `probeGit` and passed in; a plan that spawned its own probe
 * would run a subprocess every time a dropdown changed. `input.git` is the probe
 * result — `{ available, path, error }` — and it is deliberately a DIFFERENT
 * object from the repository facts this function reads from `.git`.
 *
 * @param {object} input - `{ fs, subprocess, launcher, git, inventory, name, ref, profileName }`.
 * @returns {Promise<object>} plain-JSON plan.
 */
export async function planUpdate(input) {
  const probe = input?.git ?? null
  const out = {
    ok: false,
    name: str(input?.name),
    kind: null,
    action: null,
    from: null,
    to: null,
    current: null,
    spec: null,
    targetSpec: null,
    remote: null,
    argv: [],
    cwd: null,
    dryRun: true,
    noChangeNeeded: false,
    summary: '',
    error: null,
    warnings: [],
  }

  const classified = await classifyUpdate({ fs: input?.fs, inventory: input?.inventory, name: input?.name, ref: input?.ref })
  if (classified.error !== null || classified.plugin === null) {
    out.error = classified.error ?? 'the plugin could not be classified'
    return out
  }
  const plugin = classified.plugin
  const git = classified.git

  out.kind = classified.kind
  out.spec = str(plugin.spec)
  out.from = str(plugin.version)

  const requestedRef = classified.requestedRef

  // ── a local checkout: the ref is moved in the directory itself ────────────
  const root = classified.checkoutRoot
  if (git !== null && git.isRepo) {
    out.kind = 'checkout'
    out.current = git.commit
    out.action = 'git-checkout'
    out.cwd = root
    if (git.remoteUrl === null) {
      out.error = 'this checkout has no origin remote, so there is nothing to fetch a newer ref from'
      return out
    }
    const remote = parseRemoteUrl(git.remoteUrl)
    out.remote = { url: git.remoteUrl, host: remote.host, webUrl: remote.webUrl, kind: remote.kind }

    if (requestedRef !== null && requestedRef === git.branch && git.attached) {
      // Moving to the branch already checked out is a fast-forward, not a
      // checkout: say so, because the two produce different working trees.
      out.action = 'git-pull'
      out.to = requestedRef
      out.argv = ['git', '-C', root, 'merge', '--ff-only', `origin/${requestedRef}`]
      out.summary = `fetch origin, then fast-forward ${requestedRef} to origin/${requestedRef}`
      out.ok = true
      // The tool check applies to the FINAL verdict, not to whether a plan
      // exists: a plan that cannot run is more useful than no plan, because the
      // panel can then show exactly what is missing.
      if (probe !== null && probe.available !== true) {
        out.ok = false
        out.error = `git is required to move a local checkout: ${probe.error ?? 'it was not found on this machine'}`
      }
      return out
    }

    out.to = requestedRef ?? (git.branch === null ? null : `origin/${git.branch}`)
    out.argv = ['git', '-C', root, 'checkout', String(out.to ?? '')]
    out.summary = requestedRef === null ? `fetch origin, then fast-forward ${String(git.branch)}` : `fetch origin, then check out ${requestedRef}`
    out.ok = out.to !== null
    if (!out.ok) out.error = 'the checkout is detached and no ref was requested, so there is nothing to move to'
    if (out.ok && probe !== null && probe.available !== true) {
      out.ok = false
      out.error = `git is required to move a local checkout and it is unavailable: ${probe.error ?? 'it was not found on this machine'}`
    }
    return out
  }

  // ── an installable source: the spec gains a ref, the CLI reinstalls ───────
  if (RESOLVABLE_KINDS.has(out.kind)) {
    out.action = 'dsh-plugin-add'
    out.kind = out.kind === 'registry' ? 'registry' : out.kind
    if (requestedRef === null) {
      // For a registry install the newest version is not knowable offline, and
      // inventing one would be the exact lie `reachability: local` forbids.
      out.summary = 're-resolve the recorded spec against its source'
      out.targetSpec = out.spec
      out.argv = ['dsh', 'plugin', '--profile', str(input?.profileName) ?? '', 'add', String(out.spec ?? '')]
      out.warnings.push(
        out.kind === 'registry'
          ? 'the newest version is not knowable without querying the registry, so this re-resolves the recorded spec rather than picking a version'
          : 'a URL or tag spec can change content without changing its name, so this refetches it',
      )
      out.ok = true
      return out
    }
    const built = specWithRef(out.spec, requestedRef)
    if (built.ok !== true) {
      out.error = built.error
      return out
    }
    out.targetSpec = built.spec
    out.to = requestedRef
    out.action = 'dsh-plugin-add'
    out.argv = ['dsh', 'plugin', '--profile', str(input?.profileName) ?? '', 'add', built.spec]
    out.summary = `install ${built.spec}`
    out.ok = true
    return out
  }

  out.error = `a "${String(out.kind)}" source cannot be updated by this package`
  return out
}

/**
 * Whether a spec is acceptable as an ARGUMENT to the official CLI.
 *
 * ## What this defends against, precisely
 *
 * A spec is DATA, not a command: it is handed to `spawn` inside an argv array,
 * never interpolated into a shell string, so there is no shell injection here and
 * this function must not be described as preventing one. What a spec *does*
 * become is **one argument of `dsh plugin add`**, and that is the whole attack
 * surface:
 *
 * - a value starting with `-` is parsed by the CLI as an OPTION (`--help`,
 *   `--global`), not as a package — the realistic way a UI text field turns into
 *   an unintended action;
 * - a control character or a newline has no legitimate use in a spec, so its
 *   presence means someone is probing;
 * - a non-ASCII payload invites homoglyph confusion in a list a human reviews.
 *
 * ## Deliberately strict, because there is a way out
 *
 * This refuses anything it does not positively recognise. A user whose legal
 * spec is rejected is not stuck: the official CLI still accepts it by hand, and
 * the refusal message says so. The panel is a convenience, not the only door —
 * which is what makes strictness the right call here rather than a guessing game
 * about what pnpm might accept.
 *
 * @param {unknown} spec - the candidate spec.
 * @returns {{ ok: boolean, spec: string|null, error: string|null }} the verdict.
 */
export function checkPackageSpec(spec) {
  const value = str(spec)
  if (value === null) return { ok: false, spec: null, error: 'a package name or spec is required' }

  if (value.startsWith('-')) {
    return {
      ok: false,
      spec: null,
      error: `"${value}" starts with a hyphen, so the CLI would read it as an option rather than a package. Remove the hyphen, or install it by hand with: dsh plugin --profile <profile> add <spec>`,
    }
  }

  // oxlint-disable-next-line no-control-regex -- matching control characters IS the check
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, spec: null, error: 'a spec cannot contain control characters or line breaks' }
  }

  // Shell metacharacters are not shell injection here (argv, not a shell string),
  // but they have no place in a package spec: every one of them means the value
  // is a command someone pasted into the wrong field. Blocking them costs a
  // legitimate spec nothing — no registry name, URL, or path needs them.
  if (/[$;&|<>()`'"\\]/.test(value)) {
    return {
      ok: false,
      spec: null,
      error:
        'a spec cannot contain shell metacharacters — if this is a local path, write it with forward slashes; otherwise install it by hand with: dsh plugin --profile <profile> add <spec>',
    }
  }

  // A scoped package is always `@scope/name`; `@1.2.3` is a mistyped version.
  if (value.startsWith('@') && !value.slice(1).includes('/')) {
    return { ok: false, spec: null, error: `"${value}" looks like a version, not a package: a scoped package is written @scope/name@version` }
  }

  if (!/^[\u0021-\u007e]+$/.test(value)) {
    return { ok: false, spec: null, error: 'a spec must be printable ASCII — a non-ASCII character in a package spec is a typo or a homoglyph' }
  }

  if (value.length > 1024) {
    return { ok: false, spec: null, error: `a spec of ${String(value.length)} characters is longer than any real one (limit 1024)` }
  }

  return { ok: true, spec: value, error: null }
}

/**
 * The package name a spec installs AS, when that can be known without asking.
 *
 * ⚠️ **`null` means "cannot be told from the spec", not "no name".** A registry
 * spec like `^1.2.0` names no package at all, and a `link:` target's name lives
 * in the target's own `package.json`. Guessing there would produce a plan that
 * claims to know which installed plugin it is about to replace, which is exactly
 * the kind of false certainty this package exists to avoid. Callers must render
 * "unknown" differently from "nothing installed".
 *
 * @param {string} spec - a spec that already passed {@link checkPackageSpec}.
 * @returns {string|null} the name, or null when the spec does not carry one.
 */
export function nameFromSpec(spec) {
  const value = str(spec)
  if (value === null) return null

  // github:owner/repo[#ref], and a plain owner/repo shorthand.
  const github = /^github:([^#]+)/.exec(value)
  if (github !== null) {
    const segment = github[1].replace(/[\\/]+$/, '').split('/').pop() ?? ''
    const name = segment.replace(/\.git$/, '')
    return name.length > 0 ? name : null
  }

  // git+https://host/owner/repo.git[#ref] — the last path segment is the name.
  if (value.startsWith('git+')) {
    const afterScheme = value.slice(value.indexOf('://') + 3)
    const withoutRef = afterScheme.split('#')[0]
    const segment = withoutRef.replace(/[\\/]+$/, '').split('/').pop() ?? ''
    const name = segment.replace(/\.git$/, '')
    return name.length > 0 ? name : null
  }

  // An alias (`npm:real-name@range`) installs under the left-hand name, which is
  // NOT in the spec — so this is one of the cases that must answer null.
  if (value.startsWith('npm:')) return null
  // A local path's name is in the target's package.json, not in the spec.
  if (value.startsWith('link:') || value.startsWith('file:') || value.startsWith('workspace:') || value.startsWith('.')) return null
  // A URL tarball's name is in the archive.
  if (value.startsWith('http:') || value.startsWith('https:')) return null

  // `name@range`, `@scope/name@range`, or a bare name. The scope's leading `@`
  // makes the split position differ, which is why the search starts at 1.
  const at = value.lastIndexOf('@')
  if (at > 0) return value.slice(0, at)
  if (value.startsWith('@')) return value
  // A leading `^`/`~`/digit means this is a bare RANGE with no name: `^1.2.0`.
  if (/^[\^~<>=*\d]/.test(value)) return null
  return value
}

/**
 * What installing one spec would do, decided WITHOUT touching any tool.
 *
 * The counterpart of {@link planUpdate} for the case that has no installed row
 * to classify: nothing about the target is known yet, so the plan is built from
 * the spec alone plus whatever the manifest already records under that name.
 *
 * @param {object} input - `{ fs, inventory, launcher, spec, profileName }`.
 * `launcher` is the `dsh` TOOL probe (or null when the caller did not probe),
 * which is a different object from anything read off disk.
 * @returns {Promise<object>} plain-JSON plan, the same shape `planUpdate` returns.
 */
export async function planInstall(input) {
  const out = {
    ok: false,
    verb: 'add',
    name: null,
    spec: null,
    kind: 'install',
    action: 'dsh-plugin-add',
    from: null,
    to: null,
    current: null,
    targetSpec: null,
    remote: null,
    argv: [],
    cwd: null,
    dryRun: true,
    noChangeNeeded: false,
    alreadyInstalled: false,
    sameSpec: false,
    summary: '',
    error: null,
    warnings: [],
  }

  const checked = checkPackageSpec(input?.spec)
  if (checked.ok !== true) {
    out.error = checked.error
    return out
  }
  const spec = checked.spec
  out.spec = spec
  out.targetSpec = spec
  out.to = spec

  const name = nameFromSpec(spec)
  out.name = name
  if (name === null) {
    out.warnings.push(
      'this spec does not name the package it installs, so the panel cannot say whether it replaces an installed plugin — the CLI resolves the name when it runs',
    )
  }

  // What the manifest already records under that name, when the name is knowable.
  const inventory = input?.inventory ?? null
  const recorded = name === null ? null : (inventory?.plugins ?? []).find((plugin) => plugin.name === name) ?? null
  if (recorded !== null) {
    out.alreadyInstalled = true
    out.from = str(recorded.version)
    out.current = str(recorded.spec)
    out.sameSpec = out.current === spec
    if (out.sameSpec) {
      out.noChangeNeeded = true
      out.warnings.push(
        'the profile already records this exact spec. Re-running it re-resolves the source: a no-op for a pinned version, a content refetch for a URL or tag',
      )
    } else {
      out.warnings.push(
        `this REPLACES the recorded spec for ${name} (currently ${String(out.current)}) — the change is snapshotted first, so it can be rolled back`,
      )
    }
  }

  out.summary = out.sameSpec ? `re-resolve ${spec}` : `install ${spec}`
  out.argv = pluginCommand(input?.profileName, 'add', spec)
  out.ok = true

  // Same rule as `planUpdate`: a plan that cannot RUN is still a plan, because
  // the panel needs to be able to show what is missing. The tool verdict is
  // applied to `ok` last, after the plan itself is known to be sound.
  const probe = input?.launcher ?? null
  if (probe !== null && probe.available !== true) {
    out.ok = false
    out.error = `the dsh launcher is required to install a plugin and it is unavailable: ${probe.error ?? 'it was not found on this machine'}`
  }
  return out
}

/**
 * What removing one plugin would do, decided WITHOUT touching any tool.
 *
 * @param {object} input - `{ fs, inventory, launcher, name, profileName, selfName }`.
 * @returns {Promise<object>} plain-JSON plan, the same shape `planUpdate` returns.
 */
export async function planRemoval(input) {
  const out = {
    ok: false,
    verb: 'remove',
    name: str(input?.name),
    spec: null,
    kind: 'remove',
    action: 'dsh-plugin-remove',
    from: null,
    to: null,
    current: null,
    targetSpec: null,
    remote: null,
    argv: [],
    cwd: null,
    dryRun: true,
    noChangeNeeded: false,
    alreadyInstalled: false,
    sameSpec: false,
    summary: '',
    error: null,
    warnings: [],
  }

  if (out.name === null) {
    out.error = 'a name is required to remove a plugin'
    return out
  }

  const found = findPlugin(input?.inventory, out.name)
  if (found === null) {
    out.error = `no installed plugin is named "${out.name}", so there is nothing to remove`
    return out
  }
  out.alreadyInstalled = true
  out.from = str(found.version)
  out.current = str(found.spec)

  // Removing this very package is legal and sometimes exactly right — it is also
  // the one removal that takes the panel away with it, and a user deserves to
  // know that BEFORE pressing the button rather than after.
  const selfName = str(input?.selfName)
  if (selfName !== null && out.name === selfName) {
    out.warnings.push('this is the plugin manager itself: removing it unloads this panel on the next restart, and the rollback button goes with it')
  }

  out.summary = `remove ${out.name}`
  out.argv = pluginCommand(input?.profileName, 'remove', out.name)
  out.ok = true

  const probe = input?.launcher ?? null
  if (probe !== null && probe.available !== true) {
    out.ok = false
    out.error = `the dsh launcher is required to remove a plugin and it is unavailable: ${probe.error ?? 'it was not found on this machine'}`
  }
  return out
}

/**
 * Read the git facts for one directory, tolerating every absence.
 *
 * ⚠️ **This returns FACTS ABOUT THE REPOSITORY, not about the `git` tool.** The
 * two are different questions with different answers, and conflating them was a
 * real bug: `planUpdate` tested `git.available`, which this function never sets,
 * so `git.available !== true` was true for every checkout and EVERY plan to move
 * a checkout was refused with "git is unavailable" — including on a machine
 * where git works. The tool probe is supplied separately by the caller (see
 * {@link planUpdate}'s `git` input) because only the caller can afford to spawn
 * a probe, and only for the plugins that need one.
 *
 * @param {object} fs - the resolved `fs` service.
 * @param {string|null} dir - the directory.
 * @returns {Promise<object>} `{ isRepo, commit, branch, attached, remoteUrl }`.
 */
async function gitFacts(fs, dir) {
  const out = { isRepo: false, commit: null, branch: null, attached: false, remoteUrl: null }
  if (dir === null || fs === undefined || fs === null) return out
  const located = await locateGitDir(fs, dir)
  if (located.dir === null) return out
  const state = await readGitState(fs, dir)
  out.isRepo = state.isRepo === true
  out.commit = str(state.commit)
  out.branch = str(state.branch)
  out.attached = state.attached === true
  out.remoteUrl = str(state.remote)
  return out
}

/**
 * What an update of one plugin would do, decided WITHOUT touching any tool.
 *
 * Two callers need this and neither may spawn anything to get it:
 *
 * - the `plan` route, which must not run a subprocess just because a dropdown
 *   changed (R4 is about work, not only about requests);
 * - `apply`, which needs to know whether the `dsh` launcher or `git` is the tool
 *   to probe — probing the other one is a wasted spawn on every change.
 *
 * @param {object} input - `{ fs, inventory, name, ref }`.
 * @returns {Promise<object>} `{ kind, plugin, checkoutRoot, git, requestedRef, needs }`.
 */
export async function classifyUpdate(input) {
  const out = { kind: null, plugin: null, checkoutRoot: null, git: null, requestedRef: str(input?.ref), needs: [], error: null }

  const plugin = findPlugin(input?.inventory, input?.name)
  if (plugin === null) {
    out.error = `no installed plugin is named "${String(input?.name)}"`
    return out
  }
  out.plugin = plugin
  out.kind = kindOf(plugin.sourceType)
  out.checkoutRoot = checkoutRootOf(plugin)

  const git = await gitFacts(input?.fs, out.checkoutRoot)
  if (git.isRepo) {
    out.kind = 'checkout'
    out.git = git
    out.needs = ['git']
    return out
  }
  // Everything else is installed through the CLI, including a re-resolve of a
  // registry or URL spec. A `link:` install that is NOT a checkout has no tool
  // that could move it, which `planUpdate` reports as a refusal.
  if (out.kind !== 'link') out.needs = ['dsh']
  return out
}

/**
 * Turn a plan's `argv` into a real argv for the subprocess service.
 *
 * A `git …` plan uses the resolved git path; a `dsh …` plan is rewritten to
 * `node <lib/bin.js> …` because the PATH shim is a `.ps1` on Windows and the
 * seam does not execute shell scripts (A3).
 * @param {object} deps - `{ git, launcher }` probe results.
 * @param {string[]} argv - the plan's argv.
 * @returns {{ ok: boolean, argv: string[]|null, error: string|null }} the real argv.
 */
export function materialiseArgv(deps, argv) {
  const list = Array.isArray(argv) ? argv.map(String) : []
  if (list.length === 0) return { ok: false, argv: null, error: 'the plan has no command to run' }

  if (list[0] === 'git') {
    const gitPath = str(deps?.git?.path)
    if (deps?.git?.available !== true || gitPath === null) {
      return { ok: false, argv: null, error: `git is unavailable: ${deps?.git?.error ?? 'no probe result'}` }
    }
    return { ok: true, argv: [gitPath, ...list.slice(1)], error: null }
  }

  if (list[0] === 'dsh') {
    const bin = str(deps?.launcher?.path)
    if (deps?.launcher?.available !== true || bin === null) {
      return { ok: false, argv: null, error: `the dsh launcher is unavailable: ${deps?.launcher?.error ?? 'no probe result'}` }
    }
    if (typeof process === 'undefined' || str(process.execPath) === null) {
      return { ok: false, argv: null, error: 'this host exposes no node executable, so the dsh CLI cannot be run' }
    }
    return { ok: true, argv: dshArgv(process.execPath, bin, list.slice(1)), error: null }
  }

  return { ok: false, argv: null, error: `the plan wants to run "${list[0]}", which this package does not invoke` }
}

/**
 * The `dsh plugin` argument list for a plain add or remove.
 * @param {string} profileName - the profile name.
 * @param {string} verb - `add` or `remove`.
 * @param {string} spec - the package or spec.
 * @returns {string[]} the dsh CLI argv (not yet materialised).
 */
export function pluginCommand(profileName, verb, spec) {
  return ['dsh', 'plugin', '--profile', String(profileName), String(verb), String(spec)]
}

/**
 * Compare the profile's dependency entry for one package against a snapshot.
 *
 * This is the "do not trust the exit code" check: `dsh plugin add` can return 0
 * without having changed anything, and the only way to know is to look.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} manifestPath - the profile's package.json.
 * @param {string} name - the package name.
 * @returns {Promise<{ spec: string|null, error: string|null }>} the recorded spec.
 */
export async function readRecordedSpec(fs, manifestPath, name) {
  try {
    const text = await fs.readText(await fs.resolve(manifestPath))
    const manifest = JSON.parse(text)
    const deps = manifest !== null && typeof manifest === 'object' && manifest.dependencies !== null && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
    const spec = deps[name]
    return { spec: typeof spec === 'string' && spec.length > 0 ? spec : null, error: null }
  } catch (error) {
    return { spec: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Run the whole pipeline for one change.
 *
 * @param {object} input - `{ fs, subprocess, launcher, git, selfName, profileDir, profileName, argv, label, action, detail, noVerify?, timeoutMs? }`.
 * @returns {Promise<object>} plain-JSON run record.
 */
export async function runPipeline(input) {
  const started = Date.now()
  const out = {
    ok: false,
    at: started,
    label: str(input?.label) ?? 'change',
    action: str(input?.action) ?? 'change',
    detail: input?.detail ?? null,
    steps: [],
    argv: [],
    skippedVerification: input?.noVerify === true,
    snapshot: null,
    rollback: null,
    verifyBefore: null,
    verifyAfter: null,
    changed: null,
    residue: [],
    elapsedMs: 0,
    error: null,
    warnings: [],
  }

  const profileDir = str(input?.profileDir)
  if (profileDir === null) {
    out.error = 'no profile directory was resolved, so no change was attempted'
    return out
  }

  const deps = { git: input?.git ?? null, launcher: input?.launcher ?? null }
  const materialised = materialiseArgv(deps, input?.argv)
  if (materialised.ok !== true) {
    out.error = materialised.error
    return out
  }
  out.argv = materialised.argv

  // ── ① verify, unless the escape hatch was taken ───────────────────────────
  if (out.skippedVerification) {
    out.steps.push({ step: 'verify-before', status: 'skipped', note: '--no-verify was given: this change runs without a pre-check, and that is recorded here' })
    out.warnings.push('the pre-check was skipped on request, so a failure will only surface at the post-check or at the next boot')
  } else {
    out.verifyBefore = await runVerification({
      fs: input?.fs,
      subprocess: input?.subprocess,
      launcher: input?.launcher,
      profileDir,
      selfName: input?.selfName,
      timeoutMs: input?.timeoutMs,
    })
    out.steps.push({ step: 'verify-before', status: out.verifyBefore.ok ? 'pass' : 'fail', note: out.verifyBefore.failed.concat(out.verifyBefore.skipped).join('; ') || null })
    if (out.verifyBefore.ok !== true) {
      out.error = `the profile did not pass its pre-check, so nothing was changed: ${out.verifyBefore.failed.concat(out.verifyBefore.skipped).join('; ')}`
      out.elapsedMs = Date.now() - started
      return out
    }
  }

  // ── ② snapshot ────────────────────────────────────────────────────────────
  const snapshot = await takeSnapshot(input?.fs, {
    profileDir,
    profileName: str(input?.profileName) ?? 'default',
    label: out.label,
    action: out.action,
    detail: out.detail,
  })
  out.snapshot = describeSnapshot(snapshot)
  out.steps.push({ step: 'snapshot', status: snapshot.ok ? 'ok' : 'fail', note: snapshot.dir })
  if (snapshot.ok !== true) {
    out.error = `the snapshot failed, so the change was NOT started: ${snapshot.error}`
    out.elapsedMs = Date.now() - started
    return out
  }

  // ── ③ execute ─────────────────────────────────────────────────────────────
  const executed = await runProcess(input?.subprocess, {
    argv: out.argv,
    cwd: str(input?.cwd) ?? profileDir,
    timeoutMs: typeof input?.timeoutMs === 'number' ? input.timeoutMs : 180000,
  })
  out.steps.push({
    step: 'execute',
    status: executed.ok ? 'ok' : 'fail',
    note: executed.ok ? null : (executed.error ?? firstLine(executed.stderr) ?? `exit ${String(executed.exitCode)}`),
  })
  if (executed.ok !== true) {
    out.error = executed.error ?? `the command exited ${String(executed.exitCode)}: ${firstLine(executed.stderr) ?? 'no message'}`
    out.rollback = await rollBack({ fs: input?.fs, subprocess: input?.subprocess, snapshot })
    out.steps.push({ step: 'rollback', status: out.rollback.ok ? 'restored' : 'failed', note: out.rollback.error })
    out.residue = out.rollback.residue ?? []
    out.elapsedMs = Date.now() - started
    return out
  }

  // ── ④ verify again ────────────────────────────────────────────────────────
  out.verifyAfter = await runVerification({
    fs: input?.fs,
    subprocess: input?.subprocess,
    launcher: input?.launcher,
    profileDir,
    selfName: input?.selfName,
    timeoutMs: input?.timeoutMs,
  })
  out.steps.push({ step: 'verify-after', status: out.verifyAfter.ok ? 'pass' : 'fail', note: out.verifyAfter.failed.concat(out.verifyAfter.skipped).join('; ') || null })

  if (out.verifyAfter.ok !== true) {
    out.error = `the change did not survive its own post-check, so it was rolled back: ${out.verifyAfter.failed.concat(out.verifyAfter.skipped).join('; ')}`
    out.rollback = await rollBack({ fs: input?.fs, subprocess: input?.subprocess, snapshot })
    out.steps.push({ step: 'rollback', status: out.rollback.ok ? 'restored' : 'failed', note: out.rollback.error })
    out.residue = out.rollback.residue ?? []
    out.elapsedMs = Date.now() - started
    return out
  }

  out.changed = input?.expect === undefined ? null : input.expect
  out.ok = true
  out.elapsedMs = Date.now() - started
  return out
}

/**
 * Restore one snapshot and report the outcome.
 * @param {object} input - `{ fs, subprocess, snapshot }`.
 * @returns {Promise<object>} the rollback result.
 */
async function rollBack(input) {
  const snapshot = input?.snapshot
  if (snapshot === null || snapshot === undefined || snapshot.ok !== true) {
    return { ok: false, restored: [], removed: [], residue: [], verified: [], mismatched: [], error: 'there was no snapshot to restore, so the profile is in the state the failed change left it' }
  }
  return restoreSnapshot({ fs: input?.fs, subprocess: input?.subprocess, snapshot })
}

/**
 * Roll back the most recent snapshot for a profile.
 *
 * Deliberately independent of the pipeline that made it: the case that matters
 * most is a host that was restarted, so the snapshot is re-read from its
 * manifest rather than from a record held in memory.
 *
 * @param {object} input - `{ fs, subprocess, profileDir, profileName, id? }`.
 * @returns {Promise<object>} plain-JSON result.
 */
export async function rollbackLast(input) {
  const out = { ok: false, id: null, restored: [], removed: [], residue: [], verified: [], mismatched: [], error: null, available: [] }
  const profileDir = str(input?.profileDir)
  const profileName = str(input?.profileName) ?? 'default'
  if (profileDir === null) {
    out.error = 'no profile directory was resolved'
    return out
  }

  const root = snapshotRoot(profileDir, profileName)
  const ids = await listSnapshots(input?.fs, profileDir, profileName)
  out.available = ids.slice(0, 20)
  if (ids.length === 0) {
    out.error = `no snapshot has been taken for this profile (looked in ${root})`
    return out
  }

  const wanted = str(input?.id) ?? ids[0]
  if (!ids.includes(wanted)) {
    out.error = `no snapshot with id "${wanted}" exists in ${root}`
    return out
  }

  const snapshot = await loadSnapshot(input?.fs, joinPathSafe(root, wanted))
  if (snapshot === null) {
    out.error = `the snapshot ${wanted} could not be read back — its manifest or a recorded file is missing, so this package will not guess at its contents`
    return out
  }

  out.id = snapshot.id
  const restored = await restoreSnapshot({ fs: input?.fs, subprocess: input?.subprocess, snapshot })
  return { ...restored, available: out.available }
}

/** Join two path segments the way `host.js` does, kept local to avoid a cycle. */
function joinPathSafe(base, name) {
  const trimmed = String(base).replace(/[\\/]+$/, '')
  const sep = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/'
  return `${trimmed}${sep}${String(name)}`
}
