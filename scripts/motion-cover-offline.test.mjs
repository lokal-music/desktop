import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { motionCoverFor } = require('../electron/artwork/motion.js')

const track = { title: 'Offline Track', artist: 'Artist', album: 'Album' }
const prefix = 'offline track|artist|album|'
const apple = { url: 'https://cdn.example.test/cover.m3u8', kind: 'hls', source: 'apple', tall: false }
const tidal = { url: 'https://cdn.example.test/cover.mp4', kind: 'mp4', source: 'tidal', tall: false }
const canvas = { url: 'https://cdn.example.test/recording.cnvs.mp4', kind: 'mp4', source: 'spotify', tall: true }
const old = Date.now() - 50 * 24 * 60 * 60 * 1000

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'lokal-offline-motion-'))
  t.after(() => { db.close(); rmSync(cacheDir, { recursive: true, force: true }) })

  function index(key, found, fetchedAt = old) {
    db.exec('CREATE TABLE IF NOT EXISTS motion_covers (key TEXT PRIMARY KEY, data TEXT, fetched_at INTEGER)')
    db.prepare('INSERT OR REPLACE INTO motion_covers VALUES (?, ?, ?)').run(prefix + key, found && JSON.stringify(found), fetchedAt)
  }

  function clip(found, { highResolution = false, bytes = 2048 } = {}) {
    const key = `${found.url}|${highResolution ? 'high' : 'default'}`
    const file = path.join(cacheDir, createHash('sha1').update(key).digest('hex').slice(0, 20) + '.mp4')
    writeFileSync(file, Buffer.alloc(bytes, 0x7f))
    return file
  }

  return { db, cacheDir, index, clip }
}

function noNetwork(t) {
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    throw new Error('Internet unavailable (airplane mode)')
  }
  t.after(() => { globalThis.fetch = original })
  return () => requests
}

function spotifyDesktop(t) {
  const previous = process.versions.electron
  process.versions.electron = '44.5.1'
  t.after(() => {
    if (previous === undefined) delete process.versions.electron
    else process.versions.electron = previous
  })
}

test('expired Apple HLS metadata serves the completed local MP4 offline, without a token refresh', async t => {
  const { db, cacheDir, index, clip } = fixture(t)
  const requests = noNetwork(t)
  index('apple,tidal,community|v3', apple)
  const file = clip(apple)
  const result = await motionCoverFor(db, track, { cacheDir })
  assert.deepEqual(result, { file, source: 'apple', tall: false })
  assert.equal(requests(), 0)
})

test('Spotify Canvas survives lookup TTL, session expiry, source reorder and old key revisions', async t => {
  spotifyDesktop(t)
  const { db, cacheDir, index, clip } = fixture(t)
  const requests = noNetwork(t)
  index('apple,tidal,spotify|v2|s2', canvas)
  const file = clip(canvas)
  const result = await motionCoverFor(db, track, {
    cacheDir,
    settings: {
      motion_cover_sources: JSON.stringify(['apple', 'tidal', 'spotify']),
      spotify_sp_dc: 'stale-but-cached-session',
      spotify_canvas_first: '1',
    },
  })
  assert.deepEqual(result, { file, source: 'spotify', tall: true })
  assert.equal(requests(), 0)
})

test('the active source order ranks existing offline covers and ignores stale negative rows', async t => {
  spotifyDesktop(t)
  const { db, cacheDir, index, clip } = fixture(t)
  const requests = noNetwork(t)
  index('tidal,spotify|v3|s3', tidal)
  index('apple,tidal,spotify|v3|s3', null, Date.now())
  index('spotify,tidal|v3|s3', canvas)
  const tidalFile = clip(tidal)
  const canvasFile = clip(canvas)
  const settings = {
    motion_cover_sources: JSON.stringify(['tidal', 'spotify']),
    spotify_sp_dc: 'cached-session',
  }
  assert.deepEqual(
    await motionCoverFor(db, track, { cacheDir, settings }),
    { file: tidalFile, source: 'tidal', tall: false },
  )
  assert.deepEqual(
    await motionCoverFor(db, track, { cacheDir, settings: { ...settings, spotify_canvas_first: '1' } }),
    { file: canvasFile, source: 'spotify', tall: true },
  )
  assert.equal(requests(), 0)
})

test('a disabled provider does not resurrect its offline clip', async t => {
  spotifyDesktop(t)
  const { db, cacheDir, index, clip } = fixture(t)
  const requests = noNetwork(t)
  index('spotify|v3|s3', canvas)
  clip(canvas)
  const result = await motionCoverFor(db, track, {
    cacheDir,
    settings: { motion_cover_sources: JSON.stringify(['tidal']) },
  })
  assert.equal(result, null)
  assert.ok(requests() >= 1, 'uncached enabled providers may still attempt normal discovery')
})

test('a changed high-resolution preference falls back to the previously downloaded rendition', async t => {
  const { db, cacheDir, index, clip } = fixture(t)
  const requests = noNetwork(t)
  index('apple,tidal,community|v3', apple)
  const defaultFile = clip(apple)
  assert.deepEqual(
    await motionCoverFor(db, track, {
      cacheDir,
      settings: { high_resolution_motion_covers: '1' },
    }),
    { file: defaultFile, source: 'apple', tall: false },
  )
  const highFile = clip(apple, { highResolution: true })
  assert.deepEqual(
    await motionCoverFor(db, track, { cacheDir }),
    { file: defaultFile, source: 'apple', tall: false },
  )
  assert.deepEqual(
    await motionCoverFor(db, track, {
      cacheDir,
      settings: { high_resolution_motion_covers: '1' },
    }),
    { file: highFile, source: 'apple', tall: false },
  )
  assert.equal(requests(), 0)
})

test('an evicted, empty or partial clip is never presented as a valid offline cover', async t => {
  const { db, cacheDir, index, clip } = fixture(t)
  const requests = noNetwork(t)
  index('apple,tidal,community|v3', apple)
  const file = clip(apple)
  unlinkSync(file)
  const result = await motionCoverFor(db, track, { cacheDir })
  assert.equal(result, null)
  assert.ok(requests() > 0, 'missing local media falls through to normal provider resolution')

  const corrupted = clip(apple, { bytes: 32 })
  const previousRequests = requests()
  const result2 = await motionCoverFor(db, track, { cacheDir })
  assert.equal(result2, null)
  assert.ok(requests() > previousRequests)
  unlinkSync(corrupted)
})

test('cached clips never leak across different artists or titles', async t => {
  const { db, cacheDir, index, clip } = fixture(t)
  const requests = noNetwork(t)
  index('apple,tidal,community|v3', apple)
  clip(apple)
  const mismatched = await motionCoverFor(db, { ...track, artist: 'Another Artist' }, {
    cacheDir,
    settings: { motion_cover_sources: '[]' },
  })
  assert.equal(mismatched, null)
  assert.equal(requests(), 0)
})
