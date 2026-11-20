import test from 'node:test'
import assert from 'node:assert/strict'
import { playlistArtworkCandidates } from '../src/playlistArtwork.mjs'

test('mobile-style playlist collage selects four distinct covers', () => {
  const rows = [
    { artwork_path: '/a.jpg' },
    { artwork_path: '/a.jpg' },
    { artwork_path: '/b.jpg' },
    { artwork_url: 'https://example.test/c.jpg' },
    { artwork_path: '/d.jpg' },
    { artwork_path: '/e.jpg' },
  ]
  assert.deepEqual(playlistArtworkCandidates(rows).map(item => item.source),
    ['/a.jpg', '/b.jpg', 'https://example.test/c.jpg', '/d.jpg'])
})

test('unavailable or unsafe remote URLs are not requested as covers', () => {
  const rows = [
    { artwork_url: 'file:///etc/passwd' },
    { artwork_url: 'http://example.test/no.jpg' },
    { artwork_url: 'https://example.test/cover.jpg' },
  ]
  assert.equal(playlistArtworkCandidates(rows).length, 1)
})

test('very large playlists inspect at most 64 song entries', () => {
  const rows = Array.from({ length: 10000 }, (_, index) => ({
    artwork_path: index === 65 ? '/late.jpg' : '/early.jpg',
  }))
  assert.deepEqual(playlistArtworkCandidates(rows).map(item => item.source), ['/early.jpg'])
})
