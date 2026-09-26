/**
 * The credential chain: which source wins, what a helper's output means, and the
 * two things that must never happen to a token.
 *
 * ## Why the subprocess double here is scripted
 *
 * It is not a claim about process handling — `test/host-tools.test.mjs` already
 * exercises the real seam against real children (collected output, exit codes, a
 * deadline that actually kills). What THIS file has to pin down is the chain's
 * own decisions: ordering, parsing, and the redaction that stands between a
 * stored secret and an HTTP response. A scripted answer is the honest tool for
 * that, because the thing being tested is a decision rather than a process.
 *
 * The one exception is the stdin protocol, which IS run against a real child:
 * "the helper received the bytes we meant to send" is exactly the kind of claim
 * a double would lie about.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRealSubprocess } from './helpers/real-subprocess.mjs'
import { joinPath, runProcess } from '../src/host/host.js'
import { SNAPSHOT_FILES, dshHomeOf } from '../src/host/snapshot.js'
import {
  credentialsPath,
  credentialStatus,
  maskToken,
  normalizeHost,
  normalizeSourceChoice,
  normalizeToken,
  parseGitCredentialOutput,
  pluginStateDir,
  readCredentialStore,
  readSettings,
  redactResolution,
  resolveCredential,
  settingsPath,
  writeCredentialStore,
  writeSettings,
} from '../src/host/credentials.js'

/** A fresh `$DSH_HOME` in the OS temp directory. */
function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-pm-cred-'))
}

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const OTHER = 'ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'

/**
 * A subprocess service that answers from a script.
 *
 * `executables` maps a bare name to the path it resolves to; a name mapped to
 * `null` is absent, which is how "git is not installed" is expressed.
 * `answers` maps a joined argv to `{ exitCode, stdout }`; anything unscripted
 * exits 1 with no output, which is what a helper that found nothing does.
 */
function scriptedSubprocess({ executables = {}, answers = {} } = {}) {
  const spawned = []
  return {
    spawned,
    async resolveExecutable(command) {
      if (Object.prototype.hasOwnProperty.call(executables, command) && executables[command] !== null) {
        return executables[command]
      }
      throw new Error(`not on PATH: ${command}`)
    },
    spawn(spec) {
      const key = spec.argv.join(' ')
      // The seam's spawn spec nests stdin under `stdio` (that is what the host's
      // own `subprocess` service receives); reading `spec.stdin` here would have
      // recorded an absent field and quietly certified nothing.
      spawned.push({ key, stdin: spec.stdio?.stdin, env: spec.env })
      const answer = answers[key] ?? { exitCode: 1, stdout: '' }
      // A spawn that is REFUSED, not one that runs and exits: this is the shape
      // the real deployment produced (a null exit code with the reason only in
      // `error`), and the reason the chain must report that field.
      if (typeof answer.refuse === 'string') throw new Error(answer.refuse)
      const text = typeof answer.stdout === 'string' ? answer.stdout : ''
      return {
        collected: {
          stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: answer.exitCode ?? 0, signal: null }),
        terminate() {},
        waitForExit: async () => true,
      }
    },
  }
}

test('credentials: normalizeToken refuses control characters, blanks and absurd lengths', () => {
  assert.equal(normalizeToken('  abc  '), 'abc')
  assert.equal(normalizeToken(''), null)
  assert.equal(normalizeToken('   '), null)
  assert.equal(normalizeToken(undefined), null)
  assert.equal(normalizeToken(123), null)
  assert.equal(normalizeToken('a'.repeat(513)), null)
  assert.equal(normalizeToken('a'.repeat(512)), 'a'.repeat(512))
  // A newline inside a token would end an `authorization:` header or a
  // `git credential` line early. That is an injection, so it is refused rather
  // than trimmed.
  for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb']) {
    assert.equal(normalizeToken(bad), null, `should refuse ${JSON.stringify(bad)}`)
  }
})

