import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'

globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} }

const { downloadGhostSongs, ghostDownloadMessage, redownloadMissingTrack } = await import('../src/ghostDownloads.js')

const imported = (i) => ({ id: `g${i}`, title: `Song ${i}`, artist: `Artist ${i}`, file_path: `ghost://spotify/pl-1/g${i}` })

function client({ inLibrary = [], online = [] } = {}) {
  const swaps = []
  return {
    swaps,
    getSettings: async () => ({ playback_search_order: JSON.stringify(['yt']) }),
    onlineProviders: async () => [{ id: 'yt' }],
    searchTracks: async (title) => inLibrary.filter(t => t.title === title),
    onlineSearch: async (query) => ({ results: online.filter(t => query.includes(t.title)).map(t => ({ ...t, id: t.vid, provider: 'yt' })) }),
    onlinePrepare: async () => ({ ok: true }),
    onlineSave: async items => items.map(item => ({ ...item, id: `yt-${item.id}`, file_path: `ghost://youtube/online/${item.id}` })),
    resolveGhostTrack: async (ghostId, targetId) => { swaps.push([ghostId, targetId]); return { ok: true } },
  }
}

test('each imported ghost is found on the playback sources and downloaded to take its place', async () => {
  const saved = []
  const c = client({ online: [{ title: 'Song 1', artist: 'Artist 1', vid: 'aaaaaaaaaa1' }, { title: 'Song 2', artist: 'Artist 2', vid: 'aaaaaaaaaa2' }] })
  const progress = []
  const result = await downloadGhostSongs([imported(1), imported(2)], { client: c, save: async (track, extra) => { saved.push([track.id, extra?.replaceImported]); return { downloadId: 'd' } }, onProgress: m => progress.push(m) })
  assert.deepEqual(result, { started: 2, existing: 0, failed: 0, notFound: 0 })
  assert.deepEqual(saved.sort(), [['yt-aaaaaaaaaa1', ['g1']], ['yt-aaaaaaaaaa2', ['g2']]])
  assert.equal(progress.at(-1), 'Finding and queuing songs… 2/2')
})

test('a song already in the library takes the ghost\'s place at once, no download', async () => {
  const saved = []
  const c = client({ inLibrary: [{ id: 'file-1', title: 'Song 1', artist: 'Artist 1', file_path: '/music/1.flac' }] })
  const result = await downloadGhostSongs([imported(1)], { client: c, save: async t => { saved.push(t); return {} } })
  assert.deepEqual(result, { started: 0, existing: 1, failed: 0, notFound: 0 })
  assert.deepEqual(c.swaps, [['g1', 'file-1']])
  assert.equal(saved.length, 0)
})

test('not found, failed downloads and streamed ghosts are told apart', async () => {
  const streamed = { id: 'yt-bbbbbbbbbbb', title: 'Streamed', artist: 'X', file_path: 'ghost://youtube/online/bbbbbbbbbbb' }
  const saved = []
  const c = client({ online: [{ title: 'Song 2', artist: 'Artist 2', vid: 'aaaaaaaaaa2' }] })
  const result = await downloadGhostSongs([imported(1), imported(2), streamed, { id: 'f', title: 'A file', artist: 'B', file_path: '/m/a.flac' }], {
    client: c, save: async (track, extra) => { saved.push([track.id, extra?.replaceImported]); return track.id === 'yt-bbbbbbbbbbb' ? { alreadyInLibrary: true } : { error: 'no' } },
  })
  assert.deepEqual(result, { started: 0, existing: 1, failed: 1, notFound: 1 })
  assert.deepEqual(saved.sort(), [['yt-aaaaaaaaaa2', ['g2']], ['yt-bbbbbbbbbbb', undefined]])
  assert.equal(ghostDownloadMessage(result), '1 already in your library; 1 not found on your playback sources; 1 unavailable')
})

