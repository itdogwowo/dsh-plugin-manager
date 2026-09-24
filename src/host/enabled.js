/**
 * Is this plugin actually enabled?
 *
 * ## Why this is a real question and not a boolean lookup
 *
 * A bundled row can be disabled **inside the bundle** (`disabled: true`) or by an
 * expression evaluated at compose time (`disabled: !!js process.platform === 'win32'`
 * — the exact shape `@deepseek-ai/dsh-base` uses for its bash and pwsh rows). So
 * an installed plugin can be present on disk, declared in `dsh.profile.bundles`,
 * and still never mount. "Installed" and "enabled" are different questions, and
 * a plugin manager that conflates them is wrong in the one case that matters.
 *
 * The layer order is stated by the bundle's own header comment:
 *
 *   profile root (empty `[]`) → each bundle patch → the user's cordis.patch.yml
 *
 * …with **the last write winning per row**, addressed by `id`. So the user's
 * patch file is the highest authority, and that is where an enable/disable would
 * have to be written.
 *
 * ## Scope
 *
 * This module READS. It resolves state; it never writes a patch entry. Both
 * `enabled` and `disabledBy` exist so the panel can tell apart the three cases a
 * user actually needs to distinguish:
 *
 *   - `enabled: true,  loaded: true`   — running
 *   - `enabled: false`                 — deliberately off, and by what
 *   - `enabled: true,  loaded: false`  — should be running and is not: a fault
 *
 * R1 applies: only `node:` and relative imports. There is deliberately no YAML
 * parser — the shapes read here are narrow, and a real parser is a dependency.
 */

import { join } from 'node:path'

/** Coerce to a non-empty string or null. */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Find every row a patch document mentions, and whether it is disabled.
 *
 * Returns **rows**, not list items. A patch entry is either a direct row
 * (`- id: x`, addressing an existing row) or an `insert:` wrapper holding many
 * rows — and only the children of an insert carry a `name`, which is what
 * identifies a third-party plugin. Flattening to rows is what makes
 * `disabled: true` attach to the right plugin: the first version of this parser
 * recorded the wrapper's own `disabled` and lost which of its ~85 children the
 * flag belonged to.
 *
 * A hand-rolled scan rather than a YAML parse: the host half may not carry a
 * dependency (R1), and only three fields are needed — `id`, `name`, `disabled`.
 *
 * @param {string} text - the patch document.
 * @returns {{ id: string|null, name: string|null, disabled: boolean|string|null, inserted: boolean }[]} rows.
 */
