import { api } from './api.js'
import { DEFAULT_PLAYBACK_SOURCES, orderedPlaybackSources } from './playbackSources.js'
import { isPlayable, providerLabel, streamRef } from './onlineTracks.js'
import { AUTOMATIC_HTTP_BUDGET_MS, automaticHttpAddonHealth, isHttpAddonSource } from './onlineAddonHealth.mjs'

export const recommendationKey = value => String(value || '').normalize('NFKD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
export const songKey = track => `${recommendationKey(track?.artist)}\0${recommendationKey(track?.title)}`
export const sourceName = source => source === 'youtube' ? 'YouTube Music' : source === 'spotify' ? 'Spotify' : 'Last.fm'

export async function mapLimited(items, callback, concurrency = 4) {
  const out = new Array(items.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) { const at = index++; out[at] = await callback(items[at], at) }
  }))
  return out
}

export function uniqueSongs(items) {
  const seen = new Set()
  return (Array.isArray(items) ? items : []).filter(track => {
    if (!track?.title || !track?.artist) return false
    const key = songKey(track)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const stripFeatured = suffix => /\b(?:remix|live|cover)\b/i.test(recommendationKey(suffix)) ? suffix : ''
// The same recording under another label: "(2011 Remaster)", "- Remastered
// 2003", "- Original Mix", "- Single Version", "(Mono)". Live, remix, edit... stay different songs.
const SAME_RECORDING = '(?:(?:\\d{4}\\s+)?(?:digital(?:ly)?\\s+)?remaster(?:ed)?(?:\\s+\\d{4})?(?:\\s+version)?|(?:album|single|mono|stereo|lp)\\s+version|original\\s+mix|mono|stereo)'
const sameRecordingBracket = new RegExp(`\\s*[([]${SAME_RECORDING}[)\\]]`, 'gi')
const sameRecordingSuffix = new RegExp(`\\s+[-–—]\\s+${SAME_RECORDING}\\s*$`, 'i')
// "[Explicit]", "(Clean Version)": labels of the same recording.
const contentLabel = /\s*[([](?:explicit|clean)(?:\s+version)?[)\]]/gi
// A credit in brackets or after the name: "[feat. Joi]", "(ft. X)", " feat. Y".
const featBracket = /\s*[([](?:feat\.?|ft\.?|featuring|with)\s+[^)\]]*[)\]]/gi
const featSuffix = /\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i

/** An artist without the guests credited with them: "Estelle [feat. Joi]" -> "Estelle". */
export const mainArtist = artist => String(artist || '').replace(featBracket, '').replace(featSuffix, '').trim()

// CSV imports flatten semicolon-separated credits into commas. Keep known
// comma-containing artist names intact, including when followed by guests.
const COMMA_ARTISTS = ['Tyler, The Creator', 'Earth, Wind & Fire', 'Crosby, Stills, Nash & Young', 'Crosby, Stills & Nash', 'Emerson, Lake & Palmer']
function leadArtist(candidate) {
  // A provider's structured credit is authoritative; never split that name.
  if (candidate.artists?.[0]) return mainArtist(candidate.artists[0])
  const artist = mainArtist(candidate.artist).normalize('NFC')
  if (artist.includes(';')) return artist.split(';')[0].trim()
  const lower = artist.toLowerCase()
  const preserved = COMMA_ARTISTS.find(name => lower === name.toLowerCase() || lower.startsWith(name.toLowerCase() + ','))
  return preserved ? artist.slice(0, preserved.length) : artist.split(',')[0].trim()
}

/**
 * A title to search with: without guests, "[Explicit]" and remaster labels
 * ("American Boy (feat. Kanye West)" -> "American Boy"). A remix or live
 * version keeps its label.
 */
export const searchTitle = title => String(title || '')
  .replace(contentLabel, '')
  .replace(sameRecordingBracket, '')
  .replace(sameRecordingSuffix, '')
  .replace(featBracket, stripFeatured)
  .replace(featSuffix, stripFeatured)
  .replace(/\s{2,}/g, ' ')
  .trim() || String(title || '').trim()

export const titleKey = title => recommendationKey(String(title || '')
  .replace(contentLabel, '')
  .replace(sameRecordingBracket, '')
  .replace(sameRecordingSuffix, '')
  .replace(/\s*[([](?:official (?:music video|audio|video)|lyrics?|audio|hq|hd|album version|single version)[)\]]/gi, '')
  .replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s+[^)\]]+[)\]]/gi, stripFeatured)
  .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, stripFeatured))

