// A Lokal playlist linked to a playlist on Spotify, Tidal, Apple Music or
// Qobuz (anything a SpotiFLAC addon's link handler reads), or on YouTube
// Music (read by Lokal itself, no addon). Syncing is never
// automatic unless asked for: each sync adds the songs added there since the
// last one, in the library already or as ghost songs the caller then
// downloads from the playback sources. Nothing is removed: a song deleted
// there, or removed here, stays as it is (songs once seen are remembered).

const PLATFORMS = [
  { id: 'spotify', label: 'Spotify', hosts: /(^|\.)spotify\.com$/, addon: 'Spotify Web' },
  { id: 'tidal', label: 'Tidal', hosts: /(^|\.)tidal\.com$/, addon: 'Tidal' },
  { id: 'apple', label: 'Apple Music', hosts: /^music\.apple\.com$/, addon: 'Apple Music' },
  { id: 'qobuz', label: 'Qobuz', hosts: /(^|\.)qobuz\.com$/, addon: 'Qobuz' },
  { id: 'deezer', label: 'Deezer', hosts: /^(?:www\.)?deezer\.com$/, builtin: true },
  // Read with the playlist import's own reader (helpers.readPlaylist).
  { id: 'youtube-music', label: 'YouTube Music', hosts: /^music\.youtube\.com$/, builtin: true },
]

function ensure(db) {
  db.exec('CREATE TABLE IF NOT EXISTS playlist_sync (playlist_id TEXT PRIMARY KEY, url TEXT NOT NULL, platform TEXT NOT NULL, title TEXT, synced_at INTEGER, seen_json TEXT NOT NULL DEFAULT \'[]\', error TEXT)')
}

