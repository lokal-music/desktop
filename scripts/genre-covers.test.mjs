import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { GENRE_TONES, genreGradient, genreToneFor } from '../src/genrePalette.js'

const genresSource = readFileSync(new URL('../src/pages/Genres.jsx', import.meta.url), 'utf8')

test('genreToneFor matches mobile LokalGenrePalette explicit genre families', () => {
  assert.deepEqual(genreToneFor('Jazz'), GENRE_TONES[0])
  assert.deepEqual(genreToneFor('Afrobeats'), GENRE_TONES[1])
  assert.deepEqual(genreToneFor('Indie / Alternative'), GENRE_TONES[2])
  assert.deepEqual(genreToneFor('R&B / Soul'), GENRE_TONES[3])
  assert.deepEqual(genreToneFor('Rock'), GENRE_TONES[4])
  assert.deepEqual(genreToneFor('Electronic'), GENRE_TONES[5])
  assert.deepEqual(genreToneFor('Hip-Hop / Rap'), GENRE_TONES[7])
  assert.deepEqual(genreToneFor('Pop'), GENRE_TONES[9])
  assert.deepEqual(genreToneFor('Classical'), GENRE_TONES[10])
  assert.deepEqual(genreToneFor('Soundtrack'), GENRE_TONES[11])
})

test('genreToneFor is deterministic for hashed genres and matches mobile hashing', () => {
  // Hash of "metal": ((((109*31+101)*31+116)*31+97)*31+108) = 103787271 % 12 = 3
  assert.deepEqual(genreToneFor('Metal'), GENRE_TONES[3])
  assert.deepEqual(genreToneFor('  METAL  '), GENRE_TONES[3])
  assert.equal(genreToneFor('Folk'), genreToneFor('folk'))
})

test('genreGradient matches mobile linear gradient stops', () => {
  const jazz = genreToneFor('Jazz')
  assert.equal(
    genreGradient(jazz),
    'linear-gradient(135deg, #8260D1 0%, #503787 45%, #503787 100%)',
  )
})

test('Genres page renders mobile-style chromatic covers instead of artwork mosaics', () => {
  assert.match(genresSource, /import \{ GENRE_FOREGROUND, genreGradient, genreToneFor \} from '\.\.\/genrePalette'/)
  assert.match(genresSource, /<GenreCover name=\{label\}>/)
  assert.match(genresSource, /<GenreCover name=\{title\} compact \/>/)
  assert.doesNotMatch(genresSource, /import FadeImg from/)
  assert.doesNotMatch(genresSource, /grid-cols-2 grid-rows-2/)
})