test('streamed ghosts pass canonical metadata and cancellation to the downloader', async () => {
  const ghost = { id: 'yt-bbbbbbbbbbb', title: 'Canonical title', artist: 'Canonical artist', album: 'Album', duration: 201, file_path: 'ghost://youtube/online/bbbbbbbbbbb' }
  const saved = []
  const result = await downloadGhostSongs([ghost], {
    client: client(),
    save: async (track, options) => { saved.push({ track, options }); return {} },
  })
  assert.equal(result.started, 1)
  assert.equal(saved[0].track, ghost)
  assert.deepEqual(saved[0].options.tags, { title: ghost.title, artist: ghost.artist, album: ghost.album })
  assert.equal(saved[0].options.expectedDuration, 201)
  assert.equal(saved[0].options.isCurrent(), true)
})

test('a missing downloaded file can be restored without changing its track identity', async () => {
  const calls = []
  const c = {
    downloadYT: async (url, options) => { calls.push({ url, options }); return { downloadId: 'repair-1' } },
  }
  const result = await redownloadMissingTrack({
    id: 'track-42', missing: true, source_ref: 'yt:abcdefghijk',
    title: 'Song', artist: 'Artist', album: 'Album', duration: 201,
  }, { client: c })
  assert.equal(result.downloadId, 'repair-1')
  assert.equal(calls[0].url, 'https://music.youtube.com/watch?v=abcdefghijk')
  assert.equal(calls[0].options.upgradeTrackId, 'track-42')
  assert.equal(calls[0].options.expectedDuration, 201)
})

test('1,901 CSV ghosts follow addon, YouTube, SoundCloud order and keep each replacement identity', async () => {
  const count = 1901
  const providers = ['a-0123456789', 'yt', 'sc']
  const attempts = new Map()
  const saved = []
  const ghosts = Array.from({ length: count }, (_, i) => ({ ...imported(i), duration: 200 + i % 30 }))
  const client = {
    getSettings: async () => ({ playback_search_order: JSON.stringify(providers) }),
    onlineProviders: async () => providers.map(id => ({ id })),
    searchTracks: async () => [],
    onlineSearch: async (query, provider) => {
      const i = Number(query.match(/Song (\d+)/)[1])
      const log = attempts.get(i) || []
      if (log.at(-1) !== provider) log.push(provider)
      attempts.set(i, log)
      const wanted = providers[i % 3]
      if (provider !== wanted) return { results: [] }
      return { results: [{ id: provider === 'yt' ? String(i).padStart(11, '0') : String(i), provider, title: `Song ${i}`, artist: `Artist ${i}`, duration: 200 + i % 30 }] }
    },
    onlinePrepare: async () => ({ ok: true }),
    onlineSave: async items => items.map(item => ({ ...item,
      id: `${item.provider}-${item.id}`,
      file_path: item.provider === 'yt' ? `ghost://youtube/online/${item.id}` : item.provider === 'sc' ? `ghost://soundcloud/online/${item.id}` : `ghost://addon/0123456789/${item.id}`,
    })),
  }
  const result = await downloadGhostSongs(ghosts, { client, concurrency: 6, save: async (track, options) => { saved.push({ track, options }); return { downloadId: track.id } } })
  assert.deepEqual(result, { started: count, existing: 0, failed: 0, notFound: 0 })
  assert.equal(new Set(saved.map(item => item.options.replaceImported[0])).size, count)
  for (let i = 0; i < count; i++) assert.deepEqual(attempts.get(i), providers.slice(0, i % 3 + 1))
  for (const { track, options } of saved) {
    const i = Number(track.title.slice(5))
    assert.equal(track.provider, providers[i % 3])
    assert.deepEqual(options.replaceImported, [`g${i}`])
    assert.equal(options.tags.title, ghosts[i].title)
    assert.equal(options.tags.artist, ghosts[i].artist)
    assert.equal(options.expectedDuration, ghosts[i].duration)
  }
})


