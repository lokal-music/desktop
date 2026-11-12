const { mergeDuplicates, mergeAllDuplicates } = require('../../electron/ipc/mergeDuplicates')
const router = require('express').Router()
const { removeTrackFiles, forgetDownloads } = require('../../electron/ipc/trackFiles')
const { getDB } = require('../../electron/ipc/db')
const { resolveArtistId } = require('../../electron/artistId')
const { getLibraryFolders } = require('../../electron/libraryFolder')
const { recordListeningEvent } = require('../../electron/ipc/recaps')
const { normalizeArtwork, writeEmbeddedArtwork } = require('../../electron/fileArtwork')
const path = require('path')
const fs = require('fs')



function scoreTrack(track) {
  let score = 0
  if (track.bitrate) score += track.bitrate / 100
  if (track.artwork_path) score += 10
  if (track.album) score += 5
  if (track.year) score += 3
  if (track.genre) score += 2
  return score
}

const { searchLyricsEntries } = require('../../electron/lyrics/librarySearch')

function normalizeDuplicateText(value, type = 'title') {
  let normalized = String(value || '').toLowerCase()
    .replace(/\[[^\]]*\]|\([^\)]*\)/g, ' ')
    .replace(/\s+(feat\.|ft\.|featuring)\s+.*$/i, ' ')
  if (type === 'title') {
    normalized = normalized.replace(/\b(remaster(ed)?|radio edit|clean|explicit|album version|single version|extended mix|original mix|bonus track|deluxe)\b/g, ' ')
  }
  return normalized.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function tokenizeDuplicateText(value, type = 'title') {
  return normalizeDuplicateText(value, type).split(' ').filter(Boolean)
}

function overlapScore(leftTokens, rightTokens) {
  if (!leftTokens.length || !rightTokens.length) return 0
  const left = new Set(leftTokens)
  const right = new Set(rightTokens)
  let shared = 0
  for (const token of left) {
    if (right.has(token)) shared += 1
  }
  return shared / Math.max(1, Math.min(left.size, right.size))
}

function durationSimilarity(leftDuration, rightDuration) {
  const diff = Math.abs(Number(leftDuration || 0) - Number(rightDuration || 0))
  if (diff > 4) return 0
  return Math.max(0, 1 - diff / 4)
}

function possibleDuplicateMatch(left, right) {
  const titleScore = overlapScore(left.titleTokens, right.titleTokens)
  const artistScore = overlapScore(left.artistTokens, right.artistTokens)
  const durationScore = durationSimilarity(left.duration, right.duration)
  const exactNormalized = left.normalizedTitle === right.normalizedTitle && left.normalizedArtist === right.normalizedArtist
  if (exactNormalized || (require('../../electron/recordingIdentity').sameRecording(left, right, Infinity) && require('../../electron/recordingIdentity').editionKey(left) === require('../../electron/recordingIdentity').editionKey(right))) return null
  const combined = titleScore * 0.45 + artistScore * 0.45 + durationScore * 0.1
  const isMatch = durationScore > 0 && artistScore >= 0.72 && (titleScore >= 0.58 || combined >= 0.74)
  if (!isMatch) return null
  return {
    titleScore,
    artistScore,
    durationDiff: Math.abs(Number(left.duration || 0) - Number(right.duration || 0)),
    combined,
  }
}

function buildPossibleDuplicateGroups(tracks = []) {
  if (!Array.isArray(tracks) || tracks.length < 2) return []
  // Ghosts retain streaming/history metadata, not another music file. They
  // must not be offered as duplicate files or as suggested keep candidates.
  const enriched = tracks.filter(track =>
    typeof track?.file_path === 'string' && track.file_path.trim() &&
    !/^ghost:\/\//i.test(track.file_path.trim())
  ).map(track => {
    const titleTokens = tokenizeDuplicateText(track.title, 'title')
    const artistTokens = tokenizeDuplicateText(track.artist, 'artist')
    return {
      ...track,
      qualityScore: scoreTrack(track),
      normalizedTitle: normalizeDuplicateText(track.title, 'title'),
      normalizedArtist: normalizeDuplicateText(track.artist, 'artist'),
      titleTokens,
      artistTokens,
      artistKey: artistTokens[0] || '',
      durationBucket: Math.round(Number(track.duration || 0) / 2),
    }
  }).filter(track => track.artistKey && track.titleTokens.length)
    .map((track, index) => ({ ...track, index }))

  const buckets = new Map()
  for (const track of enriched) {
    const bucketKey = `${track.artistKey}:${track.durationBucket}`
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, [])
    buckets.get(bucketKey).push(track)
  }

  const parent = enriched.map((_, index) => index)
  const find = (value) => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]]
      value = parent[value]
    }
    return value
  }
  const union = (left, right) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent[b] = a
  }

  const pairMeta = new Map()
  const seenPairs = new Set()
  for (const track of enriched) {
    for (let offset = -1; offset <= 1; offset += 1) {
      const bucketKey = `${track.artistKey}:${track.durationBucket + offset}`
      const candidates = buckets.get(bucketKey) || []
      for (const candidate of candidates) {
        if (candidate.index <= track.index) continue
        const pairKey = `${track.index}:${candidate.index}`
        if (seenPairs.has(pairKey)) continue
        seenPairs.add(pairKey)
        const match = possibleDuplicateMatch(track, candidate)
        if (!match) continue
        union(track.index, candidate.index)
        pairMeta.set(pairKey, match)
      }
    }
  }

  const grouped = new Map()
  for (const track of enriched) {
    const root = find(track.index)
    if (!grouped.has(root)) grouped.set(root, [])
    grouped.get(root).push(track)
  }

  return [...grouped.values()]
    .filter(group => group.length > 1)
    .map((group, index) => {
      const sortedTracks = [...group].sort((left, right) => require('../../electron/duplicateGroups').tierRank(right) - require('../../electron/duplicateGroups').tierRank(left) || (right.playlist_count || 0) - (left.playlist_count || 0) || right.qualityScore - left.qualityScore)
      const scores = []
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const key = `${Math.min(group[i].index, group[j].index)}:${Math.max(group[i].index, group[j].index)}`
          const meta = pairMeta.get(key)
          if (meta) scores.push(meta)
        }
      }
      const avg = scores.length ? scores.reduce((sum, item) => sum + item.combined, 0) / scores.length : 0
      const bestTitle = scores.length ? Math.max(...scores.map(item => item.titleScore)) : 0
      const bestArtist = scores.length ? Math.max(...scores.map(item => item.artistScore)) : 0
      const maxDurationDiff = scores.length ? Math.max(...scores.map(item => item.durationDiff)) : 0
      return {
        id: `possible-${index}-${sortedTracks[0].id}`,
        confidence: Math.round(avg * 100),
        suggestedKeepId: sortedTracks[0].id,
        summary: `Title ${(bestTitle * 100).toFixed(0)}% · Artist ${(bestArtist * 100).toFixed(0)}% · Δ ${maxDurationDiff.toFixed(1)}s`,
        tracks: sortedTracks.map(track => ({
          ...track,
          qualityScore: undefined,
          normalizedTitle: undefined,
          normalizedArtist: undefined,
          titleTokens: undefined,
          artistTokens: undefined,
          artistKey: undefined,
          durationBucket: undefined,
          index: undefined,
        })),
      }
    })
    .sort((left, right) => right.confidence - left.confidence)
}

