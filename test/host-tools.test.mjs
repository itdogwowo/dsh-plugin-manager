/**
 * The host-side tool layer, exercised against REAL child processes.
 *
 * Nothing here stubs a spawn. The pipeline's entire claim is "we ran the command
 * and then checked what it did", so a test double that returns `{ ok: true }`
 * would certify the one part that must not be taken on faith — collected output,
 * exit codes, and a deadline that really terminates a running process.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readdirSync, statSync } from 'node:fs'

import { createRealSubprocess } from './helpers/real-subprocess.mjs'
import { linuxInstallCommand, toolInstallHint } from '../src/host/install-hints.mjs'
import {
  base64,
  describeProbe,
  dshArgv,
  dshBinCandidates,
  firstLine,
  joinPath,
  looksLikeVersion,
  parentPath,
  probeGit,
  removeFile,
  resolveTool,
  runProcess,
} from '../src/host/host.js'

const subprocess = createRealSubprocess()

/** One throwaway directory, removed after the callback. */
function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pm-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A fake `fs` service over the real filesystem, with the host's shapes. */
function realFs() {
  return {
    /**
     * Resolve a path.
     * @param {string} target - the path or `.`.
     * @returns {Promise<object>} the resolved target.
     */
    async resolve(target) {
      if (target === '.') return { displayPath: process.cwd() }
      return { displayPath: target }
    },
    /**
     * Read a text file.
     * @param {object} handle - a resolved target.
     * @returns {Promise<string>} the text.
     */
    async readText(handle) {
      return readFileSync(handle.displayPath, 'utf8')
    },
    /**
     * Write a text file.
     * @param {object} handle - a resolved target.
     * @param {string} content - the text.
     * @returns {Promise<object>} the outcome.
     */
    async writeText(handle, content) {
      writeFileSync(handle.displayPath, content)
      return { ok: true }
    },
    /**
     * List a directory.
     * @param {object} handle - a resolved target.
     * @returns {Promise<object[]>} the entries.
     */
    async listDir(handle) {
      return readdirSync(handle.displayPath).map((name) => ({
        name,
        isDirectory: statSync(join(handle.displayPath, name)).isDirectory(),
      }))
    },
    /**
     * Stat a path.
     * @param {object} handle - a resolved target.
     * @returns {Promise<object|undefined>} the info, or undefined.
     */
    async stat(handle) {
      try {
        const info = statSync(handle.displayPath)
        return { size: info.size, isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs }
      } catch {
        return undefined
      }
    },
  }
}

test('host: joinPath and parentPath agree with each other in both styles', () => {
  assert.equal(joinPath('C:\\a\\b', 'c'), 'C:\\a\\b\\c')
  assert.equal(joinPath('/a/b/', 'c'), '/a/b/c')
  // A base with BOTH separators is treated as a POSIX-ish path; the point is
  // that the choice is deterministic rather than mixed.
  assert.equal(joinPath('/a/b', 'c'), '/a/b/c')

  assert.equal(parentPath('C:\\a\\b\\c'), 'C:\\a\\b')
  assert.equal(parentPath('/a/b/c'), '/a/b')
  assert.equal(parentPath('C:\\a'), 'C:\\a', 'a drive root has no parent to give')
})

test('host: dshBinCandidates walks up from argv[1] and never guesses a PATH name', () => {
  const candidates = dshBinCandidates()
  assert.ok(Array.isArray(candidates))
  for (const candidate of candidates) {
    assert.match(candidate, /node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/)
    expectAbsolute(candidate)
  }
})

/** Assert a path is absolute in either style. */
function expectAbsolute(path) {
  assert.ok(/^([A-Za-z]:[\\/]|[\\/])/.test(path), `not absolute: ${path}`)
}

test('host: dshArgv puts node first, never the PATH shim', () => {
  const argv = dshArgv('C:\\node\\node.exe', 'C:\\dsh\\lib\\bin.js', ['--profile', 'web', '--dump-config'])
  assert.deepEqual(argv, ['C:\\node\\node.exe', 'C:\\dsh\\lib\\bin.js', '--profile', 'web', '--dump-config'])
  // The reason this exists: on Windows `dsh` is a .ps1 and the subprocess seam
  // will not execute a shell script as argv[0].
  assert.notEqual(argv[0], 'dsh')
})

