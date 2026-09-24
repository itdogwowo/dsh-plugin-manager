/**
 * Parameter-schema drift.
 *
 * `src/params.js` declares what detection reads and what it is allowed to do.
 * `test/params.test.mjs` enforces that the host report implements exactly that
 * declaration.
 *
 * The entry that made this file necessary: `position` was added to the host
 * report and to the panel's rendering, but never to the parameter table. Nothing
 * failed, so the parameter was invisible in the docs — a hand-kept parameter
 * list is a list that rots.
 *
 * These tests fail if the declaration and the implementation drift: verified by
 * removing `commit` from `SOURCE_PARAMS` and watching the sync case go red
 * (docs/host-notes.md F26).
 */

import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ALL_PARAM_KEYS, SOURCE_KINDS, SOURCE_PARAMS, STRATEGY_DEFAULTS, STRATEGY_PARAMS, VERDICTS } from '../src/params.js'
import { verdictOf, kindOf, refOf } from '../src/host/detect-report.js'

const REPORT = readFileSync(new URL('../src/host/detect-report.js', import.meta.url), 'utf8')

/**
 * The keys of the per-plugin object the report actually builds.
 *
 * Both `key: value` and ES6 shorthand (`resolvedDir,`) count — the first version
 * of this extractor only matched the `key:` form and reported `resolvedDir` as
 * missing when it was right there in shorthand.
 */
function implementedPluginKeys(source) {
  // The object literal is `out.plugins.push({ … })`; capture it by brace depth.
  const start = source.indexOf('out.plugins.push({')
  assert.notEqual(start, -1, 'the report must build a per-plugin object')
  let depth = 0
  let begin = -1
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1
      if (depth === 1) begin = i
    } else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        const body = source.slice(begin + 1, i)
        const keys = new Set()
        for (const match of body.matchAll(/^\s{6}(\w+)\s*:/gm)) keys.add(match[1])
        for (const match of body.matchAll(/^\s{6}(\w+),\s*$/gm)) keys.add(match[1])
        return [...keys].sort()
      }
    }
  }
  assert.fail('unterminated object literal')
}

test('params: every source parameter is implemented by the report', () => {
  const implemented = new Set(implementedPluginKeys(REPORT))
  for (const key of ALL_PARAM_KEYS.source) {
    assert.ok(
      implemented.has(key),
      `params.js declares source parameter "${key}" but detect-report.js never emits it — implement it or delete it`,
    )
  }
})

test('params: the report emits no plugin field the schema does not declare', () => {
  // The reverse direction. Without this, a new field can be shipped to the panel
  // and to the network while the documented parameter list stays silent.
  const declared = new Set(ALL_PARAM_KEYS.source)
  // Bookkeeping fields that are not parameters: they describe the row, not the
  // source it came from.
  const derived = new Set(['kind', 'verdict', 'verdictReason', 'baseline', 'dirHash', 'dirHashTruncated', 'self', 'loaded', 'declaresBundle'])
  for (const key of implementedPluginKeys(REPORT)) {
    assert.ok(
      declared.has(key) || derived.has(key),
      `detect-report.js emits "${key}" but params.js does not declare it — declare it or add it to the derived list`,
    )
  }
})

test('params: the strategy keys the report reads are all declared', () => {
  for (const key of ALL_PARAM_KEYS.strategy) {
    assert.ok(REPORT.includes(`strategy.${key}`), `strategy parameter "${key}" is declared but never read by the report`)
  }
})

test('params: every strategy default is a legal option', () => {
  for (const entry of STRATEGY_PARAMS) {
    if (!Array.isArray(entry.options)) continue
    // `includeKinds` declares its own full set as the default, so the check is
    // "is the default a legal MEMBER", not "is it one of the listed options".
    if (entry.key === 'includeKinds') {
      assert.deepEqual(
        [...entry.default].sort(),
        [...SOURCE_KINDS].sort(),
        'the default kind set must be exactly the declared kinds',
      )
      continue
    }
    assert.ok(
      entry.options.includes(entry.default),
      `"${entry.key}" defaults to ${JSON.stringify(entry.default)}, which is not among its options`,
    )
  }
})

