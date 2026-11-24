import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  relativeInside,
  relativeFromFolderMarker,
  destinationPath,
  rebaseMobileTrackPaths,
} from '../electron/mobilePathRelocation.js'

test('rebases Windows backup paths onto a Linux Lokal Mobile folder', () => {
  const oldRoot = 'C:\\Music\\Lokal Mobile'
  const file = 'C:\\Music\\Lokal Mobile\\Artist\\Album\\Track.flac'
  const artwork = 'C:\\Music\\Lokal Mobile\\Artist\\Album\\cover.jpg'
  const newRoot = '/mnt/music/Lokal Mobile'

  const trackRelative = relativeInside(file, oldRoot)
  const artworkRelative = relativeInside(artwork, oldRoot)
  assert.equal(trackRelative, 'Artist\\Album\\Track.flac')
  assert.equal(artworkRelative, 'Artist\\Album\\cover.jpg')
  assert.equal(destinationPath(newRoot, trackRelative), '/mnt/music/Lokal Mobile/Artist/Album/Track.flac')
  assert.equal(destinationPath(newRoot, artworkRelative), '/mnt/music/Lokal Mobile/Artist/Album/cover.jpg')
})

test('repairs already-restored tracks when the setting already contains the destination root', () => {
  const newRoot = 'E:\\Lokal Mobile'
  const oldTrack = 'C:\\Music\\Lokal Mobile\\Artist\\Track.flac'
  const relative = relativeFromFolderMarker(oldTrack, newRoot)
  assert.equal(relative, 'Artist\\Track.flac')
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

test('rebase updates only mobile file and artwork paths and preserves track identity', () => {
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
  const result = rebaseMobileTrackPaths(database, 'C:\\Music\\Lokal Mobile', '/mnt/music/Lokal Mobile')
  assert.deepEqual(result, { tracks: 1, artwork: 1 })
  assert.deepEqual(updates, [{
    filePath: '/mnt/music/Lokal Mobile/Artist/Track.flac',
    artworkPath: '/mnt/music/Lokal Mobile/Artist/cover.jpg',
    id: 'mobile-track',
  }])
})
