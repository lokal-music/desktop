// A casting session: one Cast device, the receiver app running on it, and
// what it plays.
//
// Lokal stays the owner of the queue (what plays, in what order, shuffle,
// history, autoplay) and the TV the owner of the clock (where in the song it
// is, playing or paused). The window says what the TV should hold: the
// playing song and the next few (AHEAD). It holds them so it moves on by
// itself, with no gap, whatever this computer is doing; after each change
// the TV's queue is made to match the window by track id: the matching part
// is kept (it may already be preloading), the rest replaced. A song the TV
// already holds is jumped to, not loaded again.
//
// The window comes from the player (src/cast/useCastPlayback.js), which also
// moves Lokal's current song when the TV moves on by itself. Status goes back
// to it on every change, with where in the song the TV was and when.

const { EventEmitter } = require('events')
const { CastConnection, NS, RECEIVER } = require('./castv2')

const DEFAULT_MEDIA_RECEIVER = 'CC1AD845'
const CUSTOM_NAMESPACE = 'urn:x-cast:app.lokal.cast'
// The version of the messages on Lokal's own channel. One receiver page
// (GitHub Pages) serves every copy of Lokal, old and new: each message says
// which version sent it, and the receiver's hello says which it speaks, so
// either side can tell an older one and keep to what it knows. Raise it when
// a message changes meaning; adding a field doesn't need it (both sides
// ignore fields they don't know). See docs/CASTING.md.
const CAST_PROTOCOL = 1
const AHEAD = 3
const UP_NEXT = 12 // the receiver's Up Next row
const PRELOAD_S = 15
const STATUS_POLL_MS = 5000 // the TV only reports changes: its clock is asked now and then
const RECONNECT_TRIES = 3
const RECONNECT_DELAY_MS = 2000
const PREPARE_AHEAD_MS = 20000 // a next song that takes longer (an online one that won't resolve) isn't waited for
const RECONCILE_RETRIES = 3 // the TV's queue failed to update: tried again this many times
const RECONCILE_RETRY_MS = 1500
const MEDIA_REACH_TIMEOUT_MS = 12000 // receiver never contacted our HTTP server after LOAD (often a firewall)
const SUPERSEDED = Symbol('superseded')

class CastController extends EventEmitter {
  /**
   * @param options.media the preparer (electron/cast/media.js)
   * @param options.server the media server (start/stop)
   * @param options.appId Lokal's own receiver app, when there is one; Google's otherwise
   * @param options.connect for the tests: how a connection is opened
   */
  constructor({ media, server, appId = null, connect = null, log = () => {}, now = Date.now, reachabilityTimeoutMs = MEDIA_REACH_TIMEOUT_MS, platform = process.platform } = {}) {
    super()
    this.media = media
    this.server = server
    this.appId = appId
    this.connectImpl = connect
    this.log = log
    this.now = now
    this.reachabilityTimeoutMs = reachabilityTimeoutMs
    this.platform = platform
    this.reset()
  }

  reset() {
    this.device = null
    this.connection = null
    this.app = null // { appId, sessionId, transportId, custom }
    this.mediaSessionId = null
    this.items = [] // what the TV holds, in order: { itemId, trackId }
    this.currentItemId = null
    this.playerState = 'IDLE'
    this.idleReason = null
    this.position = 0
    this.positionAt = 0
    this.duration = null
    this.volume = { level: 1, muted: false }
    this.prepared = new Map() // trackId -> prepared (addresses on the media server)
    this.session = (this.session || 0) + 1 // a song got ready for an earlier session is let go of
    this.desired = null
    this.generation = 0
    this.applied = 0
    this.syncing = null
    this.wakeSuperseded()
    this.loading = false
    this.retried = new Set() // track ids converted after the TV refused them
    this.upNextKeys = [] // the Up Next row's covers on the media server
    this.videoKey = null // the music video on the media server
    this.state = 'idle'
    this.error = null
    this.reachabilityError = null
    this.reachabilityHitsBefore = null
    clearTimeout(this.reachabilityTimer)
    this.reachabilityTimer = null
    clearInterval(this.poll)
  }

  // ---------------------------------------------------------------- status

