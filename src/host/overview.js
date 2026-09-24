/**
 * Snapshot builder: turn live host Services into the smallest plain-JSON object
 * the panel needs.
 *
 * Two rules from the repo's hard constraints are enforced here:
 *
 * - **R1** — this file imports only `node:` and relative paths.
 * - **No live data crosses the wire.** Services, loader entries, fibers and
 *   graph objects are read for a handful of leaf fields and then discarded;
 *   nothing here is `JSON.stringify`-ed wholesale.
 *
 * Every field is read defensively: host shapes are read from source, not from a
 * public API (R7), so a renamed or absent field must degrade to a notice instead
 * of throwing inside a route handler.
 */

import { buildPluginInventory, profileDirCandidates } from './profile.js'
import { resolveEnabledState } from './enabled.js'
import { readGitState } from './detect.js'

/** This package's own name, flagged in the inventory rather than hidden. */
export const SELF_NAME = 'dsh-plugin-manager'

/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Coerce to an array or an empty one. */
function arr(value) {
  return Array.isArray(value) ? value : []
}

/** Keep only string members. */
function strArray(value) {
  const out = []
  for (const item of arr(value)) if (typeof item === 'string' && item.length > 0) out.push(item)
  return out
}

/**
 * Project one client-modules graph row.
 * @param {object} entry - a `WebBootEntry`.
 * @param {number} index - position in graph order.
 * @returns {object} plain row.
 */
function projectEntry(entry, index) {
  const source = entry !== null && typeof entry === 'object' ? entry : {}
  return {
    index,
    id: str(source.id) ?? '(no id)',
    url: str(source.url),
    rev: str(source.rev),
    immediate: source.immediately === true,
    inject: strArray(source.inject),
  }
}

/**
 * Project one client-modules batch.
 * @param {object} batch - a `WebBootBatch`.
 * @param {number} index - position in batch order.
 * @returns {object} plain row.
 */
function projectBatch(batch, index) {
  const source = batch !== null && typeof batch === 'object' ? batch : {}
  return {
    index,
    phase: str(source.phase) ?? 'unknown',
    url: str(source.url),
    rev: str(source.rev),
    count: arr(source.entries).length,
    entries: strArray(source.entries),
  }
}

/**
 * Project the `clientModules` service into rows.
 * @param {object} service - the resolved service instance.
 * @param {object} out - the snapshot being built (mutated).
 */
