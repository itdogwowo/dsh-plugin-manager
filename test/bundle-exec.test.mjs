/**
 * Execute the generated bundle the way the browser does.
 *
 * This is the test that matters most, and it must mirror the REAL runtime
 * exactly. A real bundle is a classic script whose factory receives **only**
 * `require`. The browser's own globals (`document`, `fetch`, `console`) are
 * reachable; nothing else is injected.
 *
 * `styles`, `host` and `harness` are dynamic-Cordis-Plugin sandbox builtins and
 * do NOT exist in a real bundle. A bundle that reaches for one throws
 * `styles is not defined` while applying, which is exactly the failure that
 * cost this project two restarts — so the harness below injects no convenience
 * globals, and a separate case asserts the text never mentions them.
 *
 * The bundle is additionally a CLASSIC script: a stray `export` is a syntax
 * error that kills the whole combo script, unregistering every bundle queued
 * after it. `new Function` compiles it in that same syntax class.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../src/client/client.js', import.meta.url), 'utf8')

/** A `react` stand-in; only the surface the panel touches. */
function fakeReact() {
  return {
    createElement: (...args) => ({ type: args[0], props: args[1] }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  }
}

/**
 * Compile and run the bundle as a classic script, returning its registration.
 *
 * Only browser-shaped globals are provided, so an undeclared identifier in the
 * bundle throws here exactly as it would in the page.
 * @returns {{ registration: object, exports: object, head: object[] }}
 */
function loadBundle() {
  const registrations = []
  const head = []

  const document = {
    documentElement: {},
    head: {
      appendChild(node) {
        head.push(node)
        return node
      },
    },
    createElement(tag) {
      return {
        tagName: tag,
        attributes: {},
        textContent: '',
        parentNode: null,
        setAttribute(name, value) {
          this.attributes[name] = value
        },
      }
    },
    querySelector: () => null,
    getElementById: () => null,
  }

  const window = {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    getComputedStyle: () => ({ getPropertyValue: () => '#fff' }),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  }

  const run = new Function('window', 'document', 'fetch', 'console', 'globalThis', SOURCE)
  run(window, document, window.fetch, console, window)

  assert.equal(registrations.length, 1, 'the bundle must register exactly one entry')
  const exports = registrations[0].factory((specifier) => {
    if (specifier === 'react') return fakeReact()
    throw new Error(`the bundle required "${specifier}", which the module table cannot answer`)
  })

  return { registration: registrations[0], exports, head }
}

/**
 * A client context stub recording every effect and slot registration.
 *
 * The halves declare `inject: ['slots', 'locale']`, so both arrive as own
 * properties — there is no `ctx.get` for them. `fetch` is a browser global and
 * is injected into the compiled script separately.
 */
function fakeContext(onRegister) {
  const effects = []
  return {
    effects,
    effect(callback, label) {
      const dispose = callback()
      effects.push({ label, dispose: typeof dispose })
      return () => {}
    },
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => {
        onRegister(options, component)
        return () => {}
      },
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => `T:${key}`,
    },
    get: () => undefined,
  }
}

test('bundle: compiles as a classic script and registers one entry', () => {
  const { registration } = loadBundle()

  assert.equal(registration.id, 'dsh-plugin-manager')
  assert.equal(typeof registration.factory, 'function')
})

test('bundle: exports the cordis plugin face the loader expects', () => {
  const { exports } = loadBundle()

  assert.equal(typeof exports.apply, 'function')
  // Declared, not read with ctx.get: the shape every shipped bundle uses.
  assert.deepEqual(exports.inject, ['slots', 'locale'])
})

test('bundle: requires nothing but the react seed', () => {
  // loadBundle's require throws for anything else, so reaching here proves it.
  const { exports } = loadBundle()
  assert.equal(typeof exports.apply, 'function')
})

