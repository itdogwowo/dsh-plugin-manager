/**
 * The overview snapshot is the host half's whole read model, so its defensive
 * behaviour is what keeps a renamed or missing host service from turning a
 * panel refresh into a thrown error.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildBackend, buildOverview } from '../src/host/overview.js'

/** A `get` reader over a fixed service table. */
function reader(services) {
  return (name) => services[name]
}

/** A graph shaped like `clientModules.graph()` returns. */
function graph() {
  return {
    rev: 'abcdef0123456789',
    entries: [
      { id: 'dsh-base', url: '/plugins/dsh-base/client.js', rev: 'r1', inject: ['react'] },
      { id: 'dsh-tools', url: '/plugins/dsh-tools/client.js', rev: 'r2', immediately: true, inject: ['react', 'dsh-base'] },
      { id: 'broken' },
    ],
    batches: [
      { phase: 'bootstrap', url: '/b1.js', rev: 'b1', entries: ['dsh-base'] },
      { phase: 'application', url: '/b2.js', rev: 'b2', entries: ['dsh-tools'] },
    ],
  }
}

test('overview: a full graph projects into plain rows with counts', async () => {
  const out = await buildOverview(reader({ clientModules: { graph } }))

  assert.equal(out.source, 'clientModules.graph()')
  assert.equal(out.rev, 'abcdef0123456789')
  assert.equal(out.entries.length, 3)
  assert.equal(out.batches.length, 2)
  assert.deepEqual(out.counts, {
    total: 3,
    immediate: 1,
    lazy: 2,
    injected: 2,
    batches: 2,
    // No `fs` here, so no profile manifest was read: nothing can be third-party.
    thirdParty: 0,
    thirdPartyLoaded: 0,
  })
  assert.deepEqual(out.injected, ['dsh-base', 'react'])
  assert.deepEqual(out.thirdParty, [])
  // Exactly one notice: the installed-plugin list is unavailable without `fs`.
  assert.equal(out.notices.length, 1)
  assert.match(out.notices[0], /installed-plugin list is unavailable/)
})

test('overview: a row missing fields degrades instead of throwing', async () => {
  const out = await buildOverview(reader({ clientModules: { graph } }))
  const broken = out.entries[2]

  assert.equal(broken.id, 'broken')
  assert.equal(broken.url, null)
  assert.equal(broken.rev, null)
  assert.equal(broken.immediate, false)
  assert.deepEqual(broken.inject, [])
})

test('overview: no clientModules is a notice, not an error, and still returns JSON', async () => {
  const out = await buildOverview(reader({}))

  assert.equal(out.source, 'none')
  assert.deepEqual(out.entries, [])
  // clientModules missing AND the installed-plugin list unavailable.
  assert.equal(out.notices.length, 2)
  assert.match(out.notices.join(' '), /clientModules service is not available/)
  assert.match(out.notices.join(' '), /installed-plugin list is unavailable/)
  // The contract the panel depends on: the whole snapshot survives JSON.
  assert.equal(typeof JSON.parse(JSON.stringify(out)), 'object')
})

test('overview: a throwing graph() is caught and reported', async () => {
  const clientModules = {
    graph() {
      throw new Error('boom')
    },
  }
  const out = await buildOverview(reader({ clientModules }))

  assert.equal(out.entries.length, 0)
  assert.match(out.notices.join(' '), /graph\(\) threw: boom/)
})

test('overview: a non-object graph() result is reported, not dereferenced', async () => {
  const out = await buildOverview(reader({ clientModules: { graph: () => null } }))

  assert.equal(out.entries.length, 0)
  assert.match(out.notices.join(' '), /returned a non-object/)
})

test('overview: pluginInventory absence stays a normal outcome', async () => {
  const out = await buildOverview(reader({ clientModules: { graph } }))

  assert.deepEqual(out.inventory, { available: false, rows: [], count: 0 })
})

