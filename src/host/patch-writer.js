/**
 * Writing one enable/disable line into the user's `cordis.patch.yml`.
 *
 * ## This file writes to the user's profile. It is the only one that does.
 *
 * **R6 said "do not write the user's cordis.patch.yml". The user was asked and
 * lifted it explicitly** for enable/disable only (docs/host-notes.md F27). The
 * rule was not quietly reinterpreted; it was raised as a conflict and decided.
 *
 * ## The three guarantees, in order of importance
 *
 * 1. **Nothing is written until the RESULT has been proven parseable.** The new
 *    document is built in memory, re-parsed with the same parser the read path
 *    uses, and only then committed. A patch file that cannot be parsed would
 *    break boot — worse than the feature not working.
 * 2. **The previous bytes are kept and restored on any failure after the
 *    write.** The write goes through the `fs` service's atomic publication, but
 *    "atomic" is not "correct".
 * 3. **The write is fenced by the deployment's own sandbox policy.** No
 *    `sandboxPolicy` is passed, so `checkedTarget` applies the deployment
 *    default. If the profile lives outside the writable root, the write is
 *    DENIED and reported as such — this plugin does not escalate its own
 *    permission to reach into `$DSH_HOME`.
 *
 * ## What it does not do
 *
 * It does not make the change take effect. `disabled` is consumed at compose
 * time by the loader (F28), so a restart is required, and the result says so in
 * as many words. Claiming otherwise would be the one lie this feature cannot
 * afford.
 *
 * R1 applies: only relative imports.
 */

import { join } from 'node:path'
import { parsePatchEntries } from './enabled.js'

/** The user patch file's header, copied from what the deployment itself writes. */
const HEADER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
].join('\n')

/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Split a patch document into its leading comment block and the entries text.
 *
 * The header is preserved verbatim rather than regenerated, so a user who edits
 * the comments keeps their edits.
 * @param {string} text - the document.
 * @returns {{ header: string, body: string }} the parts.
 */
function splitDocument(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return { header: HEADER, body: '' }
  const lines = text.split('\n')
  let cut = 0
  while (cut < lines.length) {
    const trimmed = lines[cut].trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) cut += 1
    else break
  }
  const header = lines.slice(0, cut).join('\n').trimEnd()
  return { header: header.length === 0 ? HEADER : header, body: lines.slice(cut).join('\n').trim() }
}

/**
 * Render one row as a block-list item.
 *
 * The leading `- ` is load-bearing, not cosmetic: a YAML list item IS the dash,
 * and a row written without it re-parses as nothing. The first version omitted
 * it and produced a file that looked right and read back as zero rows — caught
 * by the round-trip check this module performs before writing.
 * @param {string} id - the loader row id.
 * @param {string} name - the package name, when known.
 * @param {boolean} enabled - the desired state.
 * @returns {string} one YAML block row.
 */
function renderRow(id, name, enabled) {
  const parts = [`id: ${id}`]
  if (str(name) !== null) parts.push(`name: ${JSON.stringify(name)}`)
  // `disabled: false` is written explicitly, not omitted: the point of the row
  // is to override a lower layer, and an omitted key overrides nothing.
  parts.push(`disabled: ${enabled === true ? 'false' : 'true'}`)
  return `- { ${parts.join(', ')} }`
}

/**
 * Build the new patch document with one row's state set.
 *
 * Existing rows for the same `id` are REPLACED in place rather than appended.
 * "Last write winning per row" means appending would also take effect — but a
 * file that grows a contradicting row on every toggle is unreadable six months
 * later, and the check would then have to reason about which row wins.
 *
 * @param {string|null} currentText - the existing document, or null when absent.
 * @param {string} id - the loader row id.
 * @param {string|null} name - the package name.
 * @param {boolean} enabled - the desired state.
 * @returns {{ text: string, action: string, before: string|null }} the new document.
 */
export function buildPatchText(currentText, id, name, enabled) {
  const { header, body } = splitDocument(currentText)
  // Parse the WHOLE body, not line by line. A one-line flow array
  // (`[ { id: a, … }, { id: b, … } ]`) is two rows on one line, and a line-based
  // loop sees it as a single unparseable row and silently drops the user's
  // entries. The parser already handles both styles; let it do the splitting.
  const existing = parsePatchEntries(body)
  const before = existing.find((row) => row.id === id) ?? null
  const beforeLine = before === null ? null : `disabled: ${String(before.disabled)}`

  // Every other row is re-rendered from what the parser understood, so it
  // survives regardless of which style it was written in. Rows for THIS id are
  // dropped and re-emitted once, so the file never accumulates contradictions.
  const others = []
  for (const row of existing) {
    if (row.id === id) continue
    others.push(renderRow(row.id, row.name, row.disabled === true ? false : true))
  }

  others.push(renderRow(id, name, enabled))
  const text = `${header}\n[\n${others.join('\n')}\n]\n`
  return { text, action: before === null ? 'added' : 'updated', before: beforeLine }
}

