// Helpers for online songs (YouTube Music, SoundCloud), which live in the
// library as ghost tracks: ghost://youtube/online/<videoId> or
// ghost://soundcloud/online/<trackId>, or any ghost track whose source link is
// a YouTube video or a SoundCloud track (e.g. an imported playlist entry).

import { api } from './api.js'
import { downloadBatchCurrent } from './downloadCancellation.js'

export const PROVIDER_LABELS = { yt: 'YouTube', sc: 'SoundCloud', mono: 'Monochrome' }

/** Is `provider` a user-installed addon ("a-<key>")? */
export function isAddonProvider(provider) {
  return /^a-[0-9a-f]{10}$/.test(String(provider || ''))
}

/** Label of a provider: YouTube, SoundCloud, or "Addon". */
export function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || (isAddonProvider(provider) ? 'Addon' : 'the web')
}

/** A placeholder track with no file (imported or online). */
export function isGhostTrack(track) {
  return String(track?.file_path || '').startsWith('ghost://')
}

/** Where a ghost track can be streamed from: { provider: 'yt' | 'sc', id }, or null. */
export function streamRef(track) {
  const path = String(track?.file_path || '')
  const fromAddon = path.match(/^ghost:\/\/addon\/([0-9a-f]{10})\/(.+)$/)
  if (fromAddon) {
    try { return { provider: `a-${fromAddon[1]}`, id: decodeURIComponent(fromAddon[2]) } } catch { return null }
  }
  const own = path.match(/^ghost:\/\/(youtube|soundcloud|monochrome)\/online\/([\w-]+)$/)
  if (own) return { provider: own[1] === 'youtube' ? 'yt' : own[1] === 'soundcloud' ? 'sc' : 'mono', id: own[2] }
  if (!path.startsWith('ghost://')) return null
  const url = String(track?.source_url || '')
  const yt = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/)([\w-]{11})/)
  if (yt) return { provider: 'yt', id: yt[1] }
  const sc = url.match(/api\.soundcloud\.com\/tracks\/(?:soundcloud(?:%3A|:)tracks(?:%3A|:))?(\d+)/i)
  if (sc) return { provider: 'sc', id: sc[1] }
  const mono = url.match(/^https:\/\/tracks\.monochrome\.st\/track\/(\d{15,20})\/?(?:[?#].*)?$/)
  return mono ? { provider: 'mono', id: mono[1] } : null
}

/** Same online song? (a track, or a search result { provider, id }) */
export function sameStream(track, item) {
  const ref = streamRef(track)
  return !!ref && !!item && ref.provider === item.provider && ref.id === String(item.id)
}

/** Streamed rather than played from a file. */
export function isStreamed(track) {
  return !!streamRef(track)
}

/** "YouTube" / "SoundCloud" for a streamed track, else null. */
export function streamLabel(track) {
  const ref = streamRef(track)
  return ref ? providerLabel(ref.provider) : null
}

/**
 * An online song, the same whichever link it's reached by: "yt:<id>",
 * "sc:<id>", "a-<key>:<id>" (a download keeps it as its sourceRef).
 */
export function sourceRefKey(ref) {
  return ref?.provider && ref?.id ? `${ref.provider}:${ref.id}` : null
}

// Where a downloaded song came from (tracks.download_source).
const DOWNLOAD_SOURCE_LABELS = { yt: 'YouTube', sc: 'SoundCloud', mono: 'Monochrome', soulseek: 'Soulseek', web: 'Web' }
let addonNames = null
if (typeof window !== 'undefined') window.addEventListener('lokal:addons-changed', () => { addonNames = null })

/** The installed addons' names ({ 'a-<key>': name }), loaded once. */
export function loadAddonNames() {
  if (!addonNames) {
    addonNames = Promise.resolve(api.onlineProviders?.())
      .then(list => Object.fromEntries((Array.isArray(list) ? list : []).filter(p => isAddonProvider(p?.id)).map(p => [p.id, p.label])))
      .catch(() => ({}))
  }
  return addonNames
}

/** "YouTube", "SoundCloud", an addon's name, "Soulseek", "Web"; null for the music folder's own files. */
export function downloadSourceLabel(source, names = {}) {
  if (!source) return null
  if (source === 'mobile') return 'Mobile'
  return DOWNLOAD_SOURCE_LABELS[source] || (isAddonProvider(source) ? (names[source] || 'Addon') : null)
}

/** Can the player play it: a file, or a ghost that can be streamed. */
export function isPlayable(track) {
  return !!track && (!isGhostTrack(track) || isStreamed(track))
}

/** Cover to show for a track: its artwork file, or an online song's remote cover. */
export function trackArtURL(track) {
  if (!track) return null
  if (track.artwork_path) return api.isElectron ? 'file://' + track.artwork_path : api.artworkURL(track.id)
  return track.artwork_url || null
}

/** The cover for a large surface; generated thumbnails resolve to the original when possible. */
export function trackFullArtURL(track) {
  if (!track) return null
  if (!track.artwork_path) return track.artwork_url || null
  if (/\.webp$/i.test(String(track.artwork_path))) return api.fullArtworkURL(track.id)
  return api.isElectron ? 'file://' + track.artwork_path : api.artworkURL(track.id, true)
}

/** Where the player gets the audio: the file, or the stream of an online song; null if neither. */
export function audioSrcFor(track) {
  if (!track?.file_path) return null
  const ref = streamRef(track)
  if (ref) return api.onlineStreamURL(ref.provider, ref.id)
  if (isGhostTrack(track)) return null
  return api.isElectron
    ? `file://${track.file_path.replace(/\\/g, '/').split('/').map(s => encodeURIComponent(s)).join('/').replace(/%3A/g, ':')}`
    : api.streamURL(track)
}

/** The URL the downloader fetches a streamed song from. */
export function downloadUrlFor(track) {
  const ref = streamRef(track)
  if (!ref || isAddonProvider(ref.provider)) return null // addons: resolved when saving
  if (ref.provider === 'mono') return /^\d{15,20}$/.test(ref.id) ? `https://tracks.monochrome.st/track/${ref.id}` : null
  return ref.provider === 'sc' ? `https://api.soundcloud.com/tracks/${ref.id}` : `https://music.youtube.com/watch?v=${ref.id}`
}

/** Rebuild a download URL for a local file that was downloaded from a known source. */
export function missingTrackDownloadUrl(track) {
  const match = String(track?.source_ref || '').match(/^(yt|sc|mono):(.+)$/)
  if (match?.[1] === 'mono') return /^\d{15,20}$/.test(match[2]) ? `https://tracks.monochrome.st/track/${match[2]}` : null
  if (match) return match[1] === 'sc'
    ? `https://api.soundcloud.com/tracks/${match[2]}`
    : `https://music.youtube.com/watch?v=${match[2]}`
  return null
}

export function missingTrackCanRedownload(track) {
  return !!missingTrackDownloadUrl(track) || /^a-[0-9a-f]{10}:.+$/i.test(String(track?.source_ref || ''))
}

/**
 * Save a streamed song to the library with the usual downloader. Once the
 * file is in, it takes the ghost track's place in playlists, likes and history.
 */
export async function saveToLibrary(track, extra = {}) {
  const isCurrent = downloadBatchCurrent(extra.isCurrent)
  if (!isCurrent()) return { cancelled: true }
  const ref = streamRef(track)
  let url = downloadUrlFor(track)
  if (ref && isAddonProvider(ref.provider)) {
    if (extra.downloadAtmos === true || extra.addonQuality) {
      // A selected Mornye quality must reach the extension's *download*
      // method, not an already resolved playback/stream URL.
      url = 'lokal-addon://' + ref.provider + '/' + encodeURIComponent(ref.id)
    } else {
      const got = await api.onlineDownloadUrl(ref.provider, ref.id)
      if (!got?.url) return { error: got?.error || 'The addon gave no download link' }
      url = got.url
    }
  }
  if (!url) return { error: 'Not a streamed song' }
  if (!isCurrent()) return { cancelled: true }
  return api.downloadYT(url, {
    title: [track.artist, track.title].filter(Boolean).join(' - ') || undefined,
    thumbnail: track.artwork_url || undefined,
    from: ref && isAddonProvider(ref.provider) ? 'Addon' : 'Streaming',
    replaceTrackId: extra.replaceTrackId || (isGhostTrack(track) ? track.id : undefined),
    upgradeTrackId: extra.upgradeTrackId,
    allowUpgradeDurationMismatch: extra.allowUpgradeDurationMismatch === true,
    // Songs of an imported playlist the file takes the place of (ghostDownloads.js).
    ...(extra.replaceImported?.length ? { replaceImported: extra.replaceImported } : {}),
    ...(extra.manuallySelectedImported?.length ? { manuallySelectedImported: extra.manuallySelectedImported } : {}),
    ...(extra.confirmedImported?.length ? { confirmedImported: extra.confirmedImported } : {}),
    // An addon's link expires: the downloader asks the addon for a fresh one
    // each time the job starts (queued, restarted or retried).
    addonSource: ref && isAddonProvider(ref.provider) ? { provider: ref.provider, id: ref.id } : undefined,
    ...(ref && isAddonProvider(ref.provider) &&
      (extra.downloadAtmos === true || extra.addonQuality) ? {
      addonQuality: extra.downloadAtmos === true
        ? 'DOLBY_ATMOS' : extra.addonQuality,
      explicitAtmosDownload: extra.downloadAtmos === true,
    } : {}),
    // Monochrome also serves bare FLAC URLs without embedded song tags.
    // Preserve the catalogue title, artist, album and cover as real file tags.
    // An addon's file is a bare audio link, without tags: name and tag it
    // from what the addon said (only where the file has nothing).
    tags: extra.tags || extra.replaceImported?.length
      ? {
          title: extra.tags?.title || track.title || undefined,
          artist: extra.tags?.artist || track.artist || undefined,
          album: extra.tags?.album || track.album || undefined,
          cover: ref && (isAddonProvider(ref.provider) || ref.provider === 'mono')
            ? (extra.tags?.cover || (/^https:\/\//.test(String(track.artwork_url || '')) ? track.artwork_url : undefined))
            : undefined,
          // Addon metadata may include details the playlist ghost did not have.
          ...(ref && isAddonProvider(ref.provider) ? {
            year: extra.tags?.year || track.year || undefined,
            track: extra.tags?.track || track.track_num || undefined,
            disc: extra.tags?.disc || track.disc_num || undefined,
            isrc: extra.tags?.isrc || track.isrc || undefined,
            genre: extra.tags?.genre || track.genre || undefined,
          } : {}),
        }
      : (ref && (isAddonProvider(ref.provider) || ref.provider === 'mono')
          ? {
              title: track.title || undefined, artist: track.artist || undefined, album: track.album || undefined,
              cover: /^https:\/\//.test(String(track.artwork_url || '')) ? track.artwork_url : undefined,
              year: track.year || undefined, track: track.track_num || undefined, disc: track.disc_num || undefined,
              isrc: track.isrc || undefined, genre: track.genre || undefined,
            }
          : undefined),
    expectedDuration: Number(extra.expectedDuration) > 0 ? Number(extra.expectedDuration) : undefined,
  })
}

/** Queue unique streamed songs, keeping local files and failed downloads separate. */
export async function saveTracksToLibrary(tracks, { isCurrent = () => true, onProgress, save = saveToLibrary, addonQuality } = {}) {
  isCurrent = downloadBatchCurrent(isCurrent)
  const result = { started: 0, existing: 0, failed: 0 }
  const seen = new Set()
  // This measures tracks processed for the download queue, NOT bytes
  // downloaded in the background (tracked by the download manager).
  const queued = new Set((tracks || []).map(track => sourceRefKey(streamRef(track)) || track?.id).filter(Boolean))
  const total = queued.size
  let completed = 0
  const report = message => onProgress?.(message, total > 1
    ? { completed, total, percent: Math.floor(completed / total * 100) } : undefined)
  let refresh = false
  for (const track of tracks || []) {
    if (!isCurrent()) break
    const key = sourceRefKey(streamRef(track)) || track?.id
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (track.file_path && !isGhostTrack(track)) {
      result.existing++
      completed++
      report('Queuing downloads…')
      continue
    }
    report(`Queuing download of “${track.title}”…`)
    const response = await save(track, { isCurrent, addonQuality }).catch(error => ({ error: error.message }))
    if (response?.cancelled) break
    if (response?.alreadyInLibrary) { result.existing++; refresh = true }
    else if (response?.error) result.failed++
    else result.started++
    completed++
    report('Queuing downloads…')
  }
  if (refresh && typeof window !== 'undefined') window.dispatchEvent(new Event('lokal:refresh'))
  return result
}

export function libraryDownloadMessage({ started, existing, failed }) {
  return [started && `Started ${started} download${started === 1 ? '' : 's'}`, existing && `${existing} already in your library`, failed && `${failed} unavailable`].filter(Boolean).join('; ') || 'No songs to download.'
}