test('supplied CSV collaborations resolve with lead-only source search and retain every credit', { skip: !process.env.LOKAL_STRESS_CSV }, async t => {
  const { searchTitle } = await import('../src/recommendations.js')
  const rows = JSON.parse(execFileSync('python3', ['-c', 'import csv,json,sys; print(json.dumps(list(csv.DictReader(open(sys.argv[1],encoding="utf-8-sig")))))', process.env.LOKAL_STRESS_CSV], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }))
    .filter(row => row['Artist Name(s)'].includes(';'))
  assert.ok(rows.length > 0)
  const providers = ['a-0123456789', 'yt', 'sc']
  const ghosts = rows.map((row, i) => ({ id: `csv-${i}`, file_path: `ghost://import/csv/${i}`, title: row['Track Name'],
    artist: [...new Set(row['Artist Name(s)'].split(/[;,]/).map(s => s.trim()).filter(Boolean))].join(', '), album: row['Album Name'], duration: Number(row['Duration (ms)']) / 1000 }))
  const catalogue = new Map()
  rows.forEach((row, i) => {
    const artist = row['Artist Name(s)'].split(';')[0]
    const query = `${artist} ${searchTitle(row['Track Name'])}`
    if (!catalogue.has(query)) catalogue.set(query, { id: String(i).padStart(11, '0'), title: row['Track Name'], artist, provider: providers[i % 3] })
  })
  const saved = []
  const attempts = []
  const client = {
    getSettings: async () => ({ playback_search_order: JSON.stringify(providers) }),
    onlineProviders: async () => providers.map(id => ({ id })),
    searchTracks: async () => [],
    onlineSearch: async (query, provider) => {
      const match = catalogue.get(query)
      attempts.push({ query, provider })
      return { results: match?.provider === provider ? [match] : [] }
    },
    onlinePrepare: async () => ({ ok: true }),
    onlineSave: async items => items.map(item => ({ ...item, id: `${item.provider}-${item.id}`,
      file_path: item.provider === 'yt' ? `ghost://youtube/online/${item.id}` : item.provider === 'sc' ? `ghost://soundcloud/online/${item.id}` : `ghost://addon/0123456789/${item.id}` })),
  }
  const result = await downloadGhostSongs(ghosts, { client, concurrency: 6, save: async (track, options) => { saved.push({ track, options }); return { downloadId: track.id } } })
  assert.deepEqual(result, { started: ghosts.length, existing: 0, failed: 0, notFound: 0 })
  assert.equal(new Set(saved.map(item => item.options.replaceImported[0])).size, ghosts.length)
  for (const { options } of saved) {
    const ghost = ghosts[Number(options.replaceImported[0].slice(4))]
    assert.deepEqual(options.tags, { title: ghost.title, artist: ghost.artist, album: ghost.album })
    assert.equal(options.expectedDuration, ghost.duration)
  }
  for (const [query, match] of catalogue) assert.deepEqual(attempts.filter(a => a.query === query).map(a => a.provider).filter((p, i, all) => all.indexOf(p) === i), providers.slice(0, providers.indexOf(match.provider) + 1))
  t.diagnostic(`${ghosts.length} actual CSV collaborations resolved with addon → YouTube → SoundCloud fallback; canonical credits preserved.`)
})

test('CSV duration skips a short addon edit and queues a matching YouTube upload with canonical tags', async () => {
  const ghost = { ...imported(1), title: 'Ring My Bell', artist: 'Anita Ward', album: 'Ring My Bell', duration: 491.933 }
  const providers = ['a-0123456789', 'yt', 'sc']
  const attempts = [], saved = []
  const c = {
    ...client(),
    getSettings: async () => ({ playback_search_order: JSON.stringify(providers) }),
    onlineProviders: async () => providers.map(id => ({ id })),
    onlineSearch: async (_query, provider) => {
      attempts.push(provider)
      return { results: provider === providers[0] ? [{ id: 'short', title: ghost.title, artist: ghost.artist, duration: 210 }] : [] }
    },
    searchYT: async () => {
      attempts.push('yt-video')
      return { results: [{ id: 'abcdefghijk', title: 'Anita Ward - Ring My Bell', channel: 'malacomg', duration: 492 }] }
    },
  }
  const result = await downloadGhostSongs([ghost], { client: c, save: async (track, options) => { saved.push({ track, options }); return { downloadId: 'one' } } })
  assert.deepEqual(result, { started: 1, existing: 0, failed: 0, notFound: 0 })
  assert.deepEqual(attempts, [providers[0], 'yt', 'yt-video'])
  assert.equal(saved[0].track.id, 'yt-abcdefghijk')
  assert.deepEqual(saved[0].options.tags, { title: ghost.title, artist: ghost.artist, album: ghost.album })
  assert.equal(saved[0].options.expectedDuration, 491.933)
  assert.deepEqual(saved[0].options.replaceImported, [ghost.id])
})

