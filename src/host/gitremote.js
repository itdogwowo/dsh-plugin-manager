/**
 * Asking a REMOTE for its refs — the one request in this package that leaves the machine.
 *
 * ## Why this is a separate, deliberate action
 *
 * Every other read in dsh-plugin-manager touches only this machine and can
 * therefore be run at any time. This one cannot: it tells the network which
 * repository you are looking at. So it is never part of a normal panel load and
 * never part of a version check — it runs only when the user presses a button
 * that says what it does (docs/plan.md §4.6, and the `reachability` strategy
 * parameter that documents the boundary).
 *
 * ## Why a child process instead of a socket in this process
 *
 * Two measured reasons, neither of them stylistic:
 *
 * 1. **PowerShell's HTTPS is broken on the reference machine** — every TLS
 *    request through `Invoke-RestMethod` or `curl.exe` fails with
 *    `SEC_E_NO_CREDENTIALS` (Windows Schannel). Node's own stack works. The
 *    request therefore has to be made BY NODE, and this half may not open
 *    sockets itself in the sandbox.
 * 2. **Bearer tokens** for private repositories must be passed as argv, not as
 *    environment entries: the `subprocess` seam deliberately scrubs
 *    credential-shaped environment names (`SENSITIVE_ENV_PATTERN`), so
 *    `GITHUB_TOKEN` in `env` would be dropped without a word.
 *
 * The child is `node -e <literal>`; the addresses travel as base64, so no URL
 * or token can be interpreted as code, and no shell is involved.
 *
 * R1 applies: `node:` and relative imports only.
 */

import { base64, firstLine, runProcess } from './host.js'
import { parseRemoteRefs, remoteApiFor } from './gitrefs.js'

/** How long the remote is given to answer, in milliseconds. */
export const REMOTE_TIMEOUT_MS = 20000

/** Cap on how many refs are read from one remote listing. */
export const MAX_REMOTE_REFS = 100

/**
 * The child that performs the two requests and prints one JSON verdict per line.
 *
 * A literal, not a template: nothing about the repository reaches this text
 * except as data. `fetch` is Node's own; the user agent is set because GitHub
 * rejects requests without one.
 */
const FETCH_SCRIPT = [
  'const spec=JSON.parse(Buffer.from(process.argv[1],"base64").toString("utf8"));',
  'const headers={accept:"application/vnd.github+json","user-agent":"dsh-plugin-manager"};',
  'if(spec.token)headers.authorization="Bearer "+spec.token;',
  'for(const [label,url] of Object.entries(spec.urls)){',
  '  try{',
  '    const res=await fetch(url,{headers,signal:AbortSignal.timeout(spec.timeoutMs)});',
  '    const text=await res.text();',
  '    let body=null;try{body=JSON.parse(text)}catch(e){body=null}',
  '    const message=body&&!Array.isArray(body)&&typeof body.message==="string"?body.message:(res.ok?"":text.slice(0,200));',
  '    const rate=res.headers.get("x-ratelimit-remaining");',
  '    process.stdout.write(JSON.stringify({ok:res.ok,label,status:res.status,message:message||null,rate:rate===null?null:Number(rate),body:body})+"\\n");',
  '  }catch(e){',
  '    process.stdout.write(JSON.stringify({ok:false,label,status:0,message:String(e&&e.message||e),rate:null,body:null})+"\\n");',
  '  }',
  '}',
].join('')

/**
 * Build the request spec for one remote, or explain why there is none.
 *
 * Pure: no network, no `fs`. It exists so the "which provider, which URL, is a
 * token even usable here" decision is testable without a connection.
 *
 * @param {object} remote - the result of `parseRemoteUrl`.
 * @param {string|null} token - an optional bearer token.
 * @returns {{ ok: boolean, provider?: string, urls?: object, token?: string|null, note?: string, error?: string }} the spec.
 */
export function buildRefRequest(remote, token) {
  const api = remoteApiFor(remote)
  if (api === null) {
    return {
      ok: false,
      error:
        remote !== null && remote !== undefined && remote.ok === true
          ? `no ref-listing API is implemented for host "${remote.host}"; only github.com is verified, and guessing another host's endpoint would produce a failure you could not act on`
          : `the remote could not be parsed: ${remote?.error ?? 'no remote was given'}`,
    }
  }
  return {
    ok: true,
    provider: api.provider,
    urls: { tags: api.tags, branches: api.branches },
    token: typeof token === 'string' && token.length > 0 ? token : null,
    note: api.note,
  }
}

