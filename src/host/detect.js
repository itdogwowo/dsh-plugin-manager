/**
 * Detection primitives: everything this module reads, it reads from FILES.
 *
 * ## Why no `git` and no crypto
 *
 * `git` is **not on PATH** on the reference machine (verified), so the host half
 * cannot shell out to learn a commit — and shelling out would fail on the next
 * machine in a new way. Git's on-disk format is stable and public, so the commit
 * is read from `.git/HEAD` plus the ref file it names. Same reasoning for the
 * tree fingerprint: a hand-rolled FNV-1a over `(path, size, mtime)` needs no
 * `node:crypto` import and no dependency, and it is deterministic.
 *
 * A fingerprint is a **change signal, not a security boundary**. It answers
 * "did this move", never "is this authentic".
 *
 * Everything here takes the `fs` **service**, never `node:fs` (docs/host-notes.md F7).
 */

/** Directory names never worth walking: VCS metadata and nested installs. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.pnpm', '.cache'])

/** FNV-1a 32-bit offset basis and prime. */
const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * Fold one string into an FNV-1a state.
 * @param {number} state - running hash.
 * @param {string} text - text to fold.
 * @returns {number} the new state.
 */
function fold(state, text) {
  let hash = state
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash
}

/**
 * Fingerprint a string as 8 lowercase hex digits.
 * @param {string} text - the input.
 * @returns {string} the digest.
 */
export function digestText(text) {
  return (fold(FNV_OFFSET, text) >>> 0).toString(16).padStart(8, '0')
}

/**
 * Coerce to a non-empty string or null.
 * @param {unknown} value - candidate.
 * @returns {string|null} the string.
 */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Join two path segments with whichever separator the first one uses.
 *
 * Hand-rolled rather than `node:path.join` because the paths here come back from
 * the `fs` service in the host's own style, and mixing separators produces
 * paths that resolve on one platform and not another.
 * @param {string} base - a directory path.
 * @param {string} name - a child name.
 * @returns {string} the joined path.
 */
export function joinPath(base, name) {
  const trimmed = base.replace(/[\\/]+$/, '')
  const sep = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/'
  return `${trimmed}${sep}${name}`
}

/** The parent directory of a path, in either separator style. */
export function parentPath(path) {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut <= 0 ? trimmed : trimmed.slice(0, cut)
}

/**
 * Read a text file through the `fs` service, or null.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} path - absolute path.
 * @returns {Promise<string|null>} the text, or null when unreadable.
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
 * @returns {Promise<object[]>} directory entries.
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
 * Stat a path through the `fs` service, or undefined.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} path - absolute path.
 * @returns {Promise<object|undefined>} the stat result.
 */
async function statOrUndefined(fs, path) {
  try {
    return await fs.stat(await fs.resolve(path))
  } catch {
    return undefined
  }
}

/**
 * The minimum shape needed from a directory entry, across host field namings.
 *
 * `fs.listDir` returns `FsDirEntry` values whose exact field names are read from
 * source, not from a public API (R7) — so both spellings are accepted rather
 * than trusting one.
 * @param {object} entry - one directory entry.
 * @returns {{ name: string|null, isDir: boolean }} a normalised entry.
 */
function normaliseEntry(entry) {
  const source = entry !== null && typeof entry === 'object' ? entry : {}
  const name = str(source.name) ?? str(source.basename)
  const kind = str(source.kind) ?? str(source.type)
  const isDir = source.isDirectory === true || source.isDir === true || kind === 'dir' || kind === 'directory'
  return { name, isDir }
}

/**
 * Walk a directory tree and fingerprint the `(relative path, size, mtime)` list.
 *
 * Returns `truncated: true` when the walk hit the file cap, so a partial hash is
 * never presented as a complete one — a fingerprint that quietly covers half a
 * tree is worse than no fingerprint.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} root - absolute directory to walk.
 * @param {number} maxFiles - the cap.
 * @returns {Promise<{ hash: string|null, files: number, truncated: boolean, error: string|null }>} the fingerprint.
 */
