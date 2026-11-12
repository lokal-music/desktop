/** Retarget already-loaded queues when duplicate records are merged. */
export function relinkMergedPlayerState(state, replacements = []) {
  const byId = new Map(replacements.flatMap(({ removedIds = [], track }) => track ? removedIds.map(id => [id, track]) : []))
  const relink = value => typeof value === 'string' ? byId.get(value)?.id || value
    : value?.id && byId.has(value.id) ? { ...value, ...byId.get(value.id) } : value
  const patch = {}
  for (const key of ['queue', 'originalQueue', 'shuffleQueue', 'playHistory', 'futureHistory', 'playNextIds']) {
    if (Array.isArray(state[key])) patch[key] = state[key].map(relink)
  }
  if (state.currentTrack) patch.currentTrack = relink(state.currentTrack)
  return patch
}

export function announceTrackMerges(result) {
  if (typeof window === 'undefined' || !result?.replacements?.length) return result
  window.dispatchEvent(new CustomEvent('lokal:tracks-merged', { detail: result.replacements }))
  window.dispatchEvent(new Event('lokal:refresh'))
  return result
}
