// What the TV plays from: an HTTP server on this computer, reachable from the
// network only while casting. The TV is handed one address per song (and per
// cover) and fetches it itself, seeking with range requests.
//
// Nothing else in the library is reachable: every address carries the
// session's random token and the random key of something put up for the TV
// (a queued song, its cover), and the server stops when casting does.
// Online songs (YouTube, SoundCloud, addons) are relayed: their links only
// work for this computer, so the TV gets the bytes from here.

const crypto = require('crypto')
const dgram = require('dgram')
const fs = require('fs')
const http = require('http')
const { isIPv4 } = require('net')
const os = require('os')
const { lanInterfaces } = require('../network/lanInterfaces')

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range, content-type',
  'access-control-expose-headers': 'content-range, content-length, accept-ranges',
  'access-control-allow-private-network': 'true',
}

function normalizeIPv4(address) {
  if (typeof address !== 'string') return null
  const ip = address.trim().replace(/^::ffff:/i, '')
  return isIPv4(ip) && ip !== '0.0.0.0' ? ip : null
}

/**
 * This computer's address on the TV's network: a physical LAN interface in the
 * same subnet (most specific netmask first), else the highest-ranked LAN IPv4
 * interface, avoiding Docker/VM/VPN adapters whenever a real LAN exists.
 */
function localAddressFor(deviceHost, interfaces = os.networkInterfaces()) {
  if (/^127\./.test(String(deviceHost || ''))) return '127.0.0.1' // a device on this computer (a test receiver)
  const preferred = lanInterfaces(interfaces)
  const fallback = []
  for (const list of Object.values(interfaces || {})) {
    for (const item of list || []) {
      if (item && !item.internal && (item.family === 'IPv4' || item.family === 4) && isIPv4(item.address || '')) fallback.push(item)
    }
  }
  const toInt = ip => String(ip).split('.').reduce((n, part) => (n * 256) + (Number(part) & 255), 0) >>> 0
  const bestSubnetMatch = list => {
    if (!isIPv4(String(deviceHost || ''))) return null
    const device = toInt(deviceHost)
    let best = null
    let bestMask = -1
    for (const item of list) {
      const mask = toInt(item.netmask || '255.255.255.0')
      if (((toInt(item.address) & mask) >>> 0) === ((device & mask) >>> 0) && mask > bestMask) {
        best = item.address
        bestMask = mask
      }
    }
    return best
  }
  const match = bestSubnetMatch(preferred) || bestSubnetMatch(fallback)
  if (match) return match
  const privateRange = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
  return (preferred.find(item => privateRange.test(item.address)) || preferred[0]
    || fallback.find(item => privateRange.test(item.address)) || fallback[0])?.address || '127.0.0.1'
}

/**
 * Asks the OS routing table which local IPv4 address reaches `deviceHost`
 * without transmitting any packets (UDP connect is a pure local route lookup).
 */
function routeAddressFor(deviceHost, port = 1400) {
  const host = normalizeIPv4(deviceHost)
  if (!host) return Promise.resolve(null)
  if (/^127\./.test(host)) return Promise.resolve('127.0.0.1')
  return new Promise(resolve => {
    let socket
    let done = false
    const finish = value => {
      if (done) return
      done = true
      try { socket?.close() } catch {}
      resolve(value)
    }
    try {
      socket = dgram.createSocket('udp4')
      socket.once('error', () => finish(null))
      socket.connect(Number(port) || 1400, host, () => {
        try { finish(normalizeIPv4(socket.address()?.address)) } catch { finish(null) }
      })
    } catch {
      finish(null)
    }
  })
}

function detectImageMime(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  return null
}

/** "bytes=a-b" for a file of `size` bytes: { start, end } or null (whole file), or 'bad'. */
function parseRange(header, size) {
  const found = String(header || '').match(/^bytes=(\d*)-(\d*)$/)
  if (!found) return null
  let start = found[1] === '' ? null : Number(found[1])
  let end = found[2] === '' ? null : Number(found[2])
  if (start == null) { if (end == null) return 'bad'; start = Math.max(0, size - end); end = size - 1 }
  if (end == null || end >= size) end = size - 1
  if (start > end || start >= size) return 'bad'
  return { start, end }
}

