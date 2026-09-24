/**
 * The generated client bundle is the one artifact whose staleness breaks the
 * whole product: a relative `require` in it throws during page boot, and the
 * user sees "Failed to load plugins" instead of a panel. These cases fail at
 * `npm test` instead.
 *
 * The rules come from `dsh-client-modules/lib/client.js:300-309` — a bundle's
 * require is answered ONLY from the platform seed words, an already-materialized
 * module, or a registered package factory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const BUNDLE = new URL('../src/client/client.js', import.meta.url)
/** The same list build-client.mjs folds — one source of truth, no drift. */
const MODULES = JSON.parse(readFileSync(new URL('../src/client/bundle.json', import.meta.url), 'utf8')).modules

/** Every `require('...')` specifier in the bundle. */
function requires(source) {
  return [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
}

// Staleness itself is guarded by `npm test`'s leading
// `node build-client.mjs --check`; a test cannot re-run it here because
// spawning a child process is blocked in this environment.

test('bundle: every require resolves in the client module system', () => {
  const source = readFileSync(BUNDLE, 'utf8')
  const specifiers = requires(source)

  assert.ok(specifiers.length > 0, 'the bundle must require the react seed')

  for (const specifier of specifiers) {
    assert.equal(
      specifier.startsWith('.') || specifier.startsWith('/'),
      false,
      `"${specifier}" is relative — the module table cannot answer it (use the inlined factory map instead)`,
    )
  }

  // 'react' is a platform seed word. Nothing else is available to us: a row in
  // the boot graph would have to be declared through dsh.client.inject, and
  // this package deliberately declares none.
  assert.deepEqual([...new Set(specifiers)], ['react'])
})

test('bundle: keeps the wrapper contract the loader requires', () => {
  const source = readFileSync(BUNDLE, 'utf8')

  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.match(source, /id:\s*'dsh-plugin-manager'/)
  assert.match(source, /exports\.apply\s*=/)
  assert.match(source, /exports\.inject\s*=\s*\['slots',\s*'locale'\]/)
})

test('bundle: inlines every module it used to require', () => {
  const source = readFileSync(BUNDLE, 'utf8')

  for (const name of MODULES) {
    assert.ok(
      source.includes(`'${name}': function`),
      `${name} is not inlined into the bundle — run \`npm run build:client\``,
    )
  }
})

test('bundle: the generated file is marked generated', () => {
  const source = readFileSync(BUNDLE, 'utf8')
  assert.match(source, /^\/\*\s*GENERATED/, 'client.js must carry a generated-by header')
})