test('CSV duration selects the full addon recording instead of downloading the first shorter result', async () => {
  const ghost = { ...imported(1), title: 'Ring My Bell', artist: 'Anita Ward', duration: 491.933 }
  const addon = 'a-0123456789'
  const c = {
    ...client(),
    getSettings: async () => ({ playback_search_order: JSON.stringify([addon, 'yt']) }),
    onlineProviders: async () => [{ id: addon }, { id: 'yt' }],
    onlineSearch: async (_query, provider) => {
      assert.equal(provider, addon)
      return { results: [{ id: 'short', title: ghost.title, artist: ghost.artist, duration: 210 }, { id: 'full', title: ghost.title, artist: ghost.artist, duration: 492 }] }
    },
    onlineSave: async items => items.map(item => ({ ...item, file_path: `ghost://addon/0123456789/${item.id}` })),
  }
  const result = await downloadGhostSongs([ghost], { client: c, save: async track => { assert.equal(track.id, 'full'); return {} } })
  assert.equal(result.started, 1)
})

for (const accept of [true, false]) {
  test(`Ring My Bell differing length requires approval (${accept})`, async () => {
    const ghost = { ...imported(1), title: 'Ring My Bell', artist: 'Anita Ward', duration: 491.933 }
    const c = client({ online: [{ title: ghost.title, artist: ghost.artist, duration: 210, vid: 'aaaaaaaaaa1' }] })
    const saved = [], prompts = []
    const result = await downloadGhostSongs([ghost], {
      client: c, confirmDuration: async (wanted, found) => { prompts.push([wanted.duration, found.duration]); return accept },
      save: async (track, options) => { saved.push(options); return {} },
    })
    assert.deepEqual(prompts, [[491.933, 210]])
    assert.equal(result.started, accept ? 1 : 0)
    if (accept) {
      assert.equal(saved[0].expectedDuration, 210)
      assert.deepEqual(saved[0].confirmedImported, [ghost.id])
      assert.deepEqual(saved[0].replaceImported, [ghost.id])
    } else {
      assert.equal(saved.length, 0)
      assert.equal(result.declined, 1)
      assert.match(ghostDownloadMessage(result), /1 skipped/)
    }
  })
}

test('close matches stay automatic and cancellation while asking prevents download', async () => {
  const ghost = { ...imported(1), duration: 200 }
  const c = client({ online: [{ title: ghost.title, artist: ghost.artist, duration: 210, vid: 'aaaaaaaaaa1' }] })
  let prompts = 0, saves = 0, current = true
  const options = { client: c, isCurrent: () => current, save: async () => { saves++; return {} }, confirmDuration: async () => { prompts++; current = false; return true } }
  assert.equal((await downloadGhostSongs([ghost], options)).started, 1)
  assert.equal(prompts, 0)
  ghost.duration = 492
  assert.equal((await downloadGhostSongs([ghost], options)).cancelled, true)
  assert.equal(prompts, 1)
  assert.equal(saves, 1)
})

test('approved library version forwards duration permission without downloading', async () => {
  const ghost = { ...imported(1), duration: 492 }
  const c = client({ inLibrary: [{ ...ghost, duration: 210, id: 'local', file_path: '/music/song.flac' }] })
  let options
  c.resolveGhostTrack = async (id, target, opts) => { options = opts; return { ok: true } }
  const result = await downloadGhostSongs([ghost], { client: c, confirmDuration: async () => true, save: async () => assert.fail('must reuse local file') })
  assert.equal(result.existing, 1)
  assert.equal(options.allowDurationMismatch, true)
  assert.equal(options.requireMetadataMatch, true)
})

