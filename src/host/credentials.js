/**
 * The credential chain: everywhere a token may come from, and the few things
 * that may never happen to one.
 *
 * ## Why this file exists
 *
 * `gitremote.js` has always been able to send a bearer token, but the token
 * could only ever arrive one way: typed into the panel for that single request
 * ("A token is used only if the caller supplies one; none is stored"). Users do
 * not keep credentials there. They keep them in git's own helper, in the macOS
 * keychain (Sourcetree writes there too), in `gh`, or in an environment
 * variable — so a plugin that understands exactly one of those makes the user
 * re-type a secret it refuses to remember.
 *
 * ## The five rules this file is built around
 *
 * 1. **A token never leaves the host half.** The panel receives
 *    {@link credentialStatus}: source ids, availability, and a MASKED hint.
 *    Never the value, and never enough of it to reconstruct one.
 * 2. **A token is never interpolated into a message.** Failures are described
 *    by source and exit code. There is no `console.log` of a resolved value
 *    anywhere in this file, deliberately.
 * 3. **A token never reaches a snapshot.** Snapshots copy profile files (R5);
 *    this store lives under `$DSH_HOME/.dsh-pm/`, which is not one of them.
 * 4. **The store is 0600, and the sandbox is still obeyed.** `fs.writeText` has
 *    no mode argument, and the default umask yields a world-readable file — not
 *    acceptable for a credential. So the store is written through `node:fs`
 *    with an explicit mode. That does NOT dodge the deployment's file sandbox
 *    (which intercepts `node:fs` too): a refusal is reported verbatim, never
 *    worked around by asking for a wider mode.
 * 5. **A token never travels in a child's environment.** The subprocess seam
 *    scrubs credential-shaped names (`gitremote.js` documents this), so env
 *    sources are read in THIS process, and a value is only ever handed to a
 *    child as argv or stdin.
 *
 * ## What this file does NOT claim
 *
 * A token passed to a child as argv is visible to the same user through the
 * process table for the life of that child. That is a real tradeoff, it is what
 * `gitremote.js` already does, and it is written down here rather than papered
 * over. Moving it to stdin is a follow-up, not something this file pretends to
 * have solved.
 */

import { promises as nodeFs } from 'node:fs'
import {
  GH_AUTH_TOKEN_ARGS,
  GH_CANDIDATES,
  firstLine,
  joinPath,
  parentPath,
  resolveTool,
  runProcess,
} from './host.js'

/** Directory the plugin owns under `$DSH_HOME`. Nothing else is ever written. */
export const PLUGIN_STATE_DIR = '.dsh-pm'

/** Schema version of both JSON files, so a future shape can migrate honestly. */
export const STATE_VERSION = 1

/** The host this plugin talks to unless a remote says otherwise. */
export const DEFAULT_HOST = 'github.com'

/** Longest token accepted. Real ones are far shorter; the cap bounds the file. */
const TOKEN_MAX = 512

/** Source ids, in resolution order. `request` is the only non-persistent one. */
export const SOURCE_IDS = ['request', 'store', 'env', 'gh']

/**
 * Sources that are OFF until the user turns them on.
 *
 * Empty on purpose. There WERE two more sources here — `git credential fill` and
 * a direct `/usr/bin/security … -w` read — and both were REMOVED, not merely
 * disabled: they read the credential that Sourcetree stored and copied it into
 * this plugin's process. That is harvesting, and the user's instruction is the
 * opposite one: **operate Sourcetree so it authenticates the operation for us**
 * (see `gitdelegate.js`), and never take a copy of its credential. The helper's
 * answer goes to the git child that needs it, and this process only ever sees the
 * RESULT of the operation.
 */
export const DEFAULT_DISABLED_SOURCES = []

/** Environment names read IN THIS PROCESS, most specific first. */
export const ENV_TOKEN_NAMES = ['DSH_PM_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']

/**
 * Timeout for the one helper that is still spawned.
 *
 * The 4 s figure is kept from a measurement that no longer applies to this list
 * but still sets the scale: when this chain also read the OS keychain, a single
 * request took **20.04 s** because both keychain-touching helpers blocked until
 * their own deadline (macOS shows an authorization prompt for an item another app
 * created, and a spawned child has nobody to answer it). Those sources are gone;
 * what remains answers in milliseconds when it can answer at all.
 */