test('params: detection declares that it writes nothing, and offers no way to say otherwise', () => {
  const write = STRATEGY_PARAMS.find((entry) => entry.key === 'writesAnything')
  assert.notEqual(write, undefined)
  assert.equal(write.default, false)
  assert.deepEqual(write.options, [false], 'the only legal value is false — this is what makes detection safe to run')
})

test('params: the default reachability is local', () => {
  // A default of 'network' would make the panel claim to have checked a
  // registry, which it cannot do.
  assert.equal(STRATEGY_DEFAULTS.reachability, 'local')
})

test('params: the declared kinds and verdicts cover what the code can return', () => {
  assert.deepEqual([...SOURCE_KINDS].sort(), ['file', 'git', 'link', 'registry', 'tarball-url'])
  assert.deepEqual([...VERDICTS].sort(), ['current', 'moved', 'unknown'])

  // kindOf must only ever return a declared kind, for every classified spec type.
  const specTypes = ['registry', 'link', 'file', 'tarball-url', 'git', 'alias', 'workspace', 'tag-or-range', 'something-new']
  for (const type of specTypes) {
    assert.ok(SOURCE_KINDS.includes(kindOf(type)), `kindOf('${type}') returned an undeclared kind`)
  }
})

test('params: no parameter carries a promise it cannot keep', () => {
  // The word "latest" is banned from the report's vocabulary: under local
  // reachability nothing here can know what the latest version is, and a field
  // label is the easiest place for that claim to sneak back in.
  const banned = /\blatest\b|最新版|is up to date|已是最新/i
  for (const entry of [...SOURCE_PARAMS, ...STRATEGY_PARAMS]) {
    assert.doesNotMatch(entry.label, banned, `parameter "${entry.key}" makes a freshness claim it cannot support`)
    assert.doesNotMatch(entry.meaning, banned, `parameter "${entry.key}" makes a freshness claim it cannot support`)
  }
})

// ── the comparison logic ────────────────────────────────────────────────────

test('verdict: a registry dependency with no locked version is unknown, never current', () => {
  const result = verdictOf({
    kind: 'registry',
    plugin: { name: 'x', spec: '^1.0.0', version: '1.0.0' },
    lock: null,
    git: null,
    fileInfo: null,
  })
  assert.equal(result.verdict, 'unknown')
  assert.match(result.reason, /no resolved version/)
})

test('verdict: a registry mismatch is moved, and names both numbers', () => {
  const result = verdictOf({
    kind: 'registry',
    plugin: { name: 'x', spec: '^1.0.0', version: '1.1.0' },
    lock: { specifier: '^1.0.0', version: '1.0.0' },
    git: null,
    fileInfo: null,
  })
  assert.equal(result.verdict, 'moved')
  assert.match(result.reason, /1\.1\.0/)
  assert.match(result.reason, /1\.0\.0/)
})

test('verdict: a registry match is current but must not claim to be the newest', () => {
  const result = verdictOf({
    kind: 'registry',
    plugin: { name: 'x', spec: '^1.0.0', version: '1.0.0' },
    lock: { specifier: '^1.0.0', version: '1.0.0' },
    git: null,
    fileInfo: null,
  })
  assert.equal(result.verdict, 'current')
  // The range may admit a newer release; saying otherwise needs a registry query.
  assert.match(result.baseline, /may still admit a newer release/)
})

test('verdict: a link with no git checkout is unknown, and says why', () => {
  const result = verdictOf({
    kind: 'link',
    plugin: { name: 'x', spec: 'link:/somewhere', version: '1.0.0' },
    lock: null,
    git: { isRepo: false },
    fileInfo: null,
  })
  assert.equal(result.verdict, 'unknown')
  assert.match(result.reason, /no readable git checkout/)
})

test('verdict: a checkout with no remote is unknown — nothing outside this machine exists', () => {
  const result = verdictOf({
    kind: 'link',
    plugin: { name: 'x', spec: 'link:/somewhere', version: '1.0.0' },
    lock: null,
    git: { isRepo: true, remote: null, commit: 'abc1234' },
    fileInfo: null,
  })
  assert.equal(result.verdict, 'unknown')
  assert.match(result.reason, /no origin remote/)
})