const versionWords = /\b(?:remix|live|cover|instrumental|acoustic|karaoke|edit|sped up|slowed|nightcore)\b/i
const nonLatinLetters = value => [...value].some(char => /\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char))

/** Explicit bilingual aliases, e.g. "流線 - ryusen", without dropping version labels. */
export function recommendationTitles(title) {
  const original = String(title || '').normalize('NFC').trim()
  const parts = original.split(/\s+[-–—|/]\s+/).map(part => part.trim())
  if (parts.length !== 2 || versionWords.test(original) || nonLatinLetters(parts[0]) === nonLatinLetters(parts[1]) || !parts.some(part => !nonLatinLetters(part) && /\p{Script=Latin}/u.test(part))) return [original]
  return [original, ...parts.filter(part => !nonLatinLetters(part)), ...parts.filter(nonLatinLetters)]
}

export function recommendationQueries(candidate) {
  const artist = String(candidate.artist || '').normalize('NFC').trim()
  const lead = leadArtist(candidate)
  // Clean names first ("Estelle Grateful", not "Estelle [feat. Teedra Moses &
  // Russell Taylor] Grateful", which sources often can't find), then the
  // album's own artist, then the names as given.
  const names = [...new Set([lead, mainArtist(artist), mainArtist(candidate.album_artist), artist].filter(Boolean))]
  const titles = [...new Set([...recommendationTitles(searchTitle(candidate.title)), ...recommendationTitles(candidate.title)])]
  const queries = []
  for (const title of titles) for (const name of names) queries.push(`${name} ${title}`.trim())
  return [...new Set(queries)].slice(0, 6)
}

function matchingDuration(candidate, result) {
  const expected = Number(candidate?.duration)
  const actual = Number(result?.duration)
  // Same tolerance as final playlist replacement; unknown durations are still
  // checked against the downloaded audio by the scanner.
  return !(Number.isFinite(expected) && expected > 0 && Number.isFinite(actual) && actual > 0) || Math.abs(expected - actual) <= 10
}

export function recommendationMatch(candidate, results, { provider } = {}) {
  const titles = recommendationTitles(candidate?.title).map(titleKey)
  const artist = recommendationKey(candidate?.artist)
  if (!titles[0] || !artist) return null
  const leadKey = recommendationKey(leadArtist(candidate)).replace(/ topic$/, '')
  // The same artists without their guests ("Estelle [feat. Joi]" is Estelle),
  // and, on an album's page, the album's artist ("Estelle, D-Nice & ...").
  const artistKeys = new Set([artist, leadKey, recommendationKey(mainArtist(candidate.artist)), recommendationKey(mainArtist(candidate.artists?.[0])), recommendationKey(mainArtist(candidate.album_artist))].filter(Boolean))
  const sameArtist = name => artistKeys.has(recommendationKey(mainArtist(name)).replace(/ topic$/, ''))
  // Require both title and artist. A catalogue search is playback resolution,
  // not a second recommendation engine. Covers/remixes must not replace songs.
  // Of the matches, the one from the same album comes first (a compilation's
  // copy would bring another cover, and its colours, along).
  const matches = (Array.isArray(results) ? results : []).filter(result => {
    if (!matchingDuration(candidate, result)) return false
    const name = String(result?.title || '')
    const prefix = name.match(/^(.+?)\s+[-–—|]\s+(.+)$/)
    const suffix = name.match(/^(.+)\s+[-–—|]\s+(.+)$/)
    const prefixedArtist = prefix && sameArtist(prefix[1])
    const youtube = (provider || result.provider) === 'yt'
    const suffixedArtist = youtube && suffix && sameArtist(suffix[2])
    const resultTitle = prefixedArtist ? prefix[2] : suffixedArtist ? suffix[1] : name
    if (!recommendationTitles(resultTitle).map(titleKey).some(title => titles.includes(title))) return false
    // Video uploaders need not be the performer. Only trust an explicit exact
    // artist/title pair; a bare title on an unrelated channel is insufficient.
    if (youtube && (prefixedArtist || suffixedArtist)) return true
    const artists = Array.isArray(result.artists) ? result.artists : [result.artist]
    return artists.some(sameArtist) || sameArtist(result.artist) || sameArtist(leadArtist(result))
  })
  const album = recommendationKey(candidate.album)
  return (album && matches.find(result => recommendationKey(result.album) === album)) || matches[0] || null
}