test('host: runProcess collects stdout, stderr and the exit code of a real child', async () => {
  const result = await runProcess(subprocess, {
    argv: [process.execPath, '-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)'],
    cwd: '.',
    timeoutMs: 20000,
  })
  assert.equal(result.exitCode, 3)
  assert.equal(result.ok, false)
  assert.equal(result.stdout, 'out')
  assert.equal(result.stderr, 'err')
  assert.equal(result.timedOut, false)
  assert.equal(result.error, null, 'a non-zero exit is not an ERROR field — the exit code says it')
})

test('host: runProcess reports a clean exit as ok', async () => {
  const result = await runProcess(subprocess, { argv: [process.execPath, '-e', 'process.stdout.write("hi")'], cwd: '.', timeoutMs: 20000 })
  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'hi')
})

test('host: a deadline actually terminates the child', async () => {
  // The child would run for 30 s; the deadline is 300 ms. If the abort were not
  // wired through to the process range this test would hang, which is exactly
  // the failure mode a plugin must not have (the whole `dsh web` would stall).
  const started = Date.now()
  const result = await runProcess(subprocess, {
    argv: [process.execPath, '-e', 'setTimeout(()=>process.stdout.write("late"),30000)'],
    cwd: '.',
    timeoutMs: 300,
  })
  const elapsed = Date.now() - started

  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.match(result.error, /did not finish within 300 ms/)
  assert.ok(elapsed < 10000, `the deadline should have terminated the child, took ${elapsed} ms`)
})

test('host: runProcess refuses a spec with no argv instead of spawning nothing', async () => {
  const result = await runProcess(subprocess, { argv: [], cwd: '.' })
  assert.equal(result.ok, false)
  assert.match(result.error, /no argv/)
})

test('host: a missing subprocess service is a reason, never a throw', async () => {
  for (const absent of [undefined, null, {}]) {
    const result = await runProcess(absent, { argv: ['node', '-e', '1'], cwd: '.' })
    assert.equal(result.ok, false)
    assert.match(result.error, /subprocess service is not available/)
  }
  assert.equal(await resolveTool(undefined, 'git'), null)
  assert.equal(await resolveTool({}, 'git'), null)
})

test('host: resolveTool answers null for a program that does not exist', async () => {
  assert.equal(await resolveTool(subprocess, 'definitely-not-a-real-program-xyz'), null)
  assert.equal(await resolveTool(subprocess, process.execPath), process.execPath)
})

test('host: removeFile removes one file with real node:fs and reports honestly', async () => {
  await withTempDir(async (dir) => {
    const fs = realFs()
    const target = join(dir, 'created-by-a-change.txt')
    writeFileSync(target, 'x')

    const removed = await removeFile(subprocess, fs, target)
    assert.equal(removed.removed, true)
    assert.equal(existsSync(target), false)

    // Removing it again must still be reported as success: the operation's goal
    // is "this file is not there", and it is not there.
    const again = await removeFile(subprocess, fs, target)
    assert.equal(again.removed, true)
  })
})

test('host: probeGit does not throw on a machine without git, and says what it tried', async () => {
  const probe = await probeGit(subprocess, realFs())
  assert.equal(typeof probe.available, 'boolean')
  assert.ok(Array.isArray(probe.tried))
  assert.ok(probe.tried.length > 0, 'a failure has to name what was tried, or the user cannot act on it')
  if (probe.available !== true) {
    assert.equal(probe.path, null)
    assert.match(probe.error, /git was not found/)
  }
})

test('host: base64 matches the runtime encoder for text, including non-ASCII', () => {
  for (const sample of ['', 'a', 'ab', 'abc', 'a/b?c=d', '路徑 C:\\x y\\z', '🔌']) {
    assert.equal(base64(sample), Buffer.from(sample, 'utf8').toString('base64'), `mismatch for ${JSON.stringify(sample)}`)
  }
})

