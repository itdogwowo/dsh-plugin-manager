/**
 * Reading a checkout's refs — the version/branch picker's evidence.
 *
 * The fixtures are synthetic `.git` trees written by the test, because `git` is
 * not on PATH on the reference machine (docs/host-notes.md F26) and a test that
 * needs git would be a test that never runs here. What is checked is the READER
 * against the formats git actually writes, including the two that are easy to
 * get wrong: packed refs, and an annotated tag whose peeled commit is the one a
 * checkout lands on.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  compareVersions,
  locateGitDir,
  looksLikeVersionRef,
  parsePackedRefs,
  parseRemoteRefs,
  parseRemoteUrl,
  readLocalRefs,
  remoteApiFor,
} from '../src/host/gitrefs.js'

/** A fake `fs` service over the real filesystem, with the host's shapes. */
function realFs() {
  return {
    resolve: async (target) => ({ displayPath: target }),
    readText: async (handle) => readFileSync(handle.displayPath, 'utf8'),
    writeText: async (handle, content) => {
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

const fs = realFs()

/** Write one file, creating its directory. */
function put(root, relative, content) {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/**
 * Build a synthetic checkout, run the callback, then remove the tree.
 * @param {(dir: string) => void} build - writes the `.git` contents.
 * @param {(dir: string) => Promise<void>} run - the assertions.
 * @returns {Promise<void>} resolves once the tree is removed.
 */
async function withRepo(build, run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pm-repo-'))
  try {
    mkdirSync(join(dir, '.git'), { recursive: true })
    build(dir)
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('gitrefs: parsePackedRefs keeps peeled commits attached to their tag', () => {
  const parsed = parsePackedRefs(
    ['# pack-refs with: peeled fully-peeled sorted', 'aaa111 refs/heads/main', 'bbb222 refs/tags/v1.0.0', '^ccc333', 'ddd444 refs/tags/v0.9.0'].join('\n'),
  )
  assert.equal(parsed.refs['refs/heads/main'], 'aaa111')
  assert.equal(parsed.refs['refs/tags/v1.0.0'], 'bbb222')
  // The peeled line belongs to the tag ABOVE it, not to the next one.
  assert.equal(parsed.peeled['refs/tags/v1.0.0'], 'ccc333')
  assert.equal(parsed.refs['refs/tags/v0.9.0'], 'ddd444')
  assert.equal(parsed.peeled['refs/tags/v0.9.0'], undefined)
})

test('gitrefs: compareVersions sorts NEWEST FIRST (negative means left is newer)', () => {
  // ⚠️ Read the operator, not the wording. The contract is a comparator for a
  // newest-first sort, so `compareVersions(a, b) < 0` means **a sorts first, so
  // a is NEWER**. That is the opposite of the reflex "a < b means a is smaller",
  // and it cost three rounds of editing this file and its comparator against
  // each other. Every assertion below therefore states what each SIDE is.
  const newer = (a, b, whatAIs) => assert.ok(compareVersions(a, b) < 0, `${a} (${whatAIs}) must sort first`)

  // Numbers compare numerically. A text sort puts 1.9.0 above 1.10.0.
  newer('v1.10.0', 'v1.9.0', 'the newer minor')
  newer('v10.0.0', 'v2.0.0', 'the newer major')
  assert.ok(compareVersions('v2.0.0', 'v10.0.0') > 0, 'v2.0.0 sorts later — it is older')

  // A release outranks its own pre-release, and `rc` outranks `alpha`.
  newer('v1.2.0', 'v1.2.0-rc.1', 'the release')
  newer('v1.2.0', 'v1.2.0-beta', 'the release')
  newer('v1.2.1', 'v1.2.0-rc.9', 'the later patch')

  // A tag with no digits sorts last, so a codename never displaces a version.
  newer('v1.0.0', 'nightly', 'a real version tag')

  assert.equal(compareVersions('v1.2.3', 'v1.2.3'), 0)
})

test('gitrefs: compareVersions handles a PREFIXED tag, which is the common shape', () => {
  // Real tags on the reference machine look like `dsh-v0.1.7-rc.1`. A prefixed
  // tag splits into WORD segments, and a text compare then decides the ordering
  // — which is how `v2.0.0` came out "newer" than `v10.0.0` until the embedded
  // number was compared first.
  assert.ok(compareVersions('dsh-v0.1.7-rc.1', 'dsh-v0.1.7-alpha.2') < 0, 'rc sorts before alpha')
  assert.ok(compareVersions('dsh-v0.1.7', 'dsh-v0.1.6') < 0, 'the newer patch sorts first')
  assert.ok(compareVersions('dsh-v0.10.0', 'dsh-v0.2.0') < 0, '0.10.0 is newer than 0.2.0')
  // A tag with no digits at all sorts last, so a codename never displaces a
  // version at the top of the picker.
  assert.ok(compareVersions('nightly', 'v1.0.0') > 0)
})

test('gitrefs: looksLikeVersionRef separates versions from codenames', () => {
  assert.equal(looksLikeVersionRef('v1.2.3'), true)
  assert.equal(looksLikeVersionRef('0.1.5-rc.3'), true)
  assert.equal(looksLikeVersionRef('nightly'), false)
  assert.equal(looksLikeVersionRef('release-two'), false)
})

test('gitrefs: an attached checkout reports its branch, commit and refs', async () => {
  await withRepo(
    (dir) => {
      put(dir, '.git/HEAD', 'ref: refs/heads/main\n')
      put(dir, '.git/refs/heads/main', `${'a'.repeat(40)}\n`)
      put(dir, '.git/refs/heads/feature/x', `${'b'.repeat(40)}\n`)
      put(dir, '.git/refs/tags/v1.0.0', `${'c'.repeat(40)}\n`)
      put(dir, '.git/refs/tags/v1.9.0', `${'d'.repeat(40)}\n`)
      put(dir, '.git/refs/tags/v1.10.0', `${'e'.repeat(40)}\n`)
      put(dir, '.git/refs/tags/nightly', `${'f'.repeat(40)}\n`)
      put(dir, '.git/refs/remotes/origin/main', `${'a'.repeat(40)}\n`)
      put(dir, '.git/config', '[remote "origin"]\n\turl = git@github.com:owner/repo.git\n')
    },
    async (dir) => {
      const refs = await readLocalRefs(fs, dir)
      assert.equal(refs.ok, true)
      assert.equal(refs.head.attached, true)
      assert.equal(refs.head.branch, 'main')
      assert.equal(refs.branches.length, 2)
      assert.ok(
        refs.branches.some((row) => row.name === 'feature/x'),
        'a nested branch name survives',
      )

      // Ordering is the feature: the newest version comes first so the picker
      // can preselect it.
      assert.deepEqual(
        refs.versionTags.map((row) => row.name),
        ['v1.10.0', 'v1.9.0', 'v1.0.0'],
      )
      assert.equal(refs.tags.length, 4, 'the codename tag is still listed, just not as a version')
      assert.equal(refs.newestTag, 'v1.10.0')

      // `current` is decided against HEAD, so the checked-out branch is marked
      // and the others are not.
      assert.equal(refs.branches.find((row) => row.name === 'main').current, true)
      assert.equal(refs.branches.find((row) => row.name === 'feature/x').current, false)
      assert.match(refs.source, /no fetch was run/)
    },
  )
})

test('gitrefs: packed refs are read when the loose files are absent', async () => {
  await withRepo(
    (dir) => {
      put(dir, '.git/HEAD', 'ref: refs/heads/main\n')
      put(
        dir,
        '.git/packed-refs',
        ['# pack-refs with: peeled', `${'a'.repeat(40)} refs/heads/main`, `${'b'.repeat(40)} refs/tags/v2.0.0`, `^${'c'.repeat(40)}`].join('\n'),
      )
    },
    async (dir) => {
      const refs = await readLocalRefs(fs, dir)
      assert.equal(refs.head.commit, 'a'.repeat(40), 'a packed branch still resolves HEAD')
      assert.equal(refs.tags.length, 1)
      // An annotated tag: the peeled commit is what a checkout lands on, so it
      // is what `current` is compared against.
      assert.equal(refs.tags[0].peeled, 'c'.repeat(40))
    },
  )
})

test('gitrefs: a detached HEAD is a state, not an error', async () => {
  await withRepo(
    (dir) => {
      put(dir, '.git/HEAD', `${'9'.repeat(40)}\n`)
      put(dir, '.git/refs/tags/v1.0.0', `${'9'.repeat(40)}\n`)
    },
    async (dir) => {
      const refs = await readLocalRefs(fs, dir)
      assert.equal(refs.ok, true)
      assert.equal(refs.head.attached, false)
      assert.equal(refs.head.branch, null)
      assert.equal(refs.head.commit, '9'.repeat(40))
      assert.equal(refs.tags[0].current, true, 'the tag pointing at the detached commit is marked current')
    },
  )
})

test('gitrefs: a directory that is not a checkout degrades to a reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pm-norepo-'))
  try {
    const refs = await readLocalRefs(fs, dir)
    assert.equal(refs.ok, false)
    assert.match(refs.error, /no \.git\/HEAD/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gitrefs: a .git FILE (worktree or submodule) is followed, not refused', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'dsh-pm-wt-'))
  try {
    put(outer, 'worktree/.git', 'gitdir: ../real-git-dir\n')
    put(outer, 'real-git-dir/HEAD', 'ref: refs/heads/main\n')
    put(outer, 'real-git-dir/refs/heads/main', `${'a'.repeat(40)}\n`)

    const located = await locateGitDir(fs, join(outer, 'worktree'))
    assert.match(located.via, /file \(worktree or submodule\)/)
    const refs = await readLocalRefs(fs, join(outer, 'worktree'))
    assert.equal(refs.ok, true)
    assert.equal(refs.head.branch, 'main')
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

test('gitrefs: parseRemoteUrl understands the four spellings that occur', () => {
  const scp = parseRemoteUrl('git@github.com:owner/repo.git')
  assert.equal(scp.ok, true)
  assert.equal(scp.host, 'github.com')
  assert.equal(scp.owner, 'owner')
  assert.equal(scp.repo, 'repo')
  assert.equal(scp.webUrl, 'https://github.com/owner/repo')

  const https = parseRemoteUrl('https://github.com/owner/repo.git')
  assert.equal(https.ok, true)
  assert.equal(https.repo, 'repo')

  const ssh = parseRemoteUrl('ssh://git@github.com/owner/repo.git')
  assert.equal(ssh.host, 'github.com')
  assert.equal(ssh.owner, 'owner')

  const local = parseRemoteUrl('C:\\code\\repo')
  assert.equal(local.kind, 'local')
  assert.equal(local.ok, false, 'a local remote has nothing to query, and that is a real answer')

  const nonsense = parseRemoteUrl('not a url at all')
  assert.equal(nonsense.ok, false)
  assert.match(nonsense.error, /owner\/repository|not a shape/)
})

test('gitrefs: remoteApiFor only claims a provider it has verified', () => {
  const github = remoteApiFor(parseRemoteUrl('git@github.com:owner/repo.git'))
  assert.equal(github.provider, 'github')
  assert.match(github.tags, /^https:\/\/api\.github\.com\/repos\/owner\/repo\/tags/)
  assert.match(github.note, /60 requests per hour/)

  // Guessing another host's endpoint would produce a failure the user cannot act
  // on; "no API for this host" is actionable.
  assert.equal(remoteApiFor(parseRemoteUrl('git@gitlab.com:owner/repo.git')), null)
  assert.equal(remoteApiFor(null), null)
})

test('gitrefs: parseRemoteRefs reads the published payload shapes', () => {
  const parsed = parseRemoteRefs(
    [
      { name: 'v1.0.0', commit: { sha: 'a'.repeat(40) } },
      { name: 'v1.10.0', commit: { sha: 'b'.repeat(40) } },
      { name: 'no-commit-field' },
    ],
    [
      { name: 'main', commit: { sha: 'c'.repeat(40) }, protected: true },
      { name: 'dev', commit: { sha: 'd'.repeat(40) } },
    ],
  )
  assert.deepEqual(
    parsed.tags.map((row) => row.name),
    ['v1.10.0', 'v1.0.0', 'no-commit-field'],
    'version tags are ordered newest first',
  )
  assert.equal(parsed.tags[2].commit, null, 'a missing sha is null, never an invented one')
  assert.deepEqual(parsed.branches.map((row) => row.name), ['dev', 'main'])
  assert.equal(parsed.branches.find((row) => row.name === 'main').protected, true)

  // A payload that is not a list must not become an empty confident answer.
  assert.deepEqual(parseRemoteRefs({ message: 'Not Found' }, null), { tags: [], branches: [] })
})
