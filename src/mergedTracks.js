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

export function mergedPlaybackContinuation(state, replacements, position = state.progress) {
  const replacement = replacements?.find(item => item.removedIds?.includes(state.currentTrack?.id))
  if (!replacement?.track) return null
  return { trackId: replacement.track.id,
    sameSource: replacement.unchangedFileIds?.includes(state.currentTrack.id) === true,
    position: Math.max(0, Number(position) || 0) }
}

export function reuseMergedAudio(element, continuation) {
  if (!continuation?.sameSource || !element?.currentSrc || element.readyState < 2) return false
  element.dataset.lokalTrackId = String(continuation.trackId)
  element.dataset.lokalTrackPending = ''
  element.dataset.fallbackPending = ''
  return true
}