function getKeepCommaArtists() {
  const keepComma = new Set([
    'tyler, the creator', 'earth, wind & fire', 'crosby, stills & nash',
    'crosby, stills, nash & young', 'simon & garfunkel', 'emerson, lake & palmer',
    'syd barrett', 'pete & bas', 'pe & ne',
  ])
  try {
    const setting = getDB().prepare("SELECT value FROM settings WHERE key = 'keep_comma_artists'").get()
    if (setting?.value) {
      const userDefined = JSON.parse(setting.value)
      userDefined.forEach(artist => keepComma.add(String(artist || '').toLowerCase().trim()))
    }
  } catch {}
  return keepComma
}

function splitArtists(raw) {
  const splitter = require('../../electron/artistSplit')
  const db = getDB()
  splitter.applySplitWordsFrom(db)
  let userDefined = []
  try {
    userDefined = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'keep_comma_artists'").get()?.value || '[]')
  } catch {}
  return splitter.splitArtists(raw, splitter.keepCommaSet(userDefined))
}

function applyBatchField(currentValue, operation) {
  if (!operation || operation.mode === 'ignore') return { changed: false, value: currentValue }
  if (operation.mode === 'clear') return { changed: currentValue !== null && currentValue !== '', value: null }
  if (operation.mode === 'removeText') {
    const currentText = String(currentValue ?? '')
    const needle = String(operation.value ?? '')
    if (!needle) return { changed: false, value: currentValue }
    const nextText = currentText.split(needle).join('').trim()
    return { changed: nextText !== currentText, value: nextText || null }
  }
  if (operation.mode === 'keepAfterText') {
    const currentText = String(currentValue ?? '')
    const needle = String(operation.value ?? '')
    if (!needle) return { changed: false, value: currentValue }
    const index = currentText.indexOf(needle)
    if (index === -1) return { changed: false, value: currentValue }
    const nextText = currentText.slice(index + needle.length).trim()
    return { changed: nextText !== currentText, value: nextText || null }
  }
  if (operation.mode === 'keepBeforeText') {
    const currentText = String(currentValue ?? '')
    const needle = String(operation.value ?? '')
    if (!needle) return { changed: false, value: currentValue }
    const index = currentText.indexOf(needle)
    if (index === -1) return { changed: false, value: currentValue }
    const nextText = currentText.slice(0, index).trim()
    return { changed: nextText !== currentText, value: nextText || null }
  }
  if (operation.mode === 'fillMissing') {
    const missing = currentValue === null || currentValue === undefined || String(currentValue) === ''
    return missing ? { changed: true, value: operation.value ?? null } : { changed: false, value: currentValue }
  }
  if (operation.mode === 'replace') {
    const nextValue = operation.value ?? null
    return { changed: currentValue !== nextValue, value: nextValue }
  }
  return { changed: false, value: currentValue }
}

function normalizeGenresForBatch(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .join(', ') || null
}

function firstGenreForBatch(value) {
  return normalizeGenresForBatch(value)?.split(',').map(part => part.trim()).filter(Boolean)[0] || null
}

function clearLyricsStateForTrack(db, trackId, filePath = null) {
  db.prepare('DELETE FROM lyrics_cache WHERE track_id = ?').run(trackId)
  db.prepare('DELETE FROM lyrics_translations WHERE track_id = ?').run(trackId)
  if (filePath) {
    try { db.prepare('DELETE FROM lyrics_cache WHERE file_path = ?').run(filePath) } catch {}
  }
}

