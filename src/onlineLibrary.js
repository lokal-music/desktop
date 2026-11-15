// Catalogue releases saved to Albums without downloading their recordings.
// Keep this distinct from library tracks and playlists. Settings are shared by
// Electron and the web client; failed writes never change the visible library.
import { create } from 'zustand'
import { api } from './api'

const part = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
export const onlineReleaseKey = album => `${part(album?.title || album?.album)}|${part(album?.artist || album?.album_artist || album?.artists)}`

export function normalizeOnlineRelease(album) {
  const title = String(album?.title || album?.album || '').trim()
  const artist = String(album?.artist || album?.album_artist || album?.artists || '').trim()
  if (!title || !artist || title.length > 500 || artist.length > 500) return null
  return {
    title, artist,
    artwork_url: String(album?.artwork_url || album?.artwork || '').slice(0, 2000),
    albumId: String(album?.albumId || '').slice(0, 300),
    provider: String(album?.provider || '').slice(0, 100),
    sourceAlbumId: String(album?.sourceAlbumId || '').slice(0, 300),
    release_type: String(album?.release_type || 'album'),
    track_count: Number(album?.track_count) || 0,
    year: Number(album?.year) || null,
  }
}

export function parseSavedOnlineAlbums(value) {
  try {
    const rows = JSON.parse(value || '[]')
    const saved = new Map()
    if (!Array.isArray(rows)) return saved
    for (const item of rows) {
      const release = normalizeOnlineRelease(item)
      if (release) saved.set(onlineReleaseKey(release), release)
    }
    return saved
  } catch { return new Map() }
}

export const useSavedOnlineAlbums = create(() => ({ saved: new Map(), loaded: false }))
let loading = null
let writes = Promise.resolve()

export function loadSavedOnlineAlbums() {
  if (useSavedOnlineAlbums.getState().loaded) return Promise.resolve()
  if (!loading) loading = api.getSettings().then(settings => {
    if (settings?.error) throw new Error(settings.error)
    useSavedOnlineAlbums.setState({ saved: parseSavedOnlineAlbums(settings?.saved_online_albums), loaded: true })
  }).finally(() => { loading = null })
  return loading
}

export function setOnlineAlbumSaved(album, shouldSave) {
  const release = normalizeOnlineRelease(album)
  if (!release) return Promise.reject(new Error('Missing album title or artist.'))
  const work = writes.catch(() => {}).then(async () => {
    await loadSavedOnlineAlbums()
    const next = new Map(useSavedOnlineAlbums.getState().saved)
    const key = onlineReleaseKey(release)
    if (shouldSave) next.set(key, { ...next.get(key), ...release })
    else next.delete(key)
    const result = await api.saveSettings({ saved_online_albums: JSON.stringify([...next.values()]) })
    if (result?.error) throw new Error(result.error)
    useSavedOnlineAlbums.setState({ saved: next })
  })
  writes = work
  return work
}
