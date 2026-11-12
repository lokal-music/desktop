import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bcrypt = require('bcryptjs')
const { initDB, getDB, importAppData } = require('../electron/ipc/db')
const { exportAppData } = require('../electron/appDataExport')
const { resetLocalPassword, listUsers, registerUserHandlers } = require('../electron/ipc/users')
const { AddonStorage, validateBackupRecords } = require('../electron/mornye/storage')
const { LinkStore } = require('../electron/link/store')

test('backup and password recovery retain both account and Guest history and destination pairing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-recovery-'))
  const previous = process.env.LOKAL_DATA_DIR
  process.env.LOKAL_DATA_DIR = root
  initDB()
  const db = getDB()
  t.after(() => {
    db.close()
    if (previous === undefined) delete process.env.LOKAL_DATA_DIR
    else process.env.LOKAL_DATA_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  const hash = bcrypt.hashSync('forgotten-password', 4)
  importAppData({ version: 1, users: [{ id: 'owner', username: 'listener', password_hash: hash }],
    tracks: [{ id: 'song', file_path: 'ghost://test/song', file_hash: 'song-hash', title: 'Song', artist: 'Artist', source_ref: 'test:song', source_url: 'https://example.com/song', artwork_url: 'https://example.com/cover.jpg' }],
    playlists: [{ id: 'playlist', name: 'Keep me', user_id: 'owner' }],
    user_likes: [{ user_id: 'owner', track_id: 'song' }],
    play_history: [
      { id: 1, user_id: 'guest', track_id: 'song', seconds_played: 60 },
      { id: 2, user_id: 'owner', track_id: 'song', seconds_played: 120 },
    ],
    listening_events: [{ user_id: 'owner', track_id: 'song', seconds_played: 120 }],
    settings: {
      spotify_sp_dc: 'test-cookie',
      lastfm_api_key: 'test-lastfm-api-key',
      lastfm_api_secret: 'test-lastfm-secret',
      lastfm_session_key: 'test-lastfm-session',
      lastfm_username: 'test-listener',
      lastfm_enabled: '1',
      lastfm_scrobbling: '1',
      listenbrainz_token: 'test-listenbrainz-token',
      listenbrainz_username: 'test-listener',
      listenbrainz_enabled: '1',
      addons: JSON.stringify([{ key: 'lastwave', signingKey: 'test-hmac' }]),
    },
  })
  const backup = exportAppData(db)
  assert.equal(backup.play_history.length, 2)
  assert.equal(backup.listening_events[0].user_id, 'owner')
  assert.equal(backup.settings.spotify_sp_dc, undefined)
  for (const key of ['lastfm_api_secret', 'lastfm_session_key', 'listenbrainz_token']) assert.equal(backup.settings[key], undefined)
  const portable = exportAppData(db, { includeCredentials: true })
  assert.equal(portable.settings.spotify_sp_dc, 'test-cookie')
  assert.equal(portable.settings.lastfm_api_secret, 'test-lastfm-secret')
  assert.equal(portable.settings.lastfm_session_key, 'test-lastfm-session')
  assert.equal(portable.settings.listenbrainz_token, 'test-listenbrainz-token')
  assert.equal(JSON.parse(portable.settings.addons)[0].signingKey, 'test-hmac')
  const packages = require('../electron/mornye/packages').service(db)
  const namespace = 'b'.repeat(64)
  packages.storage.write(namespace, 'credentials', { token: 'test-addon-token' })
  const scanner = require('../electron/ipc/scanner')
  const nativeHandlers = new Map()
  scanner.registerScannerHandlers({ handle: (key, handler) => nativeHandlers.set(key, handler) })
  const nativeBackup = nativeHandlers.get('settings:exportAll')({}, { includeCredentials: true })
  assert.deepEqual(nativeBackup.addonCredentials, [{ namespace, purpose: 'credentials', value: { token: 'test-addon-token' } }])
  assert.equal(nativeHandlers.get('settings:exportAll')({}).addonCredentials, undefined)
  // Importing another PC's data must never clone its device ID or replace
  // the local phone pairing tokens.
  const link = new LinkStore(db)
  db.prepare('INSERT INTO remote_devices (id,name,token_hash,user_id,created,last_seen,revoked) VALUES (?,?,?,?,?,?,?)').run('phone', 'Phone', 'token-hash', 'owner', 1, 1, 0)
  const desktopId = link.deviceId
  nativeHandlers.get('settings:importAll')({}, JSON.parse(JSON.stringify(nativeBackup)))
  for (const key of ['lastfm_api_key', 'lastfm_api_secret', 'lastfm_session_key', 'lastfm_username', 'lastfm_enabled', 'lastfm_scrobbling', 'listenbrainz_token', 'listenbrainz_username', 'listenbrainz_enabled']) {
    assert.equal(db.prepare('SELECT value FROM settings WHERE key=?').get(key).value, nativeBackup.settings[key], key)
  }
  assert.deepEqual(db.prepare('SELECT source_ref, source_url, artwork_url FROM tracks WHERE id=?').get('song'), {
    source_ref: 'test:song', source_url: 'https://example.com/song', artwork_url: 'https://example.com/cover.jpg',
  })
  assert.equal(new LinkStore(db).deviceId, desktopId)
  assert.equal(db.prepare('SELECT token_hash FROM remote_devices WHERE id=?').get('phone').token_hash, 'token-hash')
  const result = resetLocalPassword(db, { userId: 'owner', password: 'replacement-password' })
  assert.equal(result.user.id, 'owner')
  assert.equal(result.user.password_hash, undefined)
  const stored = db.prepare('SELECT password_hash FROM users WHERE id=?').get('owner').password_hash
  assert.equal(bcrypt.compareSync('replacement-password', stored), true)
  assert.equal(bcrypt.compareSync('forgotten-password', stored), false)
  assert.equal(listUsers(db)[0].history_count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM play_history WHERE user_id=?').get('guest').n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_likes WHERE user_id=?').get('owner').n, 1)
  assert.equal(db.prepare('SELECT user_id FROM playlists WHERE id=?').get('playlist').user_id, 'owner')
  // Vault failures must not leave the database replaced while reporting a
  // failed import. The destination's Spotify cookie and accounts stay intact.
  packages.storage.key = null
  packages.storage.vaultProvider = () => { throw new Error('test vault unavailable') }
  assert.throws(() => nativeHandlers.get('settings:importAll')({}, {
    ...nativeBackup, settings: { spotify_sp_dc: 'replacement-cookie' }, users: [],
  }), /test vault unavailable/)
  assert.equal(db.prepare('SELECT value FROM settings WHERE key=?').get('spotify_sp_dc').value, 'test-cookie')
  assert.equal(listUsers(db)[0].id, 'owner')
  packages.storage.vaultProvider = null
  assert.ok(resetLocalPassword(db, { userId: 'owner', password: ' ' }).error)
  assert.ok(resetLocalPassword(db, { userId: 'owner', password: 'é'.repeat(37) }).error)
  assert.ok(resetLocalPassword(db, { userId: 'missing', password: 'valid' }).error)
  const handlers = new Map()
  registerUserHandlers({ handle: (key, handler) => handlers.set(key, handler) })
  const login = await handlers.get('user:login')({}, { username: 'listener', password: 'replacement-password' })
  assert.equal(login.user.id, 'owner')
  assert.equal(login.user.password_hash, undefined)
})

test('addon credentials move between device keys without exporting the master key', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-addon-transfer-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = new AddonStorage(path.join(root, 'source'))
  const target = new AddonStorage(path.join(root, 'target'))
  const namespace = 'a'.repeat(64)
  for (const purpose of ['settings', 'storage', 'credentials', 'connection', 'session']) source.write(namespace, purpose, { testSecret: `test-${purpose}` })
  const portable = JSON.parse(JSON.stringify(source.exportRecords()))
  target.importRecords(portable)
  assert.notDeepEqual(source.masterKey(), target.masterKey())
  for (const record of portable) assert.deepEqual(target.read(record.namespace, record.purpose), record.value)
  assert.ok(!fs.readFileSync(target.file(namespace, 'credentials'), 'utf8').includes('test-credentials'))
  assert.throws(() => validateBackupRecords([{ namespace: '../escape', purpose: 'credentials', value: {} }]))
  assert.throws(() => validateBackupRecords([{ namespace, purpose: 'files', value: {} }]))
  assert.throws(() => validateBackupRecords([portable[0], portable[0]]))
  assert.deepEqual(validateBackupRecords(undefined), [])
})
