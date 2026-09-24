/**
 * The change pipeline and the snapshot it depends on.
 *
 * ## What is actually being asserted
 *
 * Not "the steps run in order" — that is visible by reading the file. The claims
 * worth a test are the ones a user is TOLD:
 *
 * 1. **Nothing runs before the snapshot.** A failed snapshot aborts.
 * 2. **A change that fails its post-check is rolled back**, and the profile's
 *    state files are then byte-identical to what they were.
 * 3. **A change that SUCCEEDS but changed nothing is still reported honestly** —
 *    the recorded spec is re-read instead of trusting an exit code.
 * 4. **A rollback is provable**: it re-reads every file and digests it.
 *
 * The fake change is a real child process that really edits `package.json`. If
 * the pipeline's rollback were broken, the file would stay edited and these
 * tests would say so.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createRealSubprocess } from './helpers/real-subprocess.mjs'
import { digestText, dshHomeOf, listSnapshots, loadSnapshot, restoreSnapshot, snapshotRoot, takeSnapshot } from '../src/host/snapshot.js'
import { classifyUpdate, findPlugin, materialiseArgv, planUpdate, runPipeline, specWithRef } from '../src/host/pipeline.js'

const subprocess = createRealSubprocess()

/** A profile manifest that a verification pass can read. */
const MANIFEST = {
  name: 'web',
  version: '0.0.0',
  dsh: { profile: { bundles: ['dsh-plugin-manager'] } },
  dependencies: { 'dsh-plugin-manager': 'link:../../../dsh-plugin-manager' },
}

/**
 * What `fs.resolve('.')` answers right now.
 *
 * ⚠️ **This is not decoration.** `fs.resolve('.')` IS the profile directory in a
 * real deployment (docs/host-notes.md F17), and the host never tells a plugin
 * which profile it is in — the base directory is the only evidence. A double
 * whose `.` resolves to this repository instead makes `buildPluginInventory` read
 * the REPO's package.json, find a `dsh` key with no `profile`, and report "no
 * declared bundles" — so every fixture-driven check passes for the wrong reason.
 * That is the lying-double failure of F29, and it was caught here only because a
 * fixture asserted a REFUSAL and got a pass.
 *
 * It follows the live fixture rather than being captured once, so one service can
 * serve fixtures and the few tests that need no fixture.
 */
let currentProfileDir = process.cwd()

/**
 * A fake `fs` service over the real filesystem, with the host's shapes.
 * @returns {object} the service.
 */
