/**
 * The patch writer: the only code in this package that writes to the user.
 *
 * Three guarantees are claimed in its header, so all three are tested here:
 *
 *   1. nothing is written until the RESULT parses back to the requested state
 *   2. the previous bytes are restored when the write cannot be verified
 *   3. the write is fenced by the deployment's sandbox policy, not escalated
 *
 * The round-trip in (1) is what caught the real bug in the first version: rows
 * were rendered WITHOUT the leading `- `, so the document looked right and
 * re-parsed as zero rows. A writer whose output its own reader cannot read is
 * the one failure that would break boot rather than break a button.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { join } from 'node:path'

import { buildPatchText, setEnabled } from '../src/host/patch-writer.js'
import { parsePatchEntries } from '../src/host/enabled.js'

/**
 * A stand-in `fs` service that records writes.
 *
 * `initial` is an ARRAY of `[path, content]` pairs. The first version ran it
 * through `Object.entries`, which turned `[[path, content]]` into
 * `{ 0: [path, content] }` — so the seed file was never in the map, `readText`
 * threw ENOENT, the writer treated a real file as absent, and the
 * restore-on-failure path had nothing to restore. Every assertion about the
 * restore then failed for a reason that had nothing to do with the writer.
 *
 * @param {[string, string][]} [initial] - seeded files.
 * @returns {object} the fake service.
 */
function fakeFs(initial) {
  const files = new Map(initial ?? [])
  const calls = { writeText: 0 }
  return {
    calls,
    files,
    // The real service's relativePath is produced in the host process, so this
    // fake echoes what it is given rather than rewriting separators. Normalising
    // here is what made the seed key disagree with the lookup key.
    async resolve(raw) {
      return { displayPath: typeof raw === 'string' ? raw : String(raw) }
    },
    async readText(target) {
      const value = files.get(target.displayPath)
      if (value === undefined) throw new Error(`ENOENT: ${target.displayPath}`)
      return value
    },
    async writeText(target, content) {
      calls.writeText += 1
      files.set(target.displayPath, content)
    },
  }
}

