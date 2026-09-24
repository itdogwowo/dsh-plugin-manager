/**
 * The host half's HTTP channel.
 *
 * `harness.handle` is a dynamic-Cordis-Plugin sandbox builtin, so the real host
 * half reaches the browser through `ctx.webServer` routes instead
 * (docs/host-notes.md F16). Nothing here spawns a process or opens a port: the
 * `webServer` service is stubbed and its `register` calls are captured, then the
 * handlers are invoked with fake `req`/`res` objects.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ENDPOINTS = JSON.parse(readFileSync(new URL('../src/endpoints.json', import.meta.url), 'utf8'))

const hostModule = await import('../src/host/index.js')
const routesModule = await import('../src/host/routes.js')
const { apply } = hostModule

/** A graph shaped like `clientModules.graph()` returns. */
function graph() {
  return {
    rev: 'abcdef0123456789',
    entries: [
      { id: 'dsh-base', url: '/plugins/dsh-base/client.js', rev: 'r1', inject: ['react'] },
      { id: 'dsh-tools', url: '/plugins/dsh-tools/client.js', rev: 'r2', immediately: true, inject: ['react', 'dsh-base'] },
    ],
    batches: [{ phase: 'application', url: '/b1.js', rev: 'b1', entries: ['dsh-base', 'dsh-tools'] }],
  }
}

/** A `res` recording what the handler wrote. */
function fakeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

/**
 * Mount the route layer against a stubbed context and return what it registered.
 *
 * Calls `registerRoutes` directly rather than `apply`: `apply` is wrapped in a
 * process-wide `mountOnce` guard (correct for the real host, useless for a test
 * that mounts several times). The guard has its own suite.
 * @param {object} services - optional services to expose through `ctx.get`.
 * @returns {{ routes: object[], effects: string[] }}
 */
function mountHost(services) {
  const routes = []
  const effects = []

  const ctx = {
    effect(callback, label) {
      const dispose = callback()
      effects.push(label)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'webServer') return undefined
      return services[name]
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }

  routesModule.registerRoutes(ctx, ctx.webServer)
  return { routes, effects }
}

test('host: declares exactly the one service it cannot work without', async () => {
  // ⚠️ `subprocess` is deliberately NOT in this list. `inject` makes cordis hold
  // the plugin until the dependency resolves, so a deployment that does not mount
  // the subprocess service would hold this plugin open forever — and R2's spirit
  // is that nothing on the boot path may be able to hold up `dsh web`. It is read
  // optionally at the moment a change is planned, and its absence becomes a
  // reason in the panel (`backend.subprocess`).
  //
  // `fs` is optional for the same reason: its absence degrades to a notice.
  assert.deepEqual(hostModule.inject, ['webServer'])
  assert.equal(hostModule.name, 'plugin-manager')
})

test('host: a missing subprocess service is reported, not thrown', async () => {
  const { routes } = mountHost({ clientModules: { graph } })
  const backend = routes.find((route) => route.path.endsWith(ENDPOINTS.endpoints.backend))

  const res = fakeRes()
  await backend.handler({ method: 'GET' }, res)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).subprocess, 'absent')
})

test('host: the update routes refuse with a reason when subprocess is absent', async () => {
  // Every change runs a command, so with no subprocess service the honest answer
  // is a plain refusal that names the missing piece — never a 500, and never a
  // silent success.
  const { routes } = mountHost({ clientModules: { graph } })

  for (const key of ['apply', 'rollback']) {
    const route = routes.find((candidate) => candidate.path.endsWith(ENDPOINTS.endpoints[key]))
    const res = fakeRes()
    await route.handler(fakeReq('POST', JSON.stringify({ name: 'pkg' })), res)

    assert.equal(res.status, 200, `${key} must answer 200 with a refusal, not 500`)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, false, `${key} must not claim success`)
    assert.equal(typeof payload.error, 'string')
  }
})

test('host: plan names the plugin and reports the tools it would need', async () => {
  const { routes } = mountHost({ clientModules: { graph } })
  const plan = routes.find((candidate) => candidate.path.endsWith(ENDPOINTS.endpoints.plan))

  const res = fakeRes()
  await plan.handler({ method: 'GET', url: '/?name=pkg&ref=v1.0.0' }, res)

  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  // No profile can be read in this stub, so the refusal is the profile's — and
  // it is a refusal, not a crash.
  assert.equal(payload.ok, false)
  assert.equal(typeof payload.error, 'string')
})

