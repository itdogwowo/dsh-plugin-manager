/**
 * Profile manifest reads: the authority on "what did the user install".
 *
 * The boot graph (`clientModules`) only says what is *loaded*. Whether a given
 * plugin is 原裝 (shipped) or 額外 (installed) is decided by the profile
 * manifest's `dependencies` map — a shipped bundle is listed in
 * `dsh.profile.bundles` but never in `dependencies`.
 *
 * **Locating the profile is the hard part, and it must never be guessed at
 * silently.** `clientModules.clientPath()` is useless here: it resolves the
 * junction, so a `link:` install reports the checkout path and walking up from
 * it never reaches the profile (verified — docs/host-notes.md F17). So the home
 * comes from the environment the host itself honours, and every candidate path
 * is tried and **recorded**, because "no plugins installed" and "could not read
 * the manifest" must never look the same.
 *
 * Everything here is **optional and non-fatal**: no `fs` service, an unreadable
 * manifest or an unknown profile degrades to `available: false` plus the exact
 * reason and the attempts made. Nothing in the boot path touches this (R4).
 *
 * Uses the `fs` **service**, never `node:fs`: the service is sandbox-aware and
 * is the host's own abstraction (docs/host-notes.md F7).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory under the harness home holding every profile. */
const PROFILES_DIR = 'profiles'

/** Profile name used when nothing better can be determined. */
const FALLBACK_PROFILE = 'web'

/**
 * Environment lookup that survives a host without a usable `process`.
 * @param {string} name - variable name.
 * @returns {string | undefined} the value, when present.
 */