test('verdict: git compares the local commit against the LAST OBSERVED upstream', () => {
  const differs = verdictOf({
    kind: 'link',
    plugin: { name: 'x', spec: 'link:/somewhere', version: '1.0.0' },
    lock: null,
    git: { isRepo: true, remote: 'https://example.invalid/r.git', branch: 'main', commit: 'aaaa1111', trackingRef: 'bbbb2222' },
    fileInfo: null,
  })
  assert.equal(differs.verdict, 'moved')
  assert.match(differs.baseline, /at last fetch/, 'the baseline must say when it was taken')

  const same = verdictOf({
    kind: 'link',
    plugin: { name: 'x', spec: 'link:/somewhere', version: '1.0.0' },
    lock: null,
    git: { isRepo: true, remote: 'https://example.invalid/r.git', branch: 'main', commit: 'aaaa1111', trackingRef: 'aaaa1111' },
    fileInfo: null,
  })
  assert.equal(same.verdict, 'current')
})

test('verdict: FETCH_HEAD alone is an acceptable baseline when the tracking ref is absent', () => {
  const result = verdictOf({
    kind: 'link',
    plugin: { name: 'x', spec: 'link:/somewhere', version: '1.0.0' },
    lock: null,
    git: { isRepo: true, remote: 'https://example.invalid/r.git', branch: 'main', commit: 'cccc3333', trackingRef: null, fetchHead: 'cccc3333' },
    fileInfo: null,
  })
  assert.equal(result.verdict, 'current')
})

test('verdict: a file tarball is unknown — it has no upstream at all', () => {
  const result = verdictOf({
    kind: 'file',
    plugin: { name: 'x', spec: 'file:/tmp/x-1.0.0.tgz', version: '1.0.0' },
    lock: null,
    git: null,
    fileInfo: { path: '/tmp/x-1.0.0.tgz', hash: 'abcd1234', size: 100 },
  })
  assert.equal(result.verdict, 'unknown')
  assert.match(result.reason, /no upstream/)
})

test('verdict: a tarball whose name disagrees with the install is moved', () => {
  const result = verdictOf({
    kind: 'file',
    plugin: { name: 'x', spec: 'file:/tmp/x-2.0.0.tgz', version: '1.0.0' },
    lock: null,
    git: null,
    fileInfo: { path: '/tmp/x-2.0.0.tgz', hash: 'abcd1234', size: 100 },
  })
  assert.equal(result.verdict, 'moved')
  assert.match(result.reason, /named 2\.0\.0 but 1\.0\.0/)
})

test('verdict: a missing tarball is unknown, not a crash', () => {
  const result = verdictOf({
    kind: 'file',
    plugin: { name: 'x', spec: 'file:/tmp/gone-1.0.0.tgz', version: '1.0.0' },
    lock: null,
    git: null,
    fileInfo: { path: '/tmp/gone-1.0.0.tgz', hash: null, size: null },
  })
  assert.equal(result.verdict, 'unknown')
  assert.match(result.reason, /not present/)
})

test('verdict: a URL source can never be resolved offline', () => {
  const result = verdictOf({
    kind: 'tarball-url',
    plugin: { name: 'x', spec: 'https://example.invalid/latest/x.tgz', version: '1.0.0' },
    lock: null,
    git: null,
    fileInfo: null,
  })
  assert.equal(result.verdict, 'unknown')
})

test('refOf: the comparison key is null exactly when the local path is the identity', () => {
  assert.equal(refOf('link', { spec: 'link:/x' }, { branch: 'main' }), null)
  assert.equal(refOf('git', { spec: 'github:a/b' }, { branch: 'main' }), 'main')
  assert.equal(refOf('registry', { spec: '^1.0.0' }, null), '^1.0.0')
  assert.equal(refOf('file', { spec: 'file:/x/y.tgz' }, null), 'file:/x/y.tgz')
})
