import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import vm from 'node:vm'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
const require = createRequire(import.meta.url)
const { initDB, getDB } = require('../electron/ipc/db')
const { mergeDuplicates, mergeAllDuplicates } = require('../electron/ipc/mergeDuplicates')
const { scanFolder, registerV4Handlers } = require('../electron/ipc/scanner')
const scanMetadata = require('../electron/ipc/scannerMetadata')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-duplicates-'))
  const previous = process.env.LOKAL_DATA_DIR
  process.env.LOKAL_DATA_DIR = path.join(dir, 'data')
  initDB()
  const db = getDB()
  const music = path.join(dir, 'music')
  fs.mkdirSync(music)
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('music_folder', ?), ('delete_files_from_disk', '0')").run(music)
  t.after(() => {
    // Windows directory watchers survive removal of their test directory.
    // Close them before deleting fixtures or they keep the CI process alive.
    require('../electron/libraryWatcher').stopWatching()
    db.close()
    if (previous === undefined) delete process.env.LOKAL_DATA_DIR
    else process.env.LOKAL_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  function add(id, title = 'Song', bitrate = 128) {
    const file = path.join(music, `${id}.mp3`)
    fs.writeFileSync(file, `synthetic audio ${id}`)
    db.prepare('INSERT INTO tracks (id,file_path,file_hash,title,artist,duration,bitrate) VALUES (?,?,?,?,?,200,?)').run(id,file,id,title,'Artist',bitrate)
    return file
  }
  return { db, dir, music, add }
}

for (const mode of ['desktop', 'web']) {
  for (const flow of ['exact', 'similar', 'smart']) {
    test(`${mode} ${flow}: removes loser audio even with file deletion off; rescan keeps only winner`, async t => {
      const { db, music, add } = fixture(t)
      const keep = add('keep', 'Song', 320)
      const remove = add('remove', flow === 'similar' ? 'Song (Remastered)' : 'Song')
      db.exec("INSERT INTO playlists (id,name) VALUES ('p','Playlist'); INSERT INTO playlist_tracks (playlist_id,track_id,position) VALUES ('p','remove',0); INSERT INTO user_likes (user_id,track_id) VALUES ('guest','remove'); INSERT INTO play_history (user_id,track_id) VALUES ('guest','remove'); UPDATE tracks SET play_count=7,genre='Rock' WHERE id='remove'; UPDATE tracks SET album='Album' WHERE id='keep'")
      let result
      if (mode === 'desktop') {
        const handlers = new Map()
        registerV4Handlers({ handle: (name, fn) => handlers.set(name, fn) })
        result = await handlers.get(flow === 'smart' ? 'scanner:mergeAllDuplicates' : 'scanner:mergeDuplicates')(null, 'keep', ['remove'])
      } else {
        const express = require('express')
        const app = express()
        app.use(express.json())
        app.use('/tracks', require('../server/routes/tracks'))
        const server = app.listen(0, '127.0.0.1')
        t.after(() => server.close())
        await new Promise(resolve => server.once('listening', resolve))
        const response = await fetch(`http://127.0.0.1:${server.address().port}/tracks/${flow === 'smart' ? 'merge-all' : 'merge'}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keepId: 'keep', removeIds: ['remove'] }),
        })
        result = await response.json()
      }
      assert.equal(result.error, undefined)
      assert.equal(result.merged, 1)
      assert.equal(fs.existsSync(keep), true)
      assert.equal(fs.existsSync(remove), false)
      assert.deepEqual(fs.readdirSync(music), ['keep.mp3'])
      assert.equal(db.prepare('SELECT track_id FROM playlist_tracks').get().track_id, 'keep')
      assert.equal(db.prepare('SELECT track_id FROM user_likes').get().track_id, 'keep')
      assert.equal(db.prepare('SELECT track_id FROM play_history').get().track_id, 'keep')
      assert.equal(db.prepare('SELECT play_count FROM tracks').get().play_count, 7)
      t.mock.method(scanMetadata, 'parseWithDeadline', async () => ({ common: { title: 'Song', artist: 'Artist' }, format: { duration: 200, bitrate: 320000 } }))
      await scanFolder(music)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 1)
      assert.equal(fs.existsSync(keep), true)
    })
  }
}

test('invalid keeper, self-removal, and missing keeper audio cannot delete files', async t => {
  const { db, add } = fixture(t)
  const keep = add('keep'); const remove = add('remove')
  for (const [id, ids] of [['missing', ['remove']], ['keep', ['keep', 'remove']], ['keep', ['missing']]]) {
    assert.ok((await mergeDuplicates(db, id, ids)).error)
    assert.ok(fs.existsSync(keep)); assert.ok(fs.existsSync(remove))
  }
  fs.unlinkSync(keep)
  assert.ok((await mergeDuplicates(db, 'keep', ['remove'])).error)
  assert.ok(fs.existsSync(remove))
})

test('a later file-move failure rolls back database and restores earlier moves', async t => {
  const { db, add } = fixture(t)
  const keep = add('keep'); const a = add('a'); const b = add('b')
  const original = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === b) throw new Error('Permission denied: cannot move duplicate audio')
    return original(from, to)
  })
  const result = await mergeDuplicates(db, 'keep', ['a', 'b'])
  assert.match(result.error, /Permission denied/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 3)
  for (const file of [keep, a, b]) assert.ok(fs.existsSync(file))
})

test('a database failure leaves all audio and references intact', async t => {
  const { db, add } = fixture(t)
  const keep = add('keep'); const remove = add('remove')
  db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON tracks BEGIN SELECT RAISE(ABORT, 'test database failure'); END")
  assert.match((await mergeDuplicates(db, 'keep', ['remove'])).error, /test database failure/)
  assert.ok(fs.existsSync(keep)); assert.ok(fs.existsSync(remove))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 2)
})

test('outside files and symlinks are refused without changing the library', async t => {
  const { db, dir, add } = fixture(t)
  add('keep'); const remove = add('remove')
  const outside = path.join(dir, 'outside.mp3')
  fs.renameSync(remove, outside)
  db.prepare('UPDATE tracks SET file_path=? WHERE id=?').run(outside, 'remove')
  assert.match((await mergeDuplicates(db, 'keep', ['remove'])).error, /outside your music folder/)
  fs.symlinkSync(outside, remove)
  db.prepare('UPDATE tracks SET file_path=? WHERE id=?').run(remove, 'remove')
  assert.ok((await mergeDuplicates(db, 'keep', ['remove'])).error)
  assert.ok(fs.existsSync(outside))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 2)
})

test('a surviving symlink reference protects the duplicate audio', async t => {
  const { db, add } = fixture(t)
  add('keep'); const remove = add('remove'); const shared = add('shared')
  fs.unlinkSync(shared); fs.symlinkSync(remove, shared)
  assert.match((await mergeDuplicates(db, 'keep', ['remove'])).error, /shares its audio file/)
  assert.ok(fs.existsSync(remove)); assert.ok(fs.existsSync(shared))
})

test('already missing loser files can still be merged', async t => {
  const { db, add } = fixture(t)
  add('keep'); fs.unlinkSync(add('remove'))
  assert.equal((await mergeDuplicates(db, 'keep', ['remove'])).ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 1)
})

test('multiple path aliases of one loser file are staged only once', async t => {
  const { db, music, add } = fixture(t)
  const keep = add('keep'), remove = add('remove')
  fs.mkdirSync(path.join(music, 'alias'))
  const alias = `${music}${path.sep}alias${path.sep}..${path.sep}remove.mp3`
  db.prepare('INSERT INTO tracks (id,file_path,file_hash,title,artist) VALUES (?,?,?,?,?)').run('alias', alias, 'alias', 'Song', 'Artist')
  db.exec("INSERT INTO playlists (id,name) VALUES ('p','Playlist'); INSERT INTO playlist_tracks (playlist_id,track_id,position) VALUES ('p','alias',0); INSERT INTO play_history (user_id,track_id) VALUES ('guest','remove')")
  const result = await mergeDuplicates(db, 'keep', ['remove', 'alias'])
  assert.equal(result.error, undefined)
  assert.equal(result.merged, 2)
  assert.ok(fs.existsSync(keep))
  assert.equal(fs.existsSync(remove), false)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tracks').get().n, 1)
  assert.equal(db.prepare('SELECT track_id FROM playlist_tracks').get().track_id, 'keep')
  assert.equal(db.prepare('SELECT track_id FROM play_history').get().track_id, 'keep')
})

test('path aliases of the keeper merge records without deleting its audio', async t => {
  const { db, music, add } = fixture(t)
  const keep = add('keep')
  const alias = `${music}${path.sep}.${path.sep}keep.mp3`
  db.prepare('INSERT INTO tracks (id,file_path,file_hash,title,artist) VALUES (?,?,?,?,?)').run('alias', alias, 'alias', 'Song', 'Artist')
  const result = await mergeDuplicates(db, 'keep', ['alias'])
  assert.equal(result.error, undefined)
  assert.equal(result.merged, 1)
  assert.ok(fs.existsSync(keep))
  assert.deepEqual(fs.readdirSync(music), ['keep.mp3'])
})

test('Windows case aliases preserve the keeper audio', { skip: process.platform !== 'win32' }, async t => {
  const { db, add } = fixture(t)
  const keep = add('keep')
  db.prepare('INSERT INTO tracks (id,file_path,file_hash,title,artist) VALUES (?,?,?,?,?)').run('alias', keep.toUpperCase(), 'alias', 'Song', 'Artist')
  const result = await mergeDuplicates(db, 'keep', ['alias'])
  assert.equal(result.error, undefined)
  assert.equal(result.merged, 1)
  assert.ok(fs.existsSync(keep))
})

test('a directory cannot be selected as the keeper of real audio', async t => {
  const { db, music, add } = fixture(t)
  const keep = add('keep'), remove = add('remove')
  fs.unlinkSync(keep)
  db.prepare('UPDATE tracks SET file_path=? WHERE id=?').run(music, 'keep')
  assert.match((await mergeDuplicates(db, 'keep', ['remove'])).error, /no local audio file/)
  assert.ok(fs.existsSync(remove))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tracks').get().n, 2)
})

test('duplicates in a second configured music root can be merged safely', async t => {
  const { db, dir, music, add } = fixture(t)
  const keep = add('keep'), original = add('remove')
  const second = path.join(dir, 'second-music')
  fs.mkdirSync(second)
  const remove = path.join(second, 'remove.mp3')
  fs.renameSync(original, remove)
  db.prepare('UPDATE tracks SET file_path=? WHERE id=?').run(remove, 'remove')
  db.prepare("INSERT INTO settings (key,value) VALUES ('music_folders',?)").run(JSON.stringify([music, second]))
  const result = await mergeDuplicates(db, 'keep', ['remove'])
  assert.equal(result.error, undefined)
  assert.ok(fs.existsSync(keep))
  assert.equal(fs.existsSync(remove), false)
})

test('long duplicate filenames do not overflow the staging filename', async t => {
  const { db, music, add } = fixture(t)
  const keep = add('keep'), original = add('remove')
  const remove = path.join(music, `${'x'.repeat(220)}.mp3`)
  fs.renameSync(original, remove)
  db.prepare('UPDATE tracks SET file_path=? WHERE id=?').run(remove, 'remove')
  assert.equal((await mergeDuplicates(db, 'keep', ['remove'])).ok, true)
  assert.ok(fs.existsSync(keep))
  assert.equal(fs.existsSync(remove), false)
})

test('a loser disappearing before staging does not abort an otherwise safe merge', async t => {
  const { db, add } = fixture(t)
  const keep = add('keep'), remove = add('remove')
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === remove) fs.unlinkSync(remove)
    return rename(from, to)
  })
  const result = await mergeDuplicates(db, 'keep', ['remove'])
  assert.equal(result.error, undefined)
  assert.ok(fs.existsSync(keep))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tracks').get().n, 1)
})

test('Smart Merge keeps an available copy ahead of a missing higher-quality record', async t => {
  const { db, add } = fixture(t)
  const keep = add('keep', 'Song', 128)
  fs.unlinkSync(add('missing', 'Song', 999))
  const result = await mergeAllDuplicates(db, track => track.bitrate)
  assert.equal(result.error, undefined)
  assert.equal(result.merged, 1)
  assert.ok(fs.existsSync(keep))
  assert.equal(db.prepare('SELECT id FROM tracks').get().id, 'keep')
})

test('loser audio and database references are restored if the keeper disappears during staging', async t => {
  const { db, add } = fixture(t)
  const keep = add('keep'), remove = add('remove')
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === remove) fs.unlinkSync(keep)
    return rename(from, to)
  })
  const result = await mergeDuplicates(db, 'keep', ['remove'])
  assert.match(result.error, /copy to keep disappeared/)
  assert.ok(fs.existsSync(remove))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tracks').get().n, 2)
})

test('desktop Trash failure is reported and staged audio stays excluded on a real rescan', async t => {
  const { db, music, add } = fixture(t)
  add('keep'); add('remove')
  const file = require.resolve('../electron/ipc/mergeDuplicates')
  const localRequire = createRequire(file)
  const module = { exports: {} }
  const calls = []
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, process,
    require: id => id === './trackFiles' ? {
      ...localRequire(id),
      moveToTrash: async filename => { calls.push(filename); throw new Error('Trash unavailable') },
    } : localRequire(id),
  }, { filename: file })
  const result = await module.exports.mergeDuplicates(db, 'keep', ['remove'])
  assert.equal(result.ok, true)
  assert.match(result.warning, /could not be moved to Trash/)
  assert.equal(calls.length, 1)
  assert.ok(fs.existsSync(calls[0]))
  assert.ok(calls[0].endsWith('.lokal-duplicate'))
  t.mock.method(scanMetadata, 'parseWithDeadline', async () => ({ common: { title: 'Song', artist: 'Artist' }, format: { duration: 200 } }))
  await scanFolder(music)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 1)
})

test('ordinary deletion still honors its disabled setting; desktop removal uses Trash', async t => {
  const { db, add } = fixture(t)
  const file = add('keep')
  const { removeTrackFiles } = require('../electron/ipc/trackFiles')
  assert.equal(await removeTrackFiles(db, [file]), null)
  assert.ok(fs.existsSync(file))
  const module = { exports: {} }
  const calls = []
  const filename = require.resolve('../electron/ipc/trackFiles')
  const localRequire = createRequire(filename)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process: { versions: { electron: '44' } },
    require: id => id === 'electron' ? { shell: { trashItem: async item => calls.push(item) } } : localRequire(id),
  }, { filename })
  await module.exports.moveToTrash(file)
  assert.deepEqual(calls, [file])
})