function envValue(name) {
  try {
    if (typeof process === 'undefined' || process === null || process.env === undefined || process.env === null) {
      return undefined
    }
    const value = process.env[name]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The OS home directory, the platform-correct way.
 *
 * `node:os.homedir()` is exactly what the host's own `dsh-home-paths` uses
 * (`join(homedir(), '.dsh')`), so this agrees with the deployment on Windows,
 * macOS and Linux instead of hand-rolling environment-variable guesses.
 *
 * `homedirFn` is an injectable seam used only by tests: `os.homedir()` consults
 * the real machine (`USERPROFILE`/`HOMEDRIVE` on Windows, `HOME` on POSIX), so a
 * unit test cannot isolate it by clearing a variable. Production never sets it.
 * @returns {string | undefined} the absolute home, when the platform reports one.
 */
let homedirFn = homedir

/** Replace the home-directory reader. Test-only seam. */
export function setHomedirReader(fn) {
  homedirFn = typeof fn === 'function' ? fn : homedir
}

/**
 * Read the OS home through the seam, tolerating a host that cannot provide one.
 * @returns {string | undefined} the absolute home.
 */
function osHome() {
  try {
    const home = homedirFn()
    return typeof home === 'string' && home.length > 0 ? home : undefined
  } catch {
    return undefined
  }
}

/**
 * The harness home candidates, most trustworthy first.
 *
 * Ordering is deliberate and cross-platform: an explicit `DSH_HOME` wins,
 * then the OS home via `homedir()`, then the two conventional home variables as
 * a last resort for a host whose `homedir()` is unusable. All of them point at
 * the same place on a normal install, so the order only matters when one is
 * missing.
 * @returns {string[]} absolute paths.
 */
function harnessHomeCandidates() {
  const out = []
  const add = (value) => {
    if (value !== undefined && !out.includes(value)) out.push(value)
  }

  add(envValue('DSH_HOME'))

  const home = osHome()
  if (home !== undefined) add(join(home, '.dsh'))

  // Last resort only: the host half may have no usable `process`, and neither
  // variable exists on every platform (`USERPROFILE` is Windows,
  // `HOME` is POSIX).
  const userProfile = envValue('USERPROFILE')
  if (userProfile !== undefined) add(join(userProfile, '.dsh'))
  const posixHome = envValue('HOME')
  if (posixHome !== undefined) add(join(posixHome, '.dsh'))

  return out
}

/**
 * The profile this process booted.
 *
 * `--profile <name>` is the documented selector, `web` is a hardcoded alias for
 * it, and `DSH_PROFILE` is the environment form.
 * @returns {{ name: string, source: string }} the profile and where it came from.
 */
export function activeProfile() {
  const fromEnv = envValue('DSH_PROFILE')
  if (fromEnv !== undefined) return { name: fromEnv, source: 'DSH_PROFILE' }

  try {
    const argv = typeof process !== 'undefined' && Array.isArray(process.argv) ? process.argv : []
    const index = argv.indexOf('--profile')
    if (index !== -1 && typeof argv[index + 1] === 'string' && argv[index + 1].length > 0) {
      return { name: argv[index + 1], source: 'argv' }
    }
    // `dsh web` is a hardcoded alias for `--profile web`.
    if (argv.includes('web')) return { name: 'web', source: 'argv-alias' }
  } catch {
    /* no argv: fall through to the default profile */
  }

  return { name: FALLBACK_PROFILE, source: 'fallback' }
}

/**
 * Candidate profile directories, most likely first.
 *
 * The name may be wrong (an alias, a renamed profile), so the default name is
 * appended as a second chance rather than trusting a single guess.
 * @returns {{ dir: string, name: string, source: string, home: string }[]} candidates.
 */
export function profileDirCandidates() {
  const { name, source } = activeProfile()
  const homes = harnessHomeCandidates()
  const names = [name]
  if (!names.includes(FALLBACK_PROFILE)) names.push(FALLBACK_PROFILE)

  const out = []
  for (const home of homes) {
    for (const candidate of names) {
      const dir = join(home, PROFILES_DIR, candidate)
      if (!out.some((entry) => entry.dir === dir)) out.push({ dir, name: candidate, source, home })
    }
  }
  return out
}

/**
 * The first candidate directory, for callers that only need a label.
 * @returns {{ dir: string, name: string, source: string } | undefined} the guess.
 */
export function profileDir() {
  const first = profileDirCandidates()[0]
  return first === undefined ? undefined : { dir: first.dir, name: first.name, source: first.source }
}

/**
 * The profile directory's own name, from a path in either separator style.
 *
 * Written by hand rather than with `basename` so it is correct on a POSIX host
 * reading a Windows-shaped diagnostic path and vice versa; the only use is a
 * display label.
 * @param {string} path - an absolute path.
 * @returns {string} the last segment, or `'unknown'`.
 */
function lastSegment(path) {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const tail = cut === -1 ? trimmed : trimmed.slice(cut + 1)
  return tail.length > 0 ? tail : 'unknown'
}

/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Classify a dependency spec into where the package came from.
 *
 * The distinction matters because an update check cannot be the same for a
 * registry range and for a URL that never changes: a `https://…/latest/…`
 * tarball keeps one spec forever while its content moves under it.
 * @param {string} spec - the raw spec from `dependencies`.
 * @returns {{ sourceType: string, changeSignal: string }} classification.
 */
export function classifySpec(spec) {
  const value = typeof spec === 'string' ? spec : ''

  if (value.startsWith('link:')) return { sourceType: 'link', changeSignal: 'resolvedDir' }
  if (value.startsWith('file:')) return { sourceType: 'file', changeSignal: 'integrity' }
  if (value.startsWith('workspace:')) return { sourceType: 'workspace', changeSignal: 'resolvedDir' }
  if (value.startsWith('github:') || value.startsWith('git+') || value.startsWith('git:')) {
    return { sourceType: 'git', changeSignal: 'integrity' }
  }
  if (/^https?:\/\//.test(value)) return { sourceType: 'tarball-url', changeSignal: 'integrity' }
  if (value.startsWith('npm:')) return { sourceType: 'alias', changeSignal: 'integrity' }
  if (value.length > 0 && !/^[\^~]?\d/.test(value)) return { sourceType: 'tag-or-range', changeSignal: 'integrity' }

  return { sourceType: 'registry', changeSignal: 'integrity' }
}

/**
 * Try to read one profile manifest.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} path - absolute manifest path.
 * @returns {Promise<{ ok: true, manifest: object } | { ok: false, detail: string }>} the attempt.
 */
async function tryManifest(fs, path) {
  try {
    const target = await fs.resolve(path)
    const manifest = JSON.parse(await fs.readText(target))
    if (manifest === null || typeof manifest !== 'object') return { ok: false, detail: 'not a JSON object' }
    return { ok: true, manifest }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read the profile manifest, trying every strategy and recording each attempt.
 *
 * **The first strategy is `fs.resolve('.')`, and it is the one that works.** The
 * host process's own `fs` base directory IS the profile directory — verified on
 * the reference deployment, where `fs.resolve('.')` reports
 * `…\.dsh\profiles\web` and `fs.resolve('package.json')` reads the manifest with
 * its `dependencies` intact (docs/host-notes.md F17). That path needs no
 * environment variable at all, which matters because the host half may not have
 * a usable `process`.
 *
 * The environment-derived candidates stay as fallbacks, and every attempt is
 * recorded: "no plugins installed" and "could not read the manifest" must never
 * look the same.
 * @param {object | undefined} fs - the resolved `fs` service.
 * @returns {Promise<object>} `{ ok, profile, manifestPath, manifest, reason, attempts }`.
 */
export async function readManifest(fs) {
  const attempts = []
  const candidates = profileDirCandidates()

  if (fs === undefined || fs === null || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') {
    return {
      ok: false,
      profile: candidates[0] ?? null,
      manifestPath: null,
      reason: 'the fs service is not available in this host',
      attempts,
    }
  }

  // Strategy 1: the fs base directory is the profile directory.
  const fromBase = await tryFromBase(fs, attempts)
  if (fromBase !== null) return fromBase

  // Strategy 2: the environment names the home and the profile.
  if (candidates.length === 0) {
    return {
      ok: false,
      profile: null,
      manifestPath: null,
      reason:
        'the fs base directory is not a profile, and no harness home could be determined (no DSH_HOME, no OS home, and neither HOME nor USERPROFILE)',
      attempts,
    }
  }

  for (const candidate of candidates) {
    const path = join(candidate.dir, 'package.json')
    const attempt = await tryManifest(fs, path)

    if (attempt.ok && carriesDsh(attempt.manifest)) {
      attempts.push({ path, detail: 'read ok (carries dsh)' })
      return { ok: true, profile: candidate, manifestPath: path, manifest: attempt.manifest, reason: null, attempts }
    }

    attempts.push({ path, detail: attempt.ok ? 'read ok but carries no dsh' : attempt.detail })
  }

  return {
    ok: false,
    profile: candidates[0],
    manifestPath: null,
    reason: 'no candidate profile manifest could be read',
    attempts,
  }
}

/**
 * Whether a parsed manifest is a PROFILE root.
 *
 * ⚠️ **`dsh.profile` is required, and the first version of this check only asked
 * for a `dsh` key.** That difference is not academic: every plugin package — this
 * one included — carries `dsh.bundle` (and a web plugin also carries
 * `dsh.client`), so a manifest with a `dsh` key is exactly what a PLUGIN looks
 * like. Since `tryFromBase` tries the `fs` base directory FIRST and a `dsh` key
 * was enough to accept it, running `dsh web` with the working directory set to a
 * plugin's checkout made the plugin's own `package.json` the "profile": it has no
 * `dependencies`, so the panel reported **zero installed plugins**, and the real
 * profile was never consulted.
 *
 * The bug was found by a test that pointed `DSH_HOME` at a fixture profile and
 * still got `source: 'fs-base'` — the fixture was correct, the DISCOVERY was not.
 *
 * @param {object} manifest - the parsed manifest.
 * @returns {boolean} true when this manifest declares a profile.
 */
function carriesDsh(manifest) {
  if (manifest === null || typeof manifest !== 'object') return false
  const dsh = manifest.dsh
  return dsh !== null && typeof dsh === 'object' && dsh.profile !== null && dsh.profile !== undefined && typeof dsh.profile === 'object'
}

/**
 * Try the fs base directory as the profile directory.
 * @param {object} fs - the resolved `fs` service.
 * @param {object[]} attempts - the running attempt log (mutated).
 * @returns {Promise<object | null>} the read result, or null when this strategy does not apply.
 */
async function tryFromBase(fs, attempts) {
  let dir = null
  try {
    dir = await fs.resolve('.')
  } catch (error) {
    attempts.push({ path: 'fs.resolve(".")', detail: error instanceof Error ? error.message : String(error) })
    return null
  }

  const basePath = str(dir?.displayPath)
  if (basePath === null) {
    attempts.push({ path: 'fs.resolve(".")', detail: 'resolved to no displayPath' })
    return null
  }

  const path = join(basePath, 'package.json')
  const attempt = await tryManifest(fs, path)

  if (!attempt.ok) {
    attempts.push({ path, detail: `${attempt.detail} (fs base directory: ${basePath})` })
    return null
  }
  if (!carriesDsh(attempt.manifest)) {
    attempts.push({ path, detail: `read ok but carries no dsh.profile (fs base directory: ${basePath})` })
    return null
  }

  attempts.push({ path, detail: 'read ok (the fs base directory is the profile)' })
  return {
    ok: true,
    profile: { dir: basePath, name: lastSegment(basePath), source: 'fs-base' },
    manifestPath: path,
    manifest: attempt.manifest,
    reason: null,
    attempts,
  }
}

/**
 * Read one installed package's own manifest, for its real on-disk version.
 *
 * The in-memory graph carries a content hash, not a version, and a spec can
 * resolve to a different version over time — so the version has to come from
 * disk. `link:` dependencies are junctions into a checkout, which is exactly
 * why this reads rather than trusting the lockfile.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} profileDirPath - the profile directory that was read.
 * @param {string} packageName - the dependency's name.
 * @returns {Promise<{ version: string | null, resolvedDir: string | null, declaresBundle: boolean }>} what was found.
 */
export async function readInstalledPackage(fs, profileDirPath, packageName) {
  const empty = { version: null, resolvedDir: null, declaresBundle: false }
  if (fs === undefined || fs === null || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') {
    return empty
  }

  const path = join(profileDirPath, 'node_modules', packageName, 'package.json')
  try {
    const target = await fs.resolve(path)
    const parsed = JSON.parse(await fs.readText(target))
    return {
      version: str(parsed.version),
      resolvedDir: str(target.displayPath),
      declaresBundle:
        parsed.dsh !== null &&
        typeof parsed.dsh === 'object' &&
        parsed.dsh.bundle !== null &&
        typeof parsed.dsh.bundle === 'object',
    }
  } catch {
    return empty
  }
}

/**
 * Build the third-party plugin inventory.
 *
 * "額外" means: listed in the profile manifest's `dependencies`. A shipped
 * bundle lives in `dsh.profile.bundles` only, so it is excluded by construction
 * rather than by a name list that would rot.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} selfName - this package's own name, flagged in the result.
 * @returns {Promise<object>} plain-JSON inventory.
 */
export async function buildPluginInventory(fs, selfName) {
  const read = await readManifest(fs)

  const out = {
    available: read.ok,
    reason: read.reason,
    attempts: read.attempts,
    profile:
      read.profile === null ? null : { name: read.profile.name, dir: read.profile.dir, source: read.profile.source },
    manifestPath: read.manifestPath,
    declaredBundles: [],
    plugins: [],
  }

  if (!read.ok) return out

  const dependencies = read.manifest.dependencies
  const bundles = read.manifest.dsh?.profile?.bundles
  out.declaredBundles = Array.isArray(bundles) ? bundles.filter((entry) => typeof entry === 'string') : []

  if (dependencies === null || typeof dependencies !== 'object') return out

  for (const [name, spec] of Object.entries(dependencies)) {
    const installed = await readInstalledPackage(fs, read.profile.dir, name)
    const { sourceType, changeSignal } = classifySpec(spec)
    out.plugins.push({
      name,
      spec: str(spec),
      version: installed.version,
      sourceType,
      changeSignal,
      resolvedDir: installed.resolvedDir,
      declaresBundle: installed.declaresBundle,
      inBundles: out.declaredBundles.includes(name),
      self: name === selfName,
    })
  }

  // Self first, then alphabetical.
  //
  // Not vanity: this plugin is the one whose own version, its own source and its
  // own enabled state the reader is most likely to be checking — it is the tool
  // they are looking at the list WITH. It is also the entry most likely to be a
  // local checkout under active edit, so "is the running copy the one I just
  // changed" is a question asked far more often than any question about a
  // third-party package. The left rule already marks it as special; the position
  // makes the answer reachable without scanning.
  out.plugins.sort((left, right) => {
    if (left.self !== right.self) return left.self ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  return out
}
