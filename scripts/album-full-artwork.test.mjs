import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const api = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8')
const albums = readFileSync(new URL('../src/pages/Albums.jsx', import.meta.url), 'utf8')
const scanner = readFileSync(new URL('../electron/ipc/scanner.js', import.meta.url), 'utf8')
const search = readFileSync(new URL('../src/pages/Search.jsx', import.meta.url), 'utf8')
const recapText = readFileSync(new URL('../src/recapText.js', import.meta.url), 'utf8')
const recapStories = readFileSync(new URL('../src/components/RecapStories.jsx', import.meta.url), 'utf8')
const recap = readFileSync(new URL('../src/pages/Recap.jsx', import.meta.url), 'utf8')
const recapStory = readFileSync(new URL('../src/components/RecapStory.jsx', import.meta.url), 'utf8')
const home = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8')

test('pre-existing library album rows retain a trusted artwork track id', () => {
  assert.match(scanner, /artwork_track_id:\s*artworkTrackId/)
  assert.match(api, /albumFullArtURL:\s*\(album\)\s*=>\s*album\?\.artwork_track_id/)
  assert.match(api, /api\.fullArtworkURL\(album\.artwork_track_id\)/)
})

test('album cards and hero load originals over existing thumbnails with fallback', () => {
  assert.match(albums, /function getAlbumFullArtwork\(album\)/)
  assert.match(albums, /const fullArtSrc = getAlbumFullArtwork\(album\)/)
  assert.match(albums, /<FadeImg src=\{artSrc\}/, 'old thumbnail stays visible initially')
  assert.match(albums, /<FadeImg src=\{fullArtSrc\}/, 'lazy full art upgrades the album card')
  assert.match(albums, /<ImageZoom src=\{fullArtSrc\}/, 'zoom uses the original image')
  assert.match(albums, /fullArtSrc !== artSrc/, 'original load is conditional')
})

test('recent search upgrades local and remote track and album artwork', () => {
  assert.ok(search.includes('api.fullArtworkURL(item.id)'))
  assert.ok(search.includes('api.albumFullArtURL(item)'))
  assert.ok(search.includes('<QualityImage src={item.artwork_url}'))
  assert.match(search, /loading="lazy"/)
})

test('recap surfaces use full-size local art and provider-aware remote images', () => {
  assert.ok(recapText.includes('api.fullArtworkURL(track.id)'))
  assert.ok(recapStories.includes('api.fullArtworkURL(track.id)'))
  assert.ok(recapStories.includes("track?.artwork_url || ''"))
  assert.ok(recap.includes('<QualityImage'))
  assert.ok(recapStory.includes('<QualityImage'))
  assert.ok(recapStories.includes('<QualityImage'))
})

test('Your Mixes cards prefer full-size local artwork and keep the thumbnail as fallback', () => {
  assert.match(home, /trackFullArtURL/)
  assert.ok(home.includes('function MixArtwork({ track })'))
  assert.ok(home.includes('QualityImage src={thumbnail}'))
  assert.ok(home.includes('QualityImage src={full}'))
  assert.ok(home.includes('onError={() => setFailed(true)}'))
  assert.ok(home.includes('MixArtwork track={arts[0]}'))
  assert.ok(home.includes('MixArtwork track={track}'))
})
