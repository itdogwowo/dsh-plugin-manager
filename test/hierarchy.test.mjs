/**
 * The panel's information hierarchy is a contract, not a taste.
 *
 * The first version of this panel was eight sibling `<div>`s with a border on
 * each and 11–14px text throughout. Read back, the complaint was exact:
 * "everything looks like the same level, I cannot find where one area ends and
 * the next begins". A 3px spread between the smallest and largest text, with
 * every region drawn as an equal-weight box, will do that.
 *
 * Both halves of the fix are asserted here, because either one alone does not
 * produce a readable panel:
 *
 *   1. STRUCTURE — the panel emits named sections, so a reader is told where
 *      they are. Previously the only section-like element was a bare `<details>`.
 *   2. SCALE — those levels differ enough in size to be seen. This is the part
 *      a screenshot review misses and an assertion catches.
 *
 * These tests fail if the hierarchy is flattened: verified by collapsing
 * `.pm-title` to 13px and by dropping `Section` from the panel
 * (docs/host-notes.md F24).
 */

import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CSS } from '../src/client/styles.js'

const PANEL = readFileSync(new URL('../src/client/panel.js', import.meta.url), 'utf8')

/**
 * Extract the font size declared for one selector from the stylesheet.
 *
 * Reads the RULE'S LINES rather than matching `selector{...}` on one line: a
 * long declaration list gets wrapped by the formatter, so `.pm-chip{…}` can span
 * several lines and a `[^}]*` pattern anchored right after the brace silently
 * returns null. That made this test report "declares no font-size" for a rule
 * that plainly had one — a false alarm that reads exactly like a real one.
 *
 * @param {string} css - the stylesheet source.
 * @param {string} selector - the exact selector, e.g. `.pm-title`.
 * @returns {number|null} the size in px, or null when not declared.
 */
function fontSizeOf(css, selector) {
  const lines = css.split('\n')
  const open = `${selector}{`
  for (let i = 0; i < lines.length; i += 1) {
    // The line must BEGIN the declaration. A descendant rule such as
    // `.pm-card-off .pm-name{…}` therefore cannot answer for `.pm-name`.
    if (!lines[i].startsWith(open)) continue
    let body = lines[i].slice(open.length)
    for (let j = i + 1; j < lines.length && !body.includes('}'); j += 1) body += lines[j]
    const declared = body.split('}')[0].match(/font-size:\s*(\d+(?:\.\d+)?)px/)
    return declared === null ? null : Number(declared[1])
  }
  return null
}

