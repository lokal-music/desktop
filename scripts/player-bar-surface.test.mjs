import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PLAYER_BAR_SURFACES,
  PLAYER_BAR_SURFACE_OPTIONS,
  resolvePlayerBarSurface,
  isFloatingPlayerBarSurface,
  playerBarSurfacePresentation,
} from '../src/playerBarSurface.mjs'

test('player bar surface exposes Off, Glass, Mica, and Acrylic options', () => {
  assert.deepEqual(PLAYER_BAR_SURFACES, ['off', 'glass', 'mica', 'acrylic'])
  assert.deepEqual(
    PLAYER_BAR_SURFACE_OPTIONS.map(option => option.id),
    ['off', 'glass', 'mica', 'acrylic'],
  )
})

test('resolvePlayerBarSurface preserves legacy glass_player_bar defaults and overrides', () => {
  assert.equal(resolvePlayerBarSurface({}), 'glass')
  assert.equal(resolvePlayerBarSurface({ glass_player_bar: '1' }), 'glass')
  assert.equal(resolvePlayerBarSurface({ glass_player_bar: '0' }), 'off')
  assert.equal(resolvePlayerBarSurface({ glass_player_bar: '0', player_bar_surface: 'mica' }), 'mica')
  assert.equal(resolvePlayerBarSurface({ glass_player_bar: '1', player_bar_surface: 'acrylic' }), 'acrylic')
  assert.equal(resolvePlayerBarSurface({ glass_player_bar: '1', player_bar_surface: 'off' }), 'off')
  assert.equal(resolvePlayerBarSurface({ glass_player_bar: '0', player_bar_surface: 'unknown' }), 'off')
  assert.equal(resolvePlayerBarSurface('', true), 'glass')
  assert.equal(resolvePlayerBarSurface('', false), 'off')
  assert.equal(resolvePlayerBarSurface('mica', false), 'mica')
})

test('Glass, Mica, and Acrylic float over content while Off remains docked', () => {
  assert.equal(isFloatingPlayerBarSurface('off'), false)
  assert.equal(isFloatingPlayerBarSurface('glass'), true)
  assert.equal(isFloatingPlayerBarSurface('mica'), true)
  assert.equal(isFloatingPlayerBarSurface('acrylic'), true)

  const off = playerBarSurfacePresentation('off')
  assert.equal(off.floating, false)
  assert.doesNotMatch(off.className, /\babsolute\b/)

  const glass = playerBarSurfacePresentation('glass')
  assert.equal(glass.floating, true)
  assert.match(glass.className, /backdrop-blur-lg/)

  const mica = playerBarSurfacePresentation('mica')
  assert.equal(mica.floating, true)
  assert.match(mica.className, /player-bar-mica/)

  const acrylic = playerBarSurfacePresentation('acrylic')
  assert.equal(acrylic.floating, true)
  assert.match(acrylic.className, /player-bar-acrylic/)
})

test('Settings, PlayerBar, App, and CSS wire Mica and Acrylic surfaces', () => {
  const settings = readFileSync(new URL('../src/pages/Settings.jsx', import.meta.url), 'utf8')
  const playerBar = readFileSync(new URL('../src/components/PlayerBar.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

  assert.match(settings, /PLAYER_BAR_SURFACE_OPTIONS/)
  assert.match(settings, /set\('player_bar_surface', mode\)/)
  assert.match(playerBar, /data-player-bar-surface=\{surfacePresentation\.mode\}/)
  assert.match(app, /usePlayerBarSurface\(\)/)
  assert.match(css, /\.player-bar-mica\b/)
  assert.match(css, /\.player-bar-acrylic\b/)
  assert.match(css, /html\[data-theme="light"\] \.player-bar-mica\b/)
  assert.match(css, /html\[data-theme="light"\] \.player-bar-acrylic\b/)
})
