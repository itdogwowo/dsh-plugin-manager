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

import { isSandboxDenial, joinPath, parentPath, removeFile } from './host.js'

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
 * The name of the probe file the preflight check leaves in the snapshot store.
 *
 * ⚠️ It is written and LEFT there, and that is not laziness: the host's `fs`
 * service has no delete (`dsh-fs` exposes resolve/readText/writeText/listDir/
 * stat), so a probe that cleaned up after itself would need a capability this
 * plugin does not have. The file is zero bytes, it lives beside the snapshots it
 * belongs to, and a future snapshot directory of the same name is the only thing
 * that could ever collide with it.
 *
 * It is also not what the app needs, which is why it exists: the panel asks
 * BEFORE the user presses a button, so the answer costs one small write instead
 * of one wasted click.
 */
export const WRITE_PROBE_FILENAME = '.dsh-pm-write-probe'

/**
 * Does `child` sit under `root`, on either platform?
 *
 * The separator is required after the prefix on purpose: a bare `startsWith`
 * would call `C:\Users\<account>-other` a child of `C:\Users\<account>`, and
 * the panel would then print a `cd` that does not make the snapshot writable.
 * @param {string} child - the path to test.
 * @param {string} root - the candidate ancestor.
 * @returns {boolean} true when the child is at or below the root.
 */
export function pathUnder(child, root) {
  const inner = String(child).replace(/[\\/]+$/, '')
  const outer = String(root).replace(/[\\/]+$/, '')
  if (inner.length === 0 || outer.length === 0) return false
  if (inner === outer) return true
  const lowered = (value) => (/^[A-Za-z]:/.test(value) ? value.toLowerCase() : value)
  return lowered(inner).startsWith(`${lowered(outer)}/`) || lowered(inner).startsWith(`${lowered(outer)}\\`)
}

/**
 * The work the user has to do for this plugin's writes to be allowed — or null.
 *
 * ## What this is for
 *
 * The deployment's file sandbox decides one thing this package cannot: whether a
 * snapshot may be written under `$DSH_HOME`, which is almost always OUTSIDE the
 * session workspace. Under the shipped default (`workspace-write`) that write is
 * refused, so every install/update/remove stops at step one — correctly, because
 * a change that cannot be rolled back must not start. The refusal is right; the
 * problem is that the user only ever met it AFTER pressing a button.
 *
 * So the panel asks first, and the answer is a COMMAND rather than a paragraph:
 * the writable root is the host's start directory, so starting `dsh web` from an
 * ancestor of the snapshot store is the whole fix — and the ancestor is computed
 * here rather than guessed, because the store's depth depends on where the
 * profiles live.
 *
 * @param {string} snapshotDir - the profile's snapshot root.
 * @param {string} workspaceRoot - the deployment's writable root.
 * @param {string} [platform] - `process.platform`, injectable for tests.
 * @returns {{ command: string, ancestor: string, note: string }|null} the fix, or null when one is not needed.
 */
export function sandboxRemedy(snapshotDir, workspaceRoot, platform = typeof process !== 'undefined' ? process.platform : 'linux') {
  const store = str(snapshotDir)
  const root = str(workspaceRoot)
  if (store === null || root === null) return null
  if (pathUnder(store, root)) return null

  const dir = root.replace(/[\\/]+$/, '')
  if (platform === 'win32') {
    return {
      command: `cd ${dir}
$env:DSH_PERMISSION_MODE = "danger-full-access"
dsh web`,
      ancestor: dir,
      note: 'the writable root is the directory dsh web was started from, so starting it from the folder that contains the profiles is the whole fix; DSH_PERMISSION_MODE is the same escape hatch the host documents',
    }
  }
  return {
    command: `cd ${dir} && DSH_PERMISSION_MODE=danger-full-access dsh web`,
    ancestor: dir,
    note: 'the writable root is the directory dsh web was started from, so starting it from the directory that contains the profiles is the whole fix; DSH_PERMISSION_MODE is the same escape hatch the host documents',
  }
}

/**
 * Can this deployment store a snapshot right now?
 *
 * One small write, and the ANSWER is the outcome — nothing is inferred from
 * permissions, ownership or a mode bit, because the thing being tested is a
 * policy inside another process. A refusal is reported with the sandbox's own
 * words plus the command that ends it (`sandboxRemedy`).
 *
 * Never throws, never writes outside the snapshot root, and writes nothing at all
 * when it can already tell that the store is readable.
 *
 * @param {object} fs - the resolved `fs` service.
 * @param {object} input - `{ profileDir, profileName, workspaceRoot }`.
 * @returns {Promise<object>} plain-JSON status.
 */
