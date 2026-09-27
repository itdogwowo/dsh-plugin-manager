#!/usr/bin/env node
/**
 * Static checks for the hard rules. Runs before tests, and is the thing a
 * reviewer is told to trust, so every check states which rule it enforces and
 * fails loudly rather than warning.
 *
 *   R1  host half imports only `node:` and relative files
 *   R2  host half declares no `@deepseek-ai/*` service dependency
 *   R3  host half does not touch settings / agents / systemPrompt
 *   R4  no top-level side effects in either half (top level declares only)
 *
 * Plus a privacy scan: this repo is public, so a real username, an absolute
 * home path or a denylisted term must never reach a committed file.
 *
 * Usage: node verify.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const HOST_DIR = join(ROOT, 'src', 'host')
const CLIENT_DIR = join(ROOT, 'src', 'client')

/** Text file extensions the checks read. */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.txt'])

/**
 * Directories never walked by the RULE checks (R1–R4).
 *
 * `test` is excluded because those checks are about what the SHIPPED halves may
 * import, and tests legitimately import `node:fs` and `node:child_process` to
 * exercise the real thing.
 *
 * ⚠️ **The privacy scan does NOT use this list** — see {@link PRIVACY_SKIP_DIRS}.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.ref', 'test'])

/**
 * Directories never walked by the PRIVACY scan.
 *
 * ⚠️ **`test` is deliberately absent, and that is a fix.** This repo is public
 * and `test/` holds paths copied from real fixtures; excluding it meant a real
 * home path pasted into a test would be committed and never reported. The RULE
 * checks may skip tests, but a leak is a leak wherever it sits.
 */
const PRIVACY_SKIP_DIRS = new Set(['node_modules', '.git', '.ref'])

/**
 * Path shapes that LOOK like a real home path but are documented placeholders.
 *
 * The two rules that already exist — a placeholder in the docs, and a scan that
 * covers the tests — can only both hold if the known placeholders are named
 * explicitly. Anything not on this list is still a failure.
 */
const PLACEHOLDER_PATHS = [/\/home\/x\//, /\/home\/user\//, /\/Users\/<user>\//, /C:\\Users\\<[^>]+>\\/]

const failures = []
const notes = []

/** Record one failure. */
function fail(rule, file, line, message) {
  failures.push({ rule, file, line, message })
}

/** Record one informational finding. */
function note(message) {
  notes.push(message)
}

/**
 * Walk a directory tree, returning file paths.
 * @param {string} dir - the directory.
 * @param {Set<string>} [skip] - directory names to skip; defaults to the rule checks' list.
 * @returns {string[]} the file paths.
 */
function walk(dir, skip) {
  const skipSet = skip ?? SKIP_DIRS
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) {
      if (skipSet.has(name)) continue
      out.push(...walk(full, skipSet))
    } else {
      out.push(full)
    }
  }
  return out
}

/**
 * All repository text files the RULE checks cover.
 * @returns {string[]} the paths.
 */
function repoFiles() {
  return [join(ROOT, 'package.json'), join(ROOT, 'cordis.patch.yml'), join(ROOT, 'README.md'), join(ROOT, 'AGENTS.md'), join(ROOT, 'verify.mjs'), ...walk(join(ROOT, 'docs')), ...walk(join(ROOT, 'src'))]
    .filter((path) => TEXT_EXT.has(extname(path)))
    .filter((path) => existsSync(path))
}

/**
 * All repository text files the PRIVACY scan covers.
 *
 * Wider than {@link repoFiles}: it includes `test/`, the root-level build and
 * entry scripts, and anything else a text file might hide in. This repo is
 * public, so the scan's job is "nothing sensitive is committable", not "nothing
 * sensitive is in the shipped halves".
 * @returns {string[]} the paths.
 */
