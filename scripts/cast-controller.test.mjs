import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { startFakeReceiver, DEFAULT_MEDIA_RECEIVER } from './fakeCastReceiver.mjs'

const require = createRequire(import.meta.url)
const { CastController, CAST_PROTOCOL } = require('../electron/cast/controller.js')

const track = id => ({ id, title: `Song ${id}`, artist: 'Artist', duration: 180 })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, ms = 2000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await wait(10) }
  assert.fail('timed out waiting')
}

function setup(t, { appId = null, device } = {}) {
  const prepared = []
  const media = {
    prepare: async (track, { convert }) => {
      prepared.push({ id: track.id, convert })
      return { trackId: String(track.id), url: `http://pc/${track.id}${convert ? '-converted' : ''}`, mime: 'audio/flac', duration: 180, metadata: { metadataType: 3, title: track.title }, keys: [] }
    },
    release: () => {},
  }
  const server = { start: async () => {}, stop: () => {} }
  const controller = new CastController({ media, server, appId, connect: device.connect })
  t.after(() => controller.disconnect({ stopReceiver: false }))
  return { controller, prepared }
}

const tv = device => ({ id: 'tv1', name: 'Living Room TV', kind: 'tv', host: '127.0.0.1', port: device.port })
const sent = (device, type) => device.log.filter(entry => entry.type === type)

test('connects to Google\'s receiver, loads the playing song where it was, and queues the next three', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  const { controller } = setup(t, { device })
  const statuses = []
  controller.on('status', status => statuses.push(status))
  const result = await controller.connect(tv(device))
  assert.equal(result.joined, false)
  assert.equal(device.state.app.appId, DEFAULT_MEDIA_RECEIVER)
  await controller.setWindow({ current: track('a'), upcoming: [track('b'), track('c'), track('d'), track('e')], position: 42, play: true, repeat: 'none' })
  const load = sent(device, 'LOAD')[0].data
  assert.equal(load.currentTime, 42)
  assert.equal(load.autoplay, true)
  assert.equal(load.media.contentUrl, 'http://pc/a')
  assert.deepEqual(load.media.customData, { lokal: 1, trackId: 'a' })
  assert.deepEqual(device.state.media.items.map(item => item.media.customData.trackId), ['a', 'b', 'c', 'd'], 'the playing song and three ahead')
  const last = statuses.at(-1)
  assert.equal(last.state, 'connected')
  assert.equal(last.trackId, 'a')
  assert.equal(last.playerState, 'PLAYING')
  assert.equal(last.device.name, 'Living Room TV')
})

test('a skip to a song the TV holds is a jump (no new load); the window then slides', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  const { controller, prepared } = setup(t, { device })
  await controller.connect(tv(device))
  await controller.setWindow({ current: track('a'), upcoming: [track('b'), track('c'), track('d')], play: true })
  await controller.setWindow({ current: track('b'), upcoming: [track('c'), track('d'), track('e')], play: true })
  assert.equal(sent(device, 'LOAD').length, 1, 'no second load')
  assert.equal(sent(device, 'QUEUE_UPDATE').filter(entry => entry.data.currentItemId != null).length, 1)
  assert.equal(controller.status().trackId, 'b')
  const m = device.state.media
  assert.deepEqual(m.items.slice(m.current).map(item => item.media.customData.trackId), ['b', 'c', 'd', 'e'])
  // Each song was made ready once.
  assert.deepEqual(prepared.map(entry => entry.id), ['a', 'b', 'c', 'd', 'e'])
})

test('the TV moving on by itself is reported; the queue order changing under the playing song is followed', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  const { controller } = setup(t, { device })
  await controller.connect(tv(device))
  await controller.setWindow({ current: track('a'), upcoming: [track('b'), track('c')], play: true })
  device.advance(181)
  await until(() => controller.status().trackId === 'b')
  // The person reordered the queue: after b now comes x, then c.
  await controller.setWindow({ current: track('b'), upcoming: [track('x'), track('c')], play: true })
  const m = device.state.media
  assert.deepEqual(m.items.slice(m.current).map(item => item.media.customData.trackId), ['b', 'x', 'c'])
  // Repeat one is the TV's to do.
  await controller.setWindow({ current: track('b'), upcoming: [track('x'), track('c')], play: true, repeat: 'one' })
  assert.equal(device.state.media.repeatMode, 'REPEAT_SINGLE')
})

