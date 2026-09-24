/**
 * A subprocess service backed by REAL child processes.
 *
 * ## Why not a stub
 *
 * The pipeline's whole job is to run a command and then check what it did. A
 * stub that returns `{ ok: true }` would pass a test suite while the thing it
 * replaced — collected output, exit codes, a deadline that actually terminates —
 * was broken. The reference implementation's lesson (`docs/host-notes.md` F29)
 * was that a lying test double is more expensive than no test at all.
 *
 * ## Why output goes through FILES, not pipes
 *
 * ⚠️ Measured, not stylistic: under the confined sandbox this package is
 * developed in, a child spawned with `stdio: 'pipe'` fails with `EPERM` — the
 * documented boundary ("programs cannot open named pipes"). `stdio: 'ignore'`
 * and `'inherit'` spawn fine. So the fake redirects the child's descriptors to
 * real files and reads them back, which reproduces the observable contract
 * (collected text after exit) without needing a pipe.
 *
 * The production path is unaffected: it uses the host's `subprocess` SERVICE,
 * which manages its own stdio inside the host process.
 */

import { spawn as spawnChild } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** In-memory cap per stream, matching the host helper's own cap. */
const MAX_BYTES = 262144

/**
 * Build a collected-output reader over a growing buffer.
 * @param {() => Buffer} read - returns the bytes so far.
 * @returns {object} a reader with `readFrom`.
 */
function readerOver(read) {
  return {
    readFrom() {
      const bytes = read()
      const text = bytes.subarray(Math.max(0, bytes.length - MAX_BYTES)).toString('utf8')
      return { text, nextOffset: bytes.length, lossy: bytes.length > MAX_BYTES }
    },
  }
}

/**
 * Create a subprocess service for tests.
 * @returns {object} the service.
 */
export function createRealSubprocess() {
  return {
    /**
     * Resolve an executable.
     * @param {string} command - a bare name or an absolute path.
     * @returns {Promise<string>} the path.
     */
    async resolveExecutable(command) {
      if (command.includes('/') || command.includes('\\')) {
        if (existsSync(command)) return command
        throw new Error(`not found: ${command}`)
      }
      // A bare name is looked up the way a shell would, but only for the one
      // name the tests use.
      if (command === 'node' || command === 'node.exe') return process.execPath
      throw new Error(`not on PATH: ${command}`)
    },

    /**
     * Spawn one child and return a handle shaped like the host's.
     * @param {object} spec - `{ argv, cwd, stdio, graceMs, signal }`.
     * @returns {object} the handle.
     */
    spawn(spec) {
      const [command, ...args] = spec.argv
      const dir = mkdtempSync(join(tmpdir(), 'dsh-pm-spawn-'))
      const outPath = join(dir, 'stdout.txt')
      const errPath = join(dir, 'stderr.txt')
      const outFd = openSync(outPath, 'w')
      const errFd = openSync(errPath, 'w')

      let child
      try {
        child = spawnChild(command, args, {
          cwd: spec.cwd,
          windowsHide: true,
          stdio: [spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe', outFd, errFd],
        })
      } finally {
        // The child owns its own descriptors now; the parent's copies would
        // otherwise keep the files open and readable-but-stale.
        closeSync(outFd)
        closeSync(errFd)
      }

      if (spec.stdio.stdin !== 'ignore' && typeof spec.stdio.stdin === 'object') {
        try {
          child.stdin.end(spec.stdio.stdin.data)
        } catch {
          /* the child may have exited already */
        }
      }

      /** Read one redirected file as bytes. */
      const bytesOf = (path) => {
        try {
          return readFileSync(path)
        } catch {
          return Buffer.alloc(0)
        }
      }

      const done = new Promise((resolve, reject) => {
        child.on('error', (error) => {
          rmSync(dir, { recursive: true, force: true })
          reject(error)
        })
        child.on('close', (code, signal) => {
          resolve({ exitCode: code === undefined ? null : code, signal: signal ?? null })
        })
      })

      const abort = () => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
      if (spec.signal !== undefined) {
        if (spec.signal.aborted) abort()
        else spec.signal.addEventListener('abort', abort, { once: true })
      }

      return {
        stdin: child.stdin ?? undefined,
        stdout: undefined,
        stderr: undefined,
        collected: {
          stdout: readerOver(() => bytesOf(outPath)),
          stderr: readerOver(() => bytesOf(errPath)),
        },
        done,
        terminate: abort,
        waitForExit: async () => true,
      }
    },
  }
}