test('overview: an available pluginInventory is projected', async () => {
  const list = async () => ({
    entries: [
      { entryId: 'timer', moduleName: '@deepseek-ai/cordis-plugin-timer', enabled: true, fiberPhase: 'active' },
      { entryId: 'hmr', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: false, fiberPhase: null },
    ],
  })
  const out = await buildOverview(reader({ clientModules: { graph }, pluginInventory: { list } }))

  assert.equal(out.inventory.available, true)
  assert.equal(out.inventory.count, 2)
  assert.equal(out.inventory.rows[1].enabled, false)
  assert.equal(out.inventory.rows[1].fiberPhase, null)
})

test('overview: a throwing pluginInventory.list() is contained in inventory', async () => {
  const list = async () => {
    throw new Error('nope')
  }
  const out = await buildOverview(reader({ clientModules: { graph }, pluginInventory: { list } }))

  // The entry list must survive an inventory failure.
  assert.equal(out.entries.length, 3)
  assert.equal(out.inventory.available, true)
  assert.match(out.inventory.error, /nope/)
})

test('backend: reports which optional services resolved', () => {
  const absent = buildBackend(reader({}))
  assert.equal(absent.clientModules, 'absent')
  assert.equal(absent.pluginInventory, 'absent')
  assert.equal(absent.fs, 'absent')
  assert.equal(absent.node, process.versions.node)
  assert.equal(absent.platform, process.platform)
  assert.ok(Array.isArray(absent.profileCandidates))

  const ready = buildBackend(reader({ clientModules: {}, pluginInventory: {}, fs: {} }))
  assert.equal(ready.clientModules, 'ready')
  assert.equal(ready.pluginInventory, 'ready')
  assert.equal(ready.fs, 'ready')
})

// ── enabled / disabled, resolved per plugin ─────────────────────────────────

/**
 * An `fs` stub that reports a profile manifest, a patch file, and per-plugin
 * installed manifests.
 *
 * The installed `package.json` is what decides `declaresBundle` — that is the
 * whole point of the library/fault distinction — so the stub has to be able to
 * declare one. `bundles` lists the dependencies whose installed package carries
 * a `dsh.bundle`.
 *
 * @param {Record<string, string>} dependencies - the profile's dependencies map.
 * @param {object} [options] - `patch` text, and which names declare a bundle.
 * @returns {object} the fs service stub.
 */
function profileFs(dependencies, options = {}) {
  const files = new Map()
  files.set('package.json', JSON.stringify({ dsh: { profile: { bundles: [] } }, dependencies }))
  if (options.patch !== undefined) files.set('cordis.patch.yml', options.patch)

  const declaresBundle = new Set(options.bundles ?? [])
  // One installed manifest per dependency, keyed the way the stub's readText
  // looks files up: by basename, with the FIRST match winning.
  for (const name of Object.keys(dependencies)) {
    files.set(`manifest:${name}`, JSON.stringify(declaresBundle.has(name) ? { version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } } : { version: '1.0.0' }))
  }

  return {
    async resolve(path) {
      return { displayPath: String(path) }
    },
    async readText(target) {
      const raw = String(target.displayPath)
      const segments = raw.split(/[\\/]/)
      const base = segments[segments.length - 1]
      // `…/node_modules/<name>/package.json` — the name is the segment before it.
      if (base === 'package.json' && segments.length >= 2) {
        const owner = segments[segments.length - 2]
        const manifest = files.get(`manifest:${owner}`)
        if (manifest !== undefined) return manifest
      }
      const value = files.get(base)
      if (value === undefined) throw new Error(`ENOENT: ${base}`)
      return value
    },
  }
}

test('overview: a library with no bundle is NOT reported as a fault', async () => {
  // The bug this guards: `config-forms` is a profile dependency with no
  // `dsh.bundle`, so it never enters the web boot graph and never should. The
  // first version called that `not-loaded` and the card showed it in the warning
  // colour beside the words for a broken plugin — telling the user something was
  // wrong with a package that was working exactly as intended.
  const fs = profileFs({ 'config-forms': '^0.2.1' })
  const out = await buildOverview(reader({ fs }))

  assert.equal(out.thirdParty.length, 1)
  const row = out.thirdParty[0]
  assert.equal(row.loaded, false, 'a library is genuinely absent from the boot graph')
  assert.equal(row.declaresBundle, false)
  assert.equal(row.enabledState, 'library', 'absence from the graph is normal for a library, not a fault')
  assert.notEqual(row.enabledState, 'not-loaded')
})

