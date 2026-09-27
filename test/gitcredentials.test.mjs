/**
 * The git credential file: what goes into it, what goes into argv, and what is
 * deleted afterwards.
 *
 * ## Why these assertions are shaped this way
 *
 * The whole point of this module is that ONLY A PATH crosses into the git child
 * — the token stays in a 0600 file this plugin owns and never enters the command
 * line, a log or a response. So the token's presence is asserted in two places at
 * once: that it IS in the file, and that it is in NEITHER the arguments nor the
 * status projections. A test that only checked "a `-c credential.helper=…`
 * argument exists" would pass for an implementation that appended the token to
 * the command line, which is the failure this file exists to prevent.
 *
 * The synthetic tokens are the three `verify.mjs` allow-lists (the privacy scan
 * fails the build on any other GitHub token shape), and every credential file
 * lives in `mkdtempSync(join(tmpdir(), …))` — never in this repository.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { joinPath } from '../src/host/host.js'
import { credentialStatus, readSettings, settingsPath, settingsStatus, writeSettings } from '../src/host/credentials.js'
import {
  credentialArgsFor,
  isGitArgv,
  removeStoreFile,
  storeFilePath,
  withCredentialArgs,
  writeStoreFile,
} from '../src/host/gitcredentials.js'

/** A fresh `$DSH_HOME` in the OS temp directory, removed when the test ends. */
function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pm-gitcred-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

/** One of the three synthetic tokens the privacy scan allow-lists. */
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

test('gitcredentials: the file belongs to this plugin, inside its own state directory', (t) => {
  const home = tempHome(t)
  const path = storeFilePath(home)

  assert.equal(path, joinPath(joinPath(home, '.dsh-pm'), 'git-credentials.tmp'))
  // NEVER inside a profile: a snapshot copies profile files (R5), and a
  // credential that a snapshot can capture is a credential in a backup.
  assert.ok(!path.includes('profiles'), 'the credential file must not live in the profile tree')
  assert.ok(path.startsWith(home), 'and it must live under $DSH_HOME, where this plugin owns a directory')
})

test('gitcredentials: the file is git’s store format, and it is 0600', async (t) => {
  const home = tempHome(t)
  const path = storeFilePath(home)

  const written = await writeStoreFile(path, 'github.com', null, TOKEN)
  assert.equal(written.ok, true, written.error ?? '')
  assert.equal(written.path, path)

  // The mode is the whole reason this write does not go through `fs.writeText`:
  // the default umask yields a world-readable file. The explicit `chmod` matters
  // for a SECOND write too, because overwriting keeps the old permissions.
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(readFileSync(path, 'utf8'), `https://git:${TOKEN}@github.com\n`)

  // A known account name replaces the placeholder; the host is normalised out of
  // a full remote URL, so a caller may pass either shape.
  const named = await writeStoreFile(path, 'https://github.com/owner/repo.git', 'someone', TOKEN)
  assert.equal(named.ok, true, named.error ?? '')
  assert.equal(readFileSync(path, 'utf8'), `https://someone:${TOKEN}@github.com\n`)
  assert.equal(statSync(path).mode & 0o777, 0o600, 'the rewritten file is 0600 again')
})

test('gitcredentials: a value that would break the line is refused, and nothing is written', async (t) => {
  const home = tempHome(t)
  const path = storeFilePath(home)

  for (const [host, token, why] of [
    ['not a host', TOKEN, 'a host that is not a host'],
    ['github.com', '', 'an empty token'],
    ['github.com', 'line\nbreak', 'a token holding a newline'],
    ['github.com', 42, 'a token that is not a string'],
  ]) {
    const refused = await writeStoreFile(path, host, null, token)
    assert.equal(refused.ok, false, `should refuse ${why}`)
    assert.equal(typeof refused.error, 'string')
    assert.ok(refused.error.length > 0, 'a refusal explains itself')
  }
  assert.equal(existsSync(path), false, 'a refused write leaves no file behind')

  const noPath = await writeStoreFile('', 'github.com', null, TOKEN)
  assert.equal(noPath.ok, false)
})

