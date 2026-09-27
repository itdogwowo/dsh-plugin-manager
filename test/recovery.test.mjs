/**
 * The reason a plugin has no git — and the way out — must come from the SPEC.
 *
 * ## The failure this pins
 *
 * A fresh profile that installs this tavern's sibling plugin the way ITS README
 * says (`dsh plugin add https://github.com/…/main.tar.gz`) gets an EXTRACTED
 * ARCHIVE. Every version tool in this panel reads `.git`, so all of them fail
 * together, and the panel said only:
 *
 *   載入版本 → no .git/HEAD and no .git file
 *   查遠端   → this checkout records no origin remote
 *
 * Both true, neither an answer. `recovery.js` is the answer, and this file holds
 * it to three properties that a screenshot cannot check:
 *
 *   1. the SPEC decides the reason — an archive spec can NEVER carry `.git`, so
 *      this is a property of the install and not of the moment the check ran;
 *   2. a spec that names a repository yields both commands, with the real URL;
 *   3. a spec that names only a NAME (a registry range) yields NO clone command,
 *      because a guessed `https://` prefix is a command that fails in a way the
 *      user cannot act on.
 *
 * It also pins the placeholder: the clone target is `<你放 clone 的位置>`, never a
 * real home directory. This repository is public, and a test is the only thing
 * that keeps a path out of it (AGENTS.md).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CLONE_PATH_PLACEHOLDER, checkoutCommands, checkoutRecovery, installDirIn, installDirOf, specRepository } from '../src/host/recovery.js'

/** The spec shape that started this: an archive URL, exactly as a README ships it. */
const TARBALL_SPEC = 'https://github.com/itdogwowo/dsh-tavern/archive/refs/heads/main.tar.gz'

/** Where that install lands inside a profile. */
const INSTALL_DIR = '/Users/<user>/.dsh/profiles/web/node_modules/dsh-tavern'

/**
 * Call the pure function the way the inventory does.
 * @param {string} spec - the dependency spec.
 * @param {object} [over] - extra input fields.
 * @returns {object} the recovery record.
 */
function recoveryFor(spec, over = {}) {
  return checkoutRecovery({ spec, name: 'dsh-tavern', profileName: 'web', dir: INSTALL_DIR, ...over })
}

test('recovery: a github: shorthand names its repository and both commands', () => {
  const out = recoveryFor('github:itdogwowo/dsh-tavern')

  assert.equal(out.applies, true)
  assert.equal(out.sourceKind, 'git')
  assert.equal(out.reason, 'archiveFromSpec')
  assert.equal(out.repoUrl, 'https://github.com/itdogwowo/dsh-tavern')
  assert.equal(out.owner, 'itdogwowo')
  assert.equal(out.repo, 'dsh-tavern')
  assert.equal(out.commands.clone, `git clone https://github.com/itdogwowo/dsh-tavern ${CLONE_PATH_PLACEHOLDER}`)
  assert.equal(out.commands.link, `dsh plugin --profile web add "link:${CLONE_PATH_PLACEHOLDER}"`)
  assert.equal(out.dir, INSTALL_DIR, 'the directory that was read is part of the answer')
})

test('recovery: a #ref pins content and still brings no history', () => {
  // The precise misunderstanding the panel's own install hint used to encourage:
  // "#ref" reads like "a version", and pnpm resolves it to a tarball too. The
  // reason must not change, and the fragment must not leak into the clone URL.
  const out = recoveryFor('github:itdogwowo/dsh-tavern#v2.6.72')

  assert.equal(out.reason, 'archiveFromSpec')
  assert.equal(out.repoUrl, 'https://github.com/itdogwowo/dsh-tavern')
  assert.equal(out.commands.clone.includes('#'), false, 'a ref is not part of a clone URL')
})

test('recovery: a tarball URL is recognised as a GitHub repository', () => {
  const out = recoveryFor(TARBALL_SPEC)

  assert.equal(out.applies, true)
  assert.equal(out.sourceKind, 'tarball')
  assert.equal(out.reason, 'archiveFromSpec')
  assert.equal(out.repoUrl, 'https://github.com/itdogwowo/dsh-tavern')
  assert.ok(out.commands.clone.includes('git clone https://github.com/itdogwowo/dsh-tavern'))
})

