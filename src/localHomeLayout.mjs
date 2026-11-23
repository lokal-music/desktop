// Local Home section customization (stable IDs, defaults, restore unknown/new
// sections, hidden visibility and reorder semantics), matching discoveryShelfLayout.mjs.
export const LOCAL_HOME_SECTION_TITLES = Object.freeze({
  madeForYou: 'Made for you',
  mixes: 'Your Mixes',
  suggestions: 'Suggested for You',
  recent: 'Recently Added',
})

export const LOCAL_HOME_SECTION_DEFAULTS = Object.freeze([
  'madeForYou',
  'mixes',
  'suggestions',
  'recent',
])

export function restoreLocalHomeLayout(saved = {}) {
  const defaults = LOCAL_HOME_SECTION_DEFAULTS
  const order = [
    ...new Set([
      ...(Array.isArray(saved?.order) ? saved.order.filter(id => defaults.includes(id)) : []),
      ...defaults,
    ]),
  ]
  const hidden = (Array.isArray(saved?.hidden) ? saved.hidden : []).filter(id => defaults.includes(id))
  return { order, hidden: [...new Set(hidden)] }
}

export function visibleLocalHomeSectionIds(layout) {
  return layout.order.filter(id => !layout.hidden.includes(id))
}

export function moveLocalHomeSection(layout, from, to) {
  const order = [...layout.order]
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= order.length || to < 0 || to >= order.length) return layout
  const [id] = order.splice(from, 1)
  order.splice(to, 0, id)
  return { ...layout, order }
}

export function showLocalHomeSection(layout, id, show) {
  if (!layout.order.includes(id)) return layout
  const hidden = new Set(layout.hidden)
  if (show) hidden.delete(id)
  else hidden.add(id)
  return { ...layout, hidden: [...hidden] }
}

export function localHomeStorageKey(user) {
  return `lokal.home.localSections.v1.${encodeURIComponent(user || 'guest')}`
}

export function readLocalHomeLayout(storage, user) {
  let value = {}
  try { value = JSON.parse(storage?.getItem(localHomeStorageKey(user)) || '{}') || {} } catch {}
  return restoreLocalHomeLayout(value)
}

export function writeLocalHomeLayout(storage, user, layout) {
  storage?.setItem(localHomeStorageKey(user), JSON.stringify(restoreLocalHomeLayout(layout)))
}
