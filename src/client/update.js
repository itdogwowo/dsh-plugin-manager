/**
 * The update half of a plugin card: which ref, what will happen, and the result.
 *
 * ## The three claims this component is built to keep
 *
 * 1. **"These are the refs I have" is not "these are the refs that exist."**
 *    Local `.git` reading is instant, offline and always available; asking the
 *    remote is a separate button that says so. The two lists are shown in
 *    separate groups so the user can see which is which — never merged into one
 *    confident-looking list.
 * 2. **The plan comes before the button.** Selecting a ref asks the host what it
 *    WOULD do and shows the exact command. The update button stays disabled
 *    until there is a runnable plan, so "I pressed it and nothing happened" is
 *    not a reachable state.
 * 3. **The result is the host's, not this component's guess.** The panel renders
 *    the pipeline's own step list, so a rolled-back update cannot be displayed
 *    as a success by a rendering mistake.
 *
 * ## Why the controls are folded away
 *
 * The plugin list is scanned far more often than it is updated. A card that
 * always shows a version dropdown, three buttons and a command line is a card
 * nobody can scan — so the trigger is one small button, and everything else
 * appears only when it is asked for.
 *
 * ## Where the trigger lives
 *
 * That one button sits on the fold's own line, at the right end of the summary
 * (`pm-fold`, see panel.js) — the card's second line, which already exists. Two
 * other homes were tried and both grew the card to three lines: a full-width row
 * of its own below the fold, and a second line under the switch.
 */

/**
 * Build the update components.
 * @param {object} react - the React instance the bundle was handed.
 * @returns {object} `{ UpdatePanel, groupRefs }`.
 */