test('overview: a plugin that DECLARES a bundle but is absent IS a fault', async () => {
  // The other half of the same rule, so the library case cannot be satisfied by
  // simply never reporting a fault. Same absent boot graph, opposite conclusion —
  // the only difference is whether the installed package declares a bundle.
  const fs = profileFs({ 'broken-tool': '^1.0.0' }, { bundles: ['broken-tool'] })
  const out = await buildOverview(reader({ fs }))

  const row = out.thirdParty[0]
  assert.equal(row.declaresBundle, true, 'the stub must declare a bundle for this case to mean anything')
  assert.equal(row.loaded, false, 'it is absent from the boot graph')
  assert.equal(row.enabledState, 'not-loaded', 'declared a bundle, enabled, and not running — that is the fault')
  assert.notEqual(row.enabledState, 'library')
})

test('overview: a patch row disabling a plugin turns the card off', async () => {
  const fs = profileFs({ 'tool-x': '^1.0.0' }, { patch: '# mine\n[\n- { id: tool-x, disabled: true }\n]\n' })
  const out = await buildOverview(reader({ fs }))

  const row = out.thirdParty.find((plugin) => plugin.name === 'tool-x')
  assert.equal(row.enabled, false)
  assert.equal(row.enabledState, 'disabled')
  assert.match(String(row.disabledBy), /cordis\.patch\.yml/)
})

test('overview: an absent patch file is normal, not a notice', async () => {
  // `dsh plugin add` never creates cordis.patch.yml. Reporting its absence told
  // the user their profile was broken when nothing was wrong.
  const fs = profileFs({ 'tool-x': '^1.0.0' })
  const out = await buildOverview(reader({ fs }))

  assert.equal(out.patch.patchPresent, false)
  assert.equal(out.patch.reason, null)
  assert.equal(
    out.notices.some((text) => /cordis\.patch\.yml/.test(text)),
    false,
    'a missing patch file must not produce a notice',
  )
})

// ── version identity: which signal is the version ────────────────────────────

/**
 * An `fs` stub for a link-installed checkout, optionally with a readable `.git`.
 * @param {object} [options] - `commit` to report, and whether a repo exists.
 * @returns {object} the fs service stub.
 */
function checkoutFs(options = {}) {
  const commit = options.commit ?? 'ef5d61a177228e3d317f85c63fbb09ea2e079284'
  const isRepo = options.isRepo !== false
  const files = new Map([
    ['package.json', JSON.stringify({ dsh: { profile: { bundles: [] } }, dependencies: { 'tool-x': 'link:/checkout/tool-x' } })],
    ['manifest:tool-x', JSON.stringify({ name: 'tool-x', version: '0.0.0', dsh: { bundle: {} } })],
  ])
  if (isRepo) {
    files.set('HEAD', 'ref: refs/heads/main\n')
    files.set('refs/heads/main', `${commit}\n`)
    files.set('config', '[remote "origin"]\n\turl = https://example.invalid/tool-x\n')
  }

  return {
    async resolve(path) {
      return { displayPath: String(path) }
    },
    async readText(target) {
      const raw = String(target.displayPath)
      const segments = raw.split(/[\\/]/)
      const base = segments[segments.length - 1]
      // Git metadata: keyed by the segment AFTER `.git`, so `HEAD` and
      // `refs/heads/main` both resolve regardless of which separator style the
      // caller used to join them.
      const gitAt = segments.indexOf('.git')
      if (gitAt !== -1) {
        const key = segments.slice(gitAt + 1).join('/')
        const value = files.get(key)
        if (value !== undefined) return value
        throw new Error(`ENOENT: .git/${key}`)
      }
      // `…/node_modules/tool-x/package.json`: the OWNER segment identifies it.
      if (base === 'package.json' && segments.includes('node_modules')) {
        const owner = segments[segments.length - 2]
        const manifest = files.get(`manifest:${owner}`)
        if (manifest !== undefined) return manifest
      }
      const value = files.get(base)
      if (value === undefined) throw new Error(`ENOENT: ${base}`)
      return value
    },
  }
}

