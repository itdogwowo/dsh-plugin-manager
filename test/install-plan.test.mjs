/**
 * Planning an INSTALL (and a removal), and the gate in front of it.
 *
 * ## Why this suite exists at all
 *
 * `apply` has accepted `verb: 'add'` since the pipeline was written, but nothing
 * in the UI ever called it, so the path was never exercised end to end: a spec
 * went from a text field straight to a subprocess. Two claims the package makes
 * about itself were therefore FALSE of installing, and only of installing:
 *
 *   "the answer arrives BEFORE anything is touched"  — there was no plan;
 *   "nothing runs that was not shown"                — nothing was shown.
 *
 * These tests pin both, plus the gate that has to hold on **both** entry points.
 * `checkPackageSpec` is deliberately strict, so the accepted list is asserted as
 * carefully as the refused one: an over-eager gate would push users back to the
 * CLI, which is a real cost and not a safe default.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const pipeline = await import('../src/host/pipeline.js')
const routesModule = await import('../src/host/routes.js')
const { checkPackageSpec, nameFromSpec, planInstall, planRemoval } = pipeline

/** The specs a real profile on this machine actually records. */
const ACCEPTED = [
  '^1.2.0',
  '1.2.3',
  '~0.1.5-rc.3',
  'some-plugin',
  '@scope/some-plugin',
  '@scope/some-plugin@^2.0.0',
  'link:../../../dsh-plugin-manager',
  'file:./plugin.tgz',
  'file:/tmp/plugin-1.0.0.tgz',
  'github:owner/repo',
  'github:owner/repo#v0.9.0',
  'git+https://host/owner/repo.git#main',
  'https://host/releases/latest/download/plugin.tgz',
  'npm:real-name@^1.0.0',
]

test('spec gate: every shape a real profile uses is accepted', () => {
  for (const spec of ACCEPTED) {
    const verdict = checkPackageSpec(spec)
    assert.equal(verdict.ok, true, `"${spec}" must be accepted, got: ${String(verdict.error)}`)
    assert.equal(verdict.spec, spec)
  }
})

test('spec gate: a leading hyphen is refused, because the CLI would read it as an option', () => {
  // The realistic way a UI text field becomes an unintended action.
  for (const spec of ['--global', '-g', '--help']) {
    const verdict = checkPackageSpec(spec)
    assert.equal(verdict.ok, false, `"${spec}" must be refused`)
    // The refusal must carry a way out: the official CLI is still allowed to
    // accept what this gate does not understand.
    assert.match(verdict.error, /hyphen/)
    assert.match(verdict.error, /dsh plugin/)
  }
})

test('spec gate: control characters and line breaks are refused', () => {
  for (const spec of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u001bb']) {
    const verdict = checkPackageSpec(spec)
    assert.equal(verdict.ok, false, `${JSON.stringify(spec)} must be refused`)
  }
})

test('spec gate: shell metacharacters are refused, and the message says why they cannot be paths', () => {
  // These are NOT defended against as shell injection — the spec goes into an
  // argv array, never into a shell string. They are refused because their
  // presence means a command was pasted into a package field.
  for (const spec of ['a;rm -rf /', 'a|b', 'a$(b)', 'a`b`', 'a&&b', 'a"b', "a'b", 'a\\b']) {
    const verdict = checkPackageSpec(spec)
    assert.equal(verdict.ok, false, `${JSON.stringify(spec)} must be refused`)
  }

  // Windows paths are the one real cost of refusing a backslash, so the refusal
  // has to say what to write instead rather than leaving the user stuck. The path
  // is BUILT rather than written out literally, because a literal home-path shape
  // trips the privacy scan in verify.mjs — that is the scan working as designed,
  // and not a reason to weaken it.
  const home = ['C:', 'Users', 'example'].join('/')
  const verdict = checkPackageSpec(`link:${home.replace(/\//g, '\\')}/plugin`)
  assert.equal(verdict.ok, false)
  assert.match(verdict.error, /forward slashes/)
  assert.match(verdict.error, /dsh plugin/, 'the refusal must offer the CLI as the way out')

  // The same path with forward slashes is accepted, which is what makes the
  // refusal a request to restyle the path rather than a wall.
  assert.equal(checkPackageSpec(`link:${home}/plugin`).ok, true)
})