function privacyFiles() {
  const roots = ['src', 'test', 'docs']
  return [
    ...roots.flatMap((dir) => walk(join(ROOT, dir), PRIVACY_SKIP_DIRS)),
    join(ROOT, 'package.json'),
    join(ROOT, 'cordis.patch.yml'),
    join(ROOT, 'README.md'),
    join(ROOT, 'AGENTS.md'),
    join(ROOT, 'verify.mjs'),
    join(ROOT, 'build-client.mjs'),
    join(ROOT, '.gitignore'),
  ]
    .filter((path) => TEXT_EXT.has(extname(path)))
    .filter((path) => existsSync(path))
}

/** Read a file, returning '' when unreadable. */
function read(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Strip comments — and optionally string literals — so a keyword inside a
 * comment or a message does not count as usage.
 *
 * ⚠️ **Regex literals are stripped too, and that is not cosmetic.** The R4 check
 * decides "is this line at top level" by counting braces and clamping at zero,
 * so a quantifier like `{7,40}` inside a regex pushes the depth negative and
 * every later line is measured against a wrong depth. That produced a FALSE
 * positive on perfectly ordinary code (`gitrefs.js`, an `else if` inside a
 * function reported as a top-level side effect) — a checker that cries wolf is
 * worse than no checker, because the next real finding gets dismissed.
 *
 * A `/` is treated as opening a regex when an unescaped closing `/` exists later
 * on the same line and no line comment starts first. Character classes are
 * honoured, because a `/` inside `[…]` does not close a regex.
 *
 * @param {string} source - file text.
 * @param {{ keepStrings?: boolean }} [options] - keep string literals intact.
 * @returns {string} text with comments (and literals) blanked, newlines kept.
 */
function blankCommentsAndStrings(source, options = {}) {
  const keepStrings = options.keepStrings === true
  let out = ''
  let i = 0
  const n = source.length
  let state = 'code'
  let quote = ''
  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line'
        out += '  '
        i += 2
        continue
      }
      if (c === '/' && next === '*') {
        state = 'block'
        out += '  '
        i += 2
        continue
      }
      if (c === '/') {
        const end = regexEnd(source, i)
        if (end !== -1) {
          out += ' '.repeat(end - i + 1)
          i = end + 1
          continue
        }
      }
      if (c === '"' || c === "'" || c === '`') {
        state = 'string'
        quote = c
        out += keepStrings ? c : ' '
        i += 1
        continue
      }
      out += c
      i += 1
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += '\n'
      } else out += ' '
      i += 1
      continue
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code'
        out += '  '
        i += 2
        continue
      }
      out += c === '\n' ? '\n' : ' '
      i += 1
      continue
    }
    // state === 'string'
    if (c === '\\') {
      out += keepStrings ? c + (source[i + 1] ?? '') : '  '
      i += 2
      continue
    }
    if (c === quote) {
      state = 'code'
      out += keepStrings ? c : ' '
      i += 1
      continue
    }
    out += keepStrings ? (c === '\n' ? '\n' : c) : c === '\n' ? '\n' : ' '
    i += 1
  }
  return out
}

/**
 * The index of the `/` that closes a regex literal starting at `start`, or -1.
 *
 * Returns -1 when the line ends first, when a `//` or `/*` appears before any
 * closer (so a division is not mistaken for a regex), or when a `[` is left
 * unterminated.
 * @param {string} source - the whole file text.
 * @param {number} start - index of the opening `/`.
 * @returns {number} the closing index, or -1.
 */
function regexEnd(source, start) {
  let i = start + 1
  let inClass = false
  while (i < source.length) {
    const c = source[i]
    if (c === '\n') return -1
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) return i
    else if (c === '*' && source[i + 1] === '/') return -1
    i += 1
  }
  return -1
}

/**
 * Every import specifier in a file, with line numbers.
 *
 * Comments are blanked first: the rules forbid real imports, and these files
 * legitimately *name* import forms while explaining why they avoid them.
 * Line numbers survive because blanking preserves newlines.
 */