test('recovery: git+ and scp-style specs are read as remotes, not as text', () => {
  assert.equal(specRepository('git+https://github.com/owner/repo.git').repoUrl, 'https://github.com/owner/repo')
  assert.equal(specRepository('git+ssh://git@github.com/owner/repo.git').repoUrl, 'https://github.com/owner/repo')
  assert.equal(specRepository('git@github.com:owner/repo.git').repoUrl, 'https://github.com/owner/repo')
  // A registry range names no host, and must stay unparsed rather than guessed.
  assert.equal(specRepository('^1.2.0'), null)
  assert.equal(specRepository(null), null)
})

test('recovery: a registry spec gets the reason but NO invented clone command', () => {
  const out = recoveryFor('^1.2.0')

  assert.equal(out.applies, true)
  assert.equal(out.sourceKind, 'registry')
  assert.equal(out.reason, 'archiveFromRegistry')
  assert.equal(out.repoUrl, null, 'a name is not a URL')
  assert.equal(out.commands, null, 'no command is better than a command that cannot work')
})

test('recovery: a link: install that has no .git reports the path it read', () => {
  const out = recoveryFor('link:/Users/<user>/Documents/Git/dsh-tavern')

  assert.equal(out.applies, true)
  assert.equal(out.sourceKind, 'link')
  assert.equal(out.reason, 'linkNoRepo')
  // The spec's own path is the answer here, not the profile's node_modules: a
  // link that does not resolve is a path problem, and the reader needs to see
  // WHICH path.
  assert.equal(out.dir, '/Users/<user>/Documents/Git/dsh-tavern')
  assert.equal(out.commands, null)
})

test('recovery: the commands never carry a real home directory', () => {
  // This repository is public. The placeholder is the whole defence, and it is
  // asserted rather than trusted: a future edit that "helpfully" fills in the
  // user's home would put a real path in a committed test.
  const out = recoveryFor(TARBALL_SPEC)
  const text = `${out.commands.clone}\n${out.commands.link}`

  assert.ok(text.includes(CLONE_PATH_PLACEHOLDER), 'the placeholder must be in both commands')
  assert.equal(/\/Users\/[A-Za-z0-9._-]+\//.test(text), false, 'no real home directory may appear')
})

test('recovery: commands are built from the spec even without a directory', () => {
  // A dependency that is declared but not installed yet has no resolvedDir, and
  // the answer is still derivable — that is what makes it a SPEC fact.
  const out = checkoutRecovery({ spec: 'github:owner/repo', name: 'p', profileName: 'web', dir: null })

  assert.equal(out.applies, true)
  assert.equal(out.dir, null)
  assert.equal(out.commands.clone, `git clone https://github.com/owner/repo ${CLONE_PATH_PLACEHOLDER}`)
})

test('recovery: a spec the panel cannot classify still gets a reason', () => {
  // `owner/repo` shorthand and an empty spec are both reachable (a hand-edited
  // manifest), and neither may produce a blank panel row.
  for (const spec of ['owner/repo', '', null]) {
    const out = recoveryFor(spec)
    assert.equal(out.applies, true, `spec ${String(spec)} must produce a reason`)
    assert.equal(typeof out.reason, 'string')
    assert.ok(out.reason.length > 0)
  }
})

test('recovery: the install directory is read from the manifest path', () => {
  assert.equal(installDirOf('/p/node_modules/dsh-tavern/package.json'), '/p/node_modules/dsh-tavern')
  assert.equal(installDirOf('C:\\p\\node_modules\\dsh-tavern\\package.json'), 'C:\\p\\node_modules\\dsh-tavern')
  assert.equal(installDirOf('package.json'), null, 'a relative path names no directory here')
  assert.equal(installDirOf(null), null)
  assert.equal(installDirIn('/p', 'dsh-tavern'), '/p/node_modules/dsh-tavern')
  assert.equal(installDirIn(null, 'dsh-tavern'), null)
})

test('recovery: the two commands are the only thing offered, and neither runs', async () => {
  // A guard against scope creep with a real cost: this plugin must not grow a
  // `git clone` of its own behind a button (the same rule `install-hints.mjs`
  // states for installing git). The record is TEXT, and this asserts the shape
  // the panel renders — adding an argv, a spawn, or a run function here would
  // break it.
  const commands = checkoutCommands({ repoUrl: 'https://github.com/owner/repo', profileName: 'web' })

  assert.deepEqual(Object.keys(commands).sort(), ['clone', 'link'])
  for (const value of Object.values(commands)) assert.equal(typeof value, 'string')
})
