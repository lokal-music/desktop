import React, { useEffect, useState } from 'react'
import { Music } from 'lucide-react'
import { api } from '../api'
import { playlistArtworkCandidates } from '../playlistArtwork.mjs'

const artSrc = path => {
  if (api.isElectron) {
    const normalized = path.replace(/\\/g, '/')
    return 'file://' + (normalized.startsWith('/') ? '' : '/') + normalized
  }
  return api.artworkURL(path.split(/[\\/]/).pop().replace(/\.(?:jpe?g|webp|png)$/i, ''))
}

// Shared between sidebar, player and playlist page. The 2×2 tile follows
// mobile: four distinct covers, or a single full-size cover when fewer exist.
export default function PlaylistCover({
  playlistId, coverPath = null, size = 48, className = '',
  tracks = null, hero = false, revision = 0,
}) {
  const [artworks, setArtworks] = useState([])
  const [eventRevision, setEventRevision] = useState(0)

  useEffect(() => {
    const changed = event => {
      const updatedId = event?.detail?.playlistId
      if (!updatedId || String(updatedId) === String(playlistId)) {
        setEventRevision(current => current + 1)
      }
    }
    window.addEventListener('lokal:playlist-updated', changed)
    window.addEventListener('lokal:playlists-changed', changed)
    return () => {
      window.removeEventListener('lokal:playlist-updated', changed)
      window.removeEventListener('lokal:playlists-changed', changed)
    }
  }, [playlistId])

  useEffect(() => {
    let cancelled = false
    if (coverPath || !playlistId || playlistId === 'liked') {
      setArtworks([])
      return
    }
    Promise.resolve(tracks || api.getPlaylistTracks(playlistId))
      .then(rows => {
        if (cancelled) return
        const choices = playlistArtworkCandidates(rows, hero ? 12 : 4)
        setArtworks(choices.map(art => art.isLocal ? artSrc(art.source) : art.source))
      })
      .catch(() => { if (!cancelled) setArtworks([]) })
    return () => { cancelled = true }
  }, [playlistId, coverPath, tracks, hero, eventRevision])

  const coverSrc = coverPath
    ? (api.isElectron ? artSrc(coverPath) : api.playlistCoverURL(playlistId)) +
      '?v=' + encodeURIComponent(String(revision) + '-' + String(eventRevision))
    : null

  if (hero) {
    const source = coverSrc || null
    return (
      <div className={'relative w-full h-full overflow-hidden pointer-events-none ' + className}>
        {source ? (
          <img src={source} alt="" aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover opacity-65" />
        ) : artworks.length ? (
          <div className="absolute -inset-[35%] rotate-[-15deg] grid grid-cols-4 gap-3">
            {Array.from({ length: 16 }, (_, index) => (
              <img key={index} src={artworks[index % artworks.length]} alt="" aria-hidden="true"
                className="w-full h-full object-cover rounded-lg aspect-square" />
            ))}
          </div>
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-r from-[rgb(var(--bg-rgb))] via-[rgb(var(--bg-rgb))]/85 to-[rgb(var(--bg-rgb))]/30" />
        <div className="absolute inset-0 bg-gradient-to-t from-[rgb(var(--bg-rgb))] via-transparent to-transparent" />
      </div>
    )
  }

  const shell = 'rounded-lg overflow-hidden flex-shrink-0 ' + className
  if (coverSrc) {
    return (
      <div className={shell} style={{ width: size, height: size }}>
        <img src={coverSrc} alt="" className="w-full h-full object-cover" />
      </div>
    )
  }
  if (!artworks.length) {
    return (
      <div className={shell + ' bg-elevated flex items-center justify-center text-subtle'}
        style={{ width: size, height: size }}>
        <Music size={size * 0.4} />
      </div>
    )
  }
  if (artworks.length < 4) {
    return (
      <div className={shell} style={{ width: size, height: size }}>
        <img src={artworks[0]} alt="" className="w-full h-full object-cover" />
      </div>
    )
  }
  return (
    <div className={shell + ' grid grid-cols-2 grid-rows-2'}
      style={{ width: size, height: size }}>
      {artworks.slice(0, 4).map((src, index) => (
        <img key={src + index} src={src} alt=""
          className="w-full h-full object-cover min-h-0 min-w-0" />
      ))}
    </div>
  )
}
