import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import youtube from '../electron/online/youtube.js'
import spotify from '../electron/artwork/spotify.js'
import {
  DISCOVERY_SHELF_DEFAULTS, DISCOVERY_SHELF_TITLES,
  restoreShelfLayout, visibleShelfIds, moveShelf, showShelf,
  readShelfLayout, writeShelfLayout, shelfStorageKey,
} from '../src/discoveryShelfLayout.mjs'
import { loadRecommendationPage } from '../src/recommendations.js'

test('mobile discovery IDs, defaults and section names match on Desktop', () => {
  assert.deepEqual(DISCOVERY_SHELF_DEFAULTS.youtube, [
    'mixes', 'community', 'newReleases', 'trending', 'featuredPlaylists',
    'dailyDiscover', 'fresh', 'quick', 'artists',
  ])
  assert.deepEqual(DISCOVERY_SHELF_DEFAULTS.lastfm, ['albums', 'fresh', 'artists'])
  assert.deepEqual(DISCOVERY_SHELF_DEFAULTS.spotify, ['mixes', 'fresh', 'quick', 'history', 'albums', 'artists'])
  assert.equal(DISCOVERY_SHELF_TITLES.community, 'From the community')
  assert.equal(DISCOVERY_SHELF_TITLES.dailyDiscover, 'Your daily discover')
})

test('reorder and disable are independent, restore missing newly added shelves', () => {
  const original = restoreShelfLayout('youtube', { order: ['trending', 'mixes', 'trending', 'removed'], hidden: ['mixes', 'removed'] })
  assert.deepEqual(original.order.slice(0, 2), ['trending', 'mixes'])
  assert.equal(new Set(original.order).size, DISCOVERY_SHELF_DEFAULTS.youtube.length)
  assert.deepEqual(original.hidden, ['mixes'])
  assert.equal(visibleShelfIds(original)[0], 'trending')
  const moved = moveShelf(original, original.order.indexOf('dailyDiscover'), 0)
  assert.equal(moved.order[0], 'dailyDiscover')
  assert.equal(moved.hidden[0], 'mixes')
  const enabled = showShelf(moved, 'mixes', true)
  assert.ok(visibleShelfIds(enabled).includes('mixes'))
  assert.ok(!original.hidden.includes('futureShelf'))
  assert.strictEqual(moveShelf(enabled, -1, 0), enabled)
  assert.strictEqual(showShelf(enabled, 'invalidShelf', false), enabled)
})

test('layouts are saved independently per user and provider and recover malformed records', () => {
  const state = new Map()
  const storage = { getItem: k => state.get(k) ?? null, setItem: (k,v) => state.set(k,v) }
  const user = 'user A'
  const youtubeLayout = showShelf(moveShelf(restoreShelfLayout('youtube'), 5, 0), 'mixes', false)
  writeShelfLayout(storage, user, 'youtube', youtubeLayout)
  assert.deepEqual(readShelfLayout(storage, user, 'youtube'), youtubeLayout)
  assert.notDeepEqual(readShelfLayout(storage, user, 'spotify'), youtubeLayout)
  assert.deepEqual(readShelfLayout(storage, 'user B', 'youtube'), restoreShelfLayout('youtube'))
  state.set(shelfStorageKey(user, 'lastfm'), '{bad')
  assert.deepEqual(readShelfLayout(storage, user, 'lastfm'), restoreShelfLayout('lastfm'))
})

