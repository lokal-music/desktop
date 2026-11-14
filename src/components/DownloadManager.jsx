// Download manager, after BitChord's: the Downloads button in the window
// header turns into a ring showing the whole batch's progress, and stays so
// until you've seen how it ended. It opens a panel with every download, where
// each can be cancelled, retried or cleared, and the playlists downloaded so
// far (to download again for what's new, or remove). The panel drops down
// from the button and grows inwards (away from the window's edge), so the
// Settings button next to it, nearer the edge, stays in reach. Downloads
// start from Search.

import { useTranslation } from '../i18n'
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, X, RotateCcw, AlertCircle, Info, Disc3, Library, ChevronDown, Mic2, Trash2, Square, Search, Download, Clapperboard, CalendarDays, UserRound, ScanSearch, Play, Tags, Blocks, ShieldAlert, Loader2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useDownloads, batchOf, isActive, startDownloadSync } from '../store/downloads'
import { useSearchStore } from '../store/search'
import { usePlayerStore } from '../store/player'
import { api, peekSettings } from '../api'
import { peekCache, writeCache } from '../pageCache'
import { displayTitle } from '../downloadLinks'
import { plural } from '../plural'
import { explainDownloadError } from '../downloadErrors'
import { ago, useReleaseCheck } from './ReleasesPanel'
import { cancelVideoIndex, startVideoIndex, useVideoIndex } from '../videoIndex'
import { useLibraryJobs, startLyricsIndex, cancelLyricsIndex, startGenres, readGenresStatus } from '../libraryJobs'
import { useDiscoveryArtists, loadDiscoveryArtists } from '../discoveryArtists'

// ------------------------------------------------------------------ ring

export function ProgressRing({ value = 0, size = 18, stroke = 2.25, settled = false, failed = false }) {
  const { t } = useTranslation()
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, value))
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={failed && settled ? 'rgb(248,113,113)' : 'currentColor'}
        strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 300ms ease' }}
      />
    </svg>
  )
}

/**
 * The header's Downloads button: a download icon, or while there's a batch,
 * its progress ring with how many are left (a check or "!" once it's over).
 */
export function DownloadsButton() {
  const { t } = useTranslation()
  const jobs = useDownloads(s => s.jobs)
  const panelOpen = useDownloads(s => s.panelOpen)
  const togglePanel = useDownloads(s => s.togglePanel)
  useEffect(() => { startDownloadSync() }, [])
  const { batch, active, failed, progress, settled } = batchOf(jobs)
  const label = !batch.length ? t('Downloads')
    : settled
      ? failed.length ? t('Downloads: {count} failed', { count: failed.length }) : t('Downloads finished')
      : t('Downloads: {count} in progress', { count: active.length })
  return (
    <button
      type="button"
      data-downloads-toggle
      data-tour="downloader"
      onClick={togglePanel}
      title={label}
      aria-label={label}
      aria-expanded={panelOpen}
      aria-haspopup="dialog"
      className={`relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-colors ${panelOpen ? 'bg-accent/15 text-accent' : batch.length ? (settled && failed.length ? 'text-red-400 hover:bg-elevated' : 'text-accent hover:bg-elevated') : 'text-muted hover:bg-elevated hover:text-text'}`}
    >
      {batch.length ? (
        <>
          <ProgressRing value={settled ? 100 : progress} size={20} settled={settled} failed={failed.length > 0} />
          <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold leading-none">
            {settled ? (failed.length ? '!' : <Check size={10} strokeWidth={3.5} />) : active.length}
          </span>
        </>
      ) : <Download size={15} />}
    </button>
  )
}

// ------------------------------------------------------------------ rows

function statusText(job, t) {
  switch (job.status) {
    case 'queued': return t(job.retryAt ? job.message || 'Retrying soon' : job.message && job.message !== 'Queued' ? job.message : 'Queued')
    case 'downloading': return t(job.message || 'Downloading...')
    case 'done': return t(job.message || 'Saved')
    case 'error': return t(explainDownloadError(job.error).summary)
    case 'cancelled': return t('Cancelled')
    case 'incomplete': return t('Stopped before finishing')
    default: return t(job.status)
  }
}

