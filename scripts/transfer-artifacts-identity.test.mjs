import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
const require = createRequire(import.meta.url)
const { cleanTransferMetadata, cleanTransferStem } = require('../electron/transferArtifacts.js')
const { ensureTrackContentHashes } = require('../electron/trackContentHashes.js')
const { isMobileFolderPath } = require('../electron/mobileSource.js')
const U = '123e4567-e89b-12d3-a456-426614174000'

test('strips machine suffixes and counters', () => {
  assert.equal(cleanTransferStem(`Song - ${U}-r2`), 'Song')
  assert.equal(cleanTransferStem('Song [0123456789abcdef]'), 'Song')
  assert.equal(cleanTransferStem('Song (2)'), 'Song (2)')
  assert.equal(cleanTransferStem(`Song (3) - ${U.toUpperCase()}`), 'Song')
})
test('placeholder artists split title; duplicated artist prefix removed', () => {
  assert.deepEqual(cleanTransferMetadata({ title: `A - B - ${U}`, artist: 'Lokal Phone' }),
    { title: 'B', artist: 'A', cleaned: true })
  assert.deepEqual(cleanTransferMetadata({ title: 'A - B', artist: 'A' }), { title: 'B', artist: 'A', cleaned: true })
  assert.equal(cleanTransferMetadata({ title: 'Fine', artist: 'X' }).cleaned, false)
})
test('content hash schema works on a minimal db and is idempotent', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE tracks (id TEXT PRIMARY KEY, file_path TEXT)')
  assert.ok(ensureTrackContentHashes(db)); assert.ok(ensureTrackContentHashes(db))
  assert.ok(db.prepare('PRAGMA table_info(tracks)').all().some(c => c.name === 'audio_sha256'))
  db.prepare('INSERT INTO track_content_hashes VALUES (?,?,?)').run('a', 1, 't')
})
test('recognises mobile folders', () => {
  assert.ok(isMobileFolderPath('/m/Lokal Mobile/x.flac'))
  assert.ok(isMobileFolderPath('/s/phone-downloads/x.flac'))
  assert.ok(!isMobileFolderPath('/music/x.flac'))
})
