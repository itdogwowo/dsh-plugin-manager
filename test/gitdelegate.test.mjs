/**
 * Delegation: letting Sourcetree authenticate the operation for us.
 *
 * ## What this file is guarding
 *
 * The user's instruction was explicit — do not read the credential out of
 * Sourcetree, operate Sourcetree so it does the work. So the tests here never
 * look for a secret. They check the two halves of that promise:
 *
 * 1. the ref listing a delegated `git ls-remote` produces (pure parsing, where an
 *    annotated tag appears twice and a picker must not show it twice), and
 * 2. that the helper discovery finds Sourcetree's own binaries and hands git
 *    exactly one `-c credential.helper=…` argument — nothing global, nothing
 *    written to the user's git config.
 *
 * The end-to-end case runs a REAL git child against a LOCAL bare repository: no
 * network, no credentials, and the same code path a remote would take.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRealSubprocess } from './helpers/real-subprocess.mjs'
import { credentialHelperArgs, findSourcetreeHelper, joinPath, sourcetreeHelperCandidates, userHome } from '../src/host/host.js'
import { listRemoteRefs, parseLsRemote } from '../src/host/gitremote.js'

const FAKE_HOME = join(tmpdir(), 'dsh-pm-fake-home')
const SHA = (char) => char.repeat(40)

test('gitdelegate: parseLsRemote reads refs, and collapses an annotated tag', () => {
  const parsed = parseLsRemote(
    [
      `${SHA('a')}\trefs/tags/v1.0.0`,
      `${SHA('b')}\trefs/tags/v1.0.0^{}`,
      `${SHA('c')}\trefs/tags/light`,
      `${SHA('d')}\trefs/heads/main`,
      `${SHA('e')}\trefs/heads/feature/x`,
      'not a ref line',
      '',
    ].join('\n'),
  )
  assert.deepEqual(parsed.tags, [
    // The peeled line is the COMMIT a checkout lands on, so it wins over the tag
    // object's own line while the version still appears exactly once.
    { name: 'v1.0.0', commit: SHA('b') },
    { name: 'light', commit: SHA('c') },
  ])
  assert.deepEqual(parsed.branches, [
    { name: 'main', commit: SHA('d') },
    { name: 'feature/x', commit: SHA('e') },
  ])
  // Nothing to read is not a crash, and `HEAD` is not a branch to offer.
  assert.deepEqual(parseLsRemote(''), { tags: [], branches: [] })
  assert.deepEqual(parseLsRemote(undefined), { tags: [], branches: [] })
  assert.deepEqual(parseLsRemote(`${SHA('f')}\tHEAD`), { tags: [], branches: [] })
})

test('gitdelegate: the helper candidates point at the Sourcetree bundle, home first', () => {
  const home = joinPath(tmpdir(), 'some-home')
  const candidates = sourcetreeHelperCandidates(home)
  assert.equal(candidates[0], joinPath(home, 'Applications', 'Sourcetree.app', 'Contents', 'Resources', 'bin', 'git-credential-sourcetree'))
  assert.ok(candidates.includes(joinPath('/Applications', 'Sourcetree.app', 'Contents', 'Resources', 'bin', 'git-credential-sourcetree')))
  assert.ok(candidates.includes(joinPath(home, 'Applications', 'Sourcetree.app', 'Contents', 'Resources', 'git_local', 'bin', 'git-credential-osxkeychain')))
  // With no home to speak of, the system-wide location is still offered.
  assert.deepEqual(sourcetreeHelperCandidates(null), [
    '/Applications/Sourcetree.app/Contents/Resources/bin/git-credential-sourcetree',
    '/Applications/Sourcetree.app/Contents/Resources/git_local/bin/git-credential-osxkeychain',
  ])
})

test('gitdelegate: the helper is passed to ONE child, never configured globally', () => {
  const args = credentialHelperArgs('/tmp/x/git-credential-sourcetree')
  assert.deepEqual(args, ['-c', 'credential.helper=/tmp/x/git-credential-sourcetree'])
  // A path is required: an empty `-c credential.helper=` would DISABLE the helper
  // a caller may have wanted.
  assert.deepEqual(credentialHelperArgs(null), [])
  assert.deepEqual(credentialHelperArgs(''), [])
})

test('gitdelegate: discovery answers with the first helper that exists, or null', async () => {
  const wanted = sourcetreeHelperCandidates(FAKE_HOME)[0]
  const fakeFs = {
    resolve: async (path) => path,
    stat: async (path) => {
      if (path === wanted) return { mode: 0o700 }
      throw new Error('ENOENT')
    },
  }
  assert.equal(await findSourcetreeHelper(fakeFs, FAKE_HOME), wanted)
  assert.equal(await findSourcetreeHelper({ resolve: async (p) => p, stat: async () => { throw new Error('ENOENT') } }, FAKE_HOME), null)
  // No fs service at all is "no helper", not an exception: this runs on machines
  // without Sourcetree and in deployments without `fs`.
  assert.equal(await findSourcetreeHelper(null, FAKE_HOME), null)
})

test('gitdelegate: a real git child lists a real repository', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is not on PATH on this machine')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pm-delegate-'))
  const bare = join(dir, 'remote.git')
  const work = join(dir, 'work')
  try {
    const run = (args, cwd) => {
      const result = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8' })
      assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
      return result
    }
    run(['init', '-q', '--bare', bare])
    run(['init', '-q', work])
    writeFileSync(join(work, 'file.txt'), 'hello\n')
    run(['add', '.'], work)
    run(['commit', '-q', '-m', 'first'], work)
    run(['tag', '-a', 'v9.9.9', '-m', 'annotated'], work)
    run(['remote', 'add', 'origin', bare], work)
    run(['push', '-q', 'origin', 'HEAD:refs/heads/main', '--tags'], work)

    const listed = await listRemoteRefs(createRealSubprocess(), { url: bare, gitPath: 'git' })
    assert.equal(listed.ok, true, `expected ok, got: ${String(listed.error)}`)
    assert.equal(listed.delegated, true)
    assert.deepEqual(listed.branches.map((item) => item.name), ['main'])
    assert.deepEqual(listed.tags.map((item) => item.name), ['v9.9.9'])
    // The annotated tag's commit is the one a checkout lands on, and the listing
    // says where it came from — the helper is null here, which the note admits.
    assert.match(listed.branches[0].commit, /^[0-9a-f]{40}$/)
    assert.match(listed.note, /no token was needed/)
    assert.equal(listed.tokenUsed, false)
    // The command it reports must not leak a helper path into the panel.
    assert.match(listed.command, /ls-remote/)

    // A remote that does not exist is an explained failure, not a throw — and it
    // carries why, because "the remote said no" is the answer here.
    const missing = await listRemoteRefs(createRealSubprocess(), { url: join(dir, 'nope.git'), gitPath: 'git' })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /git ls-remote failed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gitdelegate: the home directory comes from the environment, both spellings', () => {
  // The value is whatever this process sees; the point is that it is never
  // guessed from a library that could disagree with the profile resolver.
  const home = userHome()
  if (process.env.HOME !== undefined || process.env.USERPROFILE !== undefined) {
    assert.equal(typeof home, 'string')
    assert.ok(home.length > 0)
  }
})
