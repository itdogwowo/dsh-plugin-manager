/**
 * Panel stylesheet.
 *
 * Appended to the document once per tab mount and removed again on dispose
 * (host-notes F13: a leaked <style> outlives the tab).
 *
 * ## Why this file has a type scale written down
 *
 * The first version of this panel was 8 sibling `<div>`s at 11–14px with a
 * border on each. Read back, the complaint was exact: "everything looks like
 * the same level, I cannot find where one area ends and the next begins".
 * The cause was measurable — a 3px spread between the smallest and largest
 * text, and every region drawn as an equal-weight box.
 *
 * So the scale is now explicit, and asserted by `test/hierarchy.test.mjs`:
 *
 *   L1 .pm-title      15px / 600   — the only text at this size
 *   L2 .pm-sec-title  11px / 600   uppercase, letter-spaced, a rule above it
 *   L3 .pm-name       13px / 600   the plugin name, the one thing you scan
 *   L4 .pm-chip       12px / 400   state and source, on a pill
 *   L5 .pm-meta       11px / 400   spec and change signal, inside a disclosure
 *   L6 .pm-foot       11px / 400   read time, footnote — present, never competing
 *
 * The 11px tier is shared on purpose: the section label and the footer are both
 * the quietest level. The test asserts that exact table rather than "all sizes
 * differ", so a level cannot drift into another's size unnoticed.
 *
 * Section transitions are carried by ONE mechanism: `.pm-sec` draws a rule
 * above itself and owns the whitespace below it. Horizontal rules stay rare
 * (two, currently: sections and the footer) so a border still means "this is
 * content" rather than "this is a region".
 */

/**
 * Theme tokens read at mount, used only to warn when a portal does not expose
 * them. Kept as a list so the probe reports which ones are missing.
 */
export const themeTokens = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
]