test('play, pause, seek and volume reach the TV; the TV\'s own volume buttons come back', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  const { controller } = setup(t, { device })
  await controller.connect(tv(device))
  await controller.setWindow({ current: track('a'), upcoming: [], play: true })
  await controller.pause()
  assert.equal(device.state.media.playerState, 'PAUSED')
  await controller.seek(90)
  assert.equal(device.state.media.time, 90)
  await controller.play()
  assert.equal(controller.status().playerState, 'PLAYING')
  await controller.setVolume({ level: 0.3 })
  assert.equal(device.state.volume.level, 0.3)
  device.setVolume({ level: 0.7 })
  await until(() => controller.status().volume.level === 0.7)
})

test('a song the TV refuses is converted and loaded again, once; then it\'s reported', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  const { controller, prepared } = setup(t, { device })
  const errors = []
  controller.on('trackError', error => errors.push(error))
  await controller.connect(tv(device))
  await controller.setWindow({ current: track('a'), upcoming: [], play: true })
  device.failCurrent()
  await until(() => sent(device, 'LOAD').length === 2)
  assert.equal(sent(device, 'LOAD')[1].data.media.contentUrl, 'http://pc/a-converted')
  assert.ok(prepared.some(entry => entry.id === 'a' && entry.convert))
  device.failCurrent()
  await until(() => errors.length === 1)
  assert.equal(errors[0].trackId, 'a')
})

test('Lokal\'s own receiver is used when it starts; Google\'s when it doesn\'t', async t => {
  const withLokal = await startFakeReceiver({ apps: ['LOKAL001', DEFAULT_MEDIA_RECEIVER] })
  t.after(() => withLokal.close())
  const a = setup(t, { device: withLokal, appId: 'LOKAL001' })
  await a.controller.connect(tv(withLokal))
  assert.equal(withLokal.state.app.appId, 'LOKAL001')
  assert.equal(a.controller.status().receiver, 'lokal')
  const without = await startFakeReceiver()
  t.after(() => without.close())
  const b = setup(t, { device: without, appId: 'LOKAL001' })
  await b.controller.connect(tv(without))
  assert.equal(without.state.app.appId, DEFAULT_MEDIA_RECEIVER)
  assert.equal(b.controller.status().receiver, 'default')
})

test('the app closed on the TV ends the session with where it was; Lokal restarting joins the music still playing', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  const first = setup(t, { device })
  await first.controller.connect(tv(device))
  await first.controller.setWindow({ current: track('a'), upcoming: [track('b')], play: true, position: 30 })
  // Lokal restarts: a new session finds the music playing and joins it.
  const second = setup(t, { device })
  const joined = await second.controller.connect(tv(device))
  assert.equal(joined.joined, true)
  assert.equal(second.controller.status().trackId, 'a')
  assert.equal(sent(device, 'LAUNCH').length, 1, 'not launched again')
  const ended = new Promise(resolve => second.controller.once('ended', resolve))
  device.stopApp()
  const end = await ended
  assert.equal(end.reason, 'stopped')
  assert.equal(end.last.trackId, 'a')
  assert.equal(end.last.position, 30)
})

test('a dropped connection is picked up again: the TV played on', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  const { controller } = setup(t, { device })
  await controller.connect(tv(device))
  await controller.setWindow({ current: track('a'), upcoming: [], play: true })
  let ended = false
  controller.on('ended', () => { ended = true })
  const rejoined = new Promise(resolve => controller.once('rejoined', resolve))
  device.dropConnections()
  await rejoined
  assert.equal(controller.status().trackId, 'a')
  assert.equal(ended, false)
  await controller.pause()
  assert.equal(device.state.media.playerState, 'PAUSED')
})

test('a song that can\'t be got ready is reported once, and doesn\'t hold up the windows after it', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  const { controller } = setup(t, { device })
  const media = controller.media
  const plain = media.prepare
  let release = null
  media.prepare = async (track, options) => {
    if (track.id === 'drm') throw new Error('This video is DRM protected')
    if (track.id === 'slow') return new Promise(resolve => { release = () => resolve(plain(track, options)) })
    return plain(track, options)
  }
  const errors = []
  controller.on('trackError', info => errors.push(info))
  await controller.connect(tv(device))
  // A next song that never gets ready: the playing one still loads, and a newer window isn't kept waiting.
  const first = controller.setWindow({ current: track('a'), upcoming: [track('slow'), track('c')], play: true })
  await until(() => device.state.media?.items.length === 1 && release)
  await controller.setWindow({ current: track('b'), upcoming: [track('c')], play: true })
  await first
  assert.deepEqual(device.state.media.items.map(item => item.media.customData.trackId), ['b', 'c'])
  release()
  // The playing song failing: reported, and the next window still applies.
  await controller.setWindow({ current: track('drm'), upcoming: [], play: true })
  assert.deepEqual(errors.map(error => error.trackId), ['drm'])
  await controller.setWindow({ current: track('d'), upcoming: [], play: true })
  assert.equal(controller.status().trackId, 'd')
  assert.equal(errors.length, 1)
})

