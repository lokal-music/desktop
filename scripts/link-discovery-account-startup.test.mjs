import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const { createLink } = require('../electron/link')

test('discovery starts after account restoration and restarts after Phone Remote is re-enabled', t => {
  // Use the real schema/capture setup without touching any user database.
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE tracks (id TEXT PRIMARY KEY,file_path TEXT,file_hash TEXT,title TEXT,artist TEXT,album TEXT,album_artist TEXT,duration REAL,genre TEXT,year INTEGER,track_num INTEGER,artwork_url TEXT,source_ref TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE playlists (id TEXT PRIMARY KEY,user_id TEXT,name TEXT,uuid TEXT);
    CREATE TABLE playlist_tracks (id INTEGER PRIMARY KEY,playlist_id TEXT,track_id TEXT,position INTEGER);
    CREATE TABLE user_likes (user_id TEXT,track_id TEXT,liked_at INTEGER);
    CREATE TABLE listening_events (id INTEGER PRIMARY KEY,user_id TEXT,track_id TEXT,event_type TEXT,ended_at INTEGER,created_at INTEGER,seconds_played INTEGER);
    CREATE TABLE users (id TEXT PRIMARY KEY);
  `)
  const server = new EventEmitter()
  const events = new EventEmitter()
  let userId = 'guest', enabled = true, starts = 0, stops = 0
  const link = createLink({ server, db, enabled: () => enabled,
    remote: { events, getRemoteState: () => ({ userId, connected: true }) },
    advertiseDesktop: () => { starts++; return () => { stops++ } },
  })
  t.after(() => { link.close(); db.close() })
  db.prepare('INSERT INTO remote_devices (id,name,token_hash,user_id,created,last_seen,revoked) VALUES (?,?,?,?,?,?,?)').run('phone', 'Phone', 'test-hash', 'owner', 1, 1, 0)
  assert.equal(starts, 0)
  userId = 'owner'
  events.emit('state', { userId })
  assert.equal(starts, 1)
  events.emit('state', { userId })
  assert.equal(starts, 1)
  enabled = false
  events.emit('state', { userId })
  assert.equal(stops, 1)
  enabled = true
  events.emit('state', { userId })
  assert.equal(starts, 2)
})

test('pairing responses include desktop hostname and OS platform for dual-boot disambiguation', async t => {
  const os = require('node:os')
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE tracks (id TEXT PRIMARY KEY,file_path TEXT,file_hash TEXT,title TEXT,artist TEXT,album TEXT,album_artist TEXT,duration REAL,genre TEXT,year INTEGER,track_num INTEGER,artwork_url TEXT,source_ref TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE playlists (id TEXT PRIMARY KEY,user_id TEXT,name TEXT,uuid TEXT);
    CREATE TABLE playlist_tracks (id INTEGER PRIMARY KEY,playlist_id TEXT,track_id TEXT,position INTEGER);
    CREATE TABLE user_likes (user_id TEXT,track_id TEXT,liked_at INTEGER);
    CREATE TABLE listening_events (id INTEGER PRIMARY KEY,user_id TEXT,track_id TEXT,event_type TEXT,ended_at INTEGER,created_at INTEGER,seconds_played INTEGER);
    CREATE TABLE users (id TEXT PRIMARY KEY);
  `)
  const server = new EventEmitter()
  const events = new EventEmitter()
  const link = createLink({
    server,
    db,
    enabled: () => true,
    remote: {
      events,
      getRemoteState: () => ({ userId: 'owner', connected: true }),
      getRemoteConnectionInfo: () => ({
        primary: 'http://192.168.1.178:3421/remote',
        urls: ['http://192.168.1.178:3421/remote'],
      }),
    },
    advertiseDesktop: () => () => {},
  })
  t.after(() => { link.close(); db.close() })
  const created = await link.createPairing()
  assert.equal(created.name, os.hostname())
  assert.equal(created.platform, process.platform)
  const paired = link.pair(
    { code: created.code, deviceId: 'phone_dualboot_1', deviceName: 'Phone' },
    '192.168.1.50',
  )
  assert.equal(paired.desktopId, created.desktopId)
  assert.equal(paired.name, os.hostname())
  assert.equal(paired.platform, process.platform)
})
