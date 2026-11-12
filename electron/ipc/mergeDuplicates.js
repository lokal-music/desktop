const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { isInside, moveToTrash, forgetDownloads } = require('./trackFiles')
const { configuredMusicRoots } = require('../libraryFolder')

const isVirtual = file => !file || /^(ghost|stream):\/\//.test(file)
const realPath = file => {
  if (isVirtual(file)) return null
  try { return fs.realpathSync(file) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
const pathKey = file => file && (process.platform === 'win32' ? file.toLowerCase() : file)
const availableFile = track => {
  try { const file = realPath(track.file_path); return !!file && fs.statSync(file).isFile() }
  catch { return false }
}

// File moves and the database transaction are synchronous so another merge cannot
// interleave with them. A failed transaction restores every staged audio file.
async function mergeDuplicates(db, keepId, removeIds) {
  const staged = []
  let losers
  try {
    if (!Array.isArray(removeIds) || removeIds.includes(keepId)) throw new Error('Choose a different copy to remove.')
    const winner = db.prepare('SELECT * FROM tracks WHERE id = ?').get(keepId)
    if (!winner) throw new Error('The copy to keep no longer exists. Refresh the duplicate list.')
    losers = [...new Set(removeIds)].map(id => db.prepare('SELECT * FROM tracks WHERE id = ?').get(id))
    if (losers.some(track => !track)) throw new Error('A copy no longer exists. Refresh the duplicate list.')
    const winnerFile = realPath(winner.file_path)
    const winnerHasFile = winnerFile && fs.statSync(winnerFile).isFile()
    const roots = configuredMusicRoots(db)
    const files = new Map()
    for (const loser of losers) {
      const file = loser.file_path
      const real = realPath(file)
      if (!real) continue // Ghosts and already missing files have nothing to delete.
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('A duplicate is a symbolic link. Remove it manually so its original audio file is not left behind.')
      if (!fs.statSync(file).isFile()) throw new Error('A duplicate path is not an audio file. No files were removed.')
      if (!winnerHasFile) throw new Error('The copy to keep has no local audio file. Choose a downloaded copy first.')
      // Duplicate records of the keeper need only a database merge. Never
      // stage their shared audio, including Windows case/separator aliases.
      if (pathKey(real) === pathKey(winnerFile)) continue
      if (!roots.some(folder => isInside(file, folder) && isInside(real, realPath(folder)))) {
        throw new Error('A duplicate is outside your music folders. Add its folder in Settings → Library before merging.')
      }
      files.set(pathKey(real), real)
    }
    // Do not remove audio used by a surviving entry, including symlink aliases.
    const removedIds = new Set(losers.map(track => track.id))
    const removedFiles = new Set(files.keys())
    for (const track of db.prepare('SELECT id, file_path FROM tracks').all()) {
      if (!removedIds.has(track.id) && removedFiles.has(pathKey(realPath(track.file_path)))) {
        throw new Error('A duplicate shares its audio file with another library entry. No files were removed.')
      }
    }
    db.transaction(() => {
      for (const loser of losers) {
        for (const field of ['artwork_path', 'album', 'year', 'genre']) {
          if (!winner[field] && loser[field]) {
            db.prepare(`UPDATE tracks SET ${field} = ? WHERE id = ?`).run(loser[field], keepId)
            winner[field] = loser[field]
          }
        }
        require('../mergeTrackReferences').mergeTrackReferences(db, keepId, loser)
      }
      for (const file of files.values()) {
        // An unrecognized extension keeps even a failed Trash operation out of scans.
        // Keep the basename short: appending to a long song name can exceed
        // the filesystem's name/path limit, particularly on Windows.
        const temporary = path.join(path.dirname(file), `${randomUUID()}.lokal-duplicate`)
        try { fs.renameSync(file, temporary) }
        catch (error) {
          // Another process may have removed it after validation. There is
          // nothing left to stage; its database references can still merge.
          if (error.code === 'ENOENT' && !realPath(file)) continue
          throw error
        }
        staged.push({ file, temporary })
      }
      if (files.size && !availableFile(winner)) {
        throw new Error('The copy to keep disappeared during the merge. No duplicate audio was discarded. Refresh the duplicate list.')
      }
    })()
  } catch (error) {
    const unrestored = []
    for (const { file, temporary } of staged.reverse()) {
      try {
        // Restore without ever replacing a new file created at the old path.
        // Hard links retain metadata; volumes without them use an exclusive
        // copy and keep the staged original if copying fails.
        try { fs.linkSync(temporary, file) }
        catch (error) {
          if (error.code === 'EEXIST') throw error
          fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL)
        }
        fs.unlinkSync(temporary)
      } catch { unrestored.push(temporary) }
    }
    return { error: unrestored.length
      ? `${error.message} Some files could not be restored: ${unrestored.join(', ')}`
      : error.message }
  }
  forgetDownloads(losers.map(track => track.id))
  const failed = []
  for (const { temporary } of staged) {
    try { await moveToTrash(temporary) } catch { failed.push(temporary) }
  }
  return {
    ok: true, merged: losers.length,
    replacements: [{ removedIds: losers.map(track => track.id), track: db.prepare('SELECT * FROM tracks WHERE id=?').get(keepId) }],
    ...(failed.length ? { warning: `Duplicates were removed from the library, but some files could not be moved to Trash. They will not be rescanned. Remove these files manually: ${failed.join(', ')}` } : {}),
  }
}

async function mergeAllDuplicates(db, scoreTrack) {
  const groups = require('../duplicateGroups').exactDuplicateGroups(db)
  let merged = 0
  const errors = []
  const warnings = []
  const replacements = []
  for (const group of groups) {
    const tracks = group.tracks || group.ids.split(',').map(id => db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)).filter(Boolean)
    const available = new Set(tracks.filter(availableFile).map(track => track.id))
    const { tierRank } = require('../duplicateGroups')
    tracks.sort((a, b) => Number(available.has(b.id)) - Number(available.has(a.id)) || tierRank(b) - tierRank(a) || (b.playlist_count || 0) - (a.playlist_count || 0) || scoreTrack(b) - scoreTrack(a))
    if (tracks.length < 2) continue
    const result = await mergeDuplicates(db, tracks[0].id, tracks.slice(1).map(track => track.id))
    merged += result.merged || 0
    replacements.push(...(result.replacements || []))
    if (result.error) errors.push(result.error)
    if (result.warning) warnings.push(result.warning)
  }
  return { merged, groups: groups.length, replacements,
    ...(errors.length ? { error: `${errors.length} group(s) could not be merged. ${[...new Set(errors)].join(' ')}` } : {}),
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  }
}

module.exports = { mergeDuplicates, mergeAllDuplicates }
