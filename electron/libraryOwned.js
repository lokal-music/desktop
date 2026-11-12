const fs = require('fs')
const { recordingKey, sameRecording, editionKey } = require('./recordingIdentity')

// One complete snapshot per batch, not a capped search result per song.
async function findOwnedTracks(db, candidates) {
  if (!Array.isArray(candidates) || candidates.length > 5000) throw new Error('Choose at most 5,000 songs per batch')
  const rows = db.prepare("SELECT id,file_path,title,artist,album,duration,source_ref,download_source,codec,atmos_verified FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND file_path NOT LIKE 'stream://%'").all()
  const buckets = new Map()
  for (const row of rows) {
    if (editionKey(row) !== 'ordinary') continue
    const key = recordingKey(row)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(row)
  }
  const usable = new Map()
  const exists = file => {
    if (!usable.has(file)) usable.set(file, require('./ipc/networkLibrary').withTimeout(fs.promises.stat)(file)
      .then(stat => stat.isFile() && stat.size > 0).catch(() => false))
    return usable.get(file)
  }
  const out = []
  for (const candidate of candidates) {
    let owned = null
    for (const row of buckets.get(recordingKey(candidate)) || []) {
      if (sameRecording(candidate, row, Infinity) && await exists(row.file_path)) { owned = row; break }
    }
    out.push(owned)
  }
  return out
}
module.exports = { findOwnedTracks }