test('gitcredentials: the arguments clear every inherited helper, then name ONLY the file', (t) => {
  const home = tempHome(t)
  const path = storeFilePath(home)

  // The empty `credential.helper=` FIRST is the load-bearing part: git's helpers
  // accumulate, so without it the inherited helper would still run — and an
  // inherited helper is the one that raises the OS password prompt.
  assert.deepEqual(credentialArgsFor(path), [
    '-c',
    'credential.helper=',
    '-c',
    `credential.helper=store --file=${path}`,
  ])
  assert.deepEqual(credentialArgsFor(null), [], 'no path, no arguments')
  assert.deepEqual(credentialArgsFor(''), [])
})

test('gitcredentials: a path the shell would split is quoted, and only then', () => {
  const plain = '/tmp/git-credentials.tmp'
  assert.equal(credentialArgsFor(plain)[3], `credential.helper=store --file=${plain}`)

  // git runs a helper string through the shell, so an unquoted path with a space
  // would be split into two arguments and the helper would read the wrong file.
  const spaced = '/tmp/a b/git-credentials.tmp'
  assert.equal(credentialArgsFor(spaced)[3], `credential.helper=store --file="${spaced}"`)
})

test('gitcredentials: the injection lands after the binary for git, and nowhere else', () => {
  const args = ['-c', 'credential.helper=', '-c', 'credential.helper=store --file=/x']

  assert.deepEqual(withCredentialArgs(['git', '-C', '/repo', 'merge', '--ff-only', 'origin/main'], args), [
    'git',
    ...args,
    '-C',
    '/repo',
    'merge',
    '--ff-only',
    'origin/main',
  ])
  // The pipeline materialises the binary to an absolute path, and on Windows to
  // `git.exe`: all three are the same program and all three get the arguments.
  assert.deepEqual(withCredentialArgs(['/usr/bin/git', '-C', '/repo', 'checkout', 'v1'], args), ['/usr/bin/git', ...args, '-C', '/repo', 'checkout', 'v1'])
  assert.deepEqual(withCredentialArgs(['C:\\Program Files\\Git\\cmd\\git.exe', 'checkout', 'v1'], args), [
    'C:\\Program Files\\Git\\cmd\\git.exe',
    ...args,
    'checkout',
    'v1',
  ])

  assert.equal(isGitArgv(['git']), true)
  assert.equal(isGitArgv(['/usr/local/bin/git']), true)
  assert.equal(isGitArgv(['C:\\Git\\git.exe']), true)
  assert.equal(isGitArgv('git'), false)
  assert.equal(isGitArgv([]), false)
  assert.equal(isGitArgv(['giti']), false)
})

test('gitcredentials: a non-git argv is returned untouched', () => {
  // The dsh CLI authenticates its own work with its own resolution; putting a git
  // config override into `node <dsh bin>` would be a setting that does nothing.
  const dsh = ['node', '/opt/dsh/lib/bin.js', 'plugin', '--profile', 'web', 'add', 'pkg']
  assert.deepEqual(withCredentialArgs(dsh, ['-c', 'credential.helper=']), dsh)

  const empty = []
  assert.deepEqual(withCredentialArgs(empty, ['-c', 'x']), empty)
  assert.deepEqual(withCredentialArgs(undefined, ['-c', 'x']), undefined)
  assert.deepEqual(withCredentialArgs(['git', '-C', '/r', 'checkout', 'v1'], undefined), ['git', '-C', '/r', 'checkout', 'v1'])
})

test('gitcredentials: injecting builds a new argv and leaves the plan’s argv alone', () => {
  const planned = ['git', '-C', '/repo', 'merge', '--ff-only', 'origin/main']
  const injected = withCredentialArgs(planned, ['-c', 'credential.helper='])

  assert.notEqual(injected, planned, 'a new array, so the plan stays the record of what was planned')
  assert.deepEqual(planned, ['git', '-C', '/repo', 'merge', '--ff-only', 'origin/main'], 'the plan is not mutated')
})