function collectAllGenres(db) {
  // Keep the editor/filter suggestions aligned with the cleaned Genres page,
  // including aliases, ignored metadata values, and singleton categories.
  const { genres } = require('../../electron/genreList').genreSummary(db)
  return genres.map(item => item.name).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
}

function normalizeAlbumTracks(tracks = []) {
  const total = Array.isArray(tracks) ? tracks.length : 0
  const validNumbered = tracks.filter((track) => {
    const value = Number(track?.track_num)
    return Number.isInteger(value) && value > 0 && value !== 63
  })
  const useTrackNumbers = validNumbered.length >= Math.max(2, Math.ceil(total * 0.4))

  const sorted = [...tracks].sort((left, right) => {
    const leftTrack = Number(left?.track_num)
    const rightTrack = Number(right?.track_num)
    const leftValid = Number.isInteger(leftTrack) && leftTrack > 0 && leftTrack !== 63
    const rightValid = Number.isInteger(rightTrack) && rightTrack > 0 && rightTrack !== 63

    if (useTrackNumbers && leftValid !== rightValid) return leftValid ? -1 : 1
    if (useTrackNumbers && leftValid && rightValid && leftTrack !== rightTrack) return leftTrack - rightTrack

    const titleCompare = String(left?.title || '').localeCompare(String(right?.title || ''), undefined, { sensitivity: 'base' })
    if (titleCompare !== 0) return titleCompare
    return String(left?.file_path || '').localeCompare(String(right?.file_path || ''), undefined, { sensitivity: 'base' })
  })

  return sorted.map((track, index) => {
    const trackNum = Number(track?.track_num)
    const valid = Number.isInteger(trackNum) && trackNum > 0 && trackNum !== 63
    return {
      ...track,
      display_track_num: useTrackNumbers && valid ? trackNum : index + 1,
    }
  })
}

function splitGenreValues(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean)
}

function scoreRelatedTrack(baseTrack, candidate) {
  let score = 0
  const sameArtist = candidate.artist && baseTrack.artist && candidate.artist.toLowerCase() === baseTrack.artist.toLowerCase()
  if (sameArtist) score += 14
  if (candidate.album && baseTrack.album && candidate.album.toLowerCase() === baseTrack.album.toLowerCase()) score += sameArtist ? 4 : 2
  const baseGenres = splitGenreValues(baseTrack.genres || baseTrack.genre)
  const candidateGenres = new Set(splitGenreValues(candidate.genres || candidate.genre))
  let sharedGenres = 0
  for (const genre of baseGenres) {
    if (candidateGenres.has(genre)) {
      sharedGenres += 1
      score += sameArtist ? 2.5 : 3.5
    }
  }
  const numericFields = ['danceability', 'energy', 'valence', 'acousticness', 'instrumentalness', 'liveness', 'speechiness']
  let strongFeatureMatches = 0
  for (const field of numericFields) {
    const left = Number(baseTrack[field])
    const right = Number(candidate[field])
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue
    const diff = Math.abs(left - right)
    if (diff <= 0.08) strongFeatureMatches += 1
    score += Math.max(0, 2.5 - diff * 10)
  }
  const tempoA = Number(baseTrack.tempo)
  const tempoB = Number(candidate.tempo)
  if (Number.isFinite(tempoA) && Number.isFinite(tempoB)) {
    score += Math.max(0, 2 - Math.abs(tempoA - tempoB) / 15)
  }
  if (!sameArtist && sharedGenres > 0 && strongFeatureMatches >= 2) score += 4
  if (baseTrack.explicit && candidate.explicit) score += 0.5
  return score
}

async function applyBatchTrackUpdates(db, trackIds = [], operations = {}) {
  if (!Array.isArray(trackIds) || !trackIds.length) return []
  const { getStorageDir } = require('../../electron/ipc/db')
  const ids = [...new Set(trackIds.filter(Boolean))]
  const tracks = ids.map(id => db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)).filter(Boolean)
  if (!tracks.length) return []

  const artworkOp = operations.artwork
  if (artworkOp?.mode === 'replace' && artworkOp?.value) {
    const base64 = String(artworkOp.value).split(',')[1] || ''
    for (const track of tracks) {
      const artPath = path.join(getStorageDir(), 'artwork', `${track.id}.jpg`)
      const dir = path.dirname(artPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(artPath, Buffer.from(base64, 'base64'))
    }
  }

  const patch = db.transaction(() => {
    const updatedIds = []
    for (const track of tracks) {
      const updates = []
      const params = []
      const nextValues = {}
      for (const field of ['title', 'artist', 'album', 'album_artist', 'track_num', 'year', 'genre', 'genres', 'record_label', 'explicit', 'instrumental']) {
        const result = applyBatchField(track[field], operations[field])
        if (result.changed) {
          updates.push(`${field} = ?`)
          params.push(result.value)
          nextValues[field] = result.value
        }
      }
      const hasGenreUpdate = Object.prototype.hasOwnProperty.call(nextValues, 'genre')
      const hasGenresUpdate = Object.prototype.hasOwnProperty.call(nextValues, 'genres')
      if (hasGenreUpdate || hasGenresUpdate) {
        const normalizedGenres = hasGenresUpdate
          ? normalizeGenresForBatch(nextValues.genres)
          : normalizeGenresForBatch(track.genres || nextValues.genre || track.genre)
        const primaryGenre = hasGenreUpdate
          ? (nextValues.genre || firstGenreForBatch(normalizedGenres))
          : firstGenreForBatch(normalizedGenres)

        delete nextValues.genre
        delete nextValues.genres
        updates.push('genre = ?')
        params.push(primaryGenre || null)
        nextValues.genre = primaryGenre || null
        updates.push('genres = ?')
        params.push(normalizedGenres)
        nextValues.genres = normalizedGenres
      }
      if (artworkOp?.mode === 'clear' && track.artwork_path) {
        updates.push('artwork_path = ?')
        params.push(null)
      } else if (artworkOp?.mode === 'replace' && artworkOp?.value) {
        updates.push('artwork_path = ?')
        params.push(path.join(getStorageDir(), 'artwork', `${track.id}.jpg`))
      }
      if (!updates.length) continue
      params.push(track.id)
      db.prepare(`UPDATE tracks SET ${updates.join(', ')} WHERE id = ?`).run(...params)
      updatedIds.push(track.id)
      if (nextValues.instrumental === 1) {
        clearLyricsStateForTrack(db, track.id, track.file_path)
      }
      if (Object.prototype.hasOwnProperty.call(nextValues, 'artist')) {
        db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(track.id)
        const artistNames = splitArtists(nextValues.artist)
        for (const name of artistNames) {
          const artistId = resolveArtistId(db, name)
          db.prepare('INSERT OR IGNORE INTO artist_track_links (artist_id, track_id) VALUES (?, ?)').run(artistId, track.id)
        }
      }
    }
    db.prepare('DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM artist_track_links)').run()
    return updatedIds
  })

  return patch().map(id => db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)).filter(Boolean)
}

