import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { planFile, targetRate, convertArgs, family } = require('../electron/cast/formats.js')
const { createCastMediaServer, localAddressFor, parseRange } = require('../electron/cast/mediaServer.js')
const { createCastMedia } = require('../electron/cast/media.js')
const { didl, parseXml, value } = require('../electron/cast/upnpXml.js')

test('what goes to the TV as it is, and what is converted (and to what)', () => {
  const direct = info => planFile(info).action
  assert.equal(direct({ file: 'a.flac', codec: 'FLAC', sampleRate: 96000, bitDepth: 24 }), 'direct')
  assert.equal(direct({ file: 'a.mp3', codec: 'MPEG 1 Layer 3', sampleRate: 44100 }), 'direct')
  assert.equal(direct({ file: 'a.m4a', codec: 'MPEG-4/AAC', sampleRate: 44100 }), 'direct')
  assert.equal(direct({ file: 'a.opus', codec: 'Opus', sampleRate: 48000 }), 'direct')
  assert.equal(direct({ file: 'a.wav', codec: 'PCM', sampleRate: 44100, bitDepth: 16 }), 'direct')
  // Hi-res beyond the TV comes down within the same rate family, 24-bit kept.
  assert.deepEqual(planFile({ file: 'a.flac', codec: 'FLAC', sampleRate: 192000, bitDepth: 24 }), { action: 'convert', to: 'flac', ext: '.flac', mime: 'audio/flac', rate: 96000, depth: 24 })
  assert.equal(planFile({ file: 'a.flac', codec: 'FLAC', sampleRate: 176400, bitDepth: 24 }).rate, 88200)
  assert.equal(planFile({ file: 'a.dsf', codec: 'DSD', sampleRate: 2822400, bitDepth: 1, lossless: 1 }).rate, 88200)
  // ALAC (in .m4a) and AIFF are lossless the TV can't read: FLAC, rate kept.
  assert.deepEqual(planFile({ file: 'a.m4a', codec: 'ALAC', sampleRate: 44100, bitDepth: 16, lossless: 1 }), { action: 'convert', to: 'flac', ext: '.flac', mime: 'audio/flac', rate: 44100, depth: 16 })
  assert.equal(planFile({ file: 'a.aiff', codec: 'PCM', sampleRate: 48000, bitDepth: 24, lossless: 1 }).to, 'flac')
  // Lossy it can't read: AAC.
  assert.equal(planFile({ file: 'a.wma', codec: 'Windows Media Audio', sampleRate: 44100, lossless: 0 }).to, 'aac')
  // "Standard" quality (a weak Wi-Fi): 16/48 at most.
  assert.deepEqual(planFile({ file: 'a.flac', codec: 'FLAC', sampleRate: 96000, bitDepth: 24 }, 'standard'), { action: 'convert', to: 'flac', ext: '.flac', mime: 'audio/flac', rate: 48000, depth: 16 })
  assert.equal(planFile({ file: 'a.flac', codec: 'FLAC', sampleRate: 44100, bitDepth: 16 }, 'standard').action, 'direct')
  assert.equal(targetRate(48000, { rate: 96000 }), 48000)
  assert.equal(family('Vorbis I'), 'vorbis')
  const args = convertArgs('in.m4a', 'out.flac', { to: 'flac', rate: 96000, depth: 24 })
  assert.deepEqual(args.slice(args.indexOf('-ar'), args.indexOf('-ar') + 2), ['-ar', '96000'])
  assert.ok(args.includes('s32') && args.at(-1) === 'out.flac')
})

