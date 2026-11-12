import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { loadRecommendationPage, sourceName } from '../src/recommendations.js'

const require = createRequire(import.meta.url)
const { madeForYou, playlistTracks, homeMixes, playlistEntry } = require('../electron/artwork/spotify.js')

const id = (prefix, n) => (prefix + String(n).padStart(22, '0')).slice(0, 22)
const playlist = (uri, name, owner = 'Spotify') => ({ uri, content: { __typename: 'PlaylistResponseWrapper', data: { __typename: 'Playlist', uri, name, description: `<b>${name}</b> for you`, ownerV2: { data: { __typename: 'User', name: owner } }, images: { items: [{ sources: [{ url: 'small', width: 60 }, { url: 'big', width: 640 }] }] } } } })
// A `home` answer the way the web player reads it: home.sectionContainer.sections.items[].sectionItems.items[].content
const home = sections => ({ home: { __typename: 'HomeResponsePayload', sectionContainer: { sections: { totalCount: sections.length, items: sections.map(items => ({ data: { __typename: 'HomeGenericSectionData' }, sectionItems: { items } })) } } } })
const track = (n, extra = {}) => ({ itemV2: { __typename: 'TrackResponseWrapper', data: { __typename: 'Track', uri: `spotify:track:${id('t', n)}`, name: `Song ${n}`, artists: { items: [{ profile: { name: `Artist ${n % 3}` } }, { profile: { name: 'Guest' } }] }, albumOfTrack: { name: `Album ${n}`, coverArt: { sources: [{ url: `cover${n}`, width: 300 }] } }, trackDuration: { totalMilliseconds: 180500 }, ...extra } } })

const DW = `spotify:playlist:37i9dQZEVXcX${'a'.repeat(10)}`
const RR = `spotify:playlist:37i9dQZEVXbX${'b'.repeat(10)}`
const DAILY = `spotify:playlist:37i9dQZF1E3${'c'.repeat(11)}`
const EDITORIAL = 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'
const USERS = `spotify:playlist:${'u'.repeat(22)}`

test('Made For You: Spotify-made playlists only, personal ones first, no repeats', async () => {
  const asked = []
  const query = async (op, variables) => { asked.push([op, variables]); return home([[playlist(EDITORIAL, "Today's Top Hits"), playlist(USERS, 'Road trip', 'someone')], [playlist(DW, 'Discover Weekly'), playlist(RR, 'Release Radar'), playlist(DW, 'Discover Weekly')], [{ uri: 'spotify:album:x', content: { __typename: 'AlbumResponseWrapper', data: { __typename: 'Album' } } }, playlist(DAILY, 'Daily Mix 1')]]) }
  const mixes = await madeForYou('', { query })
  assert.deepEqual(mixes.map(mix => mix.title), ['Discover Weekly', 'Release Radar', 'Daily Mix 1', "Today's Top Hits"])
  assert.deepEqual(mixes.map(mix => mix.personal), [true, true, true, false])
  assert.equal(mixes[0].thumbnail, 'big')
  assert.equal(mixes[0].description, 'Discover Weekly for you')
  assert.equal(asked[0][0], 'home')
  assert.equal(asked[0][1].homeEndUserIntegration, 'INTEGRATION_WEB_PLAYER')
})