router.get('/folder-artwork', (req, res) => {
  try {
    const db = getDB()
    const plural = db.prepare("SELECT value FROM settings WHERE key = 'music_folders'").get()?.value
    let configuredRoots = []
    try { configuredRoots = Array.isArray(JSON.parse(plural || 'null')) ? JSON.parse(plural) : [] } catch {}
    if (!configuredRoots.length) { const legacy = db.prepare("SELECT value FROM settings WHERE key = 'music_folder'").get()?.value; if (legacy) configuredRoots = [legacy] }
    if (!configuredRoots.length || typeof req.query.path !== 'string' || !req.query.path) return res.status(404).end()
    const requested = fs.realpathSync(path.resolve(req.query.path))
    const withinRoot = configuredRoots.some(configuredRoot => {
      try {
        const root = fs.realpathSync(configuredRoot)
        const relative = path.relative(root, requested)
        return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
      } catch { return false }
    })
    const allowed = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
    if (!withinRoot || !fs.statSync(requested).isFile() || !allowed.has(path.extname(requested).toLowerCase())) return res.status(404).end()
    res.set('Cache-Control', 'private, max-age=3600')
    return res.sendFile(requested)
  } catch { return res.status(404).end() }
})

router.get('/library-folders', (req, res) => {
  try {
    res.json(getLibraryFolders(getDB(), typeof req.query.path === 'string' ? req.query.path : '', typeof req.query.search === 'string' ? req.query.search : '', typeof req.query.root === 'string' ? req.query.root : ''))
  } catch (error) {
    console.error('[library-folders] Could not read library folder:', error.message)
    res.status(500).json({ available: false, error: 'Could not read the selected music folder', folders: [], tracks: [] })
  }
})

