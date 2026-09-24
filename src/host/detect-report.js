/**
 * The detection report: per plugin, what is installed, what it is compared
 * against, and whether it moved.
 *
 * ## The rule this file exists to obey
 *
 * **"No update" and "cannot tell" are different answers, and only one of them is
 * true.** Every source kind without a remote baseline lands on `unknown` with a
 * reason, never on `current`. On the reference machine 5 of 8 plugins are
 * `unknown` under `reachability: 'local'`, and reporting them as "up to date"
 * would be the single most damaging thing this feature could do — the user has
 * no way to check it.
 *
 * ## What it will never do
 *
 * Write. Install. Fetch. Update. The report is a read of local files, so it is
 * always safe to press, and nothing here needs a snapshot to be reversible.
 *
 * R1 applies: this file imports only `node:` and relative paths.
 */

import { SOURCE_KINDS, STRATEGY_DEFAULTS } from '../params.js'
import { buildPluginInventory } from './profile.js'
import { resolveEnabledState } from './enabled.js'
import {
  fingerprintDir,
  fingerprintFile,
  joinPath,
  parseLockfileImporters,
  parentPath,
  readGitState,
} from './detect.js'

/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Map a classified spec type onto one of the five source kinds.
 * @param {string} sourceType - the classification from `classifySpec`.
 * @returns {string} one of {@link SOURCE_KINDS}.
 */
export function kindOf(sourceType) {
  if (sourceType === 'link' || sourceType === 'workspace') return 'link'
  if (sourceType === 'file') return 'file'
  if (sourceType === 'git') return 'git'
  if (sourceType === 'tarball-url' || sourceType === 'alias' || sourceType === 'tag-or-range') return 'tarball-url'
  return 'registry'
}

/**
 * The comparison key for a source kind: what "the same version" is measured against.
 * @param {string} kind - a {@link SOURCE_KINDS} member.
 * @param {object} plugin - one inventory row.
 * @param {object} git - the git state, when read.
 * @returns {string|null} the key, or null when the local path is the identity.
 */
export function refOf(kind, plugin, git) {
  if (kind === 'git') return str(git?.branch) ?? str(plugin.version)
  if (kind === 'link') return null
  if (kind === 'file') return str(plugin.spec)
  if (kind === 'tarball-url') return str(plugin.spec)
  return str(plugin.spec)
}

/**
 * Decide the verdict for one plugin, and say what it was compared against.
 *
 * The `baseline` field is the point of the whole report: a verdict is only
 * meaningful next to the thing it was measured against, and for most kinds that
 * baseline is "as of the last fetch", not "as of now".
 * @param {object} input - gathered evidence.
 * @returns {{ verdict: string, reason: string, baseline: string|null }} the judgement.
 */
export function verdictOf(input) {
  const { kind, plugin, lock, git, fileInfo } = input

  if (kind === 'registry') {
    const range = str(lock?.specifier) ?? str(plugin.spec)
    const locked = str(lock?.version)
    if (locked === null) {
      return {
        verdict: 'unknown',
        reason: 'the lockfile records no resolved version, so nothing local shows what this spec once resolved to',
        baseline: range,
      }
    }
    if (str(plugin.version) === null) {
      return {
        verdict: 'unknown',
        reason: 'the installed package.json could not be read, so the locked version cannot be compared',
        baseline: `${locked} (locked)`,
      }
    }
    if (plugin.version !== locked) {
      return {
        verdict: 'moved',
        reason: `installed ${plugin.version} disagrees with the locked ${locked}; the spec "${range}" resolves differently now`,
        baseline: `locked ${locked}`,
      }
    }
    return {
      verdict: 'current',
      reason: `installed ${plugin.version} matches the locked ${locked}`,
      // Two different "current"s must not look alike: the range may well admit a
      // newer version, and nothing offline can say whether one exists.
      baseline: `locked ${locked} — "${range}" may still admit a newer release, which only a registry query could answer`,
    }
  }

  if (kind === 'link') {
    if (git === null || git.isRepo !== true) {
      return {
        verdict: 'unknown',
        reason: 'this is a local link with no readable git checkout, so there is no upstream to compare against',
        baseline: null,
      }
    }
    if (git.remote === null) {
      return {
        verdict: 'unknown',
        reason: 'the checkout has no origin remote, so nothing outside this machine can be compared against',
        baseline: str(git.commit),
      }
    }
    const upstream = str(git.trackingRef) ?? str(git.fetchHead)
    if (upstream === null) {
      return {
        verdict: 'unknown',
        reason: 'no remote-tracking ref and no FETCH_HEAD, so the upstream commit has never been observed here',
        baseline: `local ${str(git.commit) ?? '?'} on ${str(git.branch) ?? '?'}`,
      }
    }
    if (str(git.commit) !== upstream) {
      return {
        verdict: 'moved',
        reason: `local ${str(git.commit)} differs from the last observed upstream ${upstream} — commits exist on one side only`,
        baseline: `origin/${str(git.branch) ?? '?'} at last fetch = ${upstream}`,
      }
    }
    return {
      verdict: 'current',
      reason: `local ${upstream} matches the upstream commit seen at the last fetch`,
      baseline: `origin/${str(git.branch) ?? '?'} at last fetch = ${upstream}, ${git.fetchHead === null ? 'no FETCH_HEAD' : 'FETCH_HEAD agrees'}`,
    }
  }

  if (kind === 'file') {
    if (fileInfo === null || fileInfo.hash === null) {
      return {
        verdict: 'unknown',
        reason: 'the tarball named by this spec is not present at the recorded path',
        baseline: str(plugin.spec),
      }
    }
    const named = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.tgz$/.exec(fileInfo.path ?? '')
    const versionInName = named === null ? null : named[1]
    if (versionInName !== null && str(plugin.version) !== null && versionInName !== plugin.version) {
      return {
        verdict: 'moved',
        reason: `the tarball is named ${versionInName} but ${plugin.version} is installed from it`,
        baseline: `${fileInfo.path} (${fileInfo.size} bytes)`,
      }
    }
    return {
      verdict: 'unknown',
      reason:
        'a local tarball has no upstream; the fingerprint notices a swap of the same path, but nothing here can discover a newer archive',
      baseline: `${fileInfo.path} = ${fileInfo.hash} (${fileInfo.size} bytes)`,
    }
  }

  // tarball-url: the spec is a URL that never changes while its content does.
  return {
    verdict: 'unknown',
    reason: 'the source is a URL or a tag, and nothing offline can tell whether the content behind it changed',
    baseline: str(plugin.spec),
  }
}