test('spec gate: a scoped-looking version is called out as a version', () => {
  const verdict = checkPackageSpec('@1.2.3')
  assert.equal(verdict.ok, false)
  assert.match(verdict.error, /@scope\/name@version/)
})

test('spec gate: empty, non-ASCII and absurdly long specs are refused', () => {
  assert.equal(checkPackageSpec('').ok, false)
  assert.equal(checkPackageSpec(null).ok, false)
  assert.equal(checkPackageSpec(undefined).ok, false)
  assert.equal(checkPackageSpec('插件').ok, false)
  assert.equal(checkPackageSpec('a'.repeat(1025)).ok, false)
  // The boundary is inclusive, so 1024 itself must still pass.
  assert.equal(checkPackageSpec('a'.repeat(1024)).ok, true)
})

test('nameFromSpec: names are derived only when the spec carries one', () => {
  assert.equal(nameFromSpec('github:owner/repo'), 'repo')
  assert.equal(nameFromSpec('github:owner/repo.git#v1.0.0'), 'repo')
  assert.equal(nameFromSpec('git+https://host/owner/repo.git#main'), 'repo')
  assert.equal(nameFromSpec('some-plugin'), 'some-plugin')
  assert.equal(nameFromSpec('@scope/some-plugin@^2.0.0'), '@scope/some-plugin')
  assert.equal(nameFromSpec('some-plugin@1.2.3'), 'some-plugin')
})

test('nameFromSpec: an unknowable name answers null rather than a guess', () => {
  // ⚠️ null means "cannot be told from the spec", NOT "no name". A plan that
  // guessed here would claim to know which installed plugin it replaces.
  for (const spec of ['^1.2.0', 'link:../somewhere', 'file:./x.tgz', 'https://host/x.tgz', 'npm:real@^1.0.0', 'workspace:*']) {
    assert.equal(nameFromSpec(spec), null, `"${spec}" must not yield a guessed name`)
  }
})

/** An inventory holding one installed plugin. */
function inventoryWith(plugin) {
  return { available: true, plugins: [plugin] }
}

test('planInstall: a spec that is not installed produces a runnable plan and says it is an addition', async () => {
  const plan = await planInstall({
    inventory: inventoryWith({ name: 'other', spec: '^1.0.0', version: '1.0.0' }),
    spec: 'github:owner/repo#v0.9.0',
    profileName: 'web',
    launcher: { available: true, path: '/launcher' },
  })

  assert.equal(plan.ok, true)
  assert.equal(plan.verb, 'add')
  assert.equal(plan.name, 'repo')
  assert.equal(plan.alreadyInstalled, false)
  assert.equal(plan.noChangeNeeded, false)
  assert.equal(plan.dryRun, true)
  assert.deepEqual(plan.argv, ['dsh', 'plugin', '--profile', 'web', 'add', 'github:owner/repo#v0.9.0'])
  // A fresh install has nothing to warn about beyond an unknowable name, and
  // this spec's name IS knowable, so there must be no warning at all.
  assert.deepEqual(plan.warnings, [])
})

test('planInstall: an installed plugin with the SAME spec is reported as no change needed', async () => {
  const plan = await planInstall({
    inventory: inventoryWith({ name: 'repo', spec: 'github:owner/repo#v0.9.0', version: '0.9.0' }),
    spec: 'github:owner/repo#v0.9.0',
    profileName: 'web',
    launcher: { available: true },
  })

  assert.equal(plan.ok, true)
  assert.equal(plan.alreadyInstalled, true)
  assert.equal(plan.sameSpec, true)
  assert.equal(plan.noChangeNeeded, true)
  assert.equal(plan.from, '0.9.0')
  assert.equal(plan.warnings.length, 1)
})

