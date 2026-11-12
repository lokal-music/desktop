// Spotify Canvas: the short looping clips Spotify shows behind a track. Same
// approach as BitChord, and just as unofficial:
//
//   1. Your own sp_dc cookie (pasted in Settings) is put into a private,
//      in-memory browser session, and open.spotify.com is loaded there in a
//      hidden window. The web player mints its own access token and client
//      token; we read both off the network (Chrome DevTools protocol) rather
//      than building them by hand -- hand-made tokens get refused (429).
//   2. The track is found with the Web API search (title/artist checked).
//   3. Its canvas is asked for from Spotify's internal canvas service
//      (protobuf; it only answers requests that look like the iOS app).
//
// Without a cookie, or with one Spotify doesn't accept, this simply finds
// nothing. The cookie only ever goes to *.spotify.com.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const CANVAS_UA = 'Spotify/9.0.34.593 iOS/18.4 (iPhone15,3)'
const CANVAS_URL = 'https://spclient.wg.spotify.com/canvaz-cache/v0/canvases'
const PARTITION = 'lokal-spotify-canvas' // no "persist:" -- nothing is written to disk
// The web player's GraphQL ("Pathfinder") queries are identified by a hash
// that changes with its releases. These are known-good values; the hidden
// window reads the current ones out of the web player's own scripts.
const KNOWN_HASHES = {
  canvas: '575138ab27cd5c1b3e54da54d0a7cc8d85485402de26340c2145f0f6bb5e7a9f', // Jan 2026
  searchTracks: 'bc1ca2fcd0ba1013a0fc88e6cc4f190af501851e3dafd3e1ef85840297694428',
  libraryV3: '390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455', // Oct 2026
  fetchLibraryTracks: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240', // Oct 2026
  addToLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148', // Oct 2026
  home: '5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1', // Oct 2026
  fetchPlaylist: '21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf', // Oct 2026
}
let liveHashes = {}
const hashFor = (op) => liveHashes[op] || KNOWN_HASHES[op]
const HASH_PATTERN = /["'](canvas|searchTracks|libraryV3|fetchLibraryTracks|addToLibrary|home|fetchPlaylist)["']\s*,\s*["'](?:query|mutation)["']\s*,\s*["']([0-9a-f]{64})["']/g

const TOKEN_TIMEOUT = 25000   // waiting for the page's token requests
const MINT_DEADLINE = 40000   // the whole sign-in step, whatever gets stuck

/** `promise`, or `fallback` after `ms` -- for Electron calls that can stall. */
function within(promise, ms, fallback) {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms) })]).finally(() => clearTimeout(timer))
}

class TransientError extends Error {
  constructor(message) { super(message); this.transient = true }
}

// ---------------------------------------------------------------- tokens

let tokens = null      // { accessToken, exp, clientToken, clientExp, cookie }
let minting = null     // Promise while the hidden window is working
let failed = null      // { cookie, at, message } -- don't hammer Spotify after a failure

function cookieValue(raw) {
  // Accept the bare value or a pasted "sp_dc=...;" fragment.
  const s = String(raw || '').trim()
  const m = s.match(/(?:^|;\s*)sp_dc=([^;]+)/)
  return (m ? m[1] : s).trim()
}

/**
 * Runs mintTokensInner with a hard deadline: whichever step stalls (clearing
 * storage, the page never finishing, no token request), the caller gets an
 * error naming that step instead of waiting forever.
 */
function mintTokens(cookie) {
  // Each step is logged (never the cookie or tokens) so a stall can be traced.
  let stage = 'starting'
  const state = {
    win: null,
    get stage() { return stage },
    set stage(v) { stage = v; console.log(`[spotify-canvas] ${v}`) },
  }
  console.log('[spotify-canvas] starting')
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { state.win?.destroy() } catch {}
      reject(new TransientError(`Spotify didn't answer in time (stuck ${state.stage}).`))
    }, MINT_DEADLINE)
  })
  return Promise.race([mintTokensInner(cookie, state), deadline])
    .then(t => { console.log('[spotify-canvas] signed in'); return t }, e => { console.log(`[spotify-canvas] failed: ${e.message}`); throw e })
    .finally(() => clearTimeout(timer))
}