const HELPER_TIMEOUT_MS = 4000

/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * A token, or null when the value cannot be one.
 *
 * Control characters are refused rather than trimmed: a token ends up in an
 * `authorization:` header and in the line-based `git credential` protocol, and
 * a newline inside it would end that header or line early. That is a header
 * injection, not a formatting nit.
 *
 * @param {unknown} value - the candidate.
 * @returns {string|null} the trimmed token, or null.
 */
export function normalizeToken(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > TOKEN_MAX) return null
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

/**
 * A hint that identifies a token without revealing it.
 *
 * Short values are hidden entirely: showing 4 of 8 characters is showing half.
 * @param {unknown} value - the token.
 * @returns {string|null} e.g. `ghp_••••••abcd`, or null when there is no token.
 */
export function maskToken(value) {
  const token = normalizeToken(value)
  if (token === null) return null
  if (token.length <= 12) return '•'.repeat(token.length)
  return `${token.slice(0, 4)}${'•'.repeat(6)}${token.slice(-4)}`
}

/**
 * The host part of a remote URL, lowercased.
 *
 * Accepts the shapes `gitremote.js` parses (`https://`, `ssh://`, `git@host:`)
 * and refuses everything else, because a bogus host would send a credential to
 * the wrong place.
 * @param {unknown} value - a remote URL or a bare host.
 * @returns {string|null} the host, or null.
 */
export function normalizeHost(value) {
  const raw = str(value)
  if (raw === null) return null
  const bare = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw) ? raw : null
  if (bare !== null) return bare.toLowerCase()
  const scp = /^[a-z0-9._-]+@([a-z0-9.-]+\.[a-z]{2,}):/i.exec(raw)
  if (scp !== null) return scp[1].toLowerCase()
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?\//i.exec(raw)
  return url === null ? null : url[1].toLowerCase()
}

/**
 * Parse the line protocol `git credential fill` answers with.
 *
 * The protocol is `key=value` lines; a trailing blank line ends the record.
 * Unknown keys are ignored, and a missing `password` means "no credential".
 * @param {unknown} text - the helper's stdout.
 * @returns {{ username: string|null, password: string|null }} the fields.
 */
export function parseGitCredentialOutput(text) {
  const out = { username: null, password: null }
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cut = line.indexOf('=')
    if (cut <= 0) continue
    const key = line.slice(0, cut)
    const value = line.slice(cut + 1)
    if (key === 'username' && out.username === null) out.username = value
    if (key === 'password' && out.password === null) out.password = value
  }
  return out
}

/** Absolute paths of this plugin's two state files. */
export function pluginStateDir(dshHome) {
  return joinPath(String(dshHome), PLUGIN_STATE_DIR)
}
/** @param {string} dshHome - `$DSH_HOME`. @returns {string} the credential store path. */
export function credentialsPath(dshHome) {
  return joinPath(pluginStateDir(dshHome), 'credentials.json')
}
/** @param {string} dshHome - `$DSH_HOME`. @returns {string} the settings path. */
export function settingsPath(dshHome) {
  return joinPath(pluginStateDir(dshHome), 'settings.json')
}

/**
 * Turn a write failure into something a user can act on.
 *
 * The sandbox case is called out by name because it is the one failure that
 * looks like a bug in the plugin when it is actually a policy decision.
 * @param {unknown} error - the thrown value.
 * @returns {string} the explanation.
 */
function explainWriteFailure(error) {
  const code = error !== null && typeof error === 'object' ? error.code : null
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'EPERM' || code === 'EACCES') {
    return `the file sandbox refused the write (${message}). The state directory lives outside this session's writable root; nothing was written.`
  }
  return message
}

/**
 * Read one JSON object, saying WHY it was unusable.
 *
 * A corrupt file is reported rather than silently treated as absent: "you have
 * no saved token" and "your token file is broken" are different answers, and
 * only one of them is the user's fault.
 * @param {string} path - the file.
 * @returns {Promise<{ value: object|null, exists: boolean, mode: number|null, error: string|null }>} the read.
 */
