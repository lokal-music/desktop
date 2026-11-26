// What happens to each file once yt-dlp has moved it into place, before it is
// indexed: lyrics looked up and written into it, the cover squared, the title
// tidied. Lyrics come from the user's own lyrics sources, in their order,
// minus "Local file" (that's this file, which has none yet).

const fs = require('fs')
const path = require('path')
const { readInfo, applyTags, stripArtistPrefix, isPlaceholderAlbum } = require('./tagger')
const { toPortableLyrics, toPrivateTag } = require('../lyrics/embedded')
const { isYouTube, isSoundCloud } = require('./args')

const LYRICS_TIMEOUT_MS = 30000

function withTimeout(promise, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(v => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(null) })
  })
}

async function findLyrics(db, info, signal) {
  const service = require('../lyrics/service')
  const { lookup } = require('../lyrics/repository')
  const settings = service.readSettings(db)
  const enabled = settings.enabled.filter(id => id !== 'local')
  if (!enabled.length) return null
  const { result } = await lookup(
    { title: info.title, artist: info.artist, album: info.album, duration: info.duration || 0, filePath: null, keepCommaArtists: settings.keepCommaArtists },
    { order: settings.order, enabled, prioritizeSyllable: settings.prioritizeSyllable, signal },
  )
  return result && !result.instrumental && result.lines?.length ? result : null
}

// ---------------------------------------------------------------- who sang it
// A YouTube video's channel or a SoundCloud uploader is often not the artist:
// labels, VEVO accounts, fan uploads, re-uploaders. The title usually is:
// "Artist - Song (Official Video)". The catalogue itself (YouTube Music,
// "Artist - Topic" channels) is trusted as-is: its titles are just the song,
// and a dash there belongs to the song ("Song - Remastered 2011"). SoundCloud
// always fills `track` with the upload's title, so there only its publisher
// metadata (`artists`, on label releases) counts as a real credit.

const DASH = /^(.{1,80}?)\s+[-–—|]\s+(.+)$/
const NOT_AN_ARTIST = /^(?:official|lyrics?|audio|video|full album|live|remix|remastered|\d{4})$/i

function unquote(s) {
  return String(s || '').trim().replace(/^["'“”‘’«]+|["'“”‘’»]+$/g, '').trim()
}

// "A, B - Song" / "A & B - Song": the whole credit comes off the title, not
// just the first name (stripArtistPrefix only knows "A - Song").
function stripCredit(title, artists) {
  const names = artists.map(a => String(a || '').trim()).filter(Boolean)
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const list = names.map(esc).join('(?:\\s*[,&+]\\s*|\\s+(?:and|x)\\s+)')
  const full = new RegExp(`^${list}\\s+[-–—]\\s+`, 'i')
  const stripped = title.replace(full, '').trim()
  return stripped && stripped !== title ? stripped : stripArtistPrefix(title, names.join(', '))
}

/** { artist, title } from the video, or null to keep what the tags say. */
function artistAndTitle(meta, tags, { soundcloud = false } = {}) {
  if (!meta) return null
  const channel = String(meta.channel || meta.uploader || '')
  const title = String(tags.title || meta.title || '').trim()
  if (soundcloud) {
    const credited = (Array.isArray(meta.artists) ? meta.artists : []).map(a => String(a || '').trim()).filter(Boolean).join(', ')
    if (credited) return { artist: credited, title: stripCredit(title, meta.artists) || title }
  } else if (meta.track || /\s-\sTopic$/i.test(channel)) return null
  const m = title.match(DASH)
  if (!m) return null
  const artist = unquote(m[1])
  const song = unquote(m[2])
  if (!artist || !song || NOT_AN_ARTIST.test(artist)) return null
  return { artist, title: song, fromDash: true }
}

// "Song - Artist (Someone Edit)" uploads exist too: a dash alone can't tell
// which side is the artist. When the right side is an artist already in the
// library and the left side isn't, they're swapped; a trailing "(… Edit)" /
// "[… Remix]" stays with the song.
const TRAILING_TAGS = /((?:\s*[([][^()[\]]*[)\]])+)\s*$/

// First credited artist of "A feat. B", "A & B", "A x B", "A, B". Like the
// scanner, a split on &/x/vs that leaves one-letter pieces is one stylised
// name ("h x m x d"), not a collaboration.
function firstArtistOf(s) {
  const lead = String(s || '').split(/\s+(?:feat\.?|ft\.?|featuring)\s+|,\s*/i)[0].trim()
  const parts = lead.split(/\s+(?:&|x|vs\.?)\s+/i)
  return (parts.some(part => part.trim().length < 2) ? lead : parts[0]).trim()
}

function knownArtist(db, name) {
  const first = firstArtistOf(name)
  if (!db || !first) return false
  try { return !!db.prepare('SELECT 1 FROM artists WHERE name = ? COLLATE NOCASE LIMIT 1').get(first) } catch { return false }
}

const FEATURING = /^[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^()[\]]+?)\s*[)\]]$/i

