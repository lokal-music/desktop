import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collapsingGapHeights, focusedScrollTarget } from '../src/lyrics/scrollTarget.mjs'

test('leaving an intro break in compact sidebar does not overshoot scrollTop upward', () => {
  // Compact sidebar card: 420px tall, anchorFraction 0.03 (~12.6px), top spacer 16px.
  // Row 0 is an intro break (33px tall while still open); Row 1 is the first lyric line at offsetTop 49px.
  const lines = [
    { gap: true, time: 0, end: 18 },
    { text: 'I need releasing from this pressure', time: 18 },
    { text: 'This life has such a price to pay', time: 22 },
  ]
  const rows = new Map([
    [0, { rowEl: { offsetTop: 16, offsetHeight: 33 } }],
    [1, { rowEl: { offsetTop: 49, offsetHeight: 54 } }],
    [2, { rowEl: { offsetTop: 103, offsetHeight: 54 } }],
  ])

  const breakScroll = focusedScrollTarget({
    rowOffsetTop: 16,
    clientHeight: 420,
    scrollHeight: 1200,
    anchorFraction: 0.03,
  })
  const collapsing = collapsingGapHeights(lines, rows, 1)
  assert.deepEqual(collapsing, { above: 33, total: 33 })

  const nextScroll = focusedScrollTarget({
    rowOffsetTop: 49,
    clientHeight: 420,
    scrollHeight: 1200,
    anchorFraction: 0.03,
    collapsingAbove: collapsing.above,
    collapsingTotal: collapsing.total,
  })
  // Focus moving from row 0 (gap) to row 1 (lyric) keeps scrollTop unchanged so
  // row 1 glides into the anchor solely via the gap's height collapse.
  assert.equal(nextScroll, breakScroll)
  // After the gap collapses to 0, row 1 sits at offsetTop 16 -> viewport Y is +12.6px (not negative/clipped).
  assert.ok(16 - nextScroll >= 12)
})

test('leaving a mid-song break and jumping multiple lines scrolls only by the lyric rows between them', () => {
  const lines = [
    { text: 'Line 0', time: 0 },
    { gap: true, time: 10, end: 24 },
    { text: 'Line 2', time: 24 },
    { text: 'Line 3', time: 28 },
  ]
  const rows = new Map([
    [0, { rowEl: { offsetTop: 450, offsetHeight: 50 } }],
    [1, { rowEl: { offsetTop: 500, offsetHeight: 33 } }],
    [2, { rowEl: { offsetTop: 533, offsetHeight: 50 } }],
    [3, { rowEl: { offsetTop: 583, offsetHeight: 50 } }],
  ])

  const collapsing = collapsingGapHeights(lines, rows, 3)
  assert.deepEqual(collapsing, { above: 33, total: 33 })

  const target = focusedScrollTarget({
    rowOffsetTop: 583,
    clientHeight: 400,
    scrollHeight: 2000,
    anchorFraction: 0.26,
    collapsingAbove: collapsing.above,
    collapsingTotal: collapsing.total,
  })
  // Settled offsetTop of row 3 is 550; anchor is 104 -> target is 446 (50px past break's 396, not 83px).
  assert.equal(target, 446)
})

test('an active gap row itself is not counted as collapsing', () => {
  const lines = [
    { gap: true, time: 0, end: 18 },
    { text: 'First line', time: 18 },
  ]
  const rows = new Map([
    [0, { rowEl: { offsetTop: 16, offsetHeight: 33 } }],
    [1, { rowEl: { offsetTop: 49, offsetHeight: 54 } }],
  ])

  assert.deepEqual(collapsingGapHeights(lines, rows, 0), { above: 0, total: 0 })
})

test('collapsing gaps below focus reduce settled maxScroll near the end of a track', () => {
  const lines = [
    { text: 'Penultimate line', time: 180 },
    { gap: true, time: 190, end: 210, outro: true },
  ]
  const rows = new Map([
    [0, { rowEl: { offsetTop: 700, offsetHeight: 50 } }],
    [1, { rowEl: { offsetTop: 750, offsetHeight: 33 } }],
  ])

  const collapsing = collapsingGapHeights(lines, rows, 0)
  assert.deepEqual(collapsing, { above: 0, total: 33 })

  const target = focusedScrollTarget({
    rowOffsetTop: 700,
    clientHeight: 400,
    scrollHeight: 800,
    anchorFraction: 0.03,
    collapsingAbove: collapsing.above,
    collapsingTotal: collapsing.total,
  })
  // Settled scrollHeight is 767 -> maxScroll is 367, not 400.
  assert.equal(target, 367)
})
