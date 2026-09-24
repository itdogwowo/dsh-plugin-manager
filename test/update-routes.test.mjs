/**
 * The update routes, driven end to end over REAL services.
 *
 * ## Why this file exists
 *
 * The unit tests cover each piece; this one covers the seam between them — the
 * HTTP handlers the panel actually calls, reading a real profile off disk and a
 * real `.git` directory, with a real subprocess service behind the tool probes.
 * That is as close to the live deployment as a test can get without restarting
 * the host, and it is where wiring mistakes live:
 *
 * - the JSON shape the browser half parses;
 * - whether a route probes a tool it does not need (R4 is about work, not only
 *   about requests — a plan for a registry plugin must not spawn `git`);
 * - whether "not probed" stays distinguishable from "not available".
 *
 * The profile is located through `DSH_PROFILE`, which is the documented fallback
 * (`profile.js`), because a test cannot change the host's working directory for
 * the code under test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createRealSubprocess } from './helpers/real-subprocess.mjs'

const routesModule = await import('../src/host/routes.js')
const ENDPOINTS = JSON.parse(readFileSync(new URL('../src/endpoints.json', import.meta.url), 'utf8'))

/** The commit the synthetic checkout sits on. */
const HEAD_SHA = 'a'.repeat(40)

/** Write one file, creating its directory. */
function put(root, relative, content) {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** A fake `res` recording what the handler wrote. */
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

/** A fake `req` carrying a JSON body, with the events `readJsonBody` listens for. */
function fakeReq(method, body, url = '/') {
  const listeners = new Map()
  const req = {
    method,
    url,
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return req
    },
    destroy() {},
  }
  setImmediate(() => {
    if (body !== undefined) for (const fn of listeners.get('data') ?? []) fn(Buffer.from(body, 'utf8'))
    for (const fn of listeners.get('end') ?? []) fn()
  })
  return req
}

/**
 * A throwaway `$DSH_HOME` with one profile containing a `link:` checkout.
 *
 * The checkout is a hand-written `.git` (HEAD, a branch, two tags, an origin
 * remote) because `git` is not on PATH on the reference machine (F26).
 *
 * @param {(ctx: {home: string, profileDir: string, checkout: string}) => Promise<void>} run - the assertions.
 * @returns {Promise<void>} resolves once the tree is removed.
 */