/**
 * The cover to save a matched song with: the match's own, unless it's from
 * another release than the one picked (a compilation) -- then the picked
 * song's cover, so the colour background matches the cover shown.
 */
export function matchCover(candidate, match) {
  const picked = /^https:\/\//.test(String(candidate?.artwork_url || '')) && !/2a96cbd8b46e442fc41c2b86b821562f/.test(candidate.artwork_url) ? candidate.artwork_url : null
  const own = match?.thumbnail || match?.artwork_url || null
  if (!picked) return own
  const album = recommendationKey(candidate.album)
  return !own || (album && recommendationKey(match.album) !== album) ? picked : own
}

/** Preserve native YouTube identity across DB rows, provider fallbacks and restored queues. */
export function recommendationVideoId(track) {
  const valid = value => /^[\w-]{11}$/.test(String(value || '')) ? String(value) : null
  if (valid(track?.videoId)) return String(track.videoId)
  const ref = streamRef(track)
  if (ref?.provider === 'yt' && valid(ref.id)) return ref.id
  const saved = String(track?.source_ref || '').match(/^yt:([\w-]{11})$/)
  if (saved) return saved[1]
  if ((track?.provider === 'yt' || !track?.provider && track?.source === 'youtube' && !track?.file_path) && valid(track.id)) return String(track.id)
  for (const link of [track?.source_url, track?.url]) {
    try {
      const url = new URL(link)
      const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : /^(?:music\.|www\.)?youtube\.com$/.test(url.hostname) ? url.searchParams.get('v') : null
      if (valid(id)) return id
    } catch {}
  }
  return null
}

export async function timed(work, ms = 15000, message = 'Provider lookup timed out') {
  let timer
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })])
  } finally { clearTimeout(timer) }
}

/** Resolve the metadata queries for a single HTTP addon under one deadline.
 * This is only used for automatic fallback; manual Search remains unrestricted.
 * A provider result without a matching recording is a miss, not a failure.
 */
export async function searchHttpAddonWithinBudget(source, candidate, client, {
  budgetMs = AUTOMATIC_HTTP_BUDGET_MS, now = Date.now,
} = {}) {
  const deadline = now() + budgetMs
  for (const query of recommendationQueries(candidate)) {
    const remaining = deadline - now()
    if (remaining <= 0) throw new Error('HTTP addon lookup timed out')
    const response = await timed(() => client.onlineSearch(query, source.id, { automatic: true }), remaining, 'HTTP addon lookup timed out')
    if (response?.error) return { match: null, error: response.error }
    const match = recommendationMatch(candidate, response?.results, { provider: source.id })
    if (match) return { match, error: '' }
  }
  return { match: null, error: '' }
}

export async function playbackSources(client = api, timeoutMs = 15000) {
  const [settings, available] = await Promise.all([
    timed(() => client.getSettings(), timeoutMs).catch(() => ({})),
    timed(() => client.onlineProviders(), timeoutMs).catch(() => DEFAULT_PLAYBACK_SOURCES),
  ])
  return orderedPlaybackSources(settings?.playback_search_order, Array.isArray(available) && available.length ? available : DEFAULT_PLAYBACK_SOURCES)
}

export const playableRecommendation = track => !!(track?.id && track.file_path && !track.preview && isPlayable(track))

export function playbackFallbackMessage({ candidate, source, nextSource, reason, detail }) {
  const label = source.label || providerLabel(source.id)
  const title = candidate.title || 'this song'
  const message = reason === 'preview' ? `${label} only has a preview of “${title}”.`
    : reason === 'not-found' ? `“${title}” wasn't found on ${label}.`
      : `“${title}” couldn't play on ${label}.`
  return `${message} ${detail ? `${detail} ` : ''}${nextSource ? `Trying ${nextSource.label || providerLabel(nextSource.id)}.` : 'No more playback sources are available.'}`
}