test('Made For You: an unreadable Home is an error, not an empty list', async () => {
  await assert.rejects(madeForYou('', { query: async () => ({ home: null }) }), /couldn't be read/)
  assert.deepEqual(homeMixes(null), [])
})

test('no cookie: asks for one before calling Spotify', async () => {
  await assert.rejects(madeForYou(''), /sp_dc/)
  await assert.rejects(playlistTracks('', DW), /sp_dc/)
  await assert.rejects(playlistTracks('x', 'spotify:album:nope'), /Not a Spotify playlist/)
})

test('playlist songs: tracks only, with artists, album, cover and duration', () => {
  const song = playlistEntry(track(4))
  assert.deepEqual(song, { title: 'Song 4', artist: 'Artist 1, Guest', artists: ['Artist 1', 'Guest'], album: 'Album 4', duration: 180.5, artwork_url: 'cover4', spotifyUri: `spotify:track:${id('t', 4)}`, source: 'spotify' })
  assert.equal(playlistEntry({ itemV2: { __typename: 'EpisodeOrChapterResponseWrapper', data: { __typename: 'Episode', name: 'Podcast' } } }), null)
  assert.equal(playlistEntry({ itemV2: { __typename: 'LocalTrackResponseWrapper', data: { __typename: 'LocalTrack', name: 'file' } } }), null)
  assert.equal(playlistEntry(track(1, { artists: { items: [] } })), null)
  assert.equal(playlistEntry(null), null)
})

test('playlist songs: pages of 100 until the end, capped', async () => {
  const all = Array.from({ length: 230 }, (_, n) => track(n))
  const asked = []
  const query = async (op, { uri, offset, limit }) => { asked.push([op, uri, offset, limit]); return { playlistV2: { __typename: 'Playlist', name: 'Discover Weekly', content: { totalCount: all.length, items: all.slice(offset, offset + limit) } } } }
  const full = await playlistTracks('', DW, { query, max: 1000 })
  assert.equal(full.title, 'Discover Weekly')
  assert.equal(full.tracks.length, 230)
  assert.deepEqual(asked.map(a => a[2]), [0, 100, 200])
  assert.ok(asked.every(a => a[0] === 'fetchPlaylist' && a[1] === DW && a[3] === 100))
  asked.length = 0
  assert.equal((await playlistTracks('', DW, { query })).tracks.length, 200)
  assert.deepEqual(asked.map(a => a[2]), [0, 100])
})

test('saved Spotify playlists load past 1,000 tracks without changing Discovery limits', async () => {
  const all = Array.from({ length: 1234 }, (_, n) => track(n))
  const offsets = []
  const query = async (_, { offset, limit }) => {
    offsets.push(offset)
    return { playlistV2: { __typename: 'Playlist', name: 'Large library', content: {
      totalCount: all.length, items: all.slice(offset, offset + limit),
    } } }
  }
  const full = await playlistTracks('', DW, { query, max: null })
  assert.equal(full.tracks.length, 1234)
  assert.deepEqual(offsets, Array.from({ length: 13 }, (_, i) => i * 100))
  offsets.length = 0
  assert.equal((await playlistTracks('', DW, { query })).tracks.length, 200)
  assert.deepEqual(offsets, [0, 100])
})

test('Spotify pagination advances by actual page size, and rejects an incomplete library', async () => {
  const all = Array.from({ length: 132 }, (_, n) => track(n))
  const offsets = []
  const query = async (_, { offset }) => {
    offsets.push(offset)
    return { playlistV2: { __typename: 'Playlist', content: {
      totalCount: all.length, items: all.slice(offset, offset + 40),
    } } }
  }
  assert.equal((await playlistTracks('', DW, { query, max: null })).tracks.length, 132)
  assert.deepEqual(offsets, [0, 40, 80, 120])
  const broken = async (_, { offset }) => ({ playlistV2: {
    __typename: 'Playlist', content: {
      totalCount: 150, items: offset >= 100 ? [] : all.slice(0, 100),
    },
  } })
  await assert.rejects(playlistTracks('', DW, { query: broken, max: null }), /before loading all/)
})

test('a 1900-entry playlist reads all 19 pages and reports unavailable Spotify entries', async () => {
  const all = Array.from({ length: 1900 }, (_, n) => n < 1200 ? track(n) : {
    itemV2: { __typename: 'LocalTrackResponseWrapper', data: { __typename: 'LocalTrack', name: 'Local only' } },
  })
  const offsets = []
  const result = await playlistTracks('', DW, { max: null, query: async (_, { offset, limit }) => {
    offsets.push(offset)
    return { playlistV2: { __typename: 'Playlist', content: { totalCount: all.length, items: all.slice(offset, offset + limit) } } }
  } })
  assert.equal(result.total, 1900)
  assert.equal(result.tracks.length, 1200)
  assert.equal(result.unavailable, 700)
  assert.deepEqual(offsets, Array.from({ length: 19 }, (_, n) => n * 100))
})

test('playlist songs: a missing playlist says so', async () => {
  await assert.rejects(playlistTracks('', DW, { query: async () => ({ playlistV2: { __typename: 'NotFound', message: 'Not found' } }) }), /Not found/)
})

test('Discovery page: fresh songs and distinct Quick Picks from rotating personal mixes', async () => {
  const mixes = [DW, RR, DAILY].map((uri, n) => ({ id: uri, title: `Mix ${n}`, personal: true, thumbnail: `img${n}` })).concat({ id: EDITORIAL, title: 'Editorial', personal: false })
  const opened = []
  const client = {
    spotifyMadeForYou: async force => ({ mixes, force }),
    spotifyPlaylist: async uri => { opened.push(uri); const n = mixes.findIndex(mix => mix.id === uri); return { tracks: [0, 1].map(k => ({ ...playlistEntry(track(n * 10 + k)) })) } },
  }
  const first = await loadRecommendationPage('spotify', 0, client)
  assert.equal(first.source, 'spotify')
  assert.deepEqual(opened, [DW, RR, DAILY])
  assert.equal(first.mixes.length, 4)
  assert.ok(first.mixes.every(mix => mix.source === 'spotify'))
  assert.equal(first.mixes[0].artwork_url, 'img0')
  assert.deepEqual(first.freshFinds.map(song => song.title), ['Song 0', 'Song 1', 'Song 10', 'Song 11'])
  assert.deepEqual(first.quickPicks.map(song => song.title), ['Song 20', 'Song 21'])
  assert.ok(first.artists.some(artist => artist.name === 'Guest'))
  assert.equal(first.albums.length, 6)
  opened.length = 0
  await loadRecommendationPage('spotify', 1, client)
  assert.deepEqual(opened, [DAILY, DW, RR])
  assert.equal(sourceName('spotify'), 'Spotify')
})

test('Discovery page: no cookie or a failed Home is shown as an error', async () => {
  const result = await loadRecommendationPage('spotify', 0, { spotifyMadeForYou: async () => ({ mixes: [], error: 'Add your Spotify cookie' }), spotifyPlaylist: async () => ({ tracks: [] }) })
  assert.deepEqual(result, { error: 'Add your Spotify cookie' })
})

test('Discovery page: one mix failing keeps the other one', async () => {
  const client = {
    spotifyMadeForYou: async () => ({ mixes: [{ id: DW, title: 'DW', personal: true }, { id: RR, title: 'RR', personal: true }] }),
    spotifyPlaylist: async uri => uri === DW ? { tracks: [], error: 'Spotify is limiting requests right now.' } : { tracks: [playlistEntry(track(7))] },
  }
  const result = await loadRecommendationPage('spotify', 0, client)
  assert.deepEqual(result.freshFinds.map(song => song.title), ['Song 7'])
  assert.deepEqual(result.warnings, ['Spotify is limiting requests right now.'])
})