const song = id => ({
  musicTwoRowItemRenderer: {
    title: { simpleText: 'Song ' + id },
    navigationEndpoint: { watchEndpoint: { videoId: id } },
    subtitle: { simpleText: 'Artist • Album' },
  },
})
const playlist = (id, title) => ({
  musicTwoRowItemRenderer: {
    title: { simpleText: title },
    navigationEndpoint: { watchPlaylistEndpoint: { playlistId: id } },
  },
})
const album = id => ({
  musicTwoRowItemRenderer: {
    title: { simpleText: 'Album ' + id },
    navigationEndpoint: { browseEndpoint: { browseId: id,
      browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' } } } },
  },
})
const shelf = (title, contents) => ({ musicCarouselShelfRenderer: {
  header: { musicCarouselShelfBasicHeaderRenderer: { title: { simpleText: title } } }, contents,
} })

test('named YouTube Music Home shelves use provider content and preserve grouped mixed cards', () => {
  const root = [
    shelf('From the community', [song('abcdefghijk'), song('abcdefghijk'), playlist('PLtest', 'Community playlist')]),
    shelf('New releases', [album('MPREfresh'), song('bcdefghijkl')]),
    shelf('Trending songs for you', [song('cdefghijklm')]),
    shelf('Featured playlists for you', [playlist('PLfeatured', 'Featured playlist')]),
    shelf('Your daily discover', [song('defghijklmn')]),
    shelf('Unrelated YouTube shelf', [song('efghijklmno')]),
  ]
  const categories = youtube.parseAccountHomeCategories(root)
  assert.deepEqual(categories.map(category => category.id),
    ['community','newReleases','trending','featuredPlaylists','dailyDiscover'])
  assert.deepEqual(categories[0].tracks.map(item => item.videoId), ['abcdefghijk'])
  assert.deepEqual(categories[0].mixes.map(item => item.id), ['PLtest'])
  assert.equal(categories[1].albums[0].title, 'Album MPREfresh')
  assert.equal(categories[3].mixes[0].title, 'Featured playlist')
  assert.equal(categories[4].tracks[0].title, 'Song defghijklmn')
  assert.equal(youtube.youtubeHomeCategory('experimental electronic dance'), null)
})

test('YouTube account categories reach the desktop recommendation session without fabricated search results', async () => {
  const account = {
    home: [], homePlaylists: [], liked: [], history: [], mixes: [],
    categories: [{ id: 'trending', tracks: [{ videoId: 'abcdefghijk', title: 'Real Home Song', artist: 'Singer', thumbnail: 'https://example.com/art.jpg' }], mixes: [], albums: [] }],
  }
  const result = await loadRecommendationPage('youtube', 0, {
    youtubeAccount: async () => account,
  })
  assert.equal(result.categories.length, 1)
  assert.equal(result.categories[0].id, 'trending')
  assert.equal(result.categories[0].tracks[0].source, 'youtube')
  assert.equal(result.categories[0].tracks[0].artwork_url, 'https://example.com/art.jpg')
  assert.deepEqual(result.quickPicks, [])
})

test('Spotify Quick Picks use a different set of personal playlists than Fresh Finds', async () => {
  const requested = []
  const result = await loadRecommendationPage('spotify', 0, {
    spotifyMadeForYou: async () => ({ mixes: ['DW','RR','Daily1','Daily2'].map(id => ({ id, title: id, personal: true })) }),
    spotifyPlaylist: async id => {
      requested.push(id)
      return { tracks: [{ title: 'Song ' + id, artist: 'Artist ' + id }] }
    },
  })
  assert.deepEqual(requested, ['DW','RR','Daily1','Daily2'])
  assert.deepEqual(result.freshFinds.map(track => track.title), ['Song DW','Song RR'])
  assert.deepEqual(result.quickPicks.map(track => track.title), ['Song Daily1','Song Daily2'])
  assert.deepEqual(result.history, [], 'no fabricated Spotify recent-listening history')
})

test('Spotify recently played parses actual provider timestamps and never invents history', async () => {
  const item = {
    played_at: '2026-10-29T18:30:00.000Z',
    track: {
      id: 'a'.repeat(22), uri: 'spotify:track:' + 'a'.repeat(22), name: 'Actual Song',
      artists: [{ name: 'Artist' }], duration_ms: 213000,
      album: { name: 'Actual Album', images: [
        { url: 'https://example.com/small', width: 64 },
        { url: 'https://example.com/large', width: 640 },
      ] },
    },
  }
  const tracks = await spotify.recentlyPlayed('', { fetchPage: async () => ({
    items: [item, { played_at: 'yesterday', track: null }],
  }) })
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].title, 'Actual Song')
  assert.equal(tracks[0].artist, 'Artist')
  assert.equal(tracks[0].album, 'Actual Album')
  assert.equal(tracks[0].artwork_url, 'https://example.com/large')
  assert.equal(tracks[0].scrobbledAt, 1793298600)
  assert.equal(tracks[0].source, 'spotify')
  assert.deepEqual(await spotify.recentlyPlayed('', { fetchPage: async () => ({ items: [] }) }), [])
  const ipc = readFileSync(new URL('../electron/ipc/spotifyLikes.js', import.meta.url), 'utf8')
  assert.match(ipc, /ipcMain\.handle\('spotify:recentlyPlayed'/)
  assert.match(ipc, /return \{ tracks: \[\], error: error\.message \}/)
  const preload = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
  assert.match(preload, /spotifyRecentlyPlayed: \(force\) => invoke\('spotify:recentlyPlayed', force\)/)
})

test('real Spotify history flows into the customizable Recently Played section', async () => {
  const history = [{ id: 'sp-1', title: 'Recent Song', artist: 'Test Artist', scrobbledAt: 1793298600 }]
  const result = await loadRecommendationPage('spotify', 0, {
    spotifyMadeForYou: async () => ({ mixes: [] }),
    spotifyPlaylist: async () => ({ tracks: [] }),
    spotifyRecentlyPlayed: async () => ({ tracks: history }),
  })
  assert.deepEqual(result.history, history)
})

test('Home right-click Edit opens category modal; rendering follows saved order, not fixed sections', () => {
  const home = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8')
  const editor = readFileSync(new URL('../src/components/DiscoveryShelfEditor.jsx', import.meta.url), 'utf8')
  const provider = readFileSync(new URL('../src/recommendationSession.js', import.meta.url), 'utf8')
  assert.match(home, /onContextMenu=\{onContextMenu\}/)
  assert.match(home, /const openMenu = \(event, items\) => \{\s*menuRequestRef\.current\+\+/)
  assert.match(home, /onEditCategory: event => openMenu\(event, \[\{ label: 'Edit'/)
  assert.match(home, /visibleShelfIds\(layout\)/)
  assert.match(home, /data-discovery-shelf=\{id\}/)
  assert.match(home, /categoryMap\.get\(id\)/)
  assert.match(home, /readShelfLayout\(window\.localStorage, uidKey, provider\)/)
  assert.match(home, /writeShelfLayout\(window\.localStorage, uidKey, provider, safe\)/)
  assert.match(home, /<DiscoveryShelfEditor open=\{showDiscoveryEditor\}/)
  assert.match(editor, /onDragStart=\{event =>/)
  assert.match(editor, /onDrop=\{event =>/)
  assert.match(editor, /showShelf\(layout, id, event\.target\.checked\)/)
  assert.match(editor, /Move \{name\} up/)
  assert.match(provider, /categories: section\('categories'\)/)
})