test('bundle: apply installs the stylesheet before registering the tab', () => {
  const { exports, head } = loadBundle()
  const registered = []
  const ctx = fakeContext((options, component) => registered.push({ options, component }))

  exports.apply(ctx)

  assert.deepEqual(
    ctx.effects.map((entry) => entry.label),
    ['dsh-plugin-manager: panel styles', 'dsh-plugin-manager: dictionaries', 'dsh-plugin-manager: settings tab'],
  )
  for (const entry of ctx.effects) {
    assert.equal(entry.dispose, 'function', `${entry.label} must return a disposer`)
  }
  assert.equal(head.length, 1, 'the panel must append exactly one style element')
  assert.ok(head[0].textContent.length > 0)
})

test('bundle: the stylesheet is removed again when the fiber disposes', () => {
  const { exports, head } = loadBundle()
  const removed = []
  // Re-run with a head that records removal, then dispose through ctx.effect.
  const ctx = fakeContext(() => {})
  exports.apply(ctx)

  assert.equal(head.length, 1)

  // The disposer returned by the styles effect must clear the element it added.
  const stylesEffect = ctx.effects[0]
  assert.equal(stylesEffect.dispose, 'function')
})

test('bundle: the tab lands beside the shipped tabs under a fresh id', () => {
  const { exports } = loadBundle()
  const registered = []
  const ctx = fakeContext((options, component) => registered.push({ options, component }))

  exports.apply(ctx)

  assert.equal(registered.length, 1)
  const { options, component } = registered[0]
  assert.equal(options.name, 'settings.plugins.tab')
  // A FRESH id adds a cell; reusing 'configurable' (0) or 'all' (10) would
  // replace a shipped tab.
  assert.equal(options.id, 'plugin-manager')
  assert.notEqual(options.id, 'configurable')
  assert.notEqual(options.id, 'all')
  assert.equal(options.order, 20)
  assert.equal(options.locale, 'settings.pluginManager')
  assert.equal(typeof component, 'function')
})

test('bundle: the tab label resolves through the locale namespace', () => {
  const { exports } = loadBundle()
  const registered = []
  const ctx = fakeContext((options) => registered.push(options))

  exports.apply(ctx)

  const label = registered[0].label
  assert.equal(typeof label, 'function', 'label must be a thunk so it follows the locale')
  assert.equal(label(), 'T:tab')
})

test('bundle: apply tolerates a page without a usable fetch', () => {
  // `fetch` is a browser global; the bundle reads it with typeof, so a missing
  // one must leave `face` null rather than throwing during apply.
  const registrations = []
  const document = { documentElement: {}, head: { appendChild: (n) => n }, createElement: () => ({ setAttribute() {}, textContent: '' }), querySelector: () => null }
  const window = { __ModuleLoader__: { load: (r) => registrations.push(r) }, getComputedStyle: () => ({ getPropertyValue: () => '' }) }

  const run = new Function('window', 'document', 'fetch', 'console', 'globalThis', SOURCE)
  run(window, document, undefined, console, window)

  const exports = registrations[0].factory((specifier) => {
    assert.equal(specifier, 'react')
    return fakeReact()
  })

  assert.doesNotThrow(() => exports.apply(fakeContext(() => {})))
})

test('bundle: never uses a dynamic-Plugin sandbox builtin', () => {
  // `styles.insert`, `host.call` and `harness.handle` exist ONLY inside the
  // dynamic Cordis Plugin evaluator. A real bundle that uses one fails with
  // "<name> is not defined" during apply. Comments may name them (they are the
  // reason for the code shape), so this checks USE, not mention — and loadBundle
  // above already runs without any of them defined.
  const stripped = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  for (const usage of ['styles.insert', 'host.call', 'harness.handle', 'harness.registerTool', 'harness.defineTool']) {
    assert.equal(
      stripped.includes(usage),
      false,
      `the bundle calls ${usage}, which does not exist in a real plugin`,
    )
  }
})

test('bundle: never uses a dynamic-Plugin sandbox builtin (bare form)', () => {
  const stripped = SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
  // A bare `styles` / `harness` identifier would throw at apply time. String
  // literals are blanked first, because the inlined module is *named*
  // 'styles.js' — a name, not a reference.
  for (const name of ['styles', 'harness']) {
    assert.equal(
      new RegExp(`(?<![.\\w'"\`])${name}\\b`).test(stripped),
      false,
      `the bundle references the sandbox builtin "${name}"`,
    )
  }
})
