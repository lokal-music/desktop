import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { connectedPhones, sendTracksToPhone, transferableTracks } from '../src/sendToMobile.mjs'

const remote = readFileSync(new URL('../server/routes/remote.js', import.meta.url), 'utf8')
const tracksEndpoint = remote.match(/router\.get\('\/library\/tracks'[\s\S]*?\n\}\)/)?.[0] || ''
const lookupEndpoint = remote.match(/router\.post\('\/library\/tracks\/lookup'[\s\S]*?\n\}\)/)?.[0] || ''
const home = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8')

test('only unique, present local tracks can be sent', () => {
  const tracks = [
    { id: 'local', file_path: 'C:\\music\\track.flac' },
    { id: 'local', file_path: 'C:\\music\\duplicate.flac' },
    { id: 'ghost', file_path: 'ghost://youtube/online/123' },
    { id: 'missing', file_path: 'C:\\music\\missing.flac', missing: true },
    { id: 'no-path' },
    { id: '', file_path: 'C:\\music\\unnamed.flac' },
  ]
  assert.deepEqual(transferableTracks(tracks).map(track => track.id), ['local'])
})

test('phone commands use unique string IDs in batches of at most 100', async () => {
  const tracks = Array.from({ length: 205 }, (_, index) => ({
    id: `track-${index}`,
    file_path: `C:\\music\\${index}.flac`,
  }))
  const calls = []
  const progress = []
  const result = await sendTracksToPhone({
    commandLinkDevice: async (id, command) => {
      calls.push({ id, command })
      return { ok: true }
    },
  }, 'phone-1', tracks, progress.push.bind(progress))

  assert.deepEqual(calls.map(call => call.command.value.tracks.length), [100, 100, 5])
  assert.equal(calls[0].command.action, 'copyTracksToPhone')
  assert.equal(calls[0].id, 'phone-1')
  assert.equal(calls.flatMap(call => call.command.value.tracks).length, 205)
  assert.ok(calls.every(call => call.command.value.tracks.every(id => typeof id === 'string')))
  assert.equal(result.copied, 205)
  assert.equal(progress.at(-1).completed, 205)
})

test('phone failures report only fully acknowledged songs', async () => {
  const tracks = Array.from({ length: 101 }, (_, index) => ({
    id: `track-${index}`,
    file_path: `C:\\music\\${index}.flac`,
  }))
  let calls = 0
  await assert.rejects(
    sendTracksToPhone({
      commandLinkDevice: async () => (++calls === 1 ? { ok: true } : { ok: false, error: 'Phone storage is full.' }),
    }, 'phone-1', tracks),
    error => error.message === 'Phone storage is full.' && error.copied === 100,
  )
})

test('connected phone choices exclude offline and revoked devices', () => {
  assert.deepEqual(connectedPhones([
    { id: 'phone-1', name: 'Phone 1', connected: true },
    { id: 'phone-2', name: 'Phone 2', connected: false },
    { id: 'phone-3', name: 'Phone 3', connected: true, revoked: true },
    { name: 'Unnamed', connected: true },
  ]).map(device => device.id), ['phone-1'])
})

test('the mobile metadata catalogue is paired-only and includes IDs and file types', () => {
  assert.match(tracksEndpoint, /if \(!pairedUser\(req, res\)\) return/)
  assert.match(remote, /id: track\.id,[\s\S]*?fileType: require\('path'\)\.extname/)
})

test('exact mobile track lookup is paired-only and validates IDs before querying', () => {
  assert.match(lookupEndpoint, /if \(!pairedUser\(req, res\)\) return/)
  assert.match(lookupEndpoint, /validateTrackLookupIds\(ids\)/)
  assert.match(lookupEndpoint, /return res\.status\(400\)\.json\(\{ error \}\)/)
  assert.match(lookupEndpoint, /items: compactTracks\(rows\)/)
})

test('every synchronous Home menu opener invalidates pending track menus', () => {
  assert.match(home, /const openMenu = \(event, items\) => \{\s*menuRequestRef\.current\+\+/)
  assert.equal((home.match(/menu\.open\(event,/g) || []).length, 1)
  assert.match(home, /const openMixMenu = \(event, mix\) => openMenu\(event,/)
  assert.match(home, /const openArtistMenu = \(event, artist\) => openMenu\(event,/)
  assert.match(home, /onEditCategory: event => openMenu\(event,/)
  assert.match(home, /onProviderMixMenu: \(event, mix\) => openMenu\(event,/)
  assert.match(home, /onAlbumMenu: \(event, album\) => openMenu\(event,/)
  assert.match(home, /const openTrackMenu = async[\s\S]{0,100}?const request = \+\+menuRequestRef\.current/)
  assert.match(home, /const openPickMenu = async[\s\S]{0,100}?const request = \+\+menuRequestRef\.current/)
})