function Artwork({ job, size = 40 }) {
  const { t } = useTranslation()
  const [broken, setBroken] = useState(false)
  const Icon = job.kind === 'music-video' ? Clapperboard : job.kind === 'playlist' ? Library : Disc3
  const width = job.kind === 'music-video' ? Math.round(size * 16 / 9) : size
  if (job.thumbnail && !broken) {
    return (
      <div className="relative flex-shrink-0 overflow-hidden rounded-lg bg-black/30" style={{ width, height: size }}>
        <img src={job.thumbnail} alt="" onError={() => setBroken(true)} className="h-full w-full object-cover" />
      </div>
    )
  }
  return (
    <div className="flex flex-shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/25" style={{ width, height: size }}>
      <Icon size={size * 0.42} className="text-muted" />
    </div>
  )
}

/** Plays what a finished download added to the library, in download order. */
async function playDownloaded(job) {
  const ids = (job.indexedTracks || []).map(track => track?.id).filter(Boolean)
  if (!ids.length) return
  const answer = await api.getTracks({ ids }).catch(() => null)
  const rows = Array.isArray(answer) ? answer : answer?.tracks || []
  const byId = new Map(rows.map(track => [track.id, track]))
  const tracks = ids.map(id => byId.get(id)).filter(Boolean)
  if (tracks.length) usePlayerStore.getState().playQueue(tracks, 0)
}

