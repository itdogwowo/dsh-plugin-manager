/**
 * A git credential file this plugin owns, and the arguments that make ONE git
 * child read it.
 *
 * ## Why this file exists
 *
 * A checkout update runs `git fetch` / `git merge --ff-only` with the git on
 * PATH, which leaves the decision "do we have a credential?" to whatever helper
 * the OS has configured — and when the answer is no, the user is asked for a
 * password by a child that has nobody to ask. The plugin meanwhile holds a token
 * in its own 0600 store (`credentials.js`), put there by the user precisely so
 * that a background operation would not need to ask. The one child that DOES
 * need the token never saw it. That is the gap this file closes.
 *
 * ## How, and the one tradeoff
 *
 * git's `store` helper reads a file of `https://<user>:<token>@<host>` lines, so
 * the token is written to a file inside this plugin's own state directory and
 * the git child is given `-c credential.helper=store --file=<that file>`. The
 * empty `credential.helper=` comes FIRST on purpose: git's helpers accumulate,
 * and a `-c` entry alone would leave the inherited helper in the list — which is
 * exactly the helper that raises the OS prompt this is meant to avoid.
 *
 * ⚠️ **What is NOT claimed:** the credential exists as a file on disk for the
 * length of the run. It is written before the pipeline starts, it is 0600, it
 * lives under `$DSH_HOME/.dsh-pm/` (never in the profile, never in this
 * repository), and the caller removes it in a `finally` once the run settles —
 * success, refusal or thrown error. A same-user process that reads it DURING the
 * run can still read it. That is the tradeoff of a file-based helper, and it is
 * written down here rather than papered over.
 *
 * ⚠️ **The token never enters argv.** Only the file PATH does. Nothing in this
 * file logs, returns or reports the token itself.
 */

import { promises as nodeFs } from 'node:fs'
import { joinPath, parentPath } from './host.js'
import { PLUGIN_STATE_DIR, normalizeHost, normalizeToken } from './credentials.js'

/** The credential file's name inside the plugin's own state directory. */
export const GIT_CREDENTIAL_FILE = 'git-credentials.tmp'

/**
 * The user part of a store line when the caller does not know the account.
 *
 * The caller has a token, not a user name — and HTTPS basic auth on the hosts
 * this package talks to takes the token as the password regardless of the user
 * part. Writing the REAL account name would put the user's identity into a file
 * for no functional gain, which this repository's privacy rule forbids anyway.
 */
const PLACEHOLDER_USER = 'git'

/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Turn a write failure into something a user can act on. */
function explainWriteFailure(error) {
  const code = error !== null && typeof error === 'object' ? error.code : null
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'EPERM' || code === 'EACCES') {
    return `the file sandbox refused the write (${message}). The state directory lives outside this session's writable root; the git child was left to authenticate on its own.`
  }
  return message
}

/**
 * Where the credential file goes: this plugin's OWN state directory.
 *
 * Derived from the same constant the credential store uses, so the two can never
 * drift apart. It is deliberately NOT inside the profile (a snapshot copies
 * profile files — R5) and NOT inside this repository.
 *
 * @param {string} dshHome - `$DSH_HOME`.
 * @returns {string} the file path.
 */
export function storeFilePath(dshHome) {
  return joinPath(joinPath(String(dshHome), PLUGIN_STATE_DIR), GIT_CREDENTIAL_FILE)
}

/**
 * Write one host's credential in git's `store` helper format.
 *
 * `node:fs` with an explicit mode plus an explicit `chmod`, for the reason
 * `credentials.js` documents: `fs.writeText` has no mode argument, the default
 * umask yields a world-readable file, and overwriting an existing file keeps its
 * old permissions. A refusal from the deployment's sandbox is returned verbatim
 * and never worked around by asking for a wider mode.
 *
 * Never throws: every failure comes back as `{ ok: false, error }`, because the
 * caller is an HTTP route and a credential file is not worth a 500.
 *
 * @param {string} path - where to write (see {@link storeFilePath}).
 * @param {string} host - the host the credential belongs to.
 * @param {string|null} [username] - the account, when known; a placeholder otherwise.
 * @param {string} token - the token.
 * @returns {Promise<{ ok: boolean, path: string, error: string|null }>} the write.
 */
