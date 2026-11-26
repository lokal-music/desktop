/** Remove repeated track memberships from one regular playlist. */
function deduplicatePlaylist(db, playlistId) {
  const playlist = db.prepare('SELECT smart_rules FROM playlists WHERE id = ?').get(playlistId)
  if (!playlist) return { error: 'Playlist not found', removed: 0 }
  if (playlist.smart_rules) return { error: 'Smart playlists cannot be deduplicated.', removed: 0 }

  const rows = db.prepare('SELECT id, track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id').all(playlistId)
  const seen = new Set()
  const duplicateIds = []
  for (const row of rows) {
    if (seen.has(row.track_id)) duplicateIds.push(row.id)
    else seen.add(row.track_id)
  }
  if (duplicateIds.length) {
    const remove = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND id = ?')
    const run = () => db.transaction(() => { for (const rowId of duplicateIds) remove.run(playlistId, rowId) })()
    // Removing repeats is tidying, not a user's remove: never journal it to Link.
    if (typeof db._withLinkSuppressed === 'function') db._withLinkSuppressed(run)
    else run()
  }
  return { ok: true, removed: duplicateIds.length, remaining: rows.length - duplicateIds.length }
}

module.exports = { deduplicatePlaylist }