export function DownloadRow({ job, detailed = false }) {
  const { t } = useTranslation()
  const { cancel, retry, remove } = useDownloads.getState()
  const [open, setOpen] = useState(false)
  const active = isActive(job)
  const canRetry = job.status === 'error' || job.status === 'cancelled' || job.status === 'incomplete'
  const files = (job.downloadedTracks || []).filter(t => !/\.webm$/i.test(t))
  // A failed download: its cause in plain words, the whole message on demand.
  const failure = job.status === 'error' ? explainDownloadError(job.error) : null
  const [why, setWhy] = useState(false)
  const tone = job.status === 'error' ? 'text-red-400' : job.status === 'done' ? 'text-green-400' : job.status === 'cancelled' || job.status === 'incomplete' ? 'text-yellow-300' : 'text-muted'

  return (
    <div className={`group rounded-xl ${detailed ? 'border border-border bg-black/15 p-3' : 'px-2 py-2 hover:bg-white/[0.04]'}`}>
      <div className="flex items-center gap-3">
        <Artwork job={job} size={detailed ? 44 : 38} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-white">{job.title}</p>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px]">
            {job.status === 'done' && <Check size={11} className="flex-shrink-0 text-green-400" />}
            {job.status === 'error' && <AlertCircle size={11} className="flex-shrink-0 text-red-400" />}
            <span className={`truncate ${tone}`} title={failure?.detail ? t(failure.detail) : undefined}>{statusText(job, t)}</span>
            {job.status === 'downloading' && job.speed ? <span className="flex-shrink-0 text-subtle">· {job.speed}</span> : null}
          </p>
          {job.from ? <p className="mt-0.5 truncate text-[10.5px] uppercase tracking-[0.14em] text-subtle">{t('from {source}', { source: job.from })}</p> : null}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {job.status === 'downloading' && <span className="w-9 text-right text-[11px] tabular-nums text-muted">{Math.round(job.progress || 0)}%</span>}
          {job.status === 'done' && job.indexedTracks?.length > 0 && (
            <button onClick={() => playDownloaded(job)} title={t(job.indexedTracks.length > 1 ? 'Play them' : 'Play')} aria-label={t('Play')}
              className="rounded-lg p-1.5 text-muted transition-colors hover:bg-white/10 hover:text-accent"><Play size={13} fill="currentColor" /></button>
          )}
          {job.lyricsCount > 0 && !active && (
            <span title={t('Lyrics added to {count} files', { count: job.lyricsCount })} className="text-accent/80"><Mic2 size={12} /></span>
          )}
          {failure?.detail && (
            <button onClick={() => setWhy(o => !o)} title={t(why ? 'Hide the details' : 'What went wrong')} aria-expanded={why}
              className="rounded-lg p-1.5 text-muted transition-colors hover:bg-white/10 hover:text-white"><Info size={13} /></button>
          )}
          {canRetry && (
            <button onClick={() => retry(job.id)} title={t("Retry")} className="rounded-lg p-1.5 text-muted transition-colors hover:bg-white/10 hover:text-white"><RotateCcw size={13} /></button>
          )}
          {active ? (
            <button onClick={() => cancel(job.id)} title={t("Cancel")} className="rounded-lg p-1.5 text-muted transition-colors hover:bg-white/10 hover:text-white"><Square size={11} fill="currentColor" /></button>
          ) : (
            <button onClick={() => remove(job.id)} title={t("Remove from list")} className="rounded-lg p-1.5 text-subtle transition-colors hover:bg-white/10 hover:text-white"><X size={13} /></button>
          )}
          {detailed && (files.length > 0 || job.output) && (
            <button onClick={() => setOpen(o => !o)} title={t("Details")} className="rounded-lg p-1.5 text-subtle transition-colors hover:bg-white/10 hover:text-white">
              <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {why && failure?.detail && (
        <p className="mt-2 max-h-32 select-text overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-red-400/20 bg-red-500/5 p-2 text-[11px] leading-relaxed text-muted">{t(failure.detail.split(/\s+\|\s+|;\s+/).join('\n'))}</p>
      )}

      {active && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
          <motion.div
            className={`h-full rounded-full ${job.status === 'queued' ? 'bg-white/25' : 'bg-accent'}`}
            initial={false}
            animate={{ width: job.status === 'queued' ? '100%' : `${Math.max(3, job.progress || 0)}%`, opacity: job.status === 'queued' ? 0.35 : 1 }}
            transition={{ duration: 0.3 }}
          />
        </div>
      )}

      {detailed && open && (
        <div className="mt-3 space-y-2">
          {job.totalTracks ? <p className="text-xs text-muted">{t('{current} / {total} tracks', { current: Math.min(job.currentTrack || 0, job.totalTracks), total: job.totalTracks })}</p> : null}
          {files.length > 0 && (
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border bg-black/15 p-2">
              {files.map((file, i) => (
                <p key={`${file}-${i}`} className="truncate text-xs text-muted"><span className="mr-1 text-accent/70">{i + 1}.</span>{file}</p>
              ))}
            </div>
          )}
          {job.output && (
            <details>
              <summary className="cursor-pointer text-xs text-muted">{t("Log")}</summary>
              <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-black/20 p-2 text-[11px] text-muted">{job.output}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

export function DownloadList({ jobs, detailed = false, empty = null }) {
  const { t } = useTranslation()
  if (!jobs.length) return empty
  return (
    <div className={detailed ? 'space-y-2' : 'space-y-0.5'}>
      {jobs.map(job => <DownloadRow key={job.id} job={job} detailed={detailed} />)}
    </div>
  )
}

// ------------------------------------------------------------------ panel

/** The playlists downloaded so far: download again (for what's new) or remove. */
function DownloadedPlaylists() {
  const { t } = useTranslation()
  const jobs = useDownloads(s => s.jobs)
  const [list, setList] = useState(() => peekCache('dl:playlists') || [])
  const [loaded, setLoaded] = useState(() => peekCache('dl:playlists') !== undefined)
  const [confirming, setConfirming] = useState(null) // a playlist's id, asked "Remove?"
  const [problem, setProblem] = useState('') // why the last download again / remove failed
  const load = () => Promise.resolve(api.getDownloadedPlaylists())
    .then(response => {
      if (!Array.isArray(response)) return
      writeCache('dl:playlists', response)
      setList(response)
    })
    .catch(() => {})
    .finally(() => setLoaded(true))
  useEffect(() => { load() }, [])

  // Both answer { error } or throw when they fail: say so.
  const attempt = (call) => Promise.resolve().then(call).then(result => result?.error || null, e => e?.message || 'Something went wrong')
  const redownload = async (id) => {
    setProblem('')
    const failed = await attempt(() => api.redownloadPlaylist(id))
    if (failed) setProblem(`Couldn't download it again: ${failed}`)
    useDownloads.getState().load()
    load()
  }
  const remove = async (id) => {
    setConfirming(null)
    setProblem('')
    setList(current => current.filter(playlist => playlist.id !== id))
    const failed = await attempt(() => api.deleteDownloadedPlaylist(id))
    // Reloading brings it back when it wasn't removed.
    if (failed) setProblem(`Couldn't remove it: ${failed}`)
    load()
  }
  const problemLine = problem ? <p role="alert" className="px-2 pb-1 text-[11px] text-red-400">{problem}</p> : null

  if (!list.length) {
    return <>{problemLine}<p className="px-3 py-8 text-center text-xs text-muted">{loaded ? t('No playlists downloaded yet. Search for one, or paste its link.') : t('Loading…')}</p></>
  }
  return (
    <div className="space-y-0.5">
      {problemLine}
      {list.map(playlist => {
        const downloading = jobs.some(job => isActive(job) && job.kind === 'playlist' && (job.playlistId === playlist.id || (playlist.url && job.url === playlist.url)))
        const title = displayTitle(playlist, 'Playlist')
        return (
          <div key={playlist.id} className="group flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/[0.04]">
            <div className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/25">
              <Library size={16} className="text-muted" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-white" title={playlist.url || title}>{title}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted">{plural(playlist.downloaded_count, 'track')}{playlist.status ? ` · ${playlist.status}` : ''}</p>
            </div>
            {confirming === playlist.id ? (
              <div className="flex flex-shrink-0 items-center gap-1">
                <button onClick={() => remove(playlist.id)} className="rounded-lg bg-red-500/15 px-2 py-1 text-[11px] font-semibold text-red-300 transition-colors hover:bg-red-500/25">{t("Remove")}</button>
                <button onClick={() => setConfirming(null)} className="rounded-lg px-2 py-1 text-[11px] text-muted transition-colors hover:text-white">{t("Keep")}</button>
              </div>
            ) : (
              <div className="flex flex-shrink-0 items-center gap-1">
                <button onClick={() => redownload(playlist.id)} disabled={downloading}
                  title={downloading ? t('Downloading') : t('Download again (gets what was added since)')}
                  aria-label={`Download ${title} again`}
                  className="rounded-lg p-1.5 text-muted transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40">
                  <RotateCcw size={13} className={downloading ? 'animate-spin' : ''} />
                </button>
                <button onClick={() => setConfirming(playlist.id)} title={t("Remove from this list")} aria-label={`Remove ${title}`}
                  className="rounded-lg p-1.5 text-subtle transition-colors hover:bg-white/10 hover:text-red-300">
                  <Trash2 size={13} />
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** A job running outside the download queue: its progress, or how it last ended, and a button to run it. */
function TaskRow({ icon: Icon, label, running, done = 0, total = 0, detail, onStop, onOpen, onRun, runLabel = 'Run', runDisabled = false, runTitle }) {
  const { t } = useTranslation()
  const [starting, setStarting] = useState(false)
  const run = async () => {
    if (starting) return
    setStarting(true)
    try { await onRun() } finally { setStarting(false) }
  }
  const percent = total ? Math.min(100, (done / total) * 100) : 0
  return (
    <div className="group flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/[0.04]">
      <div className={`flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-lg border bg-black/25 ${running ? 'border-accent/40' : 'border-white/10'}`}>
        <Icon size={16} className={running ? 'text-accent' : 'text-muted'} />
      </div>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <p className="truncate text-[13px] font-semibold text-white">{label}</p>
        {running ? (
          <>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
              <div className={`h-full bg-accent transition-[width] duration-300 ${total ? '' : 'w-1/3 animate-pulse'}`} style={total ? { width: `${percent}%` } : undefined} />
            </div>
            <p className="mt-1 truncate text-[11px] tabular-nums text-muted" title={detail}>{total ? `${done}/${total}` : t('Starting…')}{detail ? ` · ${detail}` : ''}</p>
          </>
        ) : <p className="mt-0.5 truncate text-[11px] text-muted" title={detail}>{detail || t('Not running')}</p>}
      </button>
      {running && onStop && (
        <button onClick={onStop} title={t("Stop")} aria-label={`Stop ${label.toLowerCase()}`}
          className="flex-shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-white/10 hover:text-white">
          <Square size={12} />
        </button>
      )}
      {!running && onRun && (
        <button onClick={run} disabled={runDisabled || starting} title={runTitle || `${runLabel}: ${label}`} aria-label={`${runLabel} ${label.toLowerCase()}`}
          className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-default disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:text-muted">
          {starting ? <span className="h-2.5 w-2.5 animate-spin rounded-full border border-accent/30 border-t-accent" /> : <Play size={10} fill="currentColor" />}
          {runLabel}
        </button>
      )}
    </div>
  )
}

// Artists > Refresh artist info runs in the main process (or the server):
// followed while the panel is open, every second while it runs.
function useArtistRefreshStatus(enabled) {
  const [status, setStatus] = useState(null)
  // Bumped when the job is started here: the status is read again at once.
  const [kick, setKick] = useState(0)
  useEffect(() => {
    if (!enabled) return undefined
    let timer = null
    let cancelled = false
    const tick = async () => {
      const next = await Promise.resolve(api.artistsRefreshAllStatus()).catch(() => null)
      if (cancelled) return
      if (next && !next.error) setStatus(next)
      timer = setTimeout(tick, next?.running ? 1000 : 4000)
    }
    tick()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [enabled, kick])
  const cancel = async () => {
    const next = await Promise.resolve(api.artistsRefreshAllCancel()).catch(() => null)
    if (next && !next.error) setStatus(next)
  }
  // With the source chosen in Settings (Artists → Refresh artist info uses the same).
  const start = async () => {
    const next = await Promise.resolve(api.artistsRefreshAllMetadata({ source: peekSettings()?.artist_metadata_source || 'either' })).catch(() => null)
    if (next && !next.error) setStatus(next)
    setKick(value => value + 1)
  }
  return [status, cancel, start]
}

/** Addons needing attention: mirrors the warning state shown in Settings → Addons. */
function AddonsTab({ addons, loading, error, onNavigate }) {
  const { t } = useTranslation()
  const [busyKey, setBusyKey] = useState(null)
  const [messages, setMessages] = useState({})
  const [verificationUrls, setVerificationUrls] = useState({})

  const openSettings = addon => onNavigate('/settings', { state: { category: 'addons', addon: addon.key } })
  const verify = async addon => {
    setBusyKey(addon.key)
    setMessages(current => ({ ...current, [addon.key]: '' }))
    try {
      const result = await api.addonsPackages({ action: 'package.verify', key: addon.key })
      if (result?.error) throw new Error(result.error)
      if (result?.opened) {
        setVerificationUrls(current => ({ ...current, [addon.key]: '' }))
        setMessages(current => ({ ...current, [addon.key]: t('Complete the verification in the window that opened. Access is checked when it closes.') }))
      } else if (result?.authenticated) {
        setVerificationUrls(current => ({ ...current, [addon.key]: '' }))
        setMessages(current => ({ ...current, [addon.key]: t('Access verified.') }))
        window.dispatchEvent(new Event('lokal:addons-changed'))
      } else if (result?.open_auth_url && /^https:\/\//i.test(result.open_auth_url)) {
        // On the web, show the returned verification URL as a direct action.
        // Opening Settings first would add an unnecessary navigation step.
        setVerificationUrls(current => ({ ...current, [addon.key]: result.open_auth_url }))
        setMessages(current => ({ ...current, [addon.key]: t('Open the verification page to continue.') }))
      } else {
        setMessages(current => ({ ...current, [addon.key]: t(result?.error || "Verification wasn't completed. Try again when you're ready.") }))
      }
    } catch (e) {
      setMessages(current => ({ ...current, [addon.key]: t(e?.message || 'Could not verify addon access.') }))
    } finally {
      setBusyKey(current => current === addon.key ? null : current)
      window.dispatchEvent(new Event('lokal:addons-changed'))
    }
  }

  const warningText = addon => {
    const missing = addon.access?.missing || []
    if (missing.length) return t('Needs {capabilities}', { capabilities: missing.map(item => t(item)).join(', ') })
    if (addon.access?.kind === 'login') return t('Needs login before this addon can stream or download.')
    if (addon.access?.kind === 'verification') return t('Needs verification before this addon can stream or download.')
    return t('Required addon settings are missing.')
  }
  // Match Settings → Addons: an unverified signed session gets a direct
  // Verify action even if other required capabilities are also missing.
  const verificationAvailable = addon => addon.signedSession && !addon.access?.verified

  return (
    <div className="space-y-2">
      {error && <p role="alert" className="rounded-lg border border-red/20 bg-red/5 px-3 py-2 text-xs text-red">{t('Could not load addon status')}: {t(error)}</p>}
      {loading && addons.length === 0 && (
        <p className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{t('Checking addon status…')}</p>
      )}
      {!loading && !error && addons.length === 0 && (
        <p className="px-3 py-8 text-center text-xs text-muted">{t('No addons need attention.')}</p>
      )}
      {addons.map(addon => (
        <div key={addon.key} className="flex items-start gap-3 rounded-xl border border-yellow-500/25 bg-yellow-500/[0.06] p-3">
          <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded-lg bg-elevated">
            {addon.icon
              ? <img src={addon.icon} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
              : <div className="flex h-full w-full items-center justify-center text-muted"><Blocks size={16} /></div>}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-text">{addon.name}</p>
            <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-yellow-200/90">
              <ShieldAlert size={12} className="mt-0.5 flex-shrink-0" />
              <span>{warningText(addon)}</span>
            </p>
            {messages[addon.key] && <p role="status" className="mt-1 text-[11px] leading-relaxed text-muted">{messages[addon.key]}</p>}
          </div>
          <div className="flex flex-shrink-0 flex-col items-end gap-2">
            {verificationAvailable(addon) ? (
              <>
                <button disabled={busyKey !== null} onClick={() => verify(addon)}
                  className="rounded-lg bg-yellow-500/20 px-2.5 py-1.5 text-[11px] font-medium text-yellow-100 transition-colors hover:bg-yellow-500/30 disabled:opacity-50">
                  {busyKey === addon.key ? <Loader2 size={12} className="inline animate-spin" /> : null} {t('Verify access')}
                </button>
                {verificationUrls[addon.key] && (
                  <button onClick={() => api.openExternal(verificationUrls[addon.key])}
                    className="max-w-28 text-right text-[10px] text-yellow-100 underline-offset-2 hover:underline">
                    {t('Open verification page')}
                  </button>
                )}
              </>
            ) : (
              <button onClick={() => openSettings(addon)}
                className="rounded-lg bg-accent/15 px-2.5 py-1.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/25">
                {t('Fix settings')}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}


/** The panel's Others tab: library jobs that aren't downloads, then the downloaded playlists. */
function OthersTab({ artists, cancelArtists, startArtists, onNavigate }) {
  const { t } = useTranslation()
  const releases = useReleaseCheck(s => s.checking)
  const releasesCheckedAt = useReleaseCheck(s => s.saved?.checkedAt)
  const stopReleases = useReleaseCheck(s => s.stop)
  const videos = useVideoIndex(s => s.progress)
  const lyrics = useLibraryJobs(s => s.lyrics)
  const genres = useLibraryJobs(s => s.genres)
  const followed = useDiscoveryArtists(s => s.followed)
  const followedLoaded = useDiscoveryArtists(s => s.loaded)
  useEffect(() => {
    if (!followedLoaded) loadDiscoveryArtists().catch(() => {})
    readGenresStatus()
  }, [followedLoaded])
  const checkReleases = () => useReleaseCheck.getState().start([...followed.values()].map(name => ({ name })))

  const lyricsDetail = lyrics?.running
    ? `${plural(lyrics.found || 0, 'lyric')} found${lyrics.title ? ` · ${lyrics.title}` : ''}`
    : lyrics ? `${lyrics.cancelled ? 'Stopped' : 'Done'} · lyrics for ${lyrics.found || 0} of ${plural(lyrics.done || 0, 'song')}` : 'Keeps every song\'s lyrics, so they open at once'
  const genresDetail = genres?.error ? genres.error
    : genres?.running ? `${plural(genres.updated || 0, 'song')} filled in`
      : genres?.total ? `Done · ${genres.updated || 0} of ${plural(genres.songs || 0, 'song')} filled in`
        : genres?.started ? 'Every song already has a genre' : 'Looks up a genre for songs with none'

  const artistsDetail = artists?.running
    ? `${plural(artists.bios || 0, 'bio')}, ${plural(artists.images || 0, 'picture')}${artists.failed ? ` · ${artists.failed} failed` : ''}`
    : artists?.finishedAt ? `${artists.done < artists.total ? 'Stopped' : 'Done'} ${ago(artists.finishedAt)} · ${plural(artists.bios || 0, 'bio')}, ${plural(artists.images || 0, 'picture')} updated` : ''
  const videosDetail = videos?.running
    ? `${plural(videos.found || 0, 'video')} found${videos.title ? ` · ${videos.title}` : ''}`
    : videos ? `${videos.cancelled ? 'Stopped' : 'Done'} · ${plural(videos.found || 0, 'video')} found for ${plural(videos.total || 0, 'song')}` : ''



  return (
    <div className="space-y-3">
      <section>
        <p className="px-2 pb-1 pt-1 text-[10px] font-display uppercase tracking-[0.2em] text-subtle">{t("Library jobs")}</p>
        <div className="space-y-0.5">
          <TaskRow icon={CalendarDays} label={t("Artist releases")} running={!!releases} done={releases?.done} total={releases?.total}
            detail={releases ? 'Checking for new releases' : releasesCheckedAt ? `Checked ${ago(releasesCheckedAt)}` : 'Not checked yet'}
            onStop={stopReleases} onOpen={() => onNavigate('/home/releases')}
            onRun={checkReleases} runLabel="Check" runDisabled={!followed.size} runTitle={followed.size ? `Check ${plural(followed.size, 'followed artist')} for new releases` : 'Follow artists first (Home → Releases)'} />
          <TaskRow icon={UserRound} label={t("Artist info")} running={!!artists?.running} done={artists?.done} total={artists?.total}
            detail={artistsDetail} onStop={cancelArtists} onOpen={() => onNavigate('/artists')}
            onRun={startArtists} runLabel="Refresh" runTitle="Refresh every artist's bio and picture" />
          {api.isElectron && (
            <TaskRow icon={ScanSearch} label={t("Music videos")} running={!!videos?.running} done={videos?.done} total={videos?.total}
              detail={videosDetail} onStop={cancelVideoIndex} onOpen={() => onNavigate('/videos')}
              onRun={startVideoIndex} runLabel="Find" runTitle="Find the music video of every library song" />
          )}
          {api.isElectron && (
            <TaskRow icon={Mic2} label={t("Lyrics")} running={!!lyrics?.running} done={lyrics?.done} total={lyrics?.total}
              detail={lyricsDetail} onStop={cancelLyricsIndex} onOpen={() => onNavigate('/settings', { state: { category: 'library' } })}
              onRun={startLyricsIndex} runLabel="Index" runTitle="Fetch and keep the lyrics of every library song" />
          )}
          <TaskRow icon={Tags} label={t("Genres")} running={!!genres?.running} done={genres?.done} total={genres?.total}
            detail={genresDetail} onOpen={() => onNavigate('/settings', { state: { category: 'library' } })}
            onRun={startGenres} runLabel="Fill in" runTitle="Look up a genre for every song that has none" />
        </div>
      </section>
      <section>
        <p className="px-2 pb-1 text-[10px] font-display uppercase tracking-[0.2em] text-subtle">{t("Downloaded playlists")}</p>
        <DownloadedPlaylists />
      </section>
    </div>
  )
}

// What opens the panel: the header's Downloads button.
const OPENERS = '[data-downloads-toggle]'
const PANEL_WIDTH = 380

export function DownloadManagerPanel() {
  const { t } = useTranslation()
  const panelOpen = useDownloads(s => s.panelOpen)
  const jobs = useDownloads(s => s.jobs)
  const { closePanel, cancelAll, clearFinished } = useDownloads.getState()
  const requestFocus = useSearchStore(s => s.requestFocus)
  const nav = useNavigate()
  const [anchor, setAnchor] = useState({ top: 44, left: 12, width: PANEL_WIDTH, origin: 'top left' })
  const [tab, setTab] = useState('queue')
  const [addonWarnings, setAddonWarnings] = useState([])
  const [addonsLoaded, setAddonsLoaded] = useState(false)
  const [addonsError, setAddonsError] = useState('')
  const releaseCheck = useReleaseCheck(s => !!s.checking)
  const videoIndex = useVideoIndex(s => !!s.progress?.running)
  const [artistRefresh, cancelArtistRefresh, startArtistRefresh] = useArtistRefreshStatus(panelOpen)
  const lyricsIndex = useLibraryJobs(s => !!s.lyrics?.running)
  const genresJob = useLibraryJobs(s => !!s.genres?.running)
  const panelRef = useRef(null)

  // Match Settings → Addons' warning condition exactly. A provider only
  // appears here while enabled and still missing access verification, login,
  // or required configuration. Refresh as soon as auth/settings change.
  useEffect(() => {
    if (!panelOpen) return undefined
    let current = true
    const loadWarnings = async () => {
      try {
        const list = await Promise.resolve(api.addonsList?.())
        if (!current) return
        if (!Array.isArray(list)) throw new Error(list?.error || 'No addon status returned')
        setAddonWarnings(list.filter(addon => addon?.enabled && addon?.access && !addon.access.ready))
        setAddonsError('')
        setAddonsLoaded(true)
      } catch (e) {
        if (!current) return
        setAddonsError(e?.message || 'Could not load addon status')
        setAddonsLoaded(true)
      }
    }
    const onChanged = () => { loadWarnings() }
    loadWarnings()
    window.addEventListener('lokal:addons-changed', onChanged)
    const unsubscribe = api.onAddonAuthChanged?.(onChanged)
    return () => {
      current = false
      window.removeEventListener('lokal:addons-changed', onChanged)
      unsubscribe?.()
    }
  }, [panelOpen])

  // Under the button, growing inwards: from a button on the left of the
  // window its left edge lines up with the button's (it grows rightwards),
  // from one on the right its right edge does. Either way it never covers the
  // Settings button, which sits between it and the edge.
  useLayoutEffect(() => {
    if (!panelOpen) return undefined
    const place = () => {
      const rect = document.querySelector(OPENERS)?.getBoundingClientRect()
      if (!rect) return
      // Narrower than the panel (the web app on a phone): it narrows to fit.
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 24)
      const fromLeft = rect.left + rect.width / 2 < window.innerWidth / 2
      const wanted = fromLeft ? rect.left : rect.right - width
      setAnchor({ top: rect.bottom + 8, width, origin: fromLeft ? 'top left' : 'top right', left: Math.max(12, Math.min(wanted, window.innerWidth - width - 12)) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [panelOpen])

  useEffect(() => {
    if (!panelOpen) return
    const onKey = (e) => { if (e.key === 'Escape') closePanel() }
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target)) return
      if (e.target.closest?.(OPENERS)) return
      closePanel()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown) }
  }, [panelOpen, closePanel])

  const active = jobs.filter(isActive)
  const othersRunning = (releaseCheck ? 1 : 0) + (videoIndex ? 1 : 0) + (artistRefresh?.running ? 1 : 0) + (lyricsIndex ? 1 : 0) + (genresJob ? 1 : 0)
  const finished = jobs.filter(j => !isActive(j))

  const findMore = () => {
    closePanel()
    nav('/search')
    requestFocus()
  }

  return createPortal(
    <AnimatePresence>
      {panelOpen && (
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-label={t("Downloads")}
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.98 }}
          transition={{ duration: 0.16 }}
          style={{ top: anchor.top, left: anchor.left, width: anchor.width, maxHeight: `min(440px, calc(100vh - ${anchor.top + 12}px))`, transformOrigin: anchor.origin, backgroundColor: 'rgba(var(--surface-rgb), 0.97)' }}
          className="fixed z-[80] flex flex-col overflow-hidden rounded-2xl border border-border shadow-[0_24px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl"
        >
          {/* Tabs and queue actions need separate rows: their combined min-content
              width exceeds the 380px popover (especially with translations or
              display scaling), otherwise Addons / Cancel all / Clear overlap. */}
          <div data-download-panel-header className="flex min-w-0 flex-col gap-2 border-b border-border px-3 py-2.5">
            <div role="tablist" aria-label={t("Downloads")} className="flex w-full min-w-0 items-center gap-1 overflow-x-auto">
              {[
                ['queue', 'Queue', active.length],
                ['others', 'Others', othersRunning],
                ['addons', 'Addons', addonsLoaded ? addonWarnings.length : 0],
              ].map(([id, label, count]) => (
                <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                  className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-display uppercase tracking-[0.16em] transition-colors ${tab === id ? 'bg-accent/15 text-accent' : 'text-muted hover:text-white'}`}>
                  {t(label)}
                  {count > 0 && (
                    <span className={`rounded-full px-1.5 text-[10px] tracking-normal tabular-nums ${id === 'addons' ? 'bg-yellow-500/20 text-yellow-200' : 'bg-accent/20 text-accent'}`}>{count}</span>
                  )}
                </button>
              ))}
            </div>
            {tab === 'queue' && (active.length > 0 || finished.length > 0) && (
              <div data-download-panel-actions className="flex w-full flex-wrap items-center justify-end gap-x-4 gap-y-1">
                {active.length > 0 && (
                  <button onClick={cancelAll} className="shrink-0 whitespace-nowrap text-[11px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-white">{t("Cancel all")}</button>
                )}
                {finished.length > 0 && (
                  <button onClick={clearFinished} className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-white"><Trash2 size={11} />{t("Clear")}</button>
                )}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {tab === 'queue' ? (
              <DownloadList jobs={jobs} empty={<p className="px-3 py-8 text-center text-xs text-muted">{t("Nothing downloading.")}</p>} />
            ) : tab === 'others' ? (
              <OthersTab artists={artistRefresh} cancelArtists={cancelArtistRefresh} startArtists={startArtistRefresh} onNavigate={(path, options) => { closePanel(); nav(path, options) }} />
            ) : (
              <AddonsTab addons={addonWarnings} loading={!addonsLoaded} error={addonsError}
                onNavigate={(path, options) => { closePanel(); nav(path, options) }} />
            )}
          </div>
          <button
            onClick={findMore}
            className="flex items-center gap-2 border-t border-border px-4 py-2.5 text-left text-[11px] uppercase tracking-[0.18em] text-accent transition-colors hover:bg-white/[0.04]"
          >
            <Search size={12} /> {t('Find music to download')}
          </button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
