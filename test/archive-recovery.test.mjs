/**
 * An ARCHIVE install, over the real route, answering with a reason and a way out.
 *
 * ## The deployment this reproduces
 *
 * A brand-new machine follows the install instructions a plugin ships and runs
 * `dsh plugin --profile web add <github archive URL>`. `dsh plugin` forwards to
 * pnpm, pnpm fetches codeload's tarball and unpacks it, and the installed
 * directory has **no `.git`** (measured; `docs/host-notes.md`). Every version
 * tool in this panel reads `.git`, so on that machine all of them refuse at once
 * — and the panel used to answer with two true sentences that explained nothing:
 *
 *   refs  → "no .git/HEAD and no .git file"
 *   remote-refs → "this checkout records no origin remote"
 *
 * That is the bug this file pins, and it is a WIRING bug rather than a logic one:
 * `recovery.js` is unit-tested on its own, and what was missing here is the seam
 * — that the inventory row carries the record, that the `refs` route serves it
 * to the panel, and that a real `link:` checkout in the SAME profile does NOT
 * get the archive story attached to it.
 *
 * So the test builds both installs side by side: one archive dependency (a
 * tarball URL, no `.git` anywhere) and one real checkout (a hand-written `.git`,
 * because `git` is not on PATH on the reference machine — host-notes F26).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { checkoutRecovery } from '../src/host/recovery.js'

const routesModule = await import('../src/host/routes.js')

/** The endpoint the panel calls for local refs. */
const REFS_PATH = `${routesModule.PREFIX}/${routesModule.ENDPOINTS.refs}`