  status() {
    return {
      state: this.state, // idle | connecting | connected
      device: this.device ? { id: this.device.id, name: this.device.name, kind: this.device.kind } : null,
      receiver: this.app ? (this.app.custom ? 'lokal' : 'default') : null,
      receiverProtocol: this.app?.custom ? this.receiverProtocol ?? null : null,
      trackId: this.currentTrackId(),
      playerState: this.loading ? 'LOADING' : this.playerState,
      idleReason: this.idleReason,
      position: this.position,
      positionAt: this.positionAt,
      duration: this.duration,
      volume: this.volume,
      error: this.error,
    }
  }

  publish() { this.emit('status', this.status()) }

  currentTrackId() {
    return this.items.find(item => item.itemId === this.currentItemId)?.trackId || null
  }

  // ---------------------------------------------------------------- connecting

  /** Connects to `device` and starts the receiver (Lokal's, else Google's). Joins one already playing Lokal's music. */
  async connect(device) {
    if (this.connection) await this.disconnect({ stopReceiver: false })
    this.reset()
    this.device = device
    this.state = 'connecting'
    this.publish()
    try {
      await this.server.start()
      await this.open(device)
      const joined = await this.join()
      if (!joined) await this.launch()
      this.state = 'connected'
      this.startPolling()
      this.publish()
      return { joined }
    } catch (error) {
      this.log(`cast: couldn't connect to ${device.name}: ${error.message}`)
      this.teardown()
      this.error = `Couldn't connect to ${device.name}: ${error.message}`
      this.state = 'idle'
      this.publish()
      throw error
    }
  }

  async open(device) {
    const connection = new CastConnection({ host: device.host, port: device.port || 8009, connect: this.connectImpl })
    await connection.open()
    this.connection = connection
    connection.on('message', message => this.onMessage(message))
    connection.on('close', reason => this.onClosed(connection, reason))
  }

  /** The receiver already playing Lokal's music (after a restart of Lokal, or a dropped connection): picked up, not restarted. */
  async join() {
    const reply = await this.connection.request(NS.receiver, { type: 'GET_STATUS' })
    this.onReceiverStatus(reply.status)
    const app = (reply.status?.applications || []).find(candidate => [this.appId, DEFAULT_MEDIA_RECEIVER].filter(Boolean).includes(candidate.appId))
    if (!app) return false
    this.adopt(app)
    const status = await this.connection.request(NS.media, { type: 'GET_STATUS' }, app.transportId).catch(() => null)
    const current = status?.status?.[0]
    const ours = current?.media?.customData?.lokal || (current?.items || []).some(item => item.media?.customData?.lokal)
    if (!ours) return false
    this.onMediaStatus(status.status)
    return true
  }

  adopt(app) {
    this.app = { appId: app.appId, sessionId: app.sessionId, transportId: app.transportId, custom: app.appId !== DEFAULT_MEDIA_RECEIVER }
    this.receiverProtocol = null // until its hello
    this.connection.connectTo(app.transportId)
  }

  async launch() {
    const tryLaunch = async appId => {
      const reply = await this.connection.request(NS.receiver, { type: 'LAUNCH', appId }, RECEIVER, { timeoutMs: 20000 })
      if (reply.type === 'LAUNCH_ERROR') throw new Error(reply.reason || 'launch refused')
      const app = (reply.status?.applications || []).find(candidate => candidate.appId === appId)
      if (!app) throw new Error('the app did not start')
      this.onReceiverStatus(reply.status)
      return app
    }
    let app = null
    if (this.appId) {
      try { app = await tryLaunch(this.appId) } catch (error) { this.log(`cast: Lokal's receiver didn't start (${error.message}); using Google's`) }
    }
    if (!app) app = await tryLaunch(DEFAULT_MEDIA_RECEIVER)
    this.adopt(app)
  }

  startPolling() {
    clearInterval(this.poll)
    this.poll = setInterval(() => {
      if (!this.app || !this.connection || this.playerState === 'IDLE') return
      this.connection.request(NS.media, { type: 'GET_STATUS' }, this.app.transportId).then(reply => this.onMediaStatus(reply.status)).catch(() => {})
    }, STATUS_POLL_MS)
    this.poll.unref?.()
  }