function createCastMediaServer({ log = () => {}, port: preferredPort = 0 } = {}) {
  let server = null
  let port = 0
  let token = null
  let requestCount = 0
  const items = new Map() // key -> { kind: 'file'|'artwork'|'relay'|'json', ... }

  async function serveFile(req, res, item) {
    let stat
    try { stat = fs.statSync(item.path) } catch { res.writeHead(404, CORS); res.end(); return }
    const range = parseRange(req.headers.range, stat.size)
    if (range === 'bad') { res.writeHead(416, { ...CORS, 'content-range': `bytes */${stat.size}` }); res.end(); return }
    const { start, end } = range || { start: 0, end: stat.size - 1 }
    res.writeHead(range ? 206 : 200, {
      ...CORS,
      'content-type': item.mime,
      'accept-ranges': 'bytes',
      'content-length': String(end - start + 1),
      ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}),
      'cache-control': 'no-store',
    })
    if (req.method === 'HEAD') { res.end(); return }
    const stream = fs.createReadStream(item.path, { start, end })
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  async function serveRelay(req, res, item) {
    const upstream = new AbortController()
    res.on('close', () => { if (!res.writableEnded) upstream.abort() })
    let answer
    try {
      answer = await item.fetchRange(req.headers.range || null, upstream.signal)
    } catch (error) {
      log(`relay ${item.label}: ${error?.message || error}`)
      if (!res.headersSent) res.writeHead(502, { ...CORS, 'content-type': 'text/plain' })
      res.end(String(error?.message || error))
      return
    }
    const headers = { ...CORS, 'content-type': item.mime || answer.headers?.get?.('content-type') || 'application/octet-stream', 'cache-control': 'no-store' }
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      const value = answer.headers?.get?.(name)
      if (value) headers[name] = value
    }
    if (!headers['accept-ranges'] && answer.status === 206) headers['accept-ranges'] = 'bytes'
    res.writeHead(answer.status, headers)
    if (req.method === 'HEAD' || !answer.body) { try { await answer.body?.cancel?.() } catch {} res.end(); return }
    const reader = answer.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || res.destroyed) break
        // Whichever comes first, the other listener goes (they'd pile up on a long song).
        if (!res.write(value)) {
          await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve() }
            res.once('drain', done)
            res.once('close', done)
          })
        }
      }
    } catch {} finally {
      try { await reader.cancel() } catch {}
      res.end()
    }
  }

  async function serveArtwork(req, res, item) {
    // The desktop library caches WebP thumbnails. Serve a JPEG that older
    // receivers can display, and share the conversion across HEAD and GET.
    item.image ??= fs.promises.readFile(item.path)
      .then(async bytes => {
        try {
          const jpeg = await require('../fileArtwork').normalizeArtwork(bytes)
          return { body: jpeg, mime: 'image/jpeg' }
        } catch {
          const mime = detectImageMime(bytes)
          return mime ? { body: bytes, mime } : null
        }
      })
      .catch(() => null)
    const image = await item.image
    if (!image) { res.writeHead(404, CORS); res.end(); return }
    res.writeHead(200, {
      ...CORS,
      'content-type': image.mime,
      'content-length': String(image.body.length),
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : image.body)
  }

  async function handle(req, res) {
    const peer = normalizeIPv4(req.socket?.remoteAddress) || req.socket?.remoteAddress || 'unknown'
    const found = String(req.url || '').match(/^\/([0-9a-f]{32})\/([0-9a-f]{24})(?:\/[^?]*)?(?:\?.*)?$/)
    if (!found || found[1] !== token) { res.writeHead(404); res.end(); return }
    requestCount++
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, CORS); res.end(); return }
    const item = items.get(found[2])
    if (!item) { log(`cast: media server 404 ${req.method} from ${peer}`); res.writeHead(404, CORS); res.end(); return }
    if (!item.loggedHit) {
      item.loggedHit = true
      log(`cast: media server ${req.method} ${item.kind} from ${peer}`)
    }
    if (item.kind === 'file') return serveFile(req, res, item)
    if (item.kind === 'artwork') return serveArtwork(req, res, item)
    if (item.kind === 'relay') return serveRelay(req, res, item)
    if (item.kind === 'json') {
      const body = Buffer.from(JSON.stringify(item.data))
      res.writeHead(200, { ...CORS, 'content-type': 'application/json', 'content-length': String(body.length), 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    res.writeHead(404, CORS); res.end()
  }

  function listenOn(instance, listenPort) {
    return new Promise((resolve, reject) => {
      const onError = error => { instance.off('listening', onListening); reject(error) }
      const onListening = () => { instance.off('error', onError); resolve(instance.address().port) }
      instance.once('error', onError)
      instance.once('listening', onListening)
      instance.listen(listenPort, '0.0.0.0')
    })
  }

  /** Starts listening (once per casting session) on every interface; a new token each time. */
  async function start() {
    if (server) return port
    token = crypto.randomBytes(16).toString('hex')
    requestCount = 0
    const instance = http.createServer((req, res) => { handle(req, res).catch(error => { log(`media server: ${error?.message || error}`); try { res.destroy() } catch {} }) })
    server = instance
    const desired = Number.isInteger(preferredPort) && preferredPort > 0 ? preferredPort : 0
    try {
      port = await listenOn(instance, desired)
    } catch (error) {
      if (desired > 0 && (error?.code === 'EADDRINUSE' || error?.code === 'EACCES')) {
        log(`cast: media server port ${desired} unavailable (${error.code}); falling back to an ephemeral port`)
        try {
          port = await listenOn(instance, 0)
        } catch (fallbackError) {
          server = null
          token = null
          throw fallbackError
        }
      } else {
        server = null
        token = null
        throw error
      }
    }
    log(`cast: media server listening on port ${port}`)
    return port
  }

  /** Puts something up for the TV; returns its address path ("/<token>/<key>/<name>"). */
  function add(item, name = 'media') {
    const key = crypto.randomBytes(12).toString('hex')
    items.set(key, item)
    return { key, path: `/${token}/${key}/${encodeURIComponent(name)}` }
  }

  function remove(key) { items.delete(key) }

  function stop() {
    items.clear()
    requestCount = 0
    if (!server) return
    try { server.closeAllConnections?.() } catch {}
    server.close()
    server = null
    token = null
  }

  return {
    start, stop, add, remove,
    /** The full address of a path for a device at `deviceHost` (preferring an explicit socket `localAddress`). */
    urlFor: (pathPart, deviceHost, localAddress = null) => {
      const host = normalizeIPv4(localAddress) || localAddressFor(deviceHost)
      return `http://${host}:${port}${pathPart}`
    },
    get running() { return !!server },
    get port() { return port },
    get size() { return items.size },
    get requestCount() { return requestCount },
  }
}

module.exports = { createCastMediaServer, localAddressFor, routeAddressFor, parseRange }