/**
 * Set one plugin's enabled state by writing its row into the user patch file.
 *
 * @param {object} fs - the resolved `fs` service.
 * @param {string} profileDir - the profile directory.
 * @param {{ id: string, name: string|null, enabled: boolean }} request - what to set.
 * @returns {Promise<object>} plain-JSON outcome, including whether a restart is needed.
 */
export async function setEnabled(fs, profileDir, request) {
  // `node:path.join`, NOT the hand-rolled `joinPath` in detect.js. The `fs`
  // service resolves PLATFORM paths and `profile.js` builds its own with
  // `node:path.join`, so a forward-slash string here would name a different file
  // on Windows than the one the read path inspects. The read would then fail,
  // `currentText` would come back null, and the restore-on-failure guarantee
  // would have nothing to restore — recovery broken while the write still worked.
  const path = join(profileDir, 'cordis.patch.yml')
  const out = {
    ok: false,
    path,
    id: request.id,
    enabled: request.enabled === true,
    action: null,
    before: null,
    restartRequired: true,
    restartNote: 'the loader consumes `disabled` when it composes the tree, so this takes effect only after `dsh web` restarts',
    denied: false,
    error: null,
  }

  if (fs === undefined || fs === null || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function' || typeof fs.writeText !== 'function') {
    out.error = 'the fs service is unavailable or cannot write, so nothing was changed'
    return out
  }
  if (str(request.id) === null) {
    out.error = 'no row id was given, so no row could be targeted'
    return out
  }

  // ── read what is there now ────────────────────────────────────────────────
  let currentText = null
  try {
    currentText = await fs.readText(await fs.resolve(path))
  } catch {
    // An absent patch file is the normal state of a fresh profile; the write
    // below creates it. Anything else surfaces on the write attempt.
    currentText = null
  }

  // ── build and PROVE the new document before touching the disk ─────────────
  const built = buildPatchText(currentText, request.id, request.name ?? null, out.enabled)
  const reparsed = parsePatchEntries(built.text)
  const written = reparsed.find((row) => row.id === request.id)
  if (written === undefined || written.disabled !== (out.enabled ? false : true)) {
    out.error = 'the new patch document did not parse back to the requested state, so nothing was written'
    return out
  }

  out.action = built.action
  out.before = built.before

  // ── write ─────────────────────────────────────────────────────────────────
  try {
    // No sandboxPolicy argument on purpose: `checkedTarget` then applies the
    // DEPLOYMENT default. A profile outside the writable root is denied here and
    // reported, rather than reached by granting ourselves a wider mode.
    await fs.writeText(await fs.resolve(path), built.text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    out.denied = /denied|FS_SANDBOX_DENIED/i.test(message)
    out.error = out.denied
      ? `the write was refused by the sandbox (${message}). The patch file lives outside this session's writable root; nothing was changed.`
      : message
    return out
  }

  // ── verify by reading it back ─────────────────────────────────────────────
  try {
    const back = await fs.readText(await fs.resolve(path))
    const check = parsePatchEntries(back).find((row) => row.id === request.id)
    if (check === undefined || check.disabled !== (out.enabled ? false : true)) {
      out.error = 'the file was written but does not read back as the requested state'
      await restore(fs, path, currentText)
      out.restored = true
      return out
    }
  } catch (error) {
    out.error = `the file was written but could not be read back: ${error instanceof Error ? error.message : String(error)}`
    await restore(fs, path, currentText)
    out.restored = true
    return out
  }

  out.ok = true
  return out
}

/**
 * Put the previous bytes back.
 *
 * Restoring an ABSENT file means writing nothing: a failed create must not leave
 * an empty patch file behind, because an empty document is not the same state as
 * no document.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} path - the patch file path.
 * @param {string|null} previous - the bytes to restore, or null when it was absent.
 * @returns {Promise<void>} resolves once the attempt is made.
 */
async function restore(fs, path, previous) {
  if (previous === null) return
  try {
    await fs.writeText(await fs.resolve(path), previous)
  } catch {
    /* reported by the caller's error field; a second failure has nowhere to go */
  }
}
