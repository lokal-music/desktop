const path = require('path')
const fs = require('fs')
const expression = process.platform === 'win32' ? "LOWER(REPLACE(file_path, char(92), '/'))" : 'file_path'
function pathKey(file) {
  const resolved = path.resolve(file)
  // SQLite's built-in LOWER() only folds ASCII, so keep the lookup key in
  // sync instead of lowercasing non-ASCII path characters in JavaScript.
  return process.platform === 'win32'
    ? resolved.replace(/\\/g, '/').replace(/[A-Z]/g, character => character.toLowerCase())
    : resolved
}
function findByPath(db, file) {
  // The overwhelmingly common case is an exact stored path. SQLite's unique
  // index handles it without probing the filesystem (which can hang when a
  // previously indexed NAS path is offline). It also prevents an unnecessary
  // INSERT that would violate tracks.file_path if the stat-based alias check
  // cannot access the file.
  const exact = db.prepare('SELECT * FROM tracks WHERE file_path = ?').get(file)
  if (exact) return exact
  return db.prepare(`SELECT * FROM tracks WHERE ${expression} = ? ORDER BY (download_source IS NOT NULL) DESC`).all(pathKey(file))
    .find(row => sameFile(row.file_path, file))
}
function sameFile(left, right) {
  if (path.resolve(left) === path.resolve(right)) return true
  // Windows directories can explicitly enable case sensitivity. Case-folded
  // spelling alone must never merge two distinct files in those directories.
  try {
    const a = fs.statSync(left, { bigint: true }), b = fs.statSync(right, { bigint: true })
    return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev
  } catch { return false }
}
function ensureIndex(db) { db.exec(`CREATE INDEX IF NOT EXISTS idx_tracks_physical_path ON tracks (${expression})`) }
function repairSameFileRows(db) {
  // Resolve physical aliases before opening the write transaction. A slow or
  // disconnected NAS can make fs.statSync take seconds; holding a SQLite write
  // transaction across those probes would stall ordinary playback/library IPC.
  const merges = []
  const groups = db.prepare(`SELECT ${expression} AS identity FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND file_path NOT LIKE 'stream://%' GROUP BY ${expression} HAVING COUNT(*)>1`).all()
  for (const group of groups) {
    const rows = db.prepare(`SELECT * FROM tracks WHERE ${expression}=? ORDER BY (download_source IS NOT NULL) DESC, COALESCE(play_count,0) DESC`).all(group.identity)
    const keeper = rows[0]
    for (const loser of rows.slice(1)) {
      if (sameFile(keeper.file_path, loser.file_path)) {
        merges.push({ keeperId: keeper.id, keeperPath: keeper.file_path, loserId: loser.id, loserPath: loser.file_path })
      }
    }
  }

  let repaired = 0
  db.transaction(() => {
    const currentKeeper = db.prepare('SELECT file_path FROM tracks WHERE id=?')
    const currentLoser = db.prepare('SELECT * FROM tracks WHERE id=?')
    for (const item of merges) {
      // Another scanner may have replaced a row while the slow filesystem
      // probe was running. Only merge the exact rows we actually verified.
      if (currentKeeper.get(item.keeperId)?.file_path !== item.keeperPath) continue
      const loser = currentLoser.get(item.loserId)
      if (!loser || loser.file_path !== item.loserPath) continue
      require('./mergeTrackReferences').mergeTrackReferences(db, item.keeperId, loser)
      repaired++
    }
    // Older merges recorded aliases but could leave references in newer
    // account/extension tables. Relink only IDs whose row is already gone.
    const aliases = db.prepare('SELECT a.old_id FROM track_aliases a WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.id=a.old_id)').all()
    for (const { old_id } of aliases) {
      const keeper = require('./trackAlias').trackById(db, old_id)
      if (keeper) require('./mergeTrackReferences').mergeTrackReferences(db, keeper.id, { id: old_id })
    }
    ensureIndex(db)
  })()
  return repaired
}
module.exports = { pathKey, expression, findByPath, ensureIndex, repairSameFileRows, sameFile }
