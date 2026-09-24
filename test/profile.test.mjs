/**
 * "Which plugins are 非原裝?" is answered from the profile manifest, not from
 * the boot graph: a shipped bundle is listed in `dsh.profile.bundles` but never
 * in `dependencies`, so the dependencies map is the whole discriminator.
 *
 * The other half of this suite is about *failing honestly*. The profile
 * location is inferred, so "no plugins installed" and "could not read the
 * profile" must never look the same — that distinction cost a whole debugging
 * round (docs/host-notes.md F17).
 *
 * **Every fixture path is built with `join`/`resolve`, never with a literal
 * drive letter or hardcoded separator**, so the suite runs unchanged on Windows,
 * macOS and Linux: `p('profiles', 'web')` is `X:\harness\.dsh\profiles\web` on
 * Windows and `/X:/harness/.dsh/profiles/web` on POSIX, and no assertion depends
 * on which.
 *
 * The `fs` service is stubbed in memory — no real profile is read, and no
 * process is spawned.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'

import {
  activeProfile,
  buildPluginInventory,
  classifySpec,
  profileDir,
  profileDirCandidates,
  readManifest,
  setHomedirReader,
} from '../src/host/profile.js'

/** Build fake absolute path segments — absolute on every platform. */
function p(...segments) {
  return resolve('X:', 'harness', '.dsh', ...segments)
}

/** Split an absolute path into segments for `join`, on any separator. */
function segmentsOf(path) {
  return path.split(/[\\/]/).filter((part) => part.length > 0)
}

const HOME = p()
const PROFILE = p('profiles', 'web')
/**
 * The environment cleared for tests that must not touch the real profile.
 *
 * `os.homedir()` still consults the real machine regardless of these, which is
 * why `setHomedirReader` exists — see the note on that seam.
 */
const NO_ENV = { DSH_HOME: undefined, DSH_PROFILE: undefined, USERPROFILE: undefined, HOME: undefined }

/**
 * Pin the OS home to a fake directory for the duration of `body`.
 *
 * Without this, `os.homedir()` returns the developer's real home and the
 * candidate list depends on the machine, not on the input.
 */
function withFakeOsHome(home, body) {
  setHomedirReader(() => home)
  try {
    return body()
  } finally {
    setHomedirReader(undefined)
  }
}

/**
 * An `fs` service over an in-memory table of path → text.
 *
 * Keys are built with `path.join` exactly as the production code builds them, so
 * the table matches on every platform rather than only where `/` is the
 * separator.
 * @param {Array} entries - `[[path segments], text]` pairs.
 * @param {string | undefined} [base] - where `resolve('.')` points. The host's
 *   own fs base directory IS the profile directory (docs/host-notes.md F17), so
 *   a test that omits this exercises the environment fallbacks.
 */
function fakeFs(entries, base) {
  const files = new Map()
  for (const [parts, text] of entries) files.set(join(...parts), text)

  return {
    async resolve(path) {
      if (path === '.' && base !== undefined) return { targetKey: `key:${base}`, displayPath: base }
      if (path === '.') throw new Error('cannot resolve ".": no base configured for this stub')
      return { targetKey: `key:${path}`, displayPath: path }
    },
    async readText(target) {
      const text = files.get(target.displayPath)
      if (text === undefined) throw new Error(`cannot read "${target.displayPath}": not found`)
      return text
    },
  }
}

/** Run `body` with the given environment, restoring it afterwards. */
function withEnv(env, body) {
  const saved = {}
  for (const key of Object.keys(env)) saved[key] = process.env[key]
  const previousArgv = process.argv

  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    return body()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    process.argv = previousArgv
  }
}