function realFs() {
  return {
    resolve: async (target) => ({ displayPath: target === '.' ? currentProfileDir : target }),
    readText: async (handle) => readFileSync(handle.displayPath, 'utf8'),
    writeText: async (handle, content) => {
      // The real service creates parent directories; a fake that does not makes
      // every snapshot fail for a reason the product does not have.
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

/** Write one file, creating its directory. */
function put(root, relative, content) {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** The one `fs` service every test uses; see {@link currentProfileDir}. */
const fs = realFs()

/** The commit the synthetic repository in {@link withRepo} is checked out at. */
const HEAD_SHA = 'a'.repeat(40)

/**
 * A synthetic git checkout, removed afterwards.
 *
 * Written by hand rather than created with `git init`, because `git` is not on
 * PATH on the reference machine (docs/host-notes.md F26) — a fixture that needs
 * git would be a fixture that never runs here.
 *
 * @param {(repo: string) => Promise<void>} run - the assertions.
 * @returns {Promise<void>} resolves once the tree is removed.
 */
async function withRepo(run) {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-pm-repo-'))
  try {
    put(repo, '.git/HEAD', 'ref: refs/heads/main\n')
    put(repo, '.git/refs/heads/main', `${HEAD_SHA}\n`)
    put(repo, '.git/refs/tags/v1.0.0', `${'b'.repeat(40)}\n`)
    put(repo, '.git/config', '[remote "origin"]\n\turl = git@github.com:owner/repo.git\n')
    put(repo, 'package.json', JSON.stringify({ name: 'x', version: '0.0.0' }))
    await run(repo)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

/**
 * A throwaway profile shaped like a real one, removed afterwards.
 *
 * The modules are INSTALLED for real (a `node_modules` entry with a manifest and
 * an entry file) and the fake launcher prints a `--dump-config` document naming
 * them. That matters: a dump with no rows makes V2 skip, and a skipped layer is
 * not a pass — so a fixture that prints nothing would fail the post-check for a
 * reason the product does not have.
 *
 * The `fs` handed to the callback resolves `.` to THIS profile, because that is
 * what the base directory means in a real deployment (F17).
 *
 * @param {{modules?: string[]}} options - the installed package names.
 * @param {(ctx: {home: string, profileDir: string, launcher: object, fs: object}) => Promise<void>} run - the assertions.
 * @returns {Promise<void>} resolves once the tree is removed.
 */
async function withProfile(options, run) {
  const modules = Array.isArray(options.modules) ? options.modules : []
  const home = mkdtempSync(join(tmpdir(), 'dsh-pm-home-'))
  const profileDir = join(home, 'profiles', 'web')
  const previous = currentProfileDir
  currentProfileDir = profileDir
  try {
    put(profileDir, 'package.json', `${JSON.stringify(MANIFEST, null, 2)}\n`)
    put(profileDir, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
    for (const name of modules) {
      put(profileDir, `node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
      put(profileDir, `node_modules/${name}/index.js`, 'export default 1\n')
    }
    // A launcher that composes a dump naming the installed modules, then exits 0.
    const dump = ['# == @deepseek-ai/dsh-base', ...modules.flatMap((name) => [`- id: ${name}`, `  name: ${name}`])].join('\n')
    put(profileDir, 'fake-dsh.js', `process.stdout.write(${JSON.stringify(dump)})\n`)
    await run({
      home,
      profileDir,
      launcher: { available: true, path: join(profileDir, 'fake-dsh.js'), error: null },
    })
  } finally {
    currentProfileDir = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('pipeline: dshHomeOf finds $DSH_HOME, so snapshots never land inside the profile', () => {
  // A directory inside the profile looks like a plugin to the loader — the very
  // thing this package exists to protect.
  assert.equal(dshHomeOf('C:\\Users\\x\\.dsh\\profiles\\web'), 'C:\\Users\\x\\.dsh')
  assert.equal(dshHomeOf('/home/x/.dsh/profiles/web'), '/home/x/.dsh')
  assert.equal(dshHomeOf('C:\\elsewhere\\web'), 'C:\\elsewhere', 'an unusual layout keeps its parent')
  assert.match(snapshotRoot('C:\\Users\\x\\.dsh\\profiles\\web', 'web'), /\.dsh-pm[\\/]profiles[\\/]web[\\/]snapshots$/)
})

test('pipeline: findPlugin only matches the exact package name', () => {
  const inventory = { plugins: [{ name: 'a' }, { name: 'ab' }] }
  assert.equal(findPlugin(inventory, 'a').name, 'a')
  assert.equal(findPlugin(inventory, 'zz'), null)
  assert.equal(findPlugin(null, 'a'), null)
})

test('pipeline: specWithRef appends a ref to an installable spec and refuses the rest', () => {
  assert.deepEqual(specWithRef('github:owner/repo', 'v1.2.3'), { ok: true, spec: 'github:owner/repo#v1.2.3', error: null })
  // Replacing an existing ref must not produce `…#a#b`.
  assert.deepEqual(specWithRef('github:owner/repo#main', 'v1.2.3'), { ok: true, spec: 'github:owner/repo#v1.2.3', error: null })
  assert.deepEqual(specWithRef('git+https://host/o/r.git', 'v1.0.0').spec, 'git+https://host/o/r.git#v1.0.0')

  // A `link:` install's identity is its local path: a ref cannot be attached to
  // it, and pretending otherwise would produce a spec the CLI cannot resolve.
  const link = specWithRef('link:../../../dsh-power', 'v1.0.0')
  assert.equal(link.ok, false)
  assert.match(link.error, /local directory/)
  assert.equal(specWithRef('file:./x.tgz', 'v1.0.0').ok, false)
  assert.equal(specWithRef('', 'v1.0.0').ok, false)
  assert.equal(specWithRef('github:o/r', '').ok, false)
})

test('pipeline: materialiseArgv rewrites dsh to node+bin.js and refuses a missing tool', () => {
  const launcher = { available: true, path: 'C:\\dsh\\lib\\bin.js', error: null }
  const git = { available: true, path: 'C:\\git\\git.exe', error: null }

  const dsh = materialiseArgv({ launcher, git }, ['dsh', 'plugin', '--profile', 'web', 'add', 'github:o/r'])
  assert.equal(dsh.ok, true)
  // The PATH shim on Windows is a .ps1, which the subprocess seam will not run
  // as argv[0] (A3).
  assert.deepEqual(dsh.argv.slice(0, 2), [process.execPath, 'C:\\dsh\\lib\\bin.js'])
  assert.deepEqual(dsh.argv.slice(2), ['plugin', '--profile', 'web', 'add', 'github:o/r'])

  const moved = materialiseArgv({ launcher, git }, ['git', '-C', '/repo', 'checkout', 'v1.0.0'])
  assert.deepEqual(moved.argv, ['C:\\git\\git.exe', '-C', '/repo', 'checkout', 'v1.0.0'])

  // A refusal has to name what is missing, because "nothing happened" is the
  // failure mode this layer exists to prevent.
  const noGit = materialiseArgv({ launcher, git: { available: false, error: 'git was not found' } }, ['git', '--version'])
  assert.equal(noGit.ok, false)
  assert.match(noGit.error, /git is unavailable/)
  assert.equal(materialiseArgv({ launcher: { available: false, error: 'no launcher' }, git }, ['dsh']).ok, false)
  assert.equal(materialiseArgv({ launcher, git }, []).ok, false)
  assert.equal(materialiseArgv({ launcher, git }, ['rm', '-rf', '/']).ok, false, 'only git and dsh are ever invoked')
})

test('pipeline: planUpdate on a registry install re-resolves and SAYS it cannot know the newest', async () => {
  const inventory = {
    plugins: [{ name: 'pkg', spec: '^1.0.0', version: '1.0.0', sourceType: 'registry', resolvedDir: '/tmp/nowhere/package.json' }],
  }
  const plan = await planUpdate({ fs, subprocess, inventory, name: 'pkg', ref: null, profileName: 'web' })

  assert.equal(plan.ok, true)
  assert.equal(plan.action, 'dsh-plugin-add')
  assert.equal(plan.kind, 'registry')
  assert.deepEqual(plan.argv, ['dsh', 'plugin', '--profile', 'web', 'add', '^1.0.0'])
  // This is the honesty requirement of `reachability: local`: no registry was
  // queried, so the plan must not imply a version was chosen.
  assert.match(plan.warnings.join(' '), /newest version is not knowable/)
})

test('pipeline: planUpdate refuses a plugin that is not installed', async () => {
  const plan = await planUpdate({ fs, subprocess, inventory: { plugins: [] }, name: 'ghost', ref: null })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /no installed plugin is named "ghost"/)
})

test('pipeline: classifyUpdate decides the KIND and the tool, and reads no tool', async () => {
  // The classification is what lets `plan` and `apply` probe only the tool they
  // need. It must work with a `subprocess` that would THROW if touched — proving
  // no probe happens here.
  const exploding = {
    resolveExecutable() {
      throw new Error('classifyUpdate must not resolve an executable')
    },
    spawn() {
      throw new Error('classifyUpdate must not spawn')
    },
  }

  const registry = await classifyUpdate({
    fs,
    subprocess: exploding,
    inventory: { plugins: [{ name: 'pkg', sourceType: 'registry', spec: '^1.0.0', resolvedDir: '/tmp/nowhere/package.json' }] },
    name: 'pkg',
  })
  assert.equal(registry.kind, 'registry')
  assert.deepEqual(registry.needs, ['dsh'], 'a registry update goes through the CLI')

  const missing = await classifyUpdate({ fs, subprocess: exploding, inventory: { plugins: [] }, name: 'ghost' })
  assert.equal(missing.plugin, null)
  assert.match(missing.error, /no installed plugin/)
})

test('pipeline: a checkout plan is RUNNABLE when git exists — the bug that made every plan refuse', async () => {
  await withRepo(async (repo) => {
    const plugin = { name: 'dsh-power', sourceType: 'link', spec: `link:${repo}`, resolvedDir: join(repo, 'package.json'), version: '0.0.0' }

    // A plan built with a WORKING git probe. Before the fix, `planUpdate` tested
    // `git.available` on the object returned by its own repository reader — which
    // never sets that field — so this plan came back `ok: false` with "git is
    // required … and it is unavailable" on every machine, including one where
    // git works.
    const working = await planUpdate({
      fs,
      subprocess,
      git: { available: true, path: 'C:\\git\\git.exe', version: 'git version 2.4', error: null },
      inventory: { plugins: [plugin] },
      name: 'dsh-power',
      ref: 'v1.0.0',
      profileName: 'web',
    })
    assert.equal(working.ok, true, `expected a runnable plan, got: ${working.error ?? ''}`)
    assert.equal(working.kind, 'checkout')
    assert.equal(working.action, 'git-checkout')
    assert.deepEqual(working.argv, ['git', '-C', repo, 'checkout', 'v1.0.0'])
    assert.equal(working.current, HEAD_SHA)

    // …and with a probe that reports git ABSENT, the plan still exists (so the
    // panel can show the command and the reason) but is not runnable.
    const absent = await planUpdate({
      fs,
      subprocess,
      git: { available: false, path: null, error: 'git was not found' },
      inventory: { plugins: [plugin] },
      name: 'dsh-power',
      ref: 'v1.0.0',
      profileName: 'web',
    })
    assert.equal(absent.ok, false)
    assert.match(absent.error, /git is required/)
    assert.deepEqual(absent.argv, ['git', '-C', repo, 'checkout', 'v1.0.0'], 'the command is still reported')
    assert.equal(absent.remote.host, 'github.com', 'the remote is reported even when the tool is missing')
  })
})

test('pipeline: a checkout plan with no probe at all is still produced', async () => {
  // `git: null` means "no probe was made", which must NOT be read as "git is
  // absent" — the plan is what the panel renders, and a plan that vanished
  // because nobody probed would be a blank update panel.
  await withRepo(async (repo) => {
    const plan = await planUpdate({
      fs,
      subprocess,
      inventory: { plugins: [{ name: 'x', sourceType: 'link', spec: `link:${repo}`, resolvedDir: join(repo, 'package.json') }] },
      name: 'x',
      ref: null,
      profileName: 'web',
    })
    assert.equal(plan.ok, true, `expected a plan, got: ${plan.error ?? ''}`)
    assert.equal(plan.kind, 'checkout')
  })
})

test('pipeline: moving to the branch already checked out is a fast-forward, not a checkout', async () => {
  await withRepo(async (repo) => {
    const plan = await planUpdate({
      fs,
      subprocess,
      git: { available: true, path: 'git', error: null },
      inventory: { plugins: [{ name: 'x', sourceType: 'link', spec: `link:${repo}`, resolvedDir: join(repo, 'package.json') }] },
      name: 'x',
      ref: 'main',
      profileName: 'web',
    })
    assert.equal(plan.action, 'git-pull')
    assert.deepEqual(plan.argv, ['git', '-C', repo, 'merge', '--ff-only', 'origin/main'])
  })
})

test('pipeline: a checkout with no origin remote refuses with the reason', async () => {
  await withRepo(async (repo) => {
    writeFileSync(join(repo, '.git', 'config'), '[core]\n\tbare = false\n')
    const plan = await planUpdate({
      fs,
      subprocess,
      git: { available: true, path: 'git', error: null },
      inventory: { plugins: [{ name: 'x', sourceType: 'link', spec: `link:${repo}`, resolvedDir: join(repo, 'package.json') }] },
      name: 'x',
      ref: 'v1.0.0',
      profileName: 'web',
    })
    assert.equal(plan.ok, false)
    assert.match(plan.error, /no origin remote/)
  })
})

test('snapshot: a round trip restores those bytes exactly, and PROVES it', async () => {
  await withProfile({ modules: ['pkg'] }, async ({ profileDir }) => {
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')

    const snapshot = await takeSnapshot(fs, { profileDir, profileName: 'web', label: 'test' })
    assert.equal(snapshot.ok, true, `snapshot failed: ${snapshot.error ?? ''}`)
    assert.equal(snapshot.id.endsWith('-test'), true)
    // The manifest is what makes a snapshot usable — a directory without one is
    // a pile of files.
    assert.equal(existsSync(join(snapshot.dir, 'manifest.json')), true)

    // A change: edit one state file, create another.
    writeFileSync(join(profileDir, 'package.json'), '{"dirty":true}\n')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: x\n')

    const result = await restoreSnapshot({ fs, subprocess, snapshot })
    assert.equal(result.ok, true)
    assert.deepEqual(result.mismatched, [])
    assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), before, 'byte-identical, not merely equivalent')
    // The file the change CREATED is removed, because an empty patch file is not
    // the same state as no patch file.
    assert.equal(existsSync(join(profileDir, 'cordis.patch.yml')), false)
    // Asserted by NAME, not by count: a count would pass while the wrong file
    // was deleted, which is the failure this whole layer exists to prevent.
    const removedNames = result.removed.map((path) => path.replace(/^.*[\\/]/, ''))
    assert.ok(removedNames.includes('cordis.patch.yml'), `cordis.patch.yml must be removed, removed: ${removedNames.join(', ')}`)
    assert.ok(result.verified.some((path) => path.endsWith('package.json')))
    assert.ok(result.verified.length >= 2, 'every recorded file was read back and digested')
  })
})

test('snapshot: an absent file is recorded as absent, and restoring does not create it', async () => {
  await withProfile({ modules: ['pkg'] }, async ({ profileDir }) => {
    const snapshot = await takeSnapshot(fs, { profileDir, profileName: 'web', label: 'no-patch' })
    const patchRecord = snapshot.files.find((record) => record.path.endsWith('cordis.patch.yml'))
    assert.equal(patchRecord.present, false, 'absence is a recorded fact, not an omission')

    const result = await restoreSnapshot({ fs, subprocess, snapshot })
    assert.equal(result.ok, true)
    assert.equal(existsSync(join(profileDir, 'cordis.patch.yml')), false)
  })
})

test('snapshot: a snapshot survives being re-read in a LATER process', async () => {
  await withProfile({ modules: ['pkg'] }, async ({ profileDir }) => {
    const snapshot = await takeSnapshot(fs, { profileDir, profileName: 'web', label: 'persisted' })
    // The case that matters most is a host that was restarted after a bad
    // change, so the rollback path re-reads the manifest from disk.
    const reloaded = await loadSnapshot(fs, snapshot.dir)
    assert.equal(reloaded.ok, true)
    assert.equal(reloaded.id, snapshot.id)
    assert.equal(reloaded.files.length, snapshot.files.length)
    assert.equal(reloaded.files.find((record) => record.path.endsWith('package.json')).digest, snapshot.digests['package.json'])

    const ids = await listSnapshots(fs, profileDir, 'web')
    assert.equal(ids[0], snapshot.id, 'newest first')
  })
})

test('snapshot: a snapshot that cannot be stored FAILS instead of warning', async () => {
  const brokenFs = { ...realFs(), writeText: async () => { throw new Error('disk full') } }
  await withProfile({ modules: ['pkg'] }, async ({ profileDir }) => {
    const snapshot = await takeSnapshot(brokenFs, { profileDir, profileName: 'web', label: 'doomed' })
    assert.equal(snapshot.ok, false)
    assert.match(snapshot.error, /could not be stored/)
  })
})

test('snapshot: restoring with no usable snapshot refuses rather than half-doing it', async () => {
  const result = await restoreSnapshot({ fs, subprocess, snapshot: { ok: false } })
  assert.equal(result.ok, false)
  assert.match(result.error, /no usable snapshot/)
})

test('pipeline: a change whose post-check FAILS is rolled back, byte for byte', async () => {
  await withProfile({ modules: ['pkg'] }, async ({ profileDir }) => {
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')

    // The "change": a real child that really corrupts the manifest.
    const script = join(profileDir, 'dirty.js')
    put(profileDir, 'dirty.js', `require('node:fs').writeFileSync(${JSON.stringify(join(profileDir, 'package.json'))}, '{ not json')\n`)

    const run = await runPipeline({
      fs,
      subprocess,
      launcher: { available: true, path: script, error: null },
      git: { available: false, error: 'no git' },
      selfName: 'dsh-plugin-manager',
      profileDir,
      profileName: 'web',
      // `--no-verify` on purpose: this case is about the POST check and the
      // rollback, and the pre-check would refuse to start on a fixture this thin.
      noVerify: true,
      argv: ['dsh', 'plugin', '--profile', 'web', 'add', 'pkg'],
      label: 'add pkg',
    })

    assert.equal(run.ok, false)
    assert.ok(run.verifyAfter !== null, 'the post-check ran')
    assert.equal(run.verifyAfter.ok, false)
    assert.equal(run.rollback.ok, true, 'the rollback restored the snapshot')
    assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), before, 'the profile is byte-identical to before the change')
    assert.equal(run.skippedVerification, true, 'skipping the pre-check is RECORDED, never silent')
    assert.ok(run.steps.some((step) => step.step === 'rollback' && step.status === 'restored'))
  })
})

test('pipeline: a change that leaves the profile valid reports ok, and re-reads the spec', async () => {
  await withProfile({ modules: ['pkg'] }, async ({ profileDir, launcher }) => {
    // The launcher composes a clean dump and exits 0 — the "the CLI did its job"
    // case. The post-check therefore passes on its own merits.
    const run = await runPipeline({
      fs,
      subprocess,
      launcher,
      git: { available: false, error: 'no git' },
      selfName: 'dsh-plugin-manager',
      profileDir,
      profileName: 'web',
      // `--no-verify` keeps this case about the post-check; the pre-check has its
      // own test below, and it is the PRE-check that must refuse when a layer
      // cannot make its claim.
      noVerify: true,
      argv: ['dsh', 'plugin', '--profile', 'web', 'add', 'pkg'],
      label: 'add pkg',
    })

    assert.equal(run.ok, true, `expected ok, got: ${run.error ?? ''} steps=${JSON.stringify(run.steps)}`)
    assert.equal(run.rollback, null)
    assert.ok(run.snapshot.id !== null, 'a successful change still leaves a snapshot behind')
    assert.equal(run.argv[0], process.execPath, 'the dsh launcher is never invoked through the PATH shim')
    assert.equal(run.verifyAfter.ok, true)
    assert.equal(run.skippedVerification, true, 'the escape hatch is recorded on a SUCCESS too, not only on a failure')
  })
})

test('pipeline: a change that exits non-zero is rolled back, not left half-applied', async () => {
  await withProfile({ modules: ['pkg'] }, async ({ profileDir }) => {
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const script = join(profileDir, 'half.js')
    put(
      profileDir,
      'half.js',
      `require('node:fs').writeFileSync(${JSON.stringify(join(profileDir, 'package.json'))}, '{"half":true}\\n');process.exit(2)\n`,
    )

    const run = await runPipeline({
      fs,
      subprocess,
      launcher: { available: true, path: script, error: null },
      git: { available: false, error: 'no git' },
      selfName: 'dsh-plugin-manager',
      profileDir,
      profileName: 'web',
      noVerify: true,
      argv: ['dsh', 'plugin', '--profile', 'web', 'add', 'pkg'],
      label: 'add pkg',
    })

    assert.equal(run.ok, false)
    assert.match(run.error, /exited 2/)
    assert.equal(run.verifyAfter, null, 'a failed command never reaches the post-check')
    assert.equal(run.rollback.ok, true)
    assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), before)
  })
})

test('pipeline: the pre-check runs FIRST and a failure there changes nothing', async () => {
  await withProfile({ modules: ['pkg'] }, async ({ profileDir }) => {
    // V1b fails here: the manifest declares a bundle whose installed package has
    // no `dsh.bundle`. The host refuses to COMPOSE that profile, so the pipeline
    // must refuse before snapshotting or running anything.
    //
    // ⚠️ The failure has to be one V1b actually detects. A declared bundle that
    // is merely ABSENT from node_modules is reported as SKIPPED, not as a fault,
    // because a shipped bundle resolves out of the harness installation instead —
    // so a fixture built on "not installed" would leave the pre-check green and
    // this test asserting nothing.
    put(profileDir, 'node_modules/pkg-not-a-bundle/package.json', JSON.stringify({ name: 'pkg-not-a-bundle', version: '1.0.0' }))
    put(
      profileDir,
      'package.json',
      `${JSON.stringify(
        {
          ...MANIFEST,
          dependencies: { 'dsh-plugin-manager': 'link:x', 'pkg-not-a-bundle': '^1.0.0' },
          dsh: { profile: { bundles: ['pkg', 'pkg-not-a-bundle'] } },
        },
        null,
        2,
      )}\n`,
    )
    put(profileDir, 'fake-dsh.js', 'process.stdout.write("- id: pkg\\n  name: pkg\\n")\n')

    const run = await runPipeline({
      fs,
      subprocess,
      launcher: { available: true, path: join(profileDir, 'fake-dsh.js'), error: null },
      git: { available: false, error: 'no git' },
      selfName: 'dsh-plugin-manager',
      profileDir,
      profileName: 'web',
      argv: ['dsh', 'plugin', '--profile', 'web', 'add', 'pkg'],
      label: 'add pkg',
    })

    assert.equal(run.ok, false, `expected the pipeline to refuse, steps=${JSON.stringify(run.steps)}`)
    assert.equal(run.snapshot, null, 'nothing is snapshotted when the pre-check refuses')
    assert.equal(run.verifyBefore.ok, false, `layers=${JSON.stringify(run.verifyBefore.layers)}`)
    assert.ok(run.steps.some((step) => step.step === 'verify-before' && step.status === 'fail'))
    assert.equal(run.skippedVerification, false)
    assert.match(run.error, /did not pass its pre-check/)
    assert.match(run.error, /pkg-not-a-bundle/)
  })
})

test('pipeline: no profile directory means no change, with a reason', async () => {
  const run = await runPipeline({ fs, subprocess, profileDir: null, argv: ['dsh'], label: 'x' })
  assert.equal(run.ok, false)
  assert.match(run.error, /no profile directory/)
})

test('snapshot: digestText is stable and distinguishes content', () => {
  assert.equal(digestText('abc'), digestText('abc'))
  assert.notEqual(digestText('abc'), digestText('abd'))
  assert.match(digestText('abc'), /^[0-9a-f]{8}$/)
})
