// Called inside the caller's transaction. Preserve all track references,
// including account/link tables created after the duplicate UI was written.
// A merge is housekeeping, not the user unliking or removing anything: Link
// capture is suppressed so no false unlike/playlist.remove is journaled.
function mergeTrackReferences(db, keepId, loser) {
  if (typeof db._withLinkSuppressed === 'function') return db._withLinkSuppressed(() => mergeNow(db, keepId, loser))
  return mergeNow(db, keepId, loser)
}

function mergeNow(db, keepId, loser) {
  // Remember the loser's identity (Link key + content hash) before it vanishes.
  try { require('./link/trackLifecycle').recordLoser(db, keepId, loser) } catch {}
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'tracks'").all()
  for (const { name } of tables) {
    const quoted = '"' + name.replace(/"/g, '""') + '"'
    if (!db.prepare(`PRAGMA table_info(${quoted})`).all().some(column => column.name === 'track_id')) continue
    if (name === 'playlist_tracks') {
      // The keeper may already be in the same playlist: keep one row at the
      // earliest position instead of leaving a visible repeat.
      for (const row of db.prepare('SELECT id, playlist_id, position FROM playlist_tracks WHERE track_id=?').all(loser.id)) {
        const existing = db.prepare('SELECT id, position FROM playlist_tracks WHERE playlist_id=? AND track_id=? ORDER BY position, id').get(row.playlist_id, keepId)
        if (!existing) continue
        if (row.position !== null && (existing.position === null || row.position < existing.position)) {
          db.prepare('UPDATE playlist_tracks SET position=? WHERE id=?').run(row.position, existing.id)
        }
        db.prepare('DELETE FROM playlist_tracks WHERE id=?').run(row.id)
      }
    }
    if (name === 'link_mobile_catalog') {
      // The table's (user, device, track_key) primary key can already point
      // at the keeper. Move non-conflicting phone associations before the
      // generic cleanup below; otherwise UPDATE OR IGNORE would silently
      // skip them and DELETE would erase the loser's Mobile membership.
      db.prepare(`
        UPDATE link_mobile_catalog AS mobile
        SET track_id=?
        WHERE track_id=?
          AND NOT EXISTS (
            SELECT 1 FROM link_mobile_catalog AS current
            WHERE current.user_id=mobile.user_id
              AND current.device_id=mobile.device_id
              AND current.track_key=mobile.track_key
              AND current.track_id=?
          )
      `).run(keepId, loser.id, keepId)
    }
    if (!['artist_track_links', 'artist_link_locks'].includes(name)) {
      db.prepare(`UPDATE OR IGNORE ${quoted} SET track_id=? WHERE track_id=?`).run(keepId, loser.id)
    }
    db.prepare(`DELETE FROM ${quoted} WHERE track_id=?`).run(loser.id)
  }
  // A phone copy must not stamp a desktop-owned winner as a mobile download.
  const inheritedSource = loser.download_source === 'mobile' ? null : (loser.download_source || null)
  db.prepare('UPDATE tracks SET play_count=COALESCE(play_count,0)+?, liked=MAX(COALESCE(liked,0),?), download_source=COALESCE(download_source,?), source_ref=COALESCE(source_ref,?) WHERE id=?')
    .run(loser.play_count || 0, loser.liked || 0, inheritedSource, loser.source_ref || null, keepId)
  db.prepare('INSERT OR REPLACE INTO track_aliases (old_id,track_id) VALUES (?,?)').run(loser.id, keepId)
  db.prepare('DELETE FROM tracks WHERE id=?').run(loser.id)
}
module.exports = { mergeTrackReferences }