export async function checkSnapshotWrite(fs, input) {
  const profileDir = str(input?.profileDir)
  const profileName = str(input?.profileName) ?? 'default'
  const workspaceRoot = str(input?.workspaceRoot)
  const out = { ok: false, state: 'unknown', dir: null, writableRoot: workspaceRoot, probePath: null, observed: null, error: null, remedy: null }

  if (profileDir === null) {
    out.error = 'no profile directory was resolved, so the snapshot store cannot be located'
    return out
  }
  if (fs === undefined || fs === null || typeof fs.writeText !== 'function') {
    out.error = 'the fs service cannot write, so no snapshot could be stored'
    return out
  }

  out.dir = snapshotRoot(profileDir, profileName)
  out.remedy = sandboxRemedy(out.dir, workspaceRoot)
  out.probePath = joinPath(out.dir, WRITE_PROBE_FILENAME)

  // A store that can be LISTED is readable, and readable is not the question —
  // so nothing is concluded here. It only saves the probe when the directory is
  // missing entirely, where the failure would be ENOENT rather than a policy.
  try {
    await fs.listDir(await fs.resolve(out.dir))
    out.observed = 'the snapshot store already exists'
  } catch {
    out.observed = 'the snapshot store does not exist yet; the first write creates it'
  }

  try {
    await fs.writeText(await fs.resolve(out.probePath), '')
    out.ok = true
    out.state = 'ready'
    return out
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    out.state = /denied|sandbox|EPERM|EACCES/i.test(message) ? 'blocked' : 'error'
    out.error = message
    return out
  }
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
    // A refusal is its own outcome, not a flavour of failure: it is the one
    // storage answer that names something the user can change (see below).
    denied: false,
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
    const message = error instanceof Error ? error.message : String(error)
    // A refusal from the deployment's file sandbox is reported AS a refusal, in
    // its own words and under its own flag, because it is the only storage
    // failure whose cause is a decision the reader can revisit. Dressing it up
    // as "could not be stored" sends the reader looking at their disk.
    //
    // Three facts the sentence has to get right, because all three are
    // counter-intuitive:
    //   - the fenced step is the snapshot, but the ROLLBACK writes the same
    //     profile files back, so there is no version of this pipeline that works
    //     without write access to that path — hence "nothing was changed"
    //     rather than a suggestion to retry;
    //   - the check is per CALL, and these writes carry no session, so they
    //     answer to the DEPLOYMENT default with the host's own start directory
    //     as the writable root — a conversation's access preset does not reach
    //     here, and saying otherwise would send the reader to a knob that does
    //     nothing;
    //   - widening it is a deployment decision (it applies to every session-less
    //     call of that host), NOT something this package does for itself.
    out.denied = isSandboxDenial(error)
    out.error = out.denied
      ? `the snapshot could not be stored at ${out.dir}: ${message}. The DSH file sandbox refused this write, and the snapshot is the step that may not be skipped — a rollback writes the same profile files back — so nothing was changed and there is nothing to undo. This panel's writes carry no session, so they answer to the deployment default (DSH_PERMISSION_MODE, else workspace-write) with the host's start directory as the writable root; a conversation's access preset does not change it. Widening that default is a deployment decision, and this package never asks for a wider mode of its own.`
      : `the snapshot could not be stored at ${out.dir}: ${message}`
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
    // Set when the sandbox refused a restore: the loud version of a partial
    // rollback, which is the only acceptable version of one.
    denied: false,
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
      const message = error instanceof Error ? error.message : String(error)
      // A refused restore leaves the profile in the state the failed change left
      // it, and the remaining files are NOT restored — this returns immediately.
      // Saying so is the whole point: a partial rollback that reports success is
      // worse than one that reports itself.
      out.denied = isSandboxDenial(error)
      out.error = out.denied
        ? `${record.path} could not be restored: ${message}. The DSH file sandbox refused the restore, so the profile is left in the state the failed change left it: the files after this one were not restored either, and \`residue\` lists what to look at by hand.`
        : `${record.path} could not be restored: ${message}`
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
    // Carried into the run record so the panel can title the outcome "write
    // refused" instead of "install failed" — a refusal is not a failed change.
    denied: snapshot?.denied === true,
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
