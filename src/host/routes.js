/**
 * HTTP routes: the host half's only channel to the browser half.
 *
 * `harness.handle` is a dynamic-Cordis-Plugin sandbox builtin and does not
 * exist in a real host plugin (docs/host-notes.md F16). A real plugin's host
 * half uses the one service it is allowed to depend on — `webServer` — and the
 * browser half reaches it with `fetch`.
 *
 * The prefix is duplicated here as a literal **on purpose**: the host half must
 * not read a file at startup (R1 — a top-level failure stops `dsh web`), and
 * `import … from '…json'` needs an import attribute this loader does not want to
 * depend on. `test/host-routes.test.mjs` asserts this literal still equals
 * `src/endpoints.json`, so the two halves cannot drift.
 *
 * Every handler is JSON-only and never throws: a failure becomes `{ error }`
 * with a 500, so a broken read shows up in the panel instead of becoming an
 * unhandled route rejection.
 *
 * ## Which routes can change something, and why that split is enforced here
 *
 * | route | method | effect |
 * |---|---|---|
 * | `overview`, `backend`, `detect`, `refs`, `plan` | GET | read only, always safe |
 * | `remoteRefs` | POST | **contacts the network** — the only route that does |
 * | `apply`, `rollback` | POST | take a snapshot, run a change, verify, roll back on failure |
 * | `toggle` | POST | writes one row into the user's `cordis.patch.yml` |
 *
 * `remoteRefs` is a POST rather than a GET on purpose. It tells a remote which
 * repository this machine is looking at, so it must be impossible to trigger by
 * a page load, a prefetch or a link — only by a deliberate request that a button
 * makes.
 */

import { buildBackend, buildOverview, SELF_NAME } from './overview.js'
import { buildDetect } from './detect-report.js'
import { buildPluginInventory } from './profile.js'
import { setEnabled } from './patch-writer.js'
import { probeDshLauncher, probeGit } from './host.js'
import { readLocalRefs, parseRemoteUrl } from './gitrefs.js'
import { fetchRemoteRefs } from './gitremote.js'
import { toolInstallHint } from './install-hints.mjs'
import {
  checkPackageSpec,
  classifyUpdate,
  materialiseArgv,
  planInstall,
  planRemoval,
  planUpdate,
  pluginCommand,
  rollbackLast,
  runPipeline,
} from './pipeline.js'

/** Path prefix; must equal `prefix` in `src/endpoints.json`. */
export const PREFIX = '/api/dsh-plugin-manager'

/** Endpoint suffixes; must equal `endpoints` in `src/endpoints.json`. */
export const ENDPOINTS = {
  overview: 'overview',
  backend: 'backend',
  detect: 'detect',
  refs: 'refs',
  remoteRefs: 'remote-refs',
  plan: 'plan',
  apply: 'apply',
  rollback: 'rollback',
  toggle: 'toggle',
}

/** Cap on a request body, so a stuck client cannot grow a buffer without bound. */
const MAX_BODY_BYTES = 4096

/** Write one JSON response. */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/**
 * Read a JSON request body.
 *
 * Written by hand rather than with a body-parser helper: this is a plain Node
 * `IncomingMessage` and the host half carries no dependencies (R1). The cap is
 * enforced DURING the read, not after, so an oversized request is refused rather
 * than buffered.
 *
 * @param {object} req - the incoming request.
 * @returns {Promise<object>} the parsed body.
 * @throws {Error} when the body is too large or is not a JSON object.
 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim().length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('request body must be a JSON object'))
          return
        }
        resolve(parsed)
      } catch (error) {
        reject(new Error(`request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  })
}

/**
 * Build one read route handler around a projection.
 * @param {(get: (name: string) => unknown) => unknown | Promise<unknown>} project - the read model.
 * @param {(name: string) => unknown} get - optional-service reader.
 * @param {string} label - endpoint name, for error text.
 * @returns {(req: object, res: object) => Promise<void>} the handler.
 */
