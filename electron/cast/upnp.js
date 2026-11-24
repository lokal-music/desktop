const { EventEmitter } = require('events')
const { isIPv4 } = require('net')
const { escapeXml, parseXml, nodes, value, timestamp } = require('./upnpXml')
const TYPES = ['urn:schemas-upnp-org:device:MediaRenderer:1', 'urn:schemas-upnp-org:device:ZonePlayer:1']
const SONOS_MDNS_SERVICE = '_sonos._tcp.local'
const AV = 'urn:schemas-upnp-org:service:AVTransport:1'
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1'
const ZG = 'urn:schemas-upnp-org:service:ZoneGroupTopology:1'
const GROUP_RC = 'urn:schemas-upnp-org:service:GroupRenderingControl:1'
const FORGET_AFTER_MS = 240000
const PROBE_COOLDOWN_MS = 5000
const TOPOLOGY_COOLDOWN_MS = 15000
const dnsName = name => String(name || '').replace(/\.$/, '').toLowerCase()

function lanUrl(input, base) {
  const url = new URL(input, base)
  // Descriptions may advertise URLs on other LAN interfaces, never credentials
  // or non-HTTP protocols. Playback media itself is served by Lokal's server.
  const octets = url.hostname.split('.').map(Number)
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && octets.every(n => n >= 0 && n <= 255)
  const privateHost = ipv4 && (octets[0] === 10 || octets[0] === 192 && octets[1] === 168 ||
    octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 169 && octets[1] === 254)
  if (url.protocol !== 'http:' || url.username || url.password || !privateHost) throw new Error('Unsupported receiver address')
  return url.href
}
async function request(url, options = {}, fetchImpl = fetch) {
  url = lanUrl(url)
  const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) })
  const text = await response.text()
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Receiver response too large')
  const doc = parseXml(text)
  if (!response.ok || nodes(doc, 'Fault').length) throw new Error(value(doc, 'errorDescription') || `Receiver HTTP ${response.status}`)
  return doc
}
async function soap(url, type, action, args = {}, fetchImpl = fetch) {
  return request(url, {
    method: 'POST', headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${type}#${action}"` },
    body: '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
      `<u:${action} xmlns:u="${type}">` + Object.entries(args).map(([key, val]) => `<${key}>${escapeXml(val)}</${key}>`).join('') + `</u:${action}></s:Body></s:Envelope>`,
  }, fetchImpl)
}
async function speakerArtwork(controlUrl, mediaUrl, fetchImpl = fetch) {
  try {
    const url = new URL('/getaa', lanUrl(controlUrl))
    url.searchParams.set('u', mediaUrl)
    const response = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(800) })
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    await response.body?.cancel()
    if (response.status === 200 && ['image/jpeg', 'image/png'].includes(type)) return url.pathname + url.search
  } catch {} // Missing embedded cover or unsupported extraction.
  return null
}
async function describe(location, fetchImpl = fetch) {
  location = lanUrl(location)
  const doc = await request(location, {}, fetchImpl)
  const allDevices = nodes(doc, 'device')
  const device = allDevices.find(d => /MediaRenderer|ZonePlayer/.test(d.children.find(x => x.name === 'deviceType')?.text || ''))
    || allDevices.find(d => nodes(d, 'service').some(s => /AVTransport/i.test(value(s, 'serviceType'))))
  if (!device) return null
  const services = {}
  const base = value(doc, 'URLBase') || location
  for (const svc of nodes(device, 'service')) {
    const type = value(svc, 'serviceType')
    const name = type.split(':').at(-2)
    if (name && value(svc, 'controlURL')) services[name] = { type, url: lanUrl(value(svc, 'controlURL'), base) }
  }
  if (!services.AVTransport) return null
  const manufacturer = value(device, 'manufacturer') || value(doc, 'manufacturer')
  const udn = value(device, 'UDN') || value(doc, 'UDN')
  const sonos = /sonos/i.test(manufacturer) || !!services.ZoneGroupTopology
  return {
    id: `upnp:${udn || location}`,
    uuid: udn.replace(/^uuid:/, ''),
    name: value(device, 'roomName') || value(doc, 'roomName') || value(device, 'friendlyName') || value(doc, 'friendlyName') || new URL(location).hostname,
    model: value(device, 'modelName') || value(doc, 'modelName'),
    host: new URL(location).hostname,
    kind: 'speaker',
    backend: 'upnp',
    sonos,
    location,
    services,
  }
}