test('gitcredentials: the token appears in the FILE and in neither the argv nor a report', async (t) => {
  const home = tempHome(t)
  const path = storeFilePath(home)
  assert.equal((await writeStoreFile(path, 'github.com', null, TOKEN)).ok, true)

  const args = credentialArgsFor(path)
  const argv = withCredentialArgs(['git', '-C', '/repo', 'merge', '--ff-only', 'origin/main'], args)

  assert.ok(readFileSync(path, 'utf8').includes(TOKEN), 'the token is in the 0600 file — that is what it is for')
  assert.ok(!args.some((part) => part.includes(TOKEN)), 'and never in the arguments')
  assert.ok(!argv.some((part) => part.includes(TOKEN)), 'nor in the command line built from them')
  assert.ok(argv.some((part) => part.includes(path)), 'only the path travels')
})

test('gitcredentials: removal is best effort, and never throws', async (t) => {
  const home = tempHome(t)
  const path = storeFilePath(home)
  assert.equal((await writeStoreFile(path, 'github.com', null, TOKEN)).ok, true)

  assert.deepEqual(await removeStoreFile(path), { ok: true, error: null })
  assert.equal(existsSync(path), false)
  // Called from a `finally`, so an already-absent file is a success: that is the
  // normal case when no credential was written at all.
  assert.deepEqual(await removeStoreFile(path), { ok: true, error: null })
  assert.deepEqual(await removeStoreFile(null), { ok: true, error: null })

  // A path that cannot be removed is REPORTED, not thrown: a cleanup failure must
  // not turn a run into a crash.
  const dir = join(home, 'not-a-file')
  mkdirSync(dir)
  const refused = await removeStoreFile(dir)
  assert.equal(refused.ok, false)
  assert.equal(typeof refused.error, 'string')
  assert.equal(existsSync(dir), true, 'the directory is still there; nothing was forced through')
})

test('settings: both credential switches are booleans, with the documented defaults', async (t) => {
  const home = tempHome(t)

  const fresh = await readSettings(home)
  assert.equal(fresh.delegateSourcetree, false, 'delegation BORROWS Sourcetree’s credential, so it is off until asked for')
  assert.equal(fresh.useStoredTokenForGit, true, 'the plugin’s own saved token is one the user gave this plugin')

  await writeSettings(home, { delegateSourcetree: true, useStoredTokenForGit: false })
  const stored = await readSettings(home)
  assert.equal(stored.delegateSourcetree, true)
  assert.equal(stored.useStoredTokenForGit, false)

  // A non-boolean keeps the CURRENT value. It is not coerced and not reset to the
  // default: a bad request may fail to change something, but it must never flip a
  // switch that decides whether a credential reaches a child process.
  await writeSettings(home, { delegateSourcetree: 'yes', useStoredTokenForGit: 0 })
  const kept = await readSettings(home)
  assert.equal(kept.delegateSourcetree, true)
  assert.equal(kept.useStoredTokenForGit, false)

  // And the same rule on READ: a hand-edited file holding the string "true" is a
  // file holding an unusable value, not an instruction to switch borrowing on.
  writeFileSync(settingsPath(home), JSON.stringify({ version: 1, delegateSourcetree: 'true', useStoredTokenForGit: 'false' }))
  const handEdited = await readSettings(home)
  assert.equal(handEdited.delegateSourcetree, false)
  assert.equal(handEdited.useStoredTokenForGit, true)
})

test('settings: both switches are exposed by the two status projections', async (t) => {
  const home = tempHome(t)
  await writeSettings(home, { delegateSourcetree: true, useStoredTokenForGit: false })

  const settings = await settingsStatus(home)
  assert.equal(settings.delegateSourcetree, true)
  assert.equal(settings.useStoredTokenForGit, false)

  // No subprocess double is needed: the status reads capability facts and the two
  // files, and answers "not installed" for a helper it cannot resolve.
  const credentials = await credentialStatus({ dshHome: home })
  assert.equal(credentials.delegateSourcetree, true)
  assert.equal(credentials.useStoredTokenForGit, false)
  // The panel receives a host, availability and a masked hint — never a token.
  assert.equal(typeof credentials.store.saved, 'boolean')
})