/**
 * The same parse read the other way round: "Song - Artist (… Edit)". Version
 * tags ("(… Edit)", "[… Remix]") stay with the song; a featured credit
 * ("(feat. Guest)") goes with the artist, written the way the artist splitter
 * reads it: "Artist feat. Guest".
 */
function swapped(parsed) {
  const tags = parsed.title.match(TRAILING_TAGS)
  const other = tags ? parsed.title.slice(0, tags.index).trim() : parsed.title
  if (!other) return null
  const guests = [], versions = []
  const sort = (groups) => {
    for (const group of groups) {
      const feat = group.match(FEATURING)
      if (feat) guests.push(feat[1].trim())
      else versions.push(group)
    }
  }
  // The song side can carry the credit too: "Song (feat. Guest) - Artist".
  const songTags = parsed.artist.match(TRAILING_TAGS)
  const song = songTags ? parsed.artist.slice(0, songTags.index).trim() || parsed.artist : parsed.artist
  const songVersions = []
  if (songTags && song !== parsed.artist) {
    for (const group of songTags[1].match(/[([][^()[\]]*[)\]]/g) || []) {
      const feat = group.match(FEATURING)
      if (feat) guests.push(feat[1].trim())
      else songVersions.push(group)
    }
  }
  sort(tags ? tags[1].match(/[([][^()[\]]*[)\]]/g) || [] : [])
  return {
    artist: guests.length ? `${other} feat. ${guests.join(', ')}` : other,
    title: [songTags && song !== parsed.artist ? song : parsed.artist, ...songVersions, ...versions].join(' '),
    fromDash: true,
  }
}

function preferKnownArtist(parsed, db) {
  if (!parsed?.fromDash || !db) return parsed
  const other = swapped(parsed)
  if (!other || knownArtist(db, parsed.artist) || !knownArtist(db, other.artist)) return parsed
  return other
}

// MusicBrainz settles it when it knows the song: whichever reading it has a
// recording for (that title, by that artist) wins. Shares the app's
// one-request-a-second MusicBrainz queue; unsure or unreachable -> null, and
// the library check above decides.
const ORDER_LOOKUP_MS = 8000
const loose = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const lucene = (s) => String(s || '').replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&')

// Uploaded titles are rarely spelled like the catalogue ("Im Really Really
// Hot" for "I'm Really Hot"): most of the words in common is enough, as long
// as the credited artist matches exactly.
function sameSong(a, b) {
  const x = new Set(loose(a).split(' ').filter(Boolean)), y = new Set(loose(b).split(' ').filter(Boolean))
  if (!x.size || !y.size) return false
  let shared = 0
  for (const word of x) if (y.has(word)) shared++
  return shared / Math.min(x.size, y.size) >= 0.75
}

async function recordingExists(artist, title, get, signal) {
  const who = firstArtistOf(artist)
  const words = loose(title.replace(TRAILING_TAGS, ''))
  if (!who || !words) return false
  const query = `recording:(${lucene(words)}) AND artist:"${lucene(who).replace(/"/g, '')}"`
  if (signal?.aborted) return false
  const found = await get(`/recording?query=${encodeURIComponent(query)}&limit=10`, signal)
  return (found?.recordings || []).some(rec =>
    Number(rec.score) >= 70 && sameSong(rec.title, title) &&
    (rec['artist-credit'] || []).some(credit => loose(credit?.name || credit?.artist?.name) === loose(who)))
}

// `signal`: aborted once the download stops waiting (ORDER_LOOKUP_MS), so
// requests still queued behind other MusicBrainz work are dropped.
async function orderByLookup(parsed, { get, signal } = {}) {
  if (!parsed?.fromDash) return parsed
  const other = swapped(parsed)
  if (!other) return parsed
  const lookup = get || ((q, sig) => require('../quality/stores').mbGet(q, fetch, { signal: sig }))
  if (await recordingExists(parsed.artist, parsed.title, lookup, signal)) return parsed
  if (await recordingExists(other.artist, other.title, lookup, signal)) return other
  return null
}

function safeName(s) {
  return String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120)
}

