// Removes machine-generated transfer suffixes (staging UUIDs, short hashes,
// collision counters) and placeholder artists from names. The identical
// contract is implemented in Dart on mobile.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_SUFFIX = new RegExp(`\\s+-\\s+${UUID}(?:-r[1-9][0-9]*)?$`, 'i')
const HASH_SUFFIX = /\s+\[[0-9a-f]{16}\]$/i
const COUNTER_SUFFIX = /\s+\((\d{1,4})\)$/
const PLACEHOLDER_ARTISTS = new Set(['', '<unknown>', 'unknown artist', 'unknown', 'lokal phone', 'lokal mobile', 'phone-downloads'])

function cleanTransferStem(stem) {
  let value = String(stem ?? '')
  let stripped = false
  for (;;) {
    const next = value.replace(UUID_SUFFIX, '').replace(HASH_SUFFIX, '')
    if (next === value) break
    value = next
    stripped = true
  }
  if (stripped) {
    const m = COUNTER_SUFFIX.exec(value)
    if (m && Number(m[1]) >= 2 && Number(m[1]) <= 9999) value = value.slice(0, m.index)
  }
  return value
}

function cleanTransferMetadata({ title, artist } = {}) {
  const originalTitle = title == null ? '' : String(title)
  const originalArtist = artist == null ? '' : String(artist)
  let nextTitle = cleanTransferStem(originalTitle)
  let nextArtist = originalArtist
  const placeholder = PLACEHOLDER_ARTISTS.has(originalArtist.trim().toLowerCase())
  const sep = ' - '
  if (placeholder) {
    const i = nextTitle.indexOf(sep)
    if (i > 0 && nextTitle.slice(i + sep.length).trim()) {
      nextArtist = nextTitle.slice(0, i).trim()
      nextTitle = nextTitle.slice(i + sep.length).trim()
    }
  } else {
    const prefix = `${originalArtist} - `
    if (nextTitle.toLowerCase().startsWith(prefix.toLowerCase()) && nextTitle.slice(prefix.length).trim()) {
      nextTitle = nextTitle.slice(prefix.length).trim()
    }
  }
  return { title: nextTitle, artist: nextArtist, cleaned: nextTitle !== originalTitle || nextArtist !== originalArtist }
}

module.exports = { cleanTransferMetadata, cleanTransferStem, PLACEHOLDER_ARTISTS }