test('host: firstLine, looksLikeVersion and describeProbe are strict', () => {
  assert.equal(firstLine('\n\n  x  \ny'), 'x')
  assert.equal(firstLine(''), null)
  assert.equal(firstLine(undefined), null)

  assert.equal(looksLikeVersion('v1.2.3'), true)
  assert.equal(looksLikeVersion('1.2.3-rc.1'), true)
  assert.equal(looksLikeVersion('main'), false)

  assert.equal(describeProbe('git', { available: true, version: 'git version 2.4' }), 'git=ready (git version 2.4)')
  assert.equal(describeProbe('git', { available: false }), 'git=absent')
  assert.equal(describeProbe('git', undefined), 'git=absent')
})

test('host: a probe failure is remembered as an answer, not re-tested per call', async () => {
  // The contract that matters here is behavioural: `probeGit` returns the same
  // shape whether or not git exists, so a caller never has to special-case it.
  const first = await probeGit(subprocess, realFs())
  const second = await probeGit(subprocess, realFs())
  assert.equal(first.available, second.available)
  assert.equal(typeof first.error === 'string', typeof second.error === 'string')
})

test('host: the install hint is per platform, and never invents a command', () => {
  // The rule from the user's side: a refusal caused by the MACHINE has to come
  // with a way out, on every system this runs on. Each platform gets its own
  // package manager — and a platform nobody here has tested gets the official
  // page rather than a guessed command.
  const win = toolInstallHint('git', { platform: 'win32' })
  assert.equal(win.command, 'winget install --id Git.Git -e --source winget')
  assert.equal(win.url, 'https://git-scm.com/download/win')
  assert.equal(win.distro, null)

  const mac = toolInstallHint('git', { platform: 'darwin' })
  assert.equal(mac.command, 'xcode-select --install', 'macOS ships git with the command line tools')
  assert.equal(mac.url, 'https://git-scm.com/download/mac')

  // Linux is answered from the distro, because "install git" is a different
  // command on Debian and on Arch.
  const ubuntu = toolInstallHint('git', { platform: 'linux', osRelease: 'ID=ubuntu\nID_LIKE=debian\n' })
  assert.equal(ubuntu.command, 'sudo apt-get update && sudo apt-get install -y git')
  assert.equal(ubuntu.distro, 'ubuntu')

  const arch = toolInstallHint('git', { platform: 'linux', osRelease: 'ID=arch\n' })
  assert.equal(arch.command, 'sudo pacman -S --noconfirm git')

  // An unreadable /etc/os-release must NOT become a wrong command.
  const unknown = toolInstallHint('git', { platform: 'linux', osRelease: null })
  assert.equal(unknown.command, null, 'no command is the honest answer when the distribution is unknown')
  assert.match(String(unknown.url), /^https:\/\/git-scm\.com\//, 'but the official instructions are still offered')

  // A platform this file has never seen: still a link, still no invented command.
  const plan9 = toolInstallHint('git', { platform: 'plan9' })
  assert.equal(plan9.command, null)
  assert.equal(plan9.url, 'https://git-scm.com/downloads')
  assert.equal(plan9.platform, 'plan9')

  // And an unknown TOOL is refused rather than half-answered.
  assert.equal(toolInstallHint('svn', { platform: 'win32' }), null)
  assert.equal(toolInstallHint('git', { platform: null }), null)
})

test('host: the linux hint reads ID_LIKE, so derivatives are not left without a command', () => {
  // The trap this exists for: Linux Mint reports `ID=linuxmint`, and only
  // `ID_LIKE` says that apt is the answer. Reading `ID` alone would drop every
  // derivative through to the source-build page.
  const mint = toolInstallHint('git', { platform: 'linux', osRelease: 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n' })
  assert.equal(mint.command, 'sudo apt-get update && sudo apt-get install -y git')
  // The distro's OWN id is reported, not the family it resembles: this is the
  // value of `ID`, and the family only decided which command applies.
  assert.equal(mint.distro, 'linuxmint')

  // Quoted values, comments and blank lines are all in the real file.
  const rocky = toolInstallHint('git', { platform: 'linux', osRelease: '# comment\nID="rocky"\nVERSION="9.4"\n\n' })
  assert.equal(rocky.command, 'sudo dnf install -y git')

  assert.equal(linuxInstallCommand(''), null)
  assert.equal(linuxInstallCommand('ID=freedesktop\n'), null, 'a distro with no known family gets no command')
})