test('manual suggestion downloads and replaces only its selected ghost', async () => {
  const { downloadGhostResult } = await import('../src/ghostDownloads.js')
  const ghost = { ...imported(1), duration: 492 }
  const item = { url: 'https://youtube.com/watch?v=aaaaaaaaaaa', title: 'Artist 1 - Song 1', channel: 'Uploader', duration: 210 }
  const calls = []
  const client = { downloadYT: async (...args) => { calls.push(args); return { downloadId: 'job' } } }
  assert.equal((await downloadGhostResult(ghost, item, { client, confirmDuration: async () => false })).cancelled, true)
  assert.equal(calls.length, 0)
  await downloadGhostResult(ghost, item, { client, confirmDuration: async () => true })
  const [url, opts] = calls[0]
  assert.equal(url, item.url)
  assert.deepEqual(opts.replaceImported, [ghost.id])
  assert.deepEqual(opts.confirmedImported, [ghost.id])
  assert.deepEqual(opts.manuallySelectedImported, [ghost.id])
  assert.equal(opts.expectedDuration, 210)
  assert.equal(opts.tags.artist, ghost.artist)
  assert.equal(opts.tags.title, ghost.title)
})

test('a close match on the next source takes priority over an earlier different length', async () => {
  const ghost = { ...imported(1), duration: 200 }
  const c = client()
  c.getSettings = async () => ({ playback_search_order: '["yt","sc"]' })
  c.onlineProviders = async () => [{ id: 'yt' }, { id: 'sc' }]
  c.onlineSearch = async (_, provider) => ({ results: [{ title: ghost.title, artist: ghost.artist, id: provider === 'yt' ? 'aaaaaaaaaaa' : '123', provider, duration: provider === 'yt' ? 400 : 200 }] })
  c.onlineSave = async items => items.map(item => ({ ...item, file_path: `ghost://${item.provider === 'sc' ? 'soundcloud' : 'youtube'}/online/${item.id}` }))
  const saved = []
  await downloadGhostSongs([ghost], { client: c, confirmDuration: () => assert.fail('close match needs no approval'), save: async t => { saved.push(t); return {} } })
  assert.equal(saved[0].provider, 'sc')
})

for (const provider of ['yt', 'sc', 'a-0123456789']) {
  test(`manual suggestions search only selected source ${provider}`, async () => {
    const { ghostDownloadSuggestions } = await import('../src/ghostDownloads.js')
    const calls = []
    const c = {
      searchYT: async query => { calls.push(['yt', query]); return { results: [{ id: 'song' }, { id: 'preview', preview: true }] } },
      onlineSearch: async (query, source) => { calls.push([source, query]); return { results: [{ id: 'song' }, { id: 'preview', preview: true }] } },
    }
    const rows = await ghostDownloadSuggestions('Anita Ward Ring My Bell', provider, c)
    assert.deepEqual(calls, [[provider, 'Anita Ward Ring My Bell']])
    assert.deepEqual(rows, [{ id: 'song', provider }])
  })
}

for (const provider of ['sc', 'a-0123456789']) {
  test(`manual ${provider} result without a URL is downloaded through its provider`, async () => {
    const { downloadGhostResult } = await import('../src/ghostDownloads.js')
    const ghost = { ...imported(1), duration: 492 }
    const item = { id: '123', provider, title: ghost.title, artist: ghost.artist, duration: 210 }
    const saved = []
    const c = { onlineSave: async items => { assert.deepEqual(items, [item]); return [{ ...item, id: 'streamed', file_path: 'ghost://source/123' }] } }
    const result = await downloadGhostResult(ghost, item, { client: c, confirmDuration: async () => true, save: async (track, options) => { saved.push({ track, options }); return { downloadId: 'queued' } } })
    assert.equal(result.downloadId, 'queued')
    assert.equal(saved[0].track.provider, provider)
    assert.deepEqual(saved[0].options.replaceImported, [ghost.id])
    assert.deepEqual(saved[0].options.manuallySelectedImported, [ghost.id])
    assert.deepEqual(saved[0].options.confirmedImported, [ghost.id])
    assert.equal(saved[0].options.expectedDuration, 210)
  })
}