async function readJsonObject(path) {
  let info = null
  try {
    info = await nodeFs.stat(path)
  } catch {
    return { value: null, exists: false, mode: null, error: null }
  }
  const actual = typeof info.mode === 'number' ? info.mode & 0o777 : null
  try {
    const parsed = JSON.parse(await nodeFs.readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, exists: true, mode: actual, error: 'the file does not contain a JSON object' }
    }
    return { value: parsed, exists: true, mode: actual, error: null }
  } catch (error) {
    return { value: null, exists: true, mode: actual, error: `the file could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Write one JSON object with an explicit mode.
 *
 * The `chmod` is not redundant: overwriting an existing file keeps its old
 * permissions, so a store created loosely once would stay loose forever.
 * @param {string} path - the file.
 * @param {object} value - the JSON payload.
 * @returns {Promise<{ ok: boolean, path: string, error: string|null }>} the write.
 */
async function writeJsonObject(path, value) {
  try {
    // The state directory is created 0700: the store inside it is 0600, and a
    // world-readable directory would list which hosts have saved tokens.
    await nodeFs.mkdir(parentPath(path), { recursive: true, mode: 0o700 })
  } catch {
    /* the directory may already exist; the write below reports a real failure */
  }
  try {
    await nodeFs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await nodeFs.chmod(path, 0o600)
    return { ok: true, path, error: null }
  } catch (error) {
    return { ok: false, path, error: explainWriteFailure(error) }
  }
}

/**
 * The saved credentials, keyed by host.
 * @param {string} dshHome - `$DSH_HOME`.
 * @returns {Promise<{ entries: object, exists: boolean, mode: number|null, error: string|null }>} the store.
 */
export async function readCredentialStore(dshHome) {
  const read = await readJsonObject(credentialsPath(dshHome))
  const entries = read.value !== null && read.value.entries !== null && typeof read.value.entries === 'object' ? read.value.entries : {}
  return { entries, exists: read.exists, mode: read.mode, error: read.error }
}

/**
 * Save one host's token, or forget it.
 *
 * @param {string} dshHome - `$DSH_HOME`.
 * @param {string} host - the host the token belongs to.
 * @param {string|null} token - the token, or null to remove the entry.
 * @returns {Promise<{ ok: boolean, path: string, error: string|null, removed: boolean }>} the write.
 */
export async function writeCredentialStore(dshHome, host, token) {
  const store = await readCredentialStore(dshHome)
  if (store.error !== null) return { ok: false, path: credentialsPath(dshHome), error: store.error, removed: false }

  const entries = { ...store.entries }
  const normalized = normalizeToken(token)
  if (normalized === null) {
    const existed = Object.prototype.hasOwnProperty.call(entries, host)
    delete entries[host]
    const written = await writeJsonObject(credentialsPath(dshHome), { version: STATE_VERSION, entries })
    return { ...written, removed: existed }
  }

  entries[host] = { token: normalized, savedAt: new Date().toISOString() }
  const written = await writeJsonObject(credentialsPath(dshHome), { version: STATE_VERSION, entries })
  return { ...written, removed: false }
}

/**
 * The plugin's own settings.
 *
 * Deliberately NOT the host's `settings` service and NOT `$DSH_HOME/settings.yaml`:
 * this is plugin state, it is read and written by this plugin alone, and it
 * lives in this plugin's directory (docs/plan.md §4.3).
 * @param {string} dshHome - `$DSH_HOME`.
 * @returns {Promise<{ defaultHost: string, disabledSources: string[], exists: boolean, error: string|null }>} the settings.
 */
export async function readSettings(dshHome) {
  const read = await readJsonObject(settingsPath(dshHome))
  const value = read.value ?? {}
  // Absent means "the user has not said", and the default list is empty: every
  // remaining source is one the user themself provided (a typed token, a saved
  // token, an environment variable, the `gh` CLI). Nothing here reads a
  // credential out of another application's store.
  const disabled = Array.isArray(value.disabledSources)
    ? value.disabledSources.filter((id) => SOURCE_IDS.includes(id))
    : [...DEFAULT_DISABLED_SOURCES]
  return {
    defaultHost: normalizeHost(value.defaultHost) ?? DEFAULT_HOST,
    disabledSources: disabled,
    // Which method the user CHOSE, as opposed to which ones are switched off.
    // `auto` is the chain; anything else means "ask only this one". Both are kept
    // because they answer different questions: a user who picks "the keychain"
    // still has an opinion about what `auto` would do if they switch back.
    preferredSource: normalizeSourceChoice(value.preferredSource),
    exists: read.exists,
    error: read.error,
  }
}

/**
 * A chosen method, or `auto`.
 *
 * `request` is not offered as a method: a token typed for one call is not
 * something to "always use", and a setting that says so would be a setting that
 * silently does nothing.
 * @param {unknown} value - the stored value.
 * @returns {string} `auto` or one of the chain's source ids.
 */
export function normalizeSourceChoice(value) {
  const id = str(value)
  if (id === null || id === 'auto') return 'auto'
  if (id === 'request' || !SOURCE_IDS.includes(id)) return 'auto'
  return id
}

/**
 * Save the plugin's settings.
 * @param {string} dshHome - `$DSH_HOME`.
 * @param {{ defaultHost?: unknown, disabledSources?: unknown, preferredSource?: unknown }} patch - the fields to set.
 * @returns {Promise<{ ok: boolean, path: string, error: string|null }>} the write.
 */
export async function writeSettings(dshHome, patch) {
  const current = await readSettings(dshHome)
  const next = {
    version: STATE_VERSION,
    defaultHost: normalizeHost(patch?.defaultHost) ?? current.defaultHost,
    disabledSources: Array.isArray(patch?.disabledSources)
      ? patch.disabledSources.filter((id) => SOURCE_IDS.includes(id))
      : current.disabledSources,
    preferredSource: patch?.preferredSource === undefined ? current.preferredSource : normalizeSourceChoice(patch.preferredSource),
  }
  return writeJsonObject(settingsPath(dshHome), next)
}

/**
 * One source attempt, in the shape the chain records.
 * @param {string} id - the source id.
 * @param {boolean} ok - whether it produced a token.
 * @param {string} detail - a secret-free explanation.
 * @param {string|null} [token] - the token, when it did.
 * @returns {object} the attempt.
 */
function attempt(id, ok, detail, token = null) {
  return { id, ok, detail, token: ok ? normalizeToken(token) : null }
}

/**
 * Read a token from the environment of THIS process.
 *
 * Not from a child's: the subprocess seam drops credential-shaped names, so a
 * helper would never see them.
 * @param {Record<string, string|undefined>} env - the environment.
 * @returns {{ token: string|null, name: string|null }} the token and where it came from.
 */
export function tokenFromEnv(env) {
  for (const name of ENV_TOKEN_NAMES) {
    const token = normalizeToken(env?.[name])
    if (token !== null) return { token, name }
  }
  return { token: null, name: null }
}

/**
 * Resolve a token, trying every source in order and recording each outcome.
 *
 * Never throws: a chain that throws would blank the panel instead of explaining
 * which sources were tried and why each missed.
 *
 * @param {object} input - `{ subprocess?, dshHome, host?, explicit?, env? }`.
 * @returns {Promise<{ token: string|null, source: string|null, host: string, tried: object[], error: string|null }>} the resolution.
 */
export async function resolveCredential(input) {
  const settings = await readSettings(input?.dshHome)
  const host = normalizeHost(input?.host) ?? settings.defaultHost
  const env = input?.env ?? (typeof process !== 'undefined' && process.env ? process.env : {})
  const disabled = new Set(settings.disabledSources)
  const tried = []

  // The user's CHOICE of method, which is a stronger statement than the list of
  // switched-off ones: "use only this". `input.source` lets a caller ask "would
  // THIS method work?" without saving that choice first, which is what the panel's
  // per-method test button does.
  const chosen = normalizeSourceChoice(input?.source ?? settings.preferredSource)
  const only = chosen === 'auto' ? null : chosen
  /** May this source be asked at all? */
  const allowed = (id) => (only === null ? !disabled.has(id) : only === id)
  /** Why a source was not asked. Never silent: an unasked source is reported. */
  const whyNot = (id) =>
    only === null ? 'this source is disabled in settings' : `the chosen method is "${String(only)}", so this source is not asked`

  const explicit = normalizeToken(input?.explicit)
  if (explicit !== null) {
    tried.push(attempt('request', true, 'a token supplied with this request'))
    return { token: explicit, source: 'request', host, tried, error: null }
  }
  tried.push(attempt('request', false, 'no token was supplied with this request'))

  const store = await readCredentialStore(input?.dshHome)
  if (!allowed('store')) {
    tried.push(attempt('store', false, whyNot('store')))
  } else if (store.error !== null) {
    tried.push(attempt('store', false, store.error))
  } else {
    const entry = store.entries?.[host]
    const token = normalizeToken(entry?.token)
    if (token === null) tried.push(attempt('store', false, `no token is saved for ${host}`))
    else {
      tried.push(attempt('store', true, `saved for ${host} at ${str(entry?.savedAt) ?? 'an unknown time'}`, token))
      return { token, source: 'store', host, tried, error: null }
    }
  }

  const fromEnv = tokenFromEnv(env)
  if (!allowed('env')) tried.push(attempt('env', false, whyNot('env')))
  else if (fromEnv.token === null) tried.push(attempt('env', false, `none of ${ENV_TOKEN_NAMES.join(', ')} is set`))
  else {
    tried.push(attempt('env', true, `read from ${fromEnv.name}`, fromEnv.token))
    return { token: fromEnv.token, source: 'env', host, tried, error: null }
  }

  for (const id of ['gh']) {
    if (!allowed(id)) {
      tried.push(attempt(id, false, whyNot(id)))
      continue
    }
    const result = await runSource(id, input?.subprocess)
    tried.push(attempt(id, result.ok, result.detail, result.token))
    if (result.ok) return { token: result.token, source: id, host, tried, error: null }
  }

  const seen = tried.map((entry) => `${entry.id} (${entry.detail})`).join('; ')
  return {
    token: null,
    source: null,
    host,
    tried,
    error:
      only === null
        ? `no credential for ${host} could be found in any source: ${seen}`
        : `the chosen method ("${String(only)}") produced no credential for ${host}: ${seen}`,
  }
}

/**
 * Why a child produced nothing, in the most specific words available.
 *
 * ⚠️ `exitCode: null` on its own is NOT a diagnosis. A refused spawn, an absent
 * `subprocess` service, a killed child and a timed-out one all report a null
 * exit code, and a message that stops there sends the reader looking in the
 * wrong place. The seam's own `error` and the child's first stderr line are what
 * tell them apart, so both are carried into the report.
 *
 * @param {object} result - a `runProcess` result.
 * @returns {string} the explanation.
 */
function describeFailure(result) {
  const parts = []
  const error = str(result?.error)
  if (error !== null) parts.push(error)
  if (result?.timedOut === true) parts.push('it was terminated at the deadline')
  const stderr = firstLine(result?.stderr)
  if (stderr !== null) parts.push(stderr)
  if (parts.length === 0) parts.push(`it exited ${String(result?.exitCode ?? 'null')} with no message`)
  return parts.join('; ')
}

/**
 * Run one local helper and read the token out of its output.
 *
 * `GIT_TERMINAL_PROMPT=0` matters: without it a `git credential fill` that no
 * helper can answer blocks on a prompt until the timeout, which in a web
 * request looks like a hang rather than a missing credential.
 *
 * @param {string} id - `git-credential`, `keychain` or `gh`.
 * @param {object} subprocess - the resolved `subprocess` service.
 * @param {string} host - the host to ask about.
 * @returns {Promise<{ ok: boolean, detail: string, token: string|null }>} the outcome.
 */
async function runSource(id, subprocess) {
  if (id !== 'gh') return { ok: false, detail: `unknown source "${String(id)}"`, token: null }

  let binary = null
  for (const candidate of GH_CANDIDATES) {
    binary = await resolveTool(subprocess, candidate)
    if (binary !== null) break
  }
  if (binary === null) return { ok: false, detail: 'the gh CLI is not installed', token: null }

  const result = await runProcess(subprocess, { argv: [binary, ...GH_AUTH_TOKEN_ARGS], cwd: '.', timeoutMs: HELPER_TIMEOUT_MS })
  if (!result.ok) return { ok: false, detail: `gh auth token produced nothing: ${describeFailure(result)}`, token: null }
  const token = normalizeToken(result.stdout)
  if (token === null) return { ok: false, detail: 'gh is not signed in', token: null }
  return { ok: true, detail: 'read from the gh CLI', token }
}


/**
 * The secret-free projection the panel is allowed to receive.
 *
 * Availability is a CAPABILITY fact (is the tool on PATH, is this macOS) and
 * costs no subprocess, so a settings page can render the whole chain without
 * spawning four children. Whether the chain actually YIELDS a token is answered
 * by {@link resolveCredential}, whose result also never carries a raw token.
 *
 * @param {object} input - `{ subprocess?, dshHome, host? }`.
 * @returns {Promise<object>} the status.
 */
export async function credentialStatus(input) {
  const settings = await readSettings(input?.dshHome)
  const host = normalizeHost(input?.host) ?? settings.defaultHost
  const store = await readCredentialStore(input?.dshHome)
  const saved = store.entries?.[host] ?? null
  const env = input?.env ?? (typeof process !== 'undefined' && process.env ? process.env : {})
  const fromEnv = tokenFromEnv(env)

  let gh = null
  for (const candidate of GH_CANDIDATES) {
    gh = await resolveTool(input?.subprocess, candidate)
    if (gh !== null) break
  }
  const disabled = new Set(settings.disabledSources)

  return {
    ok: true,
    host,
    defaultHost: settings.defaultHost,
    disabledSources: settings.disabledSources,
    store: {
      path: credentialsPath(input?.dshHome),
      // `exists` is separate from `saved`: a store file can exist and hold
      // nothing, and a file's MODE is only a fact about a file that is there.
      // Reporting "not 0600" for an absent file is a false alarm — measured in
      // the live panel before this field existed.
      exists: store.exists,
      saved: saved !== null,
      hint: maskToken(saved?.token),
      savedAt: str(saved?.savedAt),
      mode: store.mode,
      modeSafe: store.mode === 0o600,
      error: store.error,
    },
    settingsError: settings.error,
    preferredSource: settings.preferredSource,
    // Every entry is a fact about the machine or the store — never a token.
    // `chosen` is the answer to "is this the method the user picked?", which the
    // panel needs in order to render one selection rather than reconstruct it.
    sources: [
      { id: 'request', available: true, detail: 'a token typed into the panel, used for that request only', disabled: false, chosen: false },
      { id: 'store', available: saved !== null, detail: `this plugin's own 0600 file`, disabled: disabled.has('store'), chosen: settings.preferredSource === 'store' },
      { id: 'env', available: fromEnv.token !== null, detail: fromEnv.name === null ? `none of ${ENV_TOKEN_NAMES.join(', ')} is set` : `read from ${fromEnv.name}`, disabled: disabled.has('env'), chosen: settings.preferredSource === 'env' },
      { id: 'gh', available: gh !== null, detail: gh === null ? 'the gh CLI is not installed' : 'the gh CLI', disabled: disabled.has('gh'), chosen: settings.preferredSource === 'gh' },
    ],
  }
}

