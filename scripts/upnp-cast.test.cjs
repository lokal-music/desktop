const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseXml, nodes, value, didl, escapeXml } = require('../electron/cast/upnpXml')
const { describe, coordinator, soap, timestamp, seconds, UpnpDiscovery } = require('../electron/cast/upnp')
const { UpnpController } = require('../electron/cast/upnpController')
const response = inner => ({ ok: true, status: 200, text: async () => `<s:Envelope xmlns:s="soap"><s:Body>${inner}</s:Body></s:Envelope>` })
const svc = name => ({ url: `http://192.168.1.20/${name}`, type: `urn:schemas-upnp-org:service:${name}:1` })
const device = sonos => ({ id: 'upnp:room', uuid: 'RINCON_20', name: 'Kitchen', host: '192.168.1.20', sonos,
  services: { AVTransport: svc('AVTransport'), RenderingControl: svc('RenderingControl'), ...(sonos ? { GroupRenderingControl: svc('GroupRenderingControl') } : {}) } })
function fixture(sonos = true, converted, embeddedCover) {
  const commands = []; const released = []; let uri = ''; let state = 'PLAYING'; let failStop = false; let metadata = ''; let currentUri = ''
  const fetchImpl = async (url, options) => {
    const action = options.headers.SOAPAction.match(/#([^" ]+)/)[1]
    const doc = parseXml(options.body)
    commands.push({ action, doc, body: options.body })
    if (action === 'Stop' && failStop) throw new Error('receiver offline')
    if (action === 'GetPositionInfo') return response(`<Track>2</Track><TrackURI>${escapeXml(uri)}</TrackURI><TrackMetaData>${escapeXml(metadata)}</TrackMetaData><RelTime>0:00:12</RelTime><TrackDuration>0:03:00</TrackDuration>`)
    if (action === 'GetMediaInfo') return response(`<CurrentURI>${escapeXml(currentUri)}</CurrentURI>`)
    if (action === 'GetTransportInfo') return response(`<CurrentTransportState>${state}</CurrentTransportState>`)
    if (/Get.*Volume/.test(action)) return response('<CurrentVolume>37</CurrentVolume>')
    if (/Get.*Mute/.test(action)) return response('<CurrentMute>0</CurrentMute>')
    return response('')
  }
  const media = { prepare: async track => ({ trackId: String(track.id), url: `http://192.168.1.4/media/${track.id}`, duration: 180, converted, embeddedCover,
    mime: 'audio/flac', metadata: { title: `A & B <${track.id}>`, artist: 'Artist', albumName: 'Album', images: [{ url: 'http://192.168.1.4/art.jpg' }] } }), release: item => released.push(item) }
  const server = { start: async () => {}, stop: () => {} }
  const controller = new UpnpController({ media, server, fetchImpl })
  return { controller, commands, released, fetchImpl, setUri: u => { uri = u }, setExternal: u => { uri = currentUri = u; metadata = `<DIDL-Lite><item><res>${escapeXml(u)}</res></item></DIDL-Lite>` }, setState: s => { state = s }, failStop: () => { failStop = true } }
}
test('SOAP metadata is a string, preserving XML entities through two encoding layers', async () => {
  let body
  const item = { trackId: 'a', url: 'http://192.168.1.22/song?a=1&b=2', mime: 'audio/flac', metadata: { title: 'A & <B>', images: [{ url: 'http://192.168.1.22/a.jpg?a=1&b=2' }] } }
  await soap('http://192.168.1.22/control', 'urn:test', 'SetAVTransportURI', { CurrentURIMetaData: didl(item) }, async (_, o) => { body = o.body; return response('') })
  const nested = parseXml(value(parseXml(body), 'CurrentURIMetaData'))
  assert.equal(value(nested, 'title'), 'A & <B>'); assert.equal(value(nested, 'res'), item.url)
  assert.equal(value(nested, 'albumArtURI'), item.metadata.images[0].url)
})
test('SOAP faults are failures even when HTTP reports success', async () => {
  await assert.rejects(soap('http://192.168.1.22', 'urn:test', 'Play', {}, async () => response('<s:Fault><errorDescription>Transition unavailable</errorDescription></s:Fault>')), /Transition unavailable/)
})
test('XML rejects DTDs and malformed nesting; handles namespaces and CDATA', () => {
  assert.throws(() => parseXml('<!DOCTYPE x><x/>'))
  assert.throws(() => parseXml('<a><b></a>'))
  assert.equal(value(parseXml('<s:a xmlns:s="x"><s:Title><![CDATA[A & B]]></s:Title></s:a>'), 'Title'), 'A & B')
})
test('description honors URLBase and distinguishes group volume from room volume', async () => {
  const d = await describe('http://192.168.1.22/device.xml', async () => response('<URLBase>http://192.168.1.22:1400/</URLBase><device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><UDN>uuid:RINCON_1</UDN><manufacturer>Sonos</manufacturer><friendlyName>Kitchen</friendlyName><serviceList>' +
    ['AVTransport', 'RenderingControl', 'GroupRenderingControl'].map(n => `<service><serviceType>urn:schemas-upnp-org:service:${n}:1</serviceType><controlURL>${n}</controlURL></service>`).join('') + '</serviceList></device>'))
  assert.equal(d.services.RenderingControl.url, 'http://192.168.1.22:1400/RenderingControl')
  assert.equal(d.services.GroupRenderingControl.url, 'http://192.168.1.22:1400/GroupRenderingControl')
  assert.equal(d.sonos, true)
})
test('Sonos stages a native queue with covers; edits preserve the playing item', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await f.controller.connect(device(true))
  await f.controller.setWindow({ current: { id: 'a' }, upcoming: [{ id: 'b' }, { id: 'c' }], play: true })
  const before = f.commands.filter(c => c.action === 'SetAVTransportURI').length
  assert.equal(f.commands.filter(c => c.action === 'AddURIToQueue').length, 3)
  const queued = value(f.commands.find(c => c.action === 'AddURIToQueue').doc, 'EnqueuedURIMetaData')
  const metadata = parseXml(queued)
  assert.equal(value(metadata, 'albumArtURI'), 'http://192.168.1.4/art.jpg')
  assert.equal(value(metadata, 'creator'), 'Artist')
  assert.equal(nodes(metadata, 'res')[0].attrs.duration, '00:03:00')
  assert.equal(value(metadata, 'desc'), 'RINCON_AssociatedZPUDN')
  assert.equal(nodes(metadata, 'desc')[0].attrs.id, 'cdudn')
  await f.controller.setWindow({ current: { id: 'a' }, upcoming: [{ id: 'c' }], play: true })
  assert.equal(f.commands.filter(c => c.action === 'SetAVTransportURI').length, before)
  const removed = f.commands.find(c => c.action === 'RemoveTrackRangeFromQueue')
  assert.equal(value(removed.doc, 'StartingIndex'), '2')
  assert.equal(value(removed.doc, 'NumberOfTracks'), '2')
})
test('repeated Sonos tracks get distinct numeric IDs in the actual queue requests', async t => {
  const f = fixture()
  t.after(() => f.controller.cleanup())
  await f.controller.connect(device(true))
  await f.controller.setWindow({ current: { id: 'a' }, upcoming: [{ id: 'a' }, { id: 'b' }] })
  const metadata = f.commands.filter(c => c.action === 'AddURIToQueue')
    .map(c => parseXml(value(c.doc, 'EnqueuedURIMetaData')))
  assert.deepEqual(metadata.map(doc => nodes(doc, 'item')[0].attrs.id), ['1', '2', '3'])
  assert.equal(value(metadata[0], 'res'), value(metadata[1], 'res'))
})
test('Sonos uses its own cover URL for converted audio with an embedded image', async t => {
  const f = fixture(true, true, true)
  t.after(() => f.controller.cleanup())
  f.controller.fetch = async (url, options) => {
    if (options.method === 'POST') return f.fetchImpl(url, options)
    const art = new URL(url)
    assert.equal(art.origin, 'http://192.168.1.20')
    assert.equal(art.pathname, '/getaa')
    const succeed = art.searchParams.get('u').endsWith('/a')
    return new Response(succeed ? Uint8Array.of(255, 216, 255) : '', {
      status: succeed ? 200 : 404, headers: { 'content-type': 'image/jpeg' },
    })
  }
  await f.controller.connect(device(true))
  await f.controller.setWindow({ current: { id: 'a' }, upcoming: [{ id: 'b' }] })
  const queued = f.commands.filter(c => c.action === 'AddURIToQueue')
  assert.equal(value(queued[0].doc, 'DesiredFirstTrackNumberEnqueued'), '1')
  const artwork = command => value(parseXml(value(command.doc, 'EnqueuedURIMetaData')), 'albumArtURI')
  assert.equal(artwork(queued[0]), '/getaa?u=http%3A%2F%2F192.168.1.4%2Fmedia%2Fa')
  assert.equal(artwork(queued[1]), 'http://192.168.1.4/art.jpg')
})
test('Sonos acknowledging zero added tracks prevents starting an empty queue', async t => {
  const f = fixture()
  t.after(() => f.controller.cleanup())
  f.controller.fetch = (url, options) => options.headers.SOAPAction.includes('#AddURIToQueue')
    ? response('<NumTracksAdded>0</NumTracksAdded>') : f.fetchImpl(url, options)
  await f.controller.connect(device(true))
  await assert.rejects(f.controller.setWindow({ current: { id: 'a' } }), /requested queue position/)
  assert(!f.commands.some(c => c.action === 'Play'))
})
test('receiver queue advancement reports its new song and clock', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await f.controller.connect(device(true))
  await f.controller.setWindow({ current: { id: 'a' }, upcoming: [{ id: 'b' }] })
  f.setUri('http://192.168.1.4/media/b'); await f.controller.poll()
  assert.equal(f.controller.status().trackId, 'b'); assert.equal(f.controller.status().position, 12)
})
test('group volume is clamped and receiver-side changes are reflected', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await f.controller.connect(device(true))
  await f.controller.setVolume({ level: 4, muted: true })
  assert.equal(value(f.commands.find(c => c.action === 'SetGroupVolume').doc, 'DesiredVolume'), '100')
  assert(f.commands.some(c => c.action === 'SetGroupMute'))
  await f.controller.readVolume(); assert.equal(f.controller.status().volume.level, .37)
  await assert.rejects(f.controller.setVolume({ level: NaN }), /Invalid volume/)
})
test('generic renderers get SetNextAVTransportURI and ordinary RenderingControl', async t => {
  const f = fixture(false); t.after(() => f.controller.cleanup()); await f.controller.connect(device(false))
  await f.controller.setWindow({ current: { id: 'a' }, upcoming: [{ id: 'b' }] })
  assert(f.commands.some(c => c.action === 'SetNextAVTransportURI'))
  assert(!f.commands.some(c => c.action === 'AddURIToQueue'))
  const next = f.commands.find(c => c.action === 'SetNextAVTransportURI')
  assert.equal(value(parseXml(value(next.doc, 'NextURIMetaData')), 'desc'), '')
  await f.controller.setVolume({ level: .23 }); assert(f.commands.some(c => c.action === 'SetVolume'))
})
test('unconfirmed Stop keeps remote ownership and refuses local handoff', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await f.controller.connect(device(true)); await f.controller.setWindow({ current: { id: 'a' }, upcoming: [] }); f.failStop()
  await assert.rejects(f.controller.disconnect(), /offline/); assert.equal(f.controller.status().state, 'connected')
})
test('unrelated external playback relinquishes ownership without stopping that music', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await f.controller.connect(device(true))
  await f.controller.setWindow({ current: { id: 'a' }, upcoming: [] }); const before = f.commands.filter(c => c.action === 'Stop').length
  f.setExternal('http://other-controller/music'); let ended; f.controller.on('ended', e => { ended = e }); await f.controller.poll()
  assert.equal(ended.reason, 'stopped'); assert.equal(f.commands.filter(c => c.action === 'Stop').length, before)
})
test('clock handles hours, invalid durations and negative seeks', () => {
  assert.equal(seconds('01:02:03'), 3723); assert.equal(seconds('NOT_IMPLEMENTED'), 0); assert.equal(timestamp(-5), '00:00:00')
})
test('a delayed status poll cannot undo a newer pause command', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await f.controller.connect(device(true))
  await f.controller.setWindow({ current: { id: 'a' }, upcoming: [] }); f.setUri('http://192.168.1.4/media/a')
  let release; const blocked = new Promise(resolve => { release = resolve })
  f.controller.fetch = async (url, options) => {
    if (options.headers.SOAPAction.includes('GetPositionInfo')) await blocked
    return f.fetchImpl(url, options)
  }
  const poll = f.controller.poll(); await f.controller.pause(); release(); await poll
  assert.equal(f.controller.status().playerState, 'PAUSED')
})
test('selecting a grouped Sonos room targets its current coordinator without regrouping', async () => {
  const selected = { ...device(true), uuid: 'MEMBER', services: { ...device(true).services, ZoneGroupTopology: svc('ZoneGroupTopology') } }
  const topology = '<ZoneGroups><ZoneGroup Coordinator="MASTER"><ZoneGroupMember UUID="MEMBER" Location="http://192.168.1.20/device.xml"/><ZoneGroupMember UUID="MASTER" Location="http://192.168.1.30/device.xml"/></ZoneGroup></ZoneGroups>'
  const calls = []
  const master = await coordinator(selected, async (url, options) => {
    calls.push({ url, options })
    if (options.method === 'POST') return response(`<ZoneGroupState>${escapeXml(topology)}</ZoneGroupState>`)
    return response('<device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><manufacturer>Sonos</manufacturer><UDN>uuid:MASTER</UDN><friendlyName>Living room</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service></serviceList></device>')
  })
  assert.equal(master.id, selected.id); assert.equal(master.uuid, 'MASTER'); assert.equal(master.host, '192.168.1.30'); assert.equal(master.kind, 'group')
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1)
})