async function mintTokensInner(cookie, state) {
  const { BrowserWindow, session, app } = require('electron')
  if (!app.isReady()) await app.whenReady()
  const part = session.fromPartition(PARTITION)
  // A clean session each time so the page mints a fresh token for this
  // cookie. clearStorageData can stall in some Electron builds: don't wait
  // on it for long -- the partition is in-memory anyway.
  state.stage = 'clearing the old session'
  await within(part.clearStorageData().catch(() => {}), 3000)
  state.stage = 'setting the cookie'
  await part.cookies.set({
    url: 'https://open.spotify.com', domain: '.spotify.com', path: '/', name: 'sp_dc', value: cookie,
    secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: Math.floor(Date.now() / 1000) + 3600,
  })

  state.stage = 'opening open.spotify.com'
  const win = state.win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { session: part, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, images: false },
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setUserAgent(UA)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const found = { hashes: {} }
  const watched = new Map() // requestId -> 'token' | 'client' | 'script'
  let scriptsSeen = 0
  const dbg = win.webContents.debugger
  try {
    // The DevTools protocol only answers once the window has a page: on a
    // fresh window Network.enable never returned (the check sat "opening
    // open.spotify.com" until the deadline). Give it a blank page first.
    state.stage = 'preparing the hidden window'
    await within(win.loadURL('about:blank').catch(() => {}), 5000)
    dbg.attach('1.3')
    state.stage = 'starting network monitoring'
    const enabled = await within(dbg.sendCommand('Network.enable').then(() => true, () => false), 5000, false)
    if (!enabled) throw new TransientError('Couldn\'t watch the hidden Spotify window (DevTools protocol didn\'t answer).')
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new TransientError('Spotify took too long to answer')), TOKEN_TIMEOUT)
      const ready = () => { if ((found.token || found.bearer) && found.client) { clearTimeout(timer); resolve() } }
      dbg.on('message', async (_e, method, params) => {
        // Backup route: the web player sends its access token with every API
        // call, so take it from there if the token response itself can't be
        // read. (Checked against /v1/me below, since it may be anonymous.)
        if (method === 'Network.requestWillBeSent' && !found.bearer) {
          const url = params.request?.url || ''
          const headers = params.request?.headers || {}
          const auth = headers.Authorization || headers.authorization || ''
          if (/^Bearer\s+\S+/.test(auth) && /^https:\/\/[^/]*spotify\.com\//.test(url) && !/clienttoken\.spotify\.com/.test(url)) {
            found.bearer = auth.replace(/^Bearer\s+/, '')
            console.log(`[spotify-canvas] saw the web player's access token on a request to ${new URL(url).host}`)
            ready()
          }
          return
        }
        let kind = null
        try {
          if (method === 'Network.responseReceived' && params.type === 'Script' && scriptsSeen < 60) {
            scriptsSeen++
            watched.set(params.requestId, 'script')
            return
          }
          if (method === 'Network.loadingFinished' && watched.get(params.requestId) === 'script') {
            watched.delete(params.requestId)
            const { body, base64Encoded } = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            const js = base64Encoded ? Buffer.from(body, 'base64').toString() : body
            for (const m of js.matchAll(HASH_PATTERN)) {
              if (found.hashes[m[1]] !== m[2]) console.log(`[spotify-canvas] web player's ${m[1]} query: ${m[2].slice(0, 12)}...${m[2] === KNOWN_HASHES[m[1]] ? ' (same as known)' : ' (newer than known)'}`)
              found.hashes[m[1]] = m[2]
            }
            return
          }
          if (method === 'Network.responseReceived') {
            const url = params.response?.url || ''
            if (/open\.spotify\.com\/api\/token|\/get_access_token/.test(url)) watched.set(params.requestId, 'token')
            else if (/clienttoken\.spotify\.com\/v1\/clienttoken/.test(url)) watched.set(params.requestId, 'client')
            if (watched.get(params.requestId) === 'token') console.log(`[spotify-canvas] token request answered HTTP ${params.response?.status}`)
          } else if ((method === 'Network.loadingFinished' || method === 'Network.loadingFailed') && watched.has(params.requestId)) {
            kind = watched.get(params.requestId)
            watched.delete(params.requestId)
            if (method === 'Network.loadingFailed') { console.log(`[spotify-canvas] ${kind} request failed: ${params.errorText || 'unknown'}`); return }
            const { body, base64Encoded } = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            const json = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString() : body)
            if (kind === 'token') {
              if (!json?.accessToken) {
                // Field names and any error text only -- never token values.
                console.log(`[spotify-canvas] token response had no accessToken (fields: ${Object.keys(json || {}).join(', ') || 'none'}${json?.error ? `; error: ${JSON.stringify(json.error).slice(0, 200)}` : ''})`)
                return
              }
              console.log(`[spotify-canvas] got access token (anonymous: ${!!json.isAnonymous})`)
              if (json.isAnonymous) { clearTimeout(timer); reject(new Error('Spotify didn\'t accept the cookie (it may have expired). Copy a fresh sp_dc.')); return }
              found.token = json
            }
            if (kind === 'client') {
              console.log(`[spotify-canvas] got client token (${json?.response_type || 'no type'})`)
              if (json?.response_type === 'RESPONSE_GRANTED_TOKEN_RESPONSE') found.client = json.granted_token
            }
            ready()
          }
        } catch (e) {
          if (kind) console.log(`[spotify-canvas] couldn't read the ${kind} response: ${e.message}`)
        }
      })
    })
    // Not awaited: the web player may never report "finished loading" (it
    // keeps connections open), and the token requests come in regardless.
    state.stage = 'waiting for the web player to sign in'
    win.loadURL('https://open.spotify.com/').catch(() => {})
    try {
      await done
    } catch (e) {
      // The access token is what matters; the client token helps but isn't
      // always requested by the page right away.
      if (!found.token && !found.bearer) throw e
    }
    // Give the player's scripts a moment to show the current canvas query.
    state.stage = 'reading the web player\'s queries'
    for (let i = 0; i < 20 && !found.hashes.canvas; i++) await new Promise(r => setTimeout(r, 200))
    if (!found.hashes.canvas) console.log('[spotify-canvas] canvas query not seen in the web player; using the known one')
    liveHashes = { ...liveHashes, ...found.hashes }
  } finally {
    try { dbg.detach() } catch {}
    try { win.destroy() } catch {}
    within(part.clearStorageData().catch(() => {}), 3000)
  }

  let t = found.token
  if (!t) {
    // Only the token seen on a request: make sure it's a signed-in one.
    state.stage = 'checking the token is signed in'
    const me = await request('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${found.bearer}`, Accept: 'application/json', 'User-Agent': UA } }).catch(() => null)
    console.log(`[spotify-canvas] /v1/me answered ${me ? `HTTP ${me.status}` : 'nothing'}`)
    if (me && (me.status === 401 || me.status === 403)) throw new Error('Spotify didn\'t accept the cookie (it may have expired). Copy a fresh sp_dc.')
    t = { accessToken: found.bearer, accessTokenExpirationTimestampMs: Date.now() + 45 * 60 * 1000 }
  }
  return {
    cookie,
    accessToken: t.accessToken,
    exp: Number(t.accessTokenExpirationTimestampMs) || Date.now() + 30 * 60 * 1000,
    clientToken: found.client?.token || null,
    clientExp: found.client ? Date.now() + (Number(found.client.expires_after_seconds) || 3600) * 1000 : 0,
  }
}

async function getTokens(rawCookie, { force = false } = {}) {
  const cookie = cookieValue(rawCookie)
  if (!cookie) return null
  if (!force && tokens?.cookie === cookie && tokens.exp - 30000 > Date.now()) return tokens
  if (!force && failed?.cookie === cookie && Date.now() - failed.at < 10 * 60 * 1000) throw new TransientError(failed.message)
  if (!minting) {
    minting = mintTokens(cookie)
      .then(t => { tokens = t; failed = null; return t })
      .catch(e => { tokens = null; failed = { cookie, at: Date.now(), message: e.message }; throw e })
      .finally(() => { minting = null })
  }
  const t = await minting
  if (t.cookie !== cookie) return getTokens(rawCookie, { force })
  return t
}

// ---------------------------------------------------------------- protobuf

