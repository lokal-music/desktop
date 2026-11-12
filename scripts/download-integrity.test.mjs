import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { initDB, getDB } = require('../electron/ipc/db')
const { DownloadManager } = require('../electron/download/manager')
const { indexSingleFile, scanFolder, walkDir } = require('../electron/ipc/scanner')
const files = require('../electron/download/libraryFiles')
const watcher = require('../electron/libraryWatcher')
const { parseFile } = require('../electron/musicMetadata')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-download-integrity-'))
  const previous = process.env.LOKAL_DATA_DIR
  process.env.LOKAL_DATA_DIR = path.join(dir, 'data')
  initDB()
  const db = getDB(), root = path.join(dir, 'Music')
  fs.mkdirSync(root)
  for (const [key, value] of Object.entries({ music_folder: root, min_duration: '0', fetch_online_artwork: '0', download_embed_lyrics: '0' })) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
  }
  const mgr = new DownloadManager().configure({ getDB: () => db, getStorageDir: () => path.join(dir, 'data'), index: indexSingleFile, findTools: () => ({ ffmpeg: 'ffmpeg' }) })
  mgr.initialized = true
  mgr.ensureTable()
  t.after(() => {
    watcher.stopWatching()
    clearTimeout(mgr.addonWake)
    db.close()
    if (previous === undefined) delete process.env.LOKAL_DATA_DIR
    else process.env.LOKAL_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  function audio(codec = 'flac') {
    const file = path.join(dir, `source-${codec}.${codec === 'alac' ? 'm4a' : 'flac'}`)
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', codec,
      '-metadata', 'title=Song', '-metadata', 'artist=Artist', '-metadata', 'album=Album', '-metadata', 'genre=Dance', file])
    return file
  }
  function download(file, opts = {}) {
    const job = mgr.makeJob('single', 'https://example.test/audio', { title: 'Artist - Song', tags: { title: 'Song', artist: 'Artist', album: 'Album', ...opts.tags }, ...opts })
    mgr.jobs.set(job.id, job)
    mgr.startAddonArtifact(job, async () => ({ file }))
    return job
  }
  async function finish(...jobs) {
    const deadline = Date.now() + 15000
    while (mgr.running && Date.now() < deadline) await pause(10)
    assert.equal(mgr.running, 0, 'download pipeline must settle')
    return jobs
  }
  return { db, dir, root, mgr, audio, download, finish }
}