/** Write one file, creating its directory. */
function put(root, relative, content) {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** The real `fs` service over the real filesystem, resolving like the host does. */
function realFs() {
  return {
    resolve: async (target) => {
      if (target === '.') return { displayPath: process.cwd() }
      try {
        return { displayPath: realpathSync(target) }
      } catch {
        return { displayPath: target }
      }
    },
    readText: async (handle) => readFileSync(handle.displayPath, 'utf8'),
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

/** A fake `res` recording what the handler wrote. */
function fakeRes() {
  return {
    status: null,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body
    },
  }
}

/**
 * Mount the real routes and return them, the way the host does.
 * @param {object} services - the services `ctx.get` answers with.
 * @returns {object[]} the registered routes.
 */
function mountRoutes(services) {
  const routes = []
  const ctx = {
    effect(callback) {
      const dispose = callback()
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
  return routes
}

/**
 * Call one GET route with only the `fs` service available.
 *
 * `subprocess` is deliberately absent: listing refs and explaining why there are
 * none needs no executable, and a route that refused for want of one would hide
 * the very answer this test is about.
 *
 * @param {string} url - the full request URL.
 * @returns {Promise<object>} the parsed JSON body.
 */
async function callRefs(url) {
  const routes = mountRoutes({ fs: realFs() })
  const entry = routes.find((route) => route.path === REFS_PATH)
  assert.notEqual(entry, undefined, 'the refs route must be registered')
  const res = fakeRes()
  await entry.handler({ method: 'GET', url, on: () => undefined, destroy: () => undefined }, res)
  return JSON.parse(res.body)
}

/**
 * A throwaway `$DSH_HOME` with an archive install and a checkout, side by side.
 *
 * ⚠️ `realpathSync(tmpdir())` is not cosmetic: on macOS `tmpdir()` is
 * `/var/folders/…`, which is itself a symlink to `/private/var/folders/…`, and
 * the `fs` double above resolves to the REAL path. Without it every expected path
 * in this file disagrees with every produced one by that prefix, and the test
 * fails for a reason that has nothing to do with the product.
 *
 * @param {(ctx: {home: string, profileDir: string, archive: string, checkout: string}) => Promise<void>} run - the assertions.
 * @returns {Promise<void>} resolves once the tree is removed.
 */
async function withDeployment(run) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-pm-arch-'))
  const profileDir = join(home, 'profiles', 'web')
  const archive = join(profileDir, 'node_modules', 'from-archive')
  const checkout = join(home, 'plugins-src', 'from-checkout')
  const previous = { profile: process.env.DSH_PROFILE, home: process.env.DSH_HOME }

  try {
    put(profileDir, 'package.json', `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {
        'from-archive': 'https://github.com/itdogwowo/dsh-tavern/archive/refs/heads/main.tar.gz',
        'from-checkout': `link:${checkout}`,
        'from-registry': '^1.0.0',
      },
      dsh: { profile: { bundles: ['from-archive', 'from-checkout'] } },
    }, null, 2)}\n`)

    // ── the archive install: an unpacked tarball, exactly as pnpm leaves it ──
    put(archive, 'package.json', JSON.stringify({ name: 'from-archive', version: '2.7.0', dsh: { bundle: { patch: './p.yml' } } }))
    put(archive, 'index.js', 'export default 1\n')

    // ── a real checkout, with the four files `gitrefs.js` reads ──────────────
    put(checkout, 'package.json', JSON.stringify({ name: 'from-checkout', version: '0.0.0', dsh: { bundle: { patch: './p.yml' } } }))
    put(checkout, '.git/HEAD', 'ref: refs/heads/main\n')
    put(checkout, '.git/refs/heads/main', `${'a'.repeat(40)}\n`)
    put(checkout, '.git/config', '[remote "origin"]\n\turl = git@github.com:owner/from-checkout.git\n')
    // A REAL junction, because that is what `link:` installs (host-notes F17) and
    // because the resolved path is the only way the route finds `.git` at all.
    symlinkSync(checkout, join(profileDir, 'node_modules', 'from-checkout'), 'junction')

    put(profileDir, 'node_modules/from-registry/package.json', JSON.stringify({ name: 'from-registry', version: '1.0.0' }))

    process.env.DSH_HOME = home
    process.env.DSH_PROFILE = 'web'
    await run({ home, profileDir, archive: realpathSync(archive), checkout: realpathSync(checkout) })
  } finally {
    if (previous.profile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = previous.profile
    if (previous.home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous.home
    rmSync(home, { recursive: true, force: true })
  }
}

test('archive install: refs answers with the reason and the way out', async () => {
  await withDeployment(async () => {
    const body = await callRefs(`${REFS_PATH}?name=from-archive`)

    assert.equal(body.ok, false, 'there are no refs to list, and the route says so')
    // The old answer is still there, unchanged: this test asserts what was ADDED,
    // not that the old string was reworded.
    assert.match(String(body.error), /no \.git\/HEAD and no \.git file/)

    assert.notEqual(body.recovery, null, 'the refusal must carry a reason the panel can render')
    assert.equal(body.recovery.applies, true)
    assert.equal(body.recovery.sourceKind, 'tarball')
    assert.equal(body.recovery.reason, 'archiveFromSpec')
    assert.equal(body.recovery.repoUrl, 'https://github.com/itdogwowo/dsh-tavern', 'the archive URL still names its repository')
    assert.equal(body.recovery.dir, body.checkoutRoot, 'the record names the directory that was read')
    assert.equal(
      body.recovery.commands.clone,
      'git clone https://github.com/itdogwowo/dsh-tavern <你放 clone 的位置>',
      'the clone command must be exact, and its target must stay a placeholder',
    )
    assert.equal(
      body.recovery.commands.link,
      'dsh plugin --profile web add "link:<你放 clone 的位置>"',
      'the second command is what actually converts the install, so it is spelled out',
    )
  })
})

test('archive install: a registry dependency gets a reason and no invented command', async () => {
  await withDeployment(async () => {
    const body = await callRefs(`${REFS_PATH}?name=from-registry`)

    assert.equal(body.recovery.applies, true, 'a registry install has no refs either, and that is not a mystery')
    assert.equal(body.recovery.sourceKind, 'registry')
    assert.equal(body.recovery.reason, 'archiveFromRegistry')
    assert.equal(body.recovery.repoUrl, null)
    assert.equal(body.recovery.commands, null, 'a spec with no URL must not produce a guessed clone command')
  })
})

test('archive install: a real checkout is NOT told it has no .git', async () => {
  await withDeployment(async () => {
    const body = await callRefs(`${REFS_PATH}?name=from-checkout`)

    assert.equal(body.ok, true, 'the checkout lists its refs')
    assert.equal(body.local.head.branch, 'main')
    assert.equal(body.local.head.commit, 'a'.repeat(40))
    assert.equal(body.remote.url, 'git@github.com:owner/from-checkout.git', 'and it has an origin to ask')

    // ⚠️ `applies` is TRUE even here, and that is deliberate rather than a leak.
    // The record is derived from the SPEC, and `link:` is the one shape that
    // normally CAN be read — so this is the row that would need the `linkNoRepo`
    // sentence if its target had no `.git` (a moved checkout, a path typo). What
    // keeps the panel from SHOWING it is the second half of the guard: the host
    // resolved a commit for this row, so there is nothing to recover from.
    // Asserting both halves is what stops a readable checkout from being
    // relabelled as a pnpm-install problem.
    assert.equal(body.recovery.applies, true)
    assert.equal(body.recovery.sourceKind, 'link')
    assert.equal(body.recovery.reason, 'linkNoRepo')
    assert.equal(body.recovery.commands, null)
  })
})

test('archive install: a link: whose target is gone names the path that is broken', async () => {
  // The reason `link` appears in `recovery.js` at all: a `link:` install with no
  // `.git` fails every version tool exactly like an archive does, and "no
  // .git/HEAD" would send the reader looking at pnpm instead of at their path.
  //
  // The dependency is declared and its target does not exist — a checkout that was
  // moved or renamed after install. That is a state the host must survive without
  // inventing an archive story for it.
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-pm-gone-'))
  const previous = { profile: process.env.DSH_PROFILE, home: process.env.DSH_HOME }
  const gone = join(home, 'plugins-src', 'moved-away')
  try {
    put(join(home, 'profiles', 'web'), 'package.json', `${JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'from-link': `link:${gone}` },
      dsh: { profile: { bundles: [] } },
    }, null, 2)}\n`)

    process.env.DSH_HOME = home
    process.env.DSH_PROFILE = 'web'
    const body = await callRefs(`${REFS_PATH}?name=from-link`)

    assert.equal(body.ok, false, 'there is no checkout to read')
    assert.equal(body.recovery.applies, true)
    assert.equal(body.recovery.sourceKind, 'link')
    assert.equal(body.recovery.reason, 'linkNoRepo')
    assert.equal(body.recovery.dir, gone, 'the spec’s own path is the answer, because that is what is broken')
    assert.equal(body.recovery.commands, null, 'there is nothing to clone from a local path')
  } finally {
    if (previous.profile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = previous.profile
    if (previous.home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous.home
    rmSync(home, { recursive: true, force: true })
  }
})

test('archive install: the same record comes from the pure function and the route', async () => {
  // The route reads the record off the inventory row rather than recomputing it,
  // so this pins the one input both share: the SPEC. If they ever disagree, the
  // card and the panel would tell two different stories about one install.
  await withDeployment(async ({ profileDir }) => {
    const body = await callRefs(`${REFS_PATH}?name=from-archive`)
    const direct = checkoutRecovery({
      spec: 'https://github.com/itdogwowo/dsh-tavern/archive/refs/heads/main.tar.gz',
      name: 'from-archive',
      profileName: 'web',
      dir: body.recovery.dir,
    })

    assert.deepEqual(body.recovery, direct)
    assert.ok(body.recovery.dir.startsWith(profileDir), 'and the directory is inside the profile, as an installed dependency')
  })
})
