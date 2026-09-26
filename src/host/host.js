/**
 * EVERY assumption about the host lives here (R7).
 *
 * File names, layer order, service method shapes and error strings in this
 * package were read from the DSH source tree, not from a public API. They are
 * the parts most likely to break on a host upgrade, so they are collected in one
 * file that a reviewer can read end to end.
 *
 * ## What this file learned the hard way
 *
 * - **`git` is not on PATH on the reference machine** (docs/host-notes.md F26).
 *   Every git capability therefore goes through {@link resolveTool}, which
 *   probes candidates once per process and REMEMBERS THE FAILURE — a failed
 *   `--version` probe is an answer, not a condition to re-test on every request.
 * - **`dsh` is not an executable on Windows** — `Get-Command dsh` returns
 *   `dsh.ps1`, and `Start-Process` on it fails (A3). The child is therefore
 *   `process.execPath <…>/dsh/lib/bin.js`, never the PATH shim.
 * - **This half cannot spawn anything itself** (F7): it has the `subprocess`
 *   SERVICE, which applies host policy. Nothing here imports
 *   `node:child_process`.
 * - **Nothing here runs at import time.** `probeSummary` is computed by
 *   `index.js` INSIDE `apply`, i.e. on the boot path where it belongs, and the
 *   tools themselves are resolved on first use (R4 — a panel that is never
 *   opened must cause zero work).
 *
 * R1 applies: only `node:` and relative imports.
 */

/** Host package that ships the `dsh` launcher. */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/** Path of the launcher inside that package, as read from the installed tree. */
export const DSH_BIN_RELATIVE = 'lib/bin.js'

/**
 * The launcher's tail as SEGMENTS, so a candidate keeps one separator style.
 *
 * `DSH_PACKAGE` and `DSH_BIN_RELATIVE` both contain `/`, and splicing them in
 * verbatim produced `C:\…\@deepseek-ai/dsh\lib/bin.js` — mixed, which Windows
 * tolerates and which therefore hides a broken construction from the reference
 * machine.
 */
const DSH_BIN_SEGMENTS = [...DSH_PACKAGE.split('/'), ...DSH_BIN_RELATIVE.split('/')]

/** Default grace for a child that ignores termination, in milliseconds. */
export const SPAWN_GRACE_MS = 2000

/** In-memory cap per collected stream. The exit code is what matters; text is for the report. */
const COLLECT_MAX_BYTES = 262144

/** Candidate names for git, tried in order. */
export const GIT_CANDIDATES = ['git', 'git.exe']

/**
 * Install roots to look for git under, when it is not on PATH.
 *
 * Windows-only spellings are harmless elsewhere: a directory that does not
 * exist simply fails to resolve. On the reference machine `git` is absent from
 * PATH altogether, so this list is the difference between "cannot update a
 * checkout" and a working feature — and when every entry misses, the reason is
 * reported verbatim instead of being papered over.
 */
export const GIT_INSTALL_ROOTS = [
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  'C:\\Program Files\\Git\\bin\\git.exe',
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
]

/** Candidate names for the GitHub CLI, tried in order. Optional everywhere. */
export const GH_CANDIDATES = ['gh', 'gh.exe']


/** `gh auth token` — prints the CLI's own token to stdout. */
export const GH_AUTH_TOKEN_ARGS = ['auth', 'token']

/**
 * Where Sourcetree keeps its credential helpers, as RELATIVE paths inside the
 * app bundle.
 *
 * Two of them, because Sourcetree ships both: its own `git-credential-sourcetree`
 * (which asks the running app) and a copy of `git-credential-osxkeychain` (which
 * reads the same keychain item osxkeychain always did). Which one is in that
 * item's ACL is a fact about the machine, not something to guess — so both are
 * offered to git, in this order, and the one that answers wins.
 *
 * The point of reaching for THESE binaries rather than the ones on PATH is
 * delegation: the credential stays between Sourcetree and the git child. This
 * plugin never reads it. Measured on the reference machine: the copy on PATH
 * (`/opt/homebrew/bin/git`) raises a macOS authorization prompt, and the user's
 * instruction is not to harvest its answer but to let Sourcetree do the work.
 */
export const SOURCETREE_HELPER_RELATIVE = [
  'Contents/Resources/bin/git-credential-sourcetree',
  'Contents/Resources/git_local/bin/git-credential-osxkeychain',
]