test('classifySpec: every install form is classified with the right change signal', () => {
  // The change signal matters: a tarball URL spec never changes even when its
  // content does, so integrity — not the spec — is what detects an update.
  const cases = [
    ['link:/checkout/plugin', 'link', 'resolvedDir'],
    ['file:./plugin.tgz', 'file', 'integrity'],
    ['workspace:*', 'workspace', 'resolvedDir'],
    ['github:owner/repo', 'git', 'integrity'],
    ['git+https://host/repo.git', 'git', 'integrity'],
    ['https://host/releases/latest/download/plugin.tgz', 'tarball-url', 'integrity'],
    ['npm:real-name@^1.0.0', 'alias', 'integrity'],
    ['latest', 'tag-or-range', 'integrity'],
    ['^1.2.3', 'registry', 'integrity'],
    ['1.2.3', 'registry', 'integrity'],
  ]

  for (const [spec, sourceType, changeSignal] of cases) {
    assert.deepEqual(classifySpec(spec), { sourceType, changeSignal }, `spec: ${spec}`)
  }
})

test('classifySpec: a non-string spec degrades to registry rather than throwing', () => {
  assert.equal(classifySpec(undefined).sourceType, 'registry')
  assert.equal(classifySpec(null).sourceType, 'registry')
})

test('activeProfile: DSH_PROFILE wins over argv, and web is the alias fallback', () => {
  withEnv({ DSH_PROFILE: 'from-env' }, () => {
    assert.deepEqual(activeProfile(), { name: 'from-env', source: 'DSH_PROFILE' })
  })

  withEnv({ DSH_PROFILE: undefined }, () => {
    process.argv = ['node', 'bin.js', '--profile', 'from-argv']
    assert.deepEqual(activeProfile(), { name: 'from-argv', source: 'argv' })

    // `dsh web` is a hardcoded alias for `--profile web`.
    process.argv = ['node', 'bin.js', 'web']
    assert.deepEqual(activeProfile(), { name: 'web', source: 'argv-alias' })

    process.argv = ['node', 'bin.js']
    assert.deepEqual(activeProfile(), { name: 'web', source: 'fallback' })
  })
})

test('candidates: the OS home comes second, and the default name is retried', () => {
  // The profile name and the harness home are both inferred, so both get a
  // second chance: `renamed` then `web`, and DSH_HOME then the OS home.
  const osHome = resolve('X:', 'other')
  const fromOsHome = join(osHome, '.dsh', 'profiles', 'web')

  return withFakeOsHome(osHome, () =>
    withEnv(NO_ENV, () => {
      const noDsHome = profileDirCandidates().map((candidate) => candidate.dir)
      assert.deepEqual(noDsHome, [fromOsHome], 'the OS home is the only source once DSH_HOME is cleared')

      process.env.DSH_HOME = HOME
      process.env.DSH_PROFILE = 'renamed'
      const dirs = profileDirCandidates().map((candidate) => candidate.dir)

      assert.deepEqual(dirs.slice(0, 2), [p('profiles', 'renamed'), p('profiles', 'web')])
      assert.ok(dirs.includes(fromOsHome), 'the OS home must also be tried')
      assert.equal(profileDir().dir, p('profiles', 'renamed'))
    }),
  )
})

test('readManifest: the fs base directory IS the profile, with NO environment at all', async () => {
  // This is the strategy that actually works on the reference deployment, and
  // the one that matters: the host half may have no usable `process`, so the
  // environment must not be required.
  const manifest = JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { alpha: '1.0.0' },
    dsh: { profile: { bundles: [] } },
  })
  const fs = fakeFs([[segmentsOf(PROFILE).concat('package.json'), manifest]], PROFILE)

  const result = await withFakeOsHome(resolve('X:', 'other'), () => withEnv(NO_ENV, () => readManifest(fs)))

  assert.equal(result.ok, true, 'the fs base directory must be enough on its own')
  assert.equal(result.profile.source, 'fs-base')
  assert.equal(result.profile.name, 'web')
  assert.equal(result.manifestPath, join(PROFILE, 'package.json'))
  assert.match(result.attempts[0].detail, /fs base directory is the profile/)
})