export function createUpdatePanel(react) {
  const { useState, useEffect } = react
  const h = react.createElement

  /**
   * Split a ref index into the four groups the picker offers.
   *
   * Pure and exported for the tests: the four groups are the whole privacy and
   * honesty story of this feature, and getting one of them wrong (mixing local
   * into remote, say) would make the panel claim knowledge it does not have.
   * @param {object|null} local - the `refs` response.
   * @param {object|null} remote - the `remote-refs` response.
   * @returns {object[]} groups, each `{ key, items }`.
   */
  function groupRefs(local, remote) {
    const groups = []
    const localTags = local !== null && local !== undefined && local.ok === true && Array.isArray(local.local?.versionTags) ? local.local.versionTags : []
    const localBranches = local !== null && local !== undefined && local.ok === true && Array.isArray(local.local?.branches) ? local.local.branches : []
    const remoteTags = remote !== null && remote !== undefined && remote.ok === true && Array.isArray(remote.tags) ? remote.tags : []
    const remoteBranches = remote !== null && remote !== undefined && remote.ok === true && Array.isArray(remote.branches) ? remote.branches : []

    // A remote ref that is already known locally is shown as the REMOTE one: the
    // point of asking the remote is to learn about things this machine lacks, and
    // a name appearing twice would make the picker look like it had more choices.
    const seen = new Set()
    for (const item of remoteTags) seen.add(`tag:${item.name}`)
    for (const item of remoteBranches) seen.add(`branch:${item.name}`)

    if (localTags.length > 0) groups.push({ key: 'updateGroupLocalVersions', items: localTags.map((item) => ({ ...item, value: `tag:${item.name}`, name: item.name })) })
    if (localBranches.length > 0) groups.push({ key: 'updateGroupLocalBranches', items: localBranches.map((item) => ({ ...item, value: `branch:${item.name}`, name: item.name })) })
    if (remoteTags.length > 0) groups.push({ key: 'updateGroupRemoteVersions', items: remoteTags.map((item) => ({ ...item, value: `tag:${item.name}`, name: item.name })) })
    if (remoteBranches.length > 0) groups.push({ key: 'updateGroupRemoteBranches', items: remoteBranches.map((item) => ({ ...item, value: `branch:${item.name}`, name: item.name })) })

    return groups
  }

  /** One label/value row in the plan block. */
  function Row(props) {
    return h('div', { className: 'pm-upd-row' }, h('span', { className: 'pm-upd-key' }, props.label), h('span', { className: 'pm-upd-val' }, props.children))
  }

  /** A short, readable rendering of an argv. */
  function commandText(argv) {
    if (!Array.isArray(argv) || argv.length === 0) return null
    return argv.map((part) => (/\s/.test(String(part)) ? `"${String(part)}"` : String(part))).join(' ')
  }

  /** One pipeline step, as a chip-shaped line. */
  function stepLine(step, t) {
    const labels = {
      'verify-before': 'stepVerifyBefore',
      snapshot: 'stepSnapshot',
      execute: 'stepExecute',
      'verify-after': 'stepVerifyAfter',
      rollback: 'stepRollback',
    }
    const status = {
      pass: 'statusPass',
      fail: 'statusFail',
      ok: 'statusOk',
      skipped: 'statusSkipped',
      restored: 'statusRestored',
    }
    const good = step.status === 'pass' || step.status === 'ok' || step.status === 'restored'
    // A step name this renderer does not know is shown RAW rather than dropped:
    // a pipeline that grows a step must not become a pipeline that silently
    // stops reporting it.
    const label = labels[step.step] === undefined ? String(step.step) : t(labels[step.step])
    return h(
      'li',
      { key: `${step.step}`, className: good ? 'pm-upd-step' : 'pm-upd-step pm-upd-step-bad' },
      `${label} · ${t(status[step.status] ?? 'statusFail')}`,
      step.note === null || step.note === undefined || String(step.note).length === 0
        ? null
        : h('span', { className: 'pm-upd-note' }, String(step.note)),
    )
  }

  /**
   * The update half's state and its I/O, for ONE plugin.
   *
   * It is a hook rather than a component because the SAME state has to drive two
   * places on the card: the trigger sits in the card's control cluster (under the
   * switch) while the panel it opens sits at the bottom of the fold. Two
   * components would be two copies of this state, and the row button would open
   * nothing.
   *
   * The card calls it; the panel below renders from what it returns and owns no
   * state itself.
   *
   * @param {object} plugin - the inventory row this controller belongs to.
   * @param {object|null} face - the host face, or null when there is none.
   * @param {(key: string) => string} t - copy lookup.
   * @param {boolean} open - whether the card has the panel open. The card owns
   *   this one flag, because the card is what draws the trigger.
   * @param {(next: boolean) => void} setOpen - open or close it.
   * @returns {object} the state, the handlers, and `open` back for the panel.
   */
  function useUpdate(plugin, face, t, open, setOpen) {
    // Hook order is part of the contract with the render test's stub: read them
    // in a fixed order, never conditionally.
    const [refs, setRefs] = useState({ phase: 'idle', data: null, error: null })
    const [remote, setRemote] = useState({ phase: 'idle', data: null, error: null })
    const [picked, setPicked] = useState('')
    const [plan, setPlan] = useState({ phase: 'idle', data: null, error: null })
    const [run, setRun] = useState({ phase: 'idle', data: null, error: null })

    const canAsk = face !== null && face !== undefined && typeof face.refs === 'function'
    const canRemote = face !== null && face !== undefined && typeof face.remoteRefs === 'function'
    const canPlan = face !== null && face !== undefined && typeof face.plan === 'function'
    const canApply = face !== null && face !== undefined && typeof face.apply === 'function'

    // The fetch itself: no state of its own beyond the results, so it can be
    // called from the trigger, from the panel's own reload button, and from a
    // retry, without any of them repeating another's claim.
    function loadRefs() {
      if (!canAsk) {
        setRefs({ phase: 'error', data: null, error: t('noHost') })
        return
      }
      setRefs({ phase: 'loading', data: null, error: null })
      face
        .refs(plugin.name)
        .then((data) => {
          setRefs({ phase: 'ready', data, error: null })
          // Preselect the newest version when this checkout is not already on a
          // branch tip — the common case for "update me".
          const groups = groupRefs(data, null)
          const first = groups.length > 0 && groups[0].items.length > 0 ? groups[0].items[0] : null
          setPicked((current) => (current.length > 0 ? current : first === null ? '' : first.value))
        })
        .catch((error) => setRefs({ phase: 'error', data: null, error: error && error.message ? error.message : String(error) }))
    }

    // The trigger does BOTH things in one click: opening the panel is what puts
    // the ref list on screen, so opening without reading would show an empty box.
    // It is deliberately a handler rather than an effect on `open` — an effect
    // has to decide whether this open is a new one, and "did I already fetch" is
    // state the click already knows the answer to.
    function openPanel() {
      setOpen(true)
      loadRefs()
    }

    function askRemote() {
      if (!canRemote) {
        setRemote({ phase: 'error', data: null, error: t('noHost') })
        return
      }
      setRemote({ phase: 'loading', data: null, error: null })
      face
        .remoteRefs(plugin.name)
        .then((data) => setRemote({ phase: 'ready', data, error: null }))
        .catch((error) => setRemote({ phase: 'error', data: null, error: error && error.message ? error.message : String(error) }))
    }

    // Ask the host what the selected ref WOULD do. Runs on every change of the
    // selection: the plan is the thing the button is gated on, so it must never
    // describe a ref other than the chosen one.
    useEffect(() => {
      if (!open || picked.length === 0 || !canPlan) return undefined
      let alive = true
      const ref = picked.slice(picked.indexOf(':') + 1)
      setPlan({ phase: 'loading', data: null, error: null })
      face
        .plan(plugin.name, ref)
        .then((data) => {
          if (alive) setPlan({ phase: 'ready', data, error: null })
        })
        .catch((error) => {
          if (alive) setPlan({ phase: 'error', data: null, error: error && error.message ? error.message : String(error) })
        })
      return () => {
        alive = false
      }
    }, [open, picked, plugin.name])

    function apply() {
      if (!canApply) {
        setRun({ phase: 'error', data: null, error: t('noHost') })
        return
      }
      // A destructive action gets a confirmation that names what protects the
      // user, not just "are you sure".
      if (typeof window !== 'undefined' && typeof window.confirm === 'function' && window.confirm(`${plugin.name}: ${t('updateConfirm')}`) !== true) return
      const ref = picked.length === 0 ? null : picked.slice(picked.indexOf(':') + 1)
      setRun({ phase: 'running', data: null, error: null })
      face
        .apply(plugin.name, ref)
        .then((data) => {
          setRun({ phase: 'ready', data, error: null })
          // The list above the card is now stale (spec, version, commit), so it
          // is reloaded — the panel must show the host's new state, not this
          // component's assumption about what the update did.
          if (typeof props.onChanged === 'function') props.onChanged()
        })
        .catch((error) => setRun({ phase: 'error', data: null, error: error && error.message ? error.message : String(error) }))
    }

    return {
      open,
      refs,
      remote,
      picked,
      plan,
      run,
      // Which host calls exist at all. The panel draws buttons for them, so the
      // answers travel with the state rather than being recomputed there.
      canRemote,
      setPicked,
      loadRefs,
      openPanel,
      askRemote,
      apply,
    }
  }

  /**
   * The one button a closed update panel is allowed to cost the card.
   *
   * It is a component rather than a bare `h('button', …)` in panel.js so that the
   * button's size, label and disabled reason stay in this file, next to the panel
   * it opens and the copy it uses. Its home is the fold summary's right end, and
   * the summary's flex row is what puts it there.
   *
   * @param {object} props - `t`, `plugin`, `busy`, `canAsk`, `onOpen`, children.
   * @returns {object} the button.
   */
  function UpdateTrigger(props) {
    return h(
      'button',
      {
        type: 'button',
        className: 'pm-btn pm-btn-sm pm-act-btn',
        // The card owns "busy": while a toggle write is in flight, a second write
        // path must not be startable from the same row.
        disabled: props.busy === true,
        // `noHost` is only reachable through this channel, so the failure reason
        // belongs on the control rather than in a note that never gets drawn.
        title: props.canAsk === true ? null : props.t('noHost'),
        onClick: props.onOpen,
      },
      props.children,
    )
  }

  /**
   * The update panel itself — pure presentation.
   *
   * Everything it shows comes from `useUpdate` through props, because the trigger
   * lives in another part of the card. It renders nothing until that trigger has
   * opened it.
   *
   * @param {object} props - the `useUpdate` result, plus `t`, `plugin` and `busy`.
   * @returns {object|null} the panel, or null while it is closed.
   */
  function UpdatePanel(props) {
    const t = props.t
    const plugin = props.plugin
    const { refs, remote, picked, plan, run, canRemote, setPicked, loadRefs, askRemote, apply, copyText } = props

    if (props.open !== true) return null

    const groups = refs.phase === 'ready' ? groupRefs(refs.data, remote.phase === 'ready' ? remote.data : null) : []
    // Named, not implied: the newest tag is preselected, and a preselection
    // nobody explained is a choice the user has to audit before trusting it.
    const newestTag = refs.phase === 'ready' && refs.data !== null && refs.data.local ? refs.data.local.newestTag : null
    const options = []
    for (const group of groups) {
      const rows = []
      for (const item of group.items) {
        const marks = []
        if (item.current === true) marks.push(t('updateCurrent'))
        if (newestTag !== null && item.name === newestTag) marks.push(t('updateNewestTag'))
        rows.push(
          h('option', { key: item.value, value: item.value }, marks.length === 0 ? item.name : `${item.name} · ${marks.join(' · ')}`),
        )
      }
      options.push(h('optgroup', { key: group.key, label: t(group.key) }, rows))
    }

    const local = refs.phase === 'ready' ? refs.data : null
    const headLine =
      local === null || local.ok !== true
        ? null
        : local.local.head.attached === true
          ? `${local.local.head.branch} @ ${String(local.local.head.commit ?? '').slice(0, 10)}`
          : `${t('updateDetached')} @ ${String(local.local.head.commit ?? '').slice(0, 10)}`

    const planData = plan.phase === 'ready' ? plan.data : null
    const runnable = planData !== null && planData.ok === true && planData.runnable === true && planData.noChangeNeeded !== true

    return h(
      'div',
      { className: 'pm-upd' },
      h(
        'div',
        { className: 'pm-upd-head' },
        h('span', { className: 'pm-upd-title' }, t('updatePanel')),
        h('span', { className: 'pm-upd-scope' }, t('updateLocalOnly')),
      ),

      headLine === null ? null : h('div', { className: 'pm-upd-headline pm-mono' }, headLine),

      refs.phase === 'loading' ? h('div', { className: 'pm-upd-note' }, t('updateLoading')) : null,
      refs.phase === 'error' ? h('div', { className: 'pm-upd-note pm-upd-note-bad' }, String(refs.error)) : null,
      refs.phase === 'ready' && refs.data !== null && refs.data.ok !== true
        ? h('div', { className: 'pm-upd-note pm-upd-note-bad' }, String(refs.data.error ?? t('updateNoRefs')))
        : null,

      refs.phase === 'ready' && options.length > 0
        ? h(
            'div',
            { className: 'pm-upd-row' },
            h('label', { className: 'pm-upd-key', htmlFor: `pm-ref-${plugin.name}` }, t('updateRefLabel')),
            h(
              'span',
              { className: 'pm-upd-val' },
              h('select', {
                id: `pm-ref-${plugin.name}`,
                className: 'pm-select',
                value: picked,
                onChange: (event) => setPicked(event && event.target && typeof event.target.value === 'string' ? event.target.value : ''),
              }, options),
            ),
          )
        : null,

      h(
        'div',
        { className: 'pm-upd-actions' },
        h('button', { type: 'button', className: 'pm-btn pm-btn-sm', disabled: refs.phase === 'loading', onClick: loadRefs }, t('updateLoad')),
        // The remote button states what it does. It is the only control on this
        // panel that leaves the machine, so it carries its own verb.
        canRemote
          ? h(
              'button',
              { type: 'button', className: 'pm-btn pm-btn-sm', disabled: remote.phase === 'loading', onClick: askRemote, title: t('updateAskRemote') },
              remote.phase === 'loading' ? t('updateAsking') : t('updateAskRemote'),
            )
          : null,
        h(
          'button',
          { type: 'button', className: 'pm-btn pm-btn-sm', disabled: runnable !== true || run.phase === 'running', onClick: apply, title: runnable === true ? t('updateConfirm') : t('updateRefused') },
          run.phase === 'running' ? t('updateApplying') : t('updateApply'),
        ),
      ),

      // Where the remote answer landed, including the honest failure modes: no
      // API for this host, no remote at all, or a rate limit.
      remote.phase === 'error' ? h('div', { className: 'pm-upd-note pm-upd-note-bad' }, `${t('updateRemoteFailed')}: ${String(remote.error)}`) : null,
      remote.phase === 'ready' && remote.data !== null && remote.data.ok !== true
        ? h('div', { className: 'pm-upd-note' }, `${t('updateRemoteFailed')}: ${String(remote.data.error ?? '')}`)
        : null,
      remote.phase === 'ready' && remote.data !== null && remote.data.ok === true
        ? h('div', { className: 'pm-upd-note' }, `${t('updateRemoteOk')}: ${remote.data.counts.tags} tag / ${remote.data.counts.branches} branch${remote.data.note ? ` — ${remote.data.note}` : ''}`)
        : null,
      remote.phase === 'ready' && remote.data !== null && remote.data.remote !== null && remote.data.remote.ok !== true
        ? h('div', { className: 'pm-upd-note' }, t('updateRemoteNotImplemented'))
        : null,
      // A checkout with no origin is a real and common state (a local experiment
      // that was never pushed). Say it once, next to the ref list, instead of
      // letting the "ask remote" button fail with no explanation.
      refs.phase === 'ready' && refs.data !== null && refs.data.ok === true && (refs.data.remote === null || refs.data.remote === undefined)
        ? h('div', { className: 'pm-upd-note' }, t('updateNoRemote'))
        : null,

      plan.phase === 'loading' ? h('div', { className: 'pm-upd-note' }, t('updateChecking')) : null,
      plan.phase === 'error' ? h('div', { className: 'pm-upd-note pm-upd-note-bad' }, String(plan.error)) : null,

      planData === null
        ? null
        : h(
            'div',
            { className: 'pm-upd-plan' },
            h('div', { className: 'pm-upd-sub' }, t('updatePlan')),
            planData.ok !== true
              ? h('div', { className: 'pm-upd-note pm-upd-note-bad' }, `${t('updateRefused')}: ${String(planData.error ?? '')}`)
              : null,
            planData.noChangeNeeded === true ? h('div', { className: 'pm-upd-note' }, t('updateNoChange')) : null,
            planData.summary ? h(Row, { label: t('updatePlan') }, planData.summary) : null,
            planData.displayArgv && planData.displayArgv.length > 0
              ? h(Row, { label: t('updateWillRun') }, h('code', { className: 'pm-mono pm-break' }, commandText(planData.displayArgv)))
              : null,
            // Which tools the host could actually find. This is the answer to
            // "why is the button refusing", and on a machine with no git it is
            // the whole answer — so it is a row, not a log line.
            planData.tools !== null && planData.tools !== undefined
              ? h(
                  Row,
                  { label: t('updateTools') },
                  h(
                    'span',
                    { className: 'pm-mono' },
                    [planData.tools.git, planData.tools.dsh]
                      .map((tool, index) => {
                        const name = index === 0 ? t('updateToolGit') : t('updateToolDsh')
                        return tool !== null && tool !== undefined && tool.available === true ? `${name} ✓` : `${name} ${t('updateToolAbsent')}`
                      })
                      .join(' · '),
                  ),
                )
              : null,
            planData.runnable !== true && planData.runError
              ? h('div', { className: 'pm-upd-note pm-upd-note-bad' }, `${t('updatePlanNothing')} ${String(planData.runError)}`)
              : null,
            // A refusal that has a way out names it. "Not possible" with no
            // alternative is the answer that makes a panel useless.
            //
            // When the way out is "install the tool", the panel does not stop at
            // naming it: the host sends the platform's own command and its
            // download page (`installHint`), and this renders them as something
            // the user can act on — a link, and the exact text to copy. The panel
            // never installs anything itself: it is a plugin, and running a
            // package manager needs a consent flow it does not have.
            planData.kind === 'checkout' && planData.tools && planData.tools.git && planData.tools.git.available !== true
              ? h(
                  'div',
                  { className: 'pm-upd-fix' },
                  h('div', { className: 'pm-upd-note' }, `${t('updateRequiresGit')} ${t('updateCloneHint')}`),
                  planData.installHint === null || planData.installHint === undefined
                    ? null
                    : h(
                        'div',
                        { className: 'pm-upd-fix-body' },
                        h('div', { className: 'pm-upd-fix-title' }, `${t('updateInstallTitle')} ${String(planData.installHint.tool)}`),
                        planData.installHint.command === null || planData.installHint.command === undefined
                          ? null
                          : h(
                              'div',
                              { className: 'pm-upd-fix-cmd' },
                              h('code', { className: 'pm-mono pm-break' }, String(planData.installHint.command)),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'pm-btn pm-btn-sm',
                                  // The copy is done by `copyText`, and this button is
                                  // only drawn when it exists.
                                  onClick: () => copyText(String(planData.installHint.command)),
                                },
                                t('updateCopy'),
                              ),
                            ),
                        planData.installHint.note === null || planData.installHint.note === undefined
                          ? null
                          : h('div', { className: 'pm-upd-note' }, String(planData.installHint.note)),
                        h(
                          'div',
                          { className: 'pm-upd-actions' },
                          h(
                            'a',
                            {
                              className: 'pm-btn pm-btn-sm',
                              href: String(planData.installHint.url),
                              target: '_blank',
                              rel: 'noreferrer noopener',
                            },
                            `${t('updateInstallOpen')} →`,
                          ),
                          h('span', { className: 'pm-upd-note' }, t('updateInstallManual')),
                        ),
                      ),
                )
              : null,
            Array.isArray(planData.warnings) && planData.warnings.length > 0
              ? h('div', { className: 'pm-upd-note' }, planData.warnings.join(' '))
              : null,
            planData.kind === 'registry' ? h('div', { className: 'pm-upd-note' }, t('updateRegistryNote')) : null,
            planData.kind === 'tarball-url' || planData.kind === 'file' ? h('div', { className: 'pm-upd-note' }, t('updateUrlNote')) : null,
          ),

      run.phase === 'error' ? h('div', { className: 'pm-upd-note pm-upd-note-bad' }, String(run.error)) : null,
      run.phase === 'ready' && run.data !== null
        ? h(
            'div',
            { className: 'pm-upd-result' },
            h(
              'div',
              { className: run.data.ok === true ? 'pm-upd-sub pm-upd-sub-ok' : 'pm-upd-sub pm-upd-sub-bad' },
              run.data.ok === true
                ? t('updateDone')
                : run.data.rollback !== null && run.data.rollback !== undefined
                  ? run.data.rollback.ok === true
                    ? t('updateRolledBack')
                    : `${t('updateRolledBack')} — ${t('updateRollbackFailed')}`
                  : t('updateRefused'),
            ),
            run.data.error ? h('div', { className: 'pm-upd-note pm-upd-note-bad' }, String(run.data.error)) : null,
            run.data.snapshot && run.data.snapshot.id ? h(Row, { label: t('updateSnapshotAt') }, h('span', { className: 'pm-mono' }, run.data.snapshot.id)) : null,
            run.data.skippedVerification === true ? h('div', { className: 'pm-upd-note pm-upd-note-bad' }, t('updateSkippedVerify')) : null,
            Array.isArray(run.data.steps) && run.data.steps.length > 0
              ? h('ul', { className: 'pm-upd-steps' }, run.data.steps.map((step) => stepLine(step, t)))
              : null,
            Array.isArray(run.data.residue) && run.data.residue.length > 0
              ? h(Row, { label: t('updateResidue') }, h('span', { className: 'pm-mono pm-break' }, run.data.residue.map((item) => item.path).join(', ')))
              : null,
            run.data.recordedSpec ? h(Row, { label: t('colSpec') }, h('span', { className: 'pm-mono pm-break' }, String(run.data.recordedSpec))) : null,
          )
        : null,
    )
  }

  UpdatePanel.__groupRefs = groupRefs

  return { UpdatePanel, UpdateTrigger, groupRefs, useUpdate }
}

