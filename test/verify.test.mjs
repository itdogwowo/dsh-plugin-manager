/**
 * The two verification layers.
 *
 * The property under test is not "does it detect a broken profile" but **"does
 * it refuse to CLAIM a pass it cannot support"**. Every layer here can be
 * skipped — no launcher, no dump, no rows — and a skipped layer must never be
 * reported as a pass, because that is how a pre-check becomes decoration.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { findSignatures, parseDump, profileNameOf, runVerification, verifyBundles, verifyCompose, verifyModules } from '../src/host/verify.js'
import { createRealSubprocess } from './helpers/real-subprocess.mjs'

const subprocess = createRealSubprocess()

/** A dump in the shape the host prints, including an unevaluated `!!js` flag. */
const SAMPLE_DUMP = [
  '# == @deepseek-ai/dsh-base',
  '- id: timer',
  "  name: '@deepseek-ai/cordis-plugin-timer'",
  '- id: better-sidebar',
  '  name: dsh-better-sidebar',
  '  disabled: !!js >-',
  "    [...ctx.loader.entries()].some((e) => e.options.name === 'dsh-better-sidebar')",
  '# == @deepseek-ai/dsh-base, patched by dsh-plugin-manager',
  '- id: plugin-manager',
  '  name: dsh-plugin-manager',
].join('\n')

/** Write one file, creating its directory. */
function put(root, relative, content) {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/**
 * A throwaway directory, removed afterwards.
 * @param {(dir: string) => Promise<void>} run - the assertions.
 * @returns {Promise<void>} resolves once the tree is removed.
 */
async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pm-verify-'))
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('verify: parseDump reads every row, its section, and marks a !!js flag as an expression', () => {
  const parsed = parseDump(SAMPLE_DUMP)

  assert.deepEqual(
    parsed.rows.map((row) => row.name),
    ['@deepseek-ai/cordis-plugin-timer', 'dsh-better-sidebar', 'dsh-plugin-manager'],
  )
  assert.equal(parsed.sections, 2)
  // The section header is how the dump says WHICH bundle contributed a row — the
  // difference between "your overlay broke this" and "a bundle broke this".
  assert.equal(parsed.rows[0].section, '@deepseek-ai/dsh-base')
  assert.equal(parsed.rows[2].section, '@deepseek-ai/dsh-base, patched by dsh-plugin-manager')

  // ⚠️ `disabled:` here is the UNEVALUATED expression, not a boolean (F3). It is
  // reported and flagged; it is never read as "this row is off".
  assert.equal(parsed.rows[1].disabledIsExpression, true)
  assert.match(parsed.rows[1].disabledRaw, /!!js/)
  assert.equal(parsed.rows[0].disabledRaw, null)
})

test('verify: parseDump strips one layer of quotes from a package name', () => {
  const parsed = parseDump(["- id: x", '  name: "quoted-name"'].join('\n'))
  assert.equal(parsed.rows[0].name, 'quoted-name')
})

test('verify: parseDump on an empty or non-text dump claims nothing', () => {
  assert.deepEqual(parseDump('').rows, [])
  assert.deepEqual(parseDump(undefined).rows, [])
  assert.equal(parseDump('').sections, 0)
})

test('verify: signatures match by PREFIX, never by full string (R7)', () => {
  // The host builds these messages from templates, so a full-string comparison
  // would pass today and fail after an upgrade that changed one word.
  const found = findSignatures(
    [
      'some noise',
      'profile bundle "x" declares no dsh.bundle in its package.json',
      'cannot resolve profile bundle "y" from the dsh installation',
      'failed to parse overlay /tmp/ov.yml: YAMLException: bad indentation',
      'patch: name mismatch for dsh-foo (expected a, got b), skipping',
      'duplicate loader entry id: timer',
      'duplicate exact route "/api/x"',
    ].join('\n'),
  )
  assert.equal(found.length, 6)
  assert.deepEqual(
    found.map((entry) => entry.stage),
    ['compose', 'compose', 'compose', 'loader', 'loader', 'runtime'],
  )
  // Each entry carries the host's own line, so the panel can show the evidence
  // rather than this package's paraphrase of it.
  assert.match(found[2].line, /failed to parse overlay/)
})

test('verify: profileNameOf takes the last path segment in either separator style', () => {
  assert.equal(profileNameOf('C:\\Users\\x\\.dsh\\profiles\\web'), 'web')
  assert.equal(profileNameOf('/home/x/.dsh/profiles/web/'), 'web')
  assert.equal(profileNameOf('web'), 'web')
})

test('verify: verifyCompose SKIPS — never passes — when no launcher was found', async () => {
  const result = await verifyCompose(subprocess, { available: false, path: null, error: 'not found' }, '/tmp/x')
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.match(result.error, /launcher is unavailable/)
  // The distinction is the whole point: a skip is a claim that could not be
  // made, and `runVerification` must not fold it into a pass.
  assert.equal(result.exitCode, null)
})

test('verify: verifyCompose parses a real child that prints a dump and exits 0', async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, 'fake-dsh.js')
    put(dir, 'fake-dsh.js', `process.stdout.write(${JSON.stringify(SAMPLE_DUMP)})\n`)

    const result = await verifyCompose(subprocess, { available: true, path: script, error: null }, dir)
    assert.equal(result.ok, true)
    assert.equal(result.exitCode, 0)
    assert.equal(result.rows.length, 3)
    assert.deepEqual(result.argv.slice(0, 2), [process.execPath, script])
    assert.deepEqual(result.argv.slice(2), ['--profile', profileNameOf(dir), '--dump-config'])
  })
})

