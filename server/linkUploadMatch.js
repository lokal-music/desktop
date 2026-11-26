// Uploads can run on a different SQLite connection from LinkStore. Keep this
// lookup independent of connection-local SQL functions such as link_normalize.
const normalize = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()

function findPhonePlaceholder(db, title, artist, duration) {
  const wantedTitle = normalize(title), wantedArtist = normalize(artist)
  if (!wantedTitle || !wantedArtist || !Number.isFinite(duration)) return null
  for (const row of db.prepare("SELECT id,title,artist FROM tracks WHERE (file_path LIKE 'ghost://link/%' OR file_path LIKE 'ghost://mobile/%') AND abs(COALESCE(duration,0)-?)<=2 ORDER BY id").iterate(duration)) {
    if (normalize(row.title) === wantedTitle && normalize(row.artist) === wantedArtist) return row
  }
  return null
}
module.exports = { findPhonePlaceholder }