test('this computer\'s address on the TV\'s network, and ranges', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0' }],
    vpn: [{ address: '10.8.0.2', family: 'IPv4', internal: false, netmask: '255.255.255.0' }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false, netmask: '255.255.0.0' }],
    virbr0: [{ address: '192.168.122.1', family: 'IPv4', internal: false, netmask: '255.255.255.0' }],
    tailscale0: [{ address: '100.64.1.2', family: 'IPv4', internal: false, netmask: '255.192.0.0' }],
    wlo1: [{ address: '192.168.1.23', family: 'IPv4', internal: false, netmask: '255.255.255.0' }],
  }
  assert.equal(localAddressFor('192.168.1.40', interfaces), '192.168.1.23')
  // Different subnet: prefer physical LAN (wlo1) over VPN/Docker/libvirt/Tailscale.
  assert.equal(localAddressFor('172.20.0.9', interfaces), '192.168.1.23')
  // Device actually on the VPN subnet: explicit fallback subnet match still works.
  assert.equal(localAddressFor('10.8.0.50', interfaces), '10.8.0.2')
  // Longest-prefix subnet match beats a broader mask on another LAN interface.
  assert.equal(localAddressFor('10.0.1.40', {
    eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false, netmask: '255.0.0.0' }],
    enp3s0: [{ address: '10.0.1.5', family: 'IPv4', internal: false, netmask: '255.255.255.0' }],
  }), '10.0.1.5')
  assert.deepEqual(parseRange('bytes=100-', 1000), { start: 100, end: 999 })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.equal(parseRange('bytes=2000-', 1000), 'bad')
  assert.equal(parseRange(null, 1000), null)
})