function importSpecifiers(source) {
  const found = []
  const code = blankCommentsAndStrings(source, { keepStrings: true })
  const patterns = [
    /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[\s\S]*?\s+from\s+)['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(code)) !== null) {
      const line = code.slice(0, match.index).split('\n').length
      found.push({ specifier: match[1], line })
    }
  }
  // De-duplicate (a specifier can match more than one pattern) keeping order.
  const seen = new Set()
  return found.filter((entry) => {
    const key = `${entry.specifier}@${entry.line}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** True when an import specifier is allowed in the host half. */
function hostImportAllowed(specifier) {
  if (specifier.startsWith('node:')) return true
  if (specifier.startsWith('./') || specifier.startsWith('../')) return true
  if (specifier.startsWith('/')) return true
  return false
}

/**
 * The services an entry declares in `inject`, read from its own source.
 *
 * The list is PARSED rather than restated here on purpose: a second copy of
 * "what this half injects" is the thing that goes stale, and the check below
 * would then bless a property access the host would refuse at runtime.
 *
 * @param {string} source - the entry file's text.
 * @returns {string[]} the injected service names (empty when there is no `inject`).
 */
export function injectedServices(source) {
  const match = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/.exec(source)
  if (match === null) return []
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1])
}

/**
 * Members of the cordis context that are API, not services.
 *
 * Deliberately explicit: a new member has to be added by hand, which is the
 * point — the check's job is to make "is this a service?" a question someone
 * answers, not something the regex guesses.
 */
export const CONTEXT_API_MEMBERS = [
  'get',
  'set',
  'provide',
  'effect',
  'on',
  'once',
  'emit',
  'parallel',
  'waterfall',
  'bail',
  'scope',
  'isolate',
  'logger',
  'inject',
  'plugin',
  'registry',
  'root',
  'dispose',
  'start',
  'stop',
  'state',
]

/**
 * `ctx.<name>` property accesses that a host half may NOT make.
 *
 * R2 says `webServer` is the only service this half depends on and that every
 * other one is read with `ctx.get(...)` so its absence degrades instead of
 * holding up boot. Cordis enforces the other side of that: a service not in
 * `inject` is unreachable as a property — it throws `cannot get property "x"
 * without inject`.
 *
 * That throw SHIPPED, on the tool probe, inside a fire-and-forget promise: the
 * deployment printed `tool probe failed` and lost the probe line with it. Hence
 * a static rule rather than a comment.
 *
 * @param {string} source - one host file's text.
 * @param {string[]} injected - the names in the entry's `inject`.
 * @param {string[]} [allowed] - context API members, overridable for tests.
 * @returns {{ name: string, line: number }[]} the violations, in file order.
 */
export function contextServiceViolations(source, injected, allowed = CONTEXT_API_MEMBERS) {
  const ok = new Set([...(Array.isArray(injected) ? injected : []), ...allowed])
  const lines = blankCommentsAndStrings(source).split('\n')
  const out = []
  for (let index = 0; index < lines.length; index += 1) {
    const pattern = /\bctx\s*\??\.\s*([A-Za-z_$][\w$]*)/g
    let match = pattern.exec(lines[index])
    while (match !== null) {
      if (!ok.has(match[1])) out.push({ name: match[1], line: index + 1 })
      match = pattern.exec(lines[index])
    }
  }
  return out
}

// ── R1: host half imports only node: and relative paths ──────────────────────

for (const path of walk(HOST_DIR)) {
  if (extname(path) !== '.js') continue
  const source = read(path)
  for (const entry of importSpecifiers(source)) {
    if (!hostImportAllowed(entry.specifier)) {
      fail('R1', relative(ROOT, path), entry.line, `host half imports "${entry.specifier}" — only node: and relative paths are allowed`)
    }
  }
}

// ── R2 / R3: no @deepseek-ai service dependency, no forbidden services ───────

const FORBIDDEN_SERVICES = ['settings', 'agents', 'systemPrompt']
for (const path of walk(HOST_DIR)) {
  if (extname(path) !== '.js') continue
  const rel = relative(ROOT, path)
  const source = read(path)
  const bare = blankCommentsAndStrings(source)

  if (/@deepseek-ai\//.test(bare)) {
    fail('R2', rel, 0, 'host half references @deepseek-ai/* — it must depend on no shipped service')
  }
  for (const service of FORBIDDEN_SERVICES) {
    const pattern = new RegExp(`ctx\\.(?:get\\(\\s*['"]${service}['"]|${service}\\b)`)
    if (pattern.test(bare)) {
      fail('R3', rel, 0, `host half touches the "${service}" service (a known startup-hang source)`)
    }
  }
}

// ── R2: every OTHER service is read with ctx.get, never as a property ────────
//
// The injected list comes from the entry file itself, so the two can never
// disagree. See `contextServiceViolations` for the deployment this caught.

const HOST_ENTRY = join(HOST_DIR, 'index.js')
const INJECTED_SERVICES = injectedServices(read(HOST_ENTRY))
if (INJECTED_SERVICES.length === 0) {
  fail('R2', relative(ROOT, HOST_ENTRY), 0, 'the entry declares no `inject` list, so this check cannot tell a service from an API member')
}
for (const path of walk(HOST_DIR)) {
  if (extname(path) !== '.js') continue
  const rel = relative(ROOT, path)
  for (const violation of contextServiceViolations(read(path), INJECTED_SERVICES)) {
    fail(
      'R2',
      rel,
      violation.line,
      `ctx.${violation.name} reads a service as a property, but \`inject\` declares only ${INJECTED_SERVICES.map((name) => `"${name}"`).join(', ')} — cordis throws "cannot get property \\"${violation.name}\\" without inject"; use ctx.get('${violation.name}')`,
    )
  }
}

// The checker's own behaviour is asserted HERE, not in test/, because this file
// exits the process and cannot be imported by a test — and a matcher that
// quietly stopped matching would turn R2 into decoration.

for (const fixture of [
  { source: 'const git = await probeGit(ctx.subprocess, fs)\n', expect: ['subprocess'], why: 'the shape that shipped' },
  { source: 'const x = ctx?.fs\n', expect: ['fs'], why: 'optional chaining is the same read' },
  { source: 'ctx.webServer.register({})\n', expect: [], why: 'injected, so a property read is legal' },
  { source: "const fs = ctx.get('fs')\nctx.effect(() => {}, 'x')\n", expect: [], why: 'the API members' },
  { source: '// ctx.subprocess in a comment\nconst s = "ctx.fs"\n', expect: [], why: 'comments and strings are not code' },
]) {
  const got = contextServiceViolations(fixture.source, INJECTED_SERVICES).map((entry) => entry.name)
  if (got.join(',') !== fixture.expect.join(',')) {
    fail('R2', 'verify.mjs', 0, `the ctx-property checker is broken (${fixture.why}): expected [${fixture.expect.join(', ')}], got [${got.join(', ')}]`)
  }
}

// ── R4: top level declares only ──────────────────────────────────────────────

/**
 * The one top-level call each half is allowed to make, and why.
 *
 * `window.__ModuleLoader__.load({...})` is not a stubbable side effect: it is
 * how the host's client-modules loader finds a web plugin entry at all, and the
 * whole bundle — including `apply` — lives inside its factory argument. There is
 * no import form of it. It is whitelisted per file AND required to be the only
 * top-level statement in that file, so a second real side effect still fails.
 */
const TOP_LEVEL_CALL_ALLOWED = new Map([
  [
    join('src', 'client', 'client.js'),
    {
      pattern: /^window\.__ModuleLoader__\.load\s*\(/,
      why: 'the client-modules bundle wrapper — the bundle is not discoverable without it',
    },
  ],
])

/** Statements that perform work at module scope rather than declaring. */
const SIDE_EFFECT_PATTERNS = [
  { pattern: /^\s*(?:await|if|for|while|switch|try|throw)\b/, why: 'control flow at top level' },
  { pattern: /^\s*[A-Za-z_$][\w$.]*\s*\(/, why: 'a bare call at top level' },
]

for (const dir of [HOST_DIR, CLIENT_DIR]) {
  for (const path of walk(dir)) {
    if (extname(path) !== '.js') continue
    const rel = relative(ROOT, path)
    const allowed = TOP_LEVEL_CALL_ALLOWED.get(rel)
    const source = read(path)
    const bare = blankCommentsAndStrings(source)
    const rawLines = source.split('\n')
    const lines = bare.split('\n')
    let depth = 0
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const trimmed = line.trim()
      if (depth === 0 && trimmed.length > 0) {
        const declares =
          /^(?:import|export|const|let|var|function|class|async\s+function)\b/.test(trimmed) ||
          /^[})\];]/.test(trimmed) ||
          trimmed === '*/'
        if (!declares && allowed !== undefined && allowed.pattern.test(trimmed)) {
          note(`${rel}: allowed top-level call at line ${index + 1} — ${allowed.why}`)
        } else if (!declares) {
          for (const rule of SIDE_EFFECT_PATTERNS) {
            if (rule.pattern.test(line)) {
              fail('R4', rel, index + 1, `${rule.why}: ${rawLines[index].trim().slice(0, 90)}`)
              break
            }
          }
        }
      }
      for (const ch of line) {
        if (ch === '{') depth += 1
        else if (ch === '}') depth = Math.max(0, depth - 1)
      }
    }
  }
}

// ── Client half: no module-level globals ────────────────────────────────────

/**
 * An ASSIGNMENT to a window property, not a comparison against one.
 *
 * The first version of this pattern was `window\s*\.\s*\w+\s*=`, which also
 * matches `window.confirm === 'function'` — the `=` of a `===`. It therefore
 * reported a false R4 failure on code that only READS a browser global
 * (`update.js`), and the only way past it would have been to stop using
 * `window.confirm` at all. A rule enforced by a pattern that forbids a correct
 * program is a rule that gets deleted the next time it fires, so the pattern
 * excludes every comparison spelling instead.
 *
 * `window.confirm = …` still fails, which is the thing the rule is about.
 */
const WINDOW_ASSIGN = /\bwindow\s*\.\s*[A-Za-z_$][\w$]*\s*(=(?!=)|[+\-*/%&|^]=(?!=)|\?\?=|\|\|=|&&=)/

for (const path of walk(CLIENT_DIR)) {
  if (extname(path) !== '.js') continue
  const rel = relative(ROOT, path)
  const stripped = blankCommentsAndStrings(read(path))
  if (WINDOW_ASSIGN.test(stripped)) {
    fail('R4', rel, 0, 'client half assigns a global on window at module scope')
  }
}

// ── Privacy scan (public repo) ──────────────────────────────────────────────

/** Absolute-path shapes that must never be committed. */
const PATH_SHAPES = [
  { pattern: /[A-Za-z]:\\Users\\[^\\\s<>"']+/, why: 'a real Windows home path' },
  { pattern: /\/Users\/[^/\s<>"']+/, why: 'a real macOS home path' },
  { pattern: /\/home\/[^/\s<>"']+/, why: 'a real Linux home path' },
]

/**
 * A path that only LOOKS like a real home path.
 *
 * The placeholder rules and a scan that covers `test/` can only both hold if the
 * documented placeholders are named. This is an allow-list of SHAPES, not of
 * files: a real account name in the same file still fails.
 * @param {string} line - one source line.
 * @returns {boolean} true when every match on the line is a known placeholder.
 */
function isPlaceholderOnly(line) {
  let stripped = line
  for (const placeholder of PLACEHOLDER_PATHS) stripped = stripped.replace(new RegExp(placeholder.source, 'g'), ' ')
  return !PATH_SHAPES.some((shape) => shape.pattern.test(stripped))
}

for (const path of privacyFiles()) {
  const rel = relative(ROOT, path)
  const lines = read(path).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (isPlaceholderOnly(lines[index])) continue
    for (const shape of PATH_SHAPES) {
      if (shape.pattern.test(lines[index])) {
        fail('PRIVACY', rel, index + 1, `${shape.why} — use a placeholder such as C:\\Users\\<account>\\`)
      }
    }
  }
}

/**
 * Credential shapes that must never reach a committed file.
 *
 * ⚠️ Why this scan exists next to the path scan: an identity leak is bad, but a
 * SECRET is worse in a way that cannot be undone — rewriting public history does
 * not remove it (`dsh-Note/notes/privacy.md` says the same about `force push`;
 * the only real fix is deleting the repository). The plugin now handles
 * credentials on purpose, so "we were careful" is not a control; this is.
 */
const SECRET_SHAPES = [
  { pattern: /\bghp_[A-Za-z0-9]{36}\b/, why: 'a GitHub personal access token' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, why: 'a GitHub fine-grained token' },
  { pattern: /\bgh[osru]_[A-Za-z0-9]{36}\b/, why: 'a GitHub OAuth or app token' },
]

/**
 * The synthetic tokens the tests use.
 *
 * Listed one by one, never as a shape: an allow-list of SHAPES is how a
 * placeholder rule gets defeated, and every literal here is one a reader can see
 * is fake. A real token will not match any of them.
 */
const SYNTHETIC_TOKENS = new Set([
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
  'ghp_thisMustNeverBeRendered1234567890',
])

for (const path of privacyFiles()) {
  const rel = relative(ROOT, path)
  const lines = read(path).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    for (const shape of SECRET_SHAPES) {
      const match = shape.pattern.exec(lines[index])
      if (match === null || SYNTHETIC_TOKENS.has(match[0])) continue
      fail('PRIVACY', rel, index + 1, `${shape.why} appears in this file — remove it before it is committed`)
    }
  }
}
note(`credential shapes: ${SECRET_SHAPES.length} pattern(s) over ${privacyFiles().length} file(s)`)

/** Local denylist: gitignored, one term per line, `#` starts a comment. */
const DENYLIST = join(ROOT, '.privacy-denylist.txt')
if (existsSync(DENYLIST)) {
  const terms = read(DENYLIST)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  for (const path of privacyFiles()) {
    if (path === DENYLIST) continue
    const rel = relative(ROOT, path)
    const haystack = read(path).toLowerCase()
    for (const term of terms) {
      if (haystack.includes(term.toLowerCase())) {
        fail('PRIVACY', rel, 0, 'a denylisted term appears in this file')
      }
    }
  }
  note(`denylist: ${terms.length} term(s) checked across ${privacyFiles().length} file(s)`)
} else {
  note('no .privacy-denylist.txt on this machine — the path-shape scan still ran, but a local denylist is stronger')
}

// ── Report ──────────────────────────────────────────────────────────────────

const RULE_LABEL = {
  R1: 'host half import list',
  R2: 'no shipped-service dependency',
  R3: 'forbidden services untouched',
  R4: 'no top-level side effects',
  PRIVACY: 'privacy red line',
}

if (failures.length === 0) {
  console.log('verify: all checks passed')
  console.log(`  R1 host imports · R2 service deps · R3 forbidden services · R4 top-level · PRIVACY paths`)
  for (const text of notes) console.log(`  note: ${text}`)
  process.exit(0)
}

console.error(`verify: ${failures.length} problem(s)\n`)
for (const item of failures) {
  const where = item.line > 0 ? `${item.file}:${item.line}` : item.file
  console.error(`  [${item.rule}] ${RULE_LABEL[item.rule] ?? item.rule}`)
  console.error(`      ${where}`)
  console.error(`      ${item.message}\n`)
}
process.exit(1)
