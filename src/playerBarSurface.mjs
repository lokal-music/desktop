// Footer player bar surface styles: Off (docked plain strip), Glass, Mica, Acrylic.
export const PLAYER_BAR_SURFACES = Object.freeze(['off', 'glass', 'mica', 'acrylic'])

export const PLAYER_BAR_SURFACE_OPTIONS = Object.freeze([
  { id: 'off', label: 'Off' },
  { id: 'glass', label: 'Glass' },
  { id: 'mica', label: 'Mica' },
  { id: 'acrylic', label: 'Acrylic' },
])

/**
 * Resolve the active player bar surface from either a settings object or a
 * (surface, glassEnabled) pair, preserving legacy `glass_player_bar` values.
 */
export function resolvePlayerBarSurface(surfaceOrSettings, glassEnabled = true) {
  if (surfaceOrSettings && typeof surfaceOrSettings === 'object') {
    const surface = surfaceOrSettings.player_bar_surface
    if (PLAYER_BAR_SURFACES.includes(surface)) return surface
    return surfaceOrSettings.glass_player_bar === '0' ? 'off' : 'glass'
  }
  if (PLAYER_BAR_SURFACES.includes(surfaceOrSettings)) return surfaceOrSettings
  return glassEnabled === false || glassEnabled === '0' ? 'off' : 'glass'
}

export function isFloatingPlayerBarSurface(surface) {
  return resolvePlayerBarSurface(surface) !== 'off'
}

const FLOATING_BASE = 'absolute inset-x-3 bottom-3 z-30 h-20 rounded-2xl flex items-center px-4 gap-4'

export function playerBarSurfacePresentation(surface) {
  const mode = resolvePlayerBarSurface(surface)
  if (mode === 'off') {
    return {
      mode,
      floating: false,
      className: 'h-20 border-t border-border flex items-center px-4 gap-4 flex-shrink-0 z-10',
      style: { backgroundColor: 'rgba(var(--surface-rgb), 0.9)', backdropFilter: 'blur(12px)' },
    }
  }
  if (mode === 'mica') {
    return {
      mode,
      floating: true,
      className: `${FLOATING_BASE} player-bar-surface player-bar-mica`,
      style: undefined,
    }
  }
  if (mode === 'acrylic') {
    return {
      mode,
      floating: true,
      className: `${FLOATING_BASE} player-bar-surface player-bar-acrylic`,
      style: undefined,
    }
  }
  return {
    mode: 'glass',
    floating: true,
    className: `${FLOATING_BASE} border border-white/10 shadow-[0_24px_60px_rgba(0,0,0,0.45)] backdrop-blur-lg backdrop-saturate-150`,
    style: { backgroundColor: 'rgba(var(--surface-rgb), 0.55)' },
  }
}
