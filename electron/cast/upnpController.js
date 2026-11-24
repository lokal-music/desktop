const { EventEmitter } = require('events')
const { coordinator, soap, speakerArtwork, AV, RC, GROUP_RC, seconds, timestamp } = require('./upnp')
const { didl, value, parseXml, nodes } = require('./upnpXml')
const { routeAddressFor } = require('./mediaServer')

const MEDIA_REACH_TIMEOUT_MS = 12000

// Owns network I/O, queue preparation and clock polling in Electron's main
// process. Minimizing the renderer never parks the receiver's queue worker.
class UpnpController extends EventEmitter {
  constructor({ media, server, fetchImpl = fetch, log = () => {}, reachabilityTimeoutMs = MEDIA_REACH_TIMEOUT_MS, platform = process.platform }) {
    super(); this.media = media; this.server = server; this.fetch = fetchImpl; this.log = log
    this.reachabilityTimeoutMs = reachabilityTimeoutMs
    this.platform = platform
    this.state = 'idle'; this.entries = []; this.prepared = new Map(); this.revision = 0; this.epoch = 0; this.serial = Promise.resolve()
    this.position = 0; this.playerState = 'IDLE'; this.volume = { level: 1, muted: false }
    this.controls = 0
    this.sonosQueueId = 0
    this.localAddress = null
    this.reachabilityTimer = null
    this.reachabilityError = null
    this.reachabilityHitsBefore = null
  }
  status() {
    return { state: this.state, device: this.device, receiver: this.device?.sonos ? 'sonos' : 'dlna', trackId: this.current?.trackId || null,
      playerState: this.playerState, position: this.position, positionAt: this.positionAt, duration: this.current?.duration || 0, volume: this.volume, error: this.error || null }
  }
  publish() { this.emit('status', this.status()) }
  av(action, args = {}) { const s = this.device.services.AVTransport; return soap(s.url, s.type || AV, action, { InstanceID: 0, ...args }, this.fetch) }
  rc(action, args = {}) {
    const s = this.device?.sonos && this.device.services.GroupRenderingControl || this.device?.services.RenderingControl
    if (!s) throw new Error('This receiver does not expose volume control')
    const group = s === this.device.services.GroupRenderingControl
    return soap(s.url, s.type || (group ? GROUP_RC : RC), group ? action.replace(/^(Get|Set)/, '$1Group') : action,
      { InstanceID: 0, ...(group ? {} : { Channel: 'Master' }), ...args }, this.fetch)
  }
  enqueue(work) { const next = this.serial.then(work); this.serial = next.catch(() => {}); return next }
  unreachableMediaMessage(url) {
    const name = this.device?.name || 'The speaker'
    let target = this.server?.port ? `port ${this.server.port}` : 'this computer'
    try { if (url) target = new URL(url).host } catch {}
    return this.platform === 'linux' && this.server?.port
      ? `${name} couldn't reach this computer at ${target}. Check your firewall (allow TCP port ${this.server.port}).`
      : `${name} couldn't reach this computer at ${target}. Check your firewall or network settings.`
  }
  clearReachabilityWatch() {
    clearTimeout(this.reachabilityTimer)
    this.reachabilityTimer = null
    this.reachabilityHitsBefore = null
  }
  watchMediaReachability(preparedUrl, hitsBefore) {
    this.clearReachabilityWatch()
    if (typeof hitsBefore !== 'number' || !this.server?.port) return
    let targetPort = 0
    try { targetPort = Number(new URL(preparedUrl).port) } catch {}
    if (targetPort !== this.server.port) return
    const epoch = this.epoch
    this.reachabilityHitsBefore = hitsBefore
    this.reachabilityTimer = setTimeout(() => {
      this.reachabilityTimer = null
      if (epoch !== this.epoch || this.state !== 'connected') return
      if (this.server.requestCount > hitsBefore) return
      const message = this.unreachableMediaMessage(preparedUrl)
      this.log(`cast: ${message}`)
      this.reachabilityError = message
      this.error = message
      this.publish()
    }, this.reachabilityTimeoutMs)
    this.reachabilityTimer.unref?.()
  }
  async connect(device) {
    this.device = await coordinator(device, this.fetch)
    await this.server.start()
    const controlPort = (() => { try { return Number(new URL(this.device.services.AVTransport.url).port) || 80 } catch { return 1400 } })()
    this.localAddress = this.fetch === fetch ? await routeAddressFor(this.device.host, controlPort).catch(() => null) : null
    this.log(`cast: ${this.device.sonos ? 'sonos' : 'dlna'} connected to ${this.device.name} (${this.device.host})${this.localAddress ? ` via ${this.localAddress}` : ''}`)
    this.state = 'connected'; this.epoch++; this.error = null
    try { await this.readVolume() } catch {}
    this.pollTimer = setInterval(() => { if (!this.polling && !this.syncing) this.poll().catch(error => this.failedPoll(error)) }, 1500)
    this.pollTimer.unref?.(); this.publish(); return { joined: false }
  }
  async prepare(track) {
    const id = String(track.id)
    if (this.prepared.has(id)) return this.prepared.get(id)
    const epoch = this.epoch
    let expired = false; let timer
    const work = this.media.prepare(track, { deviceHost: this.device.host, localAddress: this.localAddress, receiver: this.device.sonos ? 'sonos' : 'dlna' })
      .then(item => { if (expired) this.media.release(item); return item })
    let item
    try {
      item = await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('Receiver source preparation timed out')) }, 20000) })])
    } finally { clearTimeout(timer) }
    if (epoch !== this.epoch) { this.media.release(item); throw new Error('Output changed while preparing audio') }
    if (this.device.sonos && (item.converted === false || item.embeddedCover)) {
      const url = await speakerArtwork(this.device.services.AVTransport.url, item.url, this.fetch)
      if (epoch !== this.epoch) { this.media.release(item); throw new Error('Output changed while preparing artwork') }
      if (url) item.metadata = { ...item.metadata, images: [{ url }] }
    }
    this.prepared.set(id, item); return item
  }
  setWindow(window) {
    if (!window?.current) return Promise.resolve()
    const revision = ++this.revision
    return this.enqueue(async () => {
      if (revision !== this.revision || this.state !== 'connected') return
      this.syncing = true
      try { await this.apply(window, revision) }
      catch (error) {
        this.log(`cast: ${this.device?.sonos ? 'sonos' : 'dlna'} error: ${error.message}`)
        if (revision === this.revision) { this.error = error.message; this.publish(); this.emit('trackError', { trackId: window.current.id, message: error.message }) }
        throw error
      }
      finally { this.syncing = false }
    })
  }
  async apply(want, revision) {
    if (this.ownershipUncertain && !want.reload) {
      this.deferredWindow = { window: want, trackId: this.current?.trackId }
      this.publish()
      return
    }
    this.deferredWindow = null
    const epoch = this.epoch
    const fresh = () => revision === this.revision && epoch === this.epoch
    const item = await this.prepare(want.current)
    if (!fresh()) return
    const changed = !this.current || this.current.trackId !== item.trackId || want.reload
    if (changed) {
      if (this.reachabilityError && this.error === this.reachabilityError) this.error = null
      this.reachabilityError = null
      const hitsBefore = typeof this.server?.requestCount === 'number' ? this.server.requestCount : null
      try {
        const origin = item.url ? new URL(item.url).origin : 'unknown'
        this.log(`cast: loading "${want.current.title || item.trackId}" on ${this.device?.name || 'speaker'} from ${origin}`)
      } catch {}
      const held = !want.reload && this.entries.findIndex(e => e.url === item.url)
      if (this.device.sonos && held !== false && held >= 0 && this.queueOwned) {
        await this.av('Seek', { Unit: 'TRACK_NR', Target: held + 1 })
      } else if (this.device.sonos) {
        await this.av('Stop')
        if (!fresh()) return
        await this.av('RemoveAllTracksFromQueue')
        this.entries = []
        await this.add(item)
        await this.av('SetAVTransportURI', { CurrentURI: `x-rincon-queue:${this.device.uuid}#0`, CurrentURIMetaData: '' })
        this.queueOwned = true
        await this.av('Seek', { Unit: 'TRACK_NR', Target: 1 })
      } else {
        await this.av('SetAVTransportURI', { CurrentURI: item.url, CurrentURIMetaData: didl(item) })
        this.entries = [item]
      }
      if (!fresh()) return
      this.current = item; this.position = Number(want.position) || 0; this.positionAt = Date.now()
      if (this.position > 0) await this.av('Seek', { Unit: 'REL_TIME', Target: timestamp(this.position) })
      if (want.play !== false) {
        await this.av('Play', { Speed: 1 })
        this.watchMediaReachability(item.url, hitsBefore)
      }
      this.playerState = want.play === false ? 'PAUSED' : 'PLAYING'
      this.finishedFor = null; this.publish()
    }
    const repeat = want.repeat === 'one'
    if (this.device.sonos) await this.av('SetPlayMode', { NewPlayMode: repeat ? 'REPEAT_ONE' : 'NORMAL' })
    const upcoming = repeat ? [] : (want.upcoming || []).slice(0, 4)
    const ready = []
    for (const track of upcoming) {
      try { const next = await this.prepare(track); if (!fresh()) return; ready.push(next) }
      catch (error) { this.log(`UPnP queue preparation: ${error.message}`); break }
    }
    if (!fresh()) return
    if (this.device.sonos) {
      let here = this.entries.findIndex(e => e.url === this.current.url)
      if (here < 0) return
      if (here > 0) {
        await this.av('RemoveTrackRangeFromQueue', { UpdateID: 0, StartingIndex: 1, NumberOfTracks: here })
        this.entries.splice(0, here)
        here = 0
      }
      let kept = 0
      const ahead = this.entries.slice(here + 1)
      while (kept < ahead.length && kept < ready.length && ahead[kept].url === ready[kept].url) kept++
      if (ahead.length > kept) {
        await this.av('RemoveTrackRangeFromQueue', { UpdateID: 0, StartingIndex: here + kept + 2, NumberOfTracks: ahead.length - kept })
        this.entries.splice(here + kept + 1)
      }
      for (const next of ready.slice(kept)) { if (!fresh()) return; await this.add(next) }
    } else {
      const next = repeat ? item : ready[0]
      if (this.nextUrl !== (next?.url || '')) {
        try {
          await this.av('SetNextAVTransportURI', { NextURI: next?.url || '', NextURIMetaData: next ? didl(next) : '' })
          this.nextUrl = next?.url || ''; this.entries = [item, ...(next ? [next] : [])]
          this.nextSupported = true
        } catch { this.nextSupported = false; this.entries = [item] }
      }
    }
    this.repeat = repeat
    const retained = new Set(this.entries.map(e => e.trackId))
    for (const [id, prepared] of this.prepared) if (!retained.has(id) && id !== item.trackId) { this.media.release(prepared); this.prepared.delete(id) }
    if (!this.reachabilityError || this.error !== this.reachabilityError) this.error = null
    this.publish()
  }
  async add(item) {
    // The same recording can appear twice. Sonos expects a distinct DIDL ID
    // for each queue entry so the app can associate its metadata and cover.
    const metadata = didl(item, { sonosQueueId: ++this.sonosQueueId })
    const expected = this.entries.length + 1
    const result = await this.av('AddURIToQueue', { EnqueuedURI: item.url, EnqueuedURIMetaData: metadata, DesiredFirstTrackNumberEnqueued: expected === 1 ? 1 : 0, EnqueueAsNext: 0 })
    const added = value(result, 'NumTracksAdded')
    const index = value(result, 'FirstTrackNumberEnqueued')
    if ((added && Number(added) !== 1) || (index && Number(index) !== expected)) {
      throw new Error('Sonos did not add the track at the requested queue position.')
    }
    this.entries.push(item)
  }
  async readVolume() {
    const controls = this.controls; const epoch = this.epoch
    const v = await this.rc('GetVolume')
    const level = Number(value(v, 'CurrentVolume'))
    const m = await this.rc('GetMute')
    if (controls !== this.controls || epoch !== this.epoch) return
    if (Number.isFinite(level)) this.volume.level = Math.max(0, Math.min(1, level / 100))
    this.volume.muted = value(m, 'CurrentMute') === '1'
  }
  async poll() {
    if (!this.current || this.state !== 'connected') return
    this.polling = true
    const epoch = this.epoch
    const revision = this.revision
    const controls = this.controls
    try {
      const [position, transport] = await Promise.all([this.av('GetPositionInfo'), this.av('GetTransportInfo')])
      if (epoch !== this.epoch || revision !== this.revision || controls !== this.controls || this.syncing) return
      this.failures = 0
      if (/^Receiver unreachable:/.test(this.error || '')) this.error = null
      const uri = value(position, 'TrackURI')
      const metadata = value(position, 'TrackMetaData')
      const resources = []
      try { for (const res of nodes(parseXml(metadata), 'res')) resources.push(res.text) } catch {}
      const identity = reference => {
        try {
          const url = new URL(reference)
          const parts = url.pathname.split('/').map(part => decodeURIComponent(part))
          // Lokal's media server identifies a resource by token/key, not the
          // optional display filename (receivers may encode that differently).
          const path = /^[a-f0-9]{32}$/i.test(parts[1] || '') && /^[a-f0-9]{24}$/i.test(parts[2] || '')
            ? parts.slice(0, 3).join('/') : parts.join('/')
          return url.origin + path + url.search
        } catch { return reference }
      }
      const owned = reference => this.entries.find(e => identity(e.url) === identity(reference))
      const item = owned(uri) || resources.map(owned).find(Boolean)
      if (!item && uri) {
        const media = await this.av('GetMediaInfo')
        if (epoch !== this.epoch || revision !== this.revision || controls !== this.controls) return
        const currentUri = value(media, 'CurrentURI')
        // An unfamiliar TrackURI alone is inconclusive. Require a consistent
        // transport source and independent metadata resource before takeover.
        const external = currentUri && !owned(currentUri) &&
          !currentUri.startsWith('x-rincon-queue:') &&
          identity(currentUri) === identity(uri) &&
          resources.some(reference => identity(reference) === identity(currentUri))
        let queueTakeover = false
        const directory = this.device.services.ContentDirectory
        const trackNumber = Number(value(position, 'Track'))
        if (this.queueOwned && directory && currentUri === 'x-rincon-queue:' + this.device.uuid + '#0' &&
            Number.isInteger(trackNumber) && trackNumber > 0 &&
            resources.some(reference => identity(reference) === identity(uri))) {
          const browse = await soap(directory.url, directory.type, 'Browse', {
            ObjectID: 'Q:0', BrowseFlag: 'BrowseDirectChildren', Filter: 'res',
            StartingIndex: trackNumber - 1, RequestedCount: 1, SortCriteria: '',
          }, this.fetch).catch(() => null)
          if (epoch !== this.epoch || revision !== this.revision || controls !== this.controls || this.syncing) return
          const result = browse && value(browse, 'Result')
          try {
            queueTakeover = !!result && nodes(parseXml(result), 'res')
              .some(res => identity(res.text) === identity(uri))
          } catch {}
        }
        if (external || queueTakeover) { this.end('stopped'); return }
        this.ownershipUncertain = true
        this.error = 'Receiver item could not be identified. Reconnect before changing its queue.'
        this.publish(); return
      }
      if (!item) return
      this.ownershipUncertain = false
      if (/^Receiver item could not be identified/.test(this.error || '')) this.error = null
      const state = value(transport, 'CurrentTransportState')
      const previous = this.playerState
      if (item) this.current = item
      this.position = seconds(value(position, 'RelTime')); this.positionAt = Date.now()
      this.playerState = state === 'PLAYING' ? 'PLAYING' : state === 'TRANSITIONING' ? 'BUFFERING' : state === 'PAUSED_PLAYBACK' ? 'PAUSED' : 'IDLE'
      if (this.playerState !== previous) {
        this.log(`cast: ${this.device?.name || 'speaker'} state ${this.playerState} (${state || 'UNKNOWN'})`)
      }
      const serverHit = typeof this.reachabilityHitsBefore === 'number' && this.server?.requestCount > this.reachabilityHitsBefore
      if (serverHit || (this.playerState === 'PLAYING' && this.position > 0)) {
        this.clearReachabilityWatch()
        if (this.reachabilityError && this.error === this.reachabilityError) {
          this.error = null
          this.reachabilityError = null
        }
      }
      await this.readVolume().catch(() => {})
      if (epoch !== this.epoch || revision !== this.revision || controls !== this.controls) return
      this.publish()
      const deferred = this.deferredWindow
      this.deferredWindow = null
      if (deferred && (String(deferred.window.current.id) !== String(deferred.trackId) ||
          String(deferred.trackId) === String(this.current.trackId))) {
        this.setWindow(deferred.window).catch(error => this.log(error.message))
      }
      // STOP alone is not completion: require a last-seconds observation.
      if (state === 'STOPPED' && previous === 'PLAYING' && this.lastDuration > 0 && this.lastPosition >= this.lastDuration - 3 && !this.stopping && this.finishedFor !== this.current.trackId) {
        this.finishedFor = this.current.trackId; this.emit('finished')
      }
      this.lastPosition = this.position; this.lastDuration = seconds(value(position, 'TrackDuration')) || this.current.duration
    } finally { this.polling = false }
  }
  failedPoll(error) {
    if (this.state !== 'connected') return
    this.error = `Receiver unreachable: ${error.message}`; this.publish()
    if ((this.failures = (this.failures || 0) + 1) >= 4) this.end('lost')
  }
  async play() { this.controls++; await this.av('Play', { Speed: 1 }); this.playerState = 'PLAYING'; this.publish() }
  async pause() { this.controls++; await this.av('Pause'); this.playerState = 'PAUSED'; this.publish() }
  async seek(position) { this.controls++; await this.av('Seek', { Unit: 'REL_TIME', Target: timestamp(position) }); this.position = Number(position); this.positionAt = Date.now(); this.publish() }
  async setVolume({ level, muted }) {
    this.controls++
    if (level != null) { const n = Number(level); if (!Number.isFinite(n)) throw new Error('Invalid volume'); await this.rc('SetVolume', { DesiredVolume: Math.round(Math.max(0, Math.min(1, n)) * 100) }); this.volume.level = Math.max(0, Math.min(1, n)) }
    if (muted != null) { await this.rc('SetMute', { DesiredMute: muted ? 1 : 0 }); this.volume.muted = !!muted }
    this.publish()
  }
  async disconnect({ stopReceiver = true } = {}) {
    const last = this.status(); this.stopping = true
    this.revision++
    await this.serial
    // A failed Stop must not authorize local autoplay or a second receiver.
    try { if (stopReceiver && this.device && (this.current || this.queueOwned)) await this.av('Stop') }
    catch (error) { this.stopping = false; throw error }
    this.cleanup(); this.state = 'idle'; this.publish(); return last
  }
  end(reason) { const last = this.status(); this.cleanup(); this.state = 'idle'; this.publish(); this.emit('ended', { reason, last }) }
  cleanup() { this.epoch++; this.revision++; this.clearReachabilityWatch(); this.reachabilityError = null; clearInterval(this.pollTimer); this.current = null; this.deferredWindow = null; this.entries = []; for (const p of this.prepared.values()) this.media.release(p); this.prepared.clear(); this.server.stop(); this.device = null }
  sendCustom() { return false }
  sendUpNext() { return false }
  sendVideo() { return false }
}
module.exports = { UpnpController }
