/**
 * Host single-instance guard.
 *
 * A host half that registers the same RPC handlers (or routes) twice throws
 * inside the second `apply`, and a throw during tree composition is exactly what
 * makes `dsh web` fail to start. Two install sources of one package — an npm
 * copy beside a `link:` checkout — produce two loader entries, so the guard is
 * keyed by **package name**, not by row id, and rides a global symbol so two
 * module instances of the same package still agree.
 *
 * Ported from the same-named helper in `@linxin666/dsh-client-ui-plugin-manager`
 * (`.ref/src__mount-once.ts`). cordis `ctx.effect` runs its callback immediately
 * and treats the return value as the fiber disposer, so the unmarker is
 * returned, not run.
 */

import { readFileSync } from 'node:fs'

/** Must match package.json `name` — it is also the client bundle id. */
export const PACKAGE_NAME = 'dsh-plugin-manager'

const MOUNTED = Symbol.for('dsh-plugin-manager.mounted-plugins')

/** The process-global set of package names whose host half is live. */
function mountedSet() {
  const existing = globalThis[MOUNTED]
  if (existing instanceof Set) return existing
  const created = new Set()
  globalThis[MOUNTED] = created
  return created
}

/**
 * Wrap a cordis plugin apply so the package runs at most once per process.
 * The first mount registers normally and unmarks when its fiber disposes; any
 * later mount of the same package name is a no-op.
 * @param {string} packageName - npm package identity shared by every install source.
 * @param {(ctx: object) => unknown} fn - the original plugin apply.
 * @returns {(ctx: object) => unknown} an apply of the same shape.
 */
export function mountOnce(packageName, fn) {
  return function guardedApply(ctx) {
    const mounted = mountedSet()
    if (mounted.has(packageName)) return undefined
    mounted.add(packageName)
    ctx?.effect?.(() => () => {
      mounted.delete(packageName)
    })
    return fn(ctx)
  }
}

/**
 * Read this package's own version from its manifest, so the panel footer can
 * show a stale install instead of hiding it.
 * @param {string} manifestUrl - `import.meta.url` of the calling module.
 * @returns {string | null} the version, or null when unreadable.
 */
export function ownVersion(manifestUrl) {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', manifestUrl), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}