  /** The connection dropped: the TV likely plays on; reconnect and rejoin, a few times, before giving up. */
  async onClosed(connection, reason) {
    if (connection !== this.connection || this.closing) return
    this.connection = null
    this.log(`cast: connection to ${this.device?.name} lost (${reason})`)
    const device = this.device
    for (let attempt = 0; attempt < RECONNECT_TRIES && this.device === device; attempt++) {
      await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS))
      if (this.device !== device || this.closing) return
      try {
        await this.open(device)
        if (await this.join()) { this.log('cast: rejoined'); this.emit('rejoined'); this.publish(); return }
        break
      } catch {
        // That try's connection goes before the next one is opened.
        const failed = this.connection
        this.connection = null
        try { failed?.close() } catch {}
      }
    }
    if (this.device !== device) return
    this.end('lost')
  }

  /** Ends the session from Lokal's side; `stopReceiver` closes the app on the TV too. */
  async disconnect({ stopReceiver = true } = {}) {
    this.closing = true
    const final = this.status()
    try {
      if (stopReceiver && this.connection && this.app) {
        await this.connection.request(NS.receiver, { type: 'STOP', sessionId: this.app.sessionId }).catch(() => {})
      }
    } finally {
      this.teardown()
      this.closing = false
      this.reset()
      this.publish()
    }
    return final
  }

  teardown() {
    clearTimeout(this.reachabilityTimer)
    this.reachabilityTimer = null
    this.reachabilityHitsBefore = null
    this.reachabilityError = null
    clearInterval(this.poll)
    for (const key of this.upNextKeys || []) this.media.unpublish?.(key)
    this.upNextKeys = []
    if (this.videoKey) this.media.unpublish?.(this.videoKey)
    this.videoKey = null
    try { this.connection?.close() } catch {}
    this.connection = null
    for (const prepared of this.prepared.values()) this.media.release(prepared)
    this.prepared.clear()
    try { this.server.stop() } catch {}
  }

  /** The TV let go (its app was closed, it was switched off, the network went): tell the player where it was. */
  end(reason) {
    const final = this.status()
    this.teardown()
    this.reset()
    this.emit('ended', { reason, last: final })
    this.publish()
  }

  // ---------------------------------------------------------------- what the TV reports

  onMessage({ namespace, source, data }) {
    if (!data || typeof data !== 'object') return
    if (namespace === NS.receiver && data.type === 'RECEIVER_STATUS') {
      this.onReceiverStatus(data.status)
      // Our app no longer running: someone else took over the TV, or it was closed.
      if (this.app && this.state === 'connected' && !this.closing && !(data.status?.applications || []).some(app => app.sessionId === this.app.sessionId)) this.end('stopped')
      return
    }
    if (namespace === NS.media && data.type === 'MEDIA_STATUS') { this.onMediaStatus(data.status); return }
    if (namespace === NS.connection && data.type === 'CLOSE' && this.app && !this.closing && source === this.app.transportId) { this.end('stopped'); return }
    if (namespace === CUSTOM_NAMESPACE) {
      // The receiver's hello: the version it speaks (0: one from before versions).
      if (data?.type === 'hello') this.receiverProtocol = Number(data.protocol) || 0
      this.emit('custom', data)
    }
  }

  onReceiverStatus(status) {
    if (status?.volume) {
      const volume = { level: Number(status.volume.level ?? this.volume.level), muted: !!status.volume.muted }
      if (volume.level !== this.volume.level || volume.muted !== this.volume.muted) { this.volume = volume; this.publish() }
    }
  }

  onMediaStatus(list) {
    const status = Array.isArray(list) ? list[0] : null
    if (!status) return
    if (status.mediaSessionId != null) this.mediaSessionId = status.mediaSessionId
    if (Array.isArray(status.items)) {
      this.items = status.items.map(item => ({
        itemId: item.itemId,
        trackId: item.media?.customData?.trackId || this.items.find(known => known.itemId === item.itemId)?.trackId || null,
      }))
    }
    if (status.currentItemId != null) this.currentItemId = status.currentItemId
    if (status.media?.customData?.trackId && this.currentItemId != null) {
      const item = this.items.find(known => known.itemId === this.currentItemId)
      if (item) item.trackId = String(status.media.customData.trackId)
    }
    if (status.media?.duration) this.duration = status.media.duration
    const previousState = this.playerState
    const previousReason = this.idleReason
    if (status.playerState) this.playerState = status.playerState
    this.idleReason = status.playerState === 'IDLE' ? status.idleReason || null : null
    if (this.playerState !== previousState || this.idleReason !== previousReason) {
      this.log(`cast: ${this.device?.name || 'receiver'} state ${this.playerState}${this.idleReason ? ` (${this.idleReason})` : ''}`)
    }
    const serverHit = typeof this.reachabilityHitsBefore === 'number' && this.server?.requestCount > this.reachabilityHitsBefore
    if (this.playerState === 'PLAYING' || this.playerState === 'PAUSED' || serverHit) {
      clearTimeout(this.reachabilityTimer)
      this.reachabilityTimer = null
      this.reachabilityHitsBefore = null
      if ((this.playerState === 'PLAYING' || serverHit) && this.reachabilityError && this.error === this.reachabilityError) {
        this.error = null
        this.reachabilityError = null
      }
    }
    if (typeof status.currentTime === 'number') { this.position = status.currentTime; this.positionAt = this.now() }
    if (this.playerState === 'IDLE' && this.idleReason === 'ERROR' && !this.loading) this.onTrackError()
    else if (this.playerState === 'IDLE' && this.idleReason === 'FINISHED' && !this.loading) this.emit('finished')
    this.publish()
  }

  /** The TV couldn't play a song: converted and loaded again once; after that, the player skips it. */
  onTrackError() {
    const trackId = this.desired?.current?.id
    if (!trackId) return
    if (this.retried.has(String(trackId))) { this.emit('trackError', { trackId, message: 'The TV couldn\'t play this song' }); return }
    this.retried.add(String(trackId))
    this.log(`cast: the TV refused ${trackId}; converting it and trying again`)
    const stale = this.prepared.get(String(trackId))
    if (stale) { this.media.release(stale); this.prepared.delete(String(trackId)) }
    this.setWindow({ ...this.desired, position: this.position, convert: trackId, reload: true })
  }

  // ---------------------------------------------------------------- what the TV should play

  /**
   * @param window { current: track, upcoming: [track], position (s), play, repeat: 'none'|'one'|'all', reload }
   */
  setWindow(window) {
    if (!window?.current) return Promise.resolve()
    this.desired = { ...window, upcoming: (window.upcoming || []).slice(0, AHEAD) }
    this.generation++
    // Whatever the last window was waiting on (a song being prepared) is let go of.
    this.wakeSuperseded()
    return this.sync()
  }

  /** Resolves (with SUPERSEDED) when a newer window comes. */
  whenSuperseded(generation) {
    if (generation !== this.generation) return Promise.resolve(SUPERSEDED)
    return new Promise(resolve => { (this.superseded ||= new Set()).add(resolve) })
  }

  wakeSuperseded() {
    for (const wake of this.superseded || []) wake(SUPERSEDED)
    this.superseded?.clear()
  }

  /** A song prepared for the TV, unless a newer window comes first (it's kept for later either way), or it takes over `timeoutMs`. */
  async prepareFor(track, options, generation, timeoutMs = 0) {
    const work = this.prepare(track, options)
    work.catch(() => {})
    let timer = null
    const racers = [work, this.whenSuperseded(generation)]
    if (timeoutMs) racers.push(new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('it took too long to get ready')), timeoutMs) }))
    try { return await Promise.race(racers) } finally { clearTimeout(timer) }
  }

  sync() {
    if (this.syncing) return this.syncing
    this.syncing = (async () => {
      try {
        let retry = null // { generation, attempts }: the window's song plays, its queue still to update
        while (this.desired && this.applied !== this.generation && this.app) {
          const generation = this.generation
          const want = this.desired
          let queued = true
          try {
            // Retrying: only the queue after the playing song, which isn't loaded again.
            queued = retry?.generation === generation ? await this.updateQueue(want, generation) : await this.apply(want, generation)
          } catch (error) {
            this.loading = false
            // A newer window replaced it meanwhile: that one is what matters.
            if (generation !== this.generation) continue
            this.log(`cast: ${error.message}`)
            this.error = error.message
            this.publish()
            if (want.current) this.emit('trackError', { trackId: want.current.id, message: error.message })
          }
          if (generation !== this.generation) continue
          if (queued === false) {
            const attempts = retry?.generation === generation ? retry.attempts + 1 : 1
            if (attempts <= RECONCILE_RETRIES) {
              // Left pending: tried again shortly, unless a newer window comes first.
              retry = { generation, attempts }
              let timer
              await Promise.race([new Promise(resolve => { timer = setTimeout(resolve, RECONCILE_RETRY_MS) }), this.whenSuperseded(generation)])
              clearTimeout(timer)
              continue
            }
            this.log(`cast: gave up updating the queue on the TV after ${RECONCILE_RETRIES} tries`)
          }
          retry = null
          this.applied = generation
        }
      } finally {
        this.syncing = null
      }
    })()
    return this.syncing
  }

  async prepare(track, { convert = false } = {}) {
    const key = String(track.id)
    if (!convert && this.prepared.has(key)) return this.prepared.get(key)
    const session = this.session
    const prepared = await this.media.prepare(track, { deviceHost: this.device?.host, localAddress: this.connection?.localAddress || null, convert })
    // The session ended (or another started) meanwhile: its addresses aren't this one's.
    if (session !== this.session) { this.media.release(prepared); throw new Error('The casting session changed') }
    const previous = this.prepared.get(key)
    if (previous) this.media.release(previous)
    this.prepared.set(key, prepared)
    return prepared
  }

  isServerUrl(url) {
    if (!url || !this.server?.port) return false
    try { return Number(new URL(url).port) === this.server.port } catch { return false }
  }

  unreachableMediaMessage(url) {
    const name = this.device?.name || 'The Cast device'
    let target = this.server?.port ? `port ${this.server.port}` : 'this computer'
    try { if (url) target = new URL(url).host } catch {}
    return this.platform === 'linux' && this.server?.port
      ? `${name} couldn't reach this computer at ${target}. Check your firewall (allow TCP port ${this.server.port}).`
      : `${name} couldn't reach this computer at ${target}. Check your firewall or network settings.`
  }

  watchMediaReachability(preparedUrl, hitsBefore) {
    clearTimeout(this.reachabilityTimer)
    this.reachabilityTimer = null
    this.reachabilityHitsBefore = null
    if (typeof hitsBefore !== 'number' || !this.isServerUrl(preparedUrl)) return
    const session = this.session
    this.reachabilityHitsBefore = hitsBefore
    this.reachabilityTimer = setTimeout(() => {
      this.reachabilityTimer = null
      if (session !== this.session || this.state !== 'connected') return
      if (this.playerState === 'PLAYING' || this.playerState === 'PAUSED') return
      if (this.server.requestCount > hitsBefore) return
      const message = this.unreachableMediaMessage(preparedUrl)
      this.log(`cast: ${message}`)
      this.reachabilityError = message
      this.error = message
      this.publish()
    }, this.reachabilityTimeoutMs)
    this.reachabilityTimer.unref?.()
  }

  queueItem(prepared, { autoplay = true } = {}) {
    return {
      media: {
        contentId: prepared.url,
        contentUrl: prepared.url,
        streamType: 'BUFFERED',
        contentType: prepared.mime,
        metadata: prepared.metadata,
        ...(prepared.duration ? { duration: prepared.duration } : {}),
        customData: { lokal: 1, trackId: prepared.trackId },
      },
      autoplay,
      preloadTime: PRELOAD_S,
    }
  }

  mediaRequest(data) {
    if (!this.connection || !this.app) return Promise.reject(new Error('Not casting'))
    return this.connection.request(NS.media, { ...data, ...(this.mediaSessionId != null ? { mediaSessionId: this.mediaSessionId } : {}) }, this.app.transportId, { timeoutMs: 20000 })
  }

  /** A change to the TV's queue: refused (an error reply) is a failure, like no answer. */
  async queueRequest(data) {
    const reply = await this.mediaRequest(data)
    if (!reply || /^(INVALID_REQUEST|ERROR|LOAD_FAILED|LOAD_CANCELLED)$/.test(reply.type)) throw new Error(`the TV refused ${data.type}${reply?.reason ? ` (${reply.reason})` : ''}`)
    return reply
  }

  repeatMode(repeat) { return repeat === 'one' ? 'REPEAT_SINGLE' : 'REPEAT_OFF' } // repeat-all is Lokal's: the TV only holds a window

  async apply(want, generation) {
    const currentId = String(want.current.id)
    const onTv = this.currentTrackId()
    const stale = () => generation !== this.generation
    if (want.reload || onTv !== currentId) {
      const held = this.items.find(item => item.trackId === currentId)
      if (held && !want.reload && this.playerState !== 'IDLE') {
        // Already on the TV (queued ahead): a jump, which is instant.
        const reply = await this.mediaRequest({ type: 'QUEUE_UPDATE', currentItemId: held.itemId, ...(want.position ? { currentTime: want.position } : {}) })
        this.onMediaStatus(reply.status)
        if (want.play === false) await this.pause()
      } else {
        this.loading = true
        this.publish()
        const prepared = await this.prepareFor(want.current, { convert: want.convert === want.current.id }, generation)
        if (prepared === SUPERSEDED || stale()) { this.loading = false; return }
        const item = this.queueItem(prepared)
        const hitsBefore = typeof this.server?.requestCount === 'number' ? this.server.requestCount : null
        try {
          const origin = prepared.url ? new URL(prepared.url).origin : 'unknown'
          this.log(`cast: loading "${want.current.title || currentId}" from ${origin}`)
        } catch {}
        this.watchMediaReachability(prepared.url, hitsBefore)
        let reply
        try {
          reply = await this.mediaRequest({
            type: 'LOAD',
            media: item.media,
            autoplay: want.play !== false,
            currentTime: want.position || 0,
            queueData: { items: [item], startIndex: 0, repeatMode: this.repeatMode(want.repeat) },
            customData: { lokal: 1 },
          })
        } catch (error) {
          this.loading = false
          clearTimeout(this.reachabilityTimer)
          this.reachabilityTimer = null
          this.reachabilityHitsBefore = null
          if (typeof hitsBefore === 'number' && this.isServerUrl(prepared.url) && this.server.requestCount === hitsBefore && /No answer to LOAD/i.test(String(error?.message || ''))) {
            throw new Error(this.unreachableMediaMessage(prepared.url))
          }
          throw error
        }
        this.loading = false
        if (reply.type === 'LOAD_FAILED' || reply.type === 'LOAD_CANCELLED' || reply.type === 'INVALID_REQUEST') {
          clearTimeout(this.reachabilityTimer)
          this.reachabilityTimer = null
          this.reachabilityHitsBefore = null
          if (reply.type === 'LOAD_FAILED' && typeof hitsBefore === 'number' && this.isServerUrl(prepared.url) && this.server.requestCount === hitsBefore) {
            throw new Error(this.unreachableMediaMessage(prepared.url))
          }
          throw new Error(`The TV couldn't load "${want.current.title || 'this song'}"`)
        }
        this.onMediaStatus(reply.status)
        // The one just loaded, whatever id the TV gave it.
        const loaded = this.items.find(entry => entry.itemId === this.currentItemId)
        if (loaded && !loaded.trackId) loaded.trackId = currentId
      }
      if (stale()) return
    }
    // The playing song is on the TV: a next song that can't be queued is
    // reported in the log, never as a failure of the one playing.
    return this.updateQueue(want, generation)
  }

  /** reconcile, its failure logged: false when the TV's queue couldn't be updated (sync tries again). */
  async updateQueue(want, generation) {
    try {
      await this.reconcile(want, generation)
      return true
    } catch (error) {
      this.log(`cast: couldn't update the queue on the TV: ${error.message}`)
      return false
    }
  }

  /** Makes what the TV holds after the playing song match the window's next songs. */
  async reconcile(want, generation) {
    const here = this.items.findIndex(item => item.itemId === this.currentItemId)
    if (here < 0) return
    const ahead = this.items.slice(here + 1)
    const wanted = want.upcoming.map(track => String(track.id))
    let kept = 0
    while (kept < ahead.length && kept < wanted.length && ahead[kept].trackId === wanted[kept]) kept++
    if (kept < ahead.length) {
      const reply = await this.queueRequest({ type: 'QUEUE_REMOVE', itemIds: ahead.slice(kept).map(item => item.itemId) })
      this.onMediaStatus(reply.status)
    }
    for (const track of want.upcoming.slice(kept)) {
      if (generation !== this.generation) return
      let prepared
      try { prepared = await this.prepareFor(track, {}, generation, PREPARE_AHEAD_MS) } catch (error) { this.log(`cast: can't queue ${track.id}: ${error.message}`); break }
      if (prepared === SUPERSEDED || generation !== this.generation) return
      const before = this.items.map(item => item.itemId)
      const reply = await this.queueRequest({ type: 'QUEUE_INSERT', items: [this.queueItem(prepared)] })
      this.onMediaStatus(reply.status)
      const added = this.items.find(item => !before.includes(item.itemId))
      if (added && !added.trackId) added.trackId = String(track.id)
    }
    const repeatMode = this.repeatMode(want.repeat)
    if (this.lastRepeat !== repeatMode) {
      this.lastRepeat = repeatMode
      await this.mediaRequest({ type: 'QUEUE_UPDATE', repeatMode }).then(reply => this.onMediaStatus(reply.status)).catch(() => {})
    }
    // Addresses of songs the TV no longer holds are taken down.
    const held = new Set(this.items.map(item => item.trackId))
    for (const [trackId, prepared] of this.prepared) {
      if (!held.has(trackId) && trackId !== String(want.current.id)) { this.media.release(prepared); this.prepared.delete(trackId) }
    }
  }

  // ---------------------------------------------------------------- controls

  async play() { const reply = await this.mediaRequest({ type: 'PLAY' }); this.onMediaStatus(reply.status) }
  async pause() { const reply = await this.mediaRequest({ type: 'PAUSE' }); this.onMediaStatus(reply.status) }
  async seek(seconds) {
    this.position = Math.max(0, Number(seconds) || 0)
    this.positionAt = this.now()
    const reply = await this.mediaRequest({ type: 'SEEK', currentTime: this.position })
    this.onMediaStatus(reply.status)
  }

  async setVolume({ level, muted } = {}) {
    if (!this.connection) return
    const volume = level != null ? { level: Math.max(0, Math.min(1, Number(level))) } : { muted: !!muted }
    this.volume = { ...this.volume, ...volume }
    this.publish()
    const reply = await this.connection.request(NS.receiver, { type: 'SET_VOLUME', volume }).catch(() => null)
    if (reply?.status) this.onReceiverStatus(reply.status)
  }

  /** A message for Lokal's own receiver (lyrics, up next, the view); Google's ignores it. */
  sendCustom(data) {
    if (!this.connection || !this.app?.custom) return false
    return this.connection.send(CUSTOM_NAMESPACE, { ...data, protocol: CAST_PROTOCOL }, this.app.transportId)
  }

  /**
   * The playing song's music video for Lokal's receiver, which plays it muted
   * and kept to the song: { trackId, item (a media server item: the
   * downloaded file, or the stream relayed), name, segments }, or null for none.
   */
  sendVideo(video) {
    if (!this.connection || !this.app?.custom) return false
    if (this.videoKey) this.media.unpublish?.(this.videoKey)
    this.videoKey = null
    if (!video?.item) return this.sendCustom({ type: 'video', trackId: video?.trackId || null })
    const added = this.server.add(video.item, video.name || 'video')
    this.videoKey = added.key
    const url = this.server.urlFor(added.path, this.device?.host, this.connection?.localAddress || null)
    return this.sendCustom({ type: 'video', trackId: String(video.trackId), url, segments: video.segments || [] })
  }

  /** The songs after the playing one, for the receiver's Up Next row (with covers it can load). */
  sendUpNext(tracks) {
    if (!this.connection || !this.app?.custom) return false
    const keys = []
    const items = (tracks || []).slice(0, UP_NEXT).map(track => {
      let image = null
      try {
        const art = this.media.artwork?.(track, { deviceHost: this.device?.host, localAddress: this.connection?.localAddress || null })
        if (art?.key) keys.push(art.key)
        image = art?.url || null
      } catch {}
      return { id: String(track.id), title: track.title || '', artist: track.artist || '', image }
    })
    for (const key of this.upNextKeys) this.media.unpublish?.(key)
    this.upNextKeys = keys
    return this.sendCustom({ type: 'upnext', items })
  }
}

module.exports = { CastController, DEFAULT_MEDIA_RECEIVER, CUSTOM_NAMESPACE, CAST_PROTOCOL, AHEAD }