router.get('/missing', (req, res) => {
  try {
    const db = getDB()
    const rows = db.prepare("SELECT id, title, artist, album, duration, source_ref, file_path FROM tracks WHERE file_path NOT LIKE 'ghost://%'").all()
    res.json(rows.filter(track => track.file_path && !fs.existsSync(track.file_path)).map(track => ({ ...track, missing: true })))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/', (req, res) => {
  const db = getDB()
  const { sort = 'added_at DESC', limit = 500, offset = 0, id, artistName, artistId, album, albumArtist, source, genre, quality, includeGhosts, problems, search, format } = req.query
  if (album) {
    const params = [album]
    let sql = "SELECT * FROM tracks WHERE album = ? AND file_path NOT LIKE 'ghost://%'"
    if (albumArtist) {
      sql += " AND LOWER(COALESCE(NULLIF(album_artist, ''), artist)) = LOWER(?)"
      params.push(albumArtist)
    }
    // Album detail screens should follow the same device-first view as Songs.
    const preference = require('../../electron/libraryDevicePreference')
    // Only suppress a phone row when its desktop counterpart is also in this album view.
    // Album-artist filtering can differ between synced metadata, so retain both there.
    if (!albumArtist && preference.shouldPreferDesktop({ source, id, includeGhosts, problems })) {
      sql += ' AND ' + preference.desktopPreferredLibraryClause().replace(
        "AND desktop.title = tracks.title COLLATE NOCASE",
        "AND desktop.album = tracks.album AND desktop.title = tracks.title COLLATE NOCASE"
      )
    }
    const tracks = db.prepare(sql).all(...params)
    res.json(normalizeAlbumTracks(tracks).map(track => ({ ...track, missing: !fs.existsSync(track.file_path) })))
    return
  }
  const params = []
  // A query string: "problems=false" must not count as on.
  const files = require('../../electron/trackErrors').truthy(problems) ? null : require('../../electron/libraryTracks').trackFileFilter(includeGhosts)
  const where = files ? [files] : []
  if (id) { where.push('id = ?'); params.push(id) }
  if (artistName) { where.push('artist = ?'); params.push(artistName) }
  if (artistId) { where.push('id IN (SELECT track_id FROM artist_track_links WHERE artist_id = ?)'); params.push(artistId) }
  const sourceWhere = require('../../electron/ipc/scanner').sourceFilter(source)
  if (sourceWhere) { where.push(sourceWhere.sql); params.push(...sourceWhere.params) }
  const genreWhere = require('../../electron/ipc/scanner').genreFilter(typeof genre === 'string' ? genre : '')
  if (genreWhere) { where.push(genreWhere.sql); params.push(...genreWhere.params) }
  const qualityWhere = typeof quality === 'string' && quality ? require('../../electron/quality').tierFilter(db, quality) : null
  if (qualityWhere) { where.push(qualityWhere.sql); params.push(...qualityWhere.params) }
  if (typeof format === 'string' && format) {
    const match = format.match(/^(16|24|32)-(\d{5,6})$/)
    if (match) { where.push('bit_depth = ? AND sample_rate = ?'); params.push(Number(match[1]), Number(match[2])) }
  }
  const searchText = String(search || '').trim()
  if (searchText) {
    const { wordsMatch, TRACK_COLUMNS } = require('../../electron/librarySearch')
    const searchWhere = wordsMatch(searchText, TRACK_COLUMNS)
    if (searchWhere) { where.push(searchWhere.sql); params.push(...searchWhere.params) }
  }
  res.json(require('../../electron/trackErrors').listTracks(db, { sort, limit, offset, problems, source, id, includeGhosts, hasRestrictiveFilters: Boolean(artistName || artistId || genre || quality || format || searchText) }, { where, params, exists: fs.existsSync }))
})

router.post('/:id/error', (req, res) => res.json({ ok: require('../../electron/trackErrors').recordTrackError(getDB(), req.params.id, req.body?.message) }))
router.delete('/:id/error', (req, res) => res.json({ ok: require('../../electron/trackErrors').clearTrackError(getDB(), req.params.id) }))

router.get('/:id/file-size', (req, res) => {
  const filePath = getDB().prepare('SELECT file_path FROM tracks WHERE id = ?').get(String(req.params.id || ''))?.file_path
  if (!filePath || String(filePath).startsWith('ghost://')) return res.json({ bytes: null })
  try {
    const stat = fs.statSync(filePath)
    return res.json({ bytes: stat.isFile() ? stat.size : null })
  } catch { return res.json({ bytes: null }) }
})

// Settings > Library > Fill In Genres (see electron/online/genres.js).
router.post('/fetch-missing-genres', (req, res) => {
  try { res.json(require('../../electron/online/genres').startLibraryGenres(getDB())) } catch (e) { res.json({ error: e.message }) }
})
router.get('/genres-status', (req, res) => res.json(require('../../electron/online/genres').libraryGenresStatus()))

// The library's files in short (see electron/ipc/libraryKeys.js).
router.post('/owned', async (req, res, next) => {
  try { res.json(await require('../../electron/libraryOwned').findOwnedTracks(getDB(), req.body?.candidates)) } catch (error) { next(error) }
})

router.get('/library-keys', (req, res) => {
  try { res.json(require('../../electron/ipc/libraryKeys').libraryKeys(getDB())) } catch (e) { res.json([]) }
})

// Flow's songs: the library with this user's likes and plays (electron/ipc/flow.js).
router.get('/flow-pool', (req, res) => {
  try { res.json(require('../../electron/ipc/flow').flowPool(getDB(), String(req.query.userId || 'guest'))) } catch (e) { res.json({ error: e.message }) }
})

router.get('/search', (req, res) => {
  // Every word in one of the fields, in any order (electron/librarySearch.js).
  res.json(require('../../electron/librarySearch').searchTracks(getDB(), String(req.query.q || ''), 60))
})

router.get('/search-lyrics', (req, res) => {
  res.json(searchLyricsEntries(getDB(), req.query.q || ''))
})

router.get('/liked', (req, res) => {
  const userId = req.query.userId || 'guest'
  const db = getDB()
  const { songIds, foldStreamedLikes } = require('../../electron/online/sources')
  foldStreamedLikes(db, userId)
  // also_ids: the other ids each song goes by, so its heart shows everywhere.
  res.json(db.prepare(`
    SELECT t.* FROM tracks t JOIN user_likes ul ON ul.track_id = t.id
    WHERE ul.user_id = ? ORDER BY ul.liked_at DESC
  `).all(userId).map(t => ({ ...t, also_ids: songIds(db, t.id).filter(id => id !== t.id) })))
})

router.get('/history', (req, res) => {
  const { userId = 'guest', limit = 30 } = req.query
  res.json(getDB().prepare(`
    SELECT t.*, ph.played_at FROM tracks t
    JOIN play_history ph ON ph.track_id = t.id
    WHERE ph.user_id = ?
    ORDER BY ph.played_at DESC LIMIT ?
  `).all(userId, parseInt(limit)))
})


router.get('/history/export', (req, res) => {
  const { userId = 'guest', format = 'json' } = req.query
  const db = getDB()
  
  try { db.exec('ALTER TABLE play_history ADD COLUMN seconds_played INTEGER DEFAULT 0') } catch {}
  const history = db.prepare(`
    SELECT t.title, t.artist, t.album, ph.played_at, COALESCE(ph.seconds_played, 0) as seconds_played
    FROM play_history ph
    JOIN tracks t ON t.id = ph.track_id
    WHERE ph.user_id = ?
    ORDER BY ph.played_at DESC
  `).all(userId)
  
  if (format === 'csv') {
    const header = 'title,artist,album,played_at,seconds_played\n'
    const rows = history.map(h => 
      `"${h.title}","${h.artist}","${h.album || ''}",${h.played_at},${h.seconds_played || 0}`
    ).join('\n')
    res.type('csv').send(header + rows)
  } else {
    res.json(history)
  }
})

router.get('/suggestions', (req, res) => {
  const { userId = 'guest' } = req.query
  const db = getDB()
  const liked = db.prepare(`
    SELECT t.artist, t.genre FROM tracks t
    JOIN user_likes ul ON ul.track_id = t.id WHERE ul.user_id = ?
  `).all(userId)
  if (!liked.length) return res.json(db.prepare("SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%' ORDER BY RANDOM() LIMIT 20").all())
  const artists = [...new Set(liked.map(l => l.artist).filter(Boolean))].slice(0, 5)
  const genres = [...new Set(liked.map(l => l.genre).filter(Boolean))].slice(0, 5)
  let rows = []
  if (artists.length) rows = db.prepare(`SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND artist IN (${artists.map(()=>'?').join(',')}) ORDER BY RANDOM() LIMIT 20`).all(...artists)
  if (rows.length < 20 && genres.length) {
    const extra = db.prepare(`SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND genre IN (${genres.map(()=>'?').join(',')}) ORDER BY RANDOM() LIMIT 20`).all(...genres)
    const ids = new Set(rows.map(r => r.id))
    rows = [...rows, ...extra.filter(r => !ids.has(r.id))].slice(0, 20)
  }
  res.json(rows)
})


router.get('/random', (req, res) => {
  res.json(getDB().prepare("SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%' ORDER BY RANDOM() LIMIT 1").get())
})


router.get('/top-genres', (req, res) => {
  res.json(getDB().prepare(`
    SELECT genre, COUNT(*) as count FROM tracks 
    WHERE file_path NOT LIKE 'ghost://%' AND genre IS NOT NULL GROUP BY genre 
    ORDER BY count DESC LIMIT 10
  `).all())
})

router.get('/genres', (req, res) => {
  res.json(collectAllGenres(getDB()))
})

router.get('/genre-summary', (req, res) => {
  res.json(require('../../electron/genreList').genreSummary(getDB()))
})


router.put('/:id/genre', (req, res) => {
  const { genre } = req.body
  getDB().prepare('UPDATE tracks SET genre = ? WHERE id = ?').run(genre || null, req.params.id)
  res.json({ ok: true })
})

router.put('/:id', (req, res) => {
  const db = getDB()
  const currentTrack = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id)
  if (!currentTrack) return res.json({ error: 'Track not found' })
  const {
    title,
    artist,
    album,
    album_artist,
    track_num,
    year,
    genre,
    genres,
    record_label,
    explicit,
    instrumental,
    clip_url,
    clip_start,
    clip_end,
    clip_zoom,
    danceability,
    energy,
    track_key,
    loudness,
    mode,
    speechiness,
    acousticness,
    instrumentalness,
    liveness,
    valence,
    tempo,
    time_signature,
  } = req.body
  const updates = []
  const params = []
  
  if (title !== undefined) { updates.push('title = ?'); params.push(title) }
  if (artist !== undefined) { updates.push('artist = ?'); params.push(artist) }
  if (album !== undefined) { updates.push('album = ?'); params.push(album) }
  if (album_artist !== undefined) { updates.push('album_artist = ?'); params.push(album_artist) }
  if (track_num !== undefined) { updates.push('track_num = ?'); params.push(track_num) }
  if (year !== undefined) { updates.push('year = ?'); params.push(year) }
  if (record_label !== undefined) { updates.push('record_label = ?'); params.push(record_label) }
  if (explicit !== undefined) { updates.push('explicit = ?'); params.push(explicit ? 1 : 0) }
  if (instrumental !== undefined) { updates.push('instrumental = ?'); params.push(instrumental === null ? null : instrumental ? 1 : 0) }
  if (clip_url !== undefined) { updates.push('clip_url = ?'); params.push(clip_url || null) }
  if (clip_start !== undefined) { updates.push('clip_start = ?'); params.push(clip_start === '' ? null : clip_start) }
  if (clip_end !== undefined) { updates.push('clip_end = ?'); params.push(clip_end === '' ? null : clip_end) }
  if (clip_zoom !== undefined) { updates.push('clip_zoom = ?'); params.push(clip_zoom === '' ? null : clip_zoom) }
  if (danceability !== undefined) { updates.push('danceability = ?'); params.push(danceability) }
  if (energy !== undefined) { updates.push('energy = ?'); params.push(energy) }
  if (track_key !== undefined) { updates.push('track_key = ?'); params.push(track_key) }
  if (loudness !== undefined) { updates.push('loudness = ?'); params.push(loudness) }
  if (mode !== undefined) { updates.push('mode = ?'); params.push(mode) }
  if (speechiness !== undefined) { updates.push('speechiness = ?'); params.push(speechiness) }
  if (acousticness !== undefined) { updates.push('acousticness = ?'); params.push(acousticness) }
  if (instrumentalness !== undefined) { updates.push('instrumentalness = ?'); params.push(instrumentalness) }
  if (liveness !== undefined) { updates.push('liveness = ?'); params.push(liveness) }
  if (valence !== undefined) { updates.push('valence = ?'); params.push(valence) }
  if (tempo !== undefined) { updates.push('tempo = ?'); params.push(tempo) }
  if (time_signature !== undefined) { updates.push('time_signature = ?'); params.push(time_signature) }

  if (genre !== undefined || genres !== undefined) {
    const normalizedGenres = genres !== undefined
      ? normalizeGenresForBatch(genres)
      : normalizeGenresForBatch(currentTrack.genres || genre || currentTrack.genre)
    const primaryGenre = genre !== undefined
      ? (genre || firstGenreForBatch(normalizedGenres))
      : firstGenreForBatch(normalizedGenres)
    updates.push('genre = ?')
    params.push(primaryGenre || null)
    updates.push('genres = ?')
    params.push(normalizedGenres)
  }
  
  if (updates.length === 0) return res.json({ error: 'No fields to update' })

  // The editable metadata also belongs in the audio file, not just the database.
  const tagEdits = require('../../electron/fileComment').fileTagEdits(req.body || {})
  if (Object.keys(tagEdits).length && !String(currentTrack.file_path || '').startsWith('ghost://') && fs.existsSync(currentTrack.file_path)) {
    try {
      require('../../electron/fileComment').writeFileTags(currentTrack.file_path, tagEdits)
      require('../../electron/fileStamp').noteFileWritten(db, currentTrack.file_path)
    } catch (e) { return res.json({ error: `Couldn't save the tags into the file: ${e.message}` }) }
  }

  params.push(req.params.id)
  const sql = `UPDATE tracks SET ${updates.join(', ')} WHERE id = ?`
  const result = db.prepare(sql).run(...params)
  if (artist !== undefined) {
    db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(req.params.id)
    for (const name of splitArtists(artist)) {
      const artistId = resolveArtistId(db, name)
      db.prepare('INSERT OR IGNORE INTO artist_track_links (artist_id, track_id) VALUES (?, ?)').run(artistId, req.params.id)
    }
    db.prepare('DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM artist_track_links)').run()
  }
  if (instrumental === 1 || instrumental === true) {
    clearLyricsStateForTrack(db, req.params.id, currentTrack.file_path)
  }
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id)
  res.json({ success: true, changes: result.changes, track })
})