export function parsePatchEntries(text) {
  if (typeof text !== 'string' || text.length === 0) return []

  const lines = text.split('\n')
  const rows = []
  let current = null
  let inInsert = false

  const finish = () => {
    if (current !== null) rows.push(current)
    current = null
  }

  /**
   * Parse one flow-style row body (`id: x, name: y, disabled: false`).
   *
   * Two shapes occur: a bare object, and a whole array of them on one line —
   * `[ { id: x, … } ]`, which is the form the reference `.bak` uses and the form
   * the previous version of this parser silently returned nothing for.
   * @param {string} body - the text between the braces.
   * @returns {object} a row.
   */
  const flowRow = (body) => {
    const read = (key) => {
      const match = body.match(new RegExp(`(?:^|,)\\s*${key}:\\s*([^,}]+)`))
      return match === null ? null : str(match[1].trim().replace(/^['"]|['"]$/g, ''))
    }
    const disabled = read('disabled')
    return { id: read('id'), name: read('name'), disabled: disabled === null ? null : readDisabled(disabled), inserted: false, fieldIndent: null }
  }

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    const trimmed = line.trim()
    // Comments carry real documentation in these files and must not be parsed as
    // content — the bundle header alone would otherwise produce phantom rows.
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue

    // ── a whole flow array on one line: `[ { … } ]` ────────────────────────
    const arrayMatch = trimmed.match(/^\[\s*\{(.*)\}\s*\]\s*$/)
    if (arrayMatch !== null) {
      finish()
      rows.push(flowRow(arrayMatch[1]))
      continue
    }

    // ── a top-level list item ──────────────────────────────────────────────
    const itemMatch = line.match(/^\s{0,4}- (.*)$/)
    if (itemMatch !== null && !inInsert) {
      finish()
      const body = itemMatch[1]
      const flow = body.match(/^\{(.*)\}\s*$/)
      if (flow !== null) {
        rows.push(flowRow(flow[1]))
        continue
      }

      const inline = body.match(/^id:\s*(.+?)\s*$/)
      if (inline !== null) {
        current = { id: str(inline[1].replace(/^['"]|['"]$/g, '')), name: null, disabled: null, inserted: false, fieldIndent: null }
      } else if (/^insert:\s*$/.test(body)) {
        inInsert = true
      }
      continue
    }

    if (/^insert:\s*$/.test(trimmed)) {
      // A bare `insert:` on its own line starts the nested list.
      finish()
      inInsert = true
      continue
    }

    // ── a row nested under `insert:` ───────────────────────────────────────
    const childMatch = line.match(/^\s{4,}- (.*)$/)
    if (inInsert && childMatch !== null) {
      finish()
      const child = childMatch[1]
      const id = child.match(/^id:\s*(.+?)\s*$/)
      current = { id: id === null ? null : str(id[1].replace(/^['"]|['"]$/g, '')), name: null, disabled: null, inserted: true, fieldIndent: null }
      continue
    }

    if (current === null) continue

    // ── a scalar field of the current row ──────────────────────────────────
    // The indent baseline is the row's own field column. Anything deeper is
    // nested inside a block such as `config:`, and must not be read as a row
    // property — `config: { disabled: false }` is a plugin's own configuration,
    // NOT a statement that the row is enabled, and reading it as one flipped the
    // answer for a row that carries no disabled flag at all.
    const field = line.match(/^(\s+)(\w+):\s*(.*?)\s*$/)
    if (field === null) continue

    const [, indent, key, value] = field
    if (current.fieldIndent === null) current.fieldIndent = indent.length
    if (indent.length > current.fieldIndent) continue

    if (key === 'disabled') {
      current.disabled = readDisabled(value)
      continue
    }
    if (key === 'id') {
      current.id = str(value.replace(/^['"]|['"]$/g, ''))
      continue
    }
    if (key === 'name') current.name = str(value.replace(/^['"]|['"]$/g, ''))
  }

  finish()
  return rows
}

/**
 * Interpret a `disabled:` value.
 *
 * Three shapes occur in practice: a boolean, an expression, and nothing. An
 * expression is returned **as an expression string**, never coerced to a
 * boolean: `!!js process.platform === 'win32'` is a fact about the platform, not
 * a user's choice, and reporting it as "you disabled this" would be a lie.
 * @param {string} value - the raw scalar.
 * @returns {boolean|string|null} the parsed value.
 */
function readDisabled(value) {
  if (value.length === 0) return null
  if (value === 'true') return true
  if (value === 'false') return false
  const unquoted = value.replace(/^['"]|['"]$/g, '')
  return unquoted.length === 0 ? null : unquoted
}

/**
 * Read one patch file through the `fs` service.
 * @param {object} fs - the resolved `fs` service.
 * @param {string} path - absolute path.
 * @returns {Promise<{ text: string|null, error: string|null }>} the contents or the reason.
 */
async function readOrNull(fs, path) {
  try {
    return { text: await fs.readText(await fs.resolve(path)), error: null }
  } catch (error) {
    return { text: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Resolve which plugins are disabled, and by which layer.
 *
 * A missing user patch file is **not** an error: it does not exist on a fresh
 * profile, and `dsh plugin add` regenerates `cordis.yml` without creating one.
 *
 * @param {object} fs - the resolved `fs` service.
 * @param {string} profileDir - the profile directory.
 * @param {string[]} names - the installed plugin names to resolve.
 * @returns {Promise<object>} plain-JSON state, keyed by plugin name.
 */
export async function resolveEnabledState(fs, profileDir, names) {
  const out = {
    available: false,
    userPatchPath: join(profileDir, 'cordis.patch.yml'),
    userPatchPresent: false,
    userPatchError: null,
    entries: [],
    disabledElsewhere: [],
    state: {},
  }

  for (const name of names) {
    out.state[name] = { enabled: true, disabledBy: null, reason: null }
  }

  if (fs === undefined || fs === null || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') {
    for (const name of names) {
      out.state[name] = { enabled: null, disabledBy: null, reason: 'the fs service is not available, so no patch layer could be read' }
    }
    return out
  }

  // ── the user's layer: the highest authority, and the only writable one ────
  const user = await readOrNull(fs, out.userPatchPath)
  if (user.text !== null) {
    out.userPatchPresent = true
    out.available = true
    out.entries = parsePatchEntries(user.text)
    for (const row of out.entries) {
      // A user patch row can also INSERT a plugin; those are invisible to
      // `dependencies`, so they are recorded separately rather than silently
      // folded into the inventory.
      if (row.inserted && row.name !== null) {
        out.disabledElsewhere.push({ name: row.name, source: 'user patch insert', disabled: row.disabled })
      }
      if (row.id === null || out.state[row.id] === undefined) continue
      if (row.disabled === true) {
        out.state[row.id] = {
          enabled: false,
          disabledBy: 'user patch (cordis.patch.yml)',
          reason: 'a row in your own patch file sets disabled: true',
        }
      } else if (typeof row.disabled === 'string') {
        out.state[row.id] = {
          enabled: null,
          disabledBy: 'user patch expression',
          reason: `disabled is computed at compose time: ${row.disabled}`,
        }
      }
    }
  } else {
    out.userPatchError = user.error
  }

  // ── bundle layers: a row disabled inside the bundle it ships in ──────────
  // Recorded but NOT treated as authoritative: the user's layer wins per row, so
  // claiming a plugin is off because its bundle says so would be wrong the
  // moment the user's patch turns it back on.
  try {
    const manifestPath = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml')
    const base = await readOrNull(fs, manifestPath)
    if (base.text !== null) {
      out.available = true
      for (const row of parsePatchEntries(base.text)) {
        if (row.disabled !== null && row.id !== null && out.state[row.id] !== undefined) {
          out.disabledElsewhere.push({ name: row.id, source: 'shipped bundle', disabled: row.disabled })
        }
      }
    }
  } catch {
    /* a missing base bundle is not this module's problem to report */
  }

  return out
}