function readClientModules(service, out) {
  let graph
  try {
    graph = service.graph()
  } catch (error) {
    out.notices.push(`clientModules.graph() threw: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (graph === null || typeof graph !== 'object') {
    out.notices.push('clientModules.graph() returned a non-object.')
    return
  }

  out.rev = str(graph.rev)
  out.entries = arr(graph.entries).map(projectEntry)
  out.batches = arr(graph.batches).map(projectBatch)

  const injectSet = new Set()
  let immediate = 0
  for (const row of out.entries) {
    if (row.immediate) immediate += 1
    for (const name of row.inject) injectSet.add(name)
  }
  out.injected = [...injectSet].sort()
  out.counts = {
    total: out.entries.length,
    immediate,
    lazy: out.entries.length - immediate,
    injected: injectSet.size,
    batches: out.batches.length,
    thirdParty: 0,
    thirdPartyLoaded: 0,
  }
}

/**
 * Project the optional `pluginInventory` service. Absent on deployments that
 * never mounted `@deepseek-ai/dsh-host-plugin-inventory` — which is the case on
 * the reference machine — so absence is a normal outcome, not an error.
 * @param {object} service - the resolved service instance.
 * @param {object} out - the snapshot being built (mutated).
 * @returns {Promise<void>} resolves once the read settles.
 */
async function readInventory(service, out) {
  if (typeof service.list !== 'function') {
    out.inventory = { available: true, rows: [], count: 0, error: 'pluginInventory has no list()' }
    return
  }
  try {
    const value = await service.list()
    const source = value !== null && typeof value === 'object' ? value : {}
    const rows = arr(source.entries).map((entry) => {
      const row = entry !== null && typeof entry === 'object' ? entry : {}
      return {
        entryId: str(row.entryId) ?? '(no id)',
        moduleName: str(row.moduleName),
        enabled: row.enabled !== false,
        fiberPhase: str(row.fiberPhase),
      }
    })
    out.inventory = { available: true, rows, count: rows.length }
  } catch (error) {
    out.inventory = {
      available: true,
      rows: [],
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Mark which graph entries are third-party, and cross-reference the inventory.
 *
 * The two sources answer different questions and the value is in joining them:
 * the manifest knows what was **installed**, the graph knows what actually
 * **loaded**. A plugin can be installed-but-not-loaded (broken import, disabled
 * row), and that difference is exactly what a plugin manager exists to show.
 * @param {object} inventory - the result of {@link buildPluginInventory}.
 * @param {object} out - the snapshot being built (mutated).
 */
function joinInventory(inventory, out) {
  // "Extra" means: a profile dependency. A shipped bundle is listed in
  // dsh.profile.bundles but never in dependencies, so this needs no name list
  // that would rot.
  const installedNames = new Set()
  for (const plugin of inventory.plugins) installedNames.add(plugin.name)

  const loadedIds = new Set()
  for (const row of out.entries) loadedIds.add(row.id)

  // Mark the graph rows first, then count from the INVENTORY, not from the
  // graph. An installed dependency and a loaded web plugin are two different
  // questions: `config-forms` is a plain library — installed, never in the boot
  // graph — so counting rows would make the headline number disagree with the
  // list length.
  let thirdPartyLoaded = 0
  for (const row of out.entries) {
    row.thirdParty = installedNames.has(row.id)
    row.self = row.id === SELF_NAME
    if (row.thirdParty) thirdPartyLoaded += 1
  }

  for (const plugin of inventory.plugins) {
    plugin.loaded = loadedIds.has(plugin.name)
  }

  out.counts.thirdParty = inventory.plugins.length
  out.counts.thirdPartyLoaded = thirdPartyLoaded

  out.thirdParty = inventory.plugins
  out.pluginInventory = {
    available: inventory.available,
    reason: inventory.reason,
    profile: inventory.profile,
    manifestPath: inventory.manifestPath,
    declaredBundles: inventory.declaredBundles,
    installed: inventory.plugins.length,
    loaded: inventory.plugins.filter((plugin) => plugin.loaded).length,
  }
}

/**
 * Resolve each plugin's enabled/disabled state and fold it into the inventory.
 *
 * This runs on the **overview** projection and not in the detection report
 * because this is the side that has the boot graph. "Enabled" and "loaded" are
 * different questions, and the useful answer is the pair:
 *
 *   enabled + loaded        running
 *   disabled                deliberately off, and the panel can say by which layer
 *   enabled + not loaded    a fault — it should be running and is not
 *   computed                the flag is an expression, so it was never a choice
 *
 * The detection report has no graph at all, so resolving state there would make
 * every plugin look faulted (verified — it reported `not-loaded` for all eight).
 * @param {object | undefined} fs - the resolved `fs` service.
 * @param {object} inventory - the result of {@link buildPluginInventory}, mutated.
 * @returns {Promise<object>} plain-JSON provenance for the panel.
 */
async function joinEnabledState(fs, inventory) {
  const out = { available: false, patchPath: null, patchPresent: false, reason: null }
  if (!inventory.available || inventory.profile === null) return out

  let resolved
  try {
    resolved = await resolveEnabledState(fs, inventory.profile.dir, inventory.plugins.map((plugin) => plugin.name))
  } catch (error) {
    out.reason = error instanceof Error ? error.message : String(error)
    for (const plugin of inventory.plugins) {
      plugin.enabled = null
      plugin.enabledState = 'unknown'
      plugin.disabledBy = null
      plugin.enabledReason = out.reason
    }
    return out
  }

  out.available = resolved.available === true
  out.patchPath = resolved.userPatchPath ?? null
  out.patchPresent = resolved.userPatchPresent === true
  // Absence is normal — `dsh plugin add` never creates this file — so it is
  // reported as `patchPresent: false`, not as an error.
  if (out.patchPresent && resolved.userPatchError !== null && resolved.userPatchError !== undefined) {
    out.reason = resolved.userPatchError
  }

  for (const plugin of inventory.plugins) {
    const flag = resolved.state[plugin.name] ?? { enabled: true, disabledBy: null, reason: null }
    plugin.enabled = flag.enabled
    plugin.disabledBy = flag.disabledBy ?? null
    plugin.enabledReason = flag.reason ?? null
    plugin.enabledState =
      flag.enabled === false
        ? 'disabled'
        : flag.enabled === null
          ? 'computed'
          : plugin.loaded
            ? 'running'
            : // "Not loaded" is only a FAULT when something was supposed to load.
              // `config-forms` is a plain library: a profile dependency with no
              // `dsh.bundle`, so it never enters the boot graph and never should.
              // The first version called that `not-loaded` and the card showed a
              // warning beside the words for a broken plugin — telling the user
              // something was wrong with a package working exactly as intended.
              plugin.declaresBundle === false
              ? 'library'
              : 'not-loaded'
  }

  return out
}

/**
 * Resolve the version IDENTITY of each plugin, for the ones where `package.json`
 * cannot supply it.
 *
 * A registry package has a real version. A local checkout does not: this very
 * plugin declares `0.0.0` from its first scaffold and has been edited many times
 * since, so the version field is technically accurate and practically a lie. The
 * commit is the identity there.
 *
 * This runs on the OVERVIEW rather than only in the detection report because it
 * is cheap and it is not a freshness claim: `readGitState` reads two or three
 * small files (`HEAD`, one ref, `config`) and walks no directory tree. Making the
 * correct version wait for a button press would be a self-inflicted mystery —
 * "why does it say v0.0.0 until I press check?".
 *
 * @param {object | undefined} fs - the resolved `fs` service.
 * @param {object} inventory - the inventory, mutated in place.
 * @returns {Promise<void>} resolves once every link-installed row is annotated.
 */
async function joinVersionIdentity(fs, inventory) {
  if (fs === undefined || fs === null || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') return

  for (const plugin of inventory.plugins) {
    // Only a `link:` install is a checkout we can read a commit from. A registry
    // install lives inside the profile and already has a real version.
    if (plugin.sourceType !== 'link' && plugin.sourceType !== 'workspace') continue
    const dir = plugin.resolvedDir === null || plugin.resolvedDir === undefined ? null : String(plugin.resolvedDir)
    if (dir === null) continue

    // resolvedDir is `<checkout>/package.json`, so the tree root is its parent.
    const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
    const root = cut > 0 ? dir.slice(0, cut) : dir

    // `pathIsLink` is the host's own answer to "does this install point away from
    // the profile", which is what `link:` means in practice. The detect report had
    // it and the overview did not, so a client reading it here got `undefined`.
    plugin.pathIsLink = true

    try {
      const git = await readGitState(fs, root)
      if (git.isRepo === true && git.commit !== null) {
        plugin.gitCommit = git.commit
        plugin.gitBranch = git.branch
        plugin.gitRemote = git.remote
      }
    } catch {
      // A checkout that cannot be read is not worth a notice: the row simply
      // keeps its package.json version.
    }
  }
}
/**
 * Build the panel's whole read model.
 *
 * Takes a `get` callback rather than a Cordis context on purpose: the same
 * projection is also authored as a dynamic Cordis Package, where the whole body
 * is one function with no module scope and a free `ctx` fails at RUN time
 * (docs/host-notes.md F13). A callback parameter is testable here and portable
 * there — `test/overview.test.mjs` enforces it.
 *
 * Never throws: a missing service becomes a notice so the panel can show what
 * is absent instead of a bare failure.
 * @param {(name: string) => unknown} get - optional-service reader.
 * @returns {Promise<object>} plain-JSON snapshot.
 */
export async function buildOverview(get) {
  const out = {
    at: Date.now(),
    rev: null,
    entries: [],
    batches: [],
    injected: [],
    thirdParty: [],
    counts: { total: 0, immediate: 0, lazy: 0, injected: 0, batches: 0, thirdParty: 0, thirdPartyLoaded: 0 },
    inventory: { available: false, rows: [], count: 0 },
    pluginInventory: {
      available: false,
      reason: null,
      profile: null,
      manifestPath: null,
      declaredBundles: [],
      installed: 0,
      loaded: 0,
    },
    notices: [],
    source: 'none',
    patch: { available: false, patchPath: null, patchPresent: false, reason: null },
  }

  const clientModules = get('clientModules')
  if (clientModules !== undefined && clientModules !== null && typeof clientModules === 'object') {
    out.source = 'clientModules.graph()'
    readClientModules(clientModules, out)
  } else {
    out.notices.push('clientModules service is not available in this host; the entry list will be empty.')
  }

  try {
    const inventory = await buildPluginInventory(get('fs'), SELF_NAME)
    joinInventory(inventory, out)
    if (!inventory.available) {
      // Say exactly what was tried: "nothing installed" and "could not read the
      // profile" must never look the same.
      out.notices.push(`the installed-plugin list is unavailable: ${inventory.reason}`)
      for (const attempt of inventory.attempts) {
        out.notices.push(`${attempt.path} → ${attempt.detail}`)
      }
    } else {
      // After joinInventory, so `loaded` is known and "enabled but not running"
      // can be told apart from "running".
      out.patch = await joinEnabledState(get('fs'), inventory)
      // Also after the inventory, because it reads resolvedDir.
      await joinVersionIdentity(get('fs'), inventory)
    }
  } catch (error) {
    out.notices.push(`the installed-plugin list failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const inventoryService = get('pluginInventory')
  if (inventoryService !== undefined && inventoryService !== null && typeof inventoryService === 'object') {
    await readInventory(inventoryService, out)
  }

  return out
}

/**
 * Report which optional host Services resolved, so the panel can show the
 * difference between "nothing installed" and "the channel is missing".
 *
 * `subprocess` is listed because it is what a change would run the `dsh` CLI
 * through: without it every update button refuses, and the panel's environment
 * section is where a user finds out why before pressing anything.
 * @param {(name: string) => unknown} get - optional-service reader.
 * @returns {object} plain-JSON snapshot.
 */
export function buildBackend(get) {
  const clientModules = get('clientModules')
  const inventory = get('pluginInventory')
  const fs = get('fs')
  const subprocess = get('subprocess')
  const candidates = profileDirCandidates()

  return {
    clientModules: clientModules === undefined || clientModules === null ? 'absent' : 'ready',
    pluginInventory: inventory === undefined || inventory === null ? 'absent' : 'ready',
    fs: fs === undefined || fs === null ? 'absent' : 'ready',
    subprocess: subprocess === undefined || subprocess === null ? 'absent' : 'ready',
    // Every candidate is reported, not just the first: the whole difficulty is
    // that the profile location is inferred rather than told to us.
    profileCandidates: candidates.map((candidate) => `${candidate.dir} (${candidate.source})`),
    node: typeof process !== 'undefined' && process.versions ? str(process.versions.node) : null,
    platform: typeof process !== 'undefined' ? str(process.platform) : null,
  }
}