test('planInstall: an installed plugin with a DIFFERENT spec says it replaces what is recorded', async () => {
  const plan = await planInstall({
    inventory: inventoryWith({ name: 'repo', spec: 'github:owner/repo#v0.8.0', version: '0.8.0' }),
    spec: 'github:owner/repo#v0.9.0',
    profileName: 'web',
    launcher: { available: true },
  })

  assert.equal(plan.ok, true)
  assert.equal(plan.alreadyInstalled, true)
  assert.equal(plan.sameSpec, false)
  assert.equal(plan.noChangeNeeded, false)
  assert.equal(plan.current, 'github:owner/repo#v0.8.0')
  // The replacement must be stated, not implied: silently overwriting a recorded
  // spec is the one thing a user cannot discover afterwards.
  assert.equal(plan.warnings.some((line) => line.includes('REPLACES')), true)
  assert.equal(plan.warnings.some((line) => line.includes('rolled back')), true)
})

test('planInstall: a spec whose name cannot be derived says so instead of claiming it is new', async () => {
  const plan = await planInstall({
    inventory: inventoryWith({ name: 'repo', spec: '^1.0.0', version: '1.0.0' }),
    spec: '^1.0.0',
    profileName: 'web',
    launcher: { available: true },
  })

  // There IS an installed plugin whose spec is identical, but the spec names no
  // package, so the honest answer is "cannot tell" — `alreadyInstalled` stays
  // false and the warning explains the limit. Claiming "fresh" here would be a
  // lie the panel would then render as fact.
  assert.equal(plan.alreadyInstalled, false)
  assert.equal(plan.name, null)
  assert.equal(plan.warnings.some((line) => line.includes('does not name the package')), true)
})

test('planInstall: an unacceptable spec is refused WITH the reason, never thrown', async () => {
  const plan = await planInstall({
    inventory: inventoryWith({ name: 'x', spec: '^1.0.0', version: '1.0.0' }),
    spec: '--global',
    profileName: 'web',
    launcher: { available: true },
  })

  assert.equal(plan.ok, false)
  assert.equal(typeof plan.error, 'string')
  assert.match(plan.error, /hyphen/)
  assert.deepEqual(plan.argv, [], 'a refused plan must carry no command to run')
})

test('planInstall: a missing launcher leaves a plan that exists but cannot run', async () => {
  // Same rule as `planUpdate`: the plan is still produced, because the panel has
  // to be able to say WHAT is missing. A plan that vanishes when a tool is absent
  // teaches the user nothing.
  const plan = await planInstall({
    inventory: inventoryWith({ name: 'x', spec: '^1.0.0', version: '1.0.0' }),
    spec: 'some-plugin',
    profileName: 'web',
    launcher: { available: false, error: 'not found on this machine' },
  })

  assert.equal(plan.ok, false)
  assert.equal(typeof plan.error, 'string')
  assert.match(plan.error, /dsh launcher is required/)
  assert.match(plan.error, /not found on this machine/)
  assert.equal(plan.argv.length > 0, true, 'the command is still shown')
})

test('planInstall: with no probe at all the plan is still produced', async () => {
  const plan = await planInstall({ inventory: inventoryWith({ name: 'x', spec: '^1.0.0', version: '1.0.0' }), spec: 'some-plugin', profileName: 'web' })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.argv, ['dsh', 'plugin', '--profile', 'web', 'add', 'some-plugin'])
})

test('planRemoval: removing an installed plugin plans the remove verb', async () => {
  const plan = await planRemoval({
    inventory: inventoryWith({ name: 'some-plugin', spec: '^1.0.0', version: '1.2.0' }),
    name: 'some-plugin',
    profileName: 'web',
    launcher: { available: true },
    selfName: 'dsh-plugin-manager',
  })

  assert.equal(plan.ok, true)
  assert.equal(plan.verb, 'remove')
  assert.equal(plan.from, '1.2.0')
  assert.deepEqual(plan.argv, ['dsh', 'plugin', '--profile', 'web', 'remove', 'some-plugin'])
})

test('planRemoval: removing the manager ITSELF warns before the button, not after', async () => {
  const plan = await planRemoval({
    inventory: inventoryWith({ name: 'dsh-plugin-manager', spec: 'link:../pm', version: '0.1.0' }),
    name: 'dsh-plugin-manager',
    profileName: 'web',
    launcher: { available: true },
    selfName: 'dsh-plugin-manager',
  })

  assert.equal(plan.ok, true)
  assert.equal(plan.warnings.some((line) => line.includes('plugin manager itself')), true)
})