function varint(n) {
  const out = []
  while (n > 127) { out.push((n & 127) | 128); n >>>= 7 }
  out.push(n)
  return Buffer.from(out)
}
const lenField = (num, buf) => Buffer.concat([varint((num << 3) | 2), varint(buf.length), buf])

function readVarint(buf, pos) {
  let result = 0, shift = 0, b
  do {
    if (pos >= buf.length) throw new Error('truncated')
    b = buf[pos++]
    result += (b & 127) * 2 ** shift
    shift += 7
  } while (b & 128)
  return [result, pos]
}

/** Top-level fields of a protobuf message: [{ num, value }] (length-delimited values as Buffers). */
function fields(buf) {
  const out = []
  let pos = 0
  while (pos < buf.length) {
    let key
    ;[key, pos] = readVarint(buf, pos)
    const num = Math.floor(key / 8), wire = key & 7
    if (wire === 0) { let v; [v, pos] = readVarint(buf, pos); out.push({ num, value: v }) }
    else if (wire === 2) { let len; [len, pos] = readVarint(buf, pos); out.push({ num, value: buf.subarray(pos, pos + len) }); pos += len }
    else if (wire === 1) pos += 8
    else if (wire === 5) pos += 4
    else throw new Error('unsupported wire type')
  }
  return out
}