// Search metadata alone cannot tell whether a full stream is available (in
// particular, SoundCloud may only report its Go+ preview during resolution).
export async function playbackAvailability(match, provider, client = api, timeoutMs = 35000, onError = () => {}, onProgress = () => {}, { packageAddon = /^a-/.test(provider), automatic = false } = {}) {
  if (match.preview) return 'preview'
  if (typeof client.onlinePrepare !== 'function') return null
  const controller = new AbortController()
  let prepared
  let completed = false
  try {
    prepared = await timed(() => client.onlinePrepare(provider, String(match.id), false, { signal: controller.signal, onProgress, automatic }), packageAddon && /^a-/.test(provider) ? Math.max(timeoutMs, 15 * 60 * 1000) : timeoutMs, 'Audio preparation timed out. Try again.')
    completed = true
  } catch (error) {
    onError(error?.message || error)
    return 'unavailable'
  } finally {
    // onlinePrepare resolves as soon as a verified growing stream is playable.
    // Aborting the signal on *success* cancels that still-running Morneye
    // download before lokal-stream:// can attach to it. Only cancel a prepare
    // that timed out or failed; playback takes ownership of a ready stream.
    if (!completed) controller.abort()
  }
  if (prepared?.preview) return 'preview'
  if (prepared?.error) onError(addonErrorText(prepared.error))
  return prepared?.ok && !prepared.error ? null : 'unavailable'
}

const ADDON_ACCESS_ERROR = /VERIFY_REQUIRED|verif|log\s*in|sign\s*in|unauthori[sz]ed|not authenticated/i

export const isAddonVerificationRequiredError = error => error?.code === 'ADDON_VERIFICATION_REQUIRED'

export function dispatchAddonVerificationRequired(error, retry, cancel) {
  if (!isAddonVerificationRequiredError(error) || typeof window === 'undefined') return false
  window.dispatchEvent(new CustomEvent('lokal:addon-verification-required', {
    detail: {
      key: error.key || String(error.provider || '').slice(2),
      provider: error.provider,
      title: error.title || 'this song',
      retry,
      cancel,
    },
  }))
  return true
}

function addonErrorText(value) {
  if (typeof value === 'string') return value
  return String(value?.message || value?.error || value?.detail || value?.code || '')
}

function requiresAddonVerification(provider, value) {
  return /^a-/.test(String(provider || '')) && ADDON_ACCESS_ERROR.test(addonErrorText(value))
}

function addonVerificationError(provider, value, candidate) {
  const error = new Error(addonErrorText(value) || 'This add-on needs verification.')
  error.code = 'ADDON_VERIFICATION_REQUIRED'
  error.provider = String(provider || '')
  error.key = error.provider.slice(2)
  error.title = candidate?.title || 'this song'
  return error
}

