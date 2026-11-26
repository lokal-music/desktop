// Content identity: lets a byte-identical file be recognised even after a tag
// write (added-date stamp) changes its hash. Safe on minimal test databases.
function ensureTrackContentHashes(db) {
  if (!db) return false
  try {
    const columns = db.prepare('PRAGMA table_info(tracks)').all()
    if (columns.length && !columns.some(c => c.name === 'audio_sha256')) {
      db.exec('ALTER TABLE tracks ADD COLUMN audio_sha256 TEXT')
    }
    db.exec(`CREATE TABLE IF NOT EXISTS track_content_hashes (
      sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, track_id TEXT NOT NULL,
      PRIMARY KEY (sha256, bytes))`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_track_content_hashes_track ON track_content_hashes(track_id)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_track_content_hashes_bytes ON track_content_hashes(bytes)')
    if (columns.length) db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_audio_sha256 ON tracks(audio_sha256)')
    return true
  } catch { return false }
}

function recordTrackContentHash(db, trackId, sha256, bytes) {
  if (!db || trackId == null || !/^[0-9a-f]{64}$/i.test(String(sha256 || '')) || !Number.isFinite(Number(bytes))) return false
  try {
    db.prepare('INSERT OR REPLACE INTO track_content_hashes(sha256,bytes,track_id) VALUES (?,?,?)')
      .run(String(sha256).toLowerCase(), Number(bytes), String(trackId))
    return true
  } catch { return false }
}

module.exports = { ensureTrackContentHashes, recordTrackContentHash }