test('unrecognized references keep ownership inconclusive without overwriting the queue', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await f.controller.connect(device(true))
  await f.controller.setWindow({ current: { id: 'a' }, upcoming: [] })
  f.setUri('x-rincon-queue:RINCON_20#0'); await f.controller.poll()
  assert.equal(f.controller.status().state, 'connected')
  assert.equal(f.controller.ownershipUncertain, true)
  const before = f.commands.length
  await f.controller.setWindow({ current: { id: 'b' }, upcoming: [] })
  assert.equal(f.commands.length, before)
})
test('equivalent percent-encoded track references preserve the current item', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await f.controller.connect(device(true))
  await f.controller.setWindow({ current: { id: 'a' }, upcoming: [] })
  f.setUri('http://192.168.1.4/media/%61'); await f.controller.poll()
  assert.equal(f.controller.status().state, 'connected'); assert.equal(f.controller.status().trackId, 'a')
})
test('successful polls clear only the transient reachability error', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await f.controller.connect(device(true))
  await f.controller.setWindow({ current: { id: 'a' }, upcoming: [] }); f.setUri('http://192.168.1.4/media/a')
  f.controller.failedPoll(new Error('temporary')); await f.controller.poll()
  assert.equal(f.controller.status().error, null)
  f.controller.error = 'A separate queue failure'; await f.controller.poll()
  assert.equal(f.controller.status().error, 'A separate queue failure')
})
test('discovery rejects non-LAN receiver addresses before performing HTTP', async () => {
  let requests = 0
  for (const address of ['http://127.0.0.1/device', 'http://0.0.0.0/device', 'http://8.8.8.8/device', 'http://speaker.example/device'])
    await assert.rejects(describe(address, async () => { requests++; return response('') }), /Unsupported receiver address/)
  assert.equal(requests, 0)
})
test('XML metadata strips forbidden controls while preserving valid whitespace', () => {
  assert.equal(escapeXml('A\u0000\u000B & B\n'), 'A &amp; B\n')
})