test('overview: a checkout reports its COMMIT as well as its version', async () => {
  // The commit is NOT the version: `package.json` is, for every source kind,
  // because a checkout's version field is maintained (`dsh-power` declares 1.8.0
  // and `dsh-tavern` 2.6.72, with no git tags anywhere). The commit stays reported
  // because it identifies WHICH BUILD is running — the question a developer
  // editing a local checkout actually asks — and reading it costs two small files,
  // so it does not wait for a button press.
  const out = await buildOverview(reader({ fs: checkoutFs() }))
  const row = out.thirdParty[0]

  assert.equal(row.version, '0.0.0', 'the version reported is package.json, unchanged')
  assert.equal(row.gitCommit, 'ef5d61a177228e3d317f85c63fbb09ea2e079284', 'the commit must be resolved on the overview')
  assert.equal(row.gitBranch, 'main')
  assert.equal(row.pathIsLink, true, 'the panel needs this flag, and the overview did not set it before')
  assert.match(String(row.gitRemote), /example\.invalid/)
})

test('overview: a checkout with no readable .git keeps its version and reports no commit', async () => {
  // A link to a plain directory is legitimate. It must not throw, and it must not
  // invent a commit.
  const out = await buildOverview(reader({ fs: checkoutFs({ isRepo: false }) }))
  const row = out.thirdParty[0]

  assert.equal(row.version, '0.0.0')
  assert.equal(row.gitCommit, undefined, 'no repo means no commit, and the row falls back to the version')
  assert.equal(row.pathIsLink, true, 'the path still points away from the profile')
})

test('overview: this package is listed FIRST, then alphabetical', async () => {
  // Self is positioned, not merely marked: it is the row whose own version and
  // source the reader is most likely checking, and the one most likely to be a
  // checkout under active edit.
  const out = await buildOverview(
    reader({
      fs: profileFs({
        'aaa-first': '^1.0.0',
        'dsh-plugin-manager': 'link:/checkout/dsh-plugin-manager',
        'zzz-last': '^1.0.0',
      }),
    }),
  )
  const names = out.thirdParty.map((plugin) => plugin.name)

  assert.equal(names[0], 'dsh-plugin-manager', 'self must be first regardless of name order')
  assert.deepEqual(names.slice(1), ['aaa-first', 'zzz-last'], 'the rest stays alphabetical')
})

// ── The regression that matters most ────────────────────────────────────────
//
// These projections must depend on NOTHING but their parameters. The same code
// is also authored as a dynamic Cordis Package (docs/host-notes.md F13), where
// the whole body is ONE function body with no module scope: a helper that
// reaches for an outer `ctx` there fails at RUN time with "ctx is not defined",
// which kills the RPC handler and leaves the panel with no data.
//
// Taking a `get` callback is what makes this testable here and portable there.
// This case fails loudly if anyone reintroduces a free variable.

test('the projections take every dependency as a parameter (no free variables)', async () => {
  const source = readFileSync(new URL('../src/host/overview.js', import.meta.url), 'utf8')
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`[^`]*`/g, '``')
    .replace(/'[^']*'/g, "''")
  assert.equal(
    /\bctx\s*[.[]/.test(stripped),
    false,
    'src/host/overview.js must not touch a ctx — take a `get` callback instead',
  )

  // Behavioural half: the whole read model works when handed nothing but a
  // reader, which is exactly what the RPC handler supplies.
  const out = await buildOverview(reader({ clientModules: { graph } }))
  assert.equal(out.entries.length, 3)
})