function handlerFor(project, get, label) {
  return async function handle(req, res) {
    try {
      sendJson(res, 200, await project(get))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[dsh-plugin-manager] ${label} failed: ${message}`)
      sendJson(res, 500, { error: message })
    }
  }
}

/**
 * The one route that writes only the user's patch file: set a plugin's enabled state.
 *
 * Answers 200 with `ok: false` for a refusal the user can act on (a bad id, a
 * sandbox denial), and 500 only for an unexpected throw. A refusal is a result,
 * not a server error — the panel renders the reason either way.
 *
 * @param {(name: string) => unknown} get - optional-service reader.
 * @returns {(req: object, res: object) => Promise<void>} the handler.
 */
function toggleHandler(get) {
  return async function handle(req, res) {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: `this route writes and accepts POST only, not ${String(req.method)}` })
        return
      }

      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : null
      if (id === null) {
        sendJson(res, 400, { ok: false, error: 'a row id is required' })
        return
      }
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { ok: false, error: '`enabled` must be a boolean' })
        return
      }

      const fs = get('fs')
      const inventory = await buildPluginInventory(fs, SELF_NAME)
      if (!inventory.available || inventory.profile === null) {
        sendJson(res, 200, {
          ok: false,
          error: `the profile could not be read, so no patch file could be written: ${inventory.reason}`,
        })
        return
      }

      // The display name is carried into the row for readability only; the id is
      // what the loader matches on.
      const known = inventory.plugins.find((plugin) => plugin.name === id)
      const result = await setEnabled(fs, inventory.profile.dir, {
        id,
        name: known === undefined ? null : known.name,
        enabled: body.enabled,
      })
      sendJson(res, 200, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[dsh-plugin-manager] toggle failed: ${message}`)
      sendJson(res, 500, { ok: false, error: message })
    }
  }
}

/**
 * Resolve the profile and the CHANGE INDEX — no tools, no subprocesses.
 *
 * Every route that can change something starts here, and this part is pure file
 * reading. The tool probes are deliberately NOT run here: they spawn a child
 * each, and R4 is about work rather than only about requests, so a plan for a
 * registry plugin must not pay for a `git --version` it will never use.
 *
 * The probes are resolved per request rather than cached in module scope: they
 * are the host-fact layer, and a change that ran against a stale "git is absent"
 * answer would be wrong in the one direction that matters (refusing to work).
 *
 * @param {(name: string) => unknown} get - optional-service reader.
 * @returns {Promise<object>} `{ fs, subprocess, inventory, profileDir, profileName, error }`.
 */
async function resolveChangeContext(get) {
  const fs = get('fs')
  const subprocess = get('subprocess')
  const out = { fs, subprocess, inventory: null, profileDir: null, profileName: null, error: null }

  try {
    out.inventory = await buildPluginInventory(fs, SELF_NAME)
  } catch (error) {
    out.error = `the profile could not be read: ${error instanceof Error ? error.message : String(error)}`
    return out
  }
  if (!out.inventory.available || out.inventory.profile === null) {
    out.error = `the profile could not be read: ${out.inventory.reason}`
    return out
  }
  out.profileDir = out.inventory.profile.dir
  out.profileName = out.inventory.profile.name
  return out
}

/**
 * Probe ONLY the tool a classified change actually needs.
 *
 * Returns both probes in the shape the plan and the run want, with the unused
 * one left null — so a caller cannot accidentally read a probe that was never
 * made and mistake "not asked" for "not available".
 *
 * @param {object} context - the result of {@link resolveChangeContext}.
 * @param {string[]} needs - the tool names from `classifyUpdate`.
 * @returns {Promise<{ git: object|null, launcher: object|null }>} the probes that were run.
 */
async function probeFor(context, needs) {
  const out = { git: null, launcher: null }
  if (needs.includes('git')) out.git = await probeGit(context.subprocess, context.fs)
  if (needs.includes('dsh')) out.launcher = await probeDshLauncher(context.fs)
  return out
}

/**
 * `refs` — the local ref index for one plugin's checkout, and the remote it has.
 *
 * Read-only, no network: this is what the machine already knows. The panel shows
 * it beside a separate, deliberate action that asks the remote.
 *
 * @param {(name: string) => unknown} get - optional-service reader.
 * @returns {(req: object, res: object) => Promise<void>} the handler.
 */
