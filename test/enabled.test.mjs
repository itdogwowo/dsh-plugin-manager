/**
 * The patch-layer parser and the enabled resolver.
 *
 * These matter because "installed" and "enabled" are different questions. A row
 * can be disabled inside the bundle that ships it, or computed off by a platform
 * expression — `@deepseek-ai/dsh-base` does exactly that for its bash and pwsh
 * rows. A manager that reports "installed" as "enabled" is wrong in the one case
 * a user actually opens it for.
 *
 * The fixtures below mirror the two real shapes: the block-style bundle patch and
 * the flow-style user patch. Neither contains a real path or account name.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parsePatchEntries } from '../src/host/enabled.js'

/** Block style: the shape a shipped bundle patch uses. */
const BLOCK = `# a header comment that must not become a row
- insert:
    - id: timer
      name: '@scope/timer'

    - id: hmr
      name: '@scope/hmr'
      disabled: true
      config:
        root: ['.']

    - id: shell
      name: '@scope/shell'
      disabled: !!js process.platform === 'win32'

    - id: configurable
      name: '@scope/configurable'
      config:
        disabled: false
`

/** Flow style: the shape the reference user patch uses, wrapped in an array. */
const FLOW = `# Your patch layer for this dsh profile
[ { id: web-ui-skill-explorer, name: "@scope/skill-explorer", disabled: false } ]
`

test('patch: a comment is never parsed as a row', () => {
  // These files carry real documentation in their headers; the bundle patch's own
  // header would otherwise produce a phantom row.
  const rows = parsePatchEntries('# - id: phantom\n')
  assert.deepEqual(rows, [])
})

test('patch: block style yields one row per inserted entry', () => {
  const rows = parsePatchEntries(BLOCK)
  assert.equal(rows.length, 4)
  assert.deepEqual(
    rows.map((row) => row.id),
    ['timer', 'hmr', 'shell', 'configurable'],
  )
  for (const row of rows) assert.equal(row.inserted, true)
})

test('patch: disabled attaches to the ENTRY it belongs to, not to the insert wrapper', () => {
  // The bug this guards: the first parser recorded the wrapper's own `disabled`,
  // which is null for `insert:`, and lost which of ~85 children the flag was on —
  // so `hmr` and `skill-badge` silently read as enabled.
  const rows = parsePatchEntries(BLOCK)
  const byId = new Map(rows.map((row) => [row.id, row]))
  assert.equal(byId.get('hmr').disabled, true)
  assert.equal(byId.get('timer').disabled, null)
})

test('patch: an expression stays an expression, never a boolean', () => {
  // `!!js process.platform === 'win32'` is a fact about the platform, not a
  // user's choice. Coercing it to a boolean would let the panel tell the user
  // they disabled something they never touched.
  const rows = parsePatchEntries(BLOCK)
  const shell = rows.find((row) => row.id === 'shell')
  assert.equal(typeof shell.disabled, 'string')
  assert.match(shell.disabled, /process\.platform/)
})

test('patch: a quoted name keeps its identity', () => {
  const rows = parsePatchEntries(BLOCK)
  assert.equal(rows.find((row) => row.id === 'timer').name, '@scope/timer')
  assert.equal(rows.find((row) => row.id === 'configurable').name, '@scope/configurable')
})

test('patch: a config key named `disabled` is not mistaken for the row flag', () => {
  // `config: { disabled: false }` is nested deeper than the row's own `disabled`.
  // `configurable` has no row-level flag, so its `disabled` must stay null.
  const rows = parsePatchEntries(BLOCK)
  assert.equal(rows.find((row) => row.id === 'configurable').disabled, null)
})

test('patch: flow-array style is parsed', () => {
  // The form the reference user patch uses, and the form the first parser
  // returned NOTHING for — which would have read as "no user layer at all".
  const rows = parsePatchEntries(FLOW)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'web-ui-skill-explorer')
  assert.equal(rows[0].name, '@scope/skill-explorer')
  assert.equal(rows[0].disabled, false)
})

test('patch: an empty document yields no rows and does not throw', () => {
  assert.deepEqual(parsePatchEntries(''), [])
  assert.deepEqual(parsePatchEntries('[]'), [])
  assert.deepEqual(parsePatchEntries(null), [])
})
