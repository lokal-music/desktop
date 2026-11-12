import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const sync = require('../electron/playlists/sync')

function setup(remote) {
  const db = new Database(':memory:')
  db.exec("CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT, artist TEXT, file_path TEXT); CREATE TABLE playlist_tracks (playlist_id TEXT, track_id TEXT, position INTEGER, added_by TEXT, added_at INTEGER)")
  db.prepare("INSERT INTO playlists VALUES ('p1', 'Mine')").run()
  db.prepare("INSERT INTO tracks VALUES ('local-1', 'Owned', 'Band', '/music/owned.flac')").run()
  const addon = { key: 'abcdef0123', enabled: 1, manifest: { displayName: 'Spotify Web', urlHandler: { enabled: true, patterns: ['open.spotify.com', 'spotify:'] } } }
  const packages = { list: () => [addon], find: () => addon, runtime: async () => ({ invoke: async () => ({ type: 'playlist', name: 'Theirs', tracks: remote.list }) }) }
  let n = 0
  const helpers = {
    findTrack: (database, entry) => database.prepare("SELECT id FROM tracks WHERE LOWER(title) = ? AND file_path NOT LIKE 'ghost://%'").get(entry.title.toLowerCase()),
    createGhostTrack: (database, entry) => { const id = `g-${++n}`; database.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?)').run(id, entry.title, entry.artist, `ghost://spotify/p1/${id}`); return { id, title: entry.title, artist: entry.artist } },
  }
  return { db, packages, helpers }
}
const songs = db => db.prepare('SELECT t.title FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id ORDER BY position').all().map(r => r.title)

test('a linked Spotify playlist recovers the remaining 700 of 1900 songs without repeating the first 1200', async t => {
  const all = Array.from({ length: 1900 }, (_, n) => ({ id: String(n).padStart(22, '0'), name: `Song ${n}`, artists: 'Band' }))
  const { db, packages, helpers } = setup({ list: all.slice(0, 1200) })
  t.after(() => db.close())
  const url = `https://open.spotify.com/playlist/${'P'.repeat(22)}`
  sync.link(db, 'p1', url)
  assert.equal((await sync.sync(db, 'p1', { packages, helpers })).added, 1200)
  packages.runtime = async () => { throw new Error('The addon preview must not be read again') }
  helpers.readSpotifyPlaylist = link => sync.readSpotifyPlaylist(link, { cookie: 'test-cookie', read: async (cookie, uri, options) => {
    assert.equal(cookie, 'test-cookie')
    assert.equal(uri, `spotify:playlist:${'P'.repeat(22)}`)
    assert.equal(options.max, null)
    return { title: 'Complete playlist', total: 1900, tracks: all.map(track => ({
      spotifyUri: `spotify:track:${track.id}`, title: track.name, artist: 'Band', duration: 200,
    })) }
  } })
  const recovered = await sync.sync(db, 'p1', { packages, helpers })
  assert.equal(recovered.added, 700)
  assert.equal(recovered.total, 1900)
  assert.equal(songs(db).length, 1900)
  assert.equal((await sync.sync(db, 'p1', { packages, helpers })).added, 0)
  assert.equal(songs(db).length, 1900)
})

test('an explicitly incomplete addon playlist never records a successful partial sync', async t => {
  const { db, packages, helpers } = setup({ list: [] })
  t.after(() => db.close())
  sync.link(db, 'p1', 'https://open.spotify.com/playlist/xyz')
  packages.runtime = async () => ({ invoke: async () => ({ total_tracks: 1900, tracks: Array.from({ length: 1200 }, (_, n) => ({ id: n, name: `Song ${n}` })) }) })
  const result = await sync.sync(db, 'p1', { packages, helpers })
  assert.match(result.error, /1200 of 1900/)
  assert.equal(songs(db).length, 0)
  assert.equal(sync.status(db, 'p1').syncedAt, null)
  assert.equal(db.prepare('SELECT seen_json FROM playlist_sync').get().seen_json, '[]')
})

test('Spotify read failures preserve existing songs and sync position rather than falling back to a partial addon', async t => {
  const { db, packages, helpers } = setup({ list: [{ id: 'seen', name: 'Owned', artists: 'Band' }] })
  t.after(() => db.close())
  sync.link(db, 'p1', `https://open.spotify.com/playlist/${'P'.repeat(22)}`)
  await sync.sync(db, 'p1', { packages, helpers })
  const before = db.prepare('SELECT seen_json,synced_at FROM playlist_sync').get()
  helpers.readSpotifyPlaylist = async () => { throw new Error('Spotify stopped before loading all playlist tracks.') }
  assert.match((await sync.sync(db, 'p1', { packages, helpers })).error, /before loading all/)
  assert.deepEqual(db.prepare('SELECT seen_json,synced_at FROM playlist_sync').get(), before)
  assert.deepEqual(songs(db), ['Owned'])
})