function platformOf(raw) {
  let url
  try { url = new URL(String(raw || '').trim()) } catch { return null }
  if (url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  const platform = PLATFORMS.find(p => p.hosts.test(host))
  if (platform?.id === 'deezer') {
    const id = require('./deezer').playlistId(url.href)
    return id ? { ...platform, url: `https://www.deezer.com/playlist/${id}` } : null
  }
  return platform && /playlist/i.test(url.pathname) ? { ...platform, url: url.href } : null
}

/** The installed, enabled SpotiFLAC addon whose link handler reads this link. */
function addonFor(packages, url) {
  const host = new URL(url).hostname.toLowerCase()
  return packages.list().filter(addon => addon.enabled).map(addon => packages.find(addon.key)).find(addon => {
    const handler = addon?.manifest?.urlHandler
    return handler?.enabled && (handler.patterns || []).some(pattern => {
      const value = String(pattern).toLowerCase()
      return !value.includes(':') && (host === value || host.endsWith(`.${value}`))
    })
  }) || null
}

function link(db, playlistId, rawUrl) {
  ensure(db)
  const platform = platformOf(rawUrl)
  if (!platform) return { error: 'Paste the link of a playlist on Spotify, Tidal, Apple Music, Qobuz, Deezer or YouTube Music.' }
  if (!db.prepare('SELECT id FROM playlists WHERE id = ?').get(playlistId)) return { error: 'Playlist not found' }
  db.prepare('INSERT OR REPLACE INTO playlist_sync (playlist_id, url, platform, title, synced_at, seen_json, error) VALUES (?, ?, ?, NULL, NULL, \'[]\', NULL)').run(playlistId, platform.url, platform.id)
  return status(db, playlistId)
}

function unlink(db, playlistId) {
  ensure(db)
  db.prepare('DELETE FROM playlist_sync WHERE playlist_id = ?').run(playlistId)
  return { ok: true }
}

function status(db, playlistId) {
  ensure(db)
  const row = db.prepare('SELECT * FROM playlist_sync WHERE playlist_id = ?').get(playlistId)
  if (!row) return { linked: false }
  const platform = PLATFORMS.find(p => p.id === row.platform)
  return { linked: true, url: row.url, platform: row.platform, platformLabel: platform?.label || row.platform, title: row.title, syncedAt: row.synced_at, error: row.error }
}

function linked(db) {
  ensure(db)
  return db.prepare('SELECT playlist_id FROM playlist_sync').all().map(row => row.playlist_id)
}

const plain = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const songKey = (title, artist) => `${plain(title)}\0${plain(String(artist || '').split(/\s*,\s*/)[0])}`
const artistNames = value => String(value || '').split(/\s*(?:,|;|&|\/|\bfeat\.?|\bft\.?|\bwith\b|\bx\b)\s*/i).map(plain).filter(Boolean)
const textOf = value => typeof value === 'string' ? value : value && typeof value === 'object' ? String(value.name || value.title || '') || null : null

/**
 * A library copy only when its artists include the song's main artist as a
 * whole name: findTrack also accepts a partial match ("Ann" in "Joanne"),
 * which an automatic sync must not trust.
 */
function libraryCopy(db, helpers, entry) {
  const found = helpers.findTrack(db, entry)
  if (!found?.id) return null
  const row = db.prepare('SELECT artist FROM tracks WHERE id = ?').get(found.id)
  const wanted = artistNames(entry.artist)[0]
  return !wanted || artistNames(row?.artist).includes(wanted) ? found : null
}

/** Prefer Lokal's fully paginated account reader when Spotify is connected. */
async function readSpotifyPlaylist(url, { cookie, read } = {}) {
  if (!cookie) return null
  const id = new URL(url).pathname.match(/\/playlist\/([A-Za-z0-9]{22})(?:\/|$)/)?.[1]
  if (!id) throw new Error('Use the full Spotify playlist link.')
  const result = await (read || require('../artwork/spotify').playlistTracks)(cookie, `spotify:playlist:${id}`, { max: null })
  if (result?.error) throw new Error(result.error)
  if (!Array.isArray(result?.tracks)) throw new Error('Spotify returned no playlist tracks.')
  return { name: result.title, total_tracks: result.total ?? result.tracks.length, skipped: result.unavailable || 0,
    tracks: result.tracks.map(track => ({
      id: String(track.spotifyUri || '').replace(/^spotify:track:/, ''),
      name: track.title, artists: track.artists || track.artist, album: track.album,
      duration_ms: Number(track.duration) > 0 ? track.duration * 1000 : null,
      source_url: /^spotify:track:[A-Za-z0-9]{22}$/.test(track.spotifyUri || '')
        ? `https://open.spotify.com/track/${track.spotifyUri.slice('spotify:track:'.length)}` : null,
    })) }
}

/**
 * Sync one linked playlist. `packages`: the SpotiFLAC PackageService.
 * `helpers`: { findTrack, createGhostTrack } from the playlist IPC.
 * Returns { added, matched, ghosts: [track], total, title }.
 */
async function sync(db, playlistId, { packages, helpers, userId = 'guest' }) {
  ensure(db)
  const row = db.prepare('SELECT * FROM playlist_sync WHERE playlist_id = ?').get(playlistId)
  if (!row) return { error: 'This playlist is not linked to a streaming playlist.' }
  const platform = PLATFORMS.find(p => p.id === row.platform)
  const fail = message => { db.prepare('UPDATE playlist_sync SET error = ? WHERE playlist_id = ?').run(message, playlistId); return { error: message } }
  let result
  if (platform?.id === 'spotify' && helpers.readSpotifyPlaylist) {
    try { result = await helpers.readSpotifyPlaylist(row.url) }
    catch (error) { return fail(error.message) }
  }
  if (!result && platform?.id === 'deezer') {
    try { result = await (helpers.readDeezerPlaylist || require('./deezer').readPlaylist)(row.url) }
    catch (error) { return fail(error.message) }
  } else if (!result && platform?.builtin) {
    // YouTube Music: the same reader as pasting a playlist link to import it.
    let read
    try { read = await helpers.readPlaylist(row.url) } catch (error) { return fail(error.message) }
    if (!read || read.error) return fail(String(read?.error || 'Could not read that YouTube Music playlist.'))
    if (read.truncated) return fail('Only part of this YouTube Music playlist was returned. Retry syncing to load all songs.')
    result = {
      name: read.title,
      tracks: (read.entries || []).map(entry => ({
        id: entry.source_url, name: entry.title, artists: entry.artist || '', album: entry.album,
        duration_ms: entry.duration ? entry.duration * 1000 : null, source_url: entry.source_url,
      })),
    }
  } else if (!result) {
    const addon = addonFor(packages, row.url)
    if (!addon) return fail(`To sync ${platform?.label || 'this'} playlists, install the ${platform?.addon || 'matching'} addon in Settings → Addons.`)
    const runtime = await packages.runtime(addon.key)
    try { result = await runtime.invoke('handleUrl', [row.url], { timeoutMs: 10 * 60 * 1000 }) } catch (error) { return fail(error.message) }
    if (result?.success === false || result?.error) {
      const message = String(result?.error || 'The addon could not read this playlist.')
      return fail(/VERIFY_REQUIRED/i.test(message) ? `${addon.manifest.displayName} needs verifying first: Settings → Addons → Verify access.` : message)
    }
  }
  const collection = result?.playlist || result
  const rawTracks = collection?.tracks
  if (!Array.isArray(rawTracks)) return fail('The playlist reader returned no track list.')
  const expected = Number(collection.total_tracks ?? collection.totalTracks ?? collection.track_count)
  if (collection.truncated || (Number.isFinite(expected) && expected > rawTracks.length + (Number(collection.skipped) || 0))) {
    return fail(`Only ${rawTracks.length} of ${Number.isFinite(expected) ? expected : 'all'} playlist entries were returned. Update the playlist addon or connect Spotify in Settings → Integrations, then sync again.`)
  }
  const remote = rawTracks.filter(track => track && (track.name || track.title))
  if (!remote.length) return fail('The playlist is empty, or the addon could not read its songs.')
  const seen = new Set(JSON.parse(row.seen_json || '[]').map(key => row.platform === 'spotify'
    ? key.replace(/^spotify:spotify:track:/, 'spotify:') : key))
  // Linking a playlist that already has songs: the first sync doesn't add
  // them twice (one remote entry per song already here). After that, the
  // remote ids alone decide what's new, so a second recording or a repeated
  // entry with the same title and artist still arrives.
  const existing = new Map()
  if (!row.synced_at) {
    for (const track of db.prepare('SELECT t.title, t.artist FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ?').all(playlistId)) {
      const key = songKey(track.title, track.artist)
      existing.set(key, (existing.get(key) || 0) + 1)
    }
  }
  const insert = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by, added_at) VALUES (?, ?, ?, ?, ?)')
  let position = Number(db.prepare('SELECT MAX(position) AS m FROM playlist_tracks WHERE playlist_id = ?').get(playlistId)?.m) || 0
  const ghosts = []
  let matched = 0
  for (const track of remote) {
    const artist = Array.isArray(track.artists) ? track.artists.map(a => typeof a === 'string' ? a : a?.name).filter(Boolean).join(', ') : String(track.artists || track.artist || '')
    const title = String(track.name || track.title)
    const remoteId = row.platform === 'spotify' ? String(track.id || '').replace(/^spotify:track:/, '') : track.id
    const key = `${row.platform}:${remoteId || songKey(title, artist)}`
    if (seen.has(key)) continue
    seen.add(key)
    const already = existing.get(songKey(title, artist)) || 0
    if (already) { existing.set(songKey(title, artist), already - 1); continue }
    const entry = { title, artist, album: textOf(track.album_name) || textOf(track.album), duration: Number(track.duration_ms) > 0 ? Math.round(Number(track.duration_ms) / 1000) : null, isrc: track.isrc || null, year: Number(String(track.release_date || '').slice(0, 4)) || null, source_url: track.source_url || null }
    let found = libraryCopy(db, helpers, entry)
    if (found) matched++
    else { found = helpers.createGhostTrack(db, entry, row.platform, playlistId); ghosts.push(found) }
    insert.run(playlistId, found.id, ++position, userId, Date.now())
  }
  const title = String(result?.name || result?.playlist?.name || row.title || '').slice(0, 300) || null
  db.prepare('UPDATE playlist_sync SET seen_json = ?, synced_at = ?, title = ?, error = NULL WHERE playlist_id = ?').run(JSON.stringify([...seen]), Date.now(), title, playlistId)
  return { ok: true, added: matched + ghosts.length, matched, ghosts, total: remote.length,
    unavailable: Number(collection.skipped) || 0, expectedTotal: Number.isFinite(expected) ? expected : remote.length,
    title, firstSync: !row.synced_at }
}

module.exports = { PLATFORMS, platformOf, addonFor, link, unlink, status, linked, sync, readSpotifyPlaylist }
