// Match the mobile playlist tile: use four distinct covers from at most the
// first 64 songs; fewer than four covers render as a single image.
export function playlistArtworkCandidates(tracks, limit = 4) {
  const covers = []
  const seen = new Set()
  for (const track of (tracks || []).slice(0, 64)) {
    const local = typeof track.artwork_path === 'string' && track.artwork_path
      ? track.artwork_path : null
    const remote = typeof track.artwork_url === 'string' &&
      /^https:\/\//i.test(track.artwork_url) ? track.artwork_url : null
    const source = local || remote
    if (!source || seen.has(source)) continue
    seen.add(source)
    covers.push({ source, isLocal: !!local })
    if (covers.length === limit) break
  }
  return covers
}
