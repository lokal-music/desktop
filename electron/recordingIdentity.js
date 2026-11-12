// Recording identity for library ownership and duplicate groups. Guest credits
// and album packaging differ between catalogues; mix/live/edit labels do not.
const { splitArtists, keepCommaSet } = require('./artistSplit')
const { isAc4Codec } = require('./quality/editionDuplicates')
const text = value => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
const version = /\b(remix|live|cover|instrumental|acoustic|edit|dub|sped up|slowed|nightcore)\b/i
const sameLabel = '(?:(?:\\d{4}\\s+)?(?:digital(?:ly)?\\s+)?remaster(?:ed)?(?:\\s+\\d{4})?(?:\\s+version)?|(?:album|single|mono|stereo|lp)\\s+version|original\\s+mix|mono|stereo)'
const labelBracket = new RegExp(`\\s*[([]${sameLabel}[)\\]]`, 'gi')
const labelSuffix = new RegExp(`\\s+[-–—]\\s+${sameLabel}\\s*$`, 'i')
function titleKey(value) {
  return text(String(value || '')
    .replace(labelBracket, '').replace(labelSuffix, '')
    .replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s+([^)[\]]+)[)\]]/gi, (all, credit) => version.test(credit) ? all : '')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$/i, (all, credit) => version.test(credit) ? all : '')
    .replace(/\s*[([](?:original mix|explicit|clean(?: version)?)[)\]]/gi, '')
    .replace(/\s+[-–—]\s+original mix\s*$/i, ''))
}
function artistKey(track) {
  const structured = track?.artists?.[0]
  const artist = typeof structured === 'object' ? structured?.name : structured
  return text(artist || splitArtists(String(track?.artist || '').replace(/;|\s\/\s/g, ', '), keepCommaSet())[0])
}
function recordingKey(track) { return `${artistKey(track)}\0${titleKey(track?.title)}` }
function editionKey(track) { return Number(track?.atmos_verified) === 1 ? 'atmos' : isAc4Codec(track?.codec) ? 'ac4' : 'ordinary' }
function sameRecording(left, right, tolerance = 2) {
  if (!titleKey(left?.title) || !artistKey(left) || recordingKey(left) !== recordingKey(right)) return false
  const a = Number(left?.duration), b = Number(right?.duration)
  return !(a > 0 && b > 0) || Math.abs(a - b) <= tolerance
}
module.exports = { titleKey, artistKey, recordingKey, editionKey, sameRecording }
