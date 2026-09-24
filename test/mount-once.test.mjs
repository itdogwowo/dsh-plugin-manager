/**
 * The duplicate-mount guard exists to stop a second install source of the same
 * package from re-registering the same RPC handlers — a throw during tree
 * composition is what makes `dsh web` fail to start.
 *
 * The guard rides a global symbol, so each case clears it first.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mountOnce, ownVersion, PACKAGE_NAME } from '../src/host/mount-once.js'

const KEY = Symbol.for('dsh-plugin-manager.mounted-plugins')

/** A context whose effects run immediately and can be disposed on demand. */
function fakeCtx() {
  const disposers = []
  return {
    disposers,
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    disposeAll() {
      while (disposers.length > 0) disposers.pop()()
    },
  }
}

test('mountOnce: package name is the npm identity and the client bundle id', () => {
  assert.equal(PACKAGE_NAME, 'dsh-plugin-manager')
})

test('mountOnce: a second mount is a no-op while the first is live', () => {
  delete globalThis[KEY]
  let runs = 0
  const apply = mountOnce('unit-a', () => {
    runs += 1
  })

  const first = fakeCtx()
  const second = fakeCtx()
  apply(first)
  apply(second)

  assert.equal(runs, 1, 'the guarded apply must run the implementation once')
  delete globalThis[KEY]
})

test('mountOnce: disposing the first fiber lets a later mount run again', () => {
  delete globalThis[KEY]
  let runs = 0
  const apply = mountOnce('unit-b', () => {
    runs += 1
  })

  const first = fakeCtx()
  apply(first)
  first.disposeAll()
  apply(fakeCtx())

  assert.equal(runs, 2)
  delete globalThis[KEY]
})

test('mountOnce: the guard is keyed per package, not globally', () => {
  delete globalThis[KEY]
  let a = 0
  let b = 0
  mountOnce('unit-c', () => {
    a += 1
  })(fakeCtx())
  mountOnce('unit-d', () => {
    b += 1
  })(fakeCtx())

  assert.equal(a, 1)
  assert.equal(b, 1)
  delete globalThis[KEY]
})

test('mountOnce: a context without effect still runs the implementation', () => {
  delete globalThis[KEY]
  let runs = 0
  const apply = mountOnce('unit-e', () => {
    runs += 1
  })

  apply({})
  assert.equal(runs, 1)
  delete globalThis[KEY]
})

test('ownVersion: reads this package version, and never throws', () => {
  const version = ownVersion(import.meta.url)
  assert.equal(typeof version, 'string')
  assert.match(version, /^\d+\.\d+\.\d+/)

  // A URL that resolves to no manifest must return null rather than throw.
  assert.equal(ownVersion('file:///nonexistent/deep/path/module.js'), null)
})
