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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createRealSubprocess } from './helpers/real-subprocess.mjs'
import { credentialsPath, writeCredentialStore, writeSettings } from '../src/host/credentials.js'
import { storeFilePath } from '../src/host/gitcredentials.js'

const routesModule = await import('../src/host/routes.js')
const ENDPOINTS = JSON.parse(readFileSync(new URL('../src/endpoints.json', import.meta.url), 'utf8'))

/** The suffix `probeDshLauncher` looks for when it stats a launcher candidate. */
const LAUNCHER_SUFFIX = join('lib', 'bin.js')

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
 * The real `fs` service with the dsh LAUNCHER hidden.
 *
 * The apply route's whole pipeline runs after its tools are probed, and the
 * pre-check needs the launcher while the git plan needs git. Hiding only the
 * launcher (`lib/bin.js`, the one shape `probeDshLauncher` stats) makes the
 * pipeline stop at its pre-check, which is exactly what a test about the
 * credential FILE wants: the run is real, but nothing is merged into a synthetic
 * checkout.
 *
 * @returns {object} the `fs` service, with the launcher stat'ed as absent.
 */
function fsWithoutLauncher() {
  const real = realFs()
  return {
    ...real,
    async stat(handle) {
      if (String(handle?.displayPath ?? '').endsWith('bin.js')) return undefined
      return real.stat(handle)
    },
  }
}

/**
 * The real `fs` service that claims a Sourcetree bundle exists.
 *
 * Every path mentioning Sourcetree is reported present AND recorded, so a test
 * can assert both that delegation happened and — more importantly — that a
 * request with the setting OFF never even looked. Nothing is spawned for the
 * borrowed git: the path is deliberately one that does not exist, so the
 * delegated child fails immediately instead of reaching the network.
 *
 * @param {string[]} seen - collects every Sourcetree path that was stat'ed.
 * @returns {object} the `fs` service.
 */
function fsWithSourcetree(seen) {
  const real = realFs()
  return {
    ...real,
    async stat(handle) {
      const path = String(handle?.displayPath ?? '')
      if (path.includes('Sourcetree') || path.includes('SourceTree')) {
        seen.push(path)
        return { size: 1, isDirectory: false, mtimeMs: 0 }
      }
      return real.stat(handle)
    },
  }
}

/** A throwaway `$DSH_HOME` with one profile containing a `link:` checkout.
 *
 * The checkout is a hand-written `.git` (HEAD, a branch, two tags, an origin
 * remote) because `git` is not on PATH on the reference machine (F26).
 *
 * @param {(ctx: {home: string, profileDir: string, checkout: string}) => Promise<void>} run - the assertions.
 * @returns {Promise<void>} resolves once the tree is removed.
 */
