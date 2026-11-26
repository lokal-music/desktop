const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

function pathApi(value) {
  if (typeof value !== 'string') return null
  // path.win32 also treats a POSIX root such as /mnt as rooted; only choose
  // Windows semantics for drive-letter or UNC paths.
  if (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) return path.win32
  if (path.posix.isAbsolute(value)) return path.posix
  return null
}

function relativeInside(filePath, root) {
  const fileApi = pathApi(filePath)
  const rootApi = pathApi(root)
  if (!fileApi || !rootApi || fileApi !== rootApi) return null
  const relative = fileApi.relative(fileApi.resolve(root), fileApi.resolve(filePath))
  if (!relative || relative === '..' || relative.startsWith('..' + fileApi.sep) || fileApi.isAbsolute(relative)) return null
  return relative.split(/[\\/]+/).join('/')
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
  return parts.slice(index + 1).join('/')
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


 
// Older desktop builds stored phone uploads in the private roaming data
// directory. Copy those files into the user-selected portable folder before
// changing their database paths. Keep the originals as a recoverable backup.
function migrateLegacyRoamingMobileFiles(database, legacyRoot, destinationRoot) {
  if (!database || !legacyRoot || !destinationRoot) return { copied: 0, skipped: 0 }
  const rows = database.prepare(`
    SELECT id, file_path
    FROM tracks
    WHERE download_source = 'mobile'
  `).all()
  const update = database.prepare('UPDATE tracks SET file_path = ? WHERE id = ? AND file_path = ?')
  let copied = 0
  let skipped = 0
  for (const row of rows) {
    const relative = relativeInside(row.file_path, legacyRoot)
    if (!relative) continue
    try {
      if (!fs.statSync(row.file_path).isFile()) { skipped++; continue }
    } catch { skipped++; continue }

    const target = destinationPath(destinationRoot, relative)
    if (!target) { skipped++; continue }
    const occupied = database.prepare('SELECT id FROM tracks WHERE file_path = ? AND id <> ?').get(target, row.id)
    if (occupied) { skipped++; continue }

    let created = false
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      try {
        fs.copyFileSync(row.file_path, target, fs.constants.COPYFILE_EXCL)
        created = true
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        // An interrupted migration may have copied the file already. Reuse it
        // only when its bytes match; never overwrite an existing destination.
        const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(row.file_path)).digest('hex')
        const targetHash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
        if (sourceHash !== targetHash) { skipped++; continue }
      }
      const changed = update.run(target, row.id, row.file_path).changes === 1
      if (!changed) {
        if (created) { try { fs.unlinkSync(target) } catch {} }
        skipped++
        continue
      }
      copied++
    } catch (error) {
      if (created) { try { fs.unlinkSync(target) } catch {} }
      console.warn('[phone-copy] Legacy roaming migration skipped:', error.message)
      skipped++
    }
  }
  return { copied, skipped }
}

module.exports = { relativeInside, relativeFromFolderMarker, destinationPath, rebaseMobileTrackPaths, migrateLegacyRoamingMobileFiles }
