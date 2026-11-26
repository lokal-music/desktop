function trackFileFilter(includeGhosts, db = null) {
  if (includeGhosts === true || includeGhosts === 'true' || includeGhosts === '1') return null
  let hasCatalog = false
  try {
    hasCatalog = !!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='link_mobile_catalog'").get()
  } catch {}
  return hasCatalog
    ? "(file_path NOT LIKE 'ghost://%' OR file_path LIKE 'ghost://mobile/%' OR id IN (SELECT track_id FROM link_mobile_catalog))"
    : "(file_path NOT LIKE 'ghost://%' OR file_path LIKE 'ghost://mobile/%')"
}

function isLibraryVisibleTrack(track) {
  const path = String(track?.file_path || '')
  return Boolean(path) && (
    !path.startsWith('ghost://') ||
    path.startsWith('ghost://mobile/') ||
    Boolean(track?.mobile_catalog)
  )
}

function missingTrackFile(track, exists) {
  return !!track.file_path && !track.file_path.startsWith('ghost://') && !exists(track.file_path)
}

module.exports = { trackFileFilter, isLibraryVisibleTrack, missingTrackFile }
