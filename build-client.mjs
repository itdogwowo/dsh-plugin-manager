#!/usr/bin/env node
/**
 * Fold the browser half into ONE self-contained bundle.
 *
 * This step is mandatory, not a convenience. The client module system answers a
 * bundle's `require` from exactly three places — the platform seed words, an
 * already-materialized module, and a registered package factory
 * (`dsh-client-modules/lib/client.js:300-309`). A **relative** specifier matches
 * none of them and throws:
 *
 *   client-modules: require("./panel.js") missed the module table — not a
 *   platform seed word, not a materialized module, and no registered package
 *   factory (a build-time externals drift, or a dynamic dependency that did not
 *   arrive)
 *
 * So `filename.js` → a factory-map entry inside `client.js`, exactly like every
 * shipped bundle. `client.js` is generated: edit the sources, never the bundle.
 *
 * The four sources deliberately share no private identifiers, so concatenation
 * cannot collide. `npm run build:client` re-checks the bundle has no relative
 * require left.
 *
 * Usage: node build-client.mjs [--check]
 *   --check  fail instead of writing when client.js is stale (used by tests)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_DIR = new URL('./src/client/', import.meta.url)
/**
 * Fold order matters only for readability; the sources have no inter-imports.
 * The list lives in `bundle.json` so the bundle test asserts against the very
 * same list this script folds, instead of a copy that can drift.
 */
const MODULES = JSON.parse(readFileSync(new URL('bundle.json', CLIENT_DIR), 'utf8')).modules
const OUTPUT = new URL('./client.js', CLIENT_DIR)

/** Absolute path to a client source, for error messages. */
function pathOf(name) {
  return fileURLToPath(new URL(name, CLIENT_DIR))
}

/**
 * Turn one ES-module source into a classic-script factory body.
 *
 * The bundle is loaded as a CLASSIC script. An unconverted `export` there is a
 * syntax error that kills the entire combo script — taking every later bundle's
 * `__ModuleLoader__.load` with it, which is how a broken bundle silently
 * unregisters its neighbours.
 *
 * So each top-level `export ` is simply **removed**, leaving the plain
 * declaration. That is enough: the declaration stays in the factory's scope and
 * the wrapper ends every factory with `return module.exports`. No `exports.X = X`
 * is emitted, because such an assignment cannot be placed correctly by a line
 * transform — `export const zh = {` opens a multi-line literal, and appending the
 * assignment on the next line injects it *inside* the braces.
 *
 * @param {string} name - source file name.
 * @param {string} source - source text.
 * @returns {string} the factory body.
 */
function toFactoryBody(name, source) {
  if (/^\s*import\s/m.test(source)) {
    throw new Error(
      `${name} contains a top-level import; sources in this folder must be standalone (the bundle wrapper is the only place that calls require)`,
    )
  }

  const body = source.replace(/^export\s+/gm, '')
  assertClassic(name, body)
  return body
}

/** Refuse to ship a classic script that still contains module syntax. */
function assertClassic(name, body) {
  const offending = body.split('\n').findIndex((line) => /^\s*(?:export|import)\s/.test(line))
  if (offending !== -1) {
    throw new Error(
      `${name}: module syntax survived the transform at line ${offending + 1} — the bundle must be a classic script`,
    )
  }
}

/**
 * Wrap one source as a factory-map entry.
 * @param {string} name - source file name.
 * @returns {string} the wrapped entry.
 */
function wrap(name) {
  const source = readFileSync(pathOf(name), 'utf8')
  const body = toFactoryBody(name, source)

  assertClassic(name, body)

  const indented = body
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n')

  // No `module`/`exports` parameters: each source's `export` keyword is simply
  // stripped, so every binding stays a plain declaration in this factory's scope.
  // The factory returns exactly the names the source exported — avoiding an
  // `exports.X = X` line, which a line transform cannot position correctly for a
  // declaration that opens a multi-line literal (`export const zh = {`).
  const bindings = exportedBindings(name, source)

  return `  '${name}': function () {\n${indented}\n      return { ${bindings.join(', ')} }\n  },`
}

/**
 * The names a source exports.
 *
 * Every source in this folder uses `export <kind> <name>`, never a bare
 * `export { … }` list, which keeps this a single read per declaration.
 * @param {string} name - source file name, for error messages.
 * @param {string} source - the ORIGINAL source text.
 * @returns {string[]} exported binding names.
 */
function exportedBindings(name, source) {
  const declared = new Set()
  for (const line of source.replace(/^export\s+/gm, '').split('\n')) {
    const match = /^\s*(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/.exec(line)
    if (match !== null) declared.add(match[1])
  }

  const exported = []
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm)) {
    if (!declared.has(match[1])) {
      throw new Error(`${name}: exported name ${match[1]} has no matching declaration`)
    }
    exported.push(match[1])
  }

  if (exported.length === 0) {
    throw new Error(`${name} exports nothing — every inlined module must export something`)
  }
  return exported
}

/** The endpoint contract, folded into the bundle so the client needs no import. */
const ENDPOINTS = JSON.parse(readFileSync(new URL('./src/endpoints.json', import.meta.url), 'utf8'))