test('live discovery wins over stale manual addresses without duplicating devices', () => {
  const { mergeDevices } = require('../electron/cast/discovery')
  const found = mergeDevices([{ id: 'room', name: 'Old', host: '192.168.1.3', manual: true, kind: 'speaker' }],
    [{ id: 'room', name: 'Kitchen', host: '192.168.1.50', kind: 'speaker' }, { id: 'tv', name: 'TV', kind: 'tv' }])
  assert.equal(found.length, 2); assert.equal(found[0].id, 'tv')
  assert.equal(found[1].host, '192.168.1.50'); assert.equal(found[1].manual, true)
})

test('the latest queue edit applies when the current speaker item becomes identifiable again', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup()); await f.controller.connect(device(true))
  const current = { id: 'a' }
  await f.controller.setWindow({ current, upcoming: [{ id: 'b' }] })
  f.setUri('x-rincon-queue:RINCON_20#0'); await f.controller.poll()
  await f.controller.setWindow({ current, upcoming: [{ id: 'c' }] })
  await f.controller.setWindow({ current, upcoming: [{ id: 'd' }] })
  assert.deepEqual(f.controller.entries.map(item => item.trackId), ['a', 'b'])
  f.setUri('http://192.168.1.4/media/a'); await f.controller.poll()
  await f.controller.serial
  assert.deepEqual(f.controller.entries.map(item => item.trackId), ['a', 'd'])
})

