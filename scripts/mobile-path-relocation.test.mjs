import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  relativeInside,
  relativeFromFolderMarker,
  destinationPath,
  rebaseMobileTrackPaths,
  migrateLegacyRoamingMobileFiles,
} from '../electron/mobilePathRelocation.js'

test('rebases Windows backup paths onto a Linux Lokal Mobile folder', () => {
  const oldRoot = 'C:\\Music\\Lokal Mobile'
  const file = 'C:\\Music\\Lokal Mobile\\Artist\\Album\\Track.flac'
  const artwork = 'C:\\Music\\Lokal Mobile\\Artist\\Album\\cover.jpg'
  const newRoot = '/mnt/music/Lokal Mobile'

  const trackRelative = relativeInside(file, oldRoot)
  const artworkRelative = relativeInside(artwork, oldRoot)
  assert.equal(trackRelative, 'Artist/Album/Track.flac')
  assert.equal(artworkRelative, 'Artist/Album/cover.jpg')
  assert.equal(destinationPath(newRoot, trackRelative), '/mnt/music/Lokal Mobile/Artist/Album/Track.flac')
  assert.equal(destinationPath(newRoot, artworkRelative), '/mnt/music/Lokal Mobile/Artist/Album/cover.jpg')
})

test('repairs already-restored tracks when the setting already contains the destination root', () => {
  const newRoot = 'E:\\Lokal Mobile'
  const oldTrack = 'C:\\Music\\Lokal Mobile\\Artist\\Track.flac'
  const relative = relativeFromFolderMarker(oldTrack, newRoot)
  assert.equal(relative, 'Artist/Track.flac')
  assert.equal(destinationPath(newRoot, relative), 'E:\\Lokal Mobile\\Artist\\Track.flac')
})

test('supports Windows drive-letter changes using the saved source root', () => {
  const oldRoot = 'C:\\Music\\Lokal Mobile'
  const newRoot = 'E:\\Lokal Mobile'
  const relative = relativeInside('C:\\Music\\Lokal Mobile\\Artist\\Track.flac', oldRoot)
  assert.equal(destinationPath(newRoot, relative), 'E:\\Lokal Mobile\\Artist\\Track.flac')
})

test('does not rebase paths outside the mobile folder', () => {
  assert.equal(relativeInside('C:\\Music\\Album\\Track.flac', 'C:\\Music\\Lokal Mobile'), null)
  assert.equal(relativeFromFolderMarker('/other/Artist/Track.flac', '/mnt/Lokal Mobile'), null)
})

test('rebase updates mobile file and artwork paths while preserving track identity', () => {
  const rows = [{
    id: 'mobile-track',
    file_path: 'C:\\Music\\Lokal Mobile\\Artist\\Track.flac',
    artwork_path: 'C:\\Music\\Lokal Mobile\\Artist\\cover.jpg',
  }]
  const updates = []
  const database = {
    prepare(sql) {
      if (sql.includes('SELECT id, file_path, artwork_path')) return { all: () => rows }
      if (sql.includes('UPDATE tracks SET file_path')) return {
        run: (filePath, artworkPath, id) => updates.push({ filePath, artworkPath, id }),
      }
      throw new Error('Unexpected SQL: ' + sql)
    },
  }
  const result = rebaseMobileTrackPaths(database, 'E:\\Lokal Mobile', 'E:\\Lokal Mobile')
  assert.deepEqual(result, { tracks: 1, artwork: 1 })
  assert.deepEqual(updates, [{
    filePath: 'E:\\Lokal Mobile\\Artist\\Track.flac',
    artworkPath: 'E:\\Lokal Mobile\\Artist\\cover.jpg',
    id: 'mobile-track',
  }])
})


test('copies legacy roaming phone downloads into selected portable folder and keeps originals', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-roaming-migration-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const legacy = path.join(temp, 'AppData', 'Roaming', 'lokal', 'data', 'phone-downloads')
  const destination = path.join(temp, 'Portable', 'Lokal Mobile')
  fs.mkdirSync(legacy, { recursive: true })
  const oldFile = path.join(legacy, 'Artist - Track.flac')
  fs.writeFileSync(oldFile, Buffer.from('audio-fixture'))
  const rows = [{ id: 'legacy-id', file_path: oldFile }]
  const updates = []
  const database = { prepare(sql) {
    if (sql.includes('SELECT id, file_path')) return { all: () => rows }
    if (sql.includes('SELECT id FROM tracks WHERE file_path')) return { get: () => undefined }
    if (sql.includes('UPDATE tracks SET file_path')) return { run: (next, id, old) => {
      updates.push({ next, id, old }); rows[0].file_path = next; return { changes: 1 }
    } }
    throw new Error('Unexpected SQL: ' + sql)
  } }
  const result = migrateLegacyRoamingMobileFiles(database, legacy, destination)
  const copied = path.join(destination, 'Artist - Track.flac')
  assert.deepEqual(result, { copied: 1, skipped: 0 })
  assert.equal(fs.readFileSync(copied, 'utf8'), 'audio-fixture')
  assert.equal(fs.existsSync(oldFile), true)
  assert.equal(rows[0].file_path, copied)
  assert.equal(updates[0].id, 'legacy-id')
})

test('does not overwrite a different destination file or rewrite its track row', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-roaming-collision-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const legacy = path.join(temp, 'phone-downloads')
  const destination = path.join(temp, 'Lokal Mobile')
  fs.mkdirSync(legacy)
  fs.mkdirSync(destination)
  const oldFile = path.join(legacy, 'Track.flac')
  const newFile = path.join(destination, 'Track.flac')
  fs.writeFileSync(oldFile, 'old-audio')
  fs.writeFileSync(newFile, 'different-audio')
  const rows = [{ id: 'legacy-id', file_path: oldFile }]
  const database = { prepare(sql) {
    if (sql.includes('SELECT id, file_path')) return { all: () => rows }
    if (sql.includes('SELECT id FROM tracks WHERE file_path')) return { get: () => undefined }
    if (sql.includes('UPDATE tracks SET file_path')) return { run: () => { throw new Error('must not update') } }
    throw new Error('Unexpected SQL: ' + sql)
  } }
  assert.deepEqual(migrateLegacyRoamingMobileFiles(database, legacy, destination), { copied: 0, skipped: 1 })
  assert.equal(fs.readFileSync(newFile, 'utf8'), 'different-audio')
  assert.equal(rows[0].file_path, oldFile)
})