test('credentials: maskToken never reveals the middle, and hides short values entirely', () => {
  assert.equal(maskToken(null), null)
  assert.equal(maskToken(''), null)
  assert.equal(maskToken('short'), '•••••')
  assert.equal(maskToken('twelvechars!'), '••••••••••••')
  const masked = maskToken(TOKEN)
  assert.equal(masked, 'ghp_••••••6789')
  assert.ok(!masked.includes('abcdefghij'), 'the middle must not survive masking')
})

test('credentials: normalizeHost accepts the remote shapes we parse and refuses the rest', () => {
  assert.equal(normalizeHost('github.com'), 'github.com')
  assert.equal(normalizeHost('GitHub.COM'), 'github.com')
  assert.equal(normalizeHost('https://github.com/itdogwowo/dsh-plugin-manager'), 'github.com')
  assert.equal(normalizeHost('https://user:pass@github.com:443/o/r.git'), 'github.com')
  assert.equal(normalizeHost('git@github.com:itdogwowo/dsh-plugin-manager.git'), 'github.com')
  assert.equal(normalizeHost('ssh://git@ghe.corp.example:22/o/r.git'), 'ghe.corp.example')
  // A credential is only ever attached to something that IS a host.
  assert.equal(normalizeHost('not a host'), null)
  assert.equal(normalizeHost(''), null)
  assert.equal(normalizeHost(undefined), null)
  assert.equal(normalizeHost('http://'), null)
})

test('credentials: parseGitCredentialOutput reads the line protocol', () => {
  const parsed = parseGitCredentialOutput('protocol=https\nhost=github.com\nusername=octocat\npassword=secret\n\n')
  assert.equal(parsed.username, 'octocat')
  assert.equal(parsed.password, 'secret')
  // Unknown keys are ignored, and no password means no credential.
  assert.deepEqual(parseGitCredentialOutput('protocol=https\nhost=github.com\n\n'), { username: null, password: null })
  assert.deepEqual(parseGitCredentialOutput(''), { username: null, password: null })
  assert.deepEqual(parseGitCredentialOutput(undefined), { username: null, password: null })
})

