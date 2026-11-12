function trackById(db, id) {
  const seen = new Set()
  while (typeof id === 'string' && !seen.has(id) && seen.size < 32) {
    seen.add(id)
    const track = db.prepare('SELECT * FROM tracks WHERE id=?').get(id)
    if (track) return track
    id = db.prepare('SELECT track_id FROM track_aliases WHERE old_id=?').get(id)?.track_id
  }
  return undefined
}
module.exports = { trackById }