test('writer: a row carries the leading dash that makes it a list item', () => {
  // Without `- ` the document is not a YAML list and reads back as zero rows.
  const { text } = buildPatchText(null, 'tool-x', 'tool-x', false)
  assert.match(text, /^- \{ id: tool-x/m, 'each row must start with a dash')
  assert.equal(parsePatchEntries(text).length, 1)
})

test('writer: creating from nothing produces a parseable one-row document', () => {
  const built = buildPatchText(null, 'tool-x', 'tool-x', false)
  assert.equal(built.action, 'added')
  assert.equal(built.before, null)

  const rows = parsePatchEntries(built.text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'tool-x')
  assert.equal(rows[0].disabled, true)
})

test('writer: a header comment is preserved rather than regenerated', () => {
  const existing = '# my own note about this file\n[\n- { id: a, disabled: true }\n]\n'
  const { text } = buildPatchText(existing, 'tool-x', 'tool-x', true)
  assert.match(text, /# my own note about this file/)
  assert.equal(text.startsWith('# my own note'), true, 'the user note must stay at the top')
})

test('writer: toggling the same row REPLACES it instead of appending a contradiction', () => {
  // Appending would also "work" (last write wins per row) but leaves a file that
  // contradicts itself, and every later reader has to reason about precedence.
  const first = buildPatchText(null, 'tool-x', 'tool-x', false)
  const second = buildPatchText(first.text, 'tool-x', 'tool-x', true)

  assert.equal(second.action, 'updated')
  assert.equal(second.before, 'disabled: true')

  const rows = parsePatchEntries(second.text)
  const matching = rows.filter((row) => row.id === 'tool-x')
  assert.equal(matching.length, 1, 'exactly one row for the id, never two')
  assert.equal(matching[0].disabled, false)
})

test('writer: a row for another id is preserved', () => {
  const first = buildPatchText(null, 'tool-a', 'tool-a', false)
  const second = buildPatchText(first.text, 'tool-b', 'tool-b', true)

  const ids = parsePatchEntries(second.text).map((row) => row.id)
  assert.deepEqual(ids.sort(), ['tool-a', 'tool-b'])
})

test('writer: a hand-written row survives a toggle of a different plugin', () => {
  // This writer must never be the reason someone's own row disappears.
  const hand = '# mine\n[ { id: keep-me, name: "@me/keep", disabled: true } ]\n'
  const { text } = buildPatchText(hand, 'tool-x', 'tool-x', false)

  const ids = parsePatchEntries(text).map((row) => row.id)
  assert.ok(ids.includes('keep-me'), 'the hand-written row must survive')
  assert.ok(ids.includes('tool-x'))
})

test('writer: every produced document parses back to the requested state', () => {
  // The invariant the write path depends on, exercised over a sequence rather
  // than a single case.
  let text = null
  for (const [id, enabled] of [
    ['a', false],
    ['b', true],
    ['a', true],
    ['c', false],
    ['b', false],
  ]) {
    const built = buildPatchText(text, id, id, enabled)
    text = built.text
    const row = parsePatchEntries(text).find((entry) => entry.id === id)
    assert.notEqual(row, undefined, `${id} must be present after being set`)
    assert.equal(row.disabled, enabled === true ? false : true, `${id} must read back as ${enabled}`)
  }
})

// ── the three guarantees, at the service level ──────────────────────────────

test('writer: a successful toggle writes once and reports that a restart is needed', async () => {
  const fs = fakeFs()
  const result = await setEnabled(fs, '/profile', { id: 'tool-x', name: 'tool-x', enabled: false })

  assert.equal(result.ok, true)
  assert.equal(result.action, 'added')
  assert.equal(fs.calls.writeText, 1)
  // The honest part. `disabled` is consumed at compose time, so this can never
  // be a live change, and the result must say so rather than implying success
  // means "in effect".
  assert.equal(result.restartRequired, true)
  assert.match(result.restartNote, /restart/i)
})

test('writer: the file is read back and verified after writing', async () => {
  const fs = fakeFs()
  await setEnabled(fs, '/profile', { id: 'tool-x', name: 'tool-x', enabled: true })

  const written = fs.files.get(join('/profile', 'cordis.patch.yml'))
  assert.notEqual(written, undefined, 'the file must have been written')
  const row = parsePatchEntries(written).find((entry) => entry.id === 'tool-x')
  assert.equal(row.disabled, false)
})

test('writer: a sandbox denial is reported as a refusal, not a crash', async () => {
  const fs = fakeFs()
  fs.writeText = async () => {
    throw new Error('cannot write "/profile/cordis.patch.yml": file access denied under workspace-write mode')
  }

  const result = await setEnabled(fs, '/profile', { id: 'tool-x', name: 'tool-x', enabled: false })

  assert.equal(result.ok, false)
  assert.equal(result.denied, true, 'a denial must be distinguishable from a generic failure')
  assert.match(result.error, /sandbox|denied/i)
  // The whole point of checking `denied` separately: the panel must be able to
  // tell the user "the sandbox refused this", not "something went wrong".
  assert.equal(result.restartRequired, true, 'the restart note stays true even on refusal')
})

test('writer: an fs without writeText refuses before attempting anything', async () => {
  const fs = fakeFs()
  delete fs.writeText
  const result = await setEnabled(fs, '/profile', { id: 'tool-x', name: 'tool-x', enabled: false })

  assert.equal(result.ok, false)
  assert.match(result.error, /cannot write/)
})

test('writer: a missing id is refused', async () => {
  const fs = fakeFs()
  const result = await setEnabled(fs, '/profile', { id: '', name: null, enabled: false })

  assert.equal(result.ok, false)
  assert.equal(fs.calls.writeText, 0, 'nothing may be written without a target id')
})

test('writer: a partial write is restored from the previous bytes', async () => {
  // Simulate a writer that commits a CORRUPT document: the read-back check must
  // notice, and the previous content must come back.
  const path = join('/profile', 'cordis.patch.yml')
  const previous = '# original\n[\n- { id: old, disabled: true }\n]\n'
  const fs = fakeFs([[path, previous]])

  let written = 0
  fs.writeText = async (target, content) => {
    written += 1
    // First write corrupts; the restore write must put the original back.
    fs.files.set(target.displayPath, written === 1 ? 'not: [valid' : content)
  }

  const result = await setEnabled(fs, '/profile', { id: 'tool-x', name: 'tool-x', enabled: false })

  assert.equal(result.ok, false, 'a write that cannot be verified must not report success')
  assert.equal(result.restored, true, 'the previous bytes must be put back')
  assert.equal(fs.files.get(path), previous)
  // Two writes: the corrupt one, then the restore. A single write here would
  // mean the recovery path silently did nothing.
  assert.equal(written, 2, 'the restore must actually write, not just report that it did')
})