router.post('/batch-update', async (req, res) => {
  const db = getDB()
  try {
    const tracks = await applyBatchTrackUpdates(db, req.body?.trackIds || [], req.body?.operations || {})
    res.json({ success: true, tracks })
  } catch (e) {
    res.json({ error: e.message })
  }
})

router.put('/:id/artwork', async (req, res) => {
  const { imageData } = req.body || {}
  if (!imageData) return res.json({ error: 'No image data provided' })

  const db = getDB()
  const { getStorageDir } = require('../../electron/ipc/db')
  let tempPath = null

  try {
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(String(req.params.id || ''))
    if (!track) return res.json({ error: 'Track not found' })
    const buf = await normalizeArtwork(imageData)
    const filePath = String(track.file_path || '')
    const hasLocalFile = path.isAbsolute(filePath) && !filePath.startsWith('ghost://')
    if (hasLocalFile) {
      if (!fs.existsSync(filePath)) return res.json({ error: 'The audio file is missing; artwork was not changed.' })
      // Embed the new cover into the original audio, not just Lokal's artwork cache.
      writeEmbeddedArtwork(filePath, buf)
      require('../../electron/fileStamp').noteFileWritten(db, filePath)
    }

    const artPath = path.join(getStorageDir(), 'artwork', `${req.params.id}.jpg`)
    fs.mkdirSync(path.dirname(artPath), { recursive: true })
    tempPath = `${artPath}.${process.pid}.tmp`
    await fs.promises.writeFile(tempPath, buf)
    await fs.promises.rename(tempPath, artPath)
    tempPath = null
    db.prepare('UPDATE tracks SET artwork_path = ? WHERE id = ?').run(artPath, req.params.id)
    res.json(db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id) || { success: true, path: artPath })
  } catch (error) {
    if (tempPath) { try { await fs.promises.unlink(tempPath) } catch {} }
    res.json({ error: error?.message || 'Could not replace artwork' })
  }
})