test('media server supports explicit socket localAddress, PNA CORS preflight, requestCount, and preferred port fallback', async t => {
  const first = createCastMediaServer()
  const port = await first.start()
  t.after(() => first.stop())
  const added = first.add({ kind: 'json', data: { ok: true } }, 'info.json')
  assert.equal(first.urlFor(added.path, '192.168.1.40', '::ffff:192.168.1.99'), `http://192.168.1.99:${port}${added.path}`)
  assert.equal(first.requestCount, 0)
  const preflight = await fetch(`http://127.0.0.1:${port}${added.path}`, { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true')
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /GET/)
  assert.equal(first.requestCount, 1)

  // Preferred port busy -> falls back cleanly to an ephemeral port.
  const second = createCastMediaServer({ port })
  const fallbackPort = await second.start()
  t.after(() => second.stop())
  assert.ok(fallbackPort > 0 && fallbackPort !== port)

  // Preferred port free -> binds that exact port.
  first.stop()
  const third = createCastMediaServer({ port })
  const reusedPort = await third.start()
  t.after(() => third.stop())
  assert.equal(reusedPort, port)
})

test('the TV fetches a song (and seeks in it), only by its token and key; online songs are relayed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-cast-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const song = path.join(dir, 'song.mp3')
  fs.writeFileSync(song, Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256)))
  const server = createCastMediaServer()
  await server.start()
  t.after(() => server.stop())
  const relayed = []
  const media = createCastMedia({
    server,
    trackRow: id => (id === 'local' ? { id, file_path: song, codec: 'MPEG 1 Layer 3', duration: 200, title: 'Song', artist: 'Artist', album: 'Album' } : null),
    streamRef: row => (row.id === 'yt' ? { provider: 'yt', id: 'abcdefghijk' } : null),
    resolveStream: async () => ({ url: 'https://example.invalid/x', mime: 'audio/webm; codecs="opus"' }),
    fetchStream: async (provider, id, { range }) => { relayed.push(range); return { res: new Response('opus-bytes', { status: 206, headers: { 'content-range': 'bytes 0-9/10', 'content-length': '10' } }), mime: 'audio/webm' } },
  })
  const prepared = await media.prepare({ id: 'local' }, { deviceHost: '127.0.0.1' })
  assert.equal(prepared.mime, 'audio/mpeg')
  assert.deepEqual(prepared.metadata, { metadataType: 3, title: 'Song', artist: 'Artist', albumName: 'Album' })
  const local = prepared.url.replace(/^http:\/\/[^/]+/, `http://127.0.0.1:${server.port}`)
  const whole = await fetch(local)
  assert.equal(whole.status, 200)
  assert.equal((await whole.arrayBuffer()).byteLength, 5000)
  const part = await fetch(local, { headers: { Range: 'bytes=1000-1009' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), 'bytes 1000-1009/5000')
  assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], Array.from({ length: 10 }, (_, i) => (1000 + i) % 256))
  // Wrong token or unknown key: nothing.
  assert.equal((await fetch(local.replace(/\/[0-9a-f]{32}\//, `/${'0'.repeat(32)}/`))).status, 404)
  // Taken down after use.
  media.release(prepared)
  assert.equal((await fetch(local)).status, 404)
  // An online song: relayed, typed for the TV.
  const online = await media.prepare({ id: 'yt', title: 'Online' }, { deviceHost: '127.0.0.1' })
  assert.equal(online.mime, 'audio/webm')
  const res = await fetch(online.url.replace(/^http:\/\/[^/]+/, `http://127.0.0.1:${server.port}`), { headers: { Range: 'bytes=0-' } })
  assert.equal(res.status, 206)
  assert.equal(await res.text(), 'opus-bytes')
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(relayed, ['bytes=0-'])
})

test('a file the TV can\'t play is converted once (the second time comes from the cache)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-cast-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const song = path.join(dir, 'song.m4a')
  fs.writeFileSync(song, 'alac')
  const server = createCastMediaServer()
  await server.start()
  t.after(() => server.stop())
  const runs = []
  const media = createCastMedia({
    server,
    cacheDir: () => path.join(dir, 'cache'),
    trackRow: id => ({ id, file_path: song, codec: 'ALAC', sample_rate: 44100, bit_depth: 16, lossless: 1 }),
    convert: async (ffmpeg, args) => { runs.push(args); fs.writeFileSync(args.at(-1), 'flac-bytes') },
  })
  const first = await media.prepare({ id: 'a' }, { deviceHost: '127.0.0.1' })
  const second = await media.prepare({ id: 'a' }, { deviceHost: '127.0.0.1' })
  assert.equal(first.mime, 'audio/flac')
  assert.equal(first.converted, true)
  assert.equal(runs.length, 1)
  assert.ok(runs[0].includes('flac'))
  const res = await fetch(second.url.replace(/^http:\/\/[^/]+/, `http://127.0.0.1:${server.port}`))
  assert.equal(await res.text(), 'flac-bytes')
})

test('Sonos can fetch a JPEG when a queue entry is missing its library WebP cover', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-cast-cover-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const song = path.join(dir, 'song.mp3')
  const cover = path.join(dir, 'cover.webp')
  const frame = Buffer.alloc(417)
  frame.set([0xff, 0xfb, 0x90, 0x00])
  const original = Buffer.concat(Array.from({ length: 40 }, () => frame))
  fs.writeFileSync(song, original)
  const sharp = require('sharp')
  await sharp({ create: { width: 16, height: 16, channels: 3, background: '#229944' } })
    .webp().toFile(cover)

  const server = createCastMediaServer()
  await server.start()
  t.after(() => server.stop())
  const media = createCastMedia({
    server,
    cacheDir: () => path.join(dir, 'cast'),
    trackRow: id => ({ id, file_path: song, codec: 'MPEG 1 Layer 3', artwork_path: cover }),
  })
  const prepared = await media.prepare({ id: 'local', artwork_path: null }, { deviceHost: '127.0.0.1', receiver: 'sonos' })
  assert.equal(prepared.embeddedCover, true)
  assert.equal(prepared.converted, false)
  const audio = Buffer.from(await (await fetch(prepared.url)).arrayBuffer())
  assert.ok(audio.includes(original), 'audio frames are copied unchanged')
  assert.deepEqual(fs.readFileSync(song), original, 'the library file is untouched')
  const parsed = await require('../electron/musicMetadata.js').parseBuffer(audio, 'audio/mpeg')
  assert.equal(parsed.common.picture[0].format, 'image/jpeg')
  const url = value(parseXml(didl(prepared, { sonosQueueId: 1 })), 'albumArtURI')
  assert.match(url, /\/cover\.jpg$/)
  const head = await fetch(url, { method: 'HEAD' })
  assert.equal(head.headers.get('content-type'), 'image/jpeg')
  const response = await fetch(url)
  assert.equal(response.status, 200)
  const jpeg = Buffer.from(await response.arrayBuffer())
  assert.equal(jpeg.length, Number(head.headers.get('content-length')))
  assert.equal((await sharp(jpeg).metadata()).format, 'jpeg')

  media.release(prepared)
  assert.equal((await fetch(url)).status, 404)
})