test('a browsed external Sonos queue item relinquishes ownership without sending Stop', async t => {
  const f = fixture(); t.after(() => f.controller.cleanup())
  const receiver = device(true)
  receiver.services.ContentDirectory = svc('ContentDirectory')
  await f.controller.connect(receiver)
  await f.controller.setWindow({ current: { id: 'a' }, upcoming: [] })
  const external = 'http://other-controller/music'
  f.setExternal(external)
  const metadata = escapeXml('<DIDL-Lite><item><res>' + external + '</res></item></DIDL-Lite>')
  let browseResult = ''
  f.controller.fetch = (url, options) => {
    if (options.headers.SOAPAction.includes('GetMediaInfo')) return response('<CurrentURI>x-rincon-queue:RINCON_20#0</CurrentURI>')
    if (options.headers.SOAPAction.includes('#Browse')) {
      assert.equal(value(parseXml(options.body), 'ObjectID'), 'Q:0')
      assert.equal(value(parseXml(options.body), 'StartingIndex'), '1')
      return response('<Result>' + browseResult + '</Result>')
    }
    return f.fetchImpl(url, options)
  }
  const stops = f.commands.filter(c => c.action === 'Stop').length
  let ended; f.controller.on('ended', event => { ended = event })
  await f.controller.poll()
  assert.equal(f.controller.ownershipUncertain, true)
  assert.equal(ended, undefined)
  browseResult = metadata
  await f.controller.poll()
  assert.equal(ended.reason, 'stopped')
  assert.equal(f.commands.filter(c => c.action === 'Stop').length, stops)
})

