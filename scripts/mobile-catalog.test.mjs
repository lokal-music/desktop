import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const { LinkStore } = require('../electron/link/store')

function fixture() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE tracks (
      id TEXT PRIMARY KEY, file_path TEXT, file_hash TEXT, title TEXT, artist TEXT,
      album TEXT, album_artist TEXT, duration REAL, genre TEXT, year INTEGER,
      track_num INTEGER, artwork_url TEXT, source_ref TEXT, download_source TEXT,
      isrc TEXT
    );
    CREATE TABLE playlists (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, uuid TEXT);
    CREATE TABLE playlist_tracks (id INTEGER PRIMARY KEY, playlist_id TEXT, track_id TEXT, position INTEGER);
    CREATE TABLE user_likes (user_id TEXT, track_id TEXT, liked_at INTEGER);
    CREATE TABLE listening_events (id INTEGER PRIMARY KEY, user_id TEXT, track_id TEXT, event_type TEXT, ended_at INTEGER, created_at INTEGER, seconds_played INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `)
  return db
}

test('mobile catalogue skips recordings already present on desktop and stores playable phone-only tracks', () => {
  const db = fixture()
  const store = new LinkStore(db)
  try {
    db.prepare(`INSERT INTO tracks
      (id,file_path,file_hash,title,artist,album,duration,download_source)
      VALUES (?,?,?,?,?,?,?,NULL)`).run('local-1', '/music/Already Here.flac', 'local-hash', 'Already Here', 'Artist A', 'Album', 201)
    db.prepare(`INSERT INTO tracks
      (id,file_path,file_hash,title,artist,album,duration,download_source)
      VALUES (?,?,?,?,?,?,?,?)`).run('history-ghost', 'ghost://link/old-history', 'history-hash', 'Previously Played', 'Artist C', 'Old Album', 222, 'mobile')
    const snapshot = 'snapshot_12345678'
    const device = 'phone_device_123'
    store.beginMobileCatalog({ device_id: device, snapshot_id: snapshot }, 'owner', device)
    const accepted = store.applyMobileCatalog([
      {
        song_id: 'song_001', title: 'Already Here', artist: 'Artist A',
        album: 'Album', duration: 201,
        stream_url: 'http://192.168.1.50:45678/opaque-token',
      },
      {
        song_id: 'song_002', title: 'Phone Only', artist: 'Artist B',
        album: 'Phone Album', duration: 183,
        stream_url: 'http://192.168.1.50:45678/another-token',
      },
      {
        song_id: 'song_003', title: 'Previously Played', artist: 'Artist C',
        album: 'Old Album', duration: 222,
        stream_url: 'http://192.168.1.50:45678/third-token',
      },
    ], { device_id: device, snapshot_id: snapshot }, 'owner', device)
    assert.equal(accepted, 2)
    const phone = db.prepare("SELECT * FROM tracks WHERE file_path LIKE 'ghost://mobile/%'").get()
    assert.equal(phone.title, 'Phone Only')
    assert.equal(phone.download_source, 'mobile')
    assert.equal(db.prepare('SELECT stream_url FROM link_mobile_catalog WHERE track_id=?').get(phone.id).stream_url,
      'http://192.168.1.50:45678/another-token')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE title='Already Here'").get().n, 1)
    const reused = db.prepare("SELECT * FROM tracks WHERE id='history-ghost'").get()
    assert.ok(reused.file_path.startsWith('ghost://mobile/'))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM link_mobile_catalog WHERE track_id=?').get('history-ghost').n, 1)
    store.finishMobileCatalog({ device_id: device, snapshot_id: snapshot, count: 3 }, 'owner', device)
  } finally {
    db.close()
  }
})

test('mobile catalogue rejects public or non-HTTP stream endpoints', () => {
  const db = fixture()
  const store = new LinkStore(db)
  try {
    const snapshot = 'snapshot_87654321'
    const device = 'phone_device_123'
    store.beginMobileCatalog({ device_id: device, snapshot_id: snapshot }, 'owner', device)
    assert.throws(() => store.applyMobileCatalog([{
      song_id: 'song_003', title: 'Unsafe', artist: 'Artist',
      duration: 100, stream_url: 'https://example.com/audio.flac',
    }], { device_id: device, snapshot_id: snapshot }, 'owner', device), /private LAN address/)
  } finally {
    db.close()
  }
})