/**
 * Interpret one child verdict line.
 *
 * Separated from the spawn so the two failure shapes — "the network refused" and
 * "the payload is not a list" — are distinguishable in a test.
 * @param {object} line - one decoded verdict.
 * @returns {{ ok: boolean, status: number, error: string|null }} the reading.
 */
export function interpretVerdict(line) {
  if (line === null || typeof line !== 'object') return { ok: false, status: 0, error: 'the child printed no verdict' }
  const status = typeof line.status === 'number' ? line.status : 0
  if (line.ok === true && Array.isArray(line.body)) return { ok: true, status, error: null }
  if (line.ok === true) return { ok: false, status, error: 'the remote answered with something that is not a list of refs' }
  const rate = typeof line.rate === 'number' ? line.rate : null
  const detail = typeof line.message === 'string' && line.message.length > 0 ? line.message : `HTTP ${status}`
  const hint = status === 403 && rate === 0 ? ' (the unauthenticated hourly limit is exhausted; it resets on the hour)' : ''
  return { ok: false, status, error: `${detail}${hint}` }
}

/**
 * Ask the remote for its tag and branch names.
 *
 * Never throws. A failure is an ANSWER here — "the remote could not be asked"
 * must never be rendered as "there is nothing newer".
 *
 * @param {object} subprocess - the resolved `subprocess` service.
 * @param {object} remote - the result of `parseRemoteUrl`.
 * @param {object} [options] - `{ token?, timeoutMs? }`.
 * @returns {Promise<object>} plain-JSON result.
 */
export async function fetchRemoteRefs(subprocess, remote, options = {}) {
  const out = {
    ok: false,
    provider: null,
    host: remote?.host ?? null,
    webUrl: remote?.webUrl ?? null,
    tags: [],
    branches: [],
    counts: { tags: 0, branches: 0 },
    truncated: false,
    status: null,
    tokenUsed: false,
    note: null,
    error: null,
  }

  const spec = buildRefRequest(remote, options.token)
  if (spec.ok !== true) {
    out.error = spec.error
    return out
  }
  out.provider = spec.provider
  out.note = spec.note
  out.tokenUsed = spec.token !== null

  if (typeof process === 'undefined' || typeof process.execPath !== 'string' || process.execPath.length === 0) {
    out.error = 'this host exposes no node executable, so the remote cannot be asked'
    return out
  }

  const payload = base64(JSON.stringify({ urls: spec.urls, token: spec.token, timeoutMs: typeof options.timeoutMs === 'number' ? options.timeoutMs : REMOTE_TIMEOUT_MS }))
  const result = await runProcess(subprocess, {
    argv: [process.execPath, '-e', FETCH_SCRIPT, payload],
    cwd: '.',
    timeoutMs: (typeof options.timeoutMs === 'number' ? options.timeoutMs : REMOTE_TIMEOUT_MS) + 10000,
  })

  if (!result.ok) {
    out.error = result.error ?? `the request child exited ${String(result.exitCode)}: ${firstLine(result.stderr) ?? 'no message'}`
    return out
  }

  const verdicts = {}
  for (const raw of result.stdout.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    let decoded = null
    try {
      decoded = JSON.parse(line)
    } catch {
      continue
    }
    const reading = interpretVerdict(decoded)
    verdicts[decoded.label] = { reading, body: decoded.body }
    if (out.status === null) out.status = decoded.status
  }

  if (verdicts.tags === undefined && verdicts.branches === undefined) {
    out.error = 'the request child returned no verdict, so nothing is claimed about the remote'
    return out
  }

  const failures = []
  for (const [label, entry] of Object.entries(verdicts)) {
    if (entry.reading.ok !== true) failures.push(`${label}: ${entry.reading.error}`)
  }
  if (failures.length === Object.keys(verdicts).length) {
    // Both halves failed: report the first reason verbatim rather than a summary
    // that hides whether it was a 404, a rate limit or no network at all.
    out.error = failures.join('; ')
    return out
  }

  const parsed = parseRemoteRefs(verdicts.tags?.body ?? null, verdicts.branches?.body ?? null)
  if (parsed.tags.length > MAX_REMOTE_REFS || parsed.branches.length > MAX_REMOTE_REFS) out.truncated = true
  out.tags = parsed.tags.slice(0, MAX_REMOTE_REFS)
  out.branches = parsed.branches.slice(0, MAX_REMOTE_REFS)
  out.counts = { tags: out.tags.length, branches: out.branches.length }
  out.ok = true
  // A partial answer is still an answer, but the missing half is named.
  if (failures.length > 0) out.note = `${out.note ?? ''} — partial: ${failures.join('; ')}`.trim()
  return out
}