test('real downloads, a concurrent scan, repeats and a watcher leave one playable file and one row', async t => {
  const { db, root, mgr, audio, download, finish } = fixture(t)
  const source = audio()
  watcher.watchLibrary(root)
  let scannedDuringPublication = false
  mgr.deps.index = async (file, opts) => {
    assert.equal(files.isHidden(file), true)
    await scanFolder(root, { saveRoot: false, watch: false })
    assert.equal(db.prepare('SELECT id FROM tracks WHERE file_path = ?').get(file), undefined)
    scannedDuringPublication = true
    return indexSingleFile(file, opts)
  }
  const first = download(source)
  await finish(first)
  assert.equal(first.status, 'done', first.error)
  const id = first.indexedTracks[0].id
  mgr.deps.index = indexSingleFile
  const second = download(source, { tags: { title: 'Song', artist: 'Artist', album: 'Compilation' } })
  const third = download(source, { tags: { title: 'Song (Original Mix)', artist: 'Artist', album: 'Another album' } })
  await finish(second, third)
  assert.equal(second.indexedTracks[0]?.id, id, second.error)
  assert.equal(third.indexedTracks[0]?.id, id, third.error)
  await pause(2200) // exercise real recursive fs.watch settling, including removed copies
  await scanFolder(root, { saveRoot: false, watch: false })
  assert.equal(await watcher.scanRootForCatchUp(root), true)
  assert.equal(scannedDuringPublication, true)
  const rows = db.prepare('SELECT id, file_path FROM tracks').all()
  assert.equal(rows.length, 1)
  assert.equal((await walkDir(root)).length, 1, 'a rescan cannot resurrect redundant physical files')
  for (const job of [first, second, third]) {
    assert.deepEqual(job.filepaths, [rows[0].file_path])
    assert.equal(job.song, rows[0].file_path)
  }
  assert.equal((await parseFile(rows[0].file_path)).format.codec, 'FLAC')
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', rows[0].file_path, '-map', '0:a:0', '-f', 'null', '-'])
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('mixes with different qualifiers remain separate downloads', async t => {
  const { db, audio, download, finish } = fixture(t)
  const source = audio()
  const first = download(source)
  await finish(first)
  const remix = download(source, { tags: { title: 'Song (Live)', artist: 'Artist', album: 'Album' } })
  await finish(remix)
  assert.equal(remix.status, 'done', remix.error)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 2)
})

test('ALAC download converts to a decodable FLAC and retains only its final path', async t => {
  const { db, root, audio, download, finish } = fixture(t)
  const job = download(audio('alac'))
  await finish(job)
  assert.equal(job.status, 'done', job.error)
  const row = db.prepare('SELECT file_path, codec FROM tracks').get()
  assert.match(row.file_path, /\.flac$/)
  assert.equal(row.codec, 'FLAC')
  assert.deepEqual(job.filepaths, [row.file_path])
  assert.equal((await walkDir(root)).length, 1)
})

test('custom download folders retain numbering and deduplicate before subsequent scans', async t => {
  const { db, root, audio, download, finish } = fixture(t)
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('download_folder', 'Downloads/Spotify')").run()
  const source = audio()
  const first = download(source)
  await finish(first)
  const second = download(source)
  await finish(second)
  const rows = db.prepare('SELECT file_path, track_num FROM tracks').all()
  assert.equal(rows.length, 1)
  assert.equal(path.dirname(rows[0].file_path), path.join(root, 'Downloads', 'Spotify'))
  assert.equal(rows[0].track_num, 1)
  assert.deepEqual(second.filepaths, first.filepaths)
  assert.equal((await walkDir(root)).length, 1)
})

test('deferred playlist indexing publishes the prepared file at completion', async t => {
  const { db, root, mgr, audio, finish } = fixture(t)
  const stage = files.stagingDirectory(root, 'deferred')
  const raw = path.join(stage, 'Artist - Song.flac')
  fs.copyFileSync(audio(), raw)
  const job = mgr.makeJob('playlist', 'https://example.test/list', { id: 'deferred', tags: { title: 'Song', artist: 'Artist', album: 'Album' } })
  job.settings = mgr.settings()
  job.post = Promise.resolve()
  job.filepaths = [raw]
  mgr.jobs.set(job.id, job)
  mgr.afterFile(job, raw)
  await job.post
  assert.equal(job.pendingIndex.length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 0)
  assert.deepEqual(await walkDir(root), [])
  await mgr.onExit(job, 0)
  await finish(job)
  assert.equal(job.status, 'done', job.error)
  assert.equal(job.indexedTracks.length, 1)
  assert.equal(files.isIncoming(job.filepaths[0]), false)
  assert.equal(fs.existsSync(job.filepaths[0]), true)
})

test('source lookup skips an old missing row in favor of an available download', async t => {
  const { db, root, mgr, audio, download, finish } = fixture(t)
  const job = download(audio())
  await finish(job)
  db.prepare('UPDATE tracks SET source_ref = ?').run('yt:existing')
  db.prepare('INSERT INTO tracks (id, file_hash, file_path, title, artist, source_ref) VALUES (?, ?, ?, ?, ?, ?)')
    .run('missing', 'missing', path.join(root, 'missing.flac'), 'Song', 'Artist', 'yt:existing')
  assert.equal(mgr.libraryTrackWithRef('yt:existing').id, job.indexedTracks[0].id)
})

for (const failure of ['invalid audio', 'failed converter', 'wrong duration']) {
  test(`${failure} is an error and never appears as a playable library download`, async t => {
    const { db, dir, root, mgr, audio, download, finish } = fixture(t)
    let source
    if (failure === 'invalid audio') {
      source = path.join(dir, 'error.flac')
      fs.writeFileSync(source, '<html>provider returned an error</html>')
    } else source = audio(failure === 'failed converter' ? 'alac' : 'flac')
    if (failure === 'failed converter') mgr.deps.findTools = () => ({ ffmpeg: path.join(dir, 'missing-ffmpeg') })
    const job = download(source, failure === 'wrong duration' ? { expectedDuration: 200 } : {})
    await finish(job)
    assert.equal(job.status, 'error', job.message)
    assert.ok(job.error)
    await scanFolder(root, { saveRoot: false, watch: false })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 0)
    assert.deepEqual(await walkDir(root), [])
  })
}

test('history repair transfers references only from the exact missing pre-tagging path', async t => {
  const { db, root, mgr, audio, download, finish } = fixture(t)
  const job = download(audio())
  await finish(job)
  const id = job.indexedTracks[0].id
  const raw = path.join(root, 'Artist - Song.flac')
  db.prepare('INSERT INTO tracks (id, file_hash, file_path, title, artist, liked, play_count) VALUES (?, ?, ?, ?, ?, 1, 7)').run('raw', 'raw', raw, 'Artist - Song', 'Music')
  db.prepare('INSERT INTO tracks (id, file_hash, file_path, title, artist) VALUES (?, ?, ?, ?, ?)').run('unrelated', 'unrelated', path.join(root, 'user-removed.flac'), 'Song', 'Artist')
  db.exec("INSERT INTO playlists (id, name) VALUES ('p', 'Saved'); INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('p', 'raw', 0); INSERT INTO play_history (user_id, track_id) VALUES ('guest', 'raw');")
  job.filepaths = [raw]
  await mgr.repairMovedDownloads()
  assert.equal(db.prepare("SELECT id FROM tracks WHERE id = 'raw'").get(), undefined)
  assert.ok(db.prepare("SELECT id FROM tracks WHERE id = 'unrelated'").get())
  assert.equal(db.prepare('SELECT track_id FROM playlist_tracks').get().track_id, id)
  assert.equal(db.prepare('SELECT track_id FROM play_history').get().track_id, id)
  assert.equal(db.prepare('SELECT liked, play_count FROM tracks WHERE id = ?').get(id).liked, 1)
  assert.equal(db.prepare('SELECT track_id FROM track_aliases WHERE old_id = ?').get('raw').track_id, id)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})