test('selected provider errors are reported and cancellation during preparation queues nothing', async () => {
  const { downloadGhostResult, ghostDownloadSuggestions } = await import('../src/ghostDownloads.js')
  await assert.rejects(ghostDownloadSuggestions('song', 'sc', { onlineSearch: async () => ({ error: 'Source unavailable' }) }), /Source unavailable/)
  let current = true
  const result = await downloadGhostResult(imported(1), { provider: 'sc', id: '123' }, {
    client: { onlineSave: async () => { current = false; return [{ id: 'streamed' }] } },
    isCurrent: () => current, save: () => assert.fail('cancelled selection must not download'),
  })
  assert.equal(result.cancelled, true)
})

for (const provider of ['yt', 'sc', 'a-0123456789']) {
  test(`confirmed ${provider} suggestion repairs the missing row through the download options`, async t => {
    const { downloadGhostResult } = await import('../src/ghostDownloads.js')
    const { api } = await import('../src/api.js')
    const calls = []
    t.mock.method(api, 'downloadYT', async (url, options) => { calls.push(options); return { downloadId: 'repair' } })
    t.mock.method(api, 'onlineDownloadUrl', async () => ({ url: 'https://source.example/song' }))
    const ghost = { id: 'missing', missing: true, title: 'Song', artist: 'Artist', duration: 492 }
    const item = { id: 'aaaaaaaaaaa', provider, url: 'https://youtube.com/watch?v=aaaaaaaaaaa', duration: 210 }
    const client = { downloadYT: api.downloadYT, onlineSave: async () => [{
      ...item, file_path: provider === 'sc' ? 'ghost://soundcloud/online/123' : 'ghost://addon/0123456789/123',
    }] }
    await downloadGhostResult(ghost, item, { client, confirmDuration: async () => false })
    assert.equal(calls.length, 0)
    await downloadGhostResult(ghost, item, { client, confirmDuration: async () => true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].upgradeTrackId, ghost.id)
    assert.equal(calls[0].allowUpgradeDurationMismatch, true)
    assert.equal(calls[0].expectedDuration, 210)
  })
}


test('batch repair queues every supported missing library file and reports unsupported rows', async () => {
  const { repairMissingTracks } = await import('../src/ghostDownloads.js')
  const calls = []
  const client = {
    downloadYT: async (url, options) => { calls.push({ url, options }); return { downloadId: 'queued' } },
    onlineDownloadUrl: async () => ({ url: 'https://source.example/song' }),
  }
  const rows = [
    { id: 'yt-row', title: 'YT', artist: 'Artist', duration: 200, missing: true, source_ref: 'yt:youtube123' },
    { id: 'sc-row', title: 'SC', artist: 'Artist', duration: 200, missing: true, source_ref: 'sc:456' },
    { id: 'addon-row', title: 'Addon', artist: 'Artist', duration: 200, missing: true, source_ref: 'a-0123456789:track' },
    { id: 'manual-row', title: 'Manual', artist: 'Artist', duration: 200, missing: true, source_ref: '' },
  ]
  const progress = []
  const result = await repairMissingTracks(rows, {
    client,
    concurrency: 2,
    onProgress: value => progress.push(value.done),
  })
  assert.equal(result.total, 4)
  assert.equal(result.queued, 3)
  assert.equal(result.unsupported, 1)
  assert.equal(result.failed, 0)
  assert.deepEqual(progress.sort((a, b) => a - b), [1, 2, 3, 4])
  assert.equal(calls.length, 3)
})

const { downloadMissingCollectionTracks } = await import('../src/ghostDownloads.js')
const { downloadMissingProviderTracks } = await import('../src/ghostDownloads.js')