/** Canvas URLs in a canvaz-cache response, preferring the one for `uri`. */
function parseCanvases(buf, uri) {
  const found = []
  try {
    for (const f of fields(buf)) {
      if (f.num !== 1 || !Buffer.isBuffer(f.value)) continue
      const c = {}
      for (const g of fields(f.value)) {
        if (g.num === 2 && Buffer.isBuffer(g.value)) c.url = g.value.toString()
        if (g.num === 5 && Buffer.isBuffer(g.value)) c.uri = g.value.toString()
      }
      if (c.url) found.push(c)
    }
  } catch {}
  if (!found.length) {
    const m = buf.toString('latin1').match(/https:\/\/[^"'\s\x00-\x1F]+\.cnvs\.mp4/)
    if (m) found.push({ url: m[0] })
  }
  const pick = found.find(c => c.uri === uri) || found[0]
  return pick && /^https:\/\//.test(pick.url) && /\.mp4(?:[?#]|$)/i.test(pick.url) ? pick.url : null
}

/** Printable hints of what a canvas answer held (URLs' hosts/extensions), without dumping it. */
function summarize(buf) {
  const text = buf.toString('latin1')
  const urls = [...new Set((text.match(/https:\/\/[^"'\s\x00-\x1F]+/g) || []).map(u => { try { const x = new URL(u); return x.host + (x.pathname.match(/\.[a-z0-9]{2,5}$/i)?.[0] || '') } catch { return '?' } }))]
  return urls.length ? urls.slice(0, 5).join(', ') : 'no links'
}

// ---------------------------------------------------------------- lookup

async function request(url, opts, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try { return await fetch(url, { ...opts, signal: controller.signal }) } finally { clearTimeout(timer) }
}

function authFailed(status) {
  if (status === 401) tokens = null
  return status === 401 || status === 429 || status >= 500
}


function pickTrack(items, { title, artist, album }, { norm, cleanTitle, artistsMatch }) {
  const wantTitle = norm(cleanTitle(title))
  // Spotify appends " - Remastered 2011" etc. to titles; compare without it.
  const bare = s => norm(String(s || '').replace(/\s+-\s+.*$/, ''))
  const candidates = items
    .filter(it => (norm(it.name) === wantTitle || bare(it.name) === wantTitle) && artistsMatch(artist, it.artists))
    // The plain title before "- Sped Up", "- Remastered"... versions.
    .sort((a, b) => (norm(a.name) === wantTitle ? 0 : 1) - (norm(b.name) === wantTitle ? 0 : 1))
  const wantAlbum = norm(album)
  const exact = wantAlbum ? candidates.find(it => norm(it.album) === wantAlbum) : null
  // Canvases belong to the track, and the single and the album cut usually
  // share one -- so a title+artist match on another release still counts.
  return (exact || candidates[0]) || null
}

/** The Web API search (what the public API offers). */
async function searchRest(t, { title, artist }, { cleanTitle, splitFirstArtist }) {
  const q = `track:${cleanTitle(title)} artist:${splitFirstArtist(artist)}`
  const res = await request(`https://api.spotify.com/v1/search?type=track&limit=10&q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${t.accessToken}`, Accept: 'application/json', 'User-Agent': UA },
  }).catch(e => ({ ok: false, status: e.name === 'AbortError' ? 'timeout' : e.message }))
  if (!res.ok) { console.log(`[spotify-canvas] search (Web API) HTTP ${res.status}`); if (res.status === 401) tokens = null; return null }
  const items = (await res.json())?.tracks?.items || []
  return items.map(it => ({ uri: it.uri, name: it.name, artists: (it.artists || []).map(a => a.name), album: it.album?.name }))
}

/** The web player's own search (Pathfinder), which BitChord tries first. */
async function searchPathfinder(t, { title, artist, album }, { cleanTitle }) {
  const variables = { searchTerm: [cleanTitle(title), artist, album].filter(Boolean).join(' '), offset: 0, limit: 10, numberOfTopResults: 5, includeAudiobooks: false, includePreReleases: false }
  const extensions = { persistedQuery: { version: 1, sha256Hash: hashFor('searchTracks') } }
  const url = `https://api-partner.spotify.com/pathfinder/v1/query?operationName=searchTracks&variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(JSON.stringify(extensions))}`
  const headers = { Authorization: `Bearer ${t.accessToken}`, Accept: 'application/json', 'App-Platform': 'WebPlayer', 'User-Agent': UA }
  if (t.clientToken && t.clientExp > Date.now()) headers['client-token'] = t.clientToken
  const res = await request(url, { headers }).catch(e => ({ ok: false, status: e.name === 'AbortError' ? 'timeout' : e.message }))
  if (!res.ok) { console.log(`[spotify-canvas] search (web player) HTTP ${res.status}`); return null }
  const json = await res.json().catch(() => null)
  const items = json?.data?.searchV2?.tracksV2?.items || []
  return items.map(x => x?.item?.data).filter(Boolean).map(d => ({
    uri: d.uri, name: d.name,
    artists: (d.artists?.items || []).map(a => a?.profile?.name).filter(Boolean),
    album: d.albumOfTrack?.name,
  }))
}

async function findTrackUri(t, track, helpers) {
  const label = `"${track.title}" by ${track.artist}`
  let sawResults = false
  for (const [name, search] of [['Web API', searchRest], ['web player', searchPathfinder]]) {
    const items = await search(t, track, helpers)
    if (!items) continue
    sawResults = true
    const hit = pickTrack(items, track, helpers)
    console.log(`[spotify-canvas] search (${name}) for ${label}: ${items.length} results, ${hit ? `matched ${hit.uri} ("${hit.name}" on ${hit.album || '?'})` : `no exact match (top: ${items.slice(0, 3).map(i => `"${i.name}" by ${i.artists.join(', ')}`).join('; ') || 'none'})`}`)
    if (hit) return hit.uri
  }
  if (!sawResults) throw new TransientError('Spotify search failed')
  return null
}

/** Resolve a title/artist to the Spotify id used by supported lyric APIs. */
async function findSpotifyTrackId(track, cookie) {
  if (!cookieValue(cookie)) return null
  return queue.then(async () => {
    const t = await getTokens(cookie)
    if (!t) return null
    const norm = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    const cleanTitle = value => String(value || '').replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, '').trim()
    const firstArtist = value => String(value || '').split(/,|\s+(?:feat\.|ft\.|&|x)\s+/i)[0].trim()
    const artistsMatch = (want, artists) => {
      const target = norm(firstArtist(want))
      return (artists || []).some(name => norm(name) === target || norm(name).includes(target) || target.includes(norm(name)))
    }
    const uri = await findTrackUri(t, track, { norm, cleanTitle, splitFirstArtist: firstArtist, artistsMatch })
    return String(uri || '').match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1] || null
  })
}

/** How the web player gets a canvas now: the "canvas" GraphQL query. */
async function canvasFromGraphql(t, uri) {
  const headers = { Authorization: `Bearer ${t.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json', 'App-Platform': 'WebPlayer', 'User-Agent': UA }
  if (t.clientToken && t.clientExp > Date.now()) headers['client-token'] = t.clientToken
  const body = JSON.stringify({ operationName: 'canvas', variables: { trackUri: uri }, extensions: { persistedQuery: { version: 1, sha256Hash: hashFor('canvas') } } })
  const res = await request('https://api-partner.spotify.com/pathfinder/v2/query', { method: 'POST', headers, body })
    .catch(e => ({ ok: false, status: e.name === 'AbortError' ? 'timeout' : e.message }))
  if (!res.ok) {
    console.log(`[spotify-canvas] canvas query for ${uri}: HTTP ${res.status}`)
    if (res.status === 401) tokens = null
    return { failed: true }
  }
  const json = await res.json().catch(() => null)
  const canvas = json?.data?.trackUnion?.canvas
  const url = canvas?.url
  if (json?.errors?.length) console.log(`[spotify-canvas] canvas query errors: ${json.errors.map(e => e.message).join('; ').slice(0, 200)}`)
  console.log(`[spotify-canvas] canvas query for ${uri}: ${url ? `found a clip (${canvas.type || 'no type'})` : canvas ? `canvas without a link (${canvas.type || 'no type'})` : 'no canvas'}`)
  return { url: url && /^https:\/\//.test(url) && /\.mp4(?:[?#]|$)/i.test(url) ? url : null, failed: !json?.data }
}

async function canvasFor(t, uri) {
  const viaGraphql = await canvasFromGraphql(t, uri)
  if (viaGraphql.url) return viaGraphql.url
  if (!viaGraphql.failed) return null
  // The query itself failed (e.g. its hash went stale): try the older
  // canvas service BitChord uses.
  return canvasFromCanvaz(t, uri)
}

async function canvasFromCanvaz(t, uri) {
  const headers = {
    'Content-Type': 'application/protobuf', Accept: 'application/protobuf', 'Accept-Language': 'en',
    Authorization: `Bearer ${t.accessToken}`, 'User-Agent': CANVAS_UA,
  }
  if (t.clientToken && t.clientExp > Date.now()) headers['client-token'] = t.clientToken
  const res = await request(CANVAS_URL, { method: 'POST', headers, body: lenField(1, lenField(1, Buffer.from(uri))) })
  if (!res.ok) {
    console.log(`[spotify-canvas] canvas request for ${uri}: HTTP ${res.status}`)
    if (authFailed(res.status)) throw new TransientError(`Spotify canvas HTTP ${res.status}`)
    return null
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const url = parseCanvases(buf, uri)
  console.log(`[spotify-canvas] canvas for ${uri}: ${url ? 'found a clip' : `none (${buf.length}-byte answer${buf.length && !url ? `, contains: ${summarize(buf)}` : ''})`}`)
  return url
}

// One lookup at a time: they share the tokens, and it keeps us polite.
let queue = Promise.resolve()
/** Runs `work` after every lookup already waiting (and before any asked for later). */
function serial(work) {
  const job = queue.then(work)
  queue = job.catch(() => {})
  return job
}

/**
 * Provider for motion.js. `helpers` are motion.js' matching functions.
 * Throws a TransientError (not cached as "no canvas") when Spotify itself failed.
 */
function fromSpotify(track, settings, helpers) {
  return serial(async () => {
    const t = await getTokens(settings.spotify_sp_dc)
    if (!t) return null
    const uri = await findTrackUri(t, track, helpers)
    if (!uri) return null
    const url = await canvasFor(t, uri)
    return url ? { url, kind: 'mp4', source: 'spotify', tall: true } : null
  })
}

/** Settings' "Save & Test": can this cookie get a signed-in token? */
async function checkSpotify(rawCookie) {
  if (!cookieValue(rawCookie)) return { error: 'Paste your sp_dc cookie first.' }
  try {
    const t = await getTokens(rawCookie, { force: true })
    return t ? { ok: true } : { error: 'No token' }
  } catch (e) {
    return { error: e.message || 'Could not reach Spotify' }
  }
}

// ---------------------------------------------------------------- follows

/**
 * The artists the signed-in account follows (Home → Releases → Followed
 * artists → Spotify), with the same cookie and web-player token as Canvas.
 * Asked the way the web player lists "Your Library → Artists" (Pathfinder
 * libraryV3): Spotify answers web-player tokens on the public Web API
 * (/v1/me/following) with 429s. `fetchPage(url, token)` is for tests.
 */
async function followedArtists(rawCookie, { fetchPage, limit = 2000, pageSize = 50 } = {}) {
  if (!cookieValue(rawCookie)) throw new Error('Add your Spotify cookie (sp_dc) first.')
  const t = fetchPage ? { accessToken: 'test' } : await getTokens(rawCookie)
  if (!t?.accessToken) throw new Error('Spotify did not accept the cookie. Copy a fresh sp_dc value.')
  const get = fetchPage || (async url => {
    const headers = { Authorization: `Bearer ${t.accessToken}`, Accept: 'application/json', 'App-Platform': 'WebPlayer', 'User-Agent': UA }
    if (t.clientToken && t.clientExp > Date.now()) headers['client-token'] = t.clientToken
    const res = await request(url, { headers })
    if (res.status === 401) tokens = null
    if (res.status === 401) throw new Error('Spotify did not accept the cookie. Copy a fresh sp_dc value.')
    if (res.status === 429) throw new Error('Spotify is limiting requests right now. Try again in a few minutes.')
    if (!res.ok) throw new Error(`Spotify answered HTTP ${res.status}.`)
    return res.json()
  })
  const names = []
  for (let offset = 0; offset < limit; offset += pageSize) {
    const variables = { filters: ['Artists'], order: null, textFilter: null, features: ['LIKED_SONGS', 'YOUR_EPISODES_V2', 'PRERELEASES', 'EVENTS'], limit: pageSize, offset, flatten: false, folderUri: null, includeFoldersWhenFlattening: true }
    const extensions = { persistedQuery: { version: 1, sha256Hash: hashFor('libraryV3') } }
    const url = `https://api-partner.spotify.com/pathfinder/v1/query?operationName=libraryV3&variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(JSON.stringify(extensions))}`
    const json = await get(url, t.accessToken)
    if (json?.errors?.length && !json?.data) throw new Error(`Spotify: ${json.errors[0]?.message || 'the library query failed'}`)
    const library = json?.data?.me?.libraryV3
    // data and errors can come together (data: { me: null }): no library isn't an empty one.
    if (!library) throw new Error(`Spotify: ${json?.errors?.[0]?.message || "your library couldn't be read"}`)
    const items = library.items || []
    for (const entry of items) {
      const data = entry?.item?.data
      if (data?.__typename === 'Artist' && data.profile?.name) names.push(data.profile.name)
    }
    const total = Number(library.totalCount)
    if (!items.length || (Number.isFinite(total) && offset + pageSize >= total)) break
  }
  return names
}

/**
 * All playlists saved in the signed-in Spotify library, including playlists
 * inside folders. Unlike Home mixes, these are the user's actual playlists.
 * Only playlist metadata crosses IPC; the cookie and bearer stay in Electron.
 *
 * fetchPage(url, token) is an injectable request for parser/pagination tests.
 */
async function libraryPlaylists(rawCookie, { fetchPage, limit = 2000, pageSize = 50 } = {}) {
  if (!fetchPage && !cookieValue(rawCookie)) throw new Error('Add your Spotify cookie (sp_dc) in Settings → Integrations → Spotify first.')
  const t = fetchPage ? { accessToken: 'test' } : await getTokens(rawCookie)
  if (!t?.accessToken) throw new Error('Spotify did not accept the cookie. Copy a fresh sp_dc value.')
  const get = fetchPage || (async url => {
    const headers = { Authorization: `Bearer ${t.accessToken}`, Accept: 'application/json', 'App-Platform': 'WebPlayer', 'User-Agent': UA }
    if (t.clientToken && t.clientExp > Date.now()) headers['client-token'] = t.clientToken
    const response = await request(url, { headers })
    if (response.status === 401) tokens = null
    if (response.status === 401) throw new Error('Spotify session expired. Update your cookie in Settings → Integrations → Spotify.')
    if (response.status === 429) throw new TransientError('Spotify is limiting requests. Try again later.')
    if (!response.ok) throw new TransientError(`Spotify answered HTTP ${response.status}.`)
    return response.json()
  })
  const playlists = new Map()
  const size = Math.min(50, Math.max(1, Number(pageSize) || 50))
  const max = Math.min(5000, Math.max(size, Number(limit) || 2000))
  for (let offset = 0; offset < max; offset += size) {
    const variables = {
      filters: ['Playlists'], order: null, textFilter: '',
      features: ['LIKED_SONGS', 'YOUR_EPISODES_V2', 'PRERELEASES', 'EVENTS'],
      limit: size, offset, flatten: true, expandedFolders: [],
      folderUri: null, includeFoldersWhenFlattening: false,
    }
    const extensions = { persistedQuery: { version: 1, sha256Hash: hashFor('libraryV3') } }
    const url = `https://api-partner.spotify.com/pathfinder/v1/query?operationName=libraryV3&variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(JSON.stringify(extensions))}`
    const json = await get(url, t.accessToken)
    const library = json?.data?.me?.libraryV3
    if (!library || !Array.isArray(library.items)) throw new TransientError(`Spotify: ${json?.errors?.[0]?.message || "your playlists couldn't be read"}`)
    const items = library.items
    for (const entry of items) {
      const wrapper = entry?.item
      if (!/Playlist/i.test(wrapper?.__typename || '')) continue // exclude folders
      const data = wrapper?.data
      const uri = wrapper?._uri || data?.uri || ''
      if (!/^spotify:playlist:[A-Za-z0-9]{22}$/.test(uri) || !data?.name) continue
      playlists.set(uri, {
        id: uri.slice('spotify:playlist:'.length),
        name: String(data.name),
        owner: String(data.ownerV2?.data?.name || ''),
        thumbnail: biggestImage(data.images?.items?.[0]?.sources),
        total: Number(data.content?.totalCount) || 0,
      })
    }
    const total = Number(library.totalCount)
    if (!items.length || items.length < size || (Number.isFinite(total) && offset + size >= total)) return [...playlists.values()]
  }
  throw new TransientError('Spotify playlist library is larger than the supported limit; results were not truncated silently.')
}

// ---------------------------------------------------------------- liked songs

const LIKES_PAGE = 50
const LIKES_MAX_PAGES = 10 // 500 new likes between two looks at most; past that only the newest come

function pathfinderHeaders(t) {
  const headers = { Authorization: `Bearer ${t.accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8', 'App-Platform': 'WebPlayer', 'User-Agent': UA }
  if (t.clientToken && t.clientExp > Date.now()) headers['client-token'] = t.clientToken
  return headers
}

/** One Pathfinder operation (query or mutation) the way the web player sends it now (POST, v2). */
async function pathfinder(t, operationName, variables) {
  const body = JSON.stringify({ variables, operationName, extensions: { persistedQuery: { version: 1, sha256Hash: hashFor(operationName) } } })
  const res = await request('https://api-partner.spotify.com/pathfinder/v2/query', { method: 'POST', headers: pathfinderHeaders(t), body })
  if (res.status === 401) { tokens = null; throw new Error('Spotify did not accept the cookie. Copy a fresh sp_dc value.') }
  if (res.status === 429) throw new TransientError('Spotify is limiting requests right now.')
  if (!res.ok) throw new TransientError(`Spotify answered HTTP ${res.status}.`)
  const json = await res.json().catch(() => null)
  if (json?.errors?.length && !json?.data) throw new TransientError(`Spotify: ${json.errors[0]?.message || `${operationName} failed`}`)
  return json?.data
}

/** A Liked Songs entry as Lokal uses it. */
function likedEntry(entry) {
  const track = entry?.track
  const data = track?.data
  const uri = track?._uri || data?.uri || ''
  if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(uri) || data?.__typename !== 'Track') return null
  return {
    uri,
    title: data.name || '',
    artist: (data.artists?.items || []).map(a => a?.profile?.name).filter(Boolean).join(', '),
    album: data.albumOfTrack?.name || '',
    duration: Number(data.duration?.totalMilliseconds) > 0 ? Number(data.duration.totalMilliseconds) / 1000 : null,
    artwork_url: (data.albumOfTrack?.coverArt?.sources || []).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null,
    addedAt: Date.parse(entry?.addedAt?.isoString || '') || 0,
  }
}

/**
 * Songs liked on Spotify after `since` (ms), newest first, read the way the
 * web player lists Liked Songs (newest first): it stops at the first older
 * one, so a library of 20,000 likes costs one request when nothing's new.
 * `since` null: only the newest like, to start from (nothing is imported).
 * `fetchPage(offset, limit)` is for the tests.
 */
async function likedSince(rawCookie, since, { fetchPage } = {}) {
  if (!fetchPage && !cookieValue(rawCookie)) throw new Error('Add your Spotify cookie (sp_dc) first.')
  const page = fetchPage || (async (offset, limit) => {
    const t = await getTokens(rawCookie)
    if (!t?.accessToken) throw new Error('Spotify did not accept the cookie. Copy a fresh sp_dc value.')
    return pathfinder(t, 'fetchLibraryTracks', { offset, limit })
  })
  const fresh = []
  let newest = 0
  for (let index = 0; index < LIKES_MAX_PAGES; index++) {
    const data = await page(index * LIKES_PAGE, since == null ? 1 : LIKES_PAGE)
    const tracks = data?.me?.library?.tracks
    if (!tracks) throw new TransientError('Spotify: your Liked Songs couldn\'t be read')
    const items = (tracks.items || []).map(likedEntry)
    for (const entry of (tracks.items || []).map(item => Date.parse(item?.addedAt?.isoString || '') || 0)) newest = Math.max(newest, entry)
    if (since == null) return { items: [], newest }
    let older = false
    for (const item of items) {
      if (!item) continue
      if (item.addedAt <= since) { older = true; break }
      fresh.push(item)
    }
    if (older || (tracks.items || []).length < LIKES_PAGE) break
  }
  return { items: fresh, newest: Math.max(newest, since || 0) }
}

/** Likes a song on Spotify (Lokal → Spotify): found by title and artist, then saved to Liked Songs. Answers its uri, or null when Spotify doesn't have it. */
async function likeOnSpotify(rawCookie, track) {
  if (!cookieValue(rawCookie)) throw new Error('Add your Spotify cookie (sp_dc) first.')
  // In turn: likes made together don't search and save on Spotify at once.
  return serial(async () => {
    const t = await getTokens(rawCookie)
    if (!t?.accessToken) throw new Error('Spotify did not accept the cookie. Copy a fresh sp_dc value.')
    const norm = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    const cleanTitle = value => String(value || '').replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, '').trim()
    const firstArtist = value => String(value || '').split(/,|\s+(?:feat\.|ft\.|&|x)\s+/i)[0].trim()
    const artistsMatch = (want, artists) => {
      const target = norm(firstArtist(want))
      return (artists || []).some(name => norm(name) === target || norm(name).includes(target) || target.includes(norm(name)))
    }
    const uri = await findTrackUri(t, track, { norm, cleanTitle, splitFirstArtist: firstArtist, artistsMatch })
    if (!uri) return null
    await pathfinder(t, 'addToLibrary', { libraryItemUris: [uri], interactionId: null })
    return uri
  })
}

// Made For You: the mixes Spotify makes for the cookie's account (Discover
// Weekly, Release Radar, Daily Mixes, ...), read off the web player's Home the
// way it shows them, and their songs. Playlists Spotify makes for one listener
// have ids starting 37i9dQZEVX (Discover Weekly, Release Radar) or 37i9dQZF1E
// (Daily Mixes, artist and decade mixes, On Repeat); they come first.
const PERSONAL_PLAYLIST = /^spotify:playlist:37i9dQZ(?:EVX|F1E)/
const biggestImage = sources => [...(sources || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null

/** The Spotify-made playlists on a `home` answer, personal ones first. */
function homeMixes(data) {
  const seen = new Set()
  const mixes = []
  for (const section of data?.home?.sectionContainer?.sections?.items || []) {
    for (const item of section?.sectionItems?.items || []) {
      const playlist = item?.content?.data
      if (item?.content?.__typename !== 'PlaylistResponseWrapper' || playlist?.__typename !== 'Playlist') continue
      const uri = playlist.uri || item.uri || ''
      if (!/^spotify:playlist:[A-Za-z0-9]{22}$/.test(uri) || seen.has(uri)) continue
      const owner = playlist.ownerV2?.data?.name || ''
      if (owner !== 'Spotify' && !PERSONAL_PLAYLIST.test(uri)) continue
      seen.add(uri)
      mixes.push({
        id: uri, title: playlist.name || '', author: 'Spotify',
        description: String(playlist.description || '').replace(/<[^>]*>/g, ''),
        thumbnail: biggestImage(playlist.images?.items?.[0]?.sources), personal: PERSONAL_PLAYLIST.test(uri),
      })
    }
  }
  return [...mixes.filter(mix => mix.personal), ...mixes.filter(mix => !mix.personal)]
}

/** A playlist row (`fetchPlaylist`'s content.items[]) as a Lokal song, or null for episodes and local files. */
function playlistEntry(item) {
  const data = item?.itemV2?.data
  if (item?.itemV2?.__typename !== 'TrackResponseWrapper' || data?.__typename !== 'Track' || !data.name) return null
  const artists = (data.artists?.items || []).map(a => a?.profile?.name).filter(Boolean)
  if (!artists.length) return null
  return {
    title: data.name, artist: artists.join(', '), artists, album: data.albumOfTrack?.name || '',
    duration: Number(data.trackDuration?.totalMilliseconds) > 0 ? Number(data.trackDuration.totalMilliseconds) / 1000 : null,
    artwork_url: biggestImage(data.albumOfTrack?.coverArt?.sources), spotifyUri: data.uri || '', source: 'spotify',
  }
}

const tokenQuery = rawCookie => async (operationName, variables) => {
  const t = await getTokens(rawCookie)
  if (!t?.accessToken) throw new Error('Spotify did not accept the cookie. Copy a fresh sp_dc value.')
  return pathfinder(t, operationName, variables)
}

/** Spotify's actual Recently Played shelf (never inferred from mixes).
 * The WebPlayer cookie token may lack this optional account scope. In that
 * case the IPC caller returns an empty shelf and other shelves still work.
 * A fetchPage override keeps parser regressions independent of network/auth.
 */
async function recentlyPlayed(rawCookie, { fetchPage } = {}) {
  if (!fetchPage && !cookieValue(rawCookie)) throw new Error('Connect Spotify to load recently played songs.')
  const requestPage = fetchPage || (async () => {
    const t = await getTokens(rawCookie)
    if (!t?.accessToken) throw new Error('Spotify did not accept the cookie.')
    const response = await request('https://api.spotify.com/v1/me/player/recently-played?limit=30', {
      headers: { Authorization: `Bearer ${t.accessToken}`, Accept: 'application/json', 'App-Platform': 'WebPlayer', 'User-Agent': UA },
    })
    if (response.status === 401) tokens = null
    if (!response.ok) throw new Error(`Spotify recently played unavailable (HTTP ${response.status}).`)
    return response.json()
  })
  const page = await requestPage()
  return (Array.isArray(page?.items) ? page.items : []).map(entry => {
    const track = entry?.track || {}
    const artists = (track.artists || []).map(a => a?.name).filter(Boolean)
    const title = String(track.name || '').trim()
    if (!title || !artists.length) return null
    const uri = /^spotify:track:[A-Za-z0-9]{22}$/.test(track.uri || '') ? track.uri : ''
    return {
      id: track.id || uri || `${title}:${artists.join(', ')}`,
      title, artist: artists.join(', '), artists, album: track.album?.name || '',
      artwork_url: (track.album?.images || []).slice().sort((a,b) => (b.width || 0) - (a.width || 0))[0]?.url || '',
      duration: Number(track.duration_ms) > 0 ? Number(track.duration_ms) / 1000 : null,
      ...(uri ? { spotifyUri: uri } : {}),
      source: 'spotify', scrobbledAt: Math.floor(Date.parse(entry.played_at || '') / 1000) || 0,
    }
  }).filter(Boolean)
}

/** The Made For You playlists on the account's Spotify Home. `query(op, variables)` is for the tests. */
async function madeForYou(rawCookie, { query } = {}) {
  if (!query && !cookieValue(rawCookie)) throw new Error('Add your Spotify cookie (sp_dc) in Settings → Integrations → Spotify first.')
  const data = await (query || tokenQuery(rawCookie))('home', {
    homeEndUserIntegration: 'INTEGRATION_WEB_PLAYER', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    sp_t: '', facet: '', sectionItemsLimit: 20, includeHomeChapterVideoCards: false, includeEpisodeContentRatingsV2: false,
  })
  if (!data?.home?.sectionContainer) throw new TransientError('Spotify: your Home couldn\'t be read')
  return homeMixes(data)
}

/** Spotify playlist tracks: null max loads every page; Discovery keeps its 200-track preview. */
async function playlistTracks(rawCookie, uri, { query, max = 200 } = {}) {
  if (!/^spotify:playlist:[A-Za-z0-9]{22}$/.test(String(uri || ''))) throw new Error('Not a Spotify playlist.')
  if (!query && !cookieValue(rawCookie)) throw new Error('Add your Spotify cookie (sp_dc) in Settings → Integrations → Spotify first.')
  const run = query || tokenQuery(rawCookie)
  const tracks = []
  const limit = max == null ? Infinity : Math.max(0, Math.floor(Number(max) || 0))
  let title = ''
  let offset = 0
  let totalCount = null
  // Never silently stop at 1,000 items: continue until Spotify's totalCount
  // is exhausted. The guard only rejects endpoints that fail to terminate.
  for (let pages = 0; offset < limit; pages++) {
    if (pages >= 10000) throw new TransientError('Spotify playlist pagination exceeded its safety limit.')
    const data = await run('fetchPlaylist', { uri, offset, limit: 100, enableWatchFeedEntrypoint: false, includeEpisodeContentRatingsV2: false })
    const playlist = data?.playlistV2
    if (playlist?.__typename !== 'Playlist') throw new TransientError(`Spotify: ${playlist?.message || 'the playlist couldn\'t be read'}`)
    title = title || playlist.name || ''
    const items = playlist.content?.items
    if (!Array.isArray(items) || items.length > 100) throw new TransientError('Spotify returned an invalid playlist page.')
    const rawTotal = playlist.content?.totalCount
    const total = rawTotal == null ? null : Number(rawTotal)
    if (total != null && (!Number.isSafeInteger(total) || total < 0)) throw new TransientError('Spotify returned an invalid playlist total.')
    if (total != null) totalCount = total
    if (!items.length) {
      if (total != null && offset < total) throw new TransientError('Spotify stopped before loading all playlist tracks. Retry later.')
      break
    }
    tracks.push(...items.map(playlistEntry).filter(Boolean))
    // Offset counts all Spotify entries, not just supported tracks.
    offset += items.length
    if (total != null && offset >= total) break
    if (total == null && items.length < 100) break
  }
  return { title, tracks: max == null ? tracks : tracks.slice(0, limit),
    ...(max == null ? { total: totalCount ?? offset, unavailable: offset - tracks.length } : {}) }
}


/**
 * Search Spotify's catalogue using the existing private sp_dc web-player
 * session; token/cookie values never cross into renderer or playlist data.
 */
async function catalogueSearch(rawCookie, query, { offset = 0, limit = 25, fetchImpl = request } = {}) {
  if (!cookieValue(rawCookie)) throw new Error('Connect Spotify in Integrations to search its catalogue.')
  const q = String(query || '').trim().slice(0, 160)
  if (q.length < 2) return { tracks: [], albums: [], artists: [] }
  const start = Math.max(0, Math.min(150, Number(offset) || 0))
  const count = Math.max(1, Math.min(50, Number(limit) || 25))
  let t = await getTokens(rawCookie)
  if (!t?.accessToken) throw new Error('Spotify session expired. Update your cookie.')
  const url = new URL('https://api.spotify.com/v1/search')
  url.search = new URLSearchParams({
    q, type: 'track,album,artist', limit: String(count), offset: String(start),
  }).toString()
  const load = token => fetchImpl(url.toString(), {
    headers: {
      Authorization: 'Bearer ' + token.accessToken,
      Accept: 'application/json', 'User-Agent': UA, 'App-Platform': 'WebPlayer',
      Origin: 'https://open.spotify.com',
      ...(token.clientToken && token.clientExp > Date.now()
        ? { 'client-token': token.clientToken } : {}),
    },
  })
  let res = await load(t)
  if (res.status === 401) {
    t = await getTokens(rawCookie, { force: true })
    if (!t) throw new Error('Spotify session expired.')
    res = await load(t)
  }
  if (!res.ok) {
    const fallback = await searchCataloguePathfinder(t, q, start, count, fetchImpl)
    if (fallback.tracks.length) return { ...fallback, partial: true }
    throw new Error('Spotify catalogue unavailable (HTTP ' + res.status + ').')
  }
  const json = await res.json()
  const photo = item => {
    const first = item?.images?.[0]?.url || item?.coverArt?.sources?.[0]?.url || ''
    return typeof first === 'string' && /^https:\/\//.test(first) ? first : ''
  }
  const tracks = (json?.tracks?.items || []).filter(item => item?.id && item?.name)
    .map(item => ({
      id: String(item.id), title: item.name,
      artist: (item.artists || []).map(a => a?.name).filter(Boolean).join(', '),
      album: item.album?.name || '',
      duration: Number(item.duration_ms) / 1000 || null,
      artwork_url: photo(item.album), catalogue: 'spotify',
      catalogue_id: String(item.id),
    })).filter(item => item.artist)
  const albums = (json?.albums?.items || []).filter(item => item?.id && item?.name)
    .map(item => ({
      id: String(item.id), title: item.name,
      artist: (item.artists || []).map(a => a?.name).filter(Boolean).join(', '),
      artwork_url: photo(item), catalogue: 'spotify', catalogue_id: String(item.id),
    }))
  const artists = (json?.artists?.items || []).filter(item => item?.id && item?.name)
    .map(item => ({
      id: String(item.id), title: item.name, artist: item.name,
      artwork_url: photo(item), catalogue: 'spotify', catalogue_id: String(item.id),
    }))
  return { tracks, albums, artists }
}

/** Older cookie-backed WebPlayer tokens can use Pathfinder even when REST
 * search refuses them. That operation currently supplies track rows only. */
async function searchCataloguePathfinder(token, term, offset, limit, fetchImpl = request) {
  const variables = { searchTerm: term, offset, limit, numberOfTopResults: 5,
    includeAudiobooks: false, includePreReleases: false }
  const extensions = { persistedQuery: { version: 1, sha256Hash: hashFor('searchTracks') } }
  const url = 'https://api-partner.spotify.com/pathfinder/v1/query?operationName=searchTracks&variables=' +
    encodeURIComponent(JSON.stringify(variables)) + '&extensions=' + encodeURIComponent(JSON.stringify(extensions))
  const headers = { Authorization: 'Bearer ' + token.accessToken,
    Accept: 'application/json', 'App-Platform': 'WebPlayer', 'User-Agent': UA }
  if (token.clientToken && token.clientExp > Date.now()) headers['client-token'] = token.clientToken
  const res = await fetchImpl(url, { headers }).catch(() => null)
  if (!res?.ok) return { tracks: [], albums: [], artists: [] }
  const json = await res.json().catch(() => ({}))
  return {
    tracks: (json?.data?.searchV2?.tracksV2?.items || []).map(item => item?.item?.data)
      .filter(Boolean).map(item => {
        const id = String(item.uri || '').split(':').at(-1)
        const artwork = item.albumOfTrack?.coverArt?.sources?.[0]?.url || ''
        return {
          id, title: item.name || '', artist: (item.artists?.items || [])
            .map(a => a?.profile?.name).filter(Boolean).join(', '),
          album: item.albumOfTrack?.name || '',
          duration: Number(item.duration?.totalMilliseconds) / 1000 || null,
          artwork_url: /^https:\/\//.test(artwork) ? artwork : '',
          catalogue: 'spotify', catalogue_id: id,
        }
      }).filter(item => item.id && item.title && item.artist),
    albums: [], artists: [],
  }
}

module.exports = { madeForYou, playlistTracks, recentlyPlayed, homeMixes, playlistEntry, fromSpotify, checkSpotify, findSpotifyTrackId, parseCanvases, cookieValue, followedArtists, libraryPlaylists, likedSince, likeOnSpotify, likedEntry, catalogueSearch, TransientError }
