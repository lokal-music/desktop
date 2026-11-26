import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createMobileCatalog } = require('../electron/link/mobileCatalog.js')

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
      download_source TEXT
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

const song = { title: 'Affection', artist: 'Boys Noize, ABRA', album: 'Affection', duration: 180 }

test('mobile-only songs become streamable metadata rows and repeated snapshots do not duplicate them', () => {
  const f = fixture()
  try {
    f.page('snapshot_0001', [song])
    f.page('snapshot_0002', [song])
    const tracks = f.db.prepare('SELECT * FROM tracks').all()
    assert.equal(tracks.length, 1)
    assert.equal(tracks[0].file_path, 'ghost://mobile/' + tracks[0].id)
    assert.equal(tracks[0].download_source, 'mobile')
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM link_mobile_catalog').get().n, 1)
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

test('only a complete snapshot retires songs removed from the phone', () => {
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
