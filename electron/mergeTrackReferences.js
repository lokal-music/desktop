// Called inside the caller's transaction. Preserve all track references,
// including account/link tables created after the duplicate UI was written.
function mergeTrackReferences(db, keepId, loser) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'tracks'").all()
  for (const { name } of tables) {
    const quoted = '"' + name.replace(/"/g, '""') + '"'
    if (!db.prepare(`PRAGMA table_info(${quoted})`).all().some(column => column.name === 'track_id')) continue
    if (!['artist_track_links', 'artist_link_locks'].includes(name)) {
      db.prepare(`UPDATE OR IGNORE ${quoted} SET track_id=? WHERE track_id=?`).run(keepId, loser.id)
    }
    db.prepare(`DELETE FROM ${quoted} WHERE track_id=?`).run(loser.id)
  }
  db.prepare('UPDATE tracks SET play_count=COALESCE(play_count,0)+?, liked=MAX(COALESCE(liked,0),?), download_source=COALESCE(download_source,?), source_ref=COALESCE(source_ref,?) WHERE id=?')
    .run(loser.play_count || 0, loser.liked || 0, loser.download_source || null, loser.source_ref || null, keepId)
  db.prepare('INSERT OR REPLACE INTO track_aliases (old_id,track_id) VALUES (?,?)').run(loser.id, keepId)
  db.prepare('DELETE FROM tracks WHERE id=?').run(loser.id)
}
module.exports = { mergeTrackReferences }
