import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  LOCAL_HOME_SECTION_DEFAULTS,
  LOCAL_HOME_SECTION_TITLES,
  restoreLocalHomeLayout,
  visibleLocalHomeSectionIds,
  moveLocalHomeSection,
  showLocalHomeSection,
  localHomeStorageKey,
  readLocalHomeLayout,
  writeLocalHomeLayout,
} from '../src/localHomeLayout.mjs'

test('Local Home defaults and titles cover Made for you, Your Mixes, Suggested for You, and Recently Added', () => {
  assert.deepEqual(LOCAL_HOME_SECTION_DEFAULTS, ['madeForYou', 'mixes', 'suggestions', 'recent'])
  assert.equal(LOCAL_HOME_SECTION_TITLES.madeForYou, 'Made for you')
  assert.equal(LOCAL_HOME_SECTION_TITLES.mixes, 'Your Mixes')
  assert.equal(LOCAL_HOME_SECTION_TITLES.suggestions, 'Suggested for You')
  assert.equal(LOCAL_HOME_SECTION_TITLES.recent, 'Recently Added')
})

test('reorder and disable are independent, and restore recovers missing/unknown sections', () => {
  const restored = restoreLocalHomeLayout({
    order: ['recent', 'mixes', 'recent', 'removed'],
    hidden: ['mixes', 'removed'],
  })
  assert.deepEqual(restored.order, ['recent', 'mixes', 'madeForYou', 'suggestions'])
  assert.deepEqual(restored.hidden, ['mixes'])
  assert.deepEqual(visibleLocalHomeSectionIds(restored), ['recent', 'madeForYou', 'suggestions'])

  const moved = moveLocalHomeSection(restored, 3, 0)
  assert.equal(moved.order[0], 'suggestions')
  assert.deepEqual(moved.hidden, ['mixes'])

  const shown = showLocalHomeSection(moved, 'mixes', true)
  assert.ok(visibleLocalHomeSectionIds(shown).includes('mixes'))

  const hidden = showLocalHomeSection(shown, 'madeForYou', false)
  assert.ok(!visibleLocalHomeSectionIds(hidden).includes('madeForYou'))

  assert.strictEqual(moveLocalHomeSection(hidden, -1, 0), hidden)
  assert.strictEqual(moveLocalHomeSection(hidden, 0, 99), hidden)
  assert.strictEqual(showLocalHomeSection(hidden, 'invalidSection', false), hidden)
})

test('Local Home layouts persist per user and recover from malformed storage', () => {
  const state = new Map()
  const storage = { getItem: k => state.get(k) ?? null, setItem: (k, v) => state.set(k, v) }

  const layout = showLocalHomeSection(moveLocalHomeSection(restoreLocalHomeLayout(), 3, 0), 'suggestions', false)
  writeLocalHomeLayout(storage, 'user A', layout)

  assert.deepEqual(readLocalHomeLayout(storage, 'user A'), layout)
  assert.deepEqual(readLocalHomeLayout(storage, 'user B'), restoreLocalHomeLayout())

  state.set(localHomeStorageKey('user C'), '{malformed')
  assert.deepEqual(readLocalHomeLayout(storage, 'user C'), restoreLocalHomeLayout())
})

test('Home wires right-click Edit on Home header and renders Local Home in saved order', () => {
  const home = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8')
  const editor = readFileSync(new URL('../src/components/LocalHomeSectionEditor.jsx', import.meta.url), 'utf8')

  assert.match(home, /data-home-greeting onContextMenu=\{homeHeaderMenu\}/)
  assert.match(home, /openLocalHomeMenu = event => openMenu\(event, \[\{ label: 'Edit'/)
  assert.match(home, /visibleLocalHomeSectionIds\(localHomeLayout\)/)
  assert.match(home, /data-local-home-section=\{id\}/)
  assert.match(home, /readLocalHomeLayout\(window\.localStorage, uidKey\)/)
  assert.match(home, /writeLocalHomeLayout\(window\.localStorage, uidKey, safe\)/)
  assert.match(home, /<LocalHomeSectionEditor open=\{showLocalHomeEditor\}/)
  assert.match(editor, /onDragStart=\{event =>/)
  assert.match(editor, /onDrop=\{event =>/)
  assert.match(editor, /showLocalHomeSection\(layout, id, event\.target\.checked\)/)
  assert.match(editor, /Move \{name\} up/)
})