router.post('/:id/like', (req, res) => {
  const db = getDB()
  const { userId = 'guest' } = req.body
  // A streamed song you already have is that song: see toggleSongLike.
  res.json(require('../../electron/online/sources').toggleSongLike(db, userId, req.params.id))
})

router.post('/:id/like-state', (req, res) => {
  const db = getDB()
  const { userId = 'guest', liked = false } = req.body || {}
  res.json(require('../../electron/online/sources').setSongLike(db, userId, req.params.id, !!liked))
})

router.post('/:id/playtime', (req, res) => {
  try {
    const { userId = 'guest', seconds = 0 } = req.body
    const db = getDB()
    const secs = Math.round(seconds)
    if (secs >= 30) db.prepare('UPDATE tracks SET play_count = play_count + 1 WHERE id = ?').run(req.params.id)
    const track = db.prepare('SELECT duration FROM tracks WHERE id = ?').get(req.params.id)
    const sessionId = recordListeningEvent(db, { userId, trackId: req.params.id, secondsPlayed: secs, trackDuration: track?.duration || null })
    const hasSecs = db.prepare('PRAGMA table_info(play_history)').all().some(c => c.name === 'seconds_played')
    try { db.exec('ALTER TABLE play_history ADD COLUMN session_id TEXT') } catch {}
    if (hasSecs) db.prepare('INSERT INTO play_history (user_id, track_id, seconds_played, session_id) VALUES (?, ?, ?, ?)').run(userId, req.params.id, secs, sessionId)
    else db.prepare('INSERT INTO play_history (user_id, track_id) VALUES (?, ?)').run(userId, req.params.id)
    res.json({ ok: true })
  } catch (e) { res.json({ error: e.message }) }
})

