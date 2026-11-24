// The Google Cast protocol (CASTV2), the part a sender needs: a TLS
// connection to a receiver's port 8009 carrying length-prefixed CastMessage
// protobufs, each a JSON payload on a named channel ("namespace") between a
// sender id and a receiver id (the device itself, "receiver-0", or an app
// running on it, by its transport id).
//
// Electron has no Cast sender of its own (Chrome's isn't in it), so Lokal
// speaks this itself. The message is small enough to encode by hand:
//
//   message CastMessage {
//     required ProtocolVersion protocol_version = 1;  // 0: CASTV2_1_0
//     required string source_id = 2;
//     required string destination_id = 3;
//     required string namespace = 4;
//     required PayloadType payload_type = 5;          // 0: STRING, 1: BINARY
//     optional string payload_utf8 = 6;
//     optional bytes payload_binary = 7;
//   }

const tls = require('tls')
const { EventEmitter } = require('events')

const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
}
const SENDER = 'sender-0'
const RECEIVER = 'receiver-0'
const PING_EVERY_MS = 5000
const SILENT_AFTER_MS = 15000 // no message (not even a PONG) for this long: the connection is gone
const REQUEST_TIMEOUT_MS = 10000
const MAX_MESSAGE = 64 * 1024

// ------------------------------------------------------------ protobuf, by hand

function varint(value) {
  const bytes = []
  let n = value >>> 0
  while (n > 0x7f) { bytes.push((n & 0x7f) | 0x80); n >>>= 7 }
  bytes.push(n)
  return Buffer.from(bytes)
}

function field(number, wireType) { return varint((number << 3) | wireType) }

function stringField(number, text) {
  const data = Buffer.from(String(text), 'utf8')
  return Buffer.concat([field(number, 2), varint(data.length), data])
}

/** A CastMessage with a JSON (string) payload. */
function encodeMessage({ source = SENDER, destination = RECEIVER, namespace, data }) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data)
  return Buffer.concat([
    field(1, 0), varint(0),
    stringField(2, source),
    stringField(3, destination),
    stringField(4, namespace),
    field(5, 0), varint(0),
    stringField(6, payload),
  ])
}

function readVarint(buffer, offset) {
  let result = 0
  let shift = 0
  for (;;) {
    if (offset >= buffer.length) throw new Error('Truncated varint')
    const byte = buffer[offset++]
    result += (byte & 0x7f) * 2 ** shift
    if (!(byte & 0x80)) return { value: result, offset }
    shift += 7
    if (shift > 35) throw new Error('Varint too long')
  }
}

/** { source, destination, namespace, payload (string), binary (Buffer) } */
function decodeMessage(buffer) {
  const message = {}
  let offset = 0
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset)
    offset = key.offset
    const number = key.value >>> 3
    const wireType = key.value & 7
    if (wireType === 0) {
      const value = readVarint(buffer, offset)
      offset = value.offset
      if (number === 5) message.payloadType = value.value
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset)
      offset = length.offset
      const bytes = buffer.subarray(offset, offset + length.value)
      if (bytes.length !== length.value) throw new Error('Truncated field')
      offset += length.value
      if (number === 2) message.source = bytes.toString('utf8')
      else if (number === 3) message.destination = bytes.toString('utf8')
      else if (number === 4) message.namespace = bytes.toString('utf8')
      else if (number === 6) message.payload = bytes.toString('utf8')
      else if (number === 7) message.binary = Buffer.from(bytes)
    } else if (wireType === 1) offset += 8
    else if (wireType === 5) offset += 4
    else throw new Error(`Unknown wire type ${wireType}`)
  }
  return message
}

/** A message on the wire: its length (4 bytes, big-endian), then the message. */
function frame(message) {
  const body = encodeMessage(message)
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length, 0)
  return Buffer.concat([head, body])
}

/** Splits incoming bytes into whole messages; keeps a partial one for the next chunk. */
function createDeframer(onMessage) {
  let pending = Buffer.alloc(0)
  return chunk => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0)
      if (length > MAX_MESSAGE) throw new Error(`Cast message too large (${length} bytes)`)
      if (pending.length < 4 + length) break
      const body = pending.subarray(4, 4 + length)
      pending = pending.subarray(4 + length)
      onMessage(decodeMessage(body))
    }
  }
}

// ------------------------------------------------------------ the connection

/**
 * One connection to a Cast device. Events: 'message' ({ namespace, source,
 * destination, data }), 'close' (reason).
 */