test('UpnpDiscovery sends SSDP M-SEARCH on every physical LAN interface with explicit multicast interface', async t => {
  const { EventEmitter } = require('events')
  const sockets = []
  const discovery = new UpnpDiscovery({
    interfaces: () => [{ address: '192.168.1.23' }, { address: '10.0.0.9' }],
    mdns: null,
    createSocket: () => {
      const sock = new EventEmitter()
      sock.bound = null
      sock.ttl = null
      sock.multicastInterface = null
      sock.sent = []
      sock.closed = false
      sock.bind = (port, address, cb) => {
        if (typeof address === 'function') { cb = address; address = null }
        sock.bound = { port, address }
        cb?.()
      }
      sock.setMulticastTTL = ttl => { sock.ttl = ttl }
      sock.setMulticastInterface = addr => { sock.multicastInterface = addr }
      sock.send = (buf, port, host) => sock.sent.push({ text: String(buf), port, host })
      sock.close = () => { sock.closed = true }
      sockets.push(sock)
      return sock
    },
    fetchImpl: async url => {
      assert.equal(url, 'http://192.168.1.50:1400/xml/device_description.xml')
      return response('<device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><UDN>uuid:RINCON_50</UDN><manufacturer>Sonos, Inc.</manufacturer><roomName>Office</roomName><modelName>Sonos One</modelName><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/MediaRenderer/AVTransport/Control</controlURL></service></serviceList></device>')
    },
  })
  t.after(() => discovery.stop())
  const found = new Promise(resolve => discovery.once('change', resolve))
  discovery.scan()
  assert.equal(sockets.length, 2)
  assert.deepEqual(sockets.map(s => s.bound.address), ['192.168.1.23', '10.0.0.9'])
  assert.deepEqual(sockets.map(s => s.multicastInterface), ['192.168.1.23', '10.0.0.9'])
  assert.deepEqual(sockets.map(s => s.ttl), [4, 4])
  assert.ok(sockets.every(s => s.sent.length === 2 && s.sent.some(m => m.text.includes('ZonePlayer:1'))))
  sockets[0].emit('message', Buffer.from('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.50:1400/xml/device_description.xml\r\n\r\n'))
  const list = await found
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'Office')
  assert.equal(list[0].sonos, true)
})

