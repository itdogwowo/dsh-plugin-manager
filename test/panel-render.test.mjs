/**
 * Render the panel against payloads shaped like the REAL host responses.
 *
 * This file exists because of a specific miss. The earlier suites checked
 * `apply` and the wrapper contract, but their `fetch` stub answered with `{}`,
 * so nothing ever rendered the component with a live-shaped payload. A single
 * unguarded read (`data.backend`, a field the overview endpoint does NOT serve —
 * the backend report comes from a second route) then crashed every render:
 *
 *   TypeError: Cannot read properties of undefined (reading 'clientModules')
 *     at Panel
 *
 * So these cases assert three things: the panel renders at all, it renders
 * WITHOUT the field that used to crash it, and it survives a shape it does not
 * understand. No process is spawned and no HTTP request is made.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createFace } from '../src/client/face.js'

const SOURCE = readFileSync(new URL('../src/client/client.js', import.meta.url), 'utf8')
const ENDPOINTS = JSON.parse(readFileSync(new URL('../src/endpoints.json', import.meta.url), 'utf8'))

/**
 * A `react` stand-in that actually holds state across renders.
 *
 * `useState` must persist (otherwise the panel is frozen on its first render and
 * every post-load assertion is meaningless) and `useEffect` must run (otherwise
 * the load never starts). Components are invoked eagerly so the returned object
 * IS the tree.
 */
function createReact() {
  const hooks = []
  let cursor = 0
  let rerender = () => {}

  const react = {
    // An element is a DESCRIPTOR, never an eager call. Invoking function
    // components here would recurse (Panel renders Row which renders Row…);
    // the test calls `Panel` itself, which is the unit under test.
    createElement(type, props, ...children) {
      return { type, props, children }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) {
        hooks[index] = typeof initial === 'function' ? initial() : initial
      }
      const set = (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
        rerender()
      }
      return [hooks[index], set]
    },
    useEffect(effect) {
      const index = cursor
      cursor += 1
      // Effects run once, like a component with an unchanging dependency list.
      if (hooks[index] === undefined) {
        hooks[index] = true
        const cleanup = effect()
        return typeof cleanup === 'function' ? cleanup : undefined
      }
      return undefined
    },
    /** Let a test drive a re-render after a `setState` lands. */
    __onRerender(fn) {
      rerender = fn
    },
    /** Reset the hook cursor before each `Panel` invocation. */
    __begin() {
      cursor = 0
    },
    /**
     * Pre-seed hook slots so a test can mount the panel already holding a value
     * (the search query). Slot order is the component's call order: tick, query,
     * state, effect.
     * @param {object[]} values - slot values, in call order.
     */
    __seed(values) {
      for (let i = 0; i < values.length; i += 1) hooks[i] = values[i]
    },
  }

  return react
}