export async function resolveRecommendationTracks(candidates, client = api, options = {}) {
  const { searchLocal = true, reusePlayable = true, isCurrent = () => true, timeoutMs = 15000, prepareTimeoutMs = 35000, afterProvider, startFromProvider, skipProviders = [], onProviderFailure, onProgress, onPreparationProgress, onAddonVerificationRequired, prepareStreams = true, preserveMatchMetadata = false, sources: configuredSources } = options
  if (!Array.isArray(candidates) || !candidates.length || !isCurrent()) return []
  const ordered = configuredSources || await playbackSources(client, timeoutMs)
  const requestedStart = startFromProvider ? ordered.findIndex(source => source.id === startFromProvider) : -1
  const start = requestedStart >= 0 ? requestedStart : afterProvider ? ordered.findIndex(source => source.id === afterProvider) + 1 : 0
  const sources = ordered.slice(start).filter(source => (requestedStart >= 0 || source.id !== afterProvider) && !skipProviders.includes(source.id))
  const unique = uniqueSongs(candidates)
  let completed = 0
  try {
    return (await mapLimited(unique, async candidate => {
    try {
    if (!isCurrent()) return null
    if (reusePlayable && playableRecommendation(candidate)) return candidate
    const videoId = recommendationVideoId(candidate)
    try {
      // A song from an addon's own album or artist page: that very song, no search.
      if (candidate.exact && /^a-/.test(String(candidate.provider || '')) && candidate.id != null) {
        const saved = await timed(() => client.onlineSave([candidate]), timeoutMs).catch(error => {
          if (requiresAddonVerification(candidate.provider, error)) throw addonVerificationError(candidate.provider, error, candidate)
          return null
        })
        if (saved?.error && requiresAddonVerification(candidate.provider, saved.error)) throw addonVerificationError(candidate.provider, saved.error, candidate)
        const row = Array.isArray(saved) && playableRecommendation(saved[0]) ? saved[0] : null
        if (row && isCurrent()) return { ...row, title: candidate.title, artist: candidate.artist, album: candidate.album || row.album, artwork_url: candidate.artwork_url || row.artwork_url, source: candidate.source || 'addon' }
      }
      const local = searchLocal ? await timed(() => client.searchTracks(candidate.title), timeoutMs).catch(() => null) : null
      const rows = Array.isArray(local) ? local : Array.isArray(local?.tracks) ? local.tracks : []
      // Imported ghosts and previously cached streams must not override a newly
      // configured provider order. Only a real library file takes precedence.
      let row = recommendationMatch(candidate, rows.filter(track => playableRecommendation(track) && !track.missing && !track.file_path.startsWith('ghost://')))
      if (!row) {
        // Warm at most three HTTP metadata lookups concurrently when a
        // recommendation reaches those providers. Only actual playback
        // follows saved priority; no audio is fetched speculatively.
        const preparedHttp = new Map()
        const warmHttp = index => {
          for (const upcoming of sources.slice(index).filter(s => isHttpAddonSource(s)).slice(0, 3)) {
            if (preparedHttp.has(upcoming.id) || automaticHttpAddonHealth.shouldSkip(upcoming, sources)) continue
            preparedHttp.set(upcoming.id, searchHttpAddonWithinBudget(upcoming, candidate, client)
              .catch(error => ({ match: null, error: String(error?.message || error) })))
          }
        }
        for (const [index, source] of sources.entries()) {
          const quickHttp = isHttpAddonSource(source) && sources.length > 1 && !startFromProvider
          if (quickHttp && automaticHttpAddonHealth.shouldSkip(source, sources)) continue
          if (quickHttp) warmHttp(index)
          const httpDeadline = quickHttp ? Date.now() + AUTOMATIC_HTTP_BUDGET_MS : null
          if (!isCurrent()) return null
          const failed = (reason, detail) => { if (isCurrent()) onProviderFailure?.({ candidate, source, nextSource: sources[index + 1], reason, ...(detail ? { detail } : {}) }) }
          let matchFound = false
          try {
            const direct = source.id === 'yt' && videoId
            if (isCurrent()) onProgress?.(`${direct ? 'Loading' : 'Searching'} ${source.label || providerLabel(source.id)} ${direct ? 'track' : 'for'} ${candidate.artist} — “${candidate.title}”…`)
            let match = direct ? { ...candidate, videoId, provider: 'yt', id: videoId } : null
            let searchError = ''
            if (!direct && quickHttp) {
              const result = await (preparedHttp.get(source.id) || searchHttpAddonWithinBudget(source, candidate, client))
              match = result.match
              searchError = result.error
            }
            if (!direct && !quickHttp) {
              const deadline = Date.now() + timeoutMs
              for (const query of recommendationQueries(candidate)) {
                if (!isCurrent()) return null
                const remaining = deadline - Date.now()
                if (remaining <= 0) throw new Error('Provider lookup timed out')
                const response = await timed(() => client.onlineSearch(query, source.id), remaining)
                if (!isCurrent()) return null
                if (response?.error) { searchError = response.error; break }
                match = recommendationMatch(candidate, response?.results, { provider: source.id })
                if (match) break
              }
              // The Music catalogue can answer successfully but omit a song
              // that exists as a regular upload. Try videos within YouTube's
              // turn, before moving to the next configured playback source.
              if (!match && !searchError && source.id === 'yt' && typeof client.searchYT === 'function') {
                if (!isCurrent()) return null
                const remaining = deadline - Date.now()
                if (remaining <= 0) throw new Error('Provider lookup timed out')
                const response = await timed(() => client.searchYT(recommendationQueries(candidate)[0], 1), remaining)
                if (!isCurrent()) return null
                searchError = response?.error || ''
                const videos = (Array.isArray(response) ? response : response?.results || []).map(video => ({
                  ...video, provider: 'yt', artist: video.artist || video.channel || '',
                  artists: video.artists || [video.artist || video.channel || ''], kind: 'video',
                }))
                match = recommendationMatch(candidate, videos, { provider: 'yt' })
              }
            }
            if (searchError) {
              // A verification error from search does not prove this provider
              // has a match for the candidate. Keep looking without prompting.
              if (quickHttp) automaticHttpAddonHealth.failed(source, searchError)
              failed('unavailable', searchError)
              continue
            }
            if (!isCurrent()) return null
            if (!match) { failed('not-found'); continue }
            matchFound = true
            let detail
            const httpPrepareBudget = quickHttp
              ? Math.max(1, httpDeadline - Date.now()) : prepareTimeoutMs
            const unavailable = match.preview ? 'preview' : prepareStreams || source.id === 'sc' ? await playbackAvailability(
              match, source.id, client, httpPrepareBudget,
              message => { detail = message },
              status => { if (isCurrent()) onPreparationProgress?.({ source, candidate, status }) },
              { packageAddon: source.package === true, automatic: quickHttp },
            ) : null
            if (!isCurrent()) return null
            if (unavailable) {
              if (requiresAddonVerification(source.id, detail)) throw addonVerificationError(source.id, detail, candidate)
              if (quickHttp) automaticHttpAddonHealth.failed(source, detail || unavailable)
              failed(unavailable, detail)
              continue
            }
            const saved = await timed(() => client.onlineSave([{ ...match, provider: source.id, thumbnail: matchCover(candidate, match) || undefined }]), timeoutMs)
            if (saved?.error && requiresAddonVerification(source.id, saved.error)) throw addonVerificationError(source.id, saved.error, candidate)
            // saveOnlineTracks preserves order, including nulls, for all
            // providers (addon row IDs are hashed by the backend).
            row = Array.isArray(saved) && playableRecommendation(saved[0]) ? saved[0] : null
            if (row) {
              if (quickHttp) automaticHttpAddonHealth.succeeded(source)
              break
            }
            failed('unavailable')
          } catch (error) {
            if (matchFound && isAddonVerificationRequiredError(error)) throw error
            if (matchFound && requiresAddonVerification(source.id, error)) throw addonVerificationError(source.id, error, candidate)
            if (quickHttp) automaticHttpAddonHealth.failed(source, error)
            failed('unavailable', error?.message)
          }
        }
      }
      return row && isCurrent() ? {
        ...row,
        title: preserveMatchMetadata ? (row.title || candidate.title) : candidate.title,
        artist: preserveMatchMetadata ? (row.artist || candidate.artist) : candidate.artist,
        ...(videoId ? { videoId } : {}),
        ...(candidate.artists?.length ? { artists: candidate.artists } : {}),
        album: preserveMatchMetadata ? (row.album || candidate.album) : (candidate.album || row.album),
        artwork_url: preserveMatchMetadata ? (row.artwork_url || candidate.artwork_url) : (candidate.artwork_url || row.artwork_url),
        source: candidate.source || 'lastfm', reason: candidate.reason,
        scrobbledAt: candidate.scrobbledAt, scrobbleCount: candidate.scrobbleCount,
      } : null
    } catch (error) {
      if (isAddonVerificationRequiredError(error)) throw error
      return null
    }
    } finally {
      completed++
      // One completed candidate is observable progress. Provider searches
      // inside a candidate have no fixed work count, so don't invent one.
      if (unique.length > 1 && isCurrent()) {
        onProgress?.(`Resolving tracks…`, {
          completed, total: unique.length,
          percent: Math.floor(completed / unique.length * 100),
        })
      }
    }
    })).filter(Boolean)
  } catch (error) {
    if (!isAddonVerificationRequiredError(error)) throw error
    const retry = () => resolveRecommendationTracks(candidates, client, {
      ...options,
      ...(error.provider ? { startFromProvider: error.provider } : {}),
    })
    if (typeof onAddonVerificationRequired === 'function') {
      onAddonVerificationRequired(error, retry)
      throw error
    }
    // Direct callers (mix generation, downloads, playlist resolution) await the
    // same operation while the popup is open. Its retry resolves this promise,
    // so the outer caller continues instead of receiving a rejected promise.
    return await new Promise((resolve, reject) => {
      const cancel = () => resolve([])
      const retryAndResolve = async () => {
        try {
          const rows = await resolveRecommendationTracks(candidates, client, {
            ...options,
            ...(error.provider ? { startFromProvider: error.provider } : {}),
            onAddonVerificationRequired: (nextError, nextRetry) => {
              const handedOff = dispatchAddonVerificationRequired(nextError, async () => {
                try {
                  const next = await nextRetry()
                  resolve(next)
                  return next
                } catch (nestedError) {
                  if (!isAddonVerificationRequiredError(nestedError)) reject(nestedError)
                  throw nestedError
                }
              }, cancel)
              if (!handedOff) reject(nextError)
            },
          })
          resolve(rows)
          return rows
        } catch (retryError) {
          // A subsequent prompt now owns this promise; let the current verify
          // attempt finish so the UI can re-enable its controls.
          if (isAddonVerificationRequiredError(retryError)) return null
          reject(retryError)
          throw retryError
        }
      }
      if (!dispatchAddonVerificationRequired(error, retryAndResolve, cancel)) reject(error)
    })
  }
}