async function withDeployment(run) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pm-dep-'))
  const profileDir = join(home, 'profiles', 'web')
  const checkout = join(home, 'plugins-src', 'dsh-power')
  const previousProfile = process.env.DSH_PROFILE
  const previousHome = process.env.DSH_HOME
  try {
    put(profileDir, 'package.json', `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {
        'dsh-power': `link:${checkout}`,
        'plain-lib': '^1.0.0',
      },
      dsh: { profile: { bundles: ['dsh-power'] } },
    }, null, 2)}\n`)

    put(profileDir, 'node_modules/plain-lib/package.json', JSON.stringify({ name: 'plain-lib', version: '1.0.0', main: 'index.js' }))
    put(profileDir, 'node_modules/plain-lib/index.js', 'export default 1\n')

    // The checkout's own manifest carries `dsh.bundle`, because that is what the
    // host scans when it maintains `dsh.profile.bundles`.
    put(checkout, 'package.json', JSON.stringify({ name: 'dsh-power', version: '0.0.0', dsh: { bundle: { patch: './p.yml' } } }))
    put(checkout, '.git/HEAD', 'ref: refs/heads/main\n')
    put(checkout, '.git/refs/heads/main', `${HEAD_SHA}\n`)
    put(checkout, '.git/refs/tags/v1.9.0', `${'b'.repeat(40)}\n`)
    put(checkout, '.git/refs/tags/v1.10.0', `${'c'.repeat(40)}\n`)
    put(checkout, '.git/config', '[remote "origin"]\n\turl = git@github.com:owner/dsh-power.git\n')

    // A REAL junction, because that is what `link:` installs (F17) and because
    // `resolve` follows it. `symlinkSync` may need a privilege this process does
    // not have; the tests that depend on it skip rather than fail in that case,
    // since the missing capability is the test machine's, not the product's.
    let linked = true
    try {
      symlinkSync(checkout, join(profileDir, 'node_modules', 'dsh-power'), 'junction')
    } catch {
      linked = false
      put(profileDir, 'node_modules/dsh-power/package.json', readFileSync(join(checkout, 'package.json'), 'utf8'))
    }

    // Both variables are needed, and they answer different questions:
    // `DSH_HOME` is WHERE the profiles live (it outranks the OS home, which is
    // what the test is overriding), and `DSH_PROFILE` is WHICH one. A test
    // cannot change the working directory of the code under test, so these are
    // the documented seams (`profile.js`).
    process.env.DSH_HOME = home
    process.env.DSH_PROFILE = 'web'
    await run({ home, profileDir, checkout, linked })
  } finally {
    for (const [key, value] of [['DSH_PROFILE', previousProfile], ['DSH_HOME', previousHome]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * The real `fs` service over the real filesystem.
 *
 * Two behaviours are mirrored rather than simplified, because both are
 * load-bearing for these routes:
 *
 * 1. **`resolve('.')` answers the process base directory** — here the repo,
 *    which is what a REAL deployment does too. The profile is then found through
 *    `DSH_HOME`/`DSH_PROFILE`, so this test exercises the production order.
 * 2. **`resolve` returns the REAL path**, following any junction. `link:` installs
 *    ARE junctions (F17), so `node_modules/<name>/package.json` resolves into the
 *    checkout — and that resolved path is the only way `checkoutRootOf` can find
 *    the `.git` directory. A double that returns the literal path reports the
 *    plugin as "not a checkout", which is a lie the product does not tell.
 *
 * @returns {object} the service.
 */
function realFs() {
  return {
    resolve: async (target) => {
      if (target === '.') return { displayPath: process.cwd() }
      try {
        return { displayPath: realpathSync(target) }
      } catch {
        // A path that does not exist yet still has to resolve — the write path
        // depends on it.
        return { displayPath: target }
      }
    },
    readText: async (handle) => readFileSync(handle.displayPath, 'utf8'),
    writeText: async (handle, content) => {
      mkdirSync(dirname(handle.displayPath), { recursive: true })
      writeFileSync(handle.displayPath, content)
      return { ok: true }
    },
    listDir: async (handle) =>
      readdirSync(handle.displayPath).map((name) => ({ name, isDirectory: statSync(join(handle.displayPath, name)).isDirectory() })),
    stat: async (handle) => {
      try {
        const info = statSync(handle.displayPath)
        return { size: info.size, isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs }
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Mount the real route layer against real services.
 * @returns {{ routes: object[], services: object, probes: string[] }} what was registered.
 */
function mountRealRoutes() {
  const routes = []
  const probes = []
  const subprocess = createRealSubprocess()
  // Wrap the two probe entry points so the test can assert WHICH tools a route
  // asked for. A route that probes `git` for a registry plugin is doing work
  // nobody asked for.
  const tracked = {
    ...subprocess,
    async resolveExecutable(command) {
      probes.push(String(command))
      return subprocess.resolveExecutable(command)
    },
  }
  const services = { fs: realFs(), subprocess: tracked }
  const ctx = {
    effect(callback, label) {
      callback()
      return () => {}
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
  return { routes, services, probes }
}

/** Find one registered route by endpoint key. */
function routeFor(routes, key) {
  return routes.find((route) => route.path === `${ENDPOINTS.prefix}/${ENDPOINTS.endpoints[key]}`)
}

test('update routes: refs lists a real checkout\'s versions NEWEST FIRST, with no tool probe', async () => {
  await withDeployment(async ({ checkout }) => {
    const { routes, probes } = mountRealRoutes()
    const refs = routeFor(routes, 'refs')

    probes.length = 0
    const res = fakeRes()
    await refs.handler({ method: 'GET', url: `/?name=dsh-power` }, res)

    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true, payload.error ?? '')
    assert.equal(payload.checkoutRoot, checkout)
    assert.equal(payload.local.head.branch, 'main')
    assert.equal(payload.local.head.commit, HEAD_SHA)
    assert.deepEqual(
      payload.local.versionTags.map((row) => row.name),
      ['v1.10.0', 'v1.9.0'],
      'the newest version is first, so the picker can preselect it',
    )
    assert.equal(payload.local.branches[0].current, true, 'the checked-out branch is marked')
    assert.equal(payload.remote.host, 'github.com')
    assert.equal(payload.remote.repo, 'dsh-power')

    // Listing local refs needs no executable at all: refusing to show them
    // because `git` is missing would hide the whole point of the route.
    assert.deepEqual(probes, [], `refs must not probe a tool, it probed: ${probes.join(', ')}`)
  })
})

test('update routes: a checkout plan runs the git probe and reports the exact command', async () => {
  await withDeployment(async ({ checkout }) => {
    const { routes, probes } = mountRealRoutes()
    const plan = routeFor(routes, 'plan')

    probes.length = 0
    const res = fakeRes()
    await plan.handler({ method: 'GET', url: '/?name=dsh-power&ref=v1.9.0' }, res)

    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.kind, 'checkout')
    assert.deepEqual(payload.displayArgv, ['git', '-C', checkout, 'checkout', 'v1.9.0'])
    assert.deepEqual(payload.needs, ['git'], 'a checkout needs git and nothing else')
    // `dsh` was NOT probed: that is one spawn this route did not pay for.
    assert.equal(payload.tools.dsh, null, 'an unprobed tool is null, which is not "absent"')
    assert.ok(payload.tools.git !== null, 'git WAS probed, because this plan needs it')
    assert.ok(probes.some((name) => /git/i.test(name)), `expected a git probe, saw: ${probes.join(', ')}`)
    assert.equal(probes.some((name) => /dsh/i.test(name)), false, `dsh must not be probed here, saw: ${probes.join(', ')}`)
    // The plan is honest about runnability on a machine with no git.
    assert.equal(typeof payload.runnable, 'boolean')
    if (payload.tools.git.available !== true) {
      assert.equal(payload.runnable, false)
      assert.match(payload.runError, /git is unavailable|git is required/)
    }
  })
})

test('update routes: a registry plan probes the dsh launcher and NOT git', async () => {
  await withDeployment(async () => {
    const { routes, probes } = mountRealRoutes()
    const plan = routeFor(routes, 'plan')

    probes.length = 0
    const res = fakeRes()
    await plan.handler({ method: 'GET', url: '/?name=plain-lib&ref=1.2.3' }, res)

    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.kind, 'registry')
    // The spec is re-resolved WITH the ref appended, and it is handed to the
    // official CLI — never interpreted here.
    assert.deepEqual(payload.displayArgv, ['dsh', 'plugin', '--profile', 'web', 'add', '^1.0.0#1.2.3'])
    assert.deepEqual(payload.needs, ['dsh'])
    assert.equal(payload.tools.git, null, 'git must not be probed for a registry plugin')
    assert.ok(payload.tools.dsh !== null, 'the CLI launcher WAS probed')

    assert.equal(probes.some((name) => /git/i.test(name)), false, `git must not be probed, saw: ${probes.join(', ')}`)
  })
})

test('update routes: apply refuses a GET, because it takes a snapshot and writes', async () => {
  await withDeployment(async () => {
    const { routes } = mountRealRoutes()
    const res = fakeRes()
    await routeFor(routes, 'apply').handler({ method: 'GET', url: '/' }, res)
    assert.equal(res.status, 405)
    assert.match(JSON.parse(res.body).error, /POST only/)
  })
})

test('update routes: apply on a checkout with no git refuses and changes NOTHING', async () => {
  await withDeployment(async ({ profileDir }) => {
    const { routes } = mountRealRoutes()
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')

    const res = fakeRes()
    await routeFor(routes, 'apply').handler(fakeReq('POST', JSON.stringify({ name: 'dsh-power', ref: 'v1.9.0' })), res)

    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, false)
    // The refusal has to come from the PLAN, before the pipeline starts: a
    // snapshot for a change that cannot run is a snapshot of nothing.
    assert.equal(payload.snapshot, undefined, 'nothing was snapshotted')
    assert.equal(payload.plan.ok, false)
    assert.match(String(payload.error), /git is required|git is unavailable/)
    assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), before, 'the profile is untouched')
  })
})

test('update routes: rollback with no snapshot says so instead of pretending', async () => {
  await withDeployment(async () => {
    const { routes } = mountRealRoutes()
    const res = fakeRes()
    await routeFor(routes, 'rollback').handler(fakeReq('POST', JSON.stringify({})), res)

    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, false)
    assert.match(String(payload.error), /no snapshot has been taken/)
  })
})

test('update routes: remote-refs is POST-only, so a page load can never reach the network', async () => {
  await withDeployment(async () => {
    const { routes } = mountRealRoutes()
    const res = fakeRes()
    await routeFor(routes, 'remoteRefs').handler({ method: 'GET', url: '/' }, res)
    assert.equal(res.status, 405)
    assert.match(JSON.parse(res.body).error, /POST only/)
  })
})

test('update routes: every route in the contract is registered', async () => {
  await withDeployment(async () => {
    const { routes } = mountRealRoutes()
    const paths = routes.map((route) => route.path).sort()
    const expected = Object.values(ENDPOINTS.endpoints)
      .map((suffix) => `${ENDPOINTS.prefix}/${suffix}`)
      .sort()
    assert.deepEqual(paths, expected)
    assert.ok(paths.length >= 9, 'the update endpoints are part of the contract now')
  })
})