/** Where the Sourcetree bundle may live. `$HOME/Applications` first: Sourcetree's own installer uses it. */
export const SOURCETREE_APP_RELATIVE = ['Applications/Sourcetree.app']

/**
 * The user's home directory, as THIS process sees it.
 *
 * `$HOME` on POSIX and `$USERPROFILE` on Windows — the same two names the profile
 * resolver already trusts. `node:os` would answer too, but the environment is the
 * authority this file already reads, and a second authority would be one more
 * thing that can disagree.
 */
export function userHome() {
  const env = typeof process !== 'undefined' && process.env ? process.env : {}
  return str(env.HOME) ?? str(env.USERPROFILE)
}

/**
 * The git binary Sourcetree ships, as app-relative segments.
 *
 * ⚠️ Both spellings of the bundle name are candidates on purpose: the recipe in
 * `dsh-Note/sync/skills/git-push` (which MEASURED it) writes `SourceTree.app`,
 * while the bundle installed on the reference macOS machine is `Sourcetree.app`.
 * Guessing one spelling would make this silently do nothing on one of them.
 */
export const SOURCETREE_GIT_IN_APP = ['Contents', 'Resources', 'git_local', 'bin', 'git']

/** The Windows layout, which is NOT inside the app bundle. From the same skill. */
export const SOURCETREE_GIT_WINDOWS = ['Atlassian', 'SourceTree', 'git_local', 'cmd', 'git.exe']

/**
 * Candidate paths for Sourcetree's OWN git, best first — the reason to reach for
 * it rather than the git on PATH.
 *
 * Measured, and recorded in `dsh-Note/sync/skills/git-push`: running Sourcetree's
 * bundled git by absolute path is what pushes successfully, because that binary
 * resolves its credential helper from ITS OWN exec-path — where Sourcetree put
 * `git-credential-osxkeychain`, the copy the OS keychain already trusts. The git
 * on PATH runs a different copy and raises an authorization prompt instead.
 *
 * @param {string|null} home - the user's home, or null.
 * @returns {string[]} absolute candidates, best first.
 */
export function sourcetreeGitCandidates(home) {
  const out = []
  const base = str(home)
  if (base !== null) {
    out.push(joinPath(base, 'Applications', 'SourceTree.app', ...SOURCETREE_GIT_IN_APP))
    out.push(joinPath(base, 'Applications', 'Sourcetree.app', ...SOURCETREE_GIT_IN_APP))
  }
  out.push(joinPath('/Applications', 'SourceTree.app', ...SOURCETREE_GIT_IN_APP))
  out.push(joinPath('/Applications', 'Sourcetree.app', ...SOURCETREE_GIT_IN_APP))
  const env = typeof process !== 'undefined' && process.env ? process.env : {}
  const local = str(env.LOCALAPPDATA)
  if (local !== null) out.push(joinPath(local, ...SOURCETREE_GIT_WINDOWS))
  const programFiles = str(env.ProgramFiles)
  if (programFiles !== null) out.push(joinPath(programFiles, ...SOURCETREE_GIT_WINDOWS))
  return out
}

/**
 * The exec-path belonging to a Sourcetree git, or null.
 *
 * ⚠️ MEASURED, and the reason Sourcetree's git looked broken: run by absolute
 * path it answers `git: 'remote-https' is not a git command` in 31 ms, because
 * the bundle keeps its subcommands in `git_local/libexec/git-core` and that
 * binary does not derive the location. With this set, the same binary works.
 *
 * @param {string|null} gitPath - a path like `…/git_local/bin/git`.
 * @returns {string|null} the exec-path, or null when it cannot be derived.
 */
export function sourcetreeExecPathFor(gitPath) {
  const path = str(gitPath)
  if (path === null) return null
  const bin = parentPath(path)
  const local = parentPath(bin)
  // `parentPath` returns its input when there is no parent to give, so an equal
  // pair means "this path is too short to say" rather than "…/git_local".
  if (local === bin || local === path) return null
  return joinPath(local, 'libexec', 'git-core')
}

/**
 * The first Sourcetree git that exists, or null.
 *
 * Null is the normal answer on a machine without Sourcetree, and the caller then
 * falls back to whatever git it can resolve — the delegation still happens, git
 * just uses the credential helper that machine configured.
 */