test('planRemoval: a plugin that is not installed is refused with the reason', async () => {
  const plan = await planRemoval({ inventory: inventoryWith({ name: 'x', spec: '^1.0.0' }), name: 'nope', profileName: 'web', launcher: { available: true } })
  assert.equal(plan.ok, false)
  assert.match(plan.error, /no installed plugin is named "nope"/)
})

/* ── the route layer ──────────────────────────────────────────────────────
   The gate has TWO enforcement points on purpose: `plan` is what a
   well-behaved client calls, and `apply` is reachable on its own. A rule that
   only holds on the polite path is not a rule, so both are pinned here. */

/** A `res` recording what the handler wrote. */
function fakeRes() {
  return {
    status: null,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body
    },
  }
}

/** A fake request carrying a JSON body, with the events `readJsonBody` listens for. */
function fakeReq(method, body) {
  const listeners = new Map()
  const req = {
    method,
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return req
    },
    destroy() {},
  }
  // Emit on the next tick so the handler has attached its listeners first.
  setImmediate(() => {
    if (body !== undefined) for (const fn of listeners.get('data') ?? []) fn(Buffer.from(body, 'utf8'))
    for (const fn of listeners.get('end') ?? []) fn()
  })
  return req
}

/** Mount the routes against a stub with no `fs`, so nothing can be read. */
function mountRoutes(services = {}) {
  const routes = []
  const ctx = {
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'webServer') return undefined
      return services[name]
    },
    webServer: {
      register(route) {
        routes.push(route)
      },
    },
  }
  routesModule.registerRoutes(ctx, ctx.webServer)
  return routes
}

test('route: plan accepts verb=add and demands a spec for it', async () => {
  const routes = mountRoutes()
  const plan = routes.find((route) => route.path.endsWith('plan'))

  const missing = fakeRes()
  await plan.handler({ method: 'GET', url: '/x?verb=add' }, missing)
  assert.equal(JSON.parse(missing.body).error, 'a spec is required to plan an install: ?verb=add&spec=<spec>')

  // With a spec the request gets as far as the profile, which this stub cannot
  // read — so the answer is the PROFILE's refusal, which proves the spec was
  // accepted and the verb was understood.
  const withSpec = fakeRes()
  await plan.handler({ method: 'GET', url: '/x?verb=add&spec=some-plugin' }, withSpec)
  const payload = JSON.parse(withSpec.body)
  assert.equal(payload.ok, false)
  assert.match(String(payload.error), /profile could not be read/)
  assert.equal(payload.verb, 'add')
})

test('route: a refused spec is stopped by the gate BEFORE the profile is read', async () => {
  // The order is the assertion. This stub has NO profile it could read, so a spec
  // that got past the gate would come back with "the profile could not be read".
  // Seeing the hyphen refusal instead is what proves the gate ran first — and the
  // order matters because the two answers have nothing to do with each other.
  const routes = mountRoutes()
  const plan = routes.find((route) => route.path.endsWith('plan'))

  const res = fakeRes()
  await plan.handler({ method: 'GET', url: `/x?verb=add&spec=${encodeURIComponent('--global')}` }, res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.match(String(payload.error), /hyphen/)
  assert.doesNotMatch(String(payload.error), /profile could not be read/)
})

test('route: apply refuses an unacceptable spec with 400 and never spawns', async () => {
  const routes = mountRoutes()
  const apply = routes.find((route) => route.path.endsWith('apply'))

  const res = fakeRes()
  await apply.handler(fakeReq('POST', JSON.stringify({ verb: 'add', spec: '--global' })), res)
  const payload = JSON.parse(res.body)
  assert.equal(res.status, 400)
  assert.equal(payload.ok, false)
  assert.match(String(payload.error), /hyphen/)
  // The profile was never consulted, so nothing could have been snapshotted or run.
  assert.equal(payload.steps, undefined)
})

test('route: apply with no name and no spec still says what is required', async () => {
  const routes = mountRoutes()
  const apply = routes.find((route) => route.path.endsWith('apply'))

  const res = fakeRes()
  await apply.handler(fakeReq('POST', JSON.stringify({ verb: 'add' })), res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.match(String(payload.error), /name or a spec is required/)
})