test('UpnpDiscovery finds Sonos via mDNS _sonos._tcp.local (even when SSDP gets no reply) and expands visible ZoneGroupTopology rooms', async t => {
  const { EventEmitter } = require('events')
  const { SONOS_MDNS_SERVICE } = require('../electron/cast/upnp')
  const mdns = new EventEmitter()
  mdns.queries = []
  mdns.destroyed = 0
  mdns.query = q => mdns.queries.push(q)
  mdns.destroy = () => { mdns.destroyed++ }

  const topology = '<ZoneGroups><ZoneGroup Coordinator="RINCON_50">' +
    '<ZoneGroupMember UUID="RINCON_50" Location="http://192.168.1.50:1400/xml/device_description.xml"/>' +
    '<ZoneGroupMember UUID="RINCON_51" Location="http://192.168.1.51:1400/xml/device_description.xml"/>' +
    '<ZoneGroupMember UUID="RINCON_SUB" Location="http://192.168.1.52:1400/xml/device_description.xml" Invisible="1"/>' +
    '</ZoneGroup></ZoneGroups>'
  const xmlFor = (uuid, room) => response(
    `<device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><UDN>uuid:${uuid}</UDN><manufacturer>Sonos, Inc.</manufacturer><roomName>${room}</roomName><serviceList>` +
    '<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/MediaRenderer/AVTransport/Control</controlURL></service>' +
    '<service><serviceType>urn:schemas-upnp-org:service:ZoneGroupTopology:1</serviceType><controlURL>/ZoneGroupTopology/Control</controlURL></service>' +
    '</serviceList></device>'
  )

  const fetched = []
  const discovery = new UpnpDiscovery({
    interfaces: () => [],
    createSocket: () => {
      const sock = new EventEmitter()
      sock.bind = (_p, cb) => cb?.()
      sock.send = () => {}
      sock.close = () => {}
      return sock
    },
    mdns: () => mdns,
    fetchImpl: async (url, options = {}) => {
      fetched.push(url)
      if (options.method === 'POST') return response(`<ZoneGroupState>${escapeXml(topology)}</ZoneGroupState>`)
      if (url.includes('192.168.1.50')) return xmlFor('RINCON_50', 'Living Room')
      if (url.includes('192.168.1.51')) return xmlFor('RINCON_51', 'Bedroom')
      throw new Error(`unexpected ${url}`)
    },
  })
  t.after(() => discovery.stop())
  const twoFound = new Promise(resolve => {
    discovery.on('change', list => { if (list.length === 2) resolve(list) })
  })
  discovery.scan()
  assert.ok(mdns.queries.some(q => q.questions.some(entry => entry.name === SONOS_MDNS_SERVICE && entry.type === 'PTR')))
  // Split mDNS packets: PTR -> SRV (port 1443 on Sonos S2) -> A.
  mdns.emit('response', { answers: [{ type: 'PTR', name: SONOS_MDNS_SERVICE, data: 'Sonos-50.' + SONOS_MDNS_SERVICE }] })
  assert.ok(mdns.queries.some(q => q.questions.some(entry => entry.name === 'Sonos-50.' + SONOS_MDNS_SERVICE && entry.type === 'SRV')))
  mdns.emit('response', { answers: [{ type: 'SRV', name: 'Sonos-50.' + SONOS_MDNS_SERVICE, data: { target: 'Sonos-50.local', port: 1443 } }] })
  assert.ok(mdns.queries.some(q => q.questions.some(entry => entry.name === 'sonos-50.local' && entry.type === 'A')))
  mdns.emit('response', { answers: [{ type: 'A', name: 'Sonos-50.local', data: '192.168.1.50', ttl: 120 }] })

  const list = await twoFound
  assert.deepEqual(list.map(d => d.name).sort(), ['Bedroom', 'Living Room'])
  assert.ok(!fetched.some(url => url.includes('192.168.1.52')), 'bonded invisible speakers are not probed')
  discovery.stop()
  assert.equal(mdns.destroyed, 1)
})