test('Spotify provider metadata downloads skip library files and repeated entries without importing fake IDs', async () => {
  const c = client({
    inLibrary: [{ id: 'owned', title: 'Song 1', artist: 'Artist 1', file_path: '/music/owned.flac' }],
    online: [{ title: 'Song 2', artist: 'Artist 2', vid: 'aaaaaaaaaa2' }],
  })
  const saved = [], progress = []
  const rows = [1, 2, 2, 3].map((n, i) => ({ id: `display-${i}`, spotifyUri: `spotify:track:${n}`, title: `Song ${n}`, artist: `Artist ${n}`, duration: 200 }))
  const result = await downloadMissingProviderTracks(rows, { client: c,
    save: async (track, options) => { saved.push({ track, options }); return { downloadId: 'queued' } },
    onProgress: message => progress.push(message),
  })
  assert.deepEqual(result, { started: 1, existing: 1, failed: 0, notFound: 1 })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].options.replaceImported, undefined)
  assert.equal(saved[0].options.expectedDuration, 200)
  assert.equal(saved[0].options.tags.title, 'Song 2')
  assert.equal(progress.at(-1), 'Finding and queuing songs… 3/3')
  assert.deepEqual(c.swaps, [])
})

test('YouTube provider downloads retain the exact video and honor cancellation', async () => {
  let current = true
  const c = client(), prepared = [], saved = []
  c.onlineSave = async rows => { prepared.push(...rows); return rows.map(row => ({ ...row, id: `yt-${row.id}`, file_path: `ghost://youtube/online/${row.id}` })) }
  c.onlinePrepare = async () => { throw new Error('Downloading must not prepare playback streams') }
  const result = await downloadMissingProviderTracks(['abcdefghijk', 'lmnopqrstuv'].map(videoId => ({ title: videoId, artist: 'Band', videoId, source: 'youtube' })), {
    client: c, concurrency: 1, isCurrent: () => current,
    save: async track => { saved.push(track); current = false; return { downloadId: 'queued' } },
  })
  assert.equal(prepared[0].id, 'abcdefghijk')
  assert.equal(saved.length, 1)
  assert.equal(result.started, 1)
  assert.equal(result.cancelled, true)
})

test('collection download skips local files, dedupes rows, and includes streamed ghosts', async () => {
  const local = { id: 'local', file_path: '/music/owned.flac' }
  const stream = { id: 'yt-bbbbbbbbbbb', title: 'Streamed', artist: 'X', file_path: 'ghost://youtube/online/bbbbbbbbbbb' }
  const calls = []
  const result = await downloadMissingCollectionTracks([local, stream, stream, imported(1)], {
    client: client({ inLibrary: [{ id: 'existing', title: 'Song 1', artist: 'Artist 1', file_path: '/music/1.flac' }] }),
    save: async track => { calls.push(track.id); return { downloadId: 'new' } },
  })
  assert.deepEqual(calls, [stream.id])
  assert.deepEqual(result, { started: 1, existing: 2, failed: 0, notFound: 0 })
})

test('collection download repairs absent files from their known source and reports unsupported rows', async () => {
  const calls = []
  const result = await downloadMissingCollectionTracks([
    { id: 'missing', title: 'Absent', missing: true, file_path: '/gone.flac', source_ref: 'yt:abcdefghijk' },
    { id: 'unknown', title: 'Unknown', missing: true, file_path: '/unknown.flac' },
  ], { client: { downloadYT: async (...args) => { calls.push(args); return { downloadId: 'repair' } } } })
  assert.equal(result.started, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.existing, 0)
  assert.equal(calls[0][1].upgradeTrackId, 'missing')
})

test('collection download stops before queuing further ghosts or missing-file repairs', async () => {
  let current = true
  const calls = []
  const result = await downloadMissingCollectionTracks([
    { id: 'yt-aaaaaaaaaaa', file_path: 'ghost://youtube/online/aaaaaaaaaaa' },
    { id: 'yt-bbbbbbbbbbb', file_path: 'ghost://youtube/online/bbbbbbbbbbb' },
    { id: 'repair', missing: true, source_ref: 'yt:ccccccccccc' },
  ], { concurrency: 1, client: client(), isCurrent: () => current,
    save: async track => { calls.push(track.id); current = false; return { downloadId: 'first' } } })
  assert.deepEqual(calls, ['yt-aaaaaaaaaaa'])
  assert.equal(result.cancelled, true)
})