test('readManifest: a base directory that is not a profile falls through to the environment', async () => {
  const checkout = resolve('X:', 'checkout')
  const fs = fakeFs(
    [
      [segmentsOf(checkout).concat('package.json'), JSON.stringify({ name: 'not-a-profile' })],
      [
        segmentsOf(PROFILE).concat('package.json'),
        JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } } }),
      ],
    ],
    checkout,
  )

  const result = await withFakeOsHome(resolve('X:', 'other'), () => withEnv({ ...NO_ENV, DSH_HOME: HOME, DSH_PROFILE: 'web' }, () => readManifest(fs)))

  assert.equal(result.ok, true)
  assert.equal(result.profile.source, 'DSH_PROFILE')
  assert.equal(result.manifestPath, join(PROFILE, 'package.json'))
  // The rejected base-directory attempt is still on the record.
  assert.match(result.attempts[0].detail, /carries no dsh/)
})

test('readManifest: an unreadable profile reports the reason AND every path tried', async () => {
  const fs = fakeFs([])

  const result = await withFakeOsHome(resolve('X:', 'other'), () => withEnv({ ...NO_ENV, DSH_HOME: HOME, DSH_PROFILE: 'web' }, () => readManifest(fs)))

  assert.equal(result.ok, false)
  assert.match(result.reason, /no candidate profile manifest could be read/)

  // The base-directory attempt is always recorded first: either it resolved and
  // the manifest was unreadable, or resolving itself failed.
  const first = result.attempts[0]
  assert.ok(
    first.path === 'fs.resolve(".")' || first.path === join(PROFILE, 'package.json'),
    `unexpected first attempt: ${first.path}`,
  )
  assert.ok(result.attempts.length >= 2, 'the fallback candidates must also be recorded')
  assert.match(result.attempts[result.attempts.length - 1].detail, /not found/)
})

test('readManifest: a missing fs is a distinct reason, never a throw', async () => {
  const result = await withFakeOsHome(resolve('X:', 'other'), () => withEnv({ ...NO_ENV, DSH_HOME: HOME, DSH_PROFILE: 'web' }, () => readManifest(undefined)))

  assert.equal(result.ok, false)
  assert.match(result.reason, /fs service is not available/)
})

test('readManifest: invalid JSON is reported per attempt, never thrown', async () => {
  const fs = fakeFs([[segmentsOf(PROFILE).concat('package.json'), '{ not json']])

  const result = await withFakeOsHome(resolve('X:', 'other'), () => withEnv({ ...NO_ENV, DSH_HOME: HOME, DSH_PROFILE: 'web' }, () => readManifest(fs)))

  assert.equal(result.ok, false)
  assert.ok(result.attempts.length >= 1)
  for (const attempt of result.attempts) assert.equal(typeof attempt.detail, 'string')
})

test('readManifest: a manifest with no dsh is rejected and the next candidate tried', async () => {
  const fs = fakeFs([
    [segmentsOf(p('profiles', 'renamed')).concat('package.json'), JSON.stringify({ name: 'not-a-profile' })],
    [
      segmentsOf(PROFILE).concat('package.json'),
      JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } } }),
    ],
  ])

  const result = await withFakeOsHome(resolve('X:', 'other'), () => withEnv({ ...NO_ENV, DSH_HOME: HOME, DSH_PROFILE: 'renamed' }, () => readManifest(fs)))

  assert.equal(result.ok, true)
  assert.equal(result.profile.name, 'web', 'the default name is the second chance')
  // One base attempt, then the rejected candidate, then the one that worked.
  assert.equal(result.attempts.length, 3)
  assert.match(result.attempts[1].detail, /carries no dsh/)
})