// Build until the requested count, trying additional provider pages and
// skipping failed playback matches. Previous songs are considered only after
// new recommendations; there is no shuffle of the previous eight-song shelf.
export async function buildRecommendationMix({ size, previous = [], loadPage, resolve = resolveRecommendationTracks, isCurrent = () => true, onAddonVerificationRequired: onVerificationRequired }) {
  const target = [24, 32, 40].includes(Number(size)) ? Number(size) : 32
  const previousKeys = new Set(previous.map(songKey))
  const tried = new Set()
  const ids = new Set()
  const tracks = []
  const repeats = []
  async function consume(pool) {
    const candidates = uniqueSongs(pool).filter(track => !tried.has(songKey(track)))
    for (let at = 0; at < candidates.length && tracks.length < target && isCurrent(); at += 8) {
      const batch = candidates.slice(at, at + 8)
      batch.forEach(track => tried.add(songKey(track)))
      let verificationRequested = false
      const onAddonVerificationRequired = typeof onVerificationRequired === 'function'
        ? error => { verificationRequested = true; onVerificationRequired(error) }
        : undefined
      let resolved
      try {
        const resolveOptions = onAddonVerificationRequired ? { onAddonVerificationRequired } : {}
        resolved = resolve === resolveRecommendationTracks
          ? await resolve(batch, api, resolveOptions)
          : await resolve(batch, resolveOptions)
      } catch (error) {
        if (isAddonVerificationRequiredError(error) && !verificationRequested) {
          if (typeof onVerificationRequired === 'function') onVerificationRequired(error)
          else dispatchAddonVerificationRequired(error, () => buildRecommendationMix({ size, previous, loadPage, resolve, isCurrent }))
        }
        throw error
      }
      if (!isCurrent()) throw new Error('Mix request superseded')
      for (const track of resolved) {
        if (!track?.id || ids.has(track.id) || tracks.length >= target) continue
        ids.add(track.id)
        tracks.push(track)
      }
    }
  }
  for (let page = 0; page < 3 && tracks.length < target && isCurrent(); page++) {
    const data = await loadPage(page)
    if (!isCurrent()) throw new Error('Mix request superseded')
    if (data?.error) throw new Error(data.error)
    const pool = uniqueSongs(data?.candidates)
    repeats.push(...pool.filter(track => previousKeys.has(songKey(track))))
    await consume(pool.filter(track => !previousKeys.has(songKey(track))).slice(0, 120))
  }
  if (tracks.length < target) await consume(repeats)
  if (!isCurrent()) throw new Error('Mix request superseded')
  if (tracks.length !== target) throw new Error(`Found ${tracks.length} playable matches for ${target} requested tracks. Try again when more recommendations are available.`)
  if (previous.length && tracks.every(track => previousKeys.has(songKey(track)))) throw new Error('The provider returned the same songs. Your existing mix has been kept; try again after more listening.')
  return tracks
}