export async function writeStoreFile(path, host, username, token) {
  const target = str(path)
  if (target === null) return { ok: false, path: String(path), error: 'no path was given for the credential file' }

  const normalizedHost = normalizeHost(host)
  if (normalizedHost === null) {
    return { ok: false, path: target, error: `"${String(host)}" is not a host a credential may be sent to` }
  }
  const secret = normalizeToken(token)
  if (secret === null) {
    return { ok: false, path: target, error: 'the token is empty, or holds a control character a credential line cannot carry' }
  }
  const user = str(username) ?? PLACEHOLDER_USER
  if (!/^[A-Za-z0-9._-]+$/.test(user)) {
    return { ok: false, path: target, error: 'the user name holds a character a credential line cannot carry' }
  }

  // Username and password are percent-encoded because the line IS a URL: a token
  // containing `@`, `:` or `/` would otherwise end the user part or the host
  // part early, and git would send the wrong secret to the wrong place. Ordinary
  // tokens are alphanumeric and pass through unchanged.
  const line = `https://${encodeURIComponent(user)}:${encodeURIComponent(secret)}@${normalizedHost}\n`

  try {
    // The state directory is created 0700: the file inside it is 0600, and a
    // world-readable directory would list what this plugin keeps.
    await nodeFs.mkdir(parentPath(target), { recursive: true, mode: 0o700 })
  } catch {
    /* the directory may already exist; the write below reports a real failure */
  }
  try {
    await nodeFs.writeFile(target, line, { mode: 0o600 })
    await nodeFs.chmod(target, 0o600)
    return { ok: true, path: target, error: null }
  } catch (error) {
    return { ok: false, path: target, error: explainWriteFailure(error) }
  }
}

/**
 * The `--file` word as git will hand it to the helper.
 *
 * git runs a helper string through the shell when it contains anything the shell
 * cares about, so an unquoted path with a space in it — the common case being a
 * Windows account name — would be split into two arguments and the helper would
 * read the wrong file, or none. The plain spelling is kept for an ordinary path,
 * so the arguments stay exactly `store --file=<path>` unless quoting is needed.
 *
 * @param {string} file - the credential file path.
 * @returns {string} the word to put after `--file=`.
 */
function helperFileWord(file) {
  if (/^[A-Za-z0-9._/:+=@,-]+$/.test(file)) return file
  return '"' + file.replace(/(["\\$`])/g, '\\$1') + '"'
}

/**
 * The git arguments that make ONE child read this file and nothing else.
 *
 * The empty entry first clears every inherited helper (git accumulates them, and
 * an inherited helper is what raises the OS prompt); the second entry is this
 * plugin's own file. Both are `-c`, which is scoped to this one command: nothing
 * is written to the user's git config and no environment variable is set.
 *
 * @param {string} path - the credential file path.
 * @returns {string[]} the arguments, or `[]` when no path was given.
 */
export function credentialArgsFor(path) {
  const file = str(path)
  if (file === null) return []
  return ['-c', 'credential.helper=', '-c', `credential.helper=store --file=${helperFileWord(file)}`]
}

/**
 * Whether an argv runs a git binary.
 *
 * Matched on the file NAME, not the whole string: the plan spells the binary
 * `git`, while the pipeline materialises it to an absolute path (and on Windows
 * to `git.exe`), and both are the same program.
 *
 * @param {unknown} argv - the argument list.
 * @returns {boolean} true when it runs git.
 */
export function isGitArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false
  const name = String(argv[0]).split(/[\\/]/).pop().toLowerCase()
  return name === 'git' || name === 'git.exe'
}

/**
 * An argv with credential arguments spliced in immediately after the binary.
 *
 * Returns a NEW array so a caller can hold the original (the plan's argv is the
 * record of what was PLANNED; the injected one is what RUNS). An argv that does
 * not run git is returned untouched — a `node <dsh bin>` command is not a place
 * to put a git config override.
 *
 * @param {unknown} argv - the argument list.
 * @param {unknown} args - the arguments to insert (see {@link credentialArgsFor}).
 * @returns {unknown} the injected argv, or the input unchanged.
 */
export function withCredentialArgs(argv, args) {
  if (isGitArgv(argv) !== true) return argv
  const injected = Array.isArray(args) ? args.map(String) : []
  if (injected.length === 0) return [...argv]
  return [String(argv[0]), ...injected, ...argv.slice(1).map(String)]
}

/**
 * Delete the credential file, best effort.
 *
 * Called from a `finally`, so it must never throw and must never make a run look
 * failed: the run's own result is the answer, and a file that could not be
 * removed is reported rather than escalated. `force: true` also makes an absent
 * file a success, which is the normal case when no credential was written.
 *
 * @param {string} path - the file to remove.
 * @returns {Promise<{ ok: boolean, error: string|null }>} the removal.
 */
export async function removeStoreFile(path) {
  const target = str(path)
  if (target === null) return { ok: true, error: null }
  try {
    await nodeFs.rm(target, { force: true })
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