export const CSS = `
.pm-root{display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:1.5}

/* ── L1 header ──────────────────────────────────────────────────────────── */
.pm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:12px}
.pm-h1{display:flex;align-items:center;gap:8px;margin:0}
.pm-title{font-size:15px;font-weight:600;margin:0;letter-spacing:-.01em}
.pm-count{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#eef1f4);color:var(--dsw-alias-label-secondary,#656d76);font-size:11px;font-weight:500;font-variant-numeric:tabular-nums}

/* ── L2 section: the only section-transition mechanism ──────────────────── */
.pm-sec{display:flex;flex-direction:column;gap:10px;padding:16px 0 0;border-top:1px solid var(--dsw-alias-border-l1,#d8dee4)}
.pm-sec:first-of-type{border-top:none;padding-top:0}
.pm-sec-head{display:flex;align-items:center;gap:8px}
.pm-sec-title{font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#656d76);margin:0}
.pm-sec-note{font-size:11px;color:var(--dsw-alias-label-secondary,#656d76)}

/* ── controls ───────────────────────────────────────────────────────────── */
.pm-controls{display:flex;align-items:center;gap:8px}
/* Visually hidden, still announced: the search field keeps a name after typing. */
.pm-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.pm-right{flex:none;color:var(--dsw-alias-label-secondary,#656d76);font-size:11px;font-variant-numeric:tabular-nums}
.pm-input{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:6px 10px;font-size:12px;font-family:inherit}
.pm-input::placeholder{color:var(--dsw-alias-label-secondary,#656d76)}
.pm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#0969da)}
.pm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;transition:border-color .12s,color .12s}
.pm-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}
.pm-btn:disabled{opacity:.5;cursor:default}
/* The in-card action. Smaller than a toolbar button because it sits inside a
   row that is 13px tall, and a full-size button would set the card's height. */
.pm-btn-sm{padding:2px 9px;font-size:11px;border-radius:6px}
.pm-btn-sm:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}
/* Every interactive element gets a visible keyboard ring — previously only the
   text input had one, so Tab through the buttons and the disclosures was silent. */
.pm-input:focus-visible,.pm-btn:focus-visible,.pm-disclosure>summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0969da);outline-offset:1px}

/* ── L3 plugin card ─────────────────────────────────────────────────────── */
/* ONE row per plugin. The card has been through three shapes:
 *
 *   v1  three stacked blocks (name / chips / detail)     ~110px
 *   v2  two rows (identity / chips)                      ~64px
 *   v3  one row: identity + state + action, rest folded  ~44px
 *
 * Every reduction answered the same question: which of these is a different
 * LEVEL, and which is merely more of the same? The state chip is 12px against a
 * 13px name, so it reads as a second level without taking a second row. The
 * source, the spec and the change signal are lookups, so they belong in a fold. */
.pm-list{display:flex;flex-direction:column;gap:4px}
.pm-card{display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l1,#d8dee4);background:var(--dsw-alias-bg-base,#ffffff);border-radius:9px;padding:5px 10px;transition:border-color .12s}
.pm-card:hover{border-color:var(--dsw-alias-border-l2,#d0d7de)}
/* "This plugin" is carried by a left rule, not a full coloured outline: an
   outline reads as a state, and self is not a state. */
.pm-card-self{border-left:3px solid var(--dsw-alias-brand-primary,#0969da)}
/* Disabled is the one state that may dim a whole card: the row is present but
   not participating, and that has to be visible before the text is read. */
.pm-card-off{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}
.pm-card-off .pm-name{color:var(--dsw-alias-label-secondary,#656d76)}
/* The card grid. TWO rows, and they are the whole card:
 *
 *   1  identity (1fr)              · the switch and its state (pinned right)
 *   2  the fold's summary (1fr)    · the update trigger (pinned right)
 *
 * Declaring both rows HERE, rather than letting the fold be a sibling block, is
 * what keeps the card two lines tall. The trigger's home was the open question:
 * a full-width row of its own made the card three lines, and putting it under
 * the switch made the CONTROL column two lines, which is also three. On the
 * summary's line it costs nothing — that line already exists — and the shared
 * grid column keeps its right edge on the state label's.
 *
 * No fixed width anywhere: the state's position used to follow the name's
 * length, which is what made the list look ragged. */
.pm-card-grid{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:1px 8px;min-width:0}
/* The fold spans both columns so its summary text starts at the card's left
   edge and the trigger can be pushed to the right end of the same line. */
.pm-card-grid>.pm-disclosure{grid-column:1/-1;min-width:0}
/* Identity takes the free column. min-width:0 is what lets a long name shrink
   and wrap instead of pushing the control out of alignment. */
.pm-lead{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}
.pm-name{font-size:13px;font-weight:600;min-width:0;overflow-wrap:anywhere}
.pm-ver{flex:none;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary,#656d76);font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-2,#eef1f4);border-radius:5px;padding:0 5px}
/* package.json's version is the ONE version signal, for every source kind.
   There was a .pm-ver-rev rule here for rendering a commit in this slot; it is
   gone because the distinction it served was wrong — dsh-power declares 1.8.0
   and dsh-tavern declares 2.6.72, with no git tags anywhere, so a checkout's
   version field is maintained rather than stale. */

/* ── the switch: the card's only control ────────────────────────────────── */
/* A switch, because the thing it controls is binary on/off. The label beside it
   carries the state in words, which is also what satisfies color-not-only — the
   switch itself never has to be read by colour.
   32x18 visual. This is a desktop list row, where the whole row is the pointer
   target; the button keeps a real focus ring for keyboard use. */
.pm-switch{position:relative;flex:none;appearance:none;border:none;padding:0;width:32px;height:18px;border-radius:999px;background:var(--dsw-alias-border-l2,#d0d7de);cursor:pointer;transition:background-color .15s ease-out}
.pm-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#ffffff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease-out}
.pm-switch-on{background:var(--dsw-alias-state-success-primary,#1a7f37)}
/* transform, not left: animating a position property forces layout every frame. */
.pm-switch-on .pm-switch-knob{transform:translateX(14px)}
.pm-switch-busy{opacity:.55}
.pm-switch:disabled{cursor:default;opacity:.45}
.pm-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#0969da);outline-offset:2px}
/* The state in words, immediately right of the switch it describes. */
.pm-state{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#656d76);white-space:nowrap;text-align:right}
.pm-state-on{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.pm-state-off{color:var(--dsw-alias-state-warn-primary,#9a6700)}

/* The control cluster: the switch, then the state in words, on the card's first
   line. It is the grid's own columns 2-3, so nothing here is positioned by a
   magic number. */
.pm-card-actions{grid-row:1;grid-column:2/span 2;display:flex;align-items:center;gap:8px;min-width:0}
/* The card's own action button: the same button as any other, sized to the line
   it shares with an 11px summary. */
.pm-act-btn{flex:none}

/* ── chips: L4 ──────────────────────────────────────────────────────────── */
.pm-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pm-chip{display:inline-flex;align-items:center;border-radius:999px;padding:3px 9px;font-size:12px;line-height:1.45;border:1px solid var(--dsw-alias-border-l2,#d0d7de);color:var(--dsw-alias-label-secondary,#656d76);white-space:nowrap}
.pm-chip-on{color:var(--dsw-alias-state-success-primary,#1a7f37);border-color:var(--dsw-alias-state-success-primary,#1a7f37)}
.pm-chip-off{color:var(--dsw-alias-state-warn-primary,#9a6700);border-color:var(--dsw-alias-state-warn-primary,#9a6700)}
.pm-chip-self{color:var(--dsw-alias-brand-primary,#0969da);border-color:var(--dsw-alias-brand-primary,#0969da)}

/* ── L5/L6 disclosures: diagnostics live down here, out of the way ──────── */
.pm-disclosure{margin-top:0}
/* The summary is the card's second line, and it is a FLEX row rather than an
   inline summary: the fold's name sits at the left edge and the update trigger
   is pushed to the right end, on the same line. A summary element is a flex
   container like any other box — the disclosure behaviour is in the element, not
   in the display. */
.pm-disclosure>summary.pm-fold{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary,#656d76);list-style:none;padding:1px 0}
.pm-fold-name{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.pm-disclosure>summary::-webkit-details-marker{display:none}
.pm-disclosure>summary::before{content:'▸';font-size:9px;display:inline-block;width:8px;flex:none}
.pm-disclosure[open]>summary::before{content:'▾'}
/* The colour change is the FOLD's affordance, so it must not also fire when the
   pointer is over the update trigger sharing this line. */
.pm-disclosure>summary:hover .pm-fold-name{color:var(--dsw-alias-brand-primary,#0969da)}
.pm-meta{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:5px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary,#656d76)}
.pm-meta dt{white-space:nowrap}
.pm-meta dd{margin:0;overflow-wrap:anywhere}
.pm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pm-dim{color:var(--dsw-alias-label-secondary,#656d76)}
.pm-break{overflow-wrap:anywhere}

/* ── notices: a callout earns its box, an empty state does not ──────────── */
.pm-note{border-left:3px solid var(--dsw-alias-state-warn-primary,#9a6700);background:var(--dsw-alias-bg-layer-1,#f6f8fa);border-radius:0 8px 8px 0;padding:8px 11px;font-size:12px}
.pm-note-bad{border-left-color:var(--dsw-alias-state-error-primary,#cf222e)}
.pm-note-title{font-weight:600}
.pm-note-body{color:var(--dsw-alias-label-secondary,#656d76);margin-top:2px}
.pm-tried{margin:4px 0 0;padding-left:16px;color:var(--dsw-alias-label-secondary,#656d76);font-size:11px}
.pm-tried li{margin:1px 0;overflow-wrap:anywhere}
.pm-empty{text-align:center;padding:26px 12px}
.pm-empty-title{font-weight:600}
.pm-empty-body{color:var(--dsw-alias-label-secondary,#656d76);font-size:12px;margin-top:3px}
.pm-empty .pm-btn{margin-top:10px}
.pm-empty-icon{font-size:20px;color:var(--dsw-alias-label-secondary,#656d76);line-height:1;margin-bottom:8px}

/* ── entries table: L5 ──────────────────────────────────────────────────── */
.pm-table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px}
.pm-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary,#656d76);padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#d8dee4);white-space:nowrap}
.pm-table td{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#d8dee4);vertical-align:top}
.pm-table tbody tr:last-child td{border-bottom:none}
.pm-w-idx{width:2.2em}
.pm-w-rev{width:7em}
.pm-w-mode{width:4.5em}
.pm-row-self td{font-weight:500}

/* ── L6 footer: the quietest thing on the panel ─────────────────────────── */
.pm-foot{margin-top:14px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,#d8dee4);font-size:11px;color:var(--dsw-alias-label-secondary,#656d76);display:flex;flex-direction:column;gap:3px}
.pm-foot-note{color:var(--dsw-alias-label-secondary,#656d76)}

/* ── L7 update: a sub-panel inside the card's fold ──────────────────────────
   It borrows the card's left edge rather than drawing a box of its own: the
   update controls belong to the plugin above them, and a second border would
   read as a second card. */
.pm-upd{margin:5px 0 3px;padding-left:9px;border-left:2px solid var(--dsw-alias-border-l1,#d8dee4);display:flex;flex-direction:column;gap:6px;font-size:11px}
.pm-upd-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.pm-upd-title{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
/* The scope line is not decoration: it says the list came from THIS machine. */
.pm-upd-scope{color:var(--dsw-alias-label-secondary,#656d76)}
.pm-upd-headline{color:var(--dsw-alias-label-secondary,#656d76)}
.pm-upd-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;align-items:center}
.pm-upd-key{color:var(--dsw-alias-label-secondary,#656d76);white-space:nowrap}
.pm-upd-val{min-width:0;overflow-wrap:anywhere}
.pm-upd-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pm-select{max-width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#d0d7de);background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:6px;padding:3px 6px;font-size:11px;font-family:inherit}
.pm-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#0969da)}
.pm-upd-note{color:var(--dsw-alias-label-secondary,#656d76);overflow-wrap:anywhere}
.pm-upd-note-bad{color:var(--dsw-alias-state-error-primary,#cf222e)}
.pm-upd-plan,.pm-upd-result{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f6f8fa)}
.pm-upd-sub{font-weight:600;color:var(--dsw-alias-label-secondary,#656d76)}
.pm-upd-sub-ok{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.pm-upd-sub-bad{color:var(--dsw-alias-state-error-primary,#cf222e)}
.pm-upd-steps{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:2px}
.pm-upd-step{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.pm-upd-step-bad{color:var(--dsw-alias-state-error-primary,#cf222e)}
.pm-upd-step .pm-upd-note{margin-left:6px}

/* ── the install field ────────────────────────────────────────────────────
   Deliberately not a card: it is a small, always-present affordance above the
   list, and giving it the same weight as the plugin cards would make the panel
   read as two lists. The plan block below it is where the weight goes, because
   that is the part the user has to read before pressing anything. */
.pm-install{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px dashed var(--dsw-alias-border-l1,#d8dee4);border-radius:9px}
.pm-install-title{font-weight:600;font-size:12px}
.pm-install-lead{font-size:11px;color:var(--dsw-alias-label-secondary,#656d76)}
.pm-install-row{display:flex;align-items:center;gap:6px}
.pm-install-plan{display:flex;flex-direction:column;gap:5px;padding:7px 9px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f6f8fa)}
/* The command is the thing being reviewed, so it is selectable as a whole: a
   partial copy of a command is a command that does something else. */
.pm-code{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1,#d8dee4);border-radius:5px;background:var(--dsw-alias-bg-base,#ffffff);user-select:all}
.pm-install-meta,.pm-install-note{font-size:11px;color:var(--dsw-alias-label-secondary,#656d76)}
.pm-install-notes{margin:0;padding-left:16px;font-size:11px;color:var(--dsw-alias-label-secondary,#656d76);display:flex;flex-direction:column;gap:2px}
.pm-install-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pm-install-goal{font-size:11px;color:var(--dsw-alias-label-secondary,#656d76)}
.pm-btn-run{border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da);font-weight:600}

/* The way out of a refusal. It is the ONE place the update panel offers
   something to DO about a missing tool, so it is set apart from the notes
   around it rather than looking like one more line of explanation. */
.pm-upd-fix{display:flex;flex-direction:column;gap:5px;border-left:3px solid var(--dsw-alias-state-warn-primary,#9a6700);background:var(--dsw-alias-bg-layer-1,#f6f8fa);border-radius:0 8px 8px 0;padding:7px 10px}
.pm-upd-fix-body{display:flex;flex-direction:column;gap:5px}
.pm-upd-fix-title{font-weight:600}
/* The command is the point of the block: monospace, selectable, and on its own
   line so a long one wraps instead of pushing the copy button off the panel. */
.pm-upd-fix-cmd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 7px;border:1px solid var(--dsw-alias-border-l1,#d8dee4);border-radius:6px;background:var(--dsw-alias-bg-base,#ffffff)}
.pm-upd-fix-cmd code{flex:1 1 auto;min-width:0;font-size:11px;user-select:all}
.pm-upd-fix .pm-upd-actions{align-items:center}
/* An anchor styled as a button keeps its underline off: it is a control here,
   not a link inside a sentence. */
a.pm-btn{display:inline-flex;align-items:center;text-decoration:none}

/* Hover borders and the switch knob: both are motion, both stop when asked. */
@media (prefers-reduced-motion: reduce){.pm-card,.pm-btn,.pm-switch,.pm-switch-knob{transition:none}}
`