test('Sonos receives an embedded JPEG in converted FLAC and AAC audio', {
  skip: spawnSync('ffmpeg', ['-version']).status !== 0 ? 'FFmpeg unavailable' : false,
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-cast-converted-cover-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const original = path.join(dir, 'song.wav')
  const fixture = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', original])
  assert.equal(fixture.status, 0, fixture.stderr?.toString())
  const cover = path.join(dir, 'cover.webp')
  await require('sharp')({ create: { width: 16, height: 16, channels: 3, background: '#229944' } }).webp().toFile(cover)
  const server = createCastMediaServer()
  await server.start()
  t.after(() => server.stop())
  const media = createCastMedia({
    server,
    cacheDir: () => path.join(dir, 'cast'),
    streamRef: row => ({ provider: 'fixture', id: row.id }),
    resolveStream: async (_provider, id) => ({
      file: original, mime: id === 'lossless' ? 'audio/wav' : 'audio/mpeg',
    }),
  })
  for (const [id, mime] of [['lossless', 'audio/flac'], ['lossy', 'audio/mp4']]) {
    const item = await media.prepare({ id, artwork_path: cover }, { deviceHost: '127.0.0.1', receiver: 'sonos' })
    assert.equal(item.converted, true)
    assert.equal(item.embeddedCover, true)
    const response = await fetch(item.url)
    assert.equal(response.headers.get('content-type'), mime)
    const parsed = await require('../electron/musicMetadata.js').parseBuffer(Buffer.from(await response.arrayBuffer()), mime)
    assert.equal(parsed.common.picture[0].format, 'image/jpeg')
    assert.ok(parsed.format.duration > 0)
    media.release(item)
    assert.equal((await fetch(item.url)).status, 404)
  }
})

test('converted songs the TV still holds are kept when the cache is trimmed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-cast-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const songs = ['a', 'b'].map(name => { const file = path.join(dir, `${name}.m4a`); fs.writeFileSync(file, name); return file })
  const server = createCastMediaServer()
  await server.start()
  t.after(() => server.stop())
  const trims = []
  const media = createCastMedia({
    server,
    cacheDir: () => path.join(dir, 'cache'),
    trackRow: id => ({ id, file_path: songs[id === 'a' ? 0 : 1], codec: 'ALAC', sample_rate: 44100, bit_depth: 16, lossless: 1 }),
    convert: async (ffmpeg, args) => { fs.writeFileSync(args.at(-1), 'flac') },
    trimCache: keep => trims.push(keep),
  })
  const first = await media.prepare({ id: 'a' }, { deviceHost: '127.0.0.1' })
  await media.prepare({ id: 'b' }, { deviceHost: '127.0.0.1' })
  assert.ok(trims[1].includes(first.files[0]), 'the first song, still held, is kept')
  media.release(first)
  fs.rmSync(path.join(dir, 'cache'), { recursive: true, force: true })
  await media.prepare({ id: 'b' }, { deviceHost: '127.0.0.1' })
  assert.ok(!trims.at(-1).includes(first.files[0]), 'released: no longer kept')
})

test('Sonos awaits live online stream jobs before conversion and media server logs incoming requests', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-cast-live-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const downloaded = path.join(dir, 'live.flac')
  fs.writeFileSync(downloaded, 'flac-audio')
  const logs = []
  const server = createCastMediaServer({ log: line => logs.push(line) })
  await server.start()
  t.after(() => server.stop())

  let convertedFrom = null
  const job = { status: 'running', result: null, promise: null }
  job.promise = new Promise(resolve => setTimeout(() => {
    job.status = 'done'
    job.result = { file: downloaded, mime: 'audio/flac' }
    resolve()
  }, 20))

  const media = createCastMedia({
    server,
    cacheDir: () => path.join(dir, 'cache'),
    streamRef: row => ({ provider: 'tidal', id: row.id }),
    resolveStream: async () => ({ type: 'live', job }),
    convert: async (_ffmpeg, args) => {
      convertedFrom = args[args.indexOf('-i') + 1]
      fs.writeFileSync(args.at(-1), 'converted-flac')
    },
  })

  const prepared = await media.prepare({ id: 'online-live', title: 'Online Track' }, { deviceHost: '127.0.0.1', receiver: 'sonos' })
  assert.equal(convertedFrom, downloaded)
  const response = await fetch(prepared.url)
  assert.equal(response.status, 200)
  assert.ok(logs.some(line => /media server GET file from 127\.0\.0\.1/.test(line)))
  media.release(prepared)
})