async function withDeployment(run) {
  // `realpathSync(tmpdir())`: on macOS `tmpdir()` is `/var/folders/…`, itself a
  // symlink to `/private/var/folders/…`, while the `fs` double resolves to the
  // REAL path — so every expected path would differ from every produced one by
  // that prefix and the test would fail for a reason unrelated to the product.
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-pm-dep-'))
  const profileDir = join(home, 'profiles', 'web')
  const checkout = join(home, 'plugins-src', 'dsh-power')
  const previousProfile = process.env.DSH_PROFILE
  const previousHome = process.env.DSH_HOME
  const previousBin = process.env.DSH_BIN
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

    // ⚠️ The launcher is located by stat'ing candidate paths (`host.js`), and its
    // candidate list derives from HOW THIS PROCESS WAS STARTED (`process.argv[1]`
    // walking up to a `@deepseek-ai/dsh/lib/bin.js` layout). Under `node --test`
    // that entry is the test RUNNER, so on a perfectly healthy machine the probe
    // finds nothing and the plan reports the launcher unavailable — a test that
    // fails for a reason unrelated to the product. `DSH_BIN` is the host's own
    // documented override, so the deployment simply states the answer:
    // `lib/bin.js`, the one shape `probeDshLauncher` stats.
    put(home, 'launcher/lib/bin.js', '// launcher\n')
    process.env.DSH_BIN = join(home, 'launcher', 'lib', 'bin.js')

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
    for (const [key, value] of [['DSH_PROFILE', previousProfile], ['DSH_HOME', previousHome], ['DSH_BIN', previousBin]]) {
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
 * The real `fs` service with NO executable on disk.
 *
 * `probeGit` has two authorities on "does this executable exist": the subprocess
 * seam's `resolveExecutable`, and `fs.stat` for absolute install paths. A test
 * about a MISSING tool has to answer for both, or it silently depends on whether
 * the machine running it happens to have git installed (this one does).
 *
 * Everything else stays REAL: the routes under test read the profile through
 * this same service, and a blanket stub would replace the deployment with
 * nothing and pass for the wrong reason.
 *
 * @returns {object} the `fs` service, with `stat` refusing every path.
 */
function fsWithoutTools() {
  const real = realFs()
  return {
    ...real,
    async stat() {
      return undefined
    },
  }
}

/**
 * Mount the real route layer against real services.
 * @param {object} [options] - `resolveExecutable` replaces the real resolver and
 *   `fs` replaces the file service, so a test about a missing tool can say so
 *   instead of inheriting this machine's.
 * @returns {{ routes: object[], services: object, probes: string[] }} what was registered.
 */
function mountRealRoutes(options = {}) {
  const routes = []
  const probes = []
  const subprocess = createRealSubprocess()
  const resolve = typeof options.resolveExecutable === 'function' ? options.resolveExecutable : (command) => subprocess.resolveExecutable(command)
  // Wrap the two probe entry points so the test can assert WHICH tools a route
  // asked for. A route that probes `git` for a registry plugin is doing work
  // nobody asked for.
  const tracked = {
    ...subprocess,
    async resolveExecutable(command) {
      probes.push(String(command))
      return resolve(command)
    },
  }
  // ⚠️ `probeDshLauncher` does not use this seam at all: it locates the launcher by
  // `fs.stat` over candidate paths (`host.js`), so a test that tracked only
  // `resolveExecutable` would report "no dsh probe" on a machine where dsh works —
  // and the assertion that a plan probes the launcher (the bug that made every
  // local checkout update refuse) would fail for the wrong reason. Both probe
  // entry points are tracked, and they are told apart by the name recorded.
  const baseFs = options.fs ?? realFs()
  const services = {
    fs: {
      ...baseFs,
      async stat(handle) {
        const path = String(handle?.displayPath ?? '')
        if (path.endsWith(LAUNCHER_SUFFIX)) probes.push('dsh (fs)')
        return baseFs.stat(handle)
      },
    },
    subprocess: tracked,
  }
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
    // ⚠️ This assertion used to read `['git']`, with the comment "a checkout needs
    // git and nothing else" — and that was the bug. Moving the tree needs git, but
    // EVERY change also runs the pipeline's pre-check (V1 compose), which spawns
    // `dsh --dump-config`. Probing only the classified tool left `launcher` null,
    // and `runPipeline` refused every local checkout update with "the dsh launcher
    // is unavailable: no probe result" — measured live, on a machine where `dsh`
    // worked. The classified need is not the run's need.
    assert.deepEqual(payload.needs, ['git', 'dsh'], 'the move needs git, and the pre-check needs dsh')
    assert.ok(payload.tools.dsh !== null, 'so the launcher IS probed, not left null')
    assert.ok(payload.tools.git !== null, 'git WAS probed, because this plan needs it')
    assert.ok(probes.some((name) => /git/i.test(name)), `expected a git probe, saw: ${probes.join(', ')}`)
    assert.ok(probes.some((name) => /dsh/i.test(name)), `expected a dsh probe, saw: ${probes.join(', ')}`)
    // The plan is honest about runnability on a machine with no git.
    assert.equal(typeof payload.runnable, 'boolean')
    if (payload.tools.git.available !== true) {
      assert.equal(payload.runnable, false)
      assert.match(payload.runError, /git is unavailable|git is required/)
    }
  })
})

