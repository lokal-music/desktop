import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { resolveMobileLinkedTracks, isMobileLinkedTrack } from '../src/mobileLinkedTracks.js'
import { isPlayable, saveToLibrary, streamRef } from '../src/onlineTracks.js'
import { api } from '../src/api.js'
const require = createRequire(import.meta.url)
const { sameRecording } = require('../electron/recordingIdentity.js')

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
const mobile = { id: 'link_phone', file_path: 'ghost://link/link_phone',
  title: 'Affection', artist: 'Boys Noize, ABRA', album: 'Affection', duration: 180,
  download_source: 'mobile', source_ref: 'phone-only:secret',
  source_url: 'https://phone.invalid/audio?token=private' }
const addon = 'a-0123456789'
const stream = { id: 'addon_pc', file_path: 'ghost://addon/0123456789/recording',
  title: mobile.title, artist: mobile.artist, album: mobile.album, duration: 180 }

function database() {
  const db = new DatabaseSync(':memory:')
  db.transaction = fn => () => {
    db.exec('BEGIN IMMEDIATE')
    try { const value = fn(); db.exec('COMMIT'); return value }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  db.exec(`
    CREATE TABLE tracks(id TEXT PRIMARY KEY, file_path TEXT, title TEXT, artist TEXT, album TEXT, duration REAL);
    CREATE TABLE track_aliases(old_id TEXT PRIMARY KEY, track_id TEXT);
    CREATE TABLE link_track_aliases(track_key TEXT PRIMARY KEY, track_id TEXT);
    CREATE TABLE listening_events(id TEXT PRIMARY KEY, track_id TEXT);
    CREATE TABLE playlist_tracks(id TEXT PRIMARY KEY, playlist_id TEXT, track_id TEXT);
    CREATE TABLE user_likes(user_id TEXT, track_id TEXT, PRIMARY KEY(user_id,track_id));
    CREATE TABLE play_history(id TEXT PRIMARY KEY, track_id TEXT, seconds_played INTEGER);
    CREATE TABLE lyrics_cache(track_id TEXT);
    CREATE TABLE lyrics_translations(track_id TEXT);
    CREATE TABLE artist_track_links(track_id TEXT);
  `)
  const add = track => db.prepare('INSERT INTO tracks VALUES(?,?,?,?,?,?)')
    .run(track.id, track.file_path, track.title, track.artist, track.album || null, track.duration || 0)
  add(mobile); add(stream)
  db.prepare('INSERT INTO user_likes VALUES(?,?)').run('owner', mobile.id)
  db.prepare('INSERT INTO user_likes VALUES(?,?)').run('another-user', mobile.id)
  db.prepare('INSERT INTO playlist_tracks VALUES(?,?,?)').run('one', 'playlist', mobile.id)
  db.prepare('INSERT INTO play_history VALUES(?,?,?)').run('play', mobile.id, 85)
  db.prepare('INSERT INTO link_track_aliases VALUES(?,?)').run('phone-recording', mobile.id)
  db.prepare('INSERT INTO listening_events VALUES(?,?)').run('qualified', mobile.id)
  const source = readFileSync(new URL('../server/routes/playlists.js', import.meta.url), 'utf8')
  const code = source.slice(source.indexOf('function resolveGhostTrack('), source.indexOf('\nfunction importExternalMetadata'))
  const resolve = vm.runInNewContext(code + '; resolveGhostTrack', {
    applyImportedMetadata() {},
    require: name => name.includes('recordingIdentity') ? { sameRecording } : {
      streamRef: track => /^ghost:\/\/(?:youtube\/online\/|addon\/)/.test(track?.file_path || '') ? { provider: addon, id: 'recording' } : null,
    },
  })
  return { db, add, bind: (from, to, options) => resolve(db, from, to, null, options) }
}

function client(fixture, overrides = {}) {
  const searched = [], bindings = []
  return {
    searched, bindings,
    getSettings: async () => ({ playback_search_order: JSON.stringify([addon, 'yt']) }),
    onlineProviders: async () => [{ id: addon, label: 'Desktop addon', addon: true }, { id: 'yt' }],
    searchTracks: async () => [],
    onlineSearch: async (query, provider) => {
      searched.push(provider)
      return { results: [{ id: 'recording', title: mobile.title, artist: mobile.artist, album: mobile.album, duration: 180 }] }
    },
    onlinePrepare: async () => ({ ok: true }),
    onlineSave: async () => [stream],
    resolveGhostTrack: async (from, to, options) => {
      bindings.push({ from, to, options })
      return fixture.bind(from, to, options)
    },
    ...overrides,
  }
}

test('mobile likes use desktop provider priority and retain likes, history and playlists', async () => {
  const fixture = database()
  try {
    const c = client(fixture)
    assert.equal(isPlayable(mobile), false, 'metadata is never advertised as an audio file')
    const [found] = await resolveMobileLinkedTracks([mobile], c, { prepareStreams: false })
    assert.equal(found.id, stream.id)
    assert.deepEqual(c.searched, [addon])
    assert.equal(c.bindings[0].options.resolveMobileStream, true)
    assert.equal(fixture.db.prepare('SELECT track_id FROM play_history').get().track_id, stream.id)
    assert.equal(fixture.db.prepare('SELECT track_id FROM playlist_tracks').get().track_id, stream.id)
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM user_likes WHERE track_id=?').get(stream.id).n, 2)
    assert.equal(fixture.db.prepare('SELECT * FROM tracks WHERE id=?').get(mobile.id), undefined)
    assert.equal(fixture.db.prepare('SELECT track_id FROM track_aliases WHERE old_id=?').get(mobile.id).track_id, stream.id)
    assert.equal(fixture.bind(mobile.id, stream.id, { resolveMobileStream: true }).ok, true, 'repeated lookup is idempotent')
    assert.equal(fixture.db.prepare('SELECT track_id FROM link_track_aliases').get().track_id, stream.id)
    assert.equal(fixture.db.prepare('SELECT track_id FROM listening_events').get().track_id, stream.id)
    const previousLink = api.onlineDownloadUrl, previousDownload = api.downloadYT
    const downloads = []
    api.onlineDownloadUrl = async () => ({ url: 'https://desktop-addon.invalid/full.flac' })
    api.downloadYT = async (url, options) => { downloads.push({ url, options }); return { downloadId: 'download' } }
    try {
      await saveToLibrary(found)
      assert.equal(downloads[0].options.replaceTrackId, stream.id, 'the ordinary downloader now replaces the row holding the mobile like/history')
      assert.deepEqual(downloads[0].options.addonSource, { provider: addon, id: 'recording' })
    } finally { api.onlineDownloadUrl = previousLink; api.downloadYT = previousDownload }
    // The completed download must collapse the whole alias chain, not strand
    // the original phone ID on the now-deleted intermediate streaming row.
    fixture.add({ ...stream, id: 'downloaded', file_path: '/Music/affection.flac' })
    assert.equal(fixture.bind(stream.id, 'downloaded', { requireMetadataMatch: true }).ok, true)
    assert.equal(fixture.db.prepare('SELECT track_id FROM track_aliases WHERE old_id=?').get(mobile.id).track_id, 'downloaded')
    assert.equal(fixture.db.prepare('SELECT track_id FROM link_track_aliases').get().track_id, 'downloaded')
    assert.equal(fixture.db.prepare('SELECT track_id FROM listening_events').get().track_id, 'downloaded')
  } finally { fixture.db.close() }
})

test('mobile-only catalogue rows resolve through this PC configured online providers and keep their catalogue link', async () => {
  const fixture = database()
  try {
    fixture.db.exec('CREATE TABLE link_mobile_catalog(user_id TEXT, device_id TEXT, track_key TEXT, track_id TEXT, snapshot_id TEXT, updated_at INTEGER, PRIMARY KEY(user_id, device_id, track_key))')
    fixture.db.prepare('UPDATE tracks SET file_path=? WHERE id=?').run('ghost://mobile/link_phone', mobile.id)
    fixture.db.prepare('INSERT INTO link_mobile_catalog VALUES(?,?,?,?,?,?)').run('owner', 'phone-1', 'phone-recording', mobile.id, 'snap_1', 1000)
    const catalogue = { ...mobile, id: 'link_phone', file_path: 'ghost://mobile/link_phone' }
    assert.equal(isMobileLinkedTrack(catalogue), true)
    assert.equal(isPlayable(catalogue), false)
    assert.equal(streamRef(catalogue), null, 'there is no direct phone audio URL')
    const c = client(fixture)
    const [found] = await resolveMobileLinkedTracks([catalogue], c, { prepareStreams: false })
    assert.equal(found.id, stream.id)
    assert.deepEqual(c.searched, [addon], 'resolution follows the PC configured provider order')
    assert.equal(fixture.db.prepare('SELECT track_id FROM link_mobile_catalog WHERE device_id=?').get('phone-1').track_id, stream.id, 'catalogue association follows the resolved PC stream')
  } finally { fixture.db.close() }
})

test('local copies are preferred without searching online', async () => {
  const fixture = database()
  try {
    const local = { ...stream, id: 'local', file_path: '/Music/affection.flac' }
    fixture.add(local)
    const c = client(fixture, { searchTracks: async () => [local] })
    const [found] = await resolveMobileLinkedTracks([mobile], c)
    assert.equal(found.id, local.id)
    assert.deepEqual(c.searched, [])
    assert.equal(fixture.db.prepare('SELECT track_id FROM user_likes LIMIT 1').get().track_id, local.id)
  } finally { fixture.db.close() }
})

test('unavailable or cancelled desktop lookup never erases the mobile like', async () => {
  for (const cancelled of [false, true]) {
    const fixture = database()
    try {
      let current = true
      const c = client(fixture)
      const rows = await resolveMobileLinkedTracks([mobile], c, {
        isCurrent: () => current,
        resolve: async candidates => {
          assert.deepEqual(Object.keys(candidates[0]).sort(), ['album', 'artist', 'artwork_url', 'duration', 'genre', 'isrc', 'title', 'year'])
          if (cancelled) current = false
          return cancelled ? [stream] : []
        },
      })
      assert.deepEqual(rows, [])
      assert.equal(c.bindings.length, 0)
      assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM user_likes WHERE track_id=?').get(mobile.id).n, 2)
    } finally { fixture.db.close() }
  }
})

test('stream linking rejects wrong recordings, wrong lengths and ordinary ghost targets', () => {
  const fixture = database()
  try {
    for (const track of [
      { ...stream, id: 'wrong-title', title: 'Affection (Live)' },
      { ...stream, id: 'wrong-length', duration: 300 },
      { ...stream, id: 'not-playable', file_path: 'ghost://import/unknown' },
      { ...stream, id: 'no-path', file_path: null },
    ]) {
      fixture.add(track)
      assert.notEqual(fixture.bind(mobile.id, track.id, {
        resolveMobileStream: true, allowDurationMismatch: true,
      }).ok, true)
    }
    assert.notEqual(fixture.bind(mobile.id, mobile.id, { resolveMobileStream: true }).ok, true)
    const imported = { ...mobile, id: 'csv', file_path: 'ghost://csv/song' }
    fixture.add(imported)
    assert.notEqual(fixture.bind(imported.id, stream.id, { resolveMobileStream: true }).ok, true)
    assert.notEqual(fixture.bind(mobile.id, stream.id, {}).ok, true)
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM user_likes WHERE track_id=?').get(mobile.id).n, 2)
  } finally { fixture.db.close() }
})

test('mixed queues reuse files/streams and only resolve mobile metadata', async () => {
  const fixture = database()
  try {
    const local = { id: 'file', file_path: '/Music/local.flac' }
    const online = { ...stream, id: 'online' }
    const c = client(fixture)
    const rows = await resolveMobileLinkedTracks([local, mobile, online], c, { prepareStreams: false })
    assert.deepEqual(rows.map(track => track.id), ['file', stream.id, 'online'])
    assert.equal(c.bindings.length, 1)
    assert.equal(isMobileLinkedTrack({ ...mobile, file_path: 'ghost://spotify/abc' }), false)
    assert.equal(isMobileLinkedTrack({ ...mobile, artist: '' }), false)
  } finally { fixture.db.close() }
})
