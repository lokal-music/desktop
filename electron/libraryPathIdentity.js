const path = require('path')
const fs = require('fs')
const expression = process.platform === 'win32' ? "LOWER(REPLACE(file_path, char(92), '/'))" : 'file_path'
function pathKey(file) {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved
}
function findByPath(db, file) {
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
  let repaired = 0
  db.transaction(() => {
    const groups = db.prepare(`SELECT ${expression} AS identity FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND file_path NOT LIKE 'stream://%' GROUP BY ${expression} HAVING COUNT(*)>1`).all()
    for (const group of groups) {
      const rows = db.prepare(`SELECT * FROM tracks WHERE ${expression}=? ORDER BY (download_source IS NOT NULL) DESC, COALESCE(play_count,0) DESC`).all(group.identity)
      for (const loser of rows.slice(1)) {
        if (!sameFile(rows[0].file_path, loser.file_path)) continue
        require('./mergeTrackReferences').mergeTrackReferences(db, rows[0].id, loser)
        repaired++
      }
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