function refsHandler(get) {
  return async function handle(req, res) {
    try {
      const name = typeof req.url === 'string' ? nameFromQuery(req.url) : null
      const context = await resolveChangeContext(get)
      if (context.error !== null) {
        sendJson(res, 200, { ok: false, error: context.error })
        return
      }

      const plugin =
        name === null
          ? null
          : context.inventory.plugins.find((candidate) => candidate.name === name) ?? null
      if (name !== null && plugin === null) {
        sendJson(res, 200, { ok: false, error: `no installed plugin is named "${name}"` })
        return
      }

      const target = plugin ?? null
      const root = target === null ? null : parentOf(target.resolvedDir)
      if (root === null) {
        sendJson(res, 200, {
          ok: false,
          name,
          error:
            name === null
              ? 'a name is required: ?name=<package>'
              : 'this plugin records no resolved directory, so there is no checkout to list refs for',
        })
        return
      }

      const local = await readLocalRefs(context.fs, root)
      const remote = local.ok === true ? await remoteOf(context.fs, root) : null
      sendJson(res, 200, {
        ok: local.ok === true,
        name: target.name,
        spec: target.spec,
        sourceType: target.sourceType,
        checkoutRoot: root,
        local,
        remote,
        // The `git` TOOL is not probed here: listing local refs needs no
        // executable, and refusing to show the refs because `git` is missing
        // would hide the one thing this route is for. Whether the picker's
        // choice can then be APPLIED is a question for `plan`, which probes.
        error: local.ok === true ? null : local.error,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[dsh-plugin-manager] refs failed: ${message}`)
      sendJson(res, 500, { ok: false, error: message })
    }
  }
}

/** The `name` query parameter of a request URL, or null. */
function nameFromQuery(url) {
  const query = String(url).indexOf('?')
  if (query === -1) return null
  for (const pair of String(url).slice(query + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (decodeURIComponent(pair.slice(0, eq)) !== 'name') continue
    const value = decodeURIComponent(pair.slice(eq + 1)).trim()
    return value.length === 0 ? null : value
  }
  return null
}

/** The parent directory of a resolved manifest path. */
function parentOf(resolvedDir) {
  if (typeof resolvedDir !== 'string' || resolvedDir.length === 0) return null
  const trimmed = resolvedDir.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut <= 0 ? null : trimmed.slice(0, cut)
}

/**
 * The checkout's origin remote, parsed — or null.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} root - the checkout root.
 * @returns {Promise<object|null>} the parsed remote.
 */
async function remoteOf(fs, root) {
  try {
    const text = await fs.readText(await fs.resolve(`${root}/.git/config`))
    const match = /^\s*url\s*=\s*(.+?)\s*$/m.exec(text)
    if (match === null) return null
    return { url: match[1], ...parseRemoteUrl(match[1]) }
  } catch {
    return null
  }
}

/**
 * `remoteRefs` — ask the remote for its tags and branches.
 *
 * The ONLY route in this package that contacts the network, and it is a POST
 * precisely so it cannot be reached by loading the panel, by a prefetch, or by
 * following a link.
 *
 * @param {(name: string) => unknown} get - optional-service reader.
 * @returns {(req: object, res: object) => Promise<void>} the handler.
 */
function remoteRefsHandler(get) {
  return async function handle(req, res) {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: `this route contacts the network and accepts POST only, not ${String(req.method)}` })
        return
      }
      const body = await readJsonBody(req)
      const context = await resolveChangeContext(get)
      if (context.error !== null) {
        sendJson(res, 200, { ok: false, error: context.error })
        return
      }

      const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : null
      const plugin = name === null ? null : context.inventory.plugins.find((candidate) => candidate.name === name) ?? null
      const root = parentOf(typeof body.dir === 'string' ? body.dir : plugin?.resolvedDir)
      if (root === null) {
        sendJson(res, 200, { ok: false, error: 'a plugin name or a checkout directory is required to know which remote to ask' })
        return
      }

      const remote = await remoteOf(context.fs, root)
      if (remote === null || remote.ok !== true) {
        sendJson(res, 200, {
          ok: false,
          name,
          remote,
          error: remote === null ? 'this checkout records no origin remote' : `the remote URL could not be parsed: ${remote.error}`,
        })
        return
      }

      // A token is used only if the caller supplies one; none is stored, and
      // none is read from the environment (the subprocess seam scrubs
      // credential-shaped names anyway).
      const token = typeof body.token === 'string' && body.token.length > 0 ? body.token : null
      const fetched = await fetchRemoteRefs(context.subprocess, remote, { token })
      sendJson(res, 200, { ...fetched, name, remote })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[dsh-plugin-manager] remote-refs failed: ${message}`)
      sendJson(res, 500, { ok: false, error: message })
    }
  }
}

/**
 * The text of `/etc/os-release`, or null.
 *
 * Read through the host's `fs` service rather than `node:fs`, and read only when
 * a Linux platform is about to need it: on Windows and macOS this file does not
 * exist, so the caller must not pay a failed stat for every plan.
 *
 * @param {object} fs - the resolved `fs` service.
 * @returns {Promise<string|null>} the file's text, or null when unreadable.
 */
async function readOsRelease(fs) {
  if (fs === undefined || fs === null || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') return null
  try {
    return await fs.readText(await fs.resolve('/etc/os-release'))
  } catch {
    return null
  }
}

/**
 * `plan` — what a change would do, without doing it.
 *
 * This is the shape the whole package is built around: the answer arrives
 * BEFORE anything is touched, and it arrives even when the answer is "this
 * cannot be done, and here is why".
 *
 * ⚠️ **All three verbs are planned through this one route**, and the reason is
 * not symmetry for its own sake. `update` was the only verb with a plan, so
 * `add` — the verb a user reaches for most — went straight from a text field to
 * a subprocess. Routing it through here is what makes the package's central
 * promise true of installing as well as of updating.
 *
 * @param {(name: string) => unknown} get - optional-service reader.
 * @returns {(req: object, res: object) => Promise<void>} the handler.
 */
function planHandler(get) {
  return async function handle(req, res) {
    try {
      const query = typeof req.url === 'string' ? req.url : ''
      const name = nameFromQuery(query)
      const ref = parameterFromQuery(query, 'ref')
      const spec = parameterFromQuery(query, 'spec')
      const requested = parameterFromQuery(query, 'verb')
      // Unknown verbs fall back to `update`, the verb this route had first, so a
      // typo can never silently become a plan for something else.
      const verb = requested === 'remove' ? 'remove' : requested === 'add' ? 'add' : 'update'

      if (verb === 'add' && spec === null) {
        sendJson(res, 200, { ok: false, verb, error: 'a spec is required to plan an install: ?verb=add&spec=<spec>' })
        return
      }
      if (verb !== 'add' && name === null) {
        sendJson(res, 200, { ok: false, verb, error: 'a name is required: ?name=<package>' })
        return
      }

      // The spec gate runs BEFORE the profile is read, and the order is the
      // point: whether a spec is acceptable has the same answer no matter what
      // the profile says, and a user whose spec is malformed should be told that,
      // not told about an unrelated failure to read a manifest.
      if (verb === 'add') {
        const checked = checkPackageSpec(spec)
        if (checked.ok !== true) {
          sendJson(res, 200, { ok: false, verb, error: checked.error })
          return
        }
      }

      const context = await resolveChangeContext(get)
      if (context.error !== null) {
        sendJson(res, 200, { ok: false, verb, error: context.error })
        return
      }

      // `add` and `remove` always go through the CLI, so their tool need is known
      // without classifying anything; only `update` has to look at what the
      // plugin IS before it can say which tool it needs. Deciding this FIRST is
      // what keeps the probe honest: a registry install never pays for a
      // `git --version` (R4: no work that was not asked for).
      let needs = ['dsh']
      let classified = null
      if (verb === 'update') {
        classified = await classifyUpdate({ fs: context.fs, inventory: context.inventory, name, ref })
        needs = classified.needs ?? []
      }
      const probes = await probeFor(context, needs)

      const plan =
        verb === 'remove'
          ? await planRemoval({
              fs: context.fs,
              inventory: context.inventory,
              launcher: probes.launcher,
              name,
              profileName: context.profileName,
              selfName: SELF_NAME,
            })
          : verb === 'add'
            ? await planInstall({
                fs: context.fs,
                inventory: context.inventory,
                launcher: probes.launcher,
                spec,
                profileName: context.profileName,
              })
            : await planUpdate({
                fs: context.fs,
                subprocess: context.subprocess,
                launcher: probes.launcher,
                git: probes.git,
                inventory: context.inventory,
                name,
                ref,
                profileName: context.profileName,
              })

      const materialised = materialiseArgv({ git: probes.git, launcher: probes.launcher }, plan.argv)
      // Only when a MISSING tool is what stands in the way: a hint on a plan
      // that can already run is noise, and one shown for "git refused this
      // command" would suggest installing what is already installed.
      const gitMissing = probes.git !== null && probes.git.available !== true && needs.includes('git')
      const installHint = gitMissing
        ? toolInstallHint('git', {
            platform: typeof process !== 'undefined' ? process.platform : null,
            osRelease: typeof process !== 'undefined' && process.platform === 'linux' ? await readOsRelease(context.fs) : null,
          })
        : null
      sendJson(res, 200, {
        ...plan,
        verb,
        runnable: materialised.ok === true,
        runError: materialised.ok === true ? null : materialised.error,
        displayArgv: plan.argv,
        needs,
        installHint,
        tools: {
          // `null` means "not probed", which is different from "not available"
          // and must not be rendered as the same thing.
          git:
            probes.git === null
              ? null
              : { available: probes.git.available, path: probes.git.path, error: probes.git.error },
          dsh:
            probes.launcher === null
              ? null
              : { available: probes.launcher.available, path: probes.launcher.path, error: probes.launcher.error },
        },
        verification:
          verb === 'update'
            ? 'the plan itself changes nothing; pressing update runs verify → snapshot → the command above → verify again, and rolls back on failure'
            : 'the plan itself changes nothing; running it goes through verify → snapshot → the command above → verify again, and rolls back on failure',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[dsh-plugin-manager] plan failed: ${message}`)
      sendJson(res, 500, { ok: false, error: message })
    }
  }
}

/** One query parameter, or null. */
function parameterFromQuery(url, key) {
  const query = String(url).indexOf('?')
  if (query === -1) return null
  for (const pair of String(url).slice(query + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (decodeURIComponent(pair.slice(0, eq)) !== key) continue
    const value = decodeURIComponent(pair.slice(eq + 1)).trim()
    return value.length === 0 ? null : value
  }
  return null
}

/**
 * `apply` — run one change through the pipeline.
 *
 * Refuses with `ok: false` and a reason rather than throwing: a refusal is an
 * answer the panel must show, and the one thing this route must never do is
 * appear to succeed without having changed anything.
 *
 * @param {(name: string) => unknown} get - optional-service reader.
 * @returns {(req: object, res: object) => Promise<void>} the handler.
 */
function applyHandler(get) {
  return async function handle(req, res) {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: `this route changes the profile and accepts POST only, not ${String(req.method)}` })
        return
      }
      const body = await readJsonBody(req)
      const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : null
      const ref = typeof body.ref === 'string' && body.ref.length > 0 ? body.ref : null
      const verb = body.verb === 'remove' ? 'remove' : body.verb === 'add' ? 'add' : 'update'
      const spec = typeof body.spec === 'string' && body.spec.length > 0 ? body.spec : null
      const noVerify = body.noVerify === true
      if (name === null && spec === null) {
        sendJson(res, 400, { ok: false, error: 'a package name or a spec is required' })
        return
      }

      // The gate is applied HERE as well as in `plan`, not instead of it. The
      // panel is expected to plan first, but `apply` is reachable on its own —
      // and a rule that only holds on the path a well-behaved client takes is not
      // a rule. One verification, two enforcement points. It also runs before the
      // profile is read, so a malformed spec is answered as a malformed spec.
      let installSpec = null
      if (verb === 'add') {
        const checked = checkPackageSpec(spec ?? name)
        if (checked.ok !== true) {
          sendJson(res, 400, { ok: false, verb, error: checked.error })
          return
        }
        installSpec = checked.spec
      }

      const context = await resolveChangeContext(get)
      if (context.error !== null) {
        sendJson(res, 200, { ok: false, error: context.error })
        return
      }

      let argv = null
      let label = null
      // Which tool this change needs, decided before any probe: `add`/`remove`
      // always go through the CLI, and `update` depends on what the plugin IS.
      let needs = ['dsh']
      if (verb === 'update') {
        const classified = await classifyUpdate({ fs: context.fs, inventory: context.inventory, name, ref })
        needs = classified.needs ?? []
      }
      const probes = await probeFor(context, needs)

      if (verb === 'add') {
        argv = pluginCommand(context.profileName, 'add', installSpec)
        label = `add ${String(installSpec)}`
      } else if (verb === 'remove') {
        argv = pluginCommand(context.profileName, 'remove', name)
        label = `remove ${name}`
      } else {
        const plan = await planUpdate({
          fs: context.fs,
          subprocess: context.subprocess,
          launcher: probes.launcher,
          git: probes.git,
          inventory: context.inventory,
          name,
          ref,
          profileName: context.profileName,
        })
        if (plan.ok !== true) {
          sendJson(res, 200, { ok: false, error: plan.error, plan })
          return
        }
        argv = plan.argv
        label = `update ${name}${ref === null ? '' : ` → ${ref}`}`
      }

      const run = await runPipeline({
        fs: context.fs,
        subprocess: context.subprocess,
        launcher: probes.launcher,
        git: probes.git,
        selfName: SELF_NAME,
        profileDir: context.profileDir,
        profileName: context.profileName,
        argv,
        label,
        action: verb,
        detail: { name, ref, spec, verb },
        noVerify,
      })

      // The claim the user is about to read must be checked, not assumed: the
      // recorded spec is re-read so "ok" cannot be printed over an unchanged
      // profile.
      const manifestPath = `${context.profileDir}/package.json`
      const recorded = name === null ? null : await readSpecSafely(context.fs, manifestPath, name)
      sendJson(res, 200, { ...run, recordedSpec: recorded, profileDir: context.profileDir })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[dsh-plugin-manager] apply failed: ${message}`)
      sendJson(res, 500, { ok: false, error: message })
    }
  }
}

/** Read one dependency spec out of the profile manifest, tolerating every failure. */
async function readSpecSafely(fs, manifestPath, name) {
  try {
    const text = await fs.readText(await fs.resolve(manifestPath))
    const manifest = JSON.parse(text)
    const deps = manifest !== null && typeof manifest === 'object' ? manifest.dependencies : null
    const value = deps !== null && typeof deps === 'object' ? deps[name] : null
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/**
 * `rollback` — restore the most recent snapshot, or a named one.
 *
 * Separate from `apply` on purpose: the case that matters most is a host that
 * was restarted after a bad change, so this route re-reads the snapshot from
 * disk instead of relying on anything held in memory.
 *
 * @param {(name: string) => unknown} get - optional-service reader.
 * @returns {(req: object, res: object) => Promise<void>} the handler.
 */
function rollbackHandler(get) {
  return async function handle(req, res) {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: `this route changes the profile and accepts POST only, not ${String(req.method)}` })
        return
      }
      const body = await readJsonBody(req)
      const context = await resolveChangeContext(get)
      if (context.error !== null) {
        sendJson(res, 200, { ok: false, error: context.error })
        return
      }
      const result = await rollbackLast({
        fs: context.fs,
        subprocess: context.subprocess,
        profileDir: context.profileDir,
        profileName: context.profileName,
        id: typeof body.id === 'string' && body.id.length > 0 ? body.id : undefined,
      })
      sendJson(res, 200, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[dsh-plugin-manager] rollback failed: ${message}`)
      sendJson(res, 500, { ok: false, error: message })
    }
  }
}

/**
 * Register every route this package serves.
 * @param {object} ctx - the host context.
 * @param {object} webServer - the resolved `webServer` service.
 * @returns {void}
 */
export function registerRoutes(ctx, webServer) {
  const get = (name) => ctx.get(name)

  const routes = [
    { path: `${PREFIX}/${ENDPOINTS.overview}`, label: 'overview', handler: handlerFor(buildOverview, get, 'overview') },
    { path: `${PREFIX}/${ENDPOINTS.backend}`, label: 'backend', handler: handlerFor(buildBackend, get, 'backend') },
    {
      path: `${PREFIX}/${ENDPOINTS.detect}`,
      label: 'detect',
      // Detection is read-only by construction (`strategy.writesAnything` is
      // permanently false), so this needs no confirmation step and no snapshot:
      // pressing it can only ever produce a report.
      handler: handlerFor((innerGet) => buildDetect(innerGet('fs'), SELF_NAME), get, 'detect'),
    },
    { path: `${PREFIX}/${ENDPOINTS.refs}`, label: 'refs', handler: refsHandler(get) },
    { path: `${PREFIX}/${ENDPOINTS.remoteRefs}`, label: 'remote-refs', handler: remoteRefsHandler(get) },
    { path: `${PREFIX}/${ENDPOINTS.plan}`, label: 'plan', handler: planHandler(get) },
    { path: `${PREFIX}/${ENDPOINTS.apply}`, label: 'apply', handler: applyHandler(get) },
    { path: `${PREFIX}/${ENDPOINTS.rollback}`, label: 'rollback', handler: rollbackHandler(get) },
    { path: `${PREFIX}/${ENDPOINTS.toggle}`, label: 'toggle', handler: toggleHandler(get) },
  ]

  for (const route of routes) {
    ctx.effect(
      () => webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      `dsh-plugin-manager: ${route.label} route`,
    )
  }
}
