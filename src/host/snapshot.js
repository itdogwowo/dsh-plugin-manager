/**
 * Snapshots and rollback: the only reason this package can promise anything.
 *
 * ## What a snapshot is, and what a rollback actually restores
 *
 * A snapshot is a directory of the profile's OWN STATE FILES — the manifest, the
 * lockfile, the workspace file and the user's patch layer — captured byte for
 * byte before a change runs. A rollback writes those bytes back and reports
 * which files it had to put back.
 *
 * ## The honest boundary, stated here rather than discovered later
 *
 * `node_modules` is **not** copied. Two reasons, and neither is laziness:
 *
 * 1. It is thousands of files and would take real time on every press.
 * 2. It is **fully determined by the lockfile**. Restoring `pnpm-lock.yaml` and
 *    `package.json` restores the declared state exactly; the installed tree is
 *    then reconciled from it by the official CLI, not by this package.
 *
 * So "byte-identical" in this package means: **every recorded state file is
 * byte-identical after a rollback, and every file the change created is gone or
 * named in `residue`.** What is left in `node_modules` is reported, never
 * assumed away — a silent partial rollback is worse than a loud one, because the
 * user would stop looking.
 *
 * ## Where snapshots live
 *
 * `$DSH_HOME/.dsh-pm/profiles/<profile>/<id>/` — deliberately NOT inside the
 * profile directory. A directory in there looks like a plugin to the loader, and
 * the loader is exactly the thing this package exists to protect.
 *
 * R1 applies: `node:` and relative imports only.
 */

import { joinPath, parentPath, removeFile } from './host.js'

/** State files a snapshot records, in the order they are restored. */
export const SNAPSHOT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']

/** Version of the manifest format, so a future reader can tell them apart. */
export const SNAPSHOT_FORMAT = 'dsh-pm/snapshot@1'

/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The file name part of a path.
 * @param {string} path - the path.
 * @returns {string} its last segment.
 */
