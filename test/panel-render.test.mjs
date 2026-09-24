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
      // This stub ignores the dependency array, so an effect that must NOT repeat
      // on an unchanged render has to say so itself — the panel's open-fetch does
      // exactly that, and the case below asserts it.
      if (hooks[index] === undefined) {
        hooks[index] = true
        const cleanup = effect()
        return typeof cleanup === 'function' ? cleanup : undefined
      }
      return undefined
    },
    /**
     * A ref hook, kept only because the stub must not lie about the API it
     * stands in for: an effect that guards itself with a ref would otherwise
     * behave differently here than in the browser.
     */
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    /** Let a test drive a re-render after a `setState` lands. */
    __onRerender(fn) {
      rerender = fn
    },
    /** Reset the hook cursor before each `Panel` invocation. */
    __begin() {
      cursor = 0
    },
    /** Read or set the hook cursor, for a test that renders two components. */
    __cursor(next) {
      if (typeof next === 'number') cursor = next
      return cursor
    },
    /**
     * Pre-seed hook slots so a test can mount the panel already holding a value
     * (the search query). Slot order is the component's call order: tick, query,
     * state, effect.
     * @param {object[]} values - slot values, in call order.
     * @param {number} [from] - first slot index; the card's own hooks start after
     *   the panel's, so a card mounted by hand seeds at a cursor, not at 0.
     */
    __seed(values, from = 0) {
      for (let i = 0; i < values.length; i += 1) hooks[from + i] = values[i]
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
  renderPanel.__update = entry.component.__update
  // The stub itself, so a test can drive a card's own hooks (see the update
  // trigger case): a card's state is not reachable from the tree it returns.
  renderPanel.__react = react
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

/**
 * Props for invoking `PluginCard` directly.
 *
 * `face: null` is not a convenience — it is the state the card is in whenever the
 * host channel is absent, and it is the ONLY face this file may use: the render
 * test makes no HTTP request, and a card holding a face would ask for refs.
 *
 * @param {object} plugin - the inventory row to render.
 * @returns {object} props for one `PluginCard` call.
 */
function cardProps(plugin) {
  return { plugin, t: (key) => `T:${key}`, face: null }
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
 * The card's visible line budget.
 *
 * This is the assertion that was missing while the card was rebuilt three times.
 * "Too thick" came back as feedback THREE times, and none of the first two could
 * a test have caught: font sizes were asserted, colours were asserted, and the
 * number of VISIBLE LINES — which is what "too thick" actually means — was not.
 *
 * The count is over the CARD's rows and the grid's own rows, because the card is
 * a flex column (the grid, then the update panel) and the grid is what declares
 * the two lines that are always on screen. A third grid row is exactly how the
 * card got thick the two times it did.
 *
 * @param {object} card - one PluginCard descriptor.
 * @returns {string[]} the classNames of its visible lines, top to bottom.
 */
function visibleRowsOf(card) {
  const lines = []
  for (const child of card.children ?? []) {
    if (child === null || child === undefined || typeof child !== 'object') continue
    const className = child.props && child.props.className
    if (typeof className !== 'string') continue
    lines.push(className)
    if (className.startsWith('pm-card-grid')) {
      for (const inner of child.children ?? []) {
        if (inner === null || inner === undefined || typeof inner !== 'object') continue
        lines.push(String(inner.props.className))
      }
    }
  }
  return lines
}

test('panel: a plugin card renders TWO lines — the header grid and the fold', async () => {
  // Verified to fail twice for real: first when the update trigger got a row of
  // its own below the fold, then when it sat under the switch and made the
  // control CLUSTER two lines. Both times the card grew to three.
  await renderPanel(withPlugins([pluginRow({ name: 'one-row' })]), { renders: 1 })
  const PluginCard = renderPanel.__PluginCard
  assert.notEqual(PluginCard, undefined, 'the card component must be reachable for this assertion')

  // The card is INVOKED here: the line count only exists after React would have
  // called it, which is the same reason `cardClassOf` is exposed.
  const card = PluginCard(cardProps(pluginRow({ name: 'one-row' })))

  const lines = visibleRowsOf(card)
  assert.deepEqual(
    lines,
    ['pm-card-grid', 'pm-lead', 'pm-card-actions', 'pm-disclosure'],
    `the card is one grid holding two lines — found ${lines.join(' + ')}`,
  )

  // The trigger is on the FOLD's line, which is the whole point: if it were a
  // third child of the grid, the grid would be three rows tall. The fold's own
  // diagnostics stay inside the collapsed `<details>`, where they cost nothing.
  const summaries = findByClass(card, 'pm-fold').filter((node) => String(node.props.className).split(' ').includes('pm-fold'))
  assert.equal(
    summaries.length,
    1,
    `the fold summary is the card’s second line, found ${summaries.map((n) => n.props.className).join(' + ')}`,
  )
  // `Meta` is a COMPONENT descriptor whose rows are props, not children, so the
  // walk cannot see the `<dl>` it renders (F23 again) — the diagnostics are
  // asserted by the component being asked for inside the fold.
  assert.equal(findByClass(card, 'pm-fold').length >= 1, true, 'the fold summary is on the card')
  const grid = findByClass(card, 'pm-card-grid')[0]
  assert.ok(
    findByClass(grid, 'Meta').length >= 1,
    'the diagnostics are still asked for inside the fold, folded',
  )

  // And the fold is still a disclosure, so "two lines" was achieved by MOVING
  // the diagnostics into it rather than by deleting them. It is the grid's own
  // last row, which is what makes it the card's second line.
  const folded = (grid.children ?? []).filter((child) => {
    if (child === null || child === undefined || typeof child !== 'object') return false
    return String(child.props === undefined ? '' : child.props.className).startsWith('pm-disclosure')
  })
  assert.equal(folded.length, 1, 'the fold is the grid’s last row, which is the card’s second line')
})

test('panel: the switch and its state label share the first line, switch first', async () => {
  // The layout contract the list's tidiness rests on: the control and its state
  // are pinned to the right of the SAME row, in that order. When the state sat
  // right after the name it moved with the name's length, and the column of
  // controls looked ragged down the list.
  await renderPanel(withPlugins([pluginRow({ name: 'lead-tool' })]), { renders: 1 })
  const card = renderPanel.__PluginCard(cardProps(pluginRow({ name: 'lead-tool' })))

  const cluster = findByClass(card, 'pm-card-actions')[0]
  assert.notEqual(cluster, undefined, 'the control cluster must exist')
  assert.deepEqual(
    (cluster.children ?? []).filter((child) => child !== null && child !== undefined).map((child) => String(child.props.className)),
    ['pm-switch pm-switch-on', 'pm-state pm-state-on'],
    'the cluster is the switch and its state, in that order — and nothing else',
  )
  assert.equal(cluster.props.className, 'pm-card-actions', 'the cluster has no open/closed variant to change its height')

  // The direct-children check above cannot see a NESTED duplicate, and the first
  // version of this test passed a change that put the status back beside the name
  // — the exact regression it exists to catch. So the status is also asserted to
  // be OUTSIDE the identity column, by structure rather than by count.
  const lead = findByClass(card, 'pm-lead')[0]
  assert.ok(findByClass(lead, 'pm-name').length > 0, 'the name belongs to the identity column')
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

test('panel: the update trigger shares the fold line, and goes away once open', async () => {
  // Three shapes were tried and two were rejected by measurement: a full-width
  // row below the fold (three lines), and a second line under the switch (three
  // lines again, because the control cluster grew). The trigger now shares the
  // fold summary's line, which already existed — so it costs no height at all.
  await renderPanel(withPlugins([pluginRow({ name: 'upd-tool' })]), { renders: 1 })
  const PluginCard = renderPanel.__PluginCard
  const upd = renderPanel.__update
  assert.notEqual(upd, undefined, 'the update units must be reachable for these assertions')

  const card = PluginCard(cardProps(pluginRow({ name: 'upd-tool' })))
  const summary = findByClass(card, 'pm-fold')[0]
  assert.notEqual(summary, undefined, 'the fold summary must exist')
  assert.equal(String(summary.type), 'summary', 'the trigger rides on the disclosure’s own summary element')

  const kinds = (summary.children ?? []).filter((child) => child !== null && child !== undefined).map((child) => {
    // A component child is a DESCRIPTOR here, exactly like the cards the panel
    // asks for: `className` only exists once React invokes it. Asserting on
    // descriptors instead is how a test reports a bug that is not there (F23).
    if (child.type === upd.UpdateTrigger) return 'trigger'
    return String(child.props.className).split(' ')[0]
  })
  assert.deepEqual(
    kinds,
    ['pm-fold-name', 'trigger'],
    'the summary is the fold’s name, then the update trigger on the same line',
  )

  // The trigger is the only thing on this line that is not always drawn, so its
  // own render is checked by invoking it: the card asks for it, the tree does not
  // show what it contains. Its label is a CHILD of the descriptor, which is what
  // the card's own `t` produced.
  const trigger = summary.children[1]
  assert.equal(trigger.type, upd.UpdateTrigger, 'the second child of the summary is the update trigger')
  assert.equal(String((trigger.children ?? [])[0]).trim(), 'T:updateCheck', 'the trigger names what it does')
  const button = upd.UpdateTrigger(trigger.props)
  assert.equal(button.props.className, 'pm-btn pm-btn-sm pm-act-btn', 'the trigger is a small card button')
  assert.equal(button.props.disabled, false, 'a card with no write in flight offers the trigger')
  assert.equal(typeof button.props.onClick, 'function', 'the trigger must be clickable')

  // And the card with the panel OPEN keeps the same two lines with the trigger
  // gone — the other half of the same layout claim. The flag is the card's first
  // hook, and the stub can mount with it already set.
  //
  // The offset is READ from the stub rather than assumed: `renderPanel` has
  // already consumed its own slots for the panel it rendered, and the card's
  // hooks start after them.
  const react = renderPanel.__react
  assert.notEqual(react, undefined, 'the react stub must be reachable to mount an open card')
  // The offset is READ from the stub rather than assumed: `renderPanel` has
  // already consumed its own slots for the panel it rendered, so the card's first
  // hook is slot `cardStart`, and the seed has to land there.
  const cardStart = react.__cursor()
  react.__begin()
  react.__cursor(cardStart)
  react.__seed([true], cardStart) // `updOpen` is the card's FIRST hook
  const openCard = PluginCard(cardProps(pluginRow({ name: 'upd-tool' })))
  const openSummary = findByClass(openCard, 'pm-fold')[0]
  assert.deepEqual(
    (openSummary.children ?? [])
      .filter((child) => child !== null && child !== undefined)
      .map((child) => (child.type === upd.UpdateTrigger ? 'trigger' : String(child.props.className).split(' ')[0])),
    ['pm-fold-name'],
    'the trigger is gone once the panel is open rather than repeated in two places',
  )
  assert.equal(visibleRowsOf(openCard).length, 4, 'and the card is still two lines tall')
})

test('panel: a missing tool comes with a way to install it, on the host’s terms', async () => {
  // The user-facing rule: "this cannot be done" must never be the last word when
  // the machine is the reason. The host reads the platform and sends the exact
  // command plus the page that documents it; the panel renders a link and a copy
  // button. The panel does NOT run anything — a plugin that silently runs a
  // package manager has no consent flow (see src/host/install-hints.mjs).
  await renderPanel(withPlugins([pluginRow({ name: 'link-tool' })]), { renders: 1 })
  const upd = renderPanel.__update
  const t = (key) => `T:${key}`

  const open = {
    open: true,
    refs: { phase: 'ready', data: null },
    remote: { phase: 'idle', data: null, error: null },
    picked: '',
    plan: {
      phase: 'ready',
      error: null,
      data: {
        ok: true,
        kind: 'checkout',
        runnable: false,
        runError: 'git is unavailable',
        noChangeNeeded: false,
        warnings: [],
        tools: { git: { available: false, path: null }, dsh: { available: false, path: null } },
        installHint: {
          tool: 'git',
          platform: 'win32',
          distro: null,
          command: 'winget install --id Git.Git -e --source winget',
          url: 'https://git-scm.com/download/win',
          note: 'winget ships with Windows 10 1809 and later',
        },
      },
    },
    run: { phase: 'idle', data: null, error: null },
    canRemote: false,
    setPicked: () => undefined,
    loadRefs: () => undefined,
    askRemote: () => undefined,
    apply: () => undefined,
    copyText: () => undefined,
  }

  const tree = upd.UpdatePanel({ ...open, t })
  assert.notEqual(tree, null, 'an open panel renders')

  const block = findByClass(tree, 'pm-upd-fix')[0]
  assert.notEqual(block, undefined, 'a missing tool gets its own block, not one more note')

  // The command the user would paste, verbatim.
  assert.ok(
    JSON.stringify(block).includes('winget install --id Git.Git'),
    'the platform’s own command must be on screen, not merely described',
  )

  // A link that opens the page, in a new tab, without handing it this document.
  const link = findByClass(block, 'pm-btn').find((node) => node.type === 'a')
  assert.notEqual(link, undefined, 'the install page must be reachable by a click')
  assert.equal(link.props.href, 'https://git-scm.com/download/win', 'the host decides WHERE, so the platform is the host’s answer')
  assert.equal(link.props.target, '_blank')
  assert.equal(link.props.rel, 'noreferrer noopener')

  // And the boundary is stated: this button does not install anything.
  assert.ok(JSON.stringify(block).includes('T:updateInstallManual'), 'the panel must say it will not install for the user')

  // A plan that CAN run carries no install block at all: a hint there is noise.
  const runnable = upd.UpdatePanel({
    ...open,
    t,
    plan: { phase: 'ready', error: null, data: { ...open.plan.data, runnable: true, tools: { git: { available: true }, dsh: null }, installHint: null } },
  })
  assert.equal(findByClass(runnable, 'pm-upd-fix').length, 0, 'no hint when nothing is missing')
})

test('panel: applying an update calls the host and never throws', async () => {
  // The regression this exists for: `apply` lived in a component and then moved
  // into a hook, and the `props.onChanged()` it carried came along — a live
  // `props is not defined` in the browser. No test caught it, because the panel
  // is only ever RENDERED here, never DRIVEN: the button's handler is a closure
  // that runs when a user presses 更新, and this stub never presses anything.
  //
  // So this case presses it: the handler is called the way React would call it,
  // against a face that answers.
  const { exports, react } = loadBundle()
  let Panel = null
  exports.apply({
    effect: (callback) => {
      callback()
      return () => {}
    },
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => {
        Panel = component
        return () => {}
      },
    },
    locale: { register: () => () => {}, bind: () => (key) => `T:${key}` },
    get: () => undefined,
  })
  assert.notEqual(Panel, null, 'the tab must register')
  const upd = Panel.__update

  const applied = []
  const face = {
    apply: (name, ref) => {
      applied.push({ name, ref })
      return Promise.resolve({ ok: true, steps: [], snapshot: { id: 's1' }, rollback: null })
    },
  }
  const t = (key) => `T:${key}`

  // `window.confirm` is the destructive-action gate; this file has no window, so
  // the handler must also work when it is absent.
  react.__begin()
  const controller = upd.useUpdate(pluginRow({ name: 'upd-tool' }), face, t, true, () => undefined)

  const panel = upd.UpdatePanel({
    ...controller,
    open: true,
    t,
    picked: 'branch:main',
    plan: { phase: 'ready', error: null, data: { ok: true, kind: 'checkout', runnable: true, noChangeNeeded: false, tools: { git: { available: true } } } },
    copyText: () => undefined,
  })
  assert.notEqual(panel, null, 'the panel must render')

  const updateButton = findByClass(panel, 'pm-btn')
    .filter((node) => node.type === 'button')
    .find((node) => JSON.stringify(node.children).includes('T:updateApply'))
  assert.notEqual(updateButton, undefined, 'the 更新 button must exist')
  assert.equal(updateButton.props.disabled, false, 'a runnable plan enables it')

  assert.doesNotThrow(() => updateButton.props.onClick(), 'pressing 更新 must not throw')
  // `picked` is the picker's own state and this hook instance never selected
  // anything, so the ref sent is null — which the host reads as "the ref this
  // checkout is already on" (`picked.slice` in `apply`). What matters here is
  // that the click reached the host at all, with the plugin's own name.
  assert.deepEqual(applied, [{ name: 'upd-tool', ref: null }], 'and it must ask the host to apply, by name')
})

test('panel: a successful update makes the card re-read the list', async () => {
  // The other half of the same contract: after the host moves the checkout the
  // panel must not keep showing its own stale copy. The HOOK reports the outcome
  // and the CARD reloads — so the condition under test is `run.data.ok`, and the
  // card is rendered with that state already in place.
  const { exports, react } = loadBundle()
  let Panel = null
  exports.apply({
    effect: (callback) => {
      callback()
      return () => {}
    },
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => {
        Panel = component
        return () => {}
      },
    },
    locale: { register: () => () => {}, bind: () => (key) => `T:${key}` },
    get: () => undefined,
  })
  assert.notEqual(Panel, null, 'the tab must register')

  // Hook slots in PluginCard's call order: 0 `updOpen`, then the hook's own
  // refs / remote / picked / plan / run, then the reload effect. Only `run`
  // matters to the condition under test.
  const seedRuns = (run) => {
    react.__begin()
    react.__seed([
      true,
      { phase: 'ready', data: null, error: null },
      { phase: 'idle', data: null, error: null },
      '',
      { phase: 'idle', data: null, error: null },
      run,
    ])
  }

  const writes = []
  const onWrite = () => writes.push('reload')

  seedRuns({ phase: 'ready', data: { ok: true }, error: null })
  Panel.__PluginCard({ ...cardProps(pluginRow({ name: 'upd-tool' })), onWrite })
  assert.deepEqual(writes, ['reload'], 'an update that succeeded must make the card re-read the host')

  // A failed one must NOT reload: a rollback has a result to show, and re-reading
  // the list would bury it under a fresh render.
  writes.length = 0
  seedRuns({ phase: 'ready', data: { ok: false, rollback: { ok: true } }, error: null })
  Panel.__PluginCard({ ...cardProps(pluginRow({ name: 'upd-tool' })), onWrite })
  assert.deepEqual(writes, [], 'a refused or rolled-back update must not reload the list')
})

test('panel: pressing the update trigger opens the panel and reads this checkout', async () => {
  // The click is driven through `useUpdate` on a stub of its own. A hook's state
  // lives in the stub's slots, so driving the whole card would mean reasoning
  // about slot offsets for every render; the hook is the unit that owns the click
  // response, and the card's own render of it is asserted above.
  const { exports, react } = loadBundle()
  let Panel = null
  exports.apply({
    effect: (callback) => {
      callback()
      return () => {}
    },
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => {
        Panel = component
        return () => {}
      },
    },
    locale: { register: () => () => {}, bind: () => (key) => `T:${key}` },
    get: () => undefined,
  })
  assert.notEqual(Panel, null, 'the tab must register')
  const upd = Panel.__update

  const calls = []
  const face = {
    refs: (name) => {
      calls.push(name)
      return Promise.resolve({ ok: true, local: { head: { attached: false, commit: 'abcdef0123456789' }, versionTags: [], branches: [] } })
    },
  }
  const t = (key) => `T:${key}`

  // Every render starts from the same cursor, the way one component's renders
  // share one hook list: the stub holds one slot list per instance, so a second
  // call without the reset would read whatever slot it happened to be on.
  let opened = false
  const control = () => {
    react.__begin()
    return upd.useUpdate(pluginRow({ name: 'upd-tool' }), face, t, opened, (next) => (opened = next))
  }
  const closed = control()
  assert.equal(closed.open, false, 'a mounted card starts closed')
  assert.deepEqual(calls, [], 'a closed card must not read refs — the list is scanned far more often than it is updated')
  assert.equal(upd.UpdatePanel({ ...closed, t }), null, 'a closed panel renders nothing')

  closed.openPanel()
  assert.equal(opened, true, 'the trigger opens the panel')
  assert.deepEqual(calls, ['upd-tool'], 'opening reads the refs of the plugin the card belongs to')
  const openedState = control()
  assert.equal(openedState.open, true, 'and the panel renders from that state')
  assert.equal(openedState.refs.phase, 'loading', 'the panel says it is reading rather than showing an empty list')
  assert.notEqual(upd.UpdatePanel({ ...openedState, t }), null, 'an open panel renders')

  // Opening once is not opening twice: a re-render of the open panel must not
  // start another request. The panel's own 載入版本 is the way to ask again, and
  // it calls `loadRefs` directly.
  const again = control()
  assert.deepEqual(calls, ['upd-tool'], 'the open panel does not re-read the refs on every render')
  assert.equal(again.open, true, 'and it stays open')
})

test('panel: the switch reports its state to assistive tech', async () => {
  // A switch has to be a switch, not a styled div: role plus aria-checked is what
  // makes "on" audible rather than merely visible.
  await renderPanel(withPlugins([pluginRow({})]), { renders: 1 })
  const PluginCard = renderPanel.__PluginCard
  const t = (key) => `T:${key}`

  const on = findByClass(PluginCard(cardProps(pluginRow({ enabled: true, enabledState: 'running' }))), 'pm-switch')[0]
  assert.equal(on.props.role, 'switch')
  assert.equal(on.props['aria-checked'], 'true')
  assert.match(String(on.props['aria-label']), /T:stateRunning/)

  const off = findByClass(
    PluginCard(cardProps(pluginRow({ name: 'off', enabled: false, enabledState: 'disabled', loaded: false }))),
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
    const card = PluginCard(cardProps(pluginRow(over)))
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
  const card = renderPanel.__PluginCard(cardProps(plugin))
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
  // A COMPONENT child is a descriptor too, and its own render is never walked
  // (see F23). Its `type` is the only name it has in the tree, so a component can
  // be looked up by the name it was asked for with — which is how a nested
  // component like `Meta` is asserted to still be on the card.
  if (typeof node.type === 'function' && node.type.name === token) found.push(node)
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







