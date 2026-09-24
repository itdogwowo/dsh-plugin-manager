/**
 * Copy is a two-dictionary contract and an easy place to rot.
 *
 * A key the panel uses but a dictionary lacks renders as the raw key in the UI,
 * and a key only one dictionary has silently falls back to Chinese. Both are
 * invisible in a screenshot review and obvious to a test.
 *
 * ⚠️ Every component that calls `t('…')` must be listed here. This scan read
 * only `panel.js` while `update.js` was added beside it, and the result was a
 * test that failed for the wrong reason — it reported the NEW keys as dead copy
 * rather than reporting that it had not looked at them. A scan list is a
 * contract: adding a component means adding it here.
 */

import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { NS, zh, en } from '../src/client/copy.js'

/** The components that render copy, and therefore have to be scanned. */
const COMPONENTS = ['panel.js', 'update.js']

const SOURCES = COMPONENTS.map((name) => ({
  name,
  source: readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8'),
}))

/** Every literal key one source passes to `t('…')`. */
function usedKeys(source) {
  const keys = new Set()
  for (const match of source.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) keys.add(match[1])
  // Keys reached through a lookup table rather than a literal call. The second
  // group is the `verdictKeys` / `stateKeys` tables, whose values are all UI
  // copy — a ternary, or a bare `return 'stateX'`, hides the keys from this
  // scan. That is how `verdictCurrent` and then `stateRunning` were each
  // reported dead while they were plainly on screen.
  for (const match of source.matchAll(/:\s*'(source[A-Z]\w+|changeIntegrity|changeResolvedDir|verdict[A-Z]\w+|state[A-Z]\w+)'/g)) {
    keys.add(match[1])
  }
  // The update panel's step labels and status words are the same shape of
  // problem: they live in lookup tables keyed by a host value, not in a call.
  for (const match of source.matchAll(/:\s*'(step[A-Z]\w+|status[A-Z]\w+|updateGroup[A-Z]\w+)'/g)) {
    keys.add(match[1])
  }
  return [...keys].sort()
}

/** Every key any rendered component uses. */
function allUsedKeys() {
  const keys = new Set()
  for (const entry of SOURCES) for (const key of usedKeys(entry.source)) keys.add(key)
  return keys
}

test('copy: the namespace is namespaced', () => {
  assert.equal(NS, 'settings.pluginManager')
})

test('copy: both dictionaries carry exactly the same keys', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('copy: every value is a non-empty string', () => {
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, 'string', `zh.${key} is not a string`)
    assert.ok(value.length > 0, `zh.${key} is empty`)
  }
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string', `en.${key} is not a string`)
    assert.ok(value.length > 0, `en.${key} is empty`)
  }
})

test('copy: the panel uses no key a dictionary lacks', () => {
  for (const { name, source } of SOURCES) {
    for (const key of usedKeys(source)) {
      assert.ok(key in zh, `${name} uses t('${key}') but zh has no such key`)
      assert.ok(key in en, `${name} uses t('${key}') but en has no such key`)
    }
  }
})

test('copy: no dictionary key is dead', () => {
  // `tab` is used by the bundle wrapper, not the panel, so it is allowed.
  const allowed = new Set(['tab'])
  const used = allUsedKeys()
  for (const key of Object.keys(zh)) {
    assert.ok(used.has(key) || allowed.has(key), `zh.${key} is never used — delete it`)
  }
})
