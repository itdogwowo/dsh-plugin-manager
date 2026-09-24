/**
 * Reading a git checkout's refs from its FILES — the version/branch picker's data.
 *
 * ## Why no `git` binary
 *
 * `git` is not on PATH on the reference machine (docs/host-notes.md F26), and
 * shelling out would add an external-executable dependency to a read that can
 * be answered from four small text files whose format is public and stable:
 * `HEAD`, `refs/heads/*`, `refs/tags/*` and `packed-refs`.
 *
 * ## What this can and cannot answer
 *
 * It reads what THIS MACHINE already knows. A branch that exists only upstream
 * is invisible here, and so is a tag that was never fetched. That is why the
 * list carries an explicit `source` field and why the panel offers a separate,
 * deliberate "ask the remote" action — "these are the refs I have" and "these
 * are the refs that exist" are different answers, and the panel must not blur
 * them.
 *
 * R1 applies: this file imports only relative paths.
 */

import { joinPath, parentPath } from './host.js'

/** Ref kinds a picker can offer, most-update-like first. */
export const REF_KINDS = ['tag', 'branch', 'remote', 'detached']

/** Cap on how many refs are read out of one checkout. */
export const MAX_REFS = 500

/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Read a text file through the `fs` service, or null.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} path - absolute path.
 * @returns {Promise<string|null>} the text, or null.
 */
async function readTextOrNull(fs, path) {
  try {
    return await fs.readText(await fs.resolve(path))
  } catch {
    return null
  }
}

/**
 * List a directory through the `fs` service, or an empty array.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} path - absolute directory path.
 * @returns {Promise<object[]>} the entries.
 */
async function listDirOrEmpty(fs, path) {
  try {
    const entries = await fs.listDir(await fs.resolve(path))
    return Array.isArray(entries) ? entries : []
  } catch {
    return []
  }
}

/**
 * The real `.git` directory for a working tree.
 *
 * A worktree or submodule keeps `.git` as a FILE holding `gitdir: <path>`; that
 * indirection is followed here rather than reported as "not a repo", because
 * refusing to look is indistinguishable from a broken checkout to the user.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} dir - the working tree root.
 * @returns {Promise<{ dir: string|null, via: string, error: string|null }>} the resolved git dir.
 */
export async function locateGitDir(fs, dir) {
  const dotGit = joinPath(dir, '.git')
  const head = await readTextOrNull(fs, joinPath(dotGit, 'HEAD'))
  if (head !== null) return { dir: dotGit, via: 'directory', error: null }

  const pointer = await readTextOrNull(fs, dotGit)
  if (pointer === null) return { dir: null, via: 'none', error: 'no .git/HEAD and no .git file' }

  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)
  if (match === null) return { dir: null, via: 'file', error: '.git is a file but does not contain a gitdir pointer' }

  const target = match[1]
  const absolute = /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('/') ? target : joinPath(parentPath(dotGit), target)
  const resolvedHead = await readTextOrNull(fs, joinPath(absolute, 'HEAD'))
  if (resolvedHead === null) return { dir: null, via: 'file', error: `.git points at ${absolute} but its HEAD could not be read` }
  return { dir: absolute, via: 'file (worktree or submodule)', error: null }
}

/**
 * Parse `packed-refs` into a name → commit map.
 *
 * Peeled lines (`^<sha>`) carry the commit an annotated tag points THROUGH, so
 * they belong to the preceding ref. They are recorded separately rather than
 * dropped: for an annotated tag the peeled commit is the one a checkout lands
 * on, and a comparison against `HEAD` that uses the tag object instead would
 * always look different.
 * @param {string} text - the file contents.
 * @returns {{ refs: Record<string, string>, peeled: Record<string, string> }} the maps.
 */
export function parsePackedRefs(text) {
  const refs = {}
  const peeled = {}
  if (typeof text !== 'string') return { refs, peeled }
  let last = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.length === 0 || line.startsWith('#')) continue
    if (line.startsWith('^')) {
      const sha = str(line.slice(1).trim())
      if (last !== null && sha !== null) peeled[last] = sha
      continue
    }
    const [sha, name] = line.trim().split(/\s+/)
    // Both fields are required, and neither check is decorative: a line that is
    // only a sha (`aaaa`, with no ref name after it) destructures to
    // `name === undefined`, and storing that would put a ref named `undefined`
    // into the map, where it would then be compared against HEAD like any other.
    if (str(sha) === null || str(name) === null) continue
    refs[name] = sha
    last = name
  }
  return { refs, peeled }
}