test('Lokal\'s receiver gets the Up Next row (covers it can load) and the music video; addresses are taken down when replaced', async t => {
  const device = await startFakeReceiver({ apps: ['ABCDEF12', DEFAULT_MEDIA_RECEIVER] })
  t.after(() => device.close())
  const { controller } = setup(t, { device, appId: 'ABCDEF12' })
  const published = new Set()
  let next = 0
  controller.server.add = (item, name) => { const key = `k${++next}`; published.add(key); return { key, path: `/token/${key}/${name}` } }
  controller.server.urlFor = path => `http://pc${path}`
  controller.media.artwork = track => (track.id === 'b' ? { url: 'http://pc/cover-b', key: 'cover-b' } : { url: null, key: null })
  const unpublished = []
  controller.media.unpublish = key => { unpublished.push(key); published.delete(key) }
  await controller.connect(tv(device))
  assert.equal(controller.status().receiver, 'lokal')
  const custom = () => device.log.filter(entry => entry.namespace === 'urn:x-cast:app.lokal.cast').map(entry => entry.data)

  controller.sendUpNext([track('b'), track('c')])
  await until(() => custom().length === 1)
  assert.deepEqual(custom()[0], { type: 'upnext', items: [{ id: 'b', title: 'Song b', artist: 'Artist', image: 'http://pc/cover-b' }, { id: 'c', title: 'Song c', artist: 'Artist', image: null }], protocol: CAST_PROTOCOL })
  controller.sendUpNext([track('c')])
  assert.deepEqual(unpublished, ['cover-b'], 'the last row\'s covers are taken down')

  controller.sendVideo({ trackId: 'a', item: { kind: 'relay', mime: null }, name: 'video', segments: [{ start: 0, end: null, offset: 2 }] })
  await until(() => custom().length === 3)
  assert.deepEqual(custom()[2], { type: 'video', trackId: 'a', url: 'http://pc/token/k1/video', segments: [{ start: 0, end: null, offset: 2 }], protocol: CAST_PROTOCOL })
  controller.sendVideo({ trackId: 'b' })
  await until(() => custom().length === 4)
  assert.deepEqual(custom()[3], { type: 'video', trackId: 'b', protocol: CAST_PROTOCOL })
  assert.ok(unpublished.includes('k1'), 'the last video is taken down')
})

test('Lokal\'s messages say their version; the receiver\'s hello says its own', async t => {
  const device = await startFakeReceiver({ apps: [DEFAULT_MEDIA_RECEIVER, 'ABCDEF12'] })
  t.after(() => device.close())
  const { controller } = setup(t, { device, appId: 'ABCDEF12' })
  await controller.connect(tv(device))
  assert.equal(controller.status().receiverProtocol, null, 'unknown until the hello')
  const heard = []
  controller.on('custom', data => heard.push(data))
  device.sendCustom({ type: 'hello', version: 1, protocol: 2 })
  await until(() => heard.length === 1)
  assert.equal(controller.status().receiverProtocol, 2)
  device.sendCustom({ type: 'hello', version: 1 })
  await until(() => heard.length === 2)
  assert.equal(controller.status().receiverProtocol, 0, 'a receiver from before versions')
  controller.sendCustom({ type: 'view', view: 'lyrics' })
  const custom = () => device.log.filter(entry => entry.namespace === 'urn:x-cast:app.lokal.cast').map(entry => entry.data)
  await until(() => custom().length === 1)
  assert.deepEqual(custom()[0], { type: 'view', view: 'lyrics', protocol: CAST_PROTOCOL })
})

test('Google\'s receiver gets none of Lokal\'s own messages', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  const { controller } = setup(t, { device, appId: 'ABCDEF12' })
  await controller.connect(tv(device))
  assert.equal(controller.status().receiver, 'default')
  assert.equal(controller.sendUpNext([track('b')]), false)
  assert.equal(controller.sendVideo(null), false)
})