export async function fingerprintDir(fs, root, maxFiles) {
  const rows = []
  const queue = ['']
  let truncated = false
  let error = null

  while (queue.length > 0) {
    const relativeDir = queue.shift()
    const absolute = relativeDir.length === 0 ? root : joinPath(root, relativeDir)
    const entries = await listDirOrEmpty(fs, absolute)

    if (entries.length === 0 && relativeDir.length === 0) {
      // The root itself did not list: report it rather than hashing nothing.
      const info = await statOrUndefined(fs, root)
      if (info === undefined) return { hash: null, files: 0, truncated: false, error: 'directory is not readable' }
    }

    for (const raw of entries) {
      const entry = normaliseEntry(raw)
      if (entry.name === null) continue
      const nextRelative = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`

      if (entry.isDir) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(nextRelative)
        continue
      }

      if (rows.length >= maxFiles) {
        truncated = true
        break
      }

      const info = await statOrUndefined(fs, joinPath(root, nextRelative))
      const size = info !== undefined && typeof info.size === 'number' ? info.size : -1
      const mtime = info !== undefined && info.mtimeMs !== undefined ? info.mtimeMs : info?.mtime
      rows.push(`${nextRelative}\u0000${size}\u0000${mtime === undefined ? '?' : String(mtime)}`)
    }

    if (truncated) break
  }

  if (rows.length === 0) return { hash: null, files: 0, truncated, error }

  rows.sort()
  // Prefix with the count so a truncated walk cannot collide with a complete one
  // that happens to share the same first N rows.
  const hash = digestText(`${rows.length}\n${rows.join('\n')}`)
  return { hash, files: rows.length, truncated, error }
}

/**
 * Fingerprint one file's identity without reading its bytes.
 *
 * Used for a `file:` tarball, where the archive itself is the source and its
 * name already carries a version. Size plus mtime is enough to notice a swap.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} path - absolute file path.
 * @returns {Promise<{ hash: string|null, size: number|null, mtime: number|string|null }>} the fingerprint.
 */
export async function fingerprintFile(fs, path) {
  const info = await statOrUndefined(fs, path)
  if (info === undefined) return { hash: null, size: null, mtime: null }
  const size = typeof info.size === 'number' ? info.size : null
  const mtime = info.mtimeMs !== undefined ? info.mtimeMs : (info.mtime ?? null)
  return { hash: digestText(`${path}\u0000${size}\u0000${mtime}`), size, mtime: mtime === null ? null : String(mtime) }
}

/**
 * Read the state of a git checkout from its files, without the git binary.
 *
 * Returns `attached: false` for a detached HEAD (where `.git/HEAD` holds a raw
 * commit rather than `ref: …`), which is a real state, not an error.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} dir - the working tree root.
 * @returns {Promise<object>} plain-JSON git state.
 */
export async function readGitState(fs, dir) {
  const gitDir = joinPath(dir, '.git')
  const out = {
    isRepo: false,
    gitDir,
    branch: null,
    attached: false,
    commit: null,
    remote: null,
    trackingRef: null,
    fetchHead: null,
    error: null,
  }

  const head = await readTextOrNull(fs, joinPath(gitDir, 'HEAD'))
  if (head === null) {
    // A worktree or submodule keeps `.git` as a FILE pointing elsewhere.
    const pointer = await readTextOrNull(fs, gitDir)
    out.error = pointer === null ? 'no .git/HEAD' : '.git is a file (worktree or submodule), which is not followed'
    return out
  }

  out.isRepo = true
  const headText = head.trim()

  if (headText.startsWith('ref:')) {
    const ref = headText.slice(4).trim()
    out.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    out.attached = true
    out.commit = str((await readTextOrNull(fs, joinPath(gitDir, ref)))?.trim() ?? null)

    // A packed ref means the loose file is absent; packed-refs is the fallback.
    if (out.commit === null) {
      const packed = await readTextOrNull(fs, joinPath(gitDir, 'packed-refs'))
      if (packed !== null) {
        for (const line of packed.split('\n')) {
          const trimmed = line.trim()
          if (trimmed.length === 0 || trimmed.startsWith('#')) continue
          const [sha, name] = trimmed.split(/\s+/)
          if (name === ref) {
            out.commit = str(sha)
            break
          }
        }
      }
    }
  } else {
    // Detached HEAD: the file holds the commit directly.
    out.commit = str(headText)
  }

  // [remote "origin"] url = … — a two-line scan is enough and cannot mis-parse
  // a comment the way a real config parser could.
  const config = await readTextOrNull(fs, joinPath(gitDir, 'config'))
  if (config !== null) {
    const lines = config.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\[remote "origin"\]/.test(lines[i].trim())) {
        for (let j = i + 1; j < lines.length && !/^\[/.test(lines[j].trim()); j += 1) {
          const match = lines[j].match(/^\s*url\s*=\s*(.+?)\s*$/)
          if (match !== null) {
            out.remote = str(match[1])
            break
          }
        }
        break
      }
    }
  }

  // The upstream tip as of the LAST FETCH. This is the honest baseline for a
  // git comparison; it is deliberately not presented as "the latest upstream".
  const fetchHead = await readTextOrNull(fs, joinPath(gitDir, 'FETCH_HEAD'))
  if (fetchHead !== null && fetchHead.trim().length > 0) {
    const first = fetchHead.trim().split('\n')[0]
    const sha = first.split(/\s+/)[0]
    out.fetchHead = /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null
  }

  if (out.branch !== null) {
    const loose = await readTextOrNull(fs, joinPath(gitDir, `refs/remotes/origin/${out.branch}`))
    if (loose !== null) {
      out.trackingRef = str(loose.trim())
    } else {
      const packed = await readTextOrNull(fs, joinPath(gitDir, 'packed-refs'))
      if (packed !== null) {
        const want = `refs/remotes/origin/${out.branch}`
        for (const line of packed.split('\n')) {
          const trimmed = line.trim()
          if (trimmed.length === 0 || trimmed.startsWith('#')) continue
          const [sha, name] = trimmed.split(/\s+/)
          if (name === want) {
            out.trackingRef = str(sha)
            break
          }
        }
      }
    }
  }

  return out
}

/**
 * Read the `importers.'.'.dependencies` map out of a pnpm lockfile.
 *
 * Deliberately a text scan rather than a YAML parse: the lockfile is large, the
 * shape is stable, and a YAML dependency is not allowed in the host half (R1).
 * The block ends at the next top-level key, so a `packages:` section cannot leak
 * into it.
 * @param {string} text - the lockfile contents.
 * @returns {{ entries: Record<string, {specifier: string|null, version: string|null}>, ok: boolean }} the map.
 */
export function parseLockfileImporters(text) {
  const out = { entries: {}, ok: false }
  if (typeof text !== 'string' || text.length === 0) return out

  const lines = text.split('\n')
  let inImporters = false
  let inRootDeps = false
  let current = null

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (line.trim().length === 0) continue

    // Top level: `importers:` ends at the next column-0 key such as `packages:`.
    if (/^\S/.test(line)) {
      inImporters = /^importers:\s*$/.test(line)
      inRootDeps = false
      current = null
      continue
    }
    if (!inImporters) continue

    // `  .:` — the root importer. Two levels of indentation.
    if (/^ {2}\S/.test(line)) {
      inRootDeps = false
      current = null
      continue
    }

    if (/^ {4}dependencies:\s*$/.test(line)) {
      inRootDeps = true
      continue
    }
    // Any other 4-space section (devDependencies, optionalDependencies) ends the
    // dependency list we want.
    if (/^ {4}\S/.test(line)) {
      inRootDeps = false
      current = null
      continue
    }
    if (!inRootDeps) continue

    // `      name:` then `        specifier: …` / `        version: …`
    const keyMatch = line.match(/^ {6}(\S.*?):\s*$/)
    if (keyMatch !== null) {
      let name = keyMatch[1]
      // A quoted key keeps its quotes in the raw text.
      if ((name.startsWith("'") && name.endsWith("'")) || (name.startsWith('"') && name.endsWith('"'))) {
        name = name.slice(1, -1)
      }
      current = { specifier: null, version: null }
      out.entries[name] = current
      continue
    }

    if (current === null) continue
    const specMatch = line.match(/^ {8}specifier:\s*(.*?)\s*$/)
    if (specMatch !== null) {
      current.specifier = str(specMatch[1])
      continue
    }
    const versionMatch = line.match(/^ {8}version:\s*(.*?)\s*$/)
    if (versionMatch !== null) current.version = str(versionMatch[1])
  }

  out.ok = Object.keys(out.entries).length > 0
  return out
}