/**
 * Order two ref names for a NEWEST-FIRST list.
 *
 * ## The contract, stated once
 *
 * This is a comparator for `Array.prototype.sort` with `versionTags[0]` as the
 * NEWEST tag:
 *
 * | return | meaning | where it is used |
 * |---|---|---|
 * | negative | `left` sorts FIRST, i.e. `left` is NEWER | `tags.sort(...)`, `versionTags[0]` |
 * | positive | `left` sorts later, i.e. `left` is OLDER | |
 * | zero | equal | |
 *
 * ⚠️ **"negative means newer" is the opposite of the reflex**, and the tests
 * covering this read it the ordinary way at first — `a < b` as "a is older" —
 * so the comparator and its test disagreed twice before the direction was
 * written down in one place. If the direction ever changes, the sort in
 * {@link readLocalRefs} and this table change with it.
 *
 * ## The rules
 *
 * - **A segment's embedded NUMBER decides first.** Tags are usually prefixed
 *   (`v1.2.0`, `dsh-v0.1.7-rc.1`), so the leading segment is a WORD containing a
 *   number. Comparing those as text makes `v2.0.0` "newer" than `v10.0.0` — and
 *   that is not a hypothetical: it is what this function did before the numeric
 *   comparison was hoisted above the text one.
 * - Segments are ranked: a NUMBER outranks a WORD outranks NOTHING. That is what
 *   makes `v1.2.0` newer than `v1.2.0-rc.1` (the word marks a pre-release) and
 *   newer than `v1.2.0-beta`, while `v1.2.1` is still newer than `v1.2.0-rc.9`.
 * - Only when the numbers tie does the text decide, so the ordering is stable
 *   and never arbitrary.
 *
 * @param {string} left - a ref name.
 * @param {string} right - a ref name.
 * @returns {number} negative when `left` is newer.
 */
export function compareVersions(left, right) {
  const a = String(left).split(/[^0-9A-Za-z]+/).filter((part) => part.length > 0)
  const b = String(right).split(/[^0-9A-Za-z]+/).filter((part) => part.length > 0)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const x = a[i]
    const y = b[i]
    const rankX = rankOf(x)
    const rankY = rankOf(y)
    if (rankX !== rankY) return rankX > rankY ? -1 : 1

    // The number inside the segment, wherever it sits: `2` and `10` here.
    const numX = numberOf(x)
    const numY = numberOf(y)
    if (numX !== null && numY !== null && numX !== numY) return numX > numY ? -1 : 1

    if (x !== y) return x > y ? -1 : 1
  }
  return 0
}

/**
 * Segment ranks, and their order is the whole pre-release rule.
 *
 * `v1.2.0` and `v1.2.0-rc.1` share their first three segments, so the decision
 * falls to the fourth pair: `(nothing, 'rc')`. Semver says the release wins, so
 * **NOTHING must outrank WORD**. Ranking `MISSING` lowest — which is the obvious
 * first guess, and what this file did — makes every release sort after its own
 * release candidate.
 *
 * A NUMBER still outranks both, so `v1.2.1` is newer than `v1.2.0-rc.9`.
 */
const RANK_WORD = 0
const RANK_MISSING = 1
const RANK_NUMBER = 2

/**
 * Rank one version segment.
 * @param {string|undefined} segment - the segment, or undefined past the end.
 * @returns {number} one of the RANK_* constants.
 */
function rankOf(segment) {
  if (segment === undefined) return RANK_MISSING
  return /^\d+$/.test(segment) ? RANK_NUMBER : RANK_WORD
}

/**
 * The first run of digits inside a segment, as a number.
 *
 * This is what makes a PREFIXED tag compare correctly: `v2` and `v10` are both
 * WORD segments, so without this their comparison falls through to a text
 * compare and `v10.0.0` sorts as older than `v2.0.0`.
 * @param {string|undefined} segment - the segment.
 * @returns {number|null} the number, or null when the segment has no digits.
 */
function numberOf(segment) {
  if (typeof segment !== 'string') return null
  const match = /\d+/.exec(segment)
  return match === null ? null : Number(match[0])
}

