/**
 * The host face the panel talks to.
 *
 * A real bundle has **no** `host.call` — that is the dynamic Cordis Plugin
 * sandbox's package-private RPC (docs/host-notes.md F16). A real plugin's
 * browser half reaches the host through the **web server**: the host registers
 * routes with `ctx.webServer.register`, and the client uses `fetch`. This is
 * the same channel `@linxin666/dsh-client-ui-plugin-manager` uses on runtimes
 * that lack the official installer services.
 *
 * The endpoints arrive as an argument rather than through an import, because
 * every inlined module must be standalone (the bundle wrapper is the only place
 * that calls `require`). The values come from `src/endpoints.json`, which the
 * build folds in — so the two halves still cannot drift.
 */

/**
 * Build the face.
 * @param {typeof fetch} doFetch - the page's fetch.
 * @param {object} endpoints - the contract from `src/endpoints.json`.
 * @returns {object} the host calls this bundle may make.
 */
export function createFace(doFetch, endpoints) {
  /** Absolute URL of one endpoint. */
  function urlFor(name) {
    const suffix = endpoints.endpoints[name]
    if (suffix === undefined) throw new Error(`dsh-plugin-manager: unknown endpoint "${name}"`)
    return `${endpoints.prefix}/${suffix}`
  }

  /**
   * GET one endpoint and parse it as JSON.
   * @param {string} name - endpoint key from `src/endpoints.json`.
   * @param {string} [query] - an optional query string, without the `?`.
   * @returns {Promise<object>} the decoded payload.
   */
  async function read(name, query) {
    const suffix = query === undefined || query.length === 0 ? '' : `?${query}`
    const response = await doFetch(`${urlFor(name)}${suffix}`, {
      method: endpoints.method,
      headers: { accept: 'application/json' },
    })

    let payload = null
    try {
      payload = response === null || response === undefined ? null : await response.json()
    } catch {
      payload = null
    }

    if (response === null || response === undefined || response.ok !== true) {
      const status = response === null || response === undefined ? 'no response' : `HTTP ${response.status}`
      const detail =
        payload !== null && typeof payload === 'object' && typeof payload.error === 'string' ? `: ${payload.error}` : ''
      throw new Error(`dsh-plugin-manager: ${name} failed (${status})${detail}`)
    }

    if (payload === null || typeof payload !== 'object') {
      throw new Error(`dsh-plugin-manager: ${name} returned a non-object payload`)
    }

    return payload
  }

  /**
   * POST one endpoint and parse it as JSON.
   *
   * Resolves with the host's outcome rather than rejecting on a refusal: a
   * refusal is an answer the panel has to show — the whole point of the update
   * panel is that "no" comes with a reason. It rejects only when the channel
   * itself failed.
   *
   * @param {string} name - endpoint key.
   * @param {object} body - the JSON request body.
   * @returns {Promise<object>} the decoded payload.
   */
  async function write(name, body) {
    const response = await doFetch(urlFor(name), {
      method: endpoints.writeMethod ?? 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    if (response === null || response === undefined || response.ok !== true) {
      const status = response === null || response === undefined ? 'no response' : `HTTP ${response.status}`
      const detail =
        payload !== null && typeof payload === 'object' && typeof payload.error === 'string' ? `: ${payload.error}` : ''
      throw new Error(`dsh-plugin-manager: ${name} failed (${status})${detail}`)
    }
    return payload
  }

  return {
    /**
     * Read the whole panel read-model.
     *
     * Both endpoints are fetched and merged, because the panel renders ONE
     * `data` object: the host serves the entry list and the backend report from
     * two routes, and reading only the first leaves `data.backend` undefined —
     * which then crashes any row that reads through it. A failed backend read
     * is not fatal: the entry list is the point, so the report degrades to null.
     * @returns {Promise<object>} the merged snapshot.
     */
    load: async () => {
      const [overview, backend] = await Promise.all([read('overview'), read('backend').catch(() => null)])
      return { ...overview, backend }
    },
    backend: () => read('backend'),
    /**
     * Read the detection report.
     *
     * Deliberately NOT part of `load()`. Detection walks every linked plugin's
     * directory tree to fingerprint it, which is real work; opening the tab must
     * stay cheap (R4). The panel asks for this only when the user asks for it,
     * and a failure degrades to a readable notice rather than a blank section.
     * @returns {Promise<object>} the detection report.
     */
    detect: () => read('detect'),
    /**
     * Read the LOCAL ref index of one plugin's checkout.
     *
     * No network: this is what the machine already knows, so it is safe to ask
     * for whenever the update panel opens.
     * @param {string} name - the package name.
     * @returns {Promise<object>} the ref index.
     */
    refs: (name) => read('refs', `name=${encodeURIComponent(String(name))}`),
    /**
     * Ask the REMOTE for its tags and branches.
     *
     * The only call in this bundle that leaves the machine. It is a POST so it
     * can never be triggered by a page load or a prefetch, and the panel only
     * calls it from a button that says what it does.
     * @param {string} name - the package name.
     * @returns {Promise<object>} the remote ref list, or a reason there is none.
     */
    remoteRefs: (name) => write('remoteRefs', { name }),
    /**
     * Ask what an update WOULD do, without doing it.
     * @param {string} name - the package name.
     * @param {string|null} ref - the chosen ref, or null for "re-resolve".
     * @returns {Promise<object>} the plan.
     */
    plan: (name, ref) =>
      read('plan', `name=${encodeURIComponent(String(name))}${ref === null || ref === undefined || ref === '' ? '' : `&ref=${encodeURIComponent(String(ref))}`}`),
    /**
     * Run one update through the pipeline.
     *
     * Resolves with the host's run record — including `ok: false`, the failed
     * step and whether the rollback restored the profile. A rejected promise
     * here means the channel broke, not that the update failed.
     * @param {string} name - the package name.
     * @param {string|null} ref - the chosen ref.
     * @param {object} [extra] - `{ verb, spec, noVerify }` for add/remove.
     * @returns {Promise<object>} the run record.
     */
    apply: (name, ref, extra = {}) => write('apply', { name, ref, ...extra }),
    /**
     * Restore the most recent snapshot, or a named one.
     * @param {string} [id] - the snapshot id.
     * @returns {Promise<object>} the rollback result.
     */
    rollback: (id) => write('rollback', id === undefined ? {} : { id }),
    /**
     * Set one plugin's enabled state.
     *
     * It RESOLVES with the host's outcome rather than rejecting on a refusal,
     * because a sandbox denial is an answer the panel has to show — not an
     * exception to swallow. It rejects only when the channel itself failed.
     * @param {string} id - the loader row id, which is the package name.
     * @param {boolean} enabled - the desired state.
     * @returns {Promise<object>} the host's outcome, including `restartRequired`.
     */
    setEnabled: (id, enabled) => write('toggle', { id, enabled }),
  }
}