test('UpnpController reports a Linux firewall error when Sonos never fetches from the media server, and clears it once a request arrives', async t => {
  const f = fixture()
  let requestCount = 0
  const media = {
    prepare: async track => ({
      trackId: String(track.id),
      url: `http://192.168.1.4:3422/token/key/${track.id}.flac`,
      duration: 180,
      mime: 'audio/flac',
      metadata: { title: `Song ${track.id}`, artist: 'Artist', albumName: 'Album', images: [] },
    }),
    release: () => {},
  }
  const server = {
    start: async () => 3422,
    stop: () => {},
    get port() { return 3422 },
    get requestCount() { return requestCount },
  }
  const controller = new UpnpController({
    media,
    server,
    fetchImpl: f.fetchImpl,
    reachabilityTimeoutMs: 60,
    platform: 'linux',
  })
  t.after(() => controller.cleanup())
  await controller.connect(device(true))
  f.setState('TRANSITIONING')
  await controller.setWindow({ current: { id: 'a', title: 'Test Song' }, upcoming: [], play: true })
  const end = Date.now() + 1000
  while (Date.now() < end && !/TCP port 3422/.test(controller.status().error || '')) {
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.match(controller.status().error || '', /TCP port 3422/)
  assert.match(controller.status().error || '', /firewall/i)
  requestCount = 1
  f.setUri('http://192.168.1.4:3422/token/key/a.flac')
  f.setState('PLAYING')
  await controller.poll()
  assert.equal(controller.status().error, null)
})

test('UpnpDiscovery listens for multicast SSDP NOTIFY announcements on 239.255.255.250:1900 and describe() accepts AVTransport devices regardless of deviceType', async t => {
  const { EventEmitter } = require('events')
  const notifySock = new EventEmitter()
  notifySock.boundPort = null
  notifySock.memberships = []
  notifySock.closed = false
  notifySock.bind = (port, cb) => { notifySock.boundPort = port; cb?.() }
  notifySock.addMembership = (group, iface) => notifySock.memberships.push({ group, iface })
  notifySock.close = () => { notifySock.closed = true }

  const probed = []
  const discovery = new UpnpDiscovery({
    interfaces: () => [{ address: '192.168.1.178' }],
    mdns: null,
    createSocket: () => {
      const sock = new EventEmitter()
      sock.bind = (_p, _a, cb) => cb?.()
      sock.send = () => {}
      sock.close = () => {}
      return sock
    },
    createNotifySocket: () => notifySock,
    fetchImpl: async url => {
      probed.push(url)
      return response(
        '<device><deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType>' +
        '<UDN>uuid:TURNTABLE_1</UDN><manufacturer>Victrola</manufacturer><friendlyName>Stream Turntable</friendlyName>' +
        '<serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>' +
        '<controlURL>/AVTransport/control</controlURL></service></serviceList></device>'
      )
    },
  })
  t.after(() => discovery.stop())

  const found = new Promise(resolve => discovery.once('change', resolve))
  discovery.scan()
  assert.equal(notifySock.boundPort, 1900)
  assert.deepEqual(notifySock.memberships, [{ group: '239.255.255.250', iface: '192.168.1.178' }])

  // Non-audio devices and ssdp:byebye announcements are ignored.
  notifySock.emit('message', Buffer.from('NOTIFY * HTTP/1.1\r\nNT: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nNTS: ssdp:alive\r\nLOCATION: http://192.168.1.1/rootDesc.xml\r\n\r\n'))
  notifySock.emit('message', Buffer.from('NOTIFY * HTTP/1.1\r\nNT: urn:schemas-upnp-org:device:MediaRenderer:1\r\nNTS: ssdp:byebye\r\nLOCATION: http://192.168.1.88:1400/desc.xml\r\n\r\n'))
  assert.equal(probed.length, 0)

  // A MediaRenderer/AVTransport ssdp:alive NOTIFY triggers probing even when M-SEARCH replies are blocked.
  notifySock.emit('message', Buffer.from('NOTIFY * HTTP/1.1\r\nNT: urn:schemas-upnp-org:service:AVTransport:1\r\nNTS: ssdp:alive\r\nLOCATION: http://192.168.1.90:49152/description.xml\r\n\r\n'))
  const list = await found
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'Stream Turntable')
  assert.equal(list[0].services.AVTransport.url, 'http://192.168.1.90:49152/AVTransport/control')

  discovery.stop()
  assert.equal(notifySock.closed, true)
})