/** The literal keys the panel passes to `t('…')` as a Section title. */
function sectionTitleKeys(source) {
  const keys = new Set()
  // `h\(\s*Section` has to tolerate a line break: the formatter puts the
  // arguments on their own lines when the call is long, so the first version
  // of this pattern silently found 2 of the 3 sections.
  for (const match of source.matchAll(/h\(\s*Section,\s*\{\s*title:\s*t\('([^']+)'\)/gs)) keys.add(match[1])
  return [...keys].sort()
}

test('hierarchy: the panel emits more than one named section', () => {
  const titles = sectionTitleKeys(PANEL)
  assert.ok(
    titles.length >= 3,
    `expected at least 3 named sections (plugins, boot order, environment), found ${titles.length}: ${titles.join(', ')}`,
  )
})

test('hierarchy: the section titles are distinct', () => {
  const titles = sectionTitleKeys(PANEL)
  assert.equal(new Set(titles).size, titles.length, `two sections share a title: ${titles.join(', ')}`)
})

test('hierarchy: the named levels declare the sizes the scale promises', () => {
  // Asserted as an exact table rather than "all different": two levels legitimately
  // share 11px (the section label and the footer are both the quietest tier).
  // What matters is that a level does not silently drift into another's size.
  const expected = {
    '.pm-title': 15,
    '.pm-sec-title': 11,
    '.pm-name': 13,
    '.pm-chip': 12,
    '.pm-foot': 11,
  }

  for (const [selector, size] of Object.entries(expected)) {
    assert.equal(
      fontSizeOf(CSS, selector),
      size,
      `${selector} should be ${size}px — if this is intentional, update the scale table in styles.js too`,
    )
  }
})

test('hierarchy: the scale spans enough steps to be read', () => {
  const levels = ['.pm-title', '.pm-sec-title', '.pm-name', '.pm-chip', '.pm-foot']
  const values = levels.map((selector) => fontSizeOf(CSS, selector))
  assert.ok(
    new Set(values).size >= 4,
    `found only ${new Set(values).size} distinct sizes across ${levels.length} levels: ${values.join(', ')}`,
  )
  assert.equal(
    values[0],
    Math.max(...values),
    'the panel title must be the largest text on the panel',
  )
})

test('hierarchy: the top of the scale is at least 4px above the DETAIL levels', () => {
  // A 3px spread was the measured cause of "everything is the same level".
  // 4px is the floor, not the target. The chip is deliberately not in this
  // list: at 12px it is a mid level that pairs with the 13px plugin name, and
  // holding it to the 4px rule would force it below a legible size.
  const title = fontSizeOf(CSS, '.pm-title')
  for (const selector of ['.pm-sec-title', '.pm-foot', '.pm-meta']) {
    const size = fontSizeOf(CSS, selector)
    assert.notEqual(size, null, `${selector} declares no font-size`)
    assert.ok(
      title - size >= 4,
      `${selector} is ${size}px against a ${title}px title — a ${title - size}px spread is too flat to read`,
    )
  }
})

test('hierarchy: the dominant level is the plugin name, not the metadata', () => {
  // The one thing a reader scans for must be the largest thing in the card.
  const name = fontSizeOf(CSS, '.pm-name')
  const chip = fontSizeOf(CSS, '.pm-chip')
  assert.ok(name > chip, `the plugin name (${name}px) must outrank its chips (${chip}px)`)
})

test('hierarchy: sections draw the transition, and rules stay scarce', () => {
  const sec = CSS.match(/\.pm-sec\{([^}]*)\}/)
  assert.notEqual(sec, null, '.pm-sec must exist — it owns the section transition')
  assert.ok(/border-top:/.test(sec[1]), '.pm-sec must draw a rule above itself')
  // The point is not "exactly one rule" — the footer legitimately draws one
  // too. The point is that rules stay rare enough that a border MEANS "this is
  // content". The first version put a border on all eight sibling divs, which
  // is why every region read as equally important.
  const rules = [...CSS.matchAll(/border-top:1px solid/g)]
  assert.ok(rules.length >= 1 && rules.length <= 4, `expected a small number of horizontal rules, found ${rules.length}`)
})

test('hierarchy: no TEXT is set below 11px', () => {
  // The one 9px declaration is the disclosure caret glyph, which is a shape
  // rather than text, so it is stripped before the check.
  const withoutGlyphs = CSS.replace(/\.pm-disclosure>summary::before\{[^}]*\}/g, '')
  const sizes = [...withoutGlyphs.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
  assert.ok(sizes.length > 0, 'the stylesheet declares no font sizes at all')
  assert.ok(
    Math.min(...sizes) >= 11,
    `smallest text is ${Math.min(...sizes)}px — below 11px it stops being readable`,
  )
})

test('hierarchy: the card grid pins the control with a grid column, not a fixed width', () => {
  // The raggedness came from the status sitting right after the name, so its
  // position moved with the name's length. The fix is a grid column, which
  // aligns without a magic number — and a fixed `width` would break the moment a
  // Chinese label and an English one differ in width.
  //
  // Matching on `width:` alone would also hit the `minmax(` and the `min-width:0`
  // in this rule, so the boundary is required.
  const fixedWidth = /(?:^|;)\s*width:\s*\d/

  const grid = CSS.match(/\.pm-card-grid\{([^}]*)\}/)
  assert.notEqual(grid, null, '.pm-card-grid must declare its layout')
  assert.match(grid[1], /display:grid/, 'the card must be a grid so the control column is stable')
  assert.match(
    grid[1],
    /grid-template-columns:minmax\(0,1fr\) auto auto/,
    'identity is the flexible column; the switch and its label are sized to content',
  )
  assert.equal(fixedWidth.test(grid[1]), false, 'the grid must not pin a fixed width')

  // The fold is a row OF that grid, not a sibling block after it: that is what
  // lets the update trigger share the summary's line instead of adding a third
  // row. Both failed attempts (a full-width row of its own, then a second line
  // under the switch) grew the card to three lines.
  assert.match(
    CSS,
    /\.pm-card-grid>\.pm-disclosure\{[^}]*grid-column:1\/-1/,
    'the fold must span the grid’s row, or the trigger cannot share its line',
  )

  // And the state label must not be given a fixed width either: it is the thing
  // whose length differs between locales.
  const state = CSS.match(/\.pm-state\{([^}]*)\}/)
  assert.notEqual(state, null, '.pm-state must declare its style')
  assert.equal(fixedWidth.test(state[1]), false, '.pm-state must be sized by its text')
})

test('hierarchy: the stylesheet text contains no backtick', () => {
  // `CSS` is a template literal, so a backtick ANYWHERE inside it — including in
  // a CSS comment — terminates the string early and turns the whole client bundle
  // into a syntax error. That happened: a comment documenting `flex-wrap` broke
  // it and took eight tests down at once, with a message pointing at the generated
  // bundle rather than at this file.
  const ticks = CSS.split('`').length - 1
  assert.equal(ticks, 0, `the CSS text contains ${ticks} backtick(s) — each one ends the template literal early`)
})

test('hierarchy: the card keeps its padding small enough to stay thin', () => {
  // Rows are the dominant term, but padding is what pushed the first version
  // over: 9px of padding on a three-block card is 18px of chrome for no content.
  const card = CSS.match(/\.pm-card\{([^}]*)\}/)
  assert.notEqual(card, null, '.pm-card must declare its box')
  const padding = card[1].match(/padding:\s*(\d+)px/)
  assert.notEqual(padding, null, '.pm-card must declare a padding')
  assert.ok(Number(padding[1]) <= 6, `card padding is ${padding[1]}px — above 6px the chrome outweighs a one-row card`)
  const gap = card[1].match(/gap:\s*(\d+)px/)
  assert.notEqual(gap, null, '.pm-card must declare a gap')
  assert.ok(Number(gap[1]) <= 2, `card gap is ${gap[1]}px — the folded disclosure should sit tight under the row`)
})
