// A playlist's ghost songs (imported entries with no file yet): pick one,
// assign a library copy or download a match that replaces it. The dialog
// keeps one size whatever the lists hold; reloading the playlist (a download
// finishing, a refresh) doesn't search again or blank what's shown; and each
// song shows its download's progress.

import { useTranslation } from '../i18n'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, AlertTriangle, Check, Download, Loader2, Search } from 'lucide-react'
import Modal from './Modal'
import HoverScrollTitle from './HoverScrollTitle'
import { showLoadingToast } from './Toaster'
import { useGhostDownloadSources } from './useGhostDownloadSources'
import { useGhostDurationConfirmation } from './useGhostDurationConfirmation'
import { api } from '../api'
import { useDownloads, isActive } from '../store/downloads'
import { downloadGhostSongs, ghostDownloadMessage, downloadGhostResult as queueGhostResult, ghostDownloadSuggestions } from '../ghostDownloads'

export const ghostKey = track => String(track?.playlist_track_id || track?.added_at || track?.id || '')
const RESULT_ROWS = 6

/** The download replacing a ghost song: the running one, or the last one. */
function jobFor(jobs, ghostId) {
  const mine = jobs.filter(job => (job.replaces || []).includes(String(ghostId)))
  return mine.find(isActive) || mine.sort((a, b) => (b.finishedAt || b.createdAt || 0) - (a.finishedAt || a.createdAt || 0))[0] || null
}

function JobChip({ job }) {
  const { t } = useTranslation()
  if (!job) return null
  if (job.status === 'queued') return <span className="inline-flex items-center gap-1 text-[10px] text-muted"><Loader2 size={10} className="animate-spin" />{t("Queued")}</span>
  if (isActive(job)) return <span className="inline-flex items-center gap-1 text-[10px] tabular-nums text-accent"><Loader2 size={10} className="animate-spin" />{Math.round(job.progress || 0)}%</span>
  if (job.status === 'error') return <span className="inline-flex items-center gap-1 text-[10px] text-red" title={job.error || ''}><AlertTriangle size={10} />{t("Failed")}</span>
  return null
}

// A fixed number of rows, so a short list is as tall as a full one.
function ResultList({ loading, stale, items, empty, render }) {
  const { t } = useTranslation()
  if (loading && !items.length) {
    return Array.from({ length: RESULT_ROWS }, (_, index) => (
      <div key={index} className="flex h-14 items-center gap-3 px-4">
        <div className="min-w-0 flex-1 space-y-1.5"><div className="h-3 w-2/3 animate-pulse rounded bg-white/[0.06]" /><div className="h-2.5 w-1/3 animate-pulse rounded bg-white/[0.04]" /></div>
      </div>
    ))
  }
  if (!items.length) return <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted">{empty}</div>
  return <div className={`divide-y divide-border transition-opacity ${stale ? 'opacity-50' : ''}`}>{items.map(render)}</div>
}