test('truncated YouTube Music reads do not mark a partial playlist synced', async t => {
  const { db, packages, helpers } = setup({ list: [] })
  t.after(() => db.close())
  sync.link(db, 'p1', 'https://music.youtube.com/playlist?list=PLabc')
  helpers.readPlaylist = async () => ({ truncated: true, entries: [{ title: 'Song', source_url: 'https://music.youtube.com/watch?v=abcdefghijk' }] })
  assert.match((await sync.sync(db, 'p1', { packages, helpers })).error, /Only part/)
  assert.equal(songs(db).length, 0)
})

// Exercise the registered IPC handlers used by both launch and manual sync.
// Resolve the actual package module path before replacing its external runtime.
function ipcHandlers(db, packages, readPlaylist) {
  const file = new URL('../electron/ipc/playlists.js', import.meta.url)
  const ipcRequire = createRequire(file)
  const handlers = new Map()
  const module = { exports: {} }
  vm.runInNewContext(readFileSync(file, 'utf8'), {
    module, exports: module.exports, console, URL,
    require: id => {
      if (id === 'electron') return { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } }
      if (id === './db') return { getDB: () => db }
      if (id.endsWith('/packages')) {
        assert.equal(ipcRequire.resolve(id), ipcRequire.resolve('../mornye/packages'))
        return { service: database => { assert.equal(database, db); return packages } }
      }
      if (id === '../playlists/linkImport') return { fetchPlaylist: readPlaylist }
      if (id === './tools') return { findYtDlp: () => 'fixture-ytdlp' }
      if (id === './downloader') return { manager: () => ({ settings: () => ({}) }) }
      return ipcRequire(id)
    },
  }, { filename: file.pathname })
  module.exports.registerPlaylistHandlers()
  return (name, ...args) => handlers.get(`playlist:${name}`)(null, ...args)
}

for (const platform of ['spotify', 'youtube-music']) {
  test(`startup IPC resumes an existing ${platform} sync without resetting saved history`, async t => {
    const { db, packages } = setup({ list: [
      { id: 'seen', name: 'Owned', artists: 'Band' },
      { id: 'new', name: 'Owned', artists: 'Band' },
    ] })
    t.after(() => db.close())
    const url = platform === 'spotify' ? 'https://open.spotify.com/playlist/xyz' : 'https://music.youtube.com/playlist?list=PLabc'
    // Persisted pre-rename schema and keys: no relinking or migration needed.
    sync.ensure // Table creation is exercised via link, then seed saved state.
    sync.link(db, 'p1', url)
    db.prepare('UPDATE playlist_sync SET synced_at=?, title=?, seen_json=?, error=? WHERE playlist_id=?')
      .run(123, 'Saved title', JSON.stringify([`${platform}:seen`]), 'Previous failure', 'p1')
    db.prepare('INSERT INTO playlist_tracks VALUES (?, ?, ?, ?, ?)').run('p1', 'local-1', 1, 'original-user', 100)
    let reads = 0
    const invoke = ipcHandlers(db, packages, async options => {
      reads++
      assert.equal(options.url, url)
      return { title: 'Theirs', entries: ['seen', 'new'].map(source_url => ({ source_url, title: 'Owned', artist: 'Band' })) }
    })
    assert.deepEqual(Array.from(invoke('syncLinked')), ['p1'])
    assert.equal(invoke('syncStatus', 'p1').syncedAt, 123)
    const result = await invoke('sync', 'p1', 'current-user')
    assert.equal(result.error, undefined)
    assert.equal(result.added, 1)
    assert.equal(result.firstSync, false)
    assert.equal((await invoke('sync', 'p1', 'current-user')).added, 0)
    assert.deepEqual(songs(db), ['Owned', 'Owned'])
    const row = db.prepare('SELECT * FROM playlist_sync WHERE playlist_id=?').get('p1')
    assert.equal(row.url, url)
    assert.equal(row.platform, platform)
    assert.equal(row.error, null)
    assert.deepEqual(JSON.parse(row.seen_json), [`${platform}:seen`, `${platform}:new`])
    assert.deepEqual(db.prepare('SELECT added_by, added_at FROM playlist_tracks ORDER BY position').all(), [
      { added_by: 'original-user', added_at: 100 },
      { added_by: 'current-user', added_at: db.prepare('SELECT added_at FROM playlist_tracks WHERE position=2').get().added_at },
    ])
    assert.equal(reads, platform === 'youtube-music' ? 2 : 0)
  })
}