/** Singles live in Music/Artist/Album; move one whose artist changed. */
function refile(filePath, { artist, title, album, outputDir }) {
  const ext = path.extname(filePath)
  const dir = outputDir && artist ? path.join(outputDir, safeName(artist), safeName(album) || 'Singles') : path.dirname(filePath)
  const bareName = name => require('../transferArtifacts').cleanTransferStem(name)
  let target = path.join(dir, `${bareName(safeName(title) || path.basename(filePath, ext))}${ext}`)
  if (target === filePath) return filePath
  for (let n = 1; fs.existsSync(target) && n < 50; n++) target = path.join(dir, `${safeName(title)} (${n})${ext}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.renameSync(filePath, target)
    // Other download workers may be about to open files in the old folder.
    // Removing an empty directory here races with yt-dlp's mkdir/open sequence.
    return target
  } catch { return filePath }
}

function renameWithoutArtist(filePath, artist) {
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  const next = stripArtistPrefix(base, artist)
  if (!next || next === base) return filePath
  const target = path.join(path.dirname(filePath), next + ext)
  try {
    if (fs.existsSync(target)) return filePath
    fs.renameSync(filePath, target)
    return target
  } catch { return filePath }
}

// ---------------------------------------------------------------- known tags
// A song saved from an addon comes from a bare audio link: no title, artist
// or cover in it, and yt-dlp names it after the link ("7779369"). What the
// addon said about the song (its search result) is passed along instead: its
// title and artist replace yt-dlp's guesses, its album and cover fill in
// whatever the file itself doesn't have.

const { fetchBestCover } = require('./coverQuality')
let downloadArtworkResolver

function resolveDownloadArtwork(title, artist, exclude) {
  downloadArtworkResolver ||= require('../discoveryArtwork').createArtworkResolver({
    fetchImpl: (...args) => globalThis.fetch(...args),
  })
  return downloadArtworkResolver([{ type: 'track', title, artist, remoteOnly: true, exclude }])
}

/** Tags for a download from the client, checked: { title, artist, album, cover, year, track, disc, isrc, genre } or undefined. */
function knownTagsOf(value) {
  if (!value || typeof value !== 'object') return undefined
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, 300) : undefined)
  const number = (v, min, max) => (Number(v) >= min && Number(v) <= max ? Math.floor(Number(v)) : undefined)
  const tags = {
    title: text(value.title),
    artist: text(value.artist),
    album: text(value.album),
    cover: typeof value.cover === 'string' && /^https:\/\/[^\s]{1,1000}$/.test(value.cover) ? value.cover : undefined,
    year: number(value.year, 1000, 2999),
    track: number(value.track, 1, 999),
    disc: number(value.disc, 1, 99),
    isrc: typeof value.isrc === 'string' && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(value.isrc.replace(/-/g, '')) ? value.isrc.replace(/-/g, '').toUpperCase() : undefined,
    genre: text(value.genre)?.slice(0, 100),
  }
  return tags.title || tags.artist ? tags : undefined
}

/**
 * @param known  tags the source gave for the song ({ title, artist, album, cover }),
 *               used where the file has none
 * @returns {{ filePath: string, lyrics: string|null, lyricsSource: string|null, cover: boolean }}
 */
async function finishFile(filePath, { db, settings = {}, url, meta = null, kind = 'single', outputDir = null, known = null, recoverArtwork = false }) {
  const out = { filePath, lyrics: null, lyricsSource: null, cover: false }
  const info = readInfo(filePath)
  if (!info) return out
  if (known) return finishKnownFile(filePath, info, { db, settings, known, outputDir, out, recoverArtwork })
  const clean = settings.clean_download_metadata !== '0'
  // "Artist - Song" videos: the artist is in the title, not the channel.
  // YouTube and SoundCloud: the artist from the title ("Artist - Song"), not
  // the uploader. (Addons bring their own tags; Soulseek files have theirs.)
  const soundcloud = isSoundCloud(url)
  let fromTitle = clean && (isYouTube(url) || soundcloud) ? artistAndTitle(meta, info, { soundcloud }) : null
  // "Artist - Song" or "Song - Artist"? MusicBrainz if it knows, else the library.
  if (fromTitle?.fromDash) {
    const controller = new AbortController()
    const ordered = await withTimeout(orderByLookup(fromTitle, { signal: controller.signal }), ORDER_LOOKUP_MS)
    controller.abort()
    fromTitle = ordered || preferKnownArtist(fromTitle, db)
  }
  const lookupInfo = fromTitle
    ? { ...info, ...fromTitle }
    : { ...info, title: clean ? stripArtistPrefix(info.title, info.artist) : info.title }

  let lyrics = null
  if (settings.download_embed_lyrics !== '0' && !info.hasLyrics && lookupInfo.title && lookupInfo.artist && db) {
    const controller = new AbortController()
    lyrics = await withTimeout(findLyrics(db, lookupInfo, controller.signal), LYRICS_TIMEOUT_MS)
    controller.abort()
  }

  const changes = { cleanTitle: clean && !fromTitle, squareCover: isYouTube(url) }
  if (fromTitle) { changes.title = fromTitle.title; changes.artist = fromTitle.artist }
  if (lyrics) {
    changes.lyrics = toPortableLyrics(lyrics)
    changes.privateLyrics = toPrivateTag(lyrics)
  }
  const done = await applyTags(filePath, changes)
  if (done.lyrics) { out.lyrics = lyrics.sync; out.lyricsSource = lyrics.source }
  out.cover = done.cover
  if (fromTitle && (done.title || done.artist)) {
    // Filed by what the file now says: a tag that couldn't be written keeps
    // the file's own value.
    const written = {
      title: done.title === fromTitle.title ? fromTitle.title : info.title,
      artist: done.artist === fromTitle.artist ? fromTitle.artist : info.artist,
    }
    out.artist = written.artist || undefined
    out.filePath = kind === 'single'
      ? refile(filePath, { ...written, album: info.album, outputDir })
      : refile(filePath, { title: written.title }) // playlists keep their folder
  } else if (clean) out.filePath = renameWithoutArtist(filePath, info.artist)
  return out
}

/** Pick source album metadata when the file's current tag is empty or a placeholder. */
function resolveKnownAlbum(existingAlbum, knownAlbum) {
  const existing = String(existingAlbum ?? '').trim()
  const known = String(knownAlbum ?? '').trim()
  if (isPlaceholderAlbum(existing) && !isPlaceholderAlbum(known)) return { value: known, replace: true }
  return { value: existing, replace: false }
}

/** finishFile for a file whose song is known from its source (an addon). */
async function finishKnownFile(filePath, info, { db, settings, known, outputDir, out, recoverArtwork }) {
  // yt-dlp tags a bare link with its own guesses, written over anything the
  // file had: the title is the link's file name ("7779369") and the artist
  // "Unknown Artist" (or the host). So the addon's title and artist win.
  // The album isn't guessed: one already in the file is kept.
  const album = resolveKnownAlbum(info.album, known.album)
  const tags = {
    title: known.title || info.title || '',
    artist: known.artist || info.artist || '',
    album: album.value,
  }
  const changes = {}
  if (known.title && known.title !== info.title) changes.title = known.title
  if (known.artist && known.artist !== info.artist) changes.artist = known.artist
  if (album.replace) changes.album = album.value
  // Year, track and disc numbers, ISRC, genre: only where the file has none.
  for (const key of ['year', 'track', 'disc', 'isrc', 'genre']) if (known[key]) changes[key] = known[key]
  let cover = known.cover ? await fetchBestCover(known.cover) : null
  if (!cover && !info.hasCover && recoverArtwork && tags.title && tags.artist) {
    // LastWave may omit cover metadata. Use the same strict recording match
    // as online artwork recovery, without accepting a similarly named song.
    try {
      const [found] = await resolveDownloadArtwork(tags.title, tags.artist, known.cover)
      if (found?.image) {
        cover = await fetchBestCover(found.image)
        if (cover) known.cover = found.image // retained in download history
      }
    } catch { /* Artwork failure must not discard downloaded audio. */ }
  }
  if (cover) { changes.coverBytes = cover.bytes; changes.coverMime = cover.mime; changes.upgradeLowResolutionCover = true }

  if (settings.download_embed_lyrics !== '0' && !info.hasLyrics && tags.title && tags.artist && db) {
    const controller = new AbortController()
    const lyrics = await withTimeout(findLyrics(db, { ...info, ...tags }, controller.signal), LYRICS_TIMEOUT_MS)
    controller.abort()
    if (lyrics) {
      changes.lyrics = toPortableLyrics(lyrics)
      changes.privateLyrics = toPrivateTag(lyrics)
      out.lyrics = lyrics.sync
      out.lyricsSource = lyrics.source
    }
  }
  const done = await applyTags(filePath, changes)
  if (!done.lyrics) { out.lyrics = null; out.lyricsSource = null }
  out.cover = done.cover
  // Filed by what the file now says: a tag that couldn't be written keeps
  // the file's own value, so the path never disagrees with the tags.
  const final = {
    title: changes.title && done.title !== changes.title ? info.title : tags.title,
    artist: changes.artist && done.artist !== changes.artist ? info.artist : tags.artist,
    album: changes.album && done.album !== changes.album ? info.album : tags.album,
  }
  out.artist = final.artist || undefined
  // Named and filed like any single: Music/Artist/Album/Title.ext.
  out.filePath = final.title ? refile(filePath, { artist: final.artist, title: final.title, album: final.album, outputDir }) : filePath
  return out
}

module.exports = { finishFile, findLyrics, artistAndTitle, preferKnownArtist, orderByLookup, swapped, knownTagsOf, resolveKnownAlbum }