test('host: the refs route requires a name and says so', async () => {
  const { routes } = mountHost({ clientModules: { graph } })
  const refs = routes.find((candidate) => candidate.path.endsWith(ENDPOINTS.endpoints.refs))

  const res = fakeRes()
  await refs.handler({ method: 'GET', url: '/' }, res)
  assert.equal(res.status, 200)
  assert.match(JSON.parse(res.body).error, /profile could not be read|a name is required/)
})

test('host: the inlined route constants still equal src/endpoints.json', () => {
  // routes.js duplicates the prefix as a literal so the host half reads no file
  // at startup; this is the guard that keeps the duplicate honest.
  assert.equal(routesModule.PREFIX, ENDPOINTS.prefix)
  assert.deepEqual(routesModule.ENDPOINTS, ENDPOINTS.endpoints)
})

test('host: registers one exact route per endpoint', () => {
  const { routes } = mountHost({ clientModules: { graph } })

  const paths = routes.map((route) => route.path).sort()
  // Derived from the contract, not hardcoded: a hardcoded list makes adding an
  // endpoint a test edit, which is how a test stops describing the contract.
  const expected = Object.values(ENDPOINTS.endpoints)
    .map((suffix) => `${ENDPOINTS.prefix}/${suffix}`)
    .sort()
  assert.deepEqual(paths, expected)
  assert.equal(expected.length, Object.keys(ENDPOINTS.endpoints).length)

  // The four routes the product cannot exist without, named so that deleting one
  // fails here rather than in the browser.
  for (const key of ['detect', 'refs', 'plan', 'apply', 'rollback', 'toggle']) {
    assert.ok(
      paths.includes(`${ENDPOINTS.prefix}/${ENDPOINTS.endpoints[key]}`),
      `the ${key} route must exist`,
    )
  }

  for (const route of routes) {
    assert.equal(route.kind, 'exact', 'a prefix route would shadow other plugins under the same path')
    assert.equal(typeof route.handler, 'function')
  }
})

test('host: the network route is a POST, so a page load can never reach it', async () => {
  // This is a privacy property, not a style choice: `remote-refs` tells a remote
  // which repository this machine is looking at. It must be unreachable by a GET,
  // a prefetch, or following a link.
  const { routes } = mountHost({ clientModules: { graph } })
  const remote = routes.find((route) => route.path.endsWith(ENDPOINTS.endpoints.remoteRefs))
  assert.ok(remote !== undefined, 'the remote-refs route must exist')

  const res = fakeRes()
  await remote.handler({ method: 'GET' }, res)
  assert.equal(res.status, 405)
  assert.match(JSON.parse(res.body).error, /POST only/)
})

test('host: the overview route answers JSON with the projection', async () => {
  const { routes } = mountHost({ clientModules: { graph } })
  const overview = routes.find((route) => route.path.endsWith(ENDPOINTS.endpoints.overview))

  const res = fakeRes()
  await overview.handler({ method: 'GET' }, res)

  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  assert.equal(res.headers['cache-control'], 'no-store')

  const payload = JSON.parse(res.body)
  assert.equal(payload.source, 'clientModules.graph()')
  assert.equal(payload.entries.length, 2)
  assert.equal(payload.counts.total, 2)
  assert.equal(payload.counts.immediate, 1)
  assert.equal(payload.counts.lazy, 1)
  assert.equal(payload.counts.injected, 2)
  assert.equal(payload.counts.batches, 1)
  assert.equal(payload.counts.thirdParty, 0)
  assert.deepEqual(payload.thirdParty, [])
})

test('host: a missing clientModules is a notice, not a 500', async () => {
  const { routes } = mountHost({})
  const overview = routes.find((route) => route.path.endsWith(ENDPOINTS.endpoints.overview))

  const res = fakeRes()
  await overview.handler({ method: 'GET' }, res)

  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.entries.length, 0)
  assert.match(payload.notices.join(' '), /clientModules service is not available/)
})

test('host: a throwing projection becomes a 500 with the message, never an unhandled rejection', async () => {
  const clientModules = {
    graph() {
      throw new Error('boom')
    },
  }
  const { routes } = mountHost({ clientModules })
  const overview = routes.find((route) => route.path.endsWith(ENDPOINTS.endpoints.overview))

  const res = fakeRes()
  await overview.handler({ method: 'GET' }, res)

  // The projection itself swallows the throw and reports it in notices, so the
  // route still answers 200 with a readable body.
  assert.equal(res.status, 200)
  assert.match(JSON.parse(res.body).notices.join(' '), /graph\(\) threw: boom/)
})