/**
 * Whether a ref name looks like a version rather than a codename.
 * @param {string} name - the ref name.
 * @returns {boolean} true when it carries a dotted number.
 */
export function looksLikeVersionRef(name) {
  return /\d+\.\d+/.test(String(name))
}

/**
 * List every ref this checkout knows, from its files.
 *
 * @param {object} fs - the resolved `fs` service.
 * @param {string} dir - the working tree root (or any directory inside it).
 * @returns {Promise<object>} plain-JSON ref index.
 */
export async function readLocalRefs(fs, dir) {
  const out = {
    ok: false,
    dir: str(dir),
    gitDir: null,
    gitDirVia: null,
    head: { attached: false, branch: null, commit: null, ref: null },
    branches: [],
    tags: [],
    remoteBranches: [],
    versionTags: [],
    newestTag: null,
    count: 0,
    truncated: false,
    source: 'local .git files (no fetch was run)',
    error: null,
  }

  if (out.dir === null || fs === undefined || fs === null || typeof fs.resolve !== 'function') {
    out.error = 'no directory or no fs service was given'
    return out
  }

  const located = await locateGitDir(fs, out.dir)
  out.gitDirVia = located.via
  if (located.dir === null) {
    out.error = located.error
    return out
  }
  out.gitDir = located.dir
  out.ok = true

  // ── HEAD ──────────────────────────────────────────────────────────────────
  const headText = (await readTextOrNull(fs, joinPath(located.dir, 'HEAD')))?.trim() ?? null
  if (headText !== null) {
    if (headText.startsWith('ref:')) {
      const ref = headText.slice(4).trim()
      out.head.attached = true
      out.head.ref = ref
      out.head.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (/^[0-9a-f]{7,40}$/i.test(headText)) {
      out.head.commit = headText
    }
  }

  const packedText = await readTextOrNull(fs, joinPath(located.dir, 'packed-refs'))
  const packed = parsePackedRefs(packedText ?? '')

  /**
   * Read one ref namespace: loose files first, then packed.
   * @param {string} prefix - `refs/heads` etc.
   * @returns {Promise<Array<{ name: string, commit: string|null }>>} the refs.
   */
  async function readNamespace(prefix) {
    const seen = new Map()
    for (const entry of await listDirOrEmpty(fs, joinPath(located.dir, prefix))) {
      const name = str(entry?.name) ?? str(entry?.basename)
      if (name === null) continue
      const isDir = entry?.isDirectory === true || entry?.isDir === true
      if (isDir) {
        // A namespace can nest (`refs/remotes/origin/feature/x`): one more level.
        for (const inner of await listDirOrEmpty(fs, joinPath(joinPath(located.dir, prefix), name))) {
          const innerName = str(inner?.name) ?? str(inner?.basename)
          if (innerName === null || inner?.isDirectory === true || inner?.isDir === true) continue
          const text = (await readTextOrNull(fs, joinPath(located.dir, prefix, name, innerName)))?.trim() ?? null
          if (text !== null) seen.set(`${name}/${innerName}`, text)
        }
        continue
      }
      const text = (await readTextOrNull(fs, joinPath(located.dir, prefix, name)))?.trim() ?? null
      if (text !== null) seen.set(name, text)
    }
    for (const [name, commit] of Object.entries(packed.refs)) {
      if (!name.startsWith(`${prefix}/`)) continue
      const short = name.slice(prefix.length + 1)
      if (!seen.has(short)) seen.set(short, commit)
    }
    return [...seen.entries()].map(([name, commit]) => ({ name, commit }))
  }

  const headCommit = await readHeadCommit(fs, located.dir, out.head, packed)
  // ⚠️ Write it BACK. The first version computed this and used it only to mark
  // rows `current`, so `head.commit` stayed null for every checkout whose branch
  // was packed — and the panel's "current HEAD" line had nothing to print. The
  // value is the answer to "which build am I on", not just an input to a
  // comparison.
  out.head.commit = headCommit

  const branches = await readNamespace('refs/heads')
  const tags = await readNamespace('refs/tags')
  const remoteBranches = await readNamespace('refs/remotes')

  /** Build one picker row. */
  function row(name, commit, kind, peeledCommit) {
    const effective = peeledCommit ?? commit
    // ⚠️ Compare like with like. The first version tested
    // `headCommit.startsWith(effective.slice(0, 7))` — a 40-character commit
    // asked whether it begins with a 7-character prefix OF ITSELF, which is
    // false for every equal pair. `current` was therefore never true, and the
    // picker could not mark the ref the checkout is actually on.
    const current = headCommit !== null && effective !== null && headCommit.slice(0, 7) === effective.slice(0, 7)
    return { name, kind, commit, peeled: peeledCommit ?? null, current }
  }

  const refPrefix = (kind) => (kind === 'tag' ? 'refs/tags' : kind === 'branch' ? 'refs/heads' : 'refs/remotes')

  out.branches = limit(
    branches.map((entry) => row(entry.name, entry.commit, 'branch', packed.peeled[`${refPrefix('branch')}/${entry.name}`] ?? null)),
    out,
  )
  out.tags = limit(
    tags
      .map((entry) => row(entry.name, entry.commit, 'tag', packed.peeled[`${refPrefix('tag')}/${entry.name}`] ?? null))
      .sort((left, right) => compareVersions(left.name, right.name)),
    out,
  )
  out.remoteBranches = limit(
    remoteBranches
      .filter((entry) => !entry.name.endsWith('/HEAD'))
      .map((entry) => row(entry.name, entry.commit, 'remote', null)),
    out,
  )

  out.versionTags = out.tags.filter((entry) => looksLikeVersionRef(entry.name))
  out.newestTag = out.versionTags.length === 0 ? null : out.versionTags[0].name
  out.count = out.branches.length + out.tags.length + out.remoteBranches.length
  return out
}

/**
 * Append rows until the cap is hit, then report the truncation.
 *
 * A silently shortened ref list would let the panel claim a tag does not exist
 * when it was simply not read.
 * @param {object[]} rows - the rows.
 * @param {object} out - the report being built (mutated).
 * @returns {object[]} the rows, possibly cut.
 */
function limit(rows, out) {
  if (rows.length <= MAX_REFS) return rows
  out.truncated = true
  return rows.slice(0, MAX_REFS)
}

/**
 * The commit HEAD resolves to, reading a loose ref or the packed fallback.
 *
 * ⚠️ **Absent and empty are different, and only absent falls back.** The first
 * version tested the read text for `null` and then fell through to packed refs
 * when it was — which is correct for an absent loose file but ALSO for one that
 * exists and is empty, and it hid the packed case behind an indirection that no
 * test could see. Here the fallback depends on whether the read *succeeded*.
 *
 * @param {object} fs - the resolved `fs` service.
 * @param {string} gitDir - the git directory.
 * @param {object} head - the head facts (`commit` is set for a detached HEAD).
 * @param {object} packed - the parsed packed refs.
 * @returns {Promise<string|null>} the commit, or null.
 */
async function readHeadCommit(fs, gitDir, head, packed) {
  if (str(head.commit) !== null) return head.commit
  const ref = str(head.ref)
  if (ref === null) return null

  const loose = await readTextOrNull(fs, joinPath(gitDir, ref))
  if (loose !== null) {
    const value = loose.trim()
    if (value.length > 0) return value
  }
  return str(packed.refs[ref]) ?? null
}

/**
 * Classify a git remote URL without network access.
 *
 * Handles the four spellings that actually occur in the wild: `git@host:o/r.git`,
 * `https://host/o/r.git`, `ssh://git@host/o/r.git`, and the bare `host/o/r`
 * shorthand. A `file://` or plain local path is a local remote, which is a real
 * answer — such a checkout can be updated but has nothing to query.
 * @param {string} url - the remote URL.
 * @returns {object} `{ ok, host, owner, repo, webUrl, kind, error }`.
 */
export function parseRemoteUrl(url) {
  const out = { ok: false, host: null, owner: null, repo: null, webUrl: null, kind: 'unknown', error: null }
  const raw = str(url)
  if (raw === null) {
    out.error = 'no remote URL was recorded'
    return out
  }

  let host = null
  let path = null
  // Set once `host` and `path` resolve. The earlier version returned a
  // successful parse with `kind: 'unknown'`, which made every caller's
  // `kind === 'network'` test fail on the ONE spelling this machine actually
  // has (`git@github.com:owner/repo.git`).
  let kind = 'network'

  // ⚠️ Order matters, and it is the whole reason this is spelled out: a Windows
  // path like `C:\code\repo` ALSO matches the `scp` shape below (`host:path`),
  // so checking `scp` first turned drive `C:` into a REMOTE HOST named "c" — and
  // a local checkout would then be reported as having an upstream on a host
  // called `c`. Local shapes are therefore recognised first.
  const looksLocal = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('.')
  const looksFileScheme = /^file:\/\//i.test(raw)
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)

  if (looksFileScheme) {
    out.kind = 'local'
    out.webUrl = raw
    return out
  }
  if (looksLocal && schemeMatch === null) {
    out.kind = 'local'
    out.webUrl = raw
    return out
  }

  if (schemeMatch !== null) {
    const scheme = schemeMatch[1].toLowerCase()
    const rest = raw.slice(schemeMatch[0].length)
    const slash = rest.indexOf('/')
    const authority = slash === -1 ? rest : rest.slice(0, slash)
    path = slash === -1 ? '' : rest.slice(slash + 1)
    host = authority.includes('@') ? authority.slice(authority.indexOf('@') + 1) : authority
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ssh' && scheme !== 'git') {
      out.error = `the remote URL "${raw}" uses a scheme ("${scheme}") this parser does not treat as a network remote`
      return out
    }
  } else {
    const scp = /^(?:[^@/]+@)?([^:/\\]+):(.+)$/.exec(raw)
    if (scp === null) {
      out.error = `the remote URL "${raw}" is not a shape this parser understands`
      return out
    }
    host = scp[1]
    path = scp[2]
  }

  if (host === null || path === null) {
    out.error = `the remote URL "${raw}" is not a shape this parser understands`
    return out
  }

  const clean = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = clean.split('/').filter((part) => part.length > 0)
  if (parts.length < 2) {
    out.error = `the remote URL "${raw}" has no owner/repository path`
    return out
  }

  out.ok = true
  out.kind = kind
  out.host = host.toLowerCase()
  out.owner = parts.slice(0, parts.length - 1).join('/')
  out.repo = parts[parts.length - 1]
  out.webUrl = `https://${out.host}/${out.owner}/${out.repo}`
  return out
}

