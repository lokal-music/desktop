import { api } from './api.js'
import { isPlayable } from './onlineTracks.js'
import { mapLimited, resolveRecommendationTracks, isAddonVerificationRequiredError } from './recommendations.js'
import { announceTrackMerges } from './mergedTracks.js'

export const isMobileLinkedTrack = track =>
  !!track?.id && (String(track.file_path || '').startsWith('ghost://mobile/') || String(track.file_path || '').startsWith('ghost://link/')) &&
  !!String(track.title || '').trim() && !!String(track.artist || '').trim()

/** Use this PC's sources, then move the synced identity onto the playable row.
 * Provider credentials/URLs from the phone are never used for resolution.
 * All matching and playback resolution use this PC's configured providers.
 * Keep unplayable ordinary imports on their existing manual-resolution path.
 */
export async function resolveMobileLinkedTracks(tracks, client = api, options = {}) {
  const { isCurrent = () => true, resolve = resolveRecommendationTracks } = options
  const replacements = [], verification = []
  try {
    const rows = await mapLimited(tracks || [], async track => {
      if (!isCurrent()) return null
      if (!isMobileLinkedTrack(track)) return isPlayable(track) ? track : null
      const candidate = {
        title: track.title, artist: track.artist, album: track.album,
        duration: track.duration, artwork_url: track.artwork_url,
        isrc: track.isrc, year: track.year, genre: track.genre,
      }
      try {
        const [found] = await resolve([candidate], client, {
          ...options, preserveMatchMetadata: true,
        })
        if (!isCurrent() || !isPlayable(found)) return null
        const linked = await client.resolveGhostTrack(track.id, found.id, {
          resolveMobileStream: true, requireMetadataMatch: true, dedupePlaylist: true,
        })
        if (!linked?.ok) throw new Error(linked?.error || 'Could not link the desktop recording')
        const playable = linked.track || found
        replacements.push({ removedIds: [track.id], track: playable })
        return isCurrent() ? playable : null
      } catch (error) {
        if (isAddonVerificationRequiredError(error)) verification.push(error)
        else if (isCurrent()) options.onProgress?.('Could not resolve “' + track.title + '”.')
        return null
      }
    }, 3)
    if (verification.length) throw verification[0]
    return rows.filter(Boolean)
  } finally {
    // Repair hearts/cached queues even if playback was cancelled after the DB
    // transaction completed. No new playback is started by this notification.
    if (client === api && replacements.length) announceTrackMerges({ replacements })
  }
}
