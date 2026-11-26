// What a smart playlist's rules can say, for the editor and the one-line
// summary on its page (the rules themselves are applied by
// electron/playlists/smart.js).

const TEXT_OPS = [['contains', 'contains'], ['is', 'is'], ['not', 'is not'], ['excludes', "doesn't contain"]]
const NUMBER_OPS = [['gte', 'at least'], ['lte', 'at most'], ['eq', 'exactly']]

export const SMART_FIELDS = {
  genre: { label: 'Genre', ops: [['contains', 'contains'], ['is', 'is'], ['excludes', "doesn't contain"]], input: 'genre' },
  artist: { label: 'Artist', ops: TEXT_OPS, input: 'text' },
  album: { label: 'Album', ops: TEXT_OPS, input: 'text' },
  title: { label: 'Title', ops: TEXT_OPS, input: 'text' },
  folder: { label: 'Folder', ops: [['in', 'is in'], ['not', 'is not in']], input: 'folder' },
  year: { label: 'Year', ops: NUMBER_OPS, input: 'number', placeholder: '1999' },
  added: { label: 'Added', ops: [['within', 'in the last'], ['before', 'more than']], input: 'days', suffix: { within: 'days', before: 'days ago' } },
  played: { label: 'Last played', ops: [['within', 'in the last'], ['before', 'not in the last'], ['never', 'never']], input: 'days', suffix: { within: 'days', before: 'days' } },
  plays: { label: 'Plays', ops: NUMBER_OPS, input: 'number', placeholder: '10' },
  liked: { label: 'Liked', ops: [['is', 'yes'], ['not', 'no']], input: 'none' },
  duration: { label: 'Length', ops: [['gte', 'at least'], ['lte', 'at most']], input: 'number', placeholder: '5', unit: 'min' },
  quality: {
    label: 'Quality',
    ops: [['is', 'is'], ['not', 'is not']],
    input: 'select',
    options: [['hires', 'Hi-res'], ['lossless', 'Lossless'], ['high', 'High (lossy)'], ['low', 'Low (lossy)'], ['suspect', 'Suspect lossless']],
  },
  source: {
    label: 'Source',
    ops: [['is', 'is'], ['not', 'is not']],
    input: 'select',
    options: [['local', 'Your files'], ['yt', 'YouTube downloads'], ['sc', 'SoundCloud downloads'], ['mono', 'Monochrome downloads'], ['soulseek', 'Soulseek downloads'], ['addon', 'Addon downloads'], ['web', 'Other downloads'], ['mobile', 'Mobile'], ['mobile-downloads', 'Mobile downloads']],
  },
}

export const SMART_SORTS = [
  ['artist', 'Artist'],
  ['album', 'Album'],
  ['title', 'Title'],
  ['year', 'Newest year first'],
  ['added', 'Recently added'],
  ['plays', 'Most played'],
  ['played', 'Recently played'],
  ['random', 'Random (new order each time)'],
]

/** A new rule for a field, with its first operator and an empty value. */
export function newRule(field = 'genre') {
  const spec = SMART_FIELDS[field]
  return { field, op: spec.ops[0][0], value: spec.input === 'select' ? spec.options[0][0] : '' }
}

/** Rules as stored (JSON) or as an object, read back for the editor. */
export function readRules(value) {
  let rules = value
  if (typeof rules === 'string') { try { rules = JSON.parse(rules) } catch { rules = null } }
  if (!rules || typeof rules !== 'object') return null
  return {
    match: rules.match === 'any' ? 'any' : 'all',
    rules: (Array.isArray(rules.rules) ? rules.rules : []).filter(rule => SMART_FIELDS[rule?.field]),
    sort: SMART_SORTS.some(([id]) => id === rules.sort) ? rules.sort : 'artist',
    limit: Math.max(0, Math.floor(Number(rules.limit) || 0)),
  }
}

/** Is a rule filled in enough to count? */
export function ruleComplete(rule) {
  const spec = SMART_FIELDS[rule?.field]
  if (!spec) return false
  if (spec.input === 'none' || rule.op === 'never') return true
  return String(rule.value ?? '').trim() !== ''
}

const folderName = (path) => String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

/** "Genre is Jazz", "Last played not in the last 90 days". */
export function describeRule(rule) {
  const spec = SMART_FIELDS[rule?.field]
  if (!spec) return ''
  const op = spec.ops.find(([id]) => id === rule.op)?.[1] || ''
  if (spec.input === 'none') return `${spec.label}: ${op}`
  if (rule.op === 'never') return `${spec.label}: never`
  let value = rule.value
  if (spec.input === 'select') value = spec.options.find(([id]) => id === rule.value)?.[1] || rule.value
  if (spec.input === 'folder') value = folderName(rule.value)
  if (spec.input === 'days') value = `${rule.value} ${spec.suffix?.[rule.op] || 'days'}`
  if (spec.unit) value = `${rule.value} ${spec.unit}`
  return `${spec.label} ${op} ${value}`
}

/** One line for the playlist's page: "Genre is Jazz · Added in the last 30 days · 50 songs, random". */
export function describeRules(rules) {
  const read = readRules(rules)
  if (!read) return ''
  const parts = read.rules.filter(ruleComplete).map(describeRule)
  const joined = parts.length ? parts.join(read.match === 'any' ? ' or ' : ' · ') : 'Your whole library'
  const sort = SMART_SORTS.find(([id]) => id === read.sort)?.[1]
  const limit = read.limit ? `${read.limit} songs` : ''
  return [joined, [limit, read.sort === 'random' ? 'random' : sort && `by ${sort.toLowerCase()}`].filter(Boolean).join(', ')].filter(Boolean).join(' — ')
}

/** Open the smart playlist editor: a new one, or `playlist`'s rules. */
export function openSmartPlaylistEditor(playlist = null) {
  window.dispatchEvent(new CustomEvent('lokal:smart-playlist', { detail: { playlist } }))
}