/**
 * Append the panel stylesheet to the document, once.
 *
 * @param {object} doc - the document to install into.
 * @returns {() => void} a disposer that removes the style element.
 */
export function installStyles(doc) {
  const existing = doc.querySelector('style[data-dsh-plugin="dsh-plugin-manager-panel"]')
  if (existing !== null && existing !== undefined) {
    return () => undefined
  }

  const style = doc.createElement('style')
  style.setAttribute('data-dsh-plugin', 'dsh-plugin-manager-panel')
  style.textContent = CSS
  doc.head.appendChild(style)

  return () => {
    if (style.parentNode !== null && style.parentNode !== undefined) {
      style.parentNode.removeChild(style)
    }
  }
}

/**
 * Read the theme tokens once, so a portal that does not expose them is
 * diagnosable instead of silently rendering unstyled.
 *
 * The return shape is a contract with the bundle wrapper, which reads
 * `probe.missing`. Returning a bare array here threw
 * `Cannot read properties of undefined (reading 'length')` from inside `apply`
 * and took every test in the suite down with it.
 *
 * @param {object} doc - the document to probe.
 * @returns {{missing: string[]}} the tokens that resolved to nothing.
 */
export function probeTheme(doc) {
  const view = doc.defaultView ?? globalThis
  if (typeof view.getComputedStyle !== 'function') return { missing: [] }
  const computed = view.getComputedStyle(doc.documentElement)
  return { missing: themeTokens.filter((token) => computed.getPropertyValue(token).trim() === '') }
}
