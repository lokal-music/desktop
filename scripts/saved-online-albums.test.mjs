import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

async function onlineModule(settings) {
  globalThis.onlineAlbumTestApi = {
    getSettings: async () => ({ ...settings.current }),
    saveSettings: async values => {
      if (settings.reject) return { error: 'disk full' }
      settings.current = { ...settings.current, ...values }
      return { success: true }
    },
  }
  const source = (await readFile(new URL('../src/onlineLibrary.js', import.meta.url), 'utf8'))
    .replace("import { api } from './api'", 'const api = globalThis.onlineAlbumTestApi')
    .replace("from 'zustand'", `from '${pathToFileURL(require.resolve('zustand')).href}'`)
  return import(`data:text/javascript;base64,${Buffer.from(source + `\n// ${Math.random()}`).toString('base64')}`)
}

test('saving a catalogue album adds it to Albums without any downloads', async () => {
  const state = { current: {} }
  const library = await onlineModule(state)
  await library.setOnlineAlbumSaved({
    title: 'A New Album', artist: 'An Online Artist', albumId: '123',
    provider: 'youtube', artwork_url: 'https://example.com/cover.png',
  }, true)
  assert.equal(library.useSavedOnlineAlbums.getState().saved.size, 1)
  assert.equal(JSON.parse(state.current.saved_online_albums)[0].albumId, '123')
  await library.setOnlineAlbumSaved({ title: ' A new album ', artist: 'AN ONLINE ARTIST' }, false)
  assert.equal(library.useSavedOnlineAlbums.getState().saved.size, 0)
})

test('restores saved online albums and ignores malformed entries', async () => {
  const state = { current: { saved_online_albums: JSON.stringify([
    { title: 'Test', artist: 'Someone', artwork_url: 'https://example.com/art.jpg' },
    { title: '', artist: 'Invalid' },
    { title: 'test', artist: 'SOMEONE', albumId: 'catalogue-1' },
  ]) } }
  const library = await onlineModule(state)
  await library.loadSavedOnlineAlbums()
  assert.equal(library.useSavedOnlineAlbums.getState().saved.size, 1)
  assert.equal(library.useSavedOnlineAlbums.getState().saved.values().next().value.albumId, 'catalogue-1')
})

test('a failed settings write does not change album save state', async () => {
  const state = { current: {}, reject: true }
  const library = await onlineModule(state)
  await assert.rejects(library.setOnlineAlbumSaved({ title: 'Test', artist: 'Artist' }, true), /disk full/)
  assert.equal(library.useSavedOnlineAlbums.getState().saved.size, 0)
})