test('update routes: a checkout update probes the launcher, because V1 needs it', async () => {
  // Regression, and the reason it is its own test: the plan used to probe only
  // the CLASSIFIED tool — `git` for a checkout move — so `launcher` stayed null,
  // and `runPipeline`'s mandatory pre-check then refused EVERY local checkout
  // update with "the dsh launcher is unavailable: no probe result". Measured live
  // on a machine where `dsh` worked, which is what made it look like a missing
  // tool rather than a missing probe.
  //
  // Deliberately no path comparison: the deployment's path spelling has its own
  // test above, and this one has to keep asserting the DECISION on every platform.
  await withDeployment(async () => {
    const { routes, probes } = mountRealRoutes()
    const res = fakeRes()
    await routeFor(routes, 'plan').handler({ method: 'GET', url: '/?name=dsh-power&ref=v1.9.0' }, res)

    const payload = JSON.parse(res.body)
    assert.equal(payload.kind, 'checkout')
    assert.ok(payload.needs.includes('dsh'), 'the pre-check needs the launcher, so the plan must declare it')
    assert.ok(payload.tools.dsh !== null, 'and the probe must actually have run')
    // The route projects a probe to `{available, path, error}`, so a boolean here
    // is the evidence it ran: the unprobed shape is `null`, which is the state this
    // regression is about.
    assert.equal(typeof payload.tools.dsh.available, 'boolean', 'a probed launcher answers yes or no')
    // Exactly once: the launcher is added to the classified needs, not duplicated.
    assert.equal(payload.needs.filter((name) => name === 'dsh').length, 1)
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
    // This machine HAS git (it is on PATH now), so "no git" is stated rather
    // than inherited: the test is about what the route does when the tool is
    // absent, and it must not start passing or failing because of the host it
    // runs on. BOTH authorities have to answer "no" — the subprocess resolver and
    // the `fs.stat` fallback that checks absolute install paths.
    const { routes } = mountRealRoutes({ resolveExecutable: () => null, fs: fsWithoutTools() })
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

test('update routes: apply lends the stored token to git as a FILE, and removes it after the run', async () => {
  await withDeployment(async ({ home }) => {
    // The user's own token, saved by the user in this plugin's own store. It is
    // the only secret in play, and it may reach the git child through nothing but
    // a 0600 file whose path — never whose content — appears in the arguments.
    const saved = await writeCredentialStore(home, 'github.com', 'ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')
    assert.equal(saved.ok, true, saved.error ?? '')

    const { routes } = mountRealRoutes({ fs: fsWithoutLauncher() })
    const res = fakeRes()
    await routeFor(routes, 'apply').handler(fakeReq('POST', JSON.stringify({ name: 'dsh-power', ref: 'v1.9.0' })), res)

    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    const borrowed = storeFilePath(home)

    assert.equal(payload.gitCredential.injected, true, `the token should have been lent: ${JSON.stringify(payload.gitCredential)}`)
    assert.equal(payload.gitCredential.host, 'github.com')
    assert.equal(payload.gitCredential.path, borrowed)

    // The command line names the FILE and only the file: an empty helper entry
    // first (which is what stops the inherited helper from prompting), then this
    // plugin's own store helper.
    assert.ok(payload.argv.includes('credential.helper='), 'the inherited helpers are cleared first')
    assert.ok(payload.argv.includes(`credential.helper=store --file=${borrowed}`), 'and the file is what git is pointed at')
    assert.ok(!payload.argv.some((part) => String(part).includes('ghp_')), 'no token may enter argv')

    // Nor the HTTP response: the browser is not a place a secret may travel to.
    assert.ok(!res.body.includes('ghp_'), 'the token must not reach the panel')

    // The file exists for the run and for nothing after it; the user's saved
    // token is a different thing and must survive.
    assert.equal(existsSync(borrowed), false, 'the credential file is deleted after the run')
    assert.equal(existsSync(credentialsPath(home)), true, 'the saved token itself is untouched')
  })
})

test('update routes: remote-refs delegates to Sourcetree only when the setting says so', async () => {
  await withDeployment(async ({ home, checkout }) => {
    // A host this package implements no API for: the REST path refuses it WITHOUT
    // going to the network, which is what makes this test runnable offline. The
    // delegated path never reaches the network either, because the "Sourcetree"
    // binary the fake fs reports does not exist.
    put(checkout, '.git/config', '[remote "origin"]\n\turl = https://example.invalid/owner/dsh-power.git\n')
    const seen = []

    // Default: OFF. The credential delegation would borrow was never handed to
    // this plugin, so nothing may look for it.
    const off = mountRealRoutes({ fs: fsWithSourcetree(seen) })
    const offRes = fakeRes()
    await routeFor(off.routes, 'remoteRefs').handler(fakeReq('POST', JSON.stringify({ name: 'dsh-power' })), offRes)
    const offPayload = JSON.parse(offRes.body)
    assert.equal(offPayload.delegated, undefined, 'the REST path makes no delegation claim')
    assert.match(String(offPayload.error), /ref-listing API/, 'the REST path is what answered')
    assert.deepEqual(seen, [], 'nothing even looked for a Sourcetree installation')

    // Opted in: the same machine now delegates.
    const written = await writeSettings(home, { delegateSourcetree: true })
    assert.equal(written.ok, true, written.error ?? '')
    const on = mountRealRoutes({ fs: fsWithSourcetree(seen) })
    const onRes = fakeRes()
    await routeFor(on.routes, 'remoteRefs').handler(fakeReq('POST', JSON.stringify({ name: 'dsh-power' })), onRes)
    const onPayload = JSON.parse(onRes.body)
    assert.equal(onPayload.delegated, true, JSON.stringify(onPayload))
    assert.equal(onPayload.provider, 'git')
    assert.equal(onPayload.tokenUsed, false, 'a delegated listing uses no token of ours')
    assert.ok(seen.some((path) => path.includes('Sourcetree')), 'the Sourcetree bundle is looked for only now')
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