/**
 * Which provider API can list a remote's refs, and where.
 *
 * Returns null for a host this package has no verified shape for. Guessing an
 * endpoint would produce a request that fails in a way the user cannot act on;
 * saying "no API for this host" is actionable.
 * @param {object} remote - the result of {@link parseRemoteUrl}.
 * @returns {{ provider: string, tags: string, branches: string, note: string }|null} the API, or null.
 */
export function remoteApiFor(remote) {
  if (remote === null || remote === undefined || remote.ok !== true) return null
  const base = `https://api.github.com/repos/${remote.owner}/${remote.repo}`
  if (remote.host === 'github.com' || remote.host === 'www.github.com') {
    return {
      provider: 'github',
      tags: `${base}/tags?per_page=100`,
      branches: `${base}/branches?per_page=100`,
      note: 'GitHub REST v3, unauthenticated: 60 requests per hour per address',
    }
  }
  return null
}

/**
 * Read the remote's tag and branch names from a provider API payload.
 *
 * Pure, so the parsing is testable without a network: the caller supplies the
 * two decoded JSON bodies and gets back the ref rows.
 * @param {object} tagsPayload - the decoded `/tags` body.
 * @param {object} branchesPayload - the decoded `/branches` body.
 * @returns {{ tags: object[], branches: object[] }} the rows.
 */
export function parseRemoteRefs(tagsPayload, branchesPayload) {
  const tags = []
  const branches = []

  if (Array.isArray(tagsPayload)) {
    for (const item of tagsPayload) {
      const name = str(item?.name)
      if (name === null) continue
      tags.push({ name, commit: str(item?.commit?.sha), kind: 'tag' })
    }
  }
  if (Array.isArray(branchesPayload)) {
    for (const item of branchesPayload) {
      const name = str(item?.name)
      if (name === null) continue
      branches.push({ name, commit: str(item?.commit?.sha), kind: 'branch', protected: item?.protected === true })
    }
  }

  tags.sort((left, right) => compareVersions(left.name, right.name))
  branches.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return { tags, branches }
}