// Resolves a selected room to its current group coordinator without regrouping.
async function coordinator(device, fetchImpl = fetch) {
  if (!device.sonos || !device.services.ZoneGroupTopology) return device
  const svc = device.services.ZoneGroupTopology
  const result = await soap(svc.url, svc.type || ZG, 'GetZoneGroupState', {}, fetchImpl)
  const doc = parseXml(value(result, 'ZoneGroupState'))
  const group = nodes(doc, 'ZoneGroup').find(g => nodes(g, 'ZoneGroupMember').some(m => m.attrs.UUID === device.uuid))
  const members = group && nodes(group, 'ZoneGroupMember')
  const master = members?.find(m => m.attrs.UUID === group.attrs.Coordinator)
  if (!master) throw new Error('The Sonos room has no reachable group coordinator')
  const target = master.attrs.UUID === device.uuid ? device : await describe(master.attrs.Location, fetchImpl)
  if (!target) throw new Error('The Sonos coordinator could not be resolved')
  return { ...target, id: device.id, name: members.length > 1 ? `${device.name} (${members.length} rooms)` : device.name, kind: members.length > 1 ? 'group' : 'speaker' }
}

class UpnpDiscovery extends EventEmitter {
  constructor({
    log = () => {},
    fetchImpl = fetch,
    createSocket,
    createNotifySocket,
    interfaces = () => require('../network/lanInterfaces').lanInterfaces(),
    mdns = () => require('../network/mdns').acquireMdns(),
    now = Date.now,
  } = {}) {
    super()
    const defaultSocket = () => require('dgram').createSocket({ type: 'udp4', reuseAddr: true })
    this.log = log
    this.fetch = fetchImpl
    this.createSocket = createSocket || defaultSocket
    this.createNotifySocket = createNotifySocket !== undefined
      ? createNotifySocket
      : (createSocket ? null : defaultSocket)
    this.interfaces = interfaces
    this.createMdns = mdns
    this.now = now
    this.devices = new Map()
    this.pending = new Set()
    this.probedAt = new Map()
    this.topologyAt = new Map()
    this.sockets = []
    this.notifySocket = null
    this.mdns = null
    this.mdnsKnown = new Map()
    this.mdnsAddresses = new Map()
    this.timer = null
    this.retryTimer = null
  }

  startMdns() {
    if (this.mdns || typeof this.createMdns !== 'function') return
    try {
      this.mdns = this.createMdns()
      this.mdns.on('response', response => this.onMdnsResponse(response))
      this.mdns.on('error', error => this.log(`Sonos mDNS: ${error?.message || error}`))
    } catch (error) {
      this.log(`Sonos mDNS unavailable: ${error?.message || error}`)
      this.mdns = null
    }
  }

  askMdns() {
    try { this.mdns?.query({ questions: [{ name: SONOS_MDNS_SERVICE, type: 'PTR' }] }) } catch (error) { this.log(`Sonos mDNS query: ${error?.message || error}`) }
  }

  // Passive multicast SSDP NOTIFY listener (239.255.255.250:1900).
  // Linux firewalls like UFW allow multicast port 1900 by default even when
  // unicast M-SEARCH replies to ephemeral ports are dropped.
  startNotifyListener(addresses = []) {
    if (this.notifySocket || typeof this.createNotifySocket !== 'function') return
    let socket
    try { socket = this.createNotifySocket() } catch { return }
    this.notifySocket = socket
    socket.on('error', error => {
      this.log(`UPnP notify: ${error?.message || error}`)
      if (this.notifySocket === socket) this.notifySocket = null
      try { socket.close() } catch {}
    })
    socket.on('message', data => this.onNotify(data))
    const join = () => {
      if (this.notifySocket !== socket) { try { socket.close() } catch {} return }
      const targets = addresses.length ? addresses : [null]
      for (const address of targets) {
        try {
          if (address) socket.addMembership?.('239.255.255.250', address)
          else socket.addMembership?.('239.255.255.250')
        } catch {}
      }
    }
    try {
      socket.bind(1900, join)
    } catch {
      if (this.notifySocket === socket) this.notifySocket = null
      try { socket.close() } catch {}
    }
  }