/** Load the bundle with a stateful react stub and return its exports. */
function loadBundle() {
  const registrations = []
  const react = createReact()
  const document = {
    documentElement: {},
    head: { appendChild: () => undefined },
    createElement: () => ({ setAttribute() {}, textContent: '', parentNode: null }),
    querySelector: () => null,
  }
  const window = {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    getComputedStyle: () => ({ getPropertyValue: () => '#fff' }),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  }

  new Function('window', 'document', 'fetch', 'console', 'globalThis', SOURCE)(
    window,
    document,
    window.fetch,
    console,
    window,
  )

  const exports = registrations[0].factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require: ${specifier}`)
  })

  return { exports, react }
}

/**
 * Register the tab, then render it the way React does: run the effect, let the
 * async load settle, and render again with the state it produced.
 *
 * A stub that merely *records* `useEffect` would leave the panel stuck in
 * `loading` and prove nothing — the crash this file guards against happened on
 * the post-load render.
 *
 * @param {object} payload - what `face.load()` resolves to.
 * @param {{ reject?: boolean, query?: string, renders?: number }} [options] -
 *   make the load reject, mount with a search query already typed, or force
 *   extra renders when the state settles without a re-render.
 * @returns {Promise<object>} the final rendered tree.
 */
async function renderPanel(payload, options = {}) {
  const { exports, react } = loadBundle()

  let entry = null
  const ctx = {
    effect: (callback) => {
      callback()
      return () => {}
    },
    slots: {
      inject: (key, callback) => callback(),
      register: (options_, component) => {
        entry = { options: options_, component }
        return () => {}
      },
    },
    locale: { register: () => () => {}, bind: () => (key) => `T:${key}` },
    get: () => undefined,
  }

  exports.apply(ctx)
  assert.ok(entry !== null, 'the tab must register')

  const face = {
    load: () => (options.reject === true ? Promise.reject(new Error('boom')) : Promise.resolve(payload)),
  }
  const props = { ...entry.options.inject(), face }

  // First render mounts the state and runs the effect, which starts the load.
  react.__begin()
  // Slot order: 0 tick, 1 query, 2 load state. Seeding a query has to happen
  // before the mount render, because the filter is applied during render.
  react.__seed([0, typeof options.query === 'string' ? options.query : '', undefined])
  let tree = entry.component(props)
  let rerendered = false
  react.__onRerender(() => {
    rerendered = true
    react.__begin()
    tree = entry.component(props)
  })

  // Let the load promise settle so its setState lands and re-renders the tree.
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  if (!rerendered && options.renders !== undefined) {
    for (let i = 0; i < options.renders; i += 1) {
      react.__begin()
      tree = entry.component(props)
    }
  }
  // The component carries the card-class and state-key rules, neither of which
  // can be read off the descriptor tree; expose them to the caller the same way.
  renderPanel.__cardClassOf = entry.component.__cardClassOf
  renderPanel.__stateKeyOf = entry.component.__stateKeyOf
  renderPanel.__PluginCard = entry.component.__PluginCard
  return tree
}

/** An overview payload with the real top-level key set. */
function overview() {
  return {
    at: 1_790_000_000_000,
    rev: '1f00850eb918',
    entries: [
      { index: 0, id: '@deepseek-ai/dsh-base', url: '/plugins/a.js', rev: 'r1', immediate: true, inject: [] },
      { index: 1, id: 'dsh-plugin-manager', url: '/plugins/???', rev: 'r2', immediate: false, inject: [], thirdParty: true, self: true },
    ],
    batches: [{ index: 0, phase: 'application', url: '/plugins/??a,b', rev: 'b1', count: 2, entries: ['a'] }],
    injected: ['react'],
    thirdParty: [
      {
        name: 'dsh-plugin-manager',
        spec: 'link:/checkout/dsh-plugin-manager',
        version: '0.0.0',
        sourceType: 'link',
        changeSignal: 'resolvedDir',
        resolvedDir: '/checkout/dsh-plugin-manager/package.json',
        declaresBundle: true,
        inBundles: true,
        self: true,
        loaded: true,
        enabled: true,
      },
    ],
    counts: { total: 2, immediate: 1, lazy: 1, injected: 1, batches: 1, thirdParty: 1, thirdPartyLoaded: 1 },
    inventory: { available: false, rows: [], count: 0 },
    pluginInventory: {
      available: true,
      reason: null,
      profile: { name: 'web', dir: '/home/user/.dsh/profiles/web', source: 'fs-base' },
      manifestPath: '/home/user/.dsh/profiles/web/package.json',
      declaredBundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-manager'],
      installed: 1,
      loaded: 1,
    },
    notices: [],
    source: 'clientModules.graph()',
  }
}

/** A backend payload with the real key set. */
function backend() {
  return {
    clientModules: 'ready',
    pluginInventory: 'absent',
    fs: 'ready',
    profileCandidates: ['/home/user/.dsh/profiles/web (fs-base)'],
    node: '22.0.0',
    platform: 'linux',
  }
}

test('panel: renders the real merged payload', async () => {
  const tree = await renderPanel({ ...overview(), backend: backend() }, { renders: 1 })

  assert.equal(tree.type, 'div')
  assert.ok(tree.children.length > 0, 'the panel must render rows, not an empty tree')
})

test('panel: the rendered tree actually shows the third-party table', () => {
  // Guards against a render that "succeeds" by returning an empty shell.
  return renderPanel({ ...overview(), backend: backend() }, { renders: 1 }).then((tree) => {
    const serialized = JSON.stringify(tree)
    assert.ok(serialized.includes('dsh-plugin-manager'), 'the plugin list must appear in the tree')
    assert.ok(serialized.includes('resolvedDir'), 'the change-signal column must render')
  })
})

/**
 * The contract the panel depends on: `face.load()` must answer with ONE object
 * carrying both the entry list and the backend report, because the panel renders
 * a single `data`. The overview route serves only the first half — depending on
 * it alone left `data.backend` undefined and crashed every render.
 *
 * This case drives the real `face` against a stub `fetch`, so it fails if the
 * merge is ever dropped. That is the regression the render cases above CANNOT
 * see, because the panel is now defensive about a missing field.
 */
test('face: load() merges the overview and backend reports into one payload', async () => {
  const requested = []
  const byPath = {
    '/api/dsh-plugin-manager/overview': overview(),
    '/api/dsh-plugin-manager/backend': backend(),
  }

  const stubFetch = async (url) => {
    requested.push(url)
    const answer = byPath[url]
    if (answer === undefined) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
    return { ok: true, status: 200, json: async () => answer }
  }

  const face = createFace(stubFetch, ENDPOINTS)
  const payload = await face.load()

  assert.deepEqual(requested.sort(), ['/api/dsh-plugin-manager/backend', '/api/dsh-plugin-manager/overview'])
  assert.equal(payload.source, 'clientModules.graph()', 'the overview fields must survive the merge')
  assert.ok(payload.backend !== undefined && payload.backend !== null, 'the backend report must be merged in')
  assert.equal(payload.backend.clientModules, 'ready')
})

test('face: a failing backend read does not sink the entry list', async () => {
  // The entry list is the point; a broken backend report must degrade to null.
  const stubFetch = async (url) =>
    url.endsWith('/overview')
      ? { ok: true, status: 200, json: async () => overview() }
      : { ok: false, status: 500, json: async () => ({ error: 'nope' }) }

  const payload = await createFace(stubFetch, ENDPOINTS).load()

  assert.equal(payload.source, 'clientModules.graph()')
  assert.equal(payload.backend, null)
})

/**
 * Detection is on-demand and must stay that way.
 *
 * `load()` is what runs when the tab opens. If detection ever joins it, opening
 * the tab starts fingerprinting every linked plugin's tree — which is the R4
 * violation this asserts against, and it would be invisible in a code review of
 * `detect()` alone.
 */
test('face: load() does NOT run detection', async () => {
  const requested = []
  const stubFetch = async (url) => {
    requested.push(url)
    return {
      ok: true,
      status: 200,
      json: async () => (url.endsWith('/overview') ? overview() : url.endsWith('/backend') ? backend() : { at: 1, plugins: [] }),
    }
  }

  const payload = await createFace(stubFetch, ENDPOINTS).load()

  assert.equal(
    requested.some((url) => url.endsWith('/detect')),
    false,
    'opening the tab must not run detection — it is a separate, explicit action',
  )
  assert.equal(payload.detect, undefined, 'the report must not be smuggled into the payload')
})

test('face: detect() reads the detect endpoint and returns its report', async () => {
  const stubFetch = async (url) => {
    if (!url.endsWith('/detect')) return { ok: false, status: 404, json: async () => ({}) }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        at: 1,
        strategy: { reachability: 'local', writesAnything: false },
        counts: { total: 1, current: 0, moved: 0, unknown: 1 },
        plugins: [{ name: 'x', kind: 'link', verdict: 'unknown', verdictReason: 'no upstream', baseline: null }],
      }),
    }
  }

  const report = await createFace(stubFetch, ENDPOINTS).detect()

  assert.equal(report.plugins.length, 1)
  assert.equal(report.plugins[0].verdict, 'unknown')
  assert.equal(report.strategy.writesAnything, false)
})

test('face: a failed detect rejects rather than resolving empty', async () => {
  // The panel renders a notice on rejection. Resolving `{plugins: []}` instead
  // would show "no plugins to check", which is a different and false claim.
  const stubFetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })

  await assert.rejects(() => createFace(stubFetch, ENDPOINTS).detect(), /detect failed/)
})

test('face: setEnabled POSTs the id and state, and resolves the host outcome', async () => {
  const seen = []
  const stubFetch = async (url, init) => {
    seen.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, id: 'tool-x', enabled: false, restartRequired: true }) }
  }

  const result = await createFace(stubFetch, ENDPOINTS).setEnabled('tool-x', false)

  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, '/api/dsh-plugin-manager/toggle')
  assert.equal(seen[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(seen[0].init.body), { id: 'tool-x', enabled: false })
  assert.equal(result.restartRequired, true)
})

test('face: a refused write resolves with the refusal instead of rejecting', async () => {
  // A sandbox denial is an ANSWER. Rejecting would make the panel render a
  // generic failure and lose the one detail the user needs.
  const stubFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, denied: true, error: 'the write was refused by the sandbox' }),
  })

  const result = await createFace(stubFetch, ENDPOINTS).setEnabled('tool-x', false)

  assert.equal(result.ok, false)
  assert.equal(result.denied, true)
  assert.match(result.error, /sandbox/)
})

test('face: a broken channel rejects', async () => {
  const stubFetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'kaboom' }) })

  await assert.rejects(() => createFace(stubFetch, ENDPOINTS).setEnabled('tool-x', false), /toggle failed/)
})

test('panel: renders when the payload has NO backend report', async () => {
  // The exact shape the overview route serves on its own. Before the merge fix
  // this threw `Cannot read properties of undefined (reading 'clientModules')`
  // and blanked the tab.
  await assert.doesNotReject(() => renderPanel(overview(), { renders: 1 }))
})

test('panel: renders when the payload has no optional section at all', async () => {
  await assert.doesNotReject(() => renderPanel({ at: 1, source: 'none' }, { renders: 1 }))
})

test('panel: an unusable payload says so instead of throwing', async () => {
  const tree = await renderPanel(undefined, { renders: 1 })

  assert.equal(tree.type, 'div')
  assert.ok(JSON.stringify(tree).includes('badPayload'), 'the panel must name the problem')
})

test('panel: a failed load renders the failure, not a crash', async () => {
  const tree = await renderPanel(null, { reject: true, renders: 1 })

  assert.equal(tree.type, 'div')
  assert.ok(JSON.stringify(tree).includes('T:failed'), 'the panel must show the failure')
})

test('panel: a partially-populated plugin row renders', async () => {
  const payload = overview()
  // Every optional field absent at once — the row builders must not assume any.
  payload.thirdParty = [{ name: 'x', self: false }]
  payload.pluginInventory = { available: true, declaredBundles: [] }

  await assert.doesNotReject(() => renderPanel(payload, { renders: 1 }))
})

/**
 * A plugin row for the enabled/disabled cases below.
 * @param {object} over - fields to override.
 * @returns {object} an inventory row.
 */
function pluginRow(over) {
  return {
    name: 'x',
    spec: '^1.0.0',
    version: '1.0.0',
    sourceType: 'registry',
    changeSignal: 'integrity',
    declaresBundle: true,
    loaded: true,
    enabled: true,
    enabledState: 'running',
    disabledBy: null,
    enabledReason: null,
    ...over,
  }
}

/** An overview payload with a ready inventory and the given plugins. */
function withPlugins(plugins) {
  const payload = overview()
  payload.backend = backend()
  payload.pluginInventory = { ...payload.pluginInventory, available: true, reason: null }
  payload.thirdParty = plugins
  return payload
}

/**
 * The card's leading state.
 *
 * "Enabled", "disabled" and "enabled but not running" are three different
 * answers, and the third is a fault. A card that renders the same thing for all
 * three is worse than no card: it tells the user everything is fine while a
 * plugin they installed is not running.
 */
test('panel: a disabled plugin is shown as disabled, with the layer that did it', async () => {
  const payload = withPlugins([
    pluginRow({ name: 'off-tool', loaded: false, enabled: false, enabledState: 'disabled', disabledBy: 'user patch (cordis.patch.yml)' }),
    pluginRow({ name: 'on-tool' }),
  ])

  const tree = await renderPanel(payload, { renders: 1 })
  const cards = findCards(tree)
  assert.equal(cards.length, 2, 'both plugins must render')

  const off = cards.find((card) => card.props.plugin.name === 'off-tool')
  const on = cards.find((card) => card.props.plugin.name === 'on-tool')

  // The class is asserted through the exported rule, NOT through the tree:
  // `h(PluginCard, …)` is a component descriptor, so `className` only exists
  // after React invokes the component, which this stub never does. Looking for
  // `pm-card-off` in the tree found nothing and reported a styling bug that was
  // not there — the same trap as `pm-card` in `findCards`.
  const cardClassOf = renderPanel.__cardClassOf
  const stateKeyOf = renderPanel.__stateKeyOf
  assert.notEqual(cardClassOf, undefined, 'the card-class rule must be reachable for this assertion')
  assert.notEqual(stateKeyOf, undefined, 'the state-key rule must be reachable for this assertion')

  assert.match(cardClassOf(off.props.plugin), /pm-card-off/, 'a disabled card must be visually set apart')
  assert.doesNotMatch(cardClassOf(on.props.plugin), /pm-card-off/, 'a running card must not be dimmed')
  assert.equal(stateKeyOf(off.props.plugin), 'stateDisabled', 'the disabled state must be labelled')
  assert.equal(stateKeyOf(on.props.plugin), 'stateRunning', 'the running state must be labelled')

  // Which layer disabled a plugin moved INTO the fold when the card went to one
  // row. Moved, not dropped — and that claim is asserted by the dedicated
  // "disabled layer is folded" case below, which invokes the card. Here the point
  // is only that the state itself is labelled correctly.
  assert.equal(stateKeyOf(off.props.plugin), 'stateDisabled')
})

/**
 * The card's visible row budget.
 *
 * This is the assertion that was missing while the card was rebuilt three times.
 * "Too thick" came back as feedback twice, and neither time could a test have
 * caught it: font sizes were asserted, colours were asserted, and the number of
 * VISIBLE ROWS — which is what "too thick" actually means — was not.
 *
 * A collapsed `<details>` does not count: its content is not on screen, which is
 * the whole reason the diagnostics live there.
 *
 * @param {object} card - one PluginCard descriptor.
 * @returns {string[]} the classNames of its visible rows.
 */
function visibleRowsOf(card) {
  const rows = []
  for (const child of card.children ?? []) {
    if (child === null || child === undefined || typeof child !== 'object') continue
    const className = child.props && child.props.className
    if (typeof className !== 'string') continue
    if (className.startsWith('pm-disclosure')) continue
    rows.push(className)
  }
  return rows
}

test('panel: a plugin card renders exactly ONE row of visible content', async () => {
  // Verified to fail by adding a chips row back — which is the change that made
  // the card thick in the first place.
  await renderPanel(withPlugins([pluginRow({ name: 'one-row' })]), { renders: 1 })
  const PluginCard = renderPanel.__PluginCard
  assert.notEqual(PluginCard, undefined, 'the card component must be reachable for this assertion')

  // The card is INVOKED here: the row count only exists after React would have
  // called it, which is the same reason `cardClassOf` is exposed.
  const card = PluginCard({ plugin: pluginRow({ name: 'one-row' }), t: (key) => `T:${key}` })

  const rows = visibleRowsOf(card)
  assert.equal(
    rows.length,
    1,
    `a card shows one row, found ${rows.length} (${rows.join(' + ')}) — the extra level belongs in the disclosure`,
  )
  assert.equal(rows[0], 'pm-row')

  // And the fold is still there, so "one row" was achieved by MOVING the
  // diagnostics rather than by deleting them.
  const folded = (card.children ?? []).filter((child) => {
    if (child === null || child === undefined || typeof child !== 'object') return false
    return String(child.props === undefined ? '' : child.props.className).startsWith('pm-disclosure')
  })
  assert.equal(folded.length, 1, 'the diagnostics must still exist, folded')
})

test('panel: the switch and its state label share the row, switch first', async () => {
  // The layout contract the list's tidiness rests on: the control and its state
  // are pinned to the right of the SAME row, in that order. When the state sat
  // right after the name it moved with the name's length, and the column of
  // controls looked ragged down the list.
  await renderPanel(withPlugins([pluginRow({ name: 'lead-tool' })]), { renders: 1 })
  const card = renderPanel.__PluginCard({ plugin: pluginRow({ name: 'lead-tool' }), t: (key) => `T:${key}` })

  const row = findByClass(card, 'pm-row')[0]
  assert.notEqual(row, undefined, 'the row must exist')

  const rowClasses = (row.children ?? [])
    .filter((child) => child !== null && child !== undefined && typeof child === 'object')
    .map((child) => String(child.props === undefined ? '' : child.props.className))

  assert.deepEqual(
    rowClasses,
    ['pm-lead', 'pm-switch pm-switch-on', 'pm-state pm-state-on'],
    'the row is identity, then the switch, then its state — no extra child to push anything around',
  )
  assert.ok(findByClass(row, 'pm-name').length > 0, 'the name belongs to the identity column')

  // The direct-children check above cannot see a NESTED duplicate, and the first
  // version of this test passed a change that put the status back beside the name
  // — the exact regression it exists to catch. So the status is also asserted to
  // be OUTSIDE the identity column, by structure rather than by count.
  const lead = findByClass(row, 'pm-lead')[0]
  assert.equal(
    findByClass(lead, 'pm-state').length,
    0,
    'the status must not sit inside the identity column — that is what made its position move with the name',
  )
  assert.equal(
    findByClass(lead, 'pm-switch').length,
    0,
    'the switch must not sit inside the identity column either',
  )
})

test('panel: the switch reports its state to assistive tech', async () => {
  // A switch has to be a switch, not a styled div: role plus aria-checked is what
  // makes "on" audible rather than merely visible.
  await renderPanel(withPlugins([pluginRow({})]), { renders: 1 })
  const PluginCard = renderPanel.__PluginCard
  const t = (key) => `T:${key}`

  const on = findByClass(PluginCard({ plugin: pluginRow({ enabled: true, enabledState: 'running' }), t }), 'pm-switch')[0]
  assert.equal(on.props.role, 'switch')
  assert.equal(on.props['aria-checked'], 'true')
  assert.match(String(on.props['aria-label']), /T:stateRunning/)

  const off = findByClass(
    PluginCard({ plugin: pluginRow({ name: 'off', enabled: false, enabledState: 'disabled', loaded: false }), t }),
    'pm-switch',
  )[0]
  assert.equal(off.props['aria-checked'], 'false')
  assert.equal(off.props.className.includes('pm-switch-on'), false, 'a disabled plugin must not render an on switch')
})

test('panel: EVERY plugin shows its package.json version, from any source', async () => {
  // Locked in after getting it wrong. I made the version source-dependent — a
  // commit for a local checkout, a version for a registry install — on the theory
  // that a checkout's version field must be stale. Measured: `dsh-power` declares
  // 1.8.0 and `dsh-tavern` declares 2.6.72, and neither repo carries a single git
  // tag, so both are maintained by hand. One signal everywhere, in the format a
  // reader already knows.
  await renderPanel(withPlugins([pluginRow({})]), { renders: 1 })
  const PluginCard = renderPanel.__PluginCard
  const t = (key) => `T:${key}`

  const cases = [
    { name: 'registry-tool', version: '5.10.3', sourceType: 'registry' },
    { name: 'link-tool', version: '1.8.0', sourceType: 'link', spec: 'link:/checkout/link-tool' },
  ]

  for (const over of cases) {
    const card = PluginCard({ plugin: pluginRow(over), t })
    const chips = findByClass(card, 'pm-ver')
    assert.equal(chips.length, 1, `${over.name} must show exactly one version chip`)
    assert.equal(chips[0].children[0], `v${over.version}`, `${over.name} must show its package.json version`)
    // The commit must never occupy the version slot, whatever the host reports.
    assert.equal(
      findByClass(card, 'pm-ver-rev').length,
      0,
      'a commit must never be rendered as the version',
    )
  }
})

test('panel: the disabled layer is folded, not deleted', async () => {
  // Which layer disabled a plugin moved INTO the fold when the card went to one
  // row. Moved, not dropped: the state chip says THAT it is off, and the layer is
  // one keypress away. Asserted by invoking the card, because a collapsed
  // `<details>`'s contents are not in the outer descriptor tree.
  await renderPanel(withPlugins([pluginRow({})]), { renders: 1 })
  const plugin = pluginRow({
    name: 'off-tool',
    loaded: false,
    enabled: false,
    enabledState: 'disabled',
    disabledBy: 'user patch (cordis.patch.yml)',
  })
  const card = renderPanel.__PluginCard({ plugin, t: (key) => `T:${key}` })
  const fold = findByClass(card, 'pm-disclosure')[0]

  assert.notEqual(fold, undefined, 'the folded diagnostics must exist')
  assert.ok(
    JSON.stringify(fold).includes('cordis.patch.yml'),
    'the disabling layer must still be reachable, just folded',
  )
})

test('panel: an enabled-but-absent plugin reads as a fault, not as disabled', async () => {
  // The distinction the whole enabled feature exists for: `enabled: true` with
  // `loaded: false` means it SHOULD be running. Reporting that as "disabled"
  // would tell the user they turned off something they never touched.
  const payload = withPlugins([pluginRow({ name: 'broken-tool', loaded: false, enabled: true, enabledState: 'not-loaded' })])

  const tree = await renderPanel(payload, { renders: 1 })
  const stateKeyOf = renderPanel.__stateKeyOf
  const broken = findCards(tree)[0].props.plugin

  assert.equal(stateKeyOf(broken), 'stateNotRunning', 'the fault state must be labelled')
  assert.notEqual(stateKeyOf(broken), 'stateDisabled', 'an enabled plugin must never be labelled disabled')
  // The card is set apart either way — a fault needs attention just as much as a
  // deliberate disable — but the LABEL must not claim the user did it.
  assert.match(renderPanel.__cardClassOf(broken), /pm-card-off/)
})

/**
 * Walk the descriptor tree collecting nodes whose className contains `token`.
 * Function components are descriptors, not calls, so this sees the cards the
 * panel ASKED for — which is exactly the filtered set.
 * @param {object} node - a descriptor, array, or child value.
 * @param {string} token - substring to match in `props.className`.
 * @param {object[]} found - accumulator.
 * @returns {object[]} the matches.
 */
function findByClass(node, token, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findByClass(child, token, found)
    return found
  }
  const className = node.props && node.props.className
  if (typeof className === 'string' && className.includes(token)) found.push(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) findByClass(child, token, found)
  }
  return found
}

/**
 * The plugin-card descriptors the panel asked React to render.
 *
 * The walker targets `pm-list`, NOT `pm-card`: `h(PluginCard, …)` is a
 * component descriptor, so the card's className only appears one level down,
 * after React invokes the component — which this stub deliberately never does.
 * The first version looked for `pm-card` and found zero cards in a tree that
 * plainly had a populated list.
 *
 * It also has to FLATTEN. The stub's `createElement` collects varargs, so a
 * single `h('div', props, array)` leaves one array element in `children`; the
 * first version filtered that array through untouched and reported "1 card"
 * for a two-card list.
 *
 * @param {object} tree - the rendered descriptor tree.
 * @returns {object[]} the card descriptors, in render order.
 */
function findCards(tree) {
  const list = findByClass(tree, 'pm-list')[0]
  if (list === undefined || !Array.isArray(list.children)) return []
  return list.children.flat(Infinity).filter((child) => child !== null && child !== undefined)
}

/**
 * Find the empty-state descriptor.
 *
 * `h(Empty, …)` is a COMPONENT descriptor, so `pm-empty` — the class name it
 * will produce — is not on the tree the stub sees. Matching on the `action`
 * prop instead finds it at the level it actually exists. This is the same trap
 * as `findCards`: assert against what the panel ASKED for, not what React would
 * later build.
 *
 * @param {object} tree - the rendered descriptor tree.
 * @returns {object|undefined} the empty-state descriptor.
 */
function findEmpty(tree) {
  const matches = findByProp(tree, 'action')
  return matches[0] === undefined ? undefined : matches[0]
}

/**
 * Walk the descriptor tree collecting nodes whose `props` own a given key.
 * @param {object} node - a descriptor, array, or child value.
 * @param {string} key - the prop name to look for.
 * @param {object[]} found - accumulator.
 * @returns {object[]} the matches.
 */
function findByProp(node, key, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findByProp(child, key, found)
    return found
  }
  if (node.props !== null && typeof node.props === 'object' && Object.prototype.hasOwnProperty.call(node.props, key)) {
    found.push(node)
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) findByProp(child, key, found)
  }
  return found
}

/**
 * The search box must actually filter. It rendered, it held state, and it
 * changed nothing: `shown` was computed and then never used, so the input was
 * decorative and every query showed the full list.
 *
 * This test fails if the filter is removed — verified by reverting `shown` to
 * `plugins` and watching this case go red (docs/host-notes.md F22).
 */
test('panel: the search box filters the rendered cards', async () => {
  const base = {
    ...overview(),
    backend: backend(),
    // `available: true` is load-bearing. Without it the panel renders the
    // "inventory unavailable" branch and there are no cards to filter at all —
    // the first version of this test omitted it and reported a search failure
    // that was really a missing list.
    pluginInventory: { ...overview().pluginInventory, available: true, reason: null, installed: 2, loaded: 2 },
  }
  base.thirdParty = [
    { name: 'alpha-tool', spec: '1.0.0', version: '1.0.0', sourceType: 'registry', changeSignal: 'integrity', declaresBundle: true, loaded: true, self: false },
    { name: 'beta-tool', spec: 'link:/checkout/beta-tool', version: '2.0.0', sourceType: 'link', changeSignal: 'resolvedDir', declaresBundle: true, loaded: true, self: true },
  ]

  // No query: both cards.
  const all = await renderPanel(base, { renders: 1 })
  assert.equal(findCards(all).length, 2, 'both plugins must render before filtering')

  // Query "beta": one card, and it is the right one — asserted through the
  // card's own props so a count-only check cannot pass by accident.
  const hit = await renderPanel(base, { renders: 1, query: 'beta' })
  const cards = findCards(hit)
  assert.equal(cards.length, 1, 'the query must narrow the list to one card')
  assert.equal(cards[0].props.plugin.name, 'beta-tool', 'the surviving card must be the match')

  // A query matching nothing must reach the empty state, not an empty list.
  // The empty state is a COMPONENT descriptor (`h(Empty, …)`), so this looks
  // for the props it was handed, not for the class name it will eventually
  // produce — the same trap that made `findCards` look for `pm-card`.
  const miss = await renderPanel(base, { renders: 1, query: 'zzz' })
  assert.equal(findCards(miss).length, 0, 'no card may survive a non-matching query')
  const empty = findEmpty(miss)
  assert.ok(empty !== undefined, 'a miss must render the empty state')
  assert.equal(empty.props.title, 'T:emptySearchTitle', 'the empty state must use the search-specific copy')
  assert.ok(empty.props.action !== null && empty.props.action !== undefined, 'the empty state must offer a way back')
})