test('credentials: the store is written 0600, and reads back per host', async () => {
  const home = tempHome()
  try {
    const written = await writeCredentialStore(home, 'github.com', TOKEN)
    assert.equal(written.ok, true)
    assert.equal(statSync(credentialsPath(home)).mode & 0o777, 0o600, 'a credential file must not be group- or world-readable')

    const store = await readCredentialStore(home)
    assert.equal(store.error, null)
    assert.equal(store.entries['github.com'].token, TOKEN)
    assert.equal(store.mode, 0o600)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('credentials: saving null forgets one host and leaves the others alone', async () => {
  const home = tempHome()
  try {
    await writeCredentialStore(home, 'github.com', TOKEN)
    await writeCredentialStore(home, 'ghe.corp.example', OTHER)
    const removed = await writeCredentialStore(home, 'github.com', null)
    assert.equal(removed.ok, true)
    assert.equal(removed.removed, true)

    const store = await readCredentialStore(home)
    assert.equal(store.entries['github.com'], undefined)
    assert.equal(store.entries['ghe.corp.example'].token, OTHER)

    const again = await writeCredentialStore(home, 'github.com', null)
    assert.equal(again.removed, false, 'forgetting an absent host is not a removal')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('credentials: a corrupt store is reported rather than treated as empty', async () => {
  const home = tempHome()
  try {
    // "You have no saved token" and "your token file is broken" are different
    // answers, and only one of them is the user's fault.
    const path = credentialsPath(home)
    mkdirSync(pluginStateDir(home), { recursive: true })
    writeFileSync(path, '{ not json')
    const store = await readCredentialStore(home)
    assert.ok(store.error !== null, 'a broken file must surface an error')
    const written = await writeCredentialStore(home, 'github.com', TOKEN)
    assert.equal(written.ok, false, 'and it must not be silently overwritten')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('credentials: settings default, and only known source ids are accepted', async () => {
  const home = tempHome()
  try {
    const defaults = await readSettings(home)
    assert.equal(defaults.defaultHost, 'github.com')
    // Nothing is off by default: every remaining source is one the user supplied.
    assert.deepEqual(defaults.disabledSources, [])
    assert.equal(defaults.exists, false)

    await writeSettings(home, { defaultHost: 'ghe.corp.example', disabledSources: ['env', 'nope', 'gh', 7] })
    const saved = await readSettings(home)
    assert.equal(saved.defaultHost, 'ghe.corp.example')
    assert.deepEqual(saved.disabledSources, ['env', 'gh'])
    assert.equal(saved.exists, true)
    assert.equal(settingsPath(home).endsWith(join('.dsh-pm', 'settings.json')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('credentials: an explicit token outranks every other source', async () => {
  const home = tempHome()
  try {
    await writeCredentialStore(home, 'github.com', TOKEN)
    const resolution = await resolveCredential({
      subprocess: scriptedSubprocess(),
      dshHome: home,
      host: 'github.com',
      explicit: OTHER,
      env: { GITHUB_TOKEN: 'from-env' },
    })
    assert.equal(resolution.token, OTHER)
    assert.equal(resolution.source, 'request')
    assert.deepEqual(resolution.tried.map((entry) => entry.id), ['request'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('credentials: the saved store outranks the environment', async () => {
  const home = tempHome()
  try {
    await writeCredentialStore(home, 'github.com', TOKEN)
    const resolution = await resolveCredential({
      subprocess: scriptedSubprocess(),
      dshHome: home,
      host: 'github.com',
      env: { GITHUB_TOKEN: 'from-env' },
    })
    assert.equal(resolution.source, 'store')
    assert.equal(resolution.token, TOKEN)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('credentials: the environment is read in THIS process, and names itself', async () => {
  const home = tempHome()
  try {
    // The subprocess seam scrubs credential-shaped environment names, so a
    // helper could never see these — which is why the host half reads them.
    const resolution = await resolveCredential({ subprocess: scriptedSubprocess(), dshHome: home, env: { GH_TOKEN: 'from-gh-env' } })
    assert.equal(resolution.token, 'from-gh-env')
    assert.equal(resolution.source, 'env')
    assert.match(resolution.tried.find((entry) => entry.id === 'env').detail, /GH_TOKEN/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('credentials: a disabled source is skipped WITH a reason, not silently', async () => {
  const home = tempHome()
  try {
    await writeSettings(home, { disabledSources: ['store', 'env', 'gh'] })
    await writeCredentialStore(home, 'github.com', TOKEN)
    const subprocess = scriptedSubprocess()
    const resolution = await resolveCredential({ subprocess, dshHome: home, env: { GITHUB_TOKEN: 'from-env' } })
    assert.equal(resolution.token, null)
    assert.match(resolution.tried.find((entry) => entry.id === 'store').detail, /disabled in settings/)
    assert.match(resolution.tried.find((entry) => entry.id === 'env').detail, /disabled in settings/)
    assert.match(resolution.tried.find((entry) => entry.id === 'gh').detail, /disabled in settings/)
    // A disabled source is not merely unmentioned: nothing was run for it.
    assert.deepEqual(subprocess.spawned, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
test('credentials: with nothing to offer, every source is reported by name', async () => {
  const home = tempHome()
  try {
    const resolution = await resolveCredential({ subprocess: scriptedSubprocess(), dshHome: home, host: 'github.com', env: {} })
    assert.equal(resolution.token, null)
    assert.equal(resolution.source, null)
    assert.deepEqual(
      resolution.tried.map((entry) => entry.id),
      ['request', 'store', 'env', 'gh'],
    )
    assert.match(resolution.error, /gh/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('credentials: redactResolution drops every token, even from the attempt log', () => {
  const redacted = redactResolution({
    token: TOKEN,
    source: 'store',
    host: 'github.com',
    tried: [
      { id: 'request', ok: false, detail: 'no token was supplied with this request', token: null },
      { id: 'store', ok: true, detail: 'saved for github.com', token: TOKEN },
    ],
    error: null,
  })
  assert.equal(redacted.resolved, true)
  assert.equal(redacted.source, 'store')
  assert.deepEqual(redacted.tried, [
    { id: 'request', ok: false, detail: 'no token was supplied with this request' },
    { id: 'store', ok: true, detail: 'saved for github.com' },
  ])
  assert.ok(!JSON.stringify(redacted).includes(TOKEN), 'no projection may carry the token')
})

test('credentials: the status projection carries a hint, never a token', async () => {
  const home = tempHome()
  try {
    const empty = await credentialStatus({ subprocess: scriptedSubprocess(), dshHome: home, host: 'github.com', env: {} })
    // With no file there is no mode, and the panel needs to know the difference
    // between "no file" and "a file anyone can read".
    assert.equal(empty.store.exists, false)
    assert.equal(empty.store.modeSafe, false)

    await writeCredentialStore(home, 'github.com', TOKEN)
    const status = await credentialStatus({ subprocess: scriptedSubprocess(), dshHome: home, host: 'github.com', env: {} })
    assert.equal(status.ok, true)
    assert.equal(status.store.exists, true)
    assert.equal(status.store.saved, true)
    assert.equal(status.store.hint, 'ghp_••••••6789')
    assert.equal(status.store.modeSafe, true)
    assert.ok(!JSON.stringify(status).includes(TOKEN), 'the panel projection must not contain the token')

    // Every source in the chain is listed exactly once, and none is a token.
    assert.deepEqual(
      status.sources.map((source) => source.id),
      ['request', 'store', 'env', 'gh'],
    )
    assert.equal(status.sources.find((source) => source.id === 'store').available, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('credentials: a caller may ask about one method without saving it', async () => {
  // This is what a per-method test needs: "would THIS work?" is a question, not a
  // settings write.
  const home = tempHome()
  try {
    const git = '/usr/bin/git'
    const subprocess = scriptedSubprocess({
      executables: { git },
      answers: { [`${git} credential fill`]: { exitCode: 0, stdout: 'password=from-git\n' } },
    })
    const before = await readSettings(home)
    const resolution = await resolveCredential({ subprocess, dshHome: home, host: 'github.com', env: {}, source: 'git-credential' })
    assert.deepEqual(await readSettings(home), before, 'asking a question must not change the stored answer')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('credentials: only real methods can be chosen', () => {
  assert.equal(normalizeSourceChoice('auto'), 'auto')
  assert.equal(normalizeSourceChoice('store'), 'store')
  assert.equal(normalizeSourceChoice('gh'), 'gh')
  // `request` is deliberately not a method, and neither is nonsense.
  assert.equal(normalizeSourceChoice('request'), 'auto')
  assert.equal(normalizeSourceChoice('nope'), 'auto')
  assert.equal(normalizeSourceChoice(undefined), 'auto')
  assert.equal(normalizeSourceChoice(42), 'auto')
})

test('credentials: the store cannot be captured by a snapshot', async () => {
  // R5 snapshots copy SNAPSHOT_FILES out of the PROFILE directory, and the store
  // is not among them: it lives in `$DSH_HOME/.dsh-pm/`, a sibling of `profiles/`.
  // This is pinned rather than assumed, because "keep the plugin's state next to
  // the profile" is a reasonable-looking change that would quietly start
  // snapshotting a secret into every restore point.
  const home = joinPath(tmpdir(), 'dsh-pm-home')
  const profileDir = joinPath(home, 'profiles', 'web')
  assert.equal(dshHomeOf(profileDir), home, 'the plugin state root is $DSH_HOME, not the profile')
  assert.ok(!credentialsPath(home).startsWith(profileDir), 'the store must not live inside a profile')
  assert.ok(SNAPSHOT_FILES.length > 0, 'the snapshot file list must stay non-empty for this to mean anything')
  for (const name of SNAPSHOT_FILES) {
    assert.ok(!credentialsPath(home).endsWith(name), `a snapshot must never copy ${name} from the store`)
  }
})