test('verify: verifyCompose reports a non-zero exit WITH the host signature', async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, 'fake-dsh.js')
    put(
      dir,
      'fake-dsh.js',
      'process.stderr.write(\'profile bundle "broken" declares no dsh.bundle in its package.json\\n\');process.exit(1)\n',
    )

    const result = await verifyCompose(subprocess, { available: true, path: script, error: null }, dir)
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, 1)
    assert.equal(result.signatures.length, 1)
    assert.match(result.error, /declares no dsh\.bundle/)
  })
})

test('verify: verifyCompose passes --patch through, which is what makes R5 possible', async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, 'fake-dsh.js')
    put(dir, 'fake-dsh.js', 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')

    const result = await verifyCompose(subprocess, { available: true, path: script, error: null }, dir, { patch: '/tmp/candidate.yml' })
    assert.equal(result.ok, true)
    // The candidate file is validated BEFORE anything is written to disk, and
    // `--patch` is always applied LAST (docs/plan.md §5.1).
    const passed = JSON.parse(result.dump)
    assert.deepEqual(passed, ['--profile', profileNameOf(dir), '--dump-config', '--patch', '/tmp/candidate.yml'])
  })
})

test('verify: verifyModules resolves against the profile tree, and names what it cannot', async () => {
  await withTempDir(async (dir) => {
    put(dir, 'package.json', JSON.stringify({ name: 'web', dsh: {} }))
    put(dir, 'node_modules/present/package.json', JSON.stringify({ name: 'present', main: 'index.js' }))
    put(dir, 'node_modules/present/index.js', 'export default 1\n')

    const result = await verifyModules(subprocess, dir, ['present', 'dsh-probe-does-not-exist-xyz', 'present'])
    assert.equal(result.layer, 'V2')
    assert.equal(result.skipped, false)
    assert.equal(result.ok, false, 'one unresolvable row means the layer did not pass')
    assert.equal(result.resolved, 1)
    assert.deepEqual(result.unresolved, ['dsh-probe-does-not-exist-xyz'], 'duplicates are collapsed and the miss is named')
  })
})

test('verify: verifyModules with no rows SKIPS rather than claiming everything resolved', async () => {
  const result = await verifyModules(subprocess, '.', [])
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.match(result.error, /no row to resolve/)
})

test('verify: verifyBundles reports a declared bundle with no fs, never a pass', async () => {
  const result = await verifyBundles(undefined, 'dsh-plugin-manager')
  assert.equal(result.ok, false)
  assert.equal(typeof result.error, 'string')
})

test('verify: runVerification folds skips into a NON-pass', async () => {
  await withTempDir(async (dir) => {
    const report = await runVerification({
      fs: undefined,
      subprocess,
      launcher: { available: false, path: null, tried: [], error: 'no launcher' },
      profileDir: dir,
      selfName: 'dsh-plugin-manager',
    })

    assert.equal(report.ok, false)
    assert.ok(report.skipped.length >= 2, 'both V1b and V1 report themselves as skipped')
    // The report states its own ceiling, so a reader of the panel cannot mistake
    // "composed cleanly" for "will boot".
    assert.match(report.note, /apply\(\)-time failure is still only visible/)
  })
})

test('verify: runVerification on a missing profile directory claims nothing at all', async () => {
  const report = await runVerification({ profileDir: null })
  assert.equal(report.ok, false)
  assert.equal(report.layers.length, 0)
  assert.match(report.note, /no profile directory/)
})