/**
 * Build the detection report.
 *
 * Never throws: a missing `fs`, an unreadable lockfile or a broken checkout
 * degrades to a per-plugin `unknown` with the reason attached.
 * @param {object | undefined} fs - the resolved `fs` service.
 * @param {string} selfName - this package's own name.
 * @param {object} [overrides] - strategy parameter overrides.
 * @returns {Promise<object>} plain-JSON report.
 */
export async function buildDetect(fs, selfName, overrides = {}) {
  const strategy = { ...STRATEGY_DEFAULTS, ...overrides }
  const kinds = Array.isArray(strategy.includeKinds) ? strategy.includeKinds : SOURCE_KINDS
  const maxFiles = typeof strategy.maxFiles === 'number' && strategy.maxFiles > 0 ? strategy.maxFiles : 2000

  const out = {
    at: Date.now(),
    strategy,
    baseline: {
      reachability: strategy.reachability,
      writable: strategy.writesAnything,
      // Stated once, at the top, so a reader cannot mistake the verdicts below
      // for a comparison against a live registry.
      note:
        strategy.reachability === 'local'
          ? 'local only: no registry was queried and no fetch was run, so "a newer version exists" is a claim this report cannot make'
          : 'network reachability is declared but not implemented; treat every verdict as local',
    },
    profile: null,
    manifestPath: null,
    lockfilePath: null,
    lockfileRead: false,
    userPatchPath: null,
    userPatchPresent: false,
    counts: { total: 0, current: 0, moved: 0, unknown: 0, hashed: 0 },
    plugins: [],
    notices: [],
  }

  if (fs === undefined || fs === null || typeof fs.resolve !== 'function') {
    out.notices.push('the fs service is not available in this host, so nothing can be read')
    return out
  }

  let inventory
  try {
    inventory = await buildPluginInventory(fs, selfName)
  } catch (error) {
    out.notices.push(`the plugin inventory failed: ${error instanceof Error ? error.message : String(error)}`)
    return out
  }

  out.profile = inventory.profile
  out.manifestPath = inventory.manifestPath
  if (!inventory.available || inventory.profile === null) {
    out.notices.push(`no profile could be read, so there is nothing to compare: ${inventory.reason}`)
    return out
  }

  // ── the lockfile: the only record of what a spec once resolved to ─────────
  let lockEntries = {}
  const lockfilePath = joinPath(joinPath(inventory.profile.dir, 'node_modules'), '.pnpm/lock.yaml')
  const lockfileAtRoot = joinPath(inventory.profile.dir, 'pnpm-lock.yaml')
  for (const candidate of [lockfileAtRoot, lockfilePath]) {
    try {
      const text = await fs.readText(await fs.resolve(candidate))
      const parsed = parseLockfileImporters(text)
      if (parsed.ok) {
        lockEntries = parsed.entries
        out.lockfilePath = candidate
        out.lockfileRead = true
        break
      }
      out.notices.push(`${candidate} was read but no importer dependencies were found in it`)
    } catch (error) {
      out.notices.push(`${candidate} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── enabled / disabled, resolved from the patch layers ────────────────────
  // Reported here for completeness, but the panel's per-card state comes from
  // `/overview`: this projection has no boot graph, so it cannot tell "enabled
  // and running" from "enabled and missing", and it must not pretend to.
  let enabledState = { userPatchPath: null, userPatchPresent: false, userPatchError: null, state: {} }
  try {
    enabledState = await resolveEnabledState(fs, inventory.profile.dir, inventory.plugins.map((plugin) => plugin.name))
  } catch (error) {
    out.notices.push(`the enabled/disabled state could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
  }
  out.userPatchPath = enabledState.userPatchPath ?? null
  out.userPatchPresent = enabledState.userPatchPresent === true
  // An ABSENT patch file is the normal state of a fresh profile — `dsh plugin add`
  // does not create one. Only a file that exists and still cannot be read is a
  // problem worth a notice; reporting ENOENT here told the user their profile was
  // broken when nothing was wrong.
  if (enabledState.userPatchPresent === true && enabledState.userPatchError !== null && enabledState.userPatchError !== undefined) {
    out.notices.push(`${enabledState.userPatchPath} exists but could not be read: ${enabledState.userPatchError}`)
  }

  // ── per plugin ────────────────────────────────────────────────────────────
  for (const plugin of inventory.plugins) {
    const kind = kindOf(plugin.sourceType)
    const lock = lockEntries[plugin.name] ?? null
    const flag = enabledState.state[plugin.name] ?? { enabled: null, disabledBy: null, reason: null }
    const installDir = joinPath(joinPath(joinPath(inventory.profile.dir, 'node_modules'), plugin.name), '')
    const installDirClean = installDir.replace(/[\\/]+$/, '')
    const resolvedDir = str(plugin.resolvedDir)
    const packageDir = resolvedDir === null ? installDirClean : parentPath(resolvedDir)

    let git = null
    let fileInfo = null
    let tree = null

    if (kinds.includes(kind)) {
      if (kind === 'link' || kind === 'git') {
        git = await readGitState(fs, packageDir)
        if (git.isRepo !== true && git.error !== null) {
          // Not an error worth a notice for a plain library with no checkout:
          // only surface it when the type is actually git.
          if (kind === 'git') out.notices.push(`${plugin.name}: ${git.error}`)
          git = kind === 'git' ? git : null
        }
      }

      if (kind === 'file') {
        const spec = str(plugin.spec) ?? ''
        const path = spec.startsWith('file:') ? spec.slice('file:'.length) : spec
        const absolute = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') ? path : joinPath(inventory.profile.dir, path)
        const info = await fingerprintFile(fs, absolute)
        fileInfo = { path: absolute, hash: info.hash, size: info.size, mtime: info.mtime }
      }

      if (strategy.hashFileTrees === true && (kind === 'link' || kind === 'file')) {
        const result = await fingerprintDir(fs, packageDir, maxFiles)
        tree = { hash: result.hash, files: result.files, truncated: result.truncated }
        if (result.hash !== null) out.counts.hashed += 1
      }
    }

    const judgement = kinds.includes(kind)
      ? verdictOf({ kind, plugin, lock, git, fileInfo })
      : { verdict: 'unknown', reason: `kind "${kind}" is excluded by strategy.includeKinds`, baseline: null }

    const pathIsLink = resolvedDir !== null && !resolvedDir.startsWith(inventory.profile.dir)
    // The flag itself, with no claim about loading: this projection has no boot
    // graph, so `enabledState` here is only ever the patch-layer answer.
    const stateOf = flag.enabled === false ? 'disabled' : flag.enabled === null ? 'computed' : 'enabled'

    out.counts[judgement.verdict] += 1
    out.plugins.push({
      name: plugin.name,
      spec: plugin.spec,
      sourceType: plugin.sourceType,
      kind,
      ref: refOf(kind, plugin, git),
      specifier: str(lock?.specifier),
      lockVersion: str(lock?.version),
      installedVersion: str(plugin.version),
      resolvedDir,
      pathIsLink,
      commit: git === null ? null : str(git.commit),
      branch: git === null ? null : str(git.branch),
      remote: git === null ? null : str(git.remote),
      trackingRef: git === null ? null : (str(git.trackingRef) ?? str(git.fetchHead)),
      tarball: fileInfo === null ? null : fileInfo.path,
      fileHash: fileInfo === null ? null : fileInfo.hash,
      dirHash: tree === null ? null : tree.hash,
      fileCount: tree === null ? null : tree.files,
      dirHashTruncated: tree === null ? false : tree.truncated,
      verdict: judgement.verdict,
      verdictReason: judgement.reason,
      baseline: judgement.baseline,
      enabled: flag.enabled !== false,
      enabledState: stateOf,
      disabledBy: flag.disabledBy ?? null,
      enabledReason: flag.reason ?? null,
      self: plugin.self === true,
      loaded: plugin.loaded === true,
      declaresBundle: plugin.declaresBundle === true,
    })
  }

  out.counts.total = out.plugins.length
  return out
}
