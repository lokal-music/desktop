// A pretend Cast device for the tests: speaks CASTV2 over plain TCP (the
// client's connect is swapped for net.connect) and plays a pretend media
// queue whose clock the test moves with advance(). With `tls` (a key and
// certificate) it listens like a real one, for trying the app against it;
// `fetchMedia` has it fetch each song it's given, as a TV would. Enough of the receiver
// and media channels for Lokal's sender: launch, status, volume, load,
// queue load/insert/remove/update, play, pause, seek.

import net from 'node:net'
import tls from 'node:tls'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { frame, createDeframer, NS } = require('../electron/cast/castv2.js')

export const DEFAULT_MEDIA_RECEIVER = 'CC1AD845'

export async function startFakeReceiver({ apps = [DEFAULT_MEDIA_RECEIVER], name = 'Living Room TV', tls: secure = null, host = '127.0.0.1', port = 0, fetchMedia = false } = {}) {
  const sockets = new Set()
  const log = []
  const fetched = [] // { url, status, bytes } for each song fetched (fetchMedia)
  const fetchItems = items => {
    if (!fetchMedia) return
    for (const item of items) {
      const url = item.media?.contentId
      if (!url) continue
      fetch(url, { headers: { Range: 'bytes=0-65535' } })
        .then(async res => fetched.push({ url, status: res.status, type: res.headers.get('content-type'), bytes: (await res.arrayBuffer()).byteLength }))
        .catch(error => fetched.push({ url, status: 0, error: error.message }))
    }
  }
  const state = {
    volume: { level: 0.5, muted: false },
    app: null, // { appId, sessionId, transportId }
    media: null, // { mediaSessionId, items: [{ itemId, media, autoplay }], current, time, playerState, idleReason, repeatMode }
    nextItemId: 1,
    nextMediaSession: 1,
    failNextLoad: false,
    failQueueChanges: 0, // the next this many QUEUE_INSERT / QUEUE_REMOVE are refused
  }
  const send = (socket, namespace, data, source = 'receiver-0', destination = '*') => socket.write(frame({ source, destination, namespace, data }))
  const broadcast = (namespace, data, source) => { for (const socket of sockets) send(socket, namespace, data, source) }
  const receiverStatus = requestId => ({
    type: 'RECEIVER_STATUS', requestId: requestId ?? 0,
    status: {
      applications: state.app ? [{ appId: state.app.appId, displayName: 'Media Receiver', sessionId: state.app.sessionId, transportId: state.app.transportId, namespaces: [{ name: NS.media }], statusText: 'Ready' }] : [],
      volume: state.volume,
    },
  })
  const mediaStatus = requestId => {
    const m = state.media
    const status = m ? [{
      mediaSessionId: m.mediaSessionId,
      playbackRate: 1,
      playerState: m.playerState,
      ...(m.idleReason ? { idleReason: m.idleReason } : {}),
      currentTime: m.time,
      currentItemId: m.items[m.current]?.itemId,
      repeatMode: m.repeatMode,
      supportedMediaCommands: 12303,
      volume: state.volume,
      media: m.items[m.current]?.media,
      items: m.items.map(item => ({ itemId: item.itemId, media: item.media, autoplay: item.autoplay !== false })),
    }] : []
    return { type: 'MEDIA_STATUS', requestId: requestId ?? 0, status }
  }
  const broadcastMedia = () => { if (state.app) broadcast(NS.media, mediaStatus(), state.app.transportId) }
  const newItems = items => items.map(item => ({ ...item, itemId: state.nextItemId++ }))

  const onMessage = (socket, { namespace, source, destination, payload }) => {
    let data = null
    try { data = JSON.parse(payload) } catch { return }
    log.push({ namespace, destination, type: data.type, data })
    if (namespace === NS.heartbeat && data.type === 'PING') { send(socket, NS.heartbeat, { type: 'PONG' }, destination, source); return }
    if (namespace === NS.connection) return
    if (namespace === NS.receiver) {
      if (data.type === 'GET_STATUS') send(socket, NS.receiver, receiverStatus(data.requestId), 'receiver-0', source)
      else if (data.type === 'LAUNCH') {
        if (!apps.includes(data.appId)) { send(socket, NS.receiver, { type: 'LAUNCH_ERROR', requestId: data.requestId, reason: 'NOT_FOUND' }, 'receiver-0', source); return }
        state.app = { appId: data.appId, sessionId: `session-${Date.now()}`, transportId: `web-${state.nextMediaSession}` }
        state.media = null
        send(socket, NS.receiver, receiverStatus(data.requestId), 'receiver-0', source)
      } else if (data.type === 'STOP') {
        state.app = null; state.media = null
        send(socket, NS.receiver, receiverStatus(data.requestId), 'receiver-0', source)
      } else if (data.type === 'SET_VOLUME') {
        state.volume = { ...state.volume, ...data.volume }
        broadcast(NS.receiver, receiverStatus())
        if (data.requestId != null) send(socket, NS.receiver, receiverStatus(data.requestId), 'receiver-0', source)
      }
      return
    }
    if (namespace === NS.media) {
      const from = state.app?.transportId
      const reply = () => send(socket, NS.media, mediaStatus(data.requestId), from, source)
      const m = state.media
      switch (data.type) {
        case 'LOAD': {
          if (state.failNextLoad) { state.failNextLoad = false; send(socket, NS.media, { type: 'LOAD_FAILED', requestId: data.requestId }, from, source); return }
          const queue = data.queueData?.items?.length ? data.queueData.items : [{ media: data.media, autoplay: true }]
          const start = data.queueData?.startIndex || 0
          state.media = {
            mediaSessionId: state.nextMediaSession++, items: newItems(queue), current: start,
            time: data.currentTime || 0, playerState: state.loadPlayerState || (data.autoplay === false ? 'PAUSED' : 'PLAYING'), idleReason: null,
            repeatMode: data.queueData?.repeatMode || 'REPEAT_OFF',
          }
          fetchItems(state.media.items)
          reply(); broadcastMedia(); return
        }
        case 'QUEUE_INSERT': {
          if (!m) return
          if (state.failQueueChanges > 0) { state.failQueueChanges--; send(socket, NS.media, { type: 'INVALID_REQUEST', reason: 'INVALID_COMMAND', requestId: data.requestId }, from, source); return }
          const items = newItems(data.items || [])
          fetchItems(items)
          const at = data.insertBefore != null ? m.items.findIndex(item => item.itemId === data.insertBefore) : -1
          if (at >= 0) { m.items.splice(at, 0, ...items); if (at <= m.current) m.current += items.length } else m.items.push(...items)
          reply(); broadcastMedia(); return
        }
        case 'QUEUE_REMOVE': {
          if (!m) return
          if (state.failQueueChanges > 0) { state.failQueueChanges--; send(socket, NS.media, { type: 'INVALID_REQUEST', reason: 'INVALID_COMMAND', requestId: data.requestId }, from, source); return }
          const currentId = m.items[m.current]?.itemId
          m.items = m.items.filter(item => !data.itemIds.includes(item.itemId))
          const index = m.items.findIndex(item => item.itemId === currentId)
          m.current = index >= 0 ? index : Math.min(m.current, m.items.length - 1)
          reply(); broadcastMedia(); return
        }
        case 'QUEUE_UPDATE': {
          if (!m) return
          if (data.repeatMode) m.repeatMode = data.repeatMode
          if (data.currentItemId != null) {
            const index = m.items.findIndex(item => item.itemId === data.currentItemId)
            if (index >= 0) { m.current = index; m.time = data.currentTime || 0; m.playerState = 'PLAYING'; m.idleReason = null }
          }
          if (data.jump) { m.current = Math.max(0, Math.min(m.items.length - 1, m.current + data.jump)); m.time = 0 }
          reply(); broadcastMedia(); return
        }
        case 'PLAY': if (m) { m.playerState = 'PLAYING'; m.idleReason = null } reply(); broadcastMedia(); return
        case 'PAUSE': if (m) m.playerState = 'PAUSED'; reply(); broadcastMedia(); return
        case 'SEEK': if (m) { m.time = data.currentTime; if (data.resumeState === 'PLAYBACK_START') m.playerState = 'PLAYING'; if (data.resumeState === 'PLAYBACK_PAUSE') m.playerState = 'PAUSED' } reply(); broadcastMedia(); return
        case 'GET_STATUS': reply(); return
        default: return
      }
    }
  }

  const server = (secure ? tls.createServer.bind(null, secure) : net.createServer)(socket => {
    sockets.add(socket)
    const deframe = createDeframer(message => onMessage(socket, message))
    socket.on('data', chunk => deframe(chunk))
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  await new Promise(resolve => server.listen(port, host, resolve))

  return {
    name,
    port: server.address().port,
    connect: options => net.connect(options),
    state,
    log,
    fetched,
    /** Moves the pretend clock: the playing item runs on, into the next one at its end. */
    advance(seconds) {
      const m = state.media
      if (!m || m.playerState !== 'PLAYING') return
      m.time += seconds
      const duration = m.items[m.current]?.media?.duration || 180
      if (m.time >= duration) {
        if (m.repeatMode === 'REPEAT_SINGLE') m.time = 0
        else if (m.current + 1 < m.items.length) { m.current += 1; m.time = 0 }
        else { m.playerState = 'IDLE'; m.idleReason = 'FINISHED'; m.time = 0 }
      }
      broadcastMedia()
    },
    /** The TV's own remote (or Google Home) changing the volume. */
    setVolume(volume) { state.volume = { ...state.volume, ...volume }; broadcast(NS.receiver, receiverStatus()) },
    /** The app on the TV closed (someone pressed Home, or another app took over). */
    stopApp() { const transport = state.app?.transportId; state.app = null; state.media = null; broadcast(NS.receiver, receiverStatus()); if (transport) for (const socket of sockets) send(socket, NS.connection, { type: 'CLOSE' }, transport) },
    /** Lokal's receiver page saying something on Lokal's channel (its hello, a view picked on the remote). */
    sendCustom(data) { if (state.app) broadcast('urn:x-cast:app.lokal.cast', data, state.app.transportId) },
    dropConnections() { for (const socket of sockets) socket.destroy() },
    /** The TV couldn't play the current item (a format it refused). */
    failCurrent() { const m = state.media; if (!m) return; m.playerState = 'IDLE'; m.idleReason = 'ERROR'; broadcastMedia() },
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) }),
  }
}