export default function GhostSongsModal({ open, onClose, ghostTracks, playlistId, onChanged }) {
  const { t } = useTranslation()
  const { confirmDuration, durationChoice, isCurrent } = useGhostDurationConfirmation(open)
  const { source, sourceChoice } = useGhostDownloadSources(open)
  const jobs = useDownloads(s => s.jobs)
  const [selectedKey, setSelectedKey] = useState(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState({ key: null, local: [], online: [] })
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [startingId, setStartingId] = useState('')
  const [downloadingAll, setDownloadingAll] = useState(false)
  const [matchingAll, setMatchingAll] = useState(false)
  const sequence = useRef(0)
  const order = useRef([])

  const selected = ghostTracks.find(track => ghostKey(track) === selectedKey) || null
  // The selected song by its key: a reload hands over new objects for the
  // same songs, which mustn't count as picking another one.
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  // Keep a song selected. When the selected one is resolved (it leaves the
  // list), the one that took its place is selected, not the first.
  useEffect(() => {
    const keys = ghostTracks.map(ghostKey)
    if (!keys.length) { setSelectedKey(null); order.current = keys; return }
    if (!selectedKey || !keys.includes(selectedKey)) {
      const was = order.current.indexOf(selectedKey)
      setSelectedKey(keys[Math.max(0, Math.min(was, keys.length - 1))] || keys[0])
    }
    order.current = keys
  }, [ghostTracks, selectedKey])

  const search = useCallback(async (track, override = '') => {
    const title = String(track?.title || '').trim()
    // Online, the artist goes with the title: "Thinking of You" alone finds
    // every song called that (Katy Perry, Sister Sledge...) before Salasa's.
    const fallback = [track?.artist, title].map(part => String(part || '').trim()).filter(Boolean).join(' ')
    const text = String(override || fallback).trim()
    const run = ++sequence.current
    const key = ghostKey(track)
    if (!track || !text || !source) return
    setQuery(text)
    setLoading(true)
    setStatus('')
    // Another song: start from empty rows; the same one searched again keeps
    // its results (dimmed) until the new ones are in.
    setResults(current => current.key === key ? current : { key, local: [], online: [] })
    try {
      const [localResult, onlineResult] = await Promise.all([
        // Local copies may be tagged differently: the title finds them.
        api.searchTracks(override ? text : title || text),
        ghostDownloadSuggestions(text, source),
      ])
      if (run !== sequence.current) return
      const localRows = Array.isArray(localResult?.tracks) ? localResult.tracks : Array.isArray(localResult) ? localResult : []
      const onlineRows = Array.isArray(onlineResult?.results) ? onlineResult.results : Array.isArray(onlineResult) ? onlineResult : []
      setResults({ key, local: localRows.filter(item => !String(item.file_path || '').startsWith('ghost://')).slice(0, 8), online: onlineRows.slice(0, 8) })
    } catch (e) {
      if (run !== sequence.current) return
      setResults({ key, local: [], online: [] })
      setStatus('Search failed: ' + e.message)
    } finally {
      if (run === sequence.current) setLoading(false)
    }
  }, [source])

  // Searches when another song is picked (or the source changes), not when
  // the playlist reloads.
  useEffect(() => {
    if (!open || !selectedKey) { setQuery(''); setStatus(''); setLoading(false); return undefined }
    search(selectedRef.current)
    return () => { sequence.current++ }
  }, [open, selectedKey, search])

  const assign = async (ghost, item) => {
    setStatus(t("Assigning…"))
    try {
      const result = await api.resolveGhostTrack(ghost.id, item.id, { dedupePlaylist: true })
      if (result?.error) { setStatus('Assign failed: ' + result.error); return }
      setStatus(`Assigned "${item.title}".`)
      onChanged?.()
      window.dispatchEvent(new Event('lokal:refresh'))
      window.dispatchEvent(new CustomEvent('lokal:playlist-updated', { detail: { playlistId } }))
    } catch (e) { setStatus('Assign failed: ' + e.message) }
  }

  const download = async (ghost, item) => {
    const itemKey = String(item.id || item.url)
    setStartingId(itemKey)
    setStatus('')
    try {
      const result = await queueGhostResult(ghost, item, { confirmDuration, isCurrent })
      if (result?.cancelled) return
      if (result?.error) { setStatus('Download failed: ' + result.error); return }
      useDownloads.getState().load?.()
      if (result?.alreadyInLibrary) { setStatus(t("Replaced with your library copy.")); onChanged?.() }
    } catch (e) { setStatus('Download failed: ' + e.message) }
    finally { setStartingId('') }
  }

  const matchAllInLibrary = async () => {
    if (matchingAll || !ghostTracks.length || typeof api.findOwnedTracks !== 'function') return
    setMatchingAll(true)
    setStatus(t('Matching against your library…'))
    try {
      const owned = await api.findOwnedTracks(ghostTracks)
      let matched = 0
      for (let i = 0; i < ghostTracks.length; i++) {
        const target = owned?.[i]
        if (!target?.id) continue
        const res = await api.resolveGhostTrack(ghostTracks[i].id, target.id, { requireMetadataMatch: true, dedupePlaylist: true }).catch(() => null)
        if (res?.ok) matched++
      }
      if (matched > 0) {
        onChanged?.()
        window.dispatchEvent(new Event('lokal:refresh'))
        window.dispatchEvent(new CustomEvent('lokal:playlist-updated', { detail: { playlistId } }))
        setStatus(`Matched ${matched} ${matched === 1 ? 'song' : 'songs'} from your library.`)
      } else {
        setStatus(t('No automatic library matches found. Assign individual songs below.'))
      }
    } catch (e) {
      setStatus('Library match failed: ' + e.message)
    } finally {
      setMatchingAll(false)
    }
  }

  const downloadAll = async () => {
    if (downloadingAll || !ghostTracks.length) return
    setDownloadingAll(true)
    const toast = showLoadingToast('Finding the songs not in your library…')
    try {
      const result = await downloadGhostSongs(ghostTracks, { confirmDuration, isCurrent, onProgress: message => toast.update(message) })
      toast.close(ghostDownloadMessage(result))
      useDownloads.getState().load?.()
      if (result.existing) onChanged?.()
    } catch {
      toast.close("Couldn't download the playlist's songs.")
    } finally { setDownloadingAll(false) }
  }

  const jobsById = useMemo(() => new Map(ghostTracks.map(track => [track.id, jobFor(jobs, track.id)])), [ghostTracks, jobs])
  const selectedJob = selected ? jobsById.get(selected.id) : null
  const downloading = selectedJob && isActive(selectedJob)
  const shown = selected && results.key === ghostKey(selected) ? results : { local: [], online: [] }
  const stale = loading && shown.local.length + shown.online.length > 0

  return (
    <Modal open={open} onClose={onClose} title={t("Ghost Songs")} width="max-w-5xl">
      {/* One height whatever the lists hold; the lists scroll inside it. */}
      <div className="grid h-[min(38rem,calc(100vh-11rem))] gap-4 md:grid-cols-[260px_1fr]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card/40">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <p className="min-w-0 truncate whitespace-nowrap text-xs font-display uppercase tracking-[0.18em] text-muted">Unresolved · {ghostTracks.length}</p>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={matchAllInLibrary} disabled={matchingAll || !ghostTracks.length}
                title={t("Automatically map every song already in your library")} aria-label={t("Match all in library")}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-xs text-white transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-wait disabled:opacity-50">
                {matchingAll ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {matchingAll ? 'Matching…' : 'Match library'}
              </button>
              <button type="button" onClick={downloadAll} disabled={downloadingAll || !ghostTracks.length}
                title={t("Find and download every unresolved song")} aria-label={t("Download all unresolved songs")}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/15 px-2.5 py-1.5 text-xs text-accent transition-colors hover:bg-accent/25 disabled:cursor-wait disabled:opacity-50">
                {downloadingAll ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} {downloadingAll ? 'Finding…' : 'Download all'}
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
            {ghostTracks.map(track => {
              const key = ghostKey(track)
              const active = key === selectedKey
              return (
                <button key={key} type="button" onClick={() => setSelectedKey(key)}
                  className={`flex w-full items-center gap-2 px-4 py-3 text-left transition-colors ${active ? 'bg-accent/10' : 'hover:bg-elevated'}`}>
                  <span className="min-w-0 flex-1">
                    <HoverScrollTitle title={track.title} className={`text-sm ${active ? 'text-accent' : 'text-white'}`} />
                    <span className="mt-1 block truncate text-xs text-muted">{track.artist}</span>
                  </span>
                  <JobChip job={jobsById.get(track.id)} />
                </button>
              )
            })}
            {!ghostTracks.length && <p className="px-4 py-8 text-center text-sm text-muted">{t("Every song is resolved.")}</p>}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          {durationChoice}
          {selected ? (
            <>
              <div className="rounded-2xl border border-yellow-400/20 bg-yellow-400/5 p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-yellow-400/20 bg-yellow-400/10">
                    <AlertCircle size={18} className="text-yellow-200" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">{selected.title}</p>
                    <p className="mt-1 truncate text-xs text-muted">{selected.artist}{selected.album ? ` · ${selected.album}` : ''}</p>
                  </div>
                </div>
                {/* Always the same height: the download's progress, or what last happened. */}
                <div className="mt-3 h-5">
                  {downloading ? (
                    <div className="flex items-center gap-2 text-[11px] text-muted">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(3, selectedJob.progress || 0)}%` }} /></div>
                      <span className="flex-shrink-0 tabular-nums">{selectedJob.status === 'queued' ? 'Queued' : `Downloading ${Math.round(selectedJob.progress || 0)}%`}</span>
                    </div>
                  ) : selectedJob?.status === 'error' ? (
                    <p className="truncate text-[11px] text-red" title={selectedJob.error || ''}>The last download failed{selectedJob.error ? `: ${selectedJob.error}` : '.'} Pick another match.</p>
                  ) : status ? (
                    <p className="truncate text-[11px] text-muted">{status}</p>
                  ) : (
                    <p className="truncate text-[11px] text-muted">{t("Assign a copy from your library, or download a match: it replaces this entry when it finishes.")}</p>
                  )}
                </div>
              </div>

              <div className="flex gap-2">
                <input value={query} onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') search(selected, e.currentTarget.value) }}
                  placeholder={t("Search manually for a better match")}
                  className="flex-1 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-white outline-none focus:border-accent/50" />
                <button type="button" onClick={() => search(selected, query)}
                  className="flex items-center gap-2 rounded-xl border border-accent/25 bg-accent/15 px-3 py-2.5 text-sm text-accent transition-colors hover:bg-accent/25">
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Search
                </button>
              </div>

              <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
                <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card/30">
                  <div className="flex h-[3.25rem] items-center border-b border-border px-4">
                    <p className="text-xs font-display uppercase tracking-[0.22em] text-muted">{t("Nearest Local Matches")}</p>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <ResultList loading={loading} stale={stale} items={shown.local} empty="No close match in your library."
                      render={item => (
                        <div key={item.id} className="flex h-14 items-center gap-3 px-4">
                          <div className="min-w-0 flex-1">
                            <HoverScrollTitle title={item.title} className="text-sm text-white" />
                            <p className="truncate text-xs text-muted">{item.artist}{item.album ? ` · ${item.album}` : ''}</p>
                          </div>
                          <button type="button" onClick={() => assign(selected, item)}
                            className="rounded-lg border border-accent/25 bg-accent/15 px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent/25">{t("Assign")}</button>
                        </div>
                      )} />
                  </div>
                </div>

                <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card/30">
                  <div className="flex h-[3.25rem] items-center gap-3 border-b border-border px-4">
                    <p className="flex-shrink-0 text-xs font-display uppercase tracking-[0.22em] text-muted">{t("Download")}</p>
                    <div className="min-w-0 flex-1">{sourceChoice}</div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <ResultList loading={loading} stale={stale} items={shown.online} empty="No download suggestion from this source."
                      render={item => {
                        const itemKey = String(item.id || item.url)
                        return (
                          <div key={itemKey} className="flex h-14 items-center gap-3 px-4">
                            <div className="min-w-0 flex-1">
                              <HoverScrollTitle title={item.title} className="text-sm text-white" />
                              <p className="truncate text-xs text-muted">{item.channel || item.artist || item.url}</p>
                            </div>
                            <button type="button" onClick={() => download(selected, item)} disabled={!!startingId || downloading}
                              title={downloading ? 'This song is downloading' : 'Download this; it replaces the playlist entry when it finishes'}
                              className="flex items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/15 px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent/25 disabled:opacity-40">
                              {startingId === itemKey ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Download
                            </button>
                          </div>
                        )
                      }} />
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-2xl border border-border bg-card/30 px-4 text-sm text-muted">
              <Check size={14} className="mr-2 text-accent" />This playlist has no ghost songs left to resolve.
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

