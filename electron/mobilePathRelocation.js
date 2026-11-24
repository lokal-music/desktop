const path = require('path')

function pathApi(value) {
  if (typeof value !== 'string') return null
  if (path.win32.isAbsolute(value)) return path.win32
  if (path.posix.isAbsolute(value)) return path.posix
  return null
}

function relativeInside(filePath, root) {
  const fileApi = pathApi(filePath)
  const rootApi = pathApi(root)
  if (!fileApi || !rootApi || fileApi !== rootApi) return null
  const relative = fileApi.relative(fileApi.resolve(root), fileApi.resolve(filePath))
  if (!relative || relative === '..' || relative.startsWith('..' + fileApi.sep) || fileApi.isAbsolute(relative)) return null
  return relative
}

// A restored backup may already have replaced phone_download_root with the
// destination selected on this PC. In that case the old root is no longer
// available, so use the dedicated folder's basename as a conservative marker.
function relativeFromFolderMarker(filePath, destinationRoot) {
  const fileApi = pathApi(filePath)
  const destinationApi = pathApi(destinationRoot)
  if (!fileApi || !destinationApi) return null
  const marker = destinationApi.basename(destinationApi.resolve(destinationRoot)).toLocaleLowerCase()
  if (!marker) return null
  const parts = filePath.split(/[\\/]+/)
  const index = parts.findIndex(part => part.toLocaleLowerCase() === marker)
  if (index < 0 || index === parts.length - 1) return null
  return parts.slice(index + 1).join(fileApi.sep)
}

function destinationPath(root, relative) {
  const api = pathApi(root)
  if (!api || !relative) return null
  return api.join(root, ...relative.split(/[\\/]+/))
}

function rebaseMobileTrackPaths(database, previousRoot, destinationRoot) {
  if (!database || !destinationRoot) return { tracks: 0, artwork: 0 }
  const rows = database.prepare(`
    SELECT id, file_path, artwork_path
    FROM tracks
    WHERE download_source = 'mobile'
  `).all()
  const update = database.prepare('UPDATE tracks SET file_path = ?, artwork_path = ? WHERE id = ?')
  let tracks = 0
  let artwork = 0

  for (const row of rows) {
    const trackRelative = relativeInside(row.file_path, previousRoot)
      || relativeFromFolderMarker(row.file_path, destinationRoot)
    const artworkRelative = relativeInside(row.artwork_path, previousRoot)
      || relativeFromFolderMarker(row.artwork_path, destinationRoot)
    const nextTrack = trackRelative ? destinationPath(destinationRoot, trackRelative) : row.file_path
    const nextArtwork = artworkRelative ? destinationPath(destinationRoot, artworkRelative) : row.artwork_path
    if (nextTrack === row.file_path && nextArtwork === row.artwork_path) continue
    update.run(nextTrack, nextArtwork, row.id)
    if (nextTrack !== row.file_path) tracks += 1
    if (nextArtwork !== row.artwork_path) artwork += 1
  }
  return { tracks, artwork }
}

module.exports = { relativeInside, relativeFromFolderMarker, destinationPath, rebaseMobileTrackPaths }