/**
 * A resolution result with every token removed.
 *
 * {@link resolveCredential} hands back the token because its caller needs it to
 * make a request. Everything that BOUNDS for the browser goes through here
 * first, so "did a source yield a token, and which one" stays answerable without
 * shipping one. This is the only projection a route may send.
 *
 * @param {object} resolution - a {@link resolveCredential} result.
 * @returns {object} the same shape, minus every token.
 */
export function redactResolution(resolution) {
  return {
    resolved: normalizeToken(resolution?.token) !== null,
    source: str(resolution?.source),
    host: str(resolution?.host),
    tried: Array.isArray(resolution?.tried)
      ? resolution.tried.map((entry) => ({ id: str(entry?.id), ok: entry?.ok === true, detail: str(entry?.detail) }))
      : [],
    error: str(resolution?.error),
  }
}

/**
 * The settings projection, secret-free by construction.
 * @param {string} dshHome - `$DSH_HOME`.
 * @returns {Promise<object>} the settings status.
 */
export async function settingsStatus(dshHome) {
  const settings = await readSettings(dshHome)
  return {
    ok: settings.error === null,
    defaultHost: settings.defaultHost,
    disabledSources: settings.disabledSources,
    preferredSource: settings.preferredSource,
    path: settingsPath(dshHome),
    exists: settings.exists,
    error: settings.error,
  }
}