function fileNameOf(path) {
  const trimmed = String(path).replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * Fold one string into an FNV-1a-32 digest as 8 hex digits.
 *
 * The same digest as `detect.js`, for the same reasons: no `node:crypto` import,
 * no dependency, deterministic, and its job is to notice a CHANGE — it is not a
 * security boundary and is never presented as one.
 * @param {string} text - the input.
 * @returns {string} the digest.
 */
export function digestText(text) {
  let hash = 0x811c9dc5
  const value = String(text)
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * The `$DSH_HOME` that contains a profile directory.
 *
 * Derived from the path (`…/.dsh/profiles/<name>`) rather than from an
 * environment variable, because the host may not expose one (F17/F18) and the
 * path is the one fact the `fs` service has already confirmed.
 *
 * ⚠️ The name says `dshHome`, not `home`. The first version was called
 * `homeOfProfile` and returned the same directory, but on a path like
 * `C:\Users\<account>\.dsh\profiles\web` the phrase "home of the profile" reads
 * as `C:\Users\<account>` — and a reader who acts on that reading puts snapshots
 * in the wrong tree. `$DSH_HOME` is the documented term (`docs/plan.md` §6.3)
 * and the function now uses it.
 *
 * @param {string} profileDir - the absolute profile directory.
 * @returns {string} `$DSH_HOME`, which is the profile directory's grandparent
 *   when the parent is literally `profiles`, and the parent otherwise.
 */
export function dshHomeOf(profileDir) {
  const parent = parentPath(String(profileDir).replace(/[\\/]+$/, ''))
  const trimmedParent = parent.replace(/[\\/]+$/, '')
  const leaf = trimmedParent.slice(Math.max(0, trimmedParent.length - 'profiles'.length))
  return leaf === 'profiles' ? parentPath(parent) : parent
}

/**
 * The snapshot root for one profile.
 * @param {string} profileDir - the profile directory.
 * @param {string} profileName - the profile name.
 * @returns {string} the directory.
 */
export function snapshotRoot(profileDir, profileName) {
  return joinPath(dshHomeOf(profileDir), '.dsh-pm', 'profiles', str(profileName) ?? 'default', 'snapshots')
}

/**
 * A filesystem-safe, sortable snapshot id.
 * @param {string} label - what the change was.
 * @param {number} [at] - epoch milliseconds.
 * @returns {string} the id.
 */
export function snapshotId(label, at) {
  const stamp = new Date(typeof at === 'number' ? at : Date.now()).toISOString().replace(/[:.]/g, '-')
  const safe = String(label).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `${stamp}-${safe.length === 0 ? 'change' : safe}`
}

/**
 * Read one file for the snapshot record.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} path - the absolute path.
 * @returns {Promise<{ path: string, present: boolean, content: string|null, digest: string|null, bytes: number, error: string|null }>} the record.
 */
async function readStateFile(fs, path) {
  const out = { path, present: false, content: null, digest: null, bytes: 0, error: null }
  try {
    const text = await fs.readText(await fs.resolve(path))
    out.present = true
    out.content = text
    out.digest = digestText(text)
    out.bytes = text.length
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Absence is the normal state of several of these files (`cordis.patch.yml`
    // does not exist in a fresh profile). Only an error that is NOT "missing"
    // is worth recording.
    const missing = /not found|ENOENT|FS_NOT_FOUND|no such file/i.test(message)
    if (!missing) out.error = message
  }
  return out
}

/**
 * Take a snapshot of one profile's state files.
 *
 * Fails LOUD: if the snapshot root cannot be written, the result says so and the
 * caller must refuse to run the change. A change that runs without a snapshot is
 * a change that cannot be undone, and quietly skipping the snapshot is how a
 * "reversible" feature stops being one.
 *
 * @param {object} fs - the resolved `fs` service.
 * @param {object} input - `{ profileDir, profileName, label, action?, detail? }`.
 * @returns {Promise<object>} plain-JSON snapshot descriptor.
 */
export async function takeSnapshot(fs, input) {
  const profileDir = str(input?.profileDir)
  const profileName = str(input?.profileName) ?? 'default'
  const label = str(input?.label) ?? 'change'
  const out = {
    ok: false,
    id: null,
    dir: null,
    label,
    action: str(input?.action) ?? label,
    detail: input?.detail ?? null,
    at: Date.now(),
    format: SNAPSHOT_FORMAT,
    profileDir,
    profileName,
    files: [],
    digests: {},
    error: null,
  }

  if (profileDir === null) {
    out.error = 'no profile directory was resolved, so there is nothing to snapshot'
    return out
  }
  if (fs === undefined || fs === null || typeof fs.writeText !== 'function') {
    out.error = 'the fs service cannot write, so a snapshot cannot be stored'
    return out
  }

  out.id = snapshotId(label, out.at)
  out.dir = joinPath(snapshotRoot(profileDir, profileName), out.id)

  for (const name of SNAPSHOT_FILES) {
    const record = await readStateFile(fs, joinPath(profileDir, name))
    out.files.push(record)
    if (record.error !== null) {
      out.error = `${name} could not be read for the snapshot: ${record.error}`
      return out
    }
    if (record.present) out.digests[name] = record.digest
  }

  // The manifest is written FIRST and is what makes a snapshot usable: a
  // directory without one is not a snapshot, it is a pile of files.
  const manifest = {
    format: out.format,
    id: out.id,
    at: out.at,
    label: out.label,
    action: out.action,
    detail: out.detail,
    profileName: out.profileName,
    digests: out.digests,
    files: out.files.map((record) => ({ path: record.path, present: record.present, digest: record.digest, bytes: record.bytes })),
  }

  try {
    await fs.writeText(await fs.resolve(joinPath(out.dir, 'manifest.json')), `${JSON.stringify(manifest, null, 2)}\n`)
    for (const record of out.files) {
      if (!record.present) continue
      await fs.writeText(await fs.resolve(joinPath(out.dir, 'files', fileNameOf(record.path))), record.content)
    }
  } catch (error) {
    out.error = `the snapshot could not be stored at ${out.dir}: ${error instanceof Error ? error.message : String(error)}`
    return out
  }

  out.ok = true
  return out
}

/**
 * Restore one snapshot, then CHECK that the restore happened.
 *
 * The check is the point. "I wrote the bytes" and "the bytes are there now" are
 * different claims, and only the second one is worth telling the user. Every
 * file is read back and digested; a mismatch is a failed rollback, reported as
 * such.
 *
 * Files the change created are removed through {@link removeFile}, because the
 * `fs` service has no delete. A removal that fails is reported in `residue`
 * rather than retried into the ground or hidden.
 *
 * @param {object} input - `{ fs, subprocess, snapshot }`.
 * @returns {Promise<object>} plain-JSON result.
 */
export async function restoreSnapshot(input) {
  const fs = input?.fs
  const snapshot = input?.snapshot
  const out = {
    ok: false,
    id: snapshot?.id ?? null,
    restored: [],
    removed: [],
    residue: [],
    verified: [],
    mismatched: [],
    error: null,
  }

  if (snapshot === null || snapshot === undefined || snapshot.ok !== true || !Array.isArray(snapshot.files)) {
    out.error = 'there is no usable snapshot to restore'
    return out
  }
  if (fs === undefined || fs === null || typeof fs.writeText !== 'function') {
    out.error = 'the fs service cannot write, so nothing could be restored'
    return out
  }

  // ── 1. remove what the change ADDED ───────────────────────────────────────
  // Removing first, then restoring, means a file that was absent before and is
  // written by the restore step cannot be resurrected by ordering.
  for (const record of snapshot.files) {
    if (record.present === true) continue
    const removal = await removeFile(input?.subprocess, fs, record.path)
    if (removal.removed) out.removed.push(record.path)
    else out.residue.push({ path: record.path, reason: removal.error ?? 'could not be removed' })
  }

  // ── 2. write the recorded bytes back ──────────────────────────────────────
  for (const record of snapshot.files) {
    if (record.present !== true) continue
    try {
      await fs.writeText(await fs.resolve(record.path), record.content)
      out.restored.push(record.path)
    } catch (error) {
      out.error = `${record.path} could not be restored: ${error instanceof Error ? error.message : String(error)}`
      return out
    }
  }

  // ── 3. prove it ───────────────────────────────────────────────────────────
  for (const record of snapshot.files) {
    const now = await readStateFile(fs, record.path)
    if (record.present !== true) {
      if (now.present) out.mismatched.push({ path: record.path, expected: 'absent', actual: now.digest })
      else out.verified.push(record.path)
      continue
    }
    if (now.digest === record.digest) out.verified.push(record.path)
    else out.mismatched.push({ path: record.path, expected: record.digest, actual: now.digest })
  }

  if (out.mismatched.length > 0) {
    out.error = `${out.mismatched.length} file(s) did not read back as they were before the change`
    return out
  }

  out.ok = true
  return out
}

/**
 * Describe a snapshot for the panel, without the file contents.
 * @param {object} snapshot - a snapshot descriptor.
 * @returns {object} a small plain-JSON row.
 */
export function describeSnapshot(snapshot) {
  return {
    id: snapshot?.id ?? null,
    at: snapshot?.at ?? null,
    label: snapshot?.label ?? null,
    action: snapshot?.action ?? null,
    detail: snapshot?.detail ?? null,
    dir: snapshot?.dir ?? null,
    files: Array.isArray(snapshot?.files)
      ? snapshot.files.map((record) => ({ path: record.path, present: record.present === true, digest: record.digest, bytes: record.bytes }))
      : [],
  }
}

/**
 * Re-read a snapshot from its manifest, so a rollback can happen in a LATER
 * process than the change that made it.
 *
 * Without this, "roll back the last change" would only work in the same panel
 * session — and the case that matters most is the one where the host was
 * restarted in between.
 *
 * @param {object} fs - the resolved `fs` service.
 * @param {string} dir - the snapshot directory.
 * @returns {Promise<object|null>} a snapshot descriptor, or null.
 */
export async function loadSnapshot(fs, dir) {
  const base = str(dir)
  if (base === null || fs === undefined || fs === null || typeof fs.readText !== 'function') return null

  let manifest = null
  try {
    manifest = JSON.parse(await fs.readText(await fs.resolve(joinPath(base, 'manifest.json'))))
  } catch {
    return null
  }
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.files)) return null

  const files = []
  for (const row of manifest.files) {
    const path = str(row?.path)
    if (path === null) continue
    if (row.present !== true) {
      files.push({ path, present: false, content: null, digest: null, bytes: 0, error: null })
      continue
    }
    let content = null
    try {
      content = await fs.readText(await fs.resolve(joinPath(base, 'files', fileNameOf(path))))
    } catch {
      content = null
    }
    if (content === null) return null
    files.push({ path, present: true, content, digest: digestText(content), bytes: content.length, error: null })
  }

  return {
    ok: true,
    id: manifest.id ?? null,
    at: manifest.at ?? null,
    label: manifest.label ?? null,
    action: manifest.action ?? null,
    detail: manifest.detail ?? null,
    dir: base,
    profileName: manifest.profileName ?? null,
    files,
    digests: manifest.digests ?? {},
    error: null,
  }
}

/**
 * List the snapshots stored for one profile, newest first.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} profileDir - the profile directory.
 * @param {string} profileName - the profile name.
 * @returns {Promise<object[]>} snapshot ids, newest first.
 */
export async function listSnapshots(fs, profileDir, profileName) {
  const root = snapshotRoot(profileDir, profileName)
  try {
    const entries = await fs.listDir(await fs.resolve(root))
    const names = []
    for (const entry of Array.isArray(entries) ? entries : []) {
      const name = str(entry?.name) ?? str(entry?.basename)
      if (name === null) continue
      if (entry?.isDirectory === false || entry?.isDir === false) continue
      names.push(name)
    }
    names.sort()
    names.reverse()
    return names
  } catch {
    return []
  }
}