test('a queue change the TV refuses is tried again, without loading the playing song again', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  const { controller } = setup(t, { device })
  await controller.connect(tv(device))
  device.state.failQueueChanges = 2 // b's insert, then its retry
  await controller.setWindow({ current: track('a'), upcoming: [track('b'), track('c')], position: 0, play: true, repeat: 'none' })
  assert.equal(sent(device, 'LOAD').length, 1, 'the playing song loaded once')
  assert.deepEqual(device.state.media.items.map(item => item.media.customData.trackId), ['a', 'b', 'c'])
  assert.equal(sent(device, 'QUEUE_INSERT').length, 4, 'two refused, then b and c')
  assert.equal(controller.applied, controller.generation)
})

test('a queue the TV keeps refusing is given up on after a few tries; the song plays on', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  const { controller } = setup(t, { device })
  await controller.connect(tv(device))
  device.state.failQueueChanges = 99
  await controller.setWindow({ current: track('a'), upcoming: [track('b')], position: 0, play: true, repeat: 'none' })
  assert.equal(sent(device, 'LOAD').length, 1)
  assert.equal(sent(device, 'QUEUE_INSERT').length, 4, 'the first try and three more')
  assert.equal(device.state.media.items.length, 1)
  assert.equal(controller.applied, controller.generation)
  assert.equal(device.state.media.playerState, 'PLAYING')
})

test('CastController passes the connected socket localAddress and reports a Linux firewall error when the receiver never fetches media', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  device.state.loadPlayerState = 'BUFFERING'
  const seenLocalAddresses = []
  let requestCount = 0
  const server = {
    start: async () => 3422,
    stop: () => {},
    get port() { return 3422 },
    get requestCount() { return requestCount },
  }
  const media = {
    prepare: async (item, { localAddress }) => {
      seenLocalAddresses.push(localAddress)
      return {
        trackId: String(item.id),
        url: `http://${localAddress || '127.0.0.1'}:3422/token/key/${item.id}.flac`,
        mime: 'audio/flac',
        duration: 180,
        metadata: { metadataType: 3, title: item.title },
        keys: [],
      }
    },
    release: () => {},
  }
  const controller = new CastController({
    media,
    server,
    connect: device.connect,
    reachabilityTimeoutMs: 60,
    platform: 'linux',
  })
  t.after(() => controller.disconnect({ stopReceiver: false }))
  await controller.connect(tv(device))
  await controller.setWindow({ current: track('a'), upcoming: [], position: 0, play: true, repeat: 'none' })
  assert.equal(seenLocalAddresses[0], '127.0.0.1')
  await until(() => /TCP port 3422/.test(controller.status().error || ''))
  assert.match(controller.status().error, /firewall/i)
  // Once the receiver begins playing, the reachability warning clears.
  await controller.play()
  assert.equal(controller.status().error, null)
})

test('CastController still reports the firewall error if the receiver stays IDLE after LOAD with no media server hits', async t => {
  const device = await startFakeReceiver()
  t.after(() => device.close())
  device.state.loadPlayerState = 'IDLE'
  let requestCount = 0
  const server = {
    start: async () => 3422,
    stop: () => {},
    get port() { return 3422 },
    get requestCount() { return requestCount },
  }
  const media = {
    prepare: async (item, { localAddress }) => ({
      trackId: String(item.id),
      url: `http://${localAddress || '127.0.0.1'}:3422/token/key/${item.id}.flac`,
      mime: 'audio/flac',
      duration: 180,
      metadata: { metadataType: 3, title: item.title },
      keys: [],
    }),
    release: () => {},
  }
  const controller = new CastController({
    media,
    server,
    connect: device.connect,
    reachabilityTimeoutMs: 60,
    platform: 'linux',
  })
  t.after(() => controller.disconnect({ stopReceiver: false }))
  await controller.connect(tv(device))
  await controller.setWindow({ current: track('a'), upcoming: [], position: 0, play: true, repeat: 'none' })
  await until(() => /TCP port 3422/.test(controller.status().error || ''))
  assert.match(controller.status().error, /firewall/i)
  // Once the receiver hits the local media server, a subsequent status clears the warning.
  requestCount = 1
  controller.onMediaStatus([{ playerState: 'BUFFERING' }])
  assert.equal(controller.status().error, null)
})