// Spotify: genuine Made For You mixes. Fresh Finds and Quick Picks use
// different personal playlists; recently played requires separate account data.
async function loadSpotifyPage(page, client, force) {
  const home = await client.spotifyMadeForYou(force)
  if (home?.error && !home?.mixes?.length) return { error: home.error }
  const mixes = (home?.mixes || []).map(mix => ({ ...mix, source: 'spotify', artwork_url: mix.thumbnail }))
  const personal = mixes.filter(mix => mix.personal)
  const pool = personal.length ? personal : mixes
  const start = pool.length ? page * 2 % pool.length : 0
  const rotated = [...pool.slice(start), ...pool.slice(0, start)]
  // Mobile's cookie-based Spotify Discovery draws from several personal
  // playlists. Use the first two for Fresh Finds and the next two for Quick
  // Picks, so the latter are real provider songs instead of fabricated
  // 'Recently played' or duplicated cards.
  const picked = rotated.slice(0, 4)
  const recentJob = typeof client.spotifyRecentlyPlayed === 'function'
    ? Promise.resolve().then(() => client.spotifyRecentlyPlayed(force)).catch(() => ({ tracks: [] }))
    : Promise.resolve({ tracks: [] })
  const expanded = await Promise.all(picked.map(mix => client.spotifyPlaylist(mix.id, force).catch(error => ({ error: error.message }))))
  const recent = await recentJob
  const from = batches => uniqueSongs(batches.flatMap(data => data?.tracks || []).map(track => ({ ...track, source: 'spotify' })))
  const fresh = from(expanded.slice(0, 2))
  const freshKeys = new Set(fresh.map(songKey))
  const quick = from(expanded.slice(2, 4)).filter(track => !freshKeys.has(songKey(track)))
  const candidates = uniqueSongs([...fresh, ...quick])
  return {
    source: 'spotify', fetchedAt: Date.now(), candidates,
    freshFinds: fresh.slice(0, 30), quickPicks: quick.slice(0, 30), liked: [], history: (recent?.tracks || []).slice(0, 30), mixes, mixError: home?.error || '',
    artists: [...new Map(candidates.flatMap(track => (track.artists || [track.artist]).map(name => ({ name, source: 'spotify' }))).filter(artist => artist.name).map(artist => [recommendationKey(artist.name), artist])).values()].slice(0, 30),
    albums: [...new Map(candidates.filter(track => track.album).map(track => ({ title: track.album, artist: track.artists?.[0] || track.artist, artwork_url: track.artwork_url })).map(album => [`${album.artist}\0${album.title}`, album])).values()].slice(0, 30),
    warnings: expanded.map(data => data?.error).filter(Boolean),
  }
}