export async function findSourcetreeGit(fs, home) {
  if (fs === undefined || fs === null || typeof fs.resolve !== 'function' || typeof fs.stat !== 'function') return null
  for (const candidate of sourcetreeGitCandidates(home)) {
    try {
      if ((await fs.stat(await fs.resolve(candidate))) !== undefined) return candidate
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** Absolute candidate paths for Sourcetree's credential helpers, best first. */
export function sourcetreeHelperCandidates(home) {
  const roots = []
  const base = str(home)
  if (base !== null) {
    for (const rel of SOURCETREE_APP_RELATIVE) roots.push(joinPath(base, ...rel.split('/')))
  }
  roots.push('/Applications/Sourcetree.app')
  const out = []
  for (const root of roots) {
    for (const rel of SOURCETREE_HELPER_RELATIVE) out.push(joinPath(root, ...rel.split('/')))
  }
  return out
}

/**
 * The git arguments that make ONE child use a specific credential helper.
 *
 * `-c credential.helper=<path>` rather than an environment variable: the
 * subprocess seam drops credential-shaped env names, and a config override is
 * exactly the scope wanted — this child, this command, nothing global and
 * nothing written to the user's git config.
 */
export function credentialHelperArgs(helperPath) {
  const path = str(helperPath)
  return path === null ? [] : ['-c', `credential.helper=${path}`]
}

/**
 * The first Sourcetree helper that exists on this machine, or null.
 *
 * A missing bundle is the normal case on a machine without Sourcetree, so this
 * returns null instead of complaining; the caller decides what to say.
 */
export async function findSourcetreeHelper(fs, home) {
  if (fs === undefined || fs === null || typeof fs.resolve !== 'function' || typeof fs.stat !== 'function') return null
  for (const candidate of sourcetreeHelperCandidates(home)) {
    try {
      if ((await fs.stat(await fs.resolve(candidate))) !== undefined) return candidate
    } catch {
      /* try the next candidate */
    }
  }
  return null
}





/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Join path segments with the separator style of the base path.
 *
 * Hand-rolled rather than `node:path.join` because half the paths here arrive
 * from the host's `fs` service in its own style; mixing separators produces
 * paths that resolve on one platform and not another (detect.js carries the
 * same helper for the same reason).
 * @param {string} base - a directory path.
 * @param {...string} parts - child names.
 * @returns {string} the joined path.
 */
export function joinPath(base, ...parts) {
  let out = String(base).replace(/[\\/]+$/, '')
  const sep = out.includes('\\') && !out.includes('/') ? '\\' : '/'
  for (const part of parts) out = `${out}${sep}${String(part).replace(/^[\\/]+/, '')}`
  return out
}

/**
 * The parent directory of a path, in either separator style.
 *
 * ⚠️ A path with no directory part is returned UNCHANGED, and the `<= 2` bound
 * is what makes that true on Windows. `C:\a` cuts at index 1 (the colon, which
 * `lastIndexOf` counts as a separator), and `'C:\\a'.slice(0, 1)` is `'C:'` — a
 * drive-relative path that names a different file than the one the caller
 * passed in. The first version used `cut <= 0` and did exactly that.
 *
 * @param {string} path - the path.
 * @returns {string} its parent, or the input when there is no parent to give.
 */
export function parentPath(path) {
  const trimmed = String(path).replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut <= 2 ? trimmed : trimmed.slice(0, cut)
}

/**
 * Candidate `dsh` launcher paths for this process, best first.
 *
 * Derived from `process.argv[1]` (the entry the host was started with) by
 * walking up towards the filesystem root and testing the layout
 * `…/node_modules/@deepseek-ai/dsh/lib/bin.js`. Absolute and deterministic: no
 * PATH lookup, no `which`, no environment variable required.
 *
 * ⚠️ **Two constructions were wrong, and both failed silently** (measured on
 * macOS: with the launcher's own real path as the entry, **0 of 14** candidates
 * existed):
 *
 * 1. The ancestor was rejoined with a hard-coded `\`, so every POSIX candidate
 *    was one file name like `\opt\homebrew\lib\…` rather than a path.
 * 2. Only `<ancestor>/node_modules/…` was tried. A global install (Homebrew,
 *    `npm -g`) puts the launcher at `<prefix>/lib/node_modules/…`, and `dsh` on
 *    PATH is a shim at `<prefix>/bin/dsh` — Node does **not** resolve `argv[1]`
 *    through that symlink, so the second layout is the only one that reaches it.
 *
 * @param {string|null} [entry] - the entry to derive from; defaults to this
 *   process's `argv[1]`. Injectable so the walk-up is testable on any machine.
 * @returns {string[]} candidate paths, best first.
 */
export function dshBinCandidates(entry = (typeof process !== 'undefined' && Array.isArray(process.argv) ? process.argv[1] : null)) {
  const out = []
  const entryPath = str(entry)

  // `process.argv[1]` is the script the host was started with. Two shapes have
  // to be refused rather than guessed at:
  //
  // - a BARE name (`dsh`) — `dirname('dsh')` is `'.'`, which resolves to a
  //   different directory on every machine;
  // - a RELATIVE path — every candidate built from it would be relative too, and
  //   a relative candidate resolves against whatever the cwd happens to be when
  //   `fs.stat` is finally called.
  //
  // In both cases the honest answer is "no candidate", and the caller reports
  // that the launcher could not be located instead of resolving to the wrong
  // checkout.
  if (entryPath === null || !/^([A-Za-z]:[\\/]|[\\/])/.test(entryPath)) return out

  // The separator follows the entry, the same rule `joinPath` uses. Guessing it
  // is what produced the unreachable candidates above.
  const sep = entryPath.includes('\\') && !entryPath.includes('/') ? '\\' : '/'
  const segments = entryPath.replace(/[\\/]+$/, '').split(/[\\/]/)
  for (let cut = segments.length - 1; cut > 0; cut -= 1) {
    const base = segments.slice(0, cut).join(sep)
    if (base.length === 0) continue
    out.push([base, 'node_modules', ...DSH_BIN_SEGMENTS].join(sep))
    out.push([base, 'lib', 'node_modules', ...DSH_BIN_SEGMENTS].join(sep))
  }
  return out
}

/**
 * Resolve one executable to a canonical path, or null.
 *
 * @param {object} subprocess - the resolved `subprocess` service.
 * @param {string} command - absolute path or bare PATH name.
 * @returns {Promise<string|null>} the canonical path, or null when unresolvable.
 */
export async function resolveTool(subprocess, command) {
  if (subprocess === undefined || subprocess === null || typeof subprocess.resolveExecutable !== 'function') return null
  try {
    const resolved = await subprocess.resolveExecutable(command)
    return str(resolved)
  } catch {
    return null
  }
}

/**
 * Run one child process to completion through the `subprocess` SERVICE.
 *
 * Never throws: every failure mode — no service, bad spec, spawn rejection,
 * timeout, signal death — comes back as a plain-JSON result, because the caller
 * is an HTTP route and an exception there blanks the panel instead of
 * explaining itself.
 *
 * The deadline is enforced with an `AbortSignal` that the service reacts to by
 * terminating the managed process RANGE, not just the direct child. That is the
 * seam's own contract, and it is the reason this helper does not implement its
 * own kill ladder.
 *
 * @param {object} subprocess - the resolved `subprocess` service.
 * @param {object} spec - `{ argv, cwd, timeoutMs?, env?, stdin? }`.
 * @returns {Promise<object>} `{ ok, exitCode, signal, stdout, stderr, timedOut, error }`.
 */
export async function runProcess(subprocess, spec) {
  const out = {
    ok: false,
    argv: Array.isArray(spec?.argv) ? spec.argv.map(String) : [],
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    error: null,
  }

  if (
    subprocess === undefined ||
    subprocess === null ||
    typeof subprocess.spawn !== 'function' ||
    typeof AbortController !== 'function'
  ) {
    out.error = 'the subprocess service is not available in this host, so nothing could be run'
    return out
  }
  if (out.argv.length === 0) {
    out.error = 'no argv was given'
    return out
  }

  const timeoutMs = typeof spec.timeoutMs === 'number' && spec.timeoutMs > 0 ? spec.timeoutMs : 120000
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const handle = subprocess.spawn({
      argv: out.argv,
      cwd: str(spec.cwd) ?? '.',
      stdio: {
        stdin: spec.stdin === undefined ? 'ignore' : { data: String(spec.stdin) },
        stdout: { maxBytes: COLLECT_MAX_BYTES },
        stderr: { maxBytes: COLLECT_MAX_BYTES },
      },
      graceMs: SPAWN_GRACE_MS,
      signal: controller.signal,
      ...(spec.env === undefined ? {} : { env: spec.env }),
    })

    const outcome = await handle.done
    out.exitCode = outcome === null || outcome === undefined ? null : (outcome.exitCode ?? null)
    out.signal = outcome === null || outcome === undefined ? null : (outcome.signal ?? null)
    out.stdout = readCollected(handle, 'stdout')
    out.stderr = readCollected(handle, 'stderr')
    out.timedOut = timedOut
    out.ok = timedOut === false && out.exitCode === 0
    if (timedOut) out.error = `the command did not finish within ${timeoutMs} ms and was terminated`
    return out
  } catch (error) {
    out.timedOut = timedOut
    out.error = error instanceof Error ? error.message : String(error)
    return out
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read one collected stream from a settled handle.
 *
 * Offset-based readers are non-consuming, so reading from 0 after settlement is
 * exactly the batch result. `truncated` is surfaced through the empty string
 * rather than silently — a caller that only sees the tail must not mistake it
 * for the whole output.
 * @param {object} handle - the spawn handle.
 * @param {string} name - `'stdout'` or `'stderr'`.
 * @returns {string} the text, or ''.
 */
function readCollected(handle, name) {
  try {
    const reader = handle !== null && handle !== undefined && handle.collected ? handle.collected[name] : undefined
    if (reader === undefined || reader === null || typeof reader.readFrom !== 'function') return ''
    const read = reader.readFrom(0)
    return read !== null && read !== undefined && typeof read.text === 'string' ? read.text : ''
  } catch {
    return ''
  }
}

/**
 * Where a probe's evidence came from. Reported to the user, never guessed.
 * @typedef {{ source: string, value: string|null, ok: boolean }} ToolProbe
 */

/**
 * Locate `git` once and remember the outcome — including the failure.
 *
 * A failure is cached deliberately: the answer cannot change while the process
 * lives, and re-probing it on every request would make a missing tool look like
 * a slow tool.
 *
 * @param {object} subprocess - the resolved `subprocess` service.
 * @param {object} fs - the resolved `fs` service, used to confirm install paths.
 * @returns {Promise<{ available: boolean, path: string|null, version: string|null, tried: string[], error: string|null }>} the probe.
 */
export async function probeGit(subprocess, fs) {
  const tried = []
  const candidates = [...GIT_CANDIDATES, ...GIT_INSTALL_ROOTS]

  for (const candidate of candidates) {
    tried.push(candidate)
    let resolved = await resolveTool(subprocess, candidate)
    if (resolved === null && fs !== undefined && fs !== null && typeof fs.resolve === 'function') {
      // `resolveExecutable` verifies absolute paths in its own execution world;
      // the `fs` service is the other authority on "does this path exist", and
      // the two can disagree. Try it before giving up on an absolute candidate.
      try {
        const info = await fs.stat(await fs.resolve(candidate))
        if (info !== undefined) resolved = candidate
      } catch {
        /* not found through this authority either */
      }
    }
    if (resolved === null) continue

    const probe = await runProcess(subprocess, { argv: [resolved, '--version'], timeoutMs: 10000 })
    const version = firstLine(probe.stdout) ?? firstLine(probe.stderr)
    if (probe.ok && version !== null) {
      return { available: true, path: resolved, version, tried, error: null }
    }
    return {
      available: false,
      path: resolved,
      version: null,
      tried,
      error: `${resolved} was found but "git --version" failed: ${probe.error ?? `exit ${String(probe.exitCode)}`}`,
    }
  }

  return {
    available: false,
    path: null,
    version: null,
    tried,
    error: 'git was not found on PATH or under any known install root, so a local checkout cannot be updated in place',
  }
}

/**
 * Locate the `dsh` launcher once and remember the outcome.
 *
 * Every candidate is a construction from `process.argv[1]`, plus the two
 * environment overrides a user can set when the layout is unusual. The list of
 * what was tried is returned so a failure explains itself.
 *
 * @param {object} fs - the resolved `fs` service.
 * @returns {Promise<{ available: boolean, path: string|null, tried: string[], error: string|null }>} the probe.
 */
export async function probeDshLauncher(fs) {
  const tried = []
  const env = typeof process !== 'undefined' && process.env ? process.env : {}
  const candidates = [
    str(env.DSH_BIN),
    ...dshBinCandidates(),
    str(env.DSH_CHECKOUT) === null ? null : joinPath(str(env.DSH_CHECKOUT), 'node_modules', DSH_PACKAGE, DSH_BIN_RELATIVE),
  ].filter((value) => value !== null)

  for (const candidate of candidates) {
    tried.push(candidate)
    if (fs === undefined || fs === null || typeof fs.resolve !== 'function' || typeof fs.stat !== 'function') continue
    try {
      const info = await fs.stat(await fs.resolve(candidate))
      if (info !== undefined) return { available: true, path: candidate, tried, error: null }
    } catch {
      /* try the next construction */
    }
  }

  return {
    available: false,
    path: null,
    tried,
    error: 'the dsh launcher (lib/bin.js) could not be located, so no install or update can be run',
  }
}

/**
 * The argv for one `dsh` invocation.
 *
 * `process.execPath` first, never the PATH shim: on Windows `dsh` resolves to
 * `dsh.ps1`, which the subprocess seam cannot execute as an `argv[0]` (A3).
 * @param {string} execPath - `process.execPath`, or a fallback.
 * @param {string} binPath - the located `lib/bin.js`.
 * @param {string[]} args - the dsh arguments.
 * @returns {string[]} the full argv.
 */
export function dshArgv(execPath, binPath, args) {
  return [execPath, binPath, ...args.map(String)]
}

/** The first non-empty line of a text block, or null. */
export function firstLine(text) {
  if (typeof text !== 'string') return null
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return null
}

/** Whether a text block looks like a version string. */
export function looksLikeVersion(text) {
  return typeof text === 'string' && /^v?\d+\.\d+\.\d+/.test(text.trim())
}

/**
 * Delete one file through whichever authority can do it.
 *
 * The `fs` service can read, write and edit — it has NO delete method, so a
 * rollback that must remove a file the change created has no route through it.
 * The fallback is one `node -e` child that uses `node:fs`, which is honest
 * about what it does: it removes exactly one named file, is given no shell, and
 * reports whether the file is gone afterwards.
 *
 * @param {object} subprocess - the resolved `subprocess` service.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} path - the absolute file to remove.
 * @returns {Promise<{ removed: boolean, via: string, error: string|null }>} the outcome.
 */
export async function removeFile(subprocess, fs, path) {
  const target = str(path)
  if (target === null) return { removed: false, via: 'none', error: 'no path was given' }

  if (typeof process === 'undefined' || str(process.execPath) === null) {
    return { removed: false, via: 'none', error: 'this host exposes no node executable, so a file cannot be removed' }
  }

  // The script is a literal, the path travels as data (base64) so no quoting or
  // shell rule can turn a filename into code.
  const payload = base64(target)
  const script =
    'const fs=require("node:fs");const p=Buffer.from(process.argv[1],"base64").toString("utf8");' +
    'try{fs.rmSync(p,{force:true});}catch(e){console.error(String(e&&e.message||e));process.exit(3);}' +
    'process.exit(fs.existsSync(p)?4:0);'

  const result = await runProcess(subprocess, { argv: [process.execPath, '-e', script, payload], timeoutMs: 20000 })
  if (result.ok) return { removed: true, via: 'node:fs', error: null }

  // Already gone is a success for this operation, not a failure.
  if (fs !== undefined && fs !== null && typeof fs.stat === 'function') {
    try {
      const info = await fs.stat(await fs.resolve(target))
      if (info === undefined) return { removed: true, via: 'fs.stat (already absent)', error: null }
    } catch {
      return { removed: true, via: 'fs.stat (already absent)', error: null }
    }
  }

  return {
    removed: false,
    via: 'node:fs',
    error: result.error ?? `removal exited ${String(result.exitCode)}: ${firstLine(result.stderr) ?? 'no message'}`,
  }
}

/**
 * Base64 one string without `node:Buffer`.
 *
 * A hand-rolled encoder keeps the host half free of a second Node import for a
 * job this small, and it is trivially testable.
 * @param {string} text - UTF-8 text.
 * @returns {string} standard base64.
 */
export function base64(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = utf8Bytes(String(text))
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
 * UTF-8 encode a string to bytes, without `TextEncoder` assumptions.
 * @param {string} text - the input.
 * @returns {number[]} the bytes.
 */
function utf8Bytes(text) {
  const out = []
  for (let i = 0; i < text.length; i += 1) {
    let code = text.codePointAt(i)
    if (code > 0xffff) i += 1
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    } else {
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    }
  }
  return out
}

/**
 * Format one probe for a log line or a panel notice.
 * @param {string} name - the tool name.
 * @param {object} probe - a probe result.
 * @returns {string} one readable line.
 */
export function describeProbe(name, probe) {
  if (probe !== null && probe !== undefined && probe.available === true) {
    return `${name}=ready${probe.version === undefined || probe.version === null ? '' : ` (${probe.version})`}`
  }
  return `${name}=absent`
}
