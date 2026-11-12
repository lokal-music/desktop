import React, { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Download, ListMusic, Play, RefreshCw } from 'lucide-react'
import { api } from '../api'
import TrackList from '../components/TrackList'
import { playRecommendationPool } from '../recommendationPlayback'
import { resolveRecommendationTracks } from '../recommendations'
import { showLoadingToast } from '../components/Toaster'
import { downloadMissingProviderTracks, ghostDownloadMessage } from '../ghostDownloads'

/** Read-only provider playlist detail, resolved using Lokal's
 * configured local and online playback sources, not Spotify audio streams. */
export default function SpotifyPlaylist({ provider = 'spotify' }) {
  const { id } = useParams()
  const [playlist, setPlaylist] = useState({ title: '', tracks: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const downloadingRef = useRef(false)
  const forceNext = useRef(false)
  const loadedKey = useRef('')
  const youtube = provider === 'youtube'
  const label = youtube ? 'YouTube Music' : 'Spotify'
  const valid = youtube ? /^[A-Za-z0-9_.-]{1,120}$/.test(id || '') : /^[A-Za-z0-9]{22}$/.test(id || '')

  useEffect(() => {
    if (!valid) { setError(`Invalid ${label} playlist.`); setLoading(false); return }
    let active = true
    const key = `${provider}:${id}`
    if (loadedKey.current !== key) {
      setPlaylist({ title: '', tracks: [] })
      loadedKey.current = key
    }
    setLoading(true)
    setError('')
    const load = async (force = false) => {
      try {
        const result = youtube ? await api.youtubeLibraryPlaylistTracks(id, force)
          : await api.spotifyLibraryPlaylistTracks(`spotify:playlist:${id}`, force)
        if (!active) return
        if (result?.tracks) setPlaylist({
          title: result?.title || `${label} playlist`,
          total: result.total ?? result.count,
          tracks: result.tracks.map((row, i) => ({
            ...row, id: youtube ? (row.spotifyUri || row.videoId || row.id || `${provider}-row:${id}:${i}`)
              : `${row.spotifyUri || row.videoId || row.id || `${provider}-row:${id}:${i}`}:${i}`,
            artist: row.artist || row.author || '',
            artwork_url: row.artwork_url || row.thumbnail || '',
          })),
        })
        setError(result?.error || '')
        // A cached view paints first. If the user enabled daily updates,
        // quietly refresh outdated content after it is already available.
        if (!force && result?.refreshDue) void load(true)
      } catch (err) {
        if (active) setError(err.message || 'Could not load this playlist.')
      } finally { if (active) setLoading(false) }
    }
    const force = forceNext.current
    forceNext.current = false
    void load(force)
    return () => { active = false }
  }, [id, revision, valid, youtube, provider, label])

  const context = { type: 'discovery', name: playlist.title || `${label} playlist` }
  const playAll = async () => {
    if (!playlist.tracks.length) return
    const toast = showLoadingToast(`Preparing ${label} playlist…`)
    try {
      const started = await playRecommendationPool(playlist.tracks, {
        firstPlayable: true, context, returnAfterStart: true,
        onProgress: message => toast.update(message),
      })
      toast.close(started === false ? 'No playable matches were found.' : '')
    } catch (err) { toast.close(err.message || 'Could not start this playlist.') }
  }
  const downloadMissing = async () => {
    if (downloadingRef.current) return
    downloadingRef.current = true
    setDownloading(true)
    const toast = showLoadingToast('Finding songs to download…')
    try {
      const result = await downloadMissingProviderTracks(playlist.tracks, {
        onProgress: (message, progress) => toast.update(message, progress),
      })
      toast.close(ghostDownloadMessage(result))
    } catch (error) { toast.close(error.message || 'Could not download the missing songs.') }
    finally { downloadingRef.current = false; setDownloading(false) }
  }
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 pb-12">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <ListMusic size={28} className="shrink-0 text-accent" />
          <div className="min-w-0">
            <p className="text-xs font-display uppercase tracking-widest text-muted">{label} playlist</p>
            <h1 className="truncate text-2xl font-semibold text-white">{playlist.title || `${label} playlist`}</h1>
            {!loading && !error && <p className="text-xs text-muted">{playlist.tracks.length} songs available{playlist.total > playlist.tracks.length ? ` · ${playlist.total - playlist.tracks.length} entries unavailable from ${label}` : ''} · Played through Lokal sources</p>}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" disabled={loading || downloading || !playlist.tracks.length} onClick={downloadMissing}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-white disabled:opacity-50">
            <Download size={15} /> {downloading ? 'Preparing downloads…' : 'Download missing songs'}
          </button>
          <button type="button" disabled={loading} onClick={() => { forceNext.current = true; setRevision(n => n + 1) }}
            className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated hover:text-white disabled:opacity-50"
            aria-label={`Update ${label} playlist`} title="Refresh"><RefreshCw size={17} /></button>
          <button type="button" disabled={loading || !playlist.tracks.length} onClick={playAll}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-base disabled:opacity-50">
            <Play size={15} fill="currentColor" /> Play all
          </button>
        </div>
      </div>
      {error && playlist.tracks.length > 0 && <p className="text-xs text-muted" role="status">Update failed: {error}. Showing the saved playlist.</p>}
      {loading && !playlist.tracks.length ? <p className="py-10 text-center text-sm text-muted">Loading playlist…</p>
        : error && !playlist.tracks.length ? <p className="py-10 text-center text-sm text-muted" role="alert">{error}</p>
        : playlist.tracks.length
          ? <TrackList tracks={playlist.tracks} resolveTracks={(rows, options) => resolveRecommendationTracks(rows, api, options)} context={context} reduceMotion />
          : <p className="py-10 text-center text-sm text-muted">This playlist has no available songs.</p>}
    </div>
  )
}