router.get('/:id/related', (req, res) => {
  const { userId = 'guest' } = req.query
  const db = getDB()
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id)
  if (!track) return res.json([])
  const recentIds = db.prepare('SELECT track_id FROM play_history WHERE user_id = ? ORDER BY played_at DESC LIMIT 100').all(userId).map(row => row.track_id)
  const recentSet = new Set(recentIds)
  const candidates = db.prepare(`
    SELECT * FROM tracks
    WHERE id != ?
      AND file_path NOT LIKE 'ghost://%'
      AND (
        artist = ?
        OR LOWER(COALESCE(genre, '')) = LOWER(?)
        OR LOWER(COALESCE(genres, '')) LIKE LOWER(?)
        OR (danceability IS NOT NULL AND ABS(danceability - ?) <= 0.18)
        OR (energy IS NOT NULL AND ABS(energy - ?) <= 0.18)
        OR (tempo IS NOT NULL AND ABS(tempo - ?) <= 18)
      )
    ORDER BY RANDOM()
    LIMIT 180
  `).all(req.params.id, track.artist || '', track.genre || '', `%${track.genre || ''}%`, Number(track.danceability) || -99, Number(track.energy) || -99, Number(track.tempo) || -999)
  let related = candidates
    .filter(candidate => !recentSet.has(candidate.id))
    .map(candidate => ({ track: candidate, score: scoreRelatedTrack(track, candidate) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .map(item => item.track)
    .slice(0, 25)
  if (related.length < 10) {
    const extra = db.prepare("SELECT * FROM tracks WHERE id != ? AND file_path NOT LIKE 'ghost://%' ORDER BY RANDOM() LIMIT 40").all(req.params.id)
    const ids = new Set(related.map(r => r.id))
    related = [...related, ...extra.filter(r => !ids.has(r.id) && !recentSet.has(r.id))].slice(0, 25)
  }
  res.json(related)
})

router.get('/duplicates', (req, res) => {
  res.json(require('../../electron/duplicateGroups').exactDuplicateGroups(getDB()))
})

router.get('/possible-duplicates', (req, res) => {
  const tracks = getDB().prepare("SELECT t.*, (SELECT COUNT(DISTINCT playlist_id) FROM playlist_tracks p WHERE p.track_id=t.id) AS playlist_count FROM tracks t WHERE file_path NOT LIKE 'ghost://%' ORDER BY artist, title").all()
  res.json(buildPossibleDuplicateGroups(tracks))
})

router.post('/merge', async (req, res, next) => {
  try {
    const { keepId, removeIds = [] } = req.body
    res.json(await mergeDuplicates(getDB(), keepId, removeIds))
  } catch (error) { next(error) }
})

router.post('/merge-all', async (req, res, next) => {
  try { res.json(await mergeAllDuplicates(getDB(), scoreTrack)) } catch (error) { next(error) }
})

router.post('/batch-delete', async (req, res, next) => {
  try {
    const { ids = [] } = req.body
    const db = getDB()
    const filePaths = ids.map(id => db.prepare('SELECT file_path FROM tracks WHERE id = ?').get(id)?.file_path)
    for (const id of ids) {
      db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(id)
      db.prepare('DELETE FROM playlist_tracks WHERE track_id = ?').run(id)
      db.prepare('DELETE FROM user_likes WHERE track_id = ?').run(id)
      db.prepare('DELETE FROM play_history WHERE track_id = ?').run(id)
      try { db.prepare('DELETE FROM listening_events WHERE track_id = ?').run(id) } catch {}
      db.prepare('DELETE FROM lyrics_cache WHERE track_id = ?').run(id)
      try { db.prepare('DELETE FROM lyrics_translations WHERE track_id = ?').run(id) } catch {}
      db.prepare('DELETE FROM tracks WHERE id = ?').run(id)
    }
    forgetDownloads(ids)
    res.json({ ok: true, files: await removeTrackFiles(db, filePaths) })
  } catch (e) { next(e) }
})

// The track menu's Delete (the desktop app has the same, over IPC).
router.post('/delete-by-path', async (req, res, next) => {
  try {
    const filePath = req.body?.filePath
    const db = getDB()
    const track = filePath ? db.prepare('SELECT id FROM tracks WHERE file_path = ?').get(filePath) : null
    if (!track) return res.status(404).json({ error: 'Track not found' })
    const trackId = track.id
    db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(trackId)
    db.prepare('DELETE FROM playlist_tracks WHERE track_id = ?').run(trackId)
    db.prepare('DELETE FROM user_likes WHERE track_id = ?').run(trackId)
    db.prepare('DELETE FROM play_history WHERE track_id = ?').run(trackId)
    try { db.prepare('DELETE FROM listening_events WHERE track_id = ?').run(trackId) } catch {}
    db.prepare('DELETE FROM lyrics_cache WHERE track_id = ?').run(trackId)
    db.prepare('DELETE FROM lyrics_cache WHERE file_path = ?').run(filePath)
    try { db.prepare('DELETE FROM lyrics_translations WHERE track_id = ?').run(trackId) } catch {}
    db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId)
    forgetDownloads([trackId])
    res.json({ success: true, trackId, files: await removeTrackFiles(db, [filePath]) })
  } catch (e) { next(e) }
})

module.exports = router
