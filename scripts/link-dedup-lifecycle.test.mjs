import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
const require = createRequire(import.meta.url)
const { initDB, getDB } = require('../electron/ipc/db')
const { LinkStore } = require('../electron/link/store')
const { installCapture } = require('../electron/link/capture')
const { mergeDuplicates } = require('../electron/ipc/mergeDuplicates')
const { exactDuplicateGroups } = require('../electron/duplicateGroups')
const lifecycle = require('../electron/link/trackLifecycle')

const user = 'guest'
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-lifecycle-'))
  const previous = process.env.LOKAL_DATA_DIR
  process.env.LOKAL_DATA_DIR = path.join(dir, 'data')
  initDB()
  const db = getDB()
  const music = path.join(dir, 'music')
  fs.mkdirSync(music)
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('music_folder', ?), ('delete_files_from_disk', '1')").run(music)
  const store = new LinkStore(db)
  store.currentUser = () => user
  installCapture(store, () => user)
  t.after(() => {
    require('../electron/libraryWatcher').stopWatching()
    db.close()
    if (previous === undefined) delete process.env.LOKAL_DATA_DIR
    else process.env.LOKAL_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const add = (id, { source = null, bitrate = 128, title = 'Song', content, addedAt = 1000, ext = 'mp3' } = {}) => {
    const file = path.join(music, `${id}.${ext}`)
    fs.writeFileSync(file, content ?? `audio ${id}`)
    const hash = String(id.charCodeAt(0).toString(16)).repeat(64).slice(0, 64)
    db.prepare('INSERT INTO tracks (id,file_path,file_hash,title,artist,album,duration,bitrate,download_source,added_at) VALUES (?,?,?,?,?,?,200,?,?,?)')
      .run(id, file, hash, title, 'Artist', 'Album', bitrate, source, addedAt)
    return { file, hash }
  }
  const ops = () => db.prepare('SELECT * FROM library_ops ORDER BY cursor').all()
  return { db, store, music, add, ops }
}

test('tie-breaker prefers local originals over online downloads over mobile copies', t => {
  const { db, add } = fixture(t)
  add('mobile', { source: 'mobile' }); add('online', { source: 'youtube' }); add('local')
  const [group] = exactDuplicateGroups(db)
  assert.deepEqual(group.tracks.map(track => track.id), ['local', 'online', 'mobile'])
})

test('merge never journals false unlike/playlist.remove, dedupes playlists and records identities', async t => {
  const { db, store, add, ops } = fixture(t)
  add('keep', { bitrate: 320 })
  const loser = add('lose', { source: 'mobile' })
  db.exec("INSERT INTO playlists (id,name,uuid) VALUES ('p','P','uuid-p'); INSERT INTO playlist_tracks (playlist_id,track_id,position) VALUES ('p','keep',5),('p','lose',2); INSERT INTO user_likes (user_id,track_id) VALUES ('guest','lose')")
  const before = ops().length
  const result = await mergeDuplicates(db, 'keep', ['lose'])
  assert.equal(result.ok, true)
  const added = ops().slice(before)
  assert.deepEqual(added.map(row => row.op), ['track.deduplicate'])
  assert.equal(db.prepare("SELECT COUNT(*) n FROM playlist_tracks WHERE playlist_id='p'").get().n, 1)
  assert.equal(db.prepare("SELECT position FROM playlist_tracks WHERE playlist_id='p'").get().position, 2)
  assert.equal(db.prepare("SELECT download_source FROM tracks WHERE id='keep'").get().download_source, null)
  assert.equal(db.prepare("SELECT track_id FROM link_track_aliases WHERE track_key='artist|song|200'").get()?.track_id, 'keep')
  assert.equal(fs.existsSync(loser.file), false)
  const fields = JSON.parse(added[0].fields_json)
  assert.equal(fields.keep_key, 'artist|song|200')
  assert.ok(store.pendingTrash.length === 0)
})

test('track.deduplicate with one match registers identities and never deletes it', t => {
  const { db, store, add } = fixture(t)
  const only = add('only')
  store.applyOps([{ op_id: 'dedup-op-0001', device_id: 'phone_12345678', hlc: `${String(Date.now()).padStart(16, '0')}:00000000`, entity: 'track', entity_id: 'artist|song|200', op: 'track.deduplicate',
    fields: { keep_key: 'artist|song|200', keep_hash: only.hash, title: 'Song', artist: 'Artist', duration: 200, removed_keys: ['artist|song (old)|200'], removed_hashes: [{ sha256: 'ab'.repeat(32), bytes: 99 }] } }], user, 'phone_12345678')
  assert.ok(db.prepare("SELECT 1 FROM tracks WHERE id='only'").get())
  assert.ok(fs.existsSync(only.file))
  assert.equal(db.prepare("SELECT track_id FROM link_track_aliases WHERE track_key='artist|song (old)|200'").get().track_id, 'only')
  assert.equal(db.prepare('SELECT track_id FROM track_content_hashes WHERE sha256=? AND bytes=99').get('ab'.repeat(32)).track_id, 'only')
})

test('track.deduplicate with two local matches merges to the best and trashes the redundant file', async t => {
  const { db, store, add } = fixture(t)
  add('best', { bitrate: 320 })
  const redundant = add('worse', { bitrate: 96, source: 'mobile' })
  store.applyOps([{ op_id: 'dedup-op-0002', device_id: 'phone_12345678', hlc: `${String(Date.now()).padStart(16, '0')}:00000000`, entity: 'track', entity_id: 'artist|song|200', op: 'track.deduplicate',
    fields: { keep_key: 'artist|song|200', title: 'Song', artist: 'Artist', duration: 200, removed_keys: [], removed_hashes: [] } }], user, 'phone_12345678')
  assert.deepEqual(db.prepare('SELECT id FROM tracks ORDER BY id').all().map(row => row.id), ['best'])
  await store.flushPendingTrash()
  assert.equal(fs.existsSync(redundant.file), false)
})

test('track.delete writes a tombstone and removes only tracks not re-added later', async t => {
  const { db, store, add } = fixture(t)
  const old = add('old', { addedAt: 1000 })
  const fresh = add('fresh', { title: 'Song', addedAt: Math.floor(Date.now() / 1000) + 3600 })
  const hlc = `${String(Date.now()).padStart(16, '0')}:00000000`
  store.applyOps([{ op_id: 'delete-op-0001', device_id: 'phone_12345678', hlc, entity: 'track', entity_id: 'artist|song|200', op: 'track.delete',
    fields: { track_key: 'artist|song|200', title: 'Song', artist: 'Artist', duration: 200 } }], user, 'phone_12345678')
  assert.ok(db.prepare("SELECT 1 FROM link_tombstones WHERE entity='track' AND entity_id='artist|song|200'").get())
  assert.equal(db.prepare("SELECT 1 FROM tracks WHERE id='old'").get(), undefined)
  assert.ok(db.prepare("SELECT 1 FROM tracks WHERE id='fresh'").get())
  await store.flushPendingTrash()
  assert.equal(fs.existsSync(old.file), false)
  assert.ok(fs.existsSync(fresh.file))
  assert.equal(store.hasTrackTombstone(user, { track_key: 'artist|song|200' }), true)
})

test('pull omits lifecycle ops for old clients but still advances the cursor', t => {
  const { store } = fixture(t)
  const hlc = `${String(Date.now()).padStart(16, '0')}:00000000`
  store.applyOps([{ op_id: 'delete-op-0002', device_id: 'phone_12345678', hlc, entity: 'track', entity_id: 'a|b|1', op: 'track.delete', fields: { track_key: 'a|b|1' } }], user, 'phone_12345678')
  const old = store.pull('library_ops', user, 0, { trackLifecycle: false })
  assert.equal(old.items.length, 0)
  assert.ok(old.cursor > 0)
  assert.equal(store.pull('library_ops', user, 0).items.length, 1)
})

test('deleting the only copy appends track.delete; deleting one of two appends track.deduplicate', async t => {
  const { db, add, ops } = fixture(t)
  add('solo', { title: 'Solo' }); add('twin-a'); add('twin-b')
  const run = async id => {
    const snapshots = lifecycle.snapshot(db, [id])
    db.prepare('DELETE FROM tracks WHERE id=?').run(id)
    await lifecycle.afterDelete(db, snapshots)
  }
  await run('solo')
  await run('twin-a')
  const lifecycleOps = ops().filter(row => row.op.startsWith('track.'))
  assert.deepEqual(lifecycleOps.map(row => row.op), ['track.delete', 'track.deduplicate'])
  assert.equal(db.prepare("SELECT track_id FROM link_track_aliases WHERE track_key='artist|song|200'").get().track_id, 'twin-b')
})

test('restore wipe is not journaled as user deletes', t => {
  const { db, ops } = fixture(t)
  add_playlist(db)
  const before = ops().length
  const { importAppData } = require('../electron/ipc/db')
  importAppData({ version: 1, playlists: [{ id: 'q', name: 'Q', uuid: 'keep-uuid', smart_rules: '{"all":[]}' }] })
  assert.equal(ops().slice(before).some(row => row.op === 'playlist.delete'), false)
  const row = db.prepare("SELECT uuid,smart_rules FROM playlists WHERE id='q'").get()
  assert.equal(row.uuid, 'keep-uuid')
  assert.equal(row.smart_rules, '{"all":[]}')
})
function add_playlist(db) { db.exec("INSERT INTO playlists (id,name,uuid) VALUES ('old','Old','old-uuid')") }