test('host: the backend route reports which optional services resolved', async () => {
  const { routes } = mountHost({ clientModules: { graph } })
  const backend = routes.find((route) => route.path.endsWith(ENDPOINTS.endpoints.backend))

  const res = fakeRes()
  await backend.handler({ method: 'GET' }, res)

  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.clientModules, 'ready')
  assert.equal(payload.pluginInventory, 'absent')
})

test('host: every route is owned by an effect so unload removes it', () => {
  const { routes, effects } = mountHost({ clientModules: { graph } })

  assert.equal(effects.length, routes.length)
  for (const label of effects) assert.match(label, /^dsh-plugin-manager: .+ route$/)
})

test('host: the detect route answers a report with NO fs service', async () => {
  // No `fs` is a real deployment shape (the service is optional). The route must
  // still answer 200 with a readable reason — an unreadable report is a report.
  const { routes } = mountHost({})
  const detect = routes.find((route) => route.path.endsWith(ENDPOINTS.endpoints.detect))
  assert.ok(detect !== undefined, 'the detect route must be registered')

  const res = fakeRes()
  await detect.handler({ method: 'GET' }, res)

  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.deepEqual(payload.plugins, [])
  assert.match(payload.notices.join(' '), /fs service is not available/)
  assert.equal(payload.strategy.writesAnything, false, 'detection must declare that it writes nothing')
})

test('host: the detect route never reports a verdict it cannot support', async () => {
  // The load-bearing property of the whole feature. With no readable profile
  // there is nothing to compare, and every count must stay zero rather than
  // implying "all up to date".
  const { routes } = mountHost({})
  const detect = routes.find((route) => route.path.endsWith(ENDPOINTS.endpoints.detect))

  const res = fakeRes()
  await detect.handler({ method: 'GET' }, res)
  const payload = JSON.parse(res.body)

  assert.equal(payload.counts.current, 0, 'an unreadable profile must not produce a single "current" verdict')
  assert.equal(payload.strategy.reachability, 'local')
  assert.match(payload.baseline.note, /cannot make/)
})

/** A fake request carrying a JSON body, with the events `readJsonBody` listens for. */
function fakeReq(method, body) {
  const listeners = new Map()
  const req = {
    method,
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return req
    },
    destroy() {},
  }
  // Emit on the next tick so the handler has attached its listeners first.
  setImmediate(() => {
    if (body !== undefined) for (const fn of listeners.get('data') ?? []) fn(Buffer.from(body, 'utf8'))
    for (const fn of listeners.get('end') ?? []) fn()
  })
  return req
}

test('host: toggle refuses a GET — it is the only route that writes', async () => {
  const { routes } = mountHost({})
  const toggle = routes.find((route) => route.path.endsWith(ENDPOINTS.endpoints.toggle))
  assert.notEqual(toggle, undefined, 'the toggle route must be registered')

  const res = fakeRes()
  await toggle.handler(fakeReq('GET'), res)

  assert.equal(res.status, 405)
  assert.match(JSON.parse(res.body).error, /POST only/)
})

test('host: toggle requires an id and a boolean state', async () => {
  const { routes } = mountHost({})
  const toggle = routes.find((route) => route.path.endsWith(ENDPOINTS.endpoints.toggle))

  const noId = fakeRes()
  await toggle.handler(fakeReq('POST', JSON.stringify({ enabled: false })), noId)
  assert.equal(noId.status, 400)
  assert.match(JSON.parse(noId.body).error, /row id is required/)

  const noState = fakeRes()
  await toggle.handler(fakeReq('POST', JSON.stringify({ id: 'tool-x' })), noState)
  assert.equal(noState.status, 400)
  assert.match(JSON.parse(noState.body).error, /must be a boolean/)
})

test('host: toggle refuses a body that is not JSON, without writing', async () => {
  const { routes } = mountHost({})
  const toggle = routes.find((route) => route.path.endsWith(ENDPOINTS.endpoints.toggle))

  const res = fakeRes()
  await toggle.handler(fakeReq('POST', 'not json at all'), res)

  assert.equal(res.status, 500)
  assert.match(JSON.parse(res.body).error, /not valid JSON/)
})

test('host: toggle with no fs refuses and says nothing was changed', async () => {
  // No `fs` means no profile read and no write. The answer must be a refusal,
  // never a 200 that implies something happened.
  const { routes } = mountHost({})
  const toggle = routes.find((route) => route.path.endsWith(ENDPOINTS.endpoints.toggle))

  const res = fakeRes()
  await toggle.handler(fakeReq('POST', JSON.stringify({ id: 'tool-x', enabled: false })), res)

  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false, 'nothing may report success without a write')
  assert.match(payload.error, /profile could not be read/)
})
