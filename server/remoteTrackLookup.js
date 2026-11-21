function validateTrackLookupIds(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 ||
      ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 512) ||
      new Set(ids).size !== ids.length) {
    return 'Expected 1–100 unique non-empty track IDs'
  }
  return null
}

function findTrackRows(db, ids) {
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(`
    SELECT t.* FROM tracks t
    WHERE t.id IN (${placeholders}) AND t.file_path NOT LIKE 'ghost://%'
  `).all(...ids)
}

module.exports = { findTrackRows, validateTrackLookupIds }
