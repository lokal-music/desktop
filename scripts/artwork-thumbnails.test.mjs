import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')
const { makeThumb, writeCover, THUMB_SIZE } = require('../electron/artwork/thumb.js')
const { filePicture } = require('../electron/artwork/fullCover.js')
const { shrinkCovers } = require('../electron/artwork/shrinkCovers.js')
const { writeEmbeddedArtwork } = require('../electron/fileArtwork.js')
const { DatabaseSync } = require('node:sqlite')

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-art-thumbs-'))
const picture = (width = 800, height = 600) =>
  sharp({ create: { width, height, channels: 3, background: '#c83' } }).jpeg({ quality: 95 }).toBuffer()
function silentMp3(filePath) {
  const frame = Buffer.alloc(417)
  frame.set([0xff, 0xfb, 0x90, 0x64])
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.concat(Array.from({ length: 30 }, () => frame)))
}
function library() {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE tracks (id TEXT PRIMARY KEY, file_path TEXT, artwork_path TEXT); CREATE TABLE artists (id TEXT, image_path TEXT); CREATE TABLE playlists (id TEXT, cover_path TEXT)")
  db.transaction = fn => (...args) => fn(...args)
  return db
}

test('embedded cover thumbnails are small 150px WebP files', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bytes = await picture()
  const thumb = await makeThumb(bytes)
  const meta = await sharp(thumb).metadata()
  assert.equal(meta.format, 'webp')
  assert.equal(meta.width, THUMB_SIZE)
  assert.equal(meta.height, THUMB_SIZE)
  assert.ok(thumb.length < bytes.length)
  const pathWritten = await writeCover(dir, 't-id', bytes)
  assert.equal(pathWritten, path.join(dir, 't-id.webp'))
  assert.equal(fs.existsSync(pathWritten), true)
})

test('full picture can be read back from a local audio file', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const song = path.join(dir, 'song.mp3')
  const cover = await picture(300, 300)
  silentMp3(song)
  writeEmbeddedArtwork(song, cover)
  const result = await filePicture(song)
  assert.ok(result)
  assert.match(result.mime, /^image\//)
  const meta = await sharp(result.bytes).metadata()
  assert.equal(meta.width, 300)
  assert.equal(meta.height, 300)
})

test('safe shrinking updates track rows, keeps non-embedded art, and removes replaced full-size cache', async t => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const art = path.join(dir, 'artwork')
  fs.mkdirSync(art)
  const song = path.join(dir, 'song.mp3')
  silentMp3(song)
  const cover = await picture(500, 500)
  writeEmbeddedArtwork(song, cover)
  const old = path.join(art, 't-song.jpg')
  fs.writeFileSync(old, cover)
  const db = library()
  db.prepare('INSERT INTO tracks VALUES (?, ?, ?)').run('t-song', song, old)
  const result = await shrinkCovers(db, art)
  assert.equal(result.converted, 1)
  assert.ok(result.freed > 0)
  const row = db.prepare('SELECT artwork_path FROM tracks WHERE id = ?').get('t-song')
  assert.equal(row.artwork_path, path.join(art, 't-song.webp'))
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(row.artwork_path), true)
})
