import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createMobileCatalog } = require('../electron/link/mobileCatalog.js')
globalThis.localStorage = { getItem: () => null, setItem() {} }

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.transaction = fn => () => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  db.exec(`
    CREATE TABLE tracks (
      id TEXT PRIMARY KEY, file_path TEXT UNIQUE, file_hash TEXT, title TEXT,
      artist TEXT, album TEXT, duration REAL, source_ref TEXT, artwork_url TEXT,
      download_source TEXT, album_artist TEXT, track_num INTEGER,
      disc_num INTEGER, year INTEGER, genre TEXT
    );
  `)
  const store = {
    matchTrack(fields) {
      return db.prepare('SELECT * FROM tracks WHERE lower(title)=lower(?) AND lower(artist)=lower(?) AND abs(duration-?)<=2 LIMIT 1')
        .get(fields.title, fields.artist, fields.duration) || null
    },
    ensureTrack(fields, key) {
      const id = 'link_' + Buffer.from(key).toString('hex').slice(0, 24)
      db.prepare('INSERT OR IGNORE INTO tracks (id,file_path,file_hash,title,artist,album,duration,artwork_url) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, 'ghost://link/' + id, id, fields.title, fields.artist, fields.album, fields.duration, fields.artwork_url)
      return db.prepare('SELECT * FROM tracks WHERE id=?').get(id)
    },
  }
  const catalog = createMobileCatalog(db, store)
  const page = (snapshot_id, items, { page = 0, pages = 1, complete = true } = {}) =>
    catalog.accept({ userId: 'owner', deviceId: 'phone', body: { snapshot_id, items, page, pages, complete } })
  return { db, page }
}

const song = { title: 'Affection', artist: 'Boys Noize, ABRA', album: 'Affection', album_artist: 'Boys Noize', track_num: 2, disc_num: 1, year: 2024, genre: 'Electronic', duration: 180 }

test('mobile-only songs become metadata rows resolved via PC sources and repeated snapshots do not duplicate them', () => {
  const f = fixture()
  try {
    f.page('snapshot_0001', [song])
    f.page('snapshot_0002', [song])
    const tracks = f.db.prepare('SELECT * FROM tracks').all()
    assert.equal(tracks.length, 1)
    assert.equal(tracks[0].file_path, 'ghost://mobile/' + tracks[0].id)
    assert.equal(tracks[0].download_source, 'mobile')
    assert.equal(tracks[0].album_artist, 'Boys Noize')
    assert.equal(tracks[0].track_num, 2)
    assert.equal(tracks[0].disc_num, 1)
    assert.equal(tracks[0].year, 2024)
    assert.equal(tracks[0].genre, 'Electronic')
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM link_mobile_catalog').get().n, 1)
  } finally { f.db.close() }
})

test('mobile-only songs appear in default Library track queries and Mobile source filter', () => {
  const { trackFileFilter, isLibraryVisibleTrack } = require('../electron/libraryTracks.js')
  const { listTracks } = require('../electron/trackErrors.js')
  const f = fixture()
  try {
    f.db.prepare('INSERT INTO tracks (id,file_path,title,artist,album,duration) VALUES (?,?,?,?,?,?)')
      .run('local-copy', '/Music/local.flac', 'Local Song', 'Local Artist', 'Album', 200)
    f.db.prepare('INSERT INTO tracks (id,file_path,title,artist,album,duration) VALUES (?,?,?,?,?,?)')
      .run('imported-ghost', 'ghost://spotify/import/1', 'Imported', 'Artist', 'Album', 210)
    f.page('snapshot_0001', [song])

    const allWhere = [trackFileFilter(undefined, f.db)]
    const allRows = listTracks(f.db, { sort: 'title ASC' }, { where: allWhere, params: [], exists: () => true })
    assert.deepEqual(allRows.map(r => r.title), ['Affection', 'Local Song'])
    assert.equal(allRows.every(isLibraryVisibleTrack), true)
    assert.equal(allRows.find(r => r.title === 'Affection')?.mobile_catalog, true)
  } finally { f.db.close() }
})

test('an existing desktop recording is reused instead of creating a mobile duplicate', () => {
  const f = fixture()
  try {
    f.db.prepare('INSERT INTO tracks (id,file_path,title,artist,album,duration) VALUES (?,?,?,?,?,?)')
      .run('desktop-copy', '/Music/affection.flac', song.title, song.artist, song.album, song.duration)
    f.page('snapshot_0001', [song])
    const rows = f.db.prepare('SELECT * FROM tracks').all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'desktop-copy')
    assert.equal(rows[0].file_path, '/Music/affection.flac')
    assert.equal(rows[0].download_source, null)
  } finally { f.db.close() }
})

test('an already-resolved online stream is reused on subsequent phone snapshots without duplicating', () => {
  const f = fixture()
  try {
    f.page('snapshot_0001', [song])
    const initialId = f.db.prepare('SELECT id FROM tracks').get().id
    f.db.prepare('INSERT INTO tracks (id,file_path,title,artist,album,duration) VALUES (?,?,?,?,?,?)')
      .run('yt-resolved', 'ghost://youtube/online/abc12345678', song.title, song.artist, song.album, song.duration)
    f.db.prepare('UPDATE link_mobile_catalog SET track_id=? WHERE track_id=?').run('yt-resolved', initialId)
    f.db.prepare('DELETE FROM tracks WHERE id=?').run(initialId)

    f.page('snapshot_0002', [song])
    const rows = f.db.prepare('SELECT * FROM tracks').all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'yt-resolved')
    assert.equal(f.db.prepare('SELECT track_id FROM link_mobile_catalog').get().track_id, 'yt-resolved')
  } finally { f.db.close() }
})

test('only a complete snapshot or device revocation retires songs removed from the phone', () => {
  const f = fixture()
  try {
    f.page('snapshot_0001', [song])
    const id = f.db.prepare('SELECT id FROM tracks').get().id
    f.page('snapshot_partial', [], { complete: false })
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM link_mobile_catalog').get().n, 1)
    f.page('snapshot_0002', [])
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM link_mobile_catalog').get().n, 0)
    const retired = f.db.prepare('SELECT file_path,download_source FROM tracks WHERE id=?').get(id)
    assert.equal(retired.file_path, 'ghost://link/' + id)
    assert.equal(retired.download_source, null)
  } finally { f.db.close() }
})

test('new phone catalogue rows enter the desktop online-provider resolution flow rather than direct phone streaming', async () => {
  const { isMobileLinkedTrack } = await import('../src/mobileLinkedTracks.js')
  const { isPlayable, streamRef, audioSrcFor } = await import('../src/onlineTracks.js')
  const track = { id: 'link_phone', file_path: 'ghost://mobile/link_phone', title: song.title, artist: song.artist }
  assert.equal(isMobileLinkedTrack(track), true)
  assert.equal(isPlayable(track), false, 'metadata placeholder is not mistaken for a ready stream')
  assert.equal(streamRef(track), null, 'playback resolves via this PC configured online sources, not a phone URL')
  assert.equal(audioSrcFor(track), null)
})