/** Render the whole bundle. */
function render() {
  const entries = MODULES.map(wrap).join('\n')
  const sourceList = MODULES.join(', ')

  return `/* GENERATED by build-client.mjs from ${sourceList} — do not edit.
 *
 * A bundle's require is answered only from the platform seed words, an
 * already-materialized module, or a registered package factory
 * (dsh-client-modules/lib/client.js:300-309), so every internal module must be
 * inlined here. Edit src/client/*.js and run \`npm run build:client\`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    // ─── inlined modules ─────────────────────────────────────────────────────
    //
    // Relative requires are impossible here (see build-client.mjs). Each source
    // below is a Cordis-free unit that takes its collaborators as arguments, so
    // there is no require graph to resolve at all.
    const __factories = {
${entries}
    }

    const __cache = Object.create(null)

    /** Resolve one inlined module by its source file name. */
    function local(name) {
      const cached = __cache[name]
      if (cached !== undefined) return cached
      const factory = __factories[name]
      if (factory === undefined) throw new Error('dsh-plugin-manager: unknown inlined module "' + name + '"')
      const exports = factory()
      __cache[name] = exports
      return exports
    }

    const { createPanel } = local('panel.js')
    const { createUpdatePanel } = local('update.js')
    const { createFace } = local('face.js')
    const { installStyles, probeTheme, themeTokens } = local('styles.js')
    const copy = local('copy.js')

    // ─── the plugin ──────────────────────────────────────────────────────────
    //
    // One page inside the Plugins settings section, beside the shipped tabs:
    // 'configurable' (order 0, plugin configuration) and 'all' (order 10, the
    // plugin list). A FRESH id adds a cell; reusing a shipped id would replace
    // it. See docs/host-notes.md F9.

    /** Target slot: one page inside the Plugins settings section. */
    const SLOT = 'settings.plugins.tab'
    /** Own cell key — never a shipped id. */
    const TAB_ID = 'plugin-manager'
    /** After both shipped tabs. */
    const TAB_ORDER = 20

    /**
     * Services this half needs.
     *
     * Declared as real cordis dependencies (not read with \`ctx.get\`), so they
     * arrive as \`ctx.slots\` / \`ctx.locale\` — the shape every shipped bundle
     * uses. There is no \`styles\`, \`host\` or \`harness\` here: those are
     * dynamic-Cordis-Plugin sandbox builtins and do not exist in a real bundle
     * (docs/host-notes.md F16).
     */
    exports.inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => installStyles(document), 'dsh-plugin-manager: panel styles')

      const probe = probeTheme(document)
      if (probe.missing.length > 0) {
        console.warn(
          '[dsh-plugin-manager] ' + probe.missing.length + '/' + themeTokens.length +
            ' theme tokens resolved to nothing: ' + probe.missing.join(', '),
        )
      }

      ctx.effect(
        () => ctx.locale.register(copy.NS, { zh: copy.zh, en: copy.en }),
        'dsh-plugin-manager: dictionaries',
      )

      /** Copy lookup: the registered dictionary when present, bundled zh otherwise. */
      const t = (key) => {
        try {
          const text = ctx.locale.bind(copy.NS)(key)
          if (typeof text === 'string' && text.length > 0 && text !== key) return text
        } catch {
          /* fall through to the bundled copy */
        }
        return copy.zh[key] === undefined ? key : copy.zh[key]
      }

      // The host face is HTTP: the host half registers these routes with
      // ctx.webServer, and the endpoints come from src/endpoints.json, folded in
      // below. \`face\` stays null when the page has no working fetch, and the
      // panel renders a notice instead of throwing.
      const endpoints = ${JSON.stringify(ENDPOINTS, null, 2).split('\n').join('\n      ')}
      const face = typeof fetch === 'function' ? createFace(fetch, endpoints) : null
      const Panel = createPanel(react, createUpdatePanel)

      ctx.effect(
        () =>
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              {
                name: SLOT,
                id: TAB_ID,
                order: TAB_ORDER,
                label: () => t('tab'),
                locale: copy.NS,
                inject: () => ({ t, face }),
              },
              Panel,
            ),
          ),
        'dsh-plugin-manager: settings tab',
      )

      console.log('[dsh-plugin-manager] client half ready; tab=' + TAB_ID + ' order=' + TAB_ORDER)
    }

    exports.apply = apply
    return module.exports
  },
})
`
}

const rendered = render()
const check = process.argv.includes('--check')
const current = (() => {
  try {
    return readFileSync(OUTPUT, 'utf8')
  } catch {
    return null
  }
})()

if (check) {
  if (current !== rendered) {
    console.error('build-client: src/client/client.js is stale — run `npm run build:client`')
    process.exit(1)
  }
  console.log('build-client: client.js is up to date')
  process.exit(0)
}

if (current === rendered) {
  console.log('build-client: unchanged')
  process.exit(0)
}

writeFileSync(OUTPUT, rendered)
console.log(`build-client: wrote client.js (${rendered.length} bytes) from ${MODULES.join(', ')}`)