test('linking accepts streaming playlist links only', () => {
  const { db } = setup({ list: [] })
  assert.ok(sync.link(db, 'p1', 'https://example.com/playlist/1').error)
  assert.ok(sync.link(db, 'p1', 'https://open.spotify.com/album/1').error)
  assert.equal(sync.link(db, 'p1', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M').platformLabel, 'Spotify')
})

test('sync adds only new songs, library copies first, and never removes', async () => {
  const remote = { list: [{ id: 'a', name: 'Owned', artists: 'Band', duration_ms: 200000 }, { id: 'b', name: 'Missing', artists: 'Other' }] }
  const { db, packages, helpers } = setup(remote)
  sync.link(db, 'p1', 'https://open.spotify.com/playlist/xyz')
  const first = await sync.sync(db, 'p1', { packages, helpers })
  assert.equal(first.added, 2); assert.equal(first.matched, 1); assert.equal(first.ghosts.length, 1)
  assert.deepEqual(songs(db), ['Owned', 'Missing'])
  // Removed there, and one removed here: neither comes back nor goes.
  db.prepare("DELETE FROM playlist_tracks WHERE track_id = 'local-1'").run()
  remote.list = [{ id: 'a', name: 'Owned', artists: 'Band' }, { id: 'c', name: 'Fresh', artists: 'New' }]
  const second = await sync.sync(db, 'p1', { packages, helpers })
  assert.equal(second.added, 1)
  assert.deepEqual(songs(db), ['Missing', 'Fresh'])
  assert.equal(sync.status(db, 'p1').title, 'Theirs')
})

test('a link no installed addon reads says which addon to install', async () => {
  const { db, helpers } = setup({ list: [] })
  sync.link(db, 'p1', 'https://tidal.com/browse/playlist/abc')
  const result = await sync.sync(db, 'p1', { packages: { list: () => [], find: () => null }, helpers })
  assert.match(result.error, /install the Tidal addon/)
})

test('after the first sync, a new remote id is added even when its title and artist match a song already here', async () => {
  const remote = { list: [{ id: 'a', name: 'Owned', artists: 'Band' }] }
  const { db, packages, helpers } = setup(remote)
  sync.link(db, 'p1', 'https://open.spotify.com/playlist/xyz')
  await sync.sync(db, 'p1', { packages, helpers })
  remote.list = [{ id: 'a', name: 'Owned', artists: 'Band' }, { id: 'a-live', name: 'Owned', artists: 'Band' }]
  const second = await sync.sync(db, 'p1', { packages, helpers })
  assert.equal(second.added, 1)
  assert.deepEqual(songs(db), ['Owned', 'Owned'])
})

test('a partial artist match is not taken as the library copy, and album objects are stored as their title', async () => {
  const remote = { list: [{ id: 'x', name: 'Owned', artists: 'Ban', album: { name: 'Record' } }] }
  const { db, packages, helpers } = setup(remote)
  // findTrack here matches on title alone, like the real one's partial artist match.
  const entries = []
  const create = helpers.createGhostTrack
  helpers.createGhostTrack = (database, entry, ...rest) => { entries.push(entry); return create(database, entry, ...rest) }
  sync.link(db, 'p1', 'https://open.spotify.com/playlist/xyz')
  const result = await sync.sync(db, 'p1', { packages, helpers })
  assert.equal(result.matched, 0)
  assert.equal(result.ghosts.length, 1)
  assert.equal(entries[0].album, 'Record')
})

test('YouTube Music playlists sync without an addon, through the built-in reader', async () => {
  const { db, helpers } = setup({ list: [] })
  assert.equal(sync.link(db, 'p1', 'https://music.youtube.com/playlist?list=PLabc').platform, 'youtube-music')
  const entries = [{ title: 'Song A', artist: 'Artist', album: 'Album', duration: 200, source_url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }]
  helpers.readPlaylist = async () => ({ title: 'My mix', entries })
  const created = []
  const create = helpers.createGhostTrack
  helpers.createGhostTrack = (database, entry, ...rest) => { created.push(entry); return create(database, entry, ...rest) }
  const first = await sync.sync(db, 'p1', { packages: { list: () => [], find: () => null }, helpers })
  assert.equal(first.added, 1)
  assert.equal(first.title, 'My mix')
  assert.equal(created[0].source_url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa')
  entries.push({ title: 'Song B', artist: 'Artist', duration: 180, source_url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' })
  const second = await sync.sync(db, 'p1', { packages: { list: () => [], find: () => null }, helpers })
  assert.equal(second.added, 1)
})

test('Deezer sync uses its built-in reader without packages and remembers seen IDs', async t => {
  const { db, helpers } = setup({ list: [] })
  t.after(() => db.close())
  assert.equal(sync.link(db, 'p1', 'https://www.deezer.com/fr/playlist/123').platform, 'deezer')
  let tracks = [{ id: 1, name: 'Owned', artists: 'Band' }]
  helpers.readDeezerPlaylist = async url => {
    assert.equal(url, 'https://www.deezer.com/playlist/123')
    return { name: 'Deezer mix', tracks }
  }
  const packages = { list: () => { throw new Error('Deezer needs no addon') } }
  assert.equal((await sync.sync(db, 'p1', { packages, helpers })).added, 1)
  assert.equal((await sync.sync(db, 'p1', { packages, helpers })).added, 0)
  tracks = [...tracks, { id: 2, name: 'Fresh', artists: 'Other' }]
  assert.equal((await sync.sync(db, 'p1', { packages, helpers })).added, 1)
  assert.deepEqual(songs(db), ['Owned', 'Fresh'])
  const before = db.prepare('SELECT seen_json FROM playlist_sync').get().seen_json
  helpers.readDeezerPlaylist = async () => { throw new Error('Deezer unavailable') }
  assert.match((await sync.sync(db, 'p1', { packages, helpers })).error, /unavailable/)
  assert.equal(db.prepare('SELECT seen_json FROM playlist_sync').get().seen_json, before)
})