export async function loadRecommendationPage(source, page = 0, client = api, { force = false } = {}) {
  if (source === 'spotify') return loadSpotifyPage(page, client, force)
  if (source !== 'youtube') return client.lastfmDiscovery(page, force)
  const account = await client.youtubeAccount(true)
  if (account?.error) return account
  const tracks = uniqueSongs((account?.home || []).map(track => ({ ...track, source: 'youtube', artwork_url: track.thumbnail })))
  const allPlaylists = account?.homePlaylists || []
  const start = allPlaylists.length ? page * 2 % allPlaylists.length : 0
  const playlists = [...allPlaylists.slice(start), ...allPlaylists.slice(0, start)].slice(0, 2)
  const expanded = await Promise.all(playlists.map(item => client.youtubeAccountPlaylist(item.id).catch(() => null)))
  const candidates = uniqueSongs([...tracks, ...expanded.flatMap(data => data?.tracks || []).map(track => ({ ...track, source: 'youtube', artwork_url: track.thumbnail }))])
  const picks = tracks.length ? tracks : candidates
  const liked = uniqueSongs(account?.liked || []).map(track => ({ ...track, source: 'youtube', artwork_url: track.thumbnail }))
  return {
    source: 'youtube', fetchedAt: Date.now(), candidates,
    freshFinds: candidates.slice(0, 30), quickPicks: [], liked: liked.slice(0, 30), history: uniqueSongs(account?.history || []).map(track => ({ ...track, source: 'youtube', artwork_url: track.thumbnail })),
    mixes: (account?.mixes || []).map(mix => ({ ...mix, source: 'youtube', artwork_url: mix.thumbnail })),
    mixError: account?.mixError || '',
    categories: (account?.categories || []).map(group => ({
      ...group,
      tracks: (group.tracks || []).map(track => ({ ...track, source: 'youtube', artwork_url: track.artwork_url || track.thumbnail })),
      mixes: (group.mixes || []).map(mix => ({ ...mix, source: 'youtube', artwork_url: mix.artwork_url || mix.thumbnail })),
      albums: (group.albums || []).map(album => ({ ...album, source: 'youtube' })),
    })),
    artists: [...new Map([...(account?.artists || []), ...picks.flatMap(track => (track.artists || [track.artist]).map(name => ({ name, source: 'youtube' })))].filter(artist => artist.name).map(artist => [recommendationKey(artist.name), artist])).values()].slice(0, 30),
    albums: [...new Map([...(account?.albums || []), ...picks.filter(track => track.album).map(track => ({ title: track.album, artist: track.artist, albumId: track.albumId, artwork_url: track.thumbnail }))].map(album => [`${album.artist}\0${album.title}`, album])).values()].slice(0, 30),
    warnings: [account.homeError, account.mixError].filter(Boolean),
  }
}
