// Playlist page: link the playlist to one on Spotify, Tidal, Apple Music, YouTube Music or
// Qobuz, then "Sync" adds what was added there since (src/playlistSync.js).

import { useTranslation } from '../i18n'
import React, { useEffect, useState } from 'react'
import { Link2, Loader2, RefreshCw, Unlink } from 'lucide-react'
import Modal from './Modal'
import { api } from '../api'
import { syncPlaylist } from '../playlistSync'
import { showLoadingToast } from './Toaster'

function ago(time, t) {
  if (!time) return t('never synced')
  const minutes = Math.round((Date.now() - time) / 60000)
  if (minutes < 1) return t('Synced just now')
  if (minutes < 60) return t('Synced {count} min ago', { count: minutes })
  const hours = Math.round(minutes / 60)
  return hours < 24 ? t('Synced {count} h ago', { count: hours }) : t('Synced {date}', { date: new Date(time).toLocaleDateString() })
}

export default function PlaylistSyncButton({ playlistId, userId, className = '', buttonClassName = '' }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState(null)
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = () => Promise.resolve(api.playlistSyncStatus(playlistId)).then(setStatus).catch(() => setStatus(null))
  useEffect(() => { setStatus(null); refresh() }, [playlistId]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!api.isElectron || !status || status.unsupported) return null

  const sync = async () => {
    setBusy(true); setError('')
    const toast = showLoadingToast(t('Syncing with {platform}…', { platform: status.platformLabel }))
    let message = ''
    try {
      const result = await syncPlaylist(playlistId, { userId, onProgress: (text, progress) => toast.update(text, progress?.percent) })
      message = result.error || result.message
      if (result.error) setError(result.error)
    } catch (e) {
      message = t(e?.message || 'Sync failed')
      setError(message)
    } finally {
      toast.close(message)
      setBusy(false)
      refresh()
    }
  }
  const link = async () => {
    setBusy(true); setError('')
    const result = await api.playlistSyncLink(playlistId, url.trim()).catch(e => ({ error: e.message }))
    setBusy(false)
    if (result?.error) { setError(result.error); return }
    setStatus(result); setOpen(false); setUrl('')
    sync()
  }
  const unlink = async () => {
    await api.playlistSyncUnlink(playlistId).catch(() => {})
    setOpen(false); refresh()
  }

  // With `buttonClassName`: icon buttons (the playlist toolbar), the details in their tooltips.
  const pill = 'flex items-center gap-2 px-5 py-2.5 bg-elevated border border-border text-white/80 rounded-full font-medium text-sm hover:text-white hover:border-accent/30 transition-colors disabled:opacity-40'
  const syncTitle = t('Sync with {platform}{title} · {ago}. Adds songs added there since the last sync; nothing is removed.', { platform: status.platformLabel, title: status.title ? ` · ${status.title}` : '', ago: ago(status.syncedAt, t) })
  const linkTitle = t('Link to a playlist on Spotify, Tidal, Apple Music, Qobuz, Deezer or YouTube Music')
  return <>
    {buttonClassName
      ? <>
          {status.linked && <button type="button" onClick={sync} disabled={busy} title={syncTitle} aria-label={t('Sync with {platform}', { platform: status.platformLabel })} className={buttonClassName}><RefreshCw size={17} className={busy ? 'animate-spin' : ''} /></button>}
          <button type="button" onClick={() => setOpen(true)} title={status.linked ? t('Linked playlist settings') : linkTitle} aria-label={status.linked ? t('Linked playlist settings') : t('Link playlist')} className={buttonClassName}><Link2 size={17} /></button>
        </>
      : <>
          {status.linked
            ? <button onClick={sync} disabled={busy} title={syncTitle} className={`${pill} ${className}`}>
                <RefreshCw size={15} className={busy ? 'animate-spin' : ''} />{t('Sync')}<span className="text-xs font-normal text-muted">{status.platformLabel} · {ago(status.syncedAt, t)}</span>
              </button>
            : <button onClick={() => setOpen(true)} title={linkTitle} className={`${pill} ${className}`}><Link2 size={15} />{t("Link playlist")}</button>}
          {status.linked && <button onClick={() => setOpen(true)} title={t("Linked playlist settings")} aria-label={t("Linked playlist settings")} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-elevated text-muted hover:text-white"><Link2 size={15} /></button>}
        </>}
    <Modal open={open} onClose={() => setOpen(false)} title={status.linked ? t('Linked playlist') : t('Link a streaming playlist')}>
      <div className="space-y-4 px-5 pb-5 pt-4 sm:px-6">
        {status.linked ? <>
          <p className="text-sm text-text">{status.title || status.platformLabel}</p>
          <p className="break-all text-xs text-muted">{status.url}</p>
          <p className="text-xs leading-relaxed text-muted">{t('Sync adds the songs added to it since the last sync and downloads them from your sources. Songs removed there stay here.')} {ago(status.syncedAt, t)}.</p>
          {status.error && <p className="text-xs text-red">{status.error}</p>}
          <button onClick={unlink} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted hover:text-red"><Unlink size={13} />{t("Unlink")}</button>
        </> : <>
          <p className="text-xs leading-relaxed text-muted">{t('Paste the link of a playlist on Spotify, Tidal, Apple Music, Qobuz, Deezer or YouTube Music (yours or anyone’s). Each sync adds new songs, then downloads them through your sources. Removals are never synced. Connect Spotify in Settings → Integrations to read its full playlist, or install the Spotify Web addon. YouTube Music and Deezer work as is; Tidal, Apple Music and Qobuz need their matching addon. Use Download missing songs to retry songs already in the playlist.')}</p>
          <input autoFocus value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && url.trim() && link()} placeholder={t('Paste playlist link')} spellCheck={false}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs text-text outline-none focus:border-accent/50" />
          {error && <p className="text-xs text-red">{error}</p>}
          <button onClick={link} disabled={busy || !url.trim()} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-[rgb(var(--bg-rgb))] disabled:opacity-40">{busy && <Loader2 size={12} className="animate-spin" />}{t('Link and sync')}</button>
        </>}
      </div>
    </Modal>
  </>
}
