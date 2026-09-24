/**
 * Host half of dsh-plugin-manager.
 *
 * Responsibilities on this milestone (M1): register two read-only HTTP routes.
 * No boot-path work, no file writes, no subprocess — the panel pulls everything
 * on demand (R4).
 *
 * Two hard constraints shape this file:
 *
 * - **R1** — the import list is `node:` and relative files only. A top-level
 *   resolution failure here stops the whole `dsh web` process.
 * - **R2** — this half declares exactly ONE service dependency, `webServer`,
 *   and reads everything else optionally with `ctx.get`, so a deployment
 *   missing `clientModules` degrades to an empty panel instead of holding up
 *   startup.
 *
 * There is no `harness` here: that is a dynamic-Cordis-Plugin sandbox builtin,
 * and a real host plugin's `apply` receives the context only
 * (docs/host-notes.md F16). The browser half reaches these routes with `fetch`.
 */

import { mountOnce, ownVersion, PACKAGE_NAME } from './mount-once.js'
import { registerRoutes } from './routes.js'
import { describeProbe, probeDshLauncher, probeGit } from './host.js'

/** Stable cordis plugin name. Deliberately NOT the package name — see cordis.patch.yml. */
export const name = 'plugin-manager'

/**
 * The services this half depends on.
 *
 * `webServer` is the only REQUIRED one, and that is deliberate: `inject` makes
 * cordis hold the plugin until the dependency resolves, and a plugin that waits
 * forever on a service a deployment does not mount is a worse outcome than a
 * plugin whose buttons explain themselves. It is also what R2's spirit asks for
 * — nothing on the boot path may be able to hold up `dsh web`.
 *
 * `subprocess` is read optionally (`ctx.get`) at the moment a change is planned.
 * It IS mounted in this deployment (`dsh-base` loads
 * `@deepseek-ai/dsh-subprocess-local`), but a host half that cannot run a
 * command should say so in the panel, not refuse to load.
 *
 * `fs` stays optional for the same reason: its absence degrades to a notice (F17).
 */
export const inject = ['webServer']

const VERSION = ownVersion(import.meta.url)

/**
 * Apply the host half (once per process).
 * @param {object} ctx - the host context.
 * @returns {void}
 */
export const apply = (ctx) => mountOnce(PACKAGE_NAME, applyImpl)(ctx)

/**
 * The real apply.
 *
 * The probes run HERE — inside `apply`, not at module scope — because R4 forbids
 * work on the import path: a module-level `await` would hold up the loader for
 * every process, including the ones that never open the panel. Inside `apply`
 * they cost one spawn each, once, and they answer the question the user will ask
 * the moment something cannot be updated: "is git even on this machine?".
 *
 * @param {object} ctx - the host context.
 * @returns {void}
 */
function applyImpl(ctx) {
  registerRoutes(ctx, ctx.webServer)

  const clientModules = ctx.get('clientModules')
  const fs = ctx.get('fs')
  console.log(
    `[${PACKAGE_NAME}] host half ready (v${VERSION ?? '?'}); ` +
      `clientModules=${clientModules === undefined || clientModules === null ? 'absent' : 'ready'} ` +
      `pluginInventory=${ctx.get('pluginInventory') === undefined || ctx.get('pluginInventory') === null ? 'absent' : 'ready'} ` +
      `fs=${fs === undefined || fs === null ? 'absent' : 'ready'}`,
  )

  // Fire-and-forget on purpose: the result is only needed when a change is
  // planned, and awaiting a spawn here would put a subprocess on the boot path.
  Promise.resolve()
    .then(async () => {
      const launcher = await probeDshLauncher(fs)
      const git = await probeGit(ctx.subprocess, fs)
      console.log(
        `[${PACKAGE_NAME}] tools: ${describeProbe('dsh', launcher)} ${describeProbe('git', git)}` +
          (launcher.available === true ? '' : ` (tried ${launcher.tried.length} location(s))`) +
          (git.available === true ? '' : ' — a local checkout cannot be moved without git'),
      )
    })
    .catch((error) => {
      // A probe that throws is a fact about this machine, not a reason to fail
      // the boot; it is logged and the features that need it refuse with a reason.
      console.error(`[${PACKAGE_NAME}] tool probe failed: ${error instanceof Error ? error.message : String(error)}`)
    })
}

