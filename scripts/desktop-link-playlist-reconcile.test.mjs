import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { diffPlaylistSnapshots, snapshotFromJournal } = require('../electron/link/reconcile.js')
const { createLinkedLibraryRefresh } = require('../electron/link/libraryRefresh.js')

const member = (key, position) => ({
  track_key: key, position, title: key, artist: 'Artist',
  album: 'Album', duration: 180, file_hash: key, online_ref: false,
  source_ref: null, artwork_url: null
})

test('initial reconciliation exports playlist definitions and ordered members', () => {
  const operations = diffPlaylistSnapshots({}, {
    first: { name: 'My playlist', members: [member('a', 0), member('b', 1)] }
  })
  assert.deepEqual(operations.map(item => item.op), [
    'playlist.create', 'playlist.add', 'playlist.add'
  ])
  assert.deepEqual(operations.slice(1).map(item => item.fields.position), [0, 1])
})

test('subsequent unchanged playlist snapshots generate no redundant operations', () => {
  const state = { p: { name: 'Same', members: [member('a', 0)] } }
  assert.deepEqual(diffPlaylistSnapshots(state, state), [])
})

test('desktop removal and rename are both exported', () => {
  const before = {
    removed: { name: 'Delete me', members: [] },
    renamed: { name: 'Old', members: [] }
  }
  const after = { renamed: { name: 'New', members: [] } }
  const events = diffPlaylistSnapshots(before, after)
  assert.deepEqual(events.map(row => [row.entity_id, row.op]), [
    ['removed', 'playlist.delete'], ['renamed', 'playlist.rename']
  ])
})

test('member removals and ordering changes survive the incremental cursor', () => {
  const before = { p: { name: 'Playlist', members: [member('a', 0), member('b', 1)] } }
  const after = { p: { name: 'Playlist', members: [member('b', 0), member('c', 1)] } }
  const events = diffPlaylistSnapshots(before, after)
  assert.deepEqual(events.map(row => [row.op, row.fields.track_key]), [
    ['playlist.remove', 'a'], ['playlist.move', 'b'], ['playlist.add', 'c']
  ])
})

test('legacy first sync detects desktop playlists deleted without a captured delete event', () => {
  const journal = snapshotFromJournal([
    { entity_id: 'deleted-legacy', op: 'playlist.create', fields_json: JSON.stringify({ name: 'Old' }) },
    { entity_id: 'deleted-legacy', op: 'playlist.add', fields_json: JSON.stringify(member('a', 0)) }
  ])
  const diff = diffPlaylistSnapshots(journal, {})
  assert.deepEqual(diff.map(row => [row.entity_id, row.op]), [
    ['deleted-legacy', 'playlist.delete']
  ])
})

test('a captured delete does not generate a redundant deletion', () => {
  const journal = snapshotFromJournal([
    { entity_id: 'p', op: 'playlist.create', fields_json: '{"name":"Already removed"}' },
    { entity_id: 'p', op: 'playlist.delete', fields_json: '{}' }
  ])
  assert.deepEqual(diffPlaylistSnapshots(journal, {}), [])
})

test('accepted mobile playlist batches refresh the desktop UI once, without a restart', async () => {
  let renders = 0
  const refresh = createLinkedLibraryRefresh({ publish: () => { renders++ }, delayMs: 10 })
  refresh.accepted(0) // duplicate journal page
  refresh.accepted(3) // playlist.create and member operations
  refresh.accepted(2) // next page in the same sync
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(renders, 1)
  refresh.accepted(1) // subsequent mobile rename
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(renders, 2)
  refresh.close()
})

test('closing the desktop link cancels its pending playlist refresh', async () => {
  let renders = 0
  const refresh = createLinkedLibraryRefresh({ publish: () => { renders++ }, delayMs: 20 })
  refresh.accepted(1)
  refresh.close()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(renders, 0)
})

test('installCapture triggers compile in SQLite, allow pairing, and log track_id swaps', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { LinkStore } = require('../electron/link/store.js')
  const { installCapture } = require('../electron/link/capture.js')
  const db = new DatabaseSync(':memory:')
  db.transaction = fn => () => {
    db.exec('BEGIN IMMEDIATE')
    try { const r = fn(); db.exec('COMMIT'); return r }
    catch (e) { db.exec('ROLLBACK'); throw e }
  }
  try {
    db.exec(`
      CREATE TABLE tracks (
        id TEXT PRIMARY KEY, file_path TEXT, file_hash TEXT, title TEXT, artist TEXT,
        album TEXT, album_artist TEXT, genre TEXT, year INTEGER, track_num INTEGER,
        duration REAL, artwork_url TEXT, download_source TEXT
      );
      CREATE TABLE playlists (id TEXT PRIMARY KEY, uuid TEXT, user_id TEXT, name TEXT);
      CREATE TABLE playlist_tracks (id INTEGER PRIMARY KEY, playlist_id TEXT, track_id TEXT, position INTEGER);
      CREATE TABLE user_likes (user_id TEXT, track_id TEXT);
      CREATE TABLE listening_events (id INTEGER PRIMARY KEY, user_id TEXT, track_id TEXT, event_type TEXT, seconds_played REAL, ended_at INTEGER, created_at INTEGER);
    `)
    const store = new LinkStore(db)
    installCapture(store, () => 'owner')
    const pairing = store.createPairing('owner')
    assert.ok(pairing?.code)

    db.prepare('INSERT INTO tracks (id,file_path,title,artist,duration) VALUES (?,?,?,?,?)')
      .run('g1', 'ghost://spotify/1', 'Song', 'Artist', 180)
    db.prepare('INSERT INTO tracks (id,file_path,title,artist,duration) VALUES (?,?,?,?,?)')
      .run('l1', '/Music/song.flac', 'Song', 'Artist', 180)
    db.prepare('INSERT INTO playlists (id,uuid,user_id,name) VALUES (?,?,?,?)')
      .run('p1', 'pl-uuid-1', 'owner', 'Mix')
    db.prepare('INSERT INTO playlist_tracks (id,playlist_id,track_id,position) VALUES (?,?,?,?)')
      .run(1, 'p1', 'g1', 0)

    db.prepare('UPDATE playlist_tracks SET track_id=? WHERE id=?').run('l1', 1)
    const ops = db.prepare("SELECT op, fields_json FROM library_ops WHERE entity_id='pl-uuid-1' ORDER BY cursor").all()
    assert.deepEqual(ops.map(o => o.op), ['playlist.create', 'playlist.add', 'playlist.remove', 'playlist.add'])
  } finally {
    db.close()
  }
})