  onNotify(data) {
    const text = String(data || '')
    if (!/^NOTIFY\s+\*\s+HTTP\/1\.[01]/i.test(text)) return
    const nts = text.match(/^nts\s*:\s*(.+)$/im)?.[1]?.trim() || ''
    if (/ssdp:byebye/i.test(nts)) return
    const nt = text.match(/^nt\s*:\s*(.+)$/im)?.[1]?.trim() || ''
    if (!/MediaRenderer|ZonePlayer|AVTransport/i.test(nt)) return
    const location = text.match(/^location\s*:\s*(.+)$/im)?.[1]?.trim()
    if (location) this.probeLocation(location)
  }

  scan() {
    this.startMdns()
    this.askMdns()
    let addresses = []
    try {
      addresses = [...new Set((this.interfaces?.() || []).map(entry => entry?.address).filter(address => isIPv4(address || '')))]
    } catch (error) {
      this.log(`UPnP interfaces: ${error?.message || error}`)
    }
    this.startNotifyListener(addresses)
    for (const entry of this.devices.values()) {
      if (entry.device?.location) this.probeLocation(entry.device.location)
    }
    if (!this.sockets.length) {
      const targets = addresses.length ? addresses : [null]
      for (const address of targets) {
        let socket
        try { socket = this.createSocket() } catch (error) { this.log(`UPnP discovery: ${error?.message || error}`); continue }
        const entry = { socket, address, ready: false }
        this.sockets.push(entry)
        socket.on('error', error => this.log(`UPnP discovery: ${error.message}`))
        socket.on('message', data => this.onMessage(data))
        const onReady = () => {
          entry.ready = true
          try { socket.setMulticastTTL?.(4) } catch {}
          if (address) try { socket.setMulticastInterface?.(address) } catch {}
          this.askSocket(socket)
        }
        try {
          if (address) socket.bind(0, address, onReady)
          else socket.bind(0, onReady)
        } catch (error) {
          this.log(`UPnP bind ${address || 'default'}: ${error?.message || error}`)
          try { socket.close() } catch {}
          this.sockets = this.sockets.filter(item => item !== entry)
        }
      }
    } else this.ask()
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => { this.ask(); this.askMdns() }, 1000)
    this.retryTimer.unref?.()
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.closeSockets(), 4500)
    this.timer.unref?.()
  }

  askSocket(socket) {
    for (const type of TYPES) {
      const query = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${type}\r\n\r\n`)
      try { socket.send(query, 1900, '239.255.255.250') } catch {}
    }
  }

  ask() {
    for (const entry of this.sockets) {
      if (entry.ready) this.askSocket(entry.socket)
    }
  }

  closeSockets() {
    const open = this.sockets
    this.sockets = []
    for (const entry of open) {
      try { entry.socket?.close() } catch {}
    }
  }

  onMdnsResponse(response) {
    const records = [...(response?.answers || []), ...(response?.additionals || [])]
    const now = this.now()
    const touched = new Set()
    const updatedHosts = new Set()
    for (const record of records) {
      if (record.type === 'A' && record.name && isIPv4(record.data)) {
        const host = dnsName(record.name)
        updatedHosts.add(host)
        if (record.ttl === 0) {
          if (this.mdnsAddresses.get(host)?.address === record.data) this.mdnsAddresses.delete(host)
        } else {
          this.mdnsAddresses.set(host, {
            address: record.data,
            expires: now + Math.min(record.ttl > 0 ? record.ttl * 1000 : FORGET_AFTER_MS, FORGET_AFTER_MS),
          })
        }
      }
    }
    for (const record of records) {
      const name = String(record.name || '')
      const key = dnsName(name)
      const ptr = record.type === 'PTR' && key === SONOS_MDNS_SERVICE
      if (!ptr && (record.type !== 'SRV' || !key.endsWith('.' + SONOS_MDNS_SERVICE))) continue
      const instance = ptr ? String(record.data || '') : name
      const id = dnsName(instance)
      if (!id.endsWith('.' + SONOS_MDNS_SERVICE) || record.ttl === 0) continue
      const entry = this.mdnsKnown.get(id) || { name: instance.replace(/\.$/, '') }
      if (record.type === 'SRV') {
        entry.target = dnsName(record.data?.target)
        entry.port = record.data?.port || 1400
      }
      entry.lastSeen = now
      this.mdnsKnown.set(id, entry)
      touched.add(id)
    }
    for (const [id, entry] of this.mdnsKnown) {
      if (now - entry.lastSeen > FORGET_AFTER_MS) { this.mdnsKnown.delete(id); continue }
      const cached = entry.target ? this.mdnsAddresses.get(entry.target) : null
      const host = cached && cached.expires > now ? cached.address : undefined
      const hostUpdated = Boolean(host && (entry.host !== host || updatedHosts.has(entry.target)))
      if (hostUpdated) entry.host = host
      if (!touched.has(id) && !hostUpdated) continue
      if (!entry.target) {
        try { this.mdns?.query({ questions: [{ name: entry.name, type: 'SRV' }] }) } catch {}
      } else if (!host) {
        try { this.mdns?.query({ questions: [{ name: entry.target, type: 'A' }] }) } catch {}
      } else {
        this.probeLocation(`http://${host}:1400/xml/device_description.xml`)
      }
    }
  }

  onMessage(data) {
    const location = String(data).match(/^location\s*:\s*(.+)$/im)?.[1]?.trim()
    if (location) this.probeLocation(location)
  }

  async probeLocation(location) {
    const now = this.now()
    if (!location || this.pending.has(location)) return
    if (now - (this.probedAt.get(location) || 0) < PROBE_COOLDOWN_MS) return
    this.pending.add(location)
    this.probedAt.set(location, now)
    try {
      const device = await describe(location, this.fetch)
      if (device) {
        const before = this.devices.get(device.id)?.device
        const changed = !before || before.name !== device.name || before.host !== device.host || before.location !== device.location
        this.devices.set(device.id, { device, at: this.now() })
        if (changed) this.emit('change', this.list())
        if (device.sonos && device.services?.ZoneGroupTopology) this.expandSonosTopology(device)
      }
    } catch (error) {
      this.log(`UPnP: ${error.message}`)
    } finally {
      this.pending.delete(location)
    }
  }

  async expandSonosTopology(device) {
    const now = this.now()
    if (now - (this.topologyAt.get(device.id) || 0) < TOPOLOGY_COOLDOWN_MS) return
    this.topologyAt.set(device.id, now)
    try {
      const svc = device.services.ZoneGroupTopology
      const result = await soap(svc.url, svc.type || ZG, 'GetZoneGroupState', {}, this.fetch)
      const doc = parseXml(value(result, 'ZoneGroupState'))
      for (const member of nodes(doc, 'ZoneGroupMember')) {
        if (member.attrs.Location && member.attrs.Invisible !== '1') {
          this.probeLocation(member.attrs.Location)
        }
      }
    } catch {}
  }

  list() { return [...this.devices.values()].filter(x => this.now() - x.at < FORGET_AFTER_MS).map(x => x.device) }
  get(id) { return this.list().find(d => d.id === id) }
  stop() {
    clearTimeout(this.retryTimer)
    clearTimeout(this.timer)
    this.closeSockets()
    try { this.notifySocket?.close() } catch {}
    this.notifySocket = null
    try { this.mdns?.destroy() } catch {}
    this.mdns = null
  }
}
const seconds = time => { const p = String(time).split(':').map(Number); return p.length === 3 && p.every(Number.isFinite) ? p[0] * 3600 + p[1] * 60 + p[2] : 0 }
module.exports = { UpnpDiscovery, describe, coordinator, soap, speakerArtwork, AV, RC, GROUP_RC, seconds, timestamp, TYPES, SONOS_MDNS_SERVICE }