test('inventory: only dependencies are third-party; shipped bundles are excluded', async () => {
  const fs = fakeFs([
    [
      segmentsOf(PROFILE).concat('package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        dependencies: {
          'dsh-plugin-manager': 'link:/checkout/dsh-plugin-manager',
          'dsh-tavern': 'link:/checkout/dsh-tavern',
          '@liustack/modsearch': '5.10.3',
        },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-tavern'] } },
      }),
    ],
    [
      segmentsOf(PROFILE).concat('node_modules', 'dsh-plugin-manager', 'package.json'),
      JSON.stringify({
        name: 'dsh-plugin-manager',
        version: '0.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
      }),
    ],
    [
      segmentsOf(PROFILE).concat('node_modules', 'dsh-tavern', 'package.json'),
      JSON.stringify({ name: 'dsh-tavern', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    ],
    // @liustack/modsearch is intentionally absent: a dependency whose install
    // directory is gone must still be listed, with a null version.
  ])

  const inventory = await withFakeOsHome(resolve('X:', 'other'), () =>
    withEnv({ ...NO_ENV, DSH_HOME: HOME, DSH_PROFILE: 'web' }, () =>
      buildPluginInventory(fs, 'dsh-plugin-manager'),
    ),
  )

  assert.equal(inventory.available, true)
  assert.equal(inventory.plugins.length, 3)
  // Self first, then alphabetical. This plugin is the one whose own version and
  // source the reader is most likely checking, and the one most likely to be a
  // local checkout under active edit — so it is positioned, not merely marked.
  assert.deepEqual(
    inventory.plugins.map((plugin) => plugin.name),
    ['dsh-plugin-manager', '@liustack/modsearch', 'dsh-tavern'],
  )
  assert.equal(inventory.plugins[0].self, true, 'the first row must be this package')

  const self = inventory.plugins.find((plugin) => plugin.name === 'dsh-plugin-manager')
  assert.equal(self.self, true, 'this package must flag itself rather than hide')
  assert.equal(self.version, '0.0.0')
  assert.equal(self.declaresBundle, true)
  assert.equal(self.sourceType, 'link')
  assert.equal(self.changeSignal, 'resolvedDir')
  assert.equal(self.inBundles, false)

  const tavern = inventory.plugins.find((plugin) => plugin.name === 'dsh-tavern')
  assert.equal(tavern.self, false)
  assert.equal(tavern.version, '1.2.3')
  assert.equal(tavern.inBundles, true)

  const missing = inventory.plugins.find((plugin) => plugin.name === '@liustack/modsearch')
  assert.equal(missing.version, null, 'a dependency with no install dir still appears, with no version')
  assert.equal(missing.declaresBundle, false)

  // Shipped bundles are never dependencies, so they never appear here.
  assert.equal(
    inventory.plugins.some((plugin) => plugin.name.startsWith('@deepseek-ai/')),
    false,
  )
  assert.deepEqual(inventory.declaredBundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-tavern'])
})

test('inventory: an unavailable manifest still yields a JSON-safe shape with a reason', async () => {
  const inventory = await withFakeOsHome(resolve('X:', 'other'), () =>
    withEnv({ ...NO_ENV, DSH_HOME: HOME, DSH_PROFILE: 'web' }, () =>
      buildPluginInventory(undefined, 'dsh-plugin-manager'),
    ),
  )

  assert.equal(inventory.available, false)
  assert.equal(typeof inventory.reason, 'string')
  assert.deepEqual(inventory.plugins, [])
  assert.deepEqual(inventory.declaredBundles, [])
  assert.equal(typeof JSON.parse(JSON.stringify(inventory)), 'object')
})

test('inventory: a manifest without dependencies yields an empty list, not an error', async () => {
  const fs = fakeFs([
    [
      segmentsOf(PROFILE).concat('package.json'),
      JSON.stringify({ name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: [] } } }),
    ],
  ])

  const inventory = await withFakeOsHome(resolve('X:', 'other'), () =>
    withEnv({ ...NO_ENV, DSH_HOME: HOME, DSH_PROFILE: 'web' }, () =>
      buildPluginInventory(fs, 'dsh-plugin-manager'),
    ),
  )

  // Readable but empty is a real answer — and it is distinct from unavailable.
  assert.equal(inventory.available, true)
  assert.equal(inventory.reason, null)
  assert.deepEqual(inventory.plugins, [])
})