class CastConnection extends EventEmitter {
  constructor({ host, port = 8009, connect = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    super()
    this.host = host
    this.port = port
    this.connectImpl = connect || (options => tls.connect({ ...options, rejectUnauthorized: false, servername: undefined }))
    this.timeoutMs = timeoutMs
    this.socket = null
    this.nextRequestId = 1
    this.pending = new Map() // requestId -> { resolve, reject, timer }
    this.connected = new Set() // destinations a virtual connection is open to
    this.closed = false
  }

  /** The local IPv4 address the kernel chose for this connection, when known. */
  get localAddress() {
    const raw = this.socket?.localAddress
    if (!raw) return null
    const ip = String(raw).replace(/^::ffff:/i, '')
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '0.0.0.0' ? ip : null
  }

  /** Opens the socket and the virtual connection to the device. */
  open() {
    return new Promise((resolve, reject) => {
      let settled = false
      const socket = this.connectImpl({ host: this.host, port: this.port })
      this.socket = socket
      const fail = error => {
        if (!settled) { settled = true; reject(error) }
        this.shutdown(error?.message || 'connection error')
      }
      socket.setTimeout?.(this.timeoutMs, () => fail(new Error(`${this.host} didn't answer`)))
      const ready = () => {
        if (settled) return
        settled = true
        socket.setTimeout?.(0)
        this.lastHeard = Date.now()
        this.connectTo(RECEIVER)
        this.heartbeat = setInterval(() => this.tick(), PING_EVERY_MS)
        this.heartbeat.unref?.()
        resolve(this)
      }
      socket.once('secureConnect', ready)
      socket.once('connect', () => { if (!socket.encrypted) ready() })
      const deframe = createDeframer(message => this.receive(message))
      socket.on('data', chunk => {
        try { deframe(chunk) } catch (error) { fail(error) }
      })
      socket.on('error', fail)
      socket.on('close', () => this.shutdown('closed'))
    })
  }

  tick() {
    if (this.closed) return
    if (Date.now() - this.lastHeard > SILENT_AFTER_MS) { this.shutdown('the device stopped answering'); return }
    this.send(NS.heartbeat, { type: 'PING' })
  }

  /** A virtual connection to `destination` (the device, or an app's transport). */
  connectTo(destination) {
    if (this.connected.has(destination)) return
    this.connected.add(destination)
    this.send(NS.connection, { type: 'CONNECT', userAgent: 'Lokal', origin: {} }, destination)
  }

  send(namespace, data, destination = RECEIVER) {
    if (this.closed || !this.socket) return false
    return this.socket.write(frame({ source: SENDER, destination, namespace, data }))
  }

  /** Sends with a requestId and resolves with the reply carrying the same one. */
  request(namespace, data, destination = RECEIVER, { timeoutMs = this.timeoutMs } = {}) {
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('Not connected')); return }
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`No answer to ${data.type}`))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      this.send(namespace, { ...data, requestId }, destination)
    })
  }

  receive(message) {
    this.lastHeard = Date.now()
    let data = null
    if (message.payload != null) {
      try { data = JSON.parse(message.payload) } catch { data = message.payload }
    }
    if (message.namespace === NS.heartbeat) {
      if (data?.type === 'PING') this.send(NS.heartbeat, { type: 'PONG' }, message.source)
      return
    }
    if (message.namespace === NS.connection && data?.type === 'CLOSE') {
      this.connected.delete(message.source)
      this.emit('message', { namespace: message.namespace, source: message.source, destination: message.destination, data })
      if (message.source === RECEIVER) this.shutdown('the device closed the connection')
      return
    }
    const waiting = data && typeof data === 'object' && data.requestId != null ? this.pending.get(data.requestId) : null
    if (waiting) {
      this.pending.delete(data.requestId)
      clearTimeout(waiting.timer)
      waiting.resolve(data)
    }
    this.emit('message', { namespace: message.namespace, source: message.source, destination: message.destination, data })
  }

  shutdown(reason) {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error(`Connection lost: ${reason}`)) }
    this.pending.clear()
    try { this.socket?.destroy() } catch {}
    this.emit('close', reason)
  }

  /** Closes the virtual connections and the socket. */
  close() {
    if (this.closed) return
    for (const destination of [...this.connected].reverse()) {
      try { this.send(NS.connection, { type: 'CLOSE' }, destination) } catch {}
    }
    this.shutdown('closed by Lokal')
  }
}

module.exports = { CastConnection, NS, SENDER, RECEIVER, encodeMessage, decodeMessage, frame, createDeframer }
