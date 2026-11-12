const { recordingKey, sameRecording, editionKey } = require('./recordingIdentity')
const tierRank = track => {
  const tier = require('./quality').tierOf(track)
  if (tier === 'unknown' && Number(track.bitrate) > 0) return Number(track.bitrate) >= 256 ? 2 : 1
  return ({ low: 1, high: 2, lossless: 3, hires: 4, atmos: 5 })[tier] || 0
}
function exactDuplicateGroups(db) {
  const rows = db.prepare("SELECT t.*, (SELECT COUNT(DISTINCT playlist_id) FROM playlist_tracks p WHERE p.track_id=t.id) AS playlist_count FROM tracks t WHERE file_path NOT LIKE 'ghost://%' AND file_path NOT LIKE 'stream://%'").all()
  const buckets = new Map()
  for (const track of rows) {
    const key = `${editionKey(track)}\0${recordingKey(track)}`
    if (!buckets.has(key)) buckets.set(key, [])
    const groups = buckets.get(key)
    let group = groups.find(group => sameRecording(group[0], track, Infinity))
    if (!group) groups.push(group = [])
    group.push(track)
  }
  return [...buckets.values()].flat().filter(group => group.length > 1).map(tracks => {
    const available = new Set(tracks.filter(track => require('fs').existsSync(track.file_path)).map(track => track.id))
    tracks.sort((a, b) => Number(available.has(b.id)) - Number(available.has(a.id)) || tierRank(b) - tierRank(a) || b.playlist_count - a.playlist_count || Number(!!b.download_source) - Number(!!a.download_source))
    return { title: tracks[0].title, artist: tracks[0].artist, count: tracks.length,
      ids: tracks.map(t => t.id).join(','), paths: tracks.map(t => t.file_path).join(','), tracks }
  })
}
module.exports = { exactDuplicateGroups, tierRank }
