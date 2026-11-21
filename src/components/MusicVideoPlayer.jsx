import { useTranslation } from '../i18n'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { X, Play, Pause, SkipBack, SkipForward, Mic2, Clapperboard, Expand, Minimize, Download, PictureInPicture2, Captions, PanelRight, Languages, Loader2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { usePlayerStore } from '../store/player'
import LyricsPanel from './LyricsPanel'
import { api, wordSyncEnabled } from '../api'
import { trackArtURL } from '../onlineTracks'
import { useMusicVideo, useMusicVideoView, songTime, useVideoOffsets, withOffset } from '../musicVideo'
import VideoOffsetControl from './VideoOffsetControl'
import { syncVideo, seekVideo, playbackVideoTime } from '../musicVideoPlayback'
import { useLyricLines } from '../lyricLine'
import { useLyricSubline } from '../lyrics/useLyricSubline'
import { isWindowHidden, onWindowVisibility } from '../windowVisibility'
import { usePerformanceMode } from '../performanceMode'
import LyricSubtitles from './LyricSubtitles'

// Further apart than this and the video jumps to the song; closer, it catches
// up by playing a touch faster or slower, which you can't see.
const IDLE_MS = 2600
const EASE = [0.32, 0.72, 0, 1]
const RECOVER_TRIES = 2

const LYRICS_LAYOUT_KEY = 'lokal-video-lyrics-layout' // 'subtitles' | 'side'
const NO_LINES = []

function readLyricsLayout() {
  try { return localStorage.getItem(LYRICS_LAYOUT_KEY) === 'side' ? 'side' : 'subtitles' } catch { return 'subtitles' }
}

/** A round button in the video's controls; `active` while what it turns on is on. */
function ChromeButton({ active, onClick, label, children }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} aria-pressed={!!active}
      className={`w-10 h-10 flex items-center justify-center rounded-full border backdrop-blur-md transition-colors ${active ? 'border-white/30 bg-white/20 text-white' : 'border-white/[0.14] bg-white/[0.08] text-white/90 hover:bg-white/[0.16]'}`}>
      {children}
    </button>
  )
}

function fmt(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

/**
 * The music video, full window, Apple Music style: the cover gives way to the
 * video once it plays, controls fade when the mouse rests, and the synced
 * lyrics can sit over its side. The video is muted and follows the song, so
 * what you hear is still the song itself (lossless, EQ, crossfade...).
 */
export default function MusicVideoPlayer({ compact = false }) {
  const { t } = useTranslation()
  const { open, hide } = useMusicVideoView(useShallow(s => ({ open: compact ? s.mini : s.open, hide: s.hide })))
  const { currentTrack, isPlaying, togglePlay, next, prev, progress, duration } = usePlayerStore(useShallow(s => ({
    currentTrack: s.currentTrack, isPlaying: s.isPlaying, togglePlay: s.togglePlay, next: s.next, prev: s.prev,
    progress: s.progress, duration: s.duration,
  })))
  const { video: foundVideo, loading, progress: lookupProgress, download } = useMusicVideo(currentTrack, open, open)
  const fallbackKey = foundVideo?.clip && foundVideo?.streamed ? JSON.stringify([currentTrack?.id, foundVideo.clip.link, foundVideo.src]) : null
  const [fallback, setFallback] = useState(null)
  const fallbackAttempt = useRef(null)
  const currentFallbackKey = useRef(fallbackKey)
  currentFallbackKey.current = fallbackKey
  const video = useMemo(() => fallbackKey && fallback?.key === fallbackKey && fallback.src
    ? { ...foundVideo, src: fallback.src, streamed: false }
    : foundVideo, [fallback, fallbackKey, foundVideo])
  useEffect(() => {
    fallbackAttempt.current = null
    setFallback(null)
  }, [fallbackKey])
  const reduceMotion = useReducedMotion()
  const videoRef = useRef(null)
  const [ready, setReady] = useState(false)
  // The video has shown at least one frame: never fall back to the cover art
  // again (a seek rebuffers like YouTube -- last frame, not the cover).
  const [everPlayed, setEverPlayed] = useState(false)
  const [failed, setFailed] = useState(false)
  const [errorText, setErrorText] = useState(null)
  const [stalled, setStalled] = useState(false)
  const [slowLoad, setSlowLoad] = useState(false)
  const [screenFull, setScreenFull] = useState(() => !!document.fullscreenElement)
  const screenOwned = useRef(false)
  // The song is at a moment the video doesn't have (past its end).
  const [outside, setOutside] = useState(false)
  const [showLyrics, setShowLyrics] = useState(false)
  // Synced lyrics as subtitles under the picture, or the full lyrics at the
  // side (with their source menu and search: another source, plain lyrics).
  const [lyricsLayout, setLyricsLayout] = useState(readLyricsLayout)
  const switchLyricsLayout = () => setLyricsLayout(layout => {
    const next = layout === 'side' ? 'subtitles' : 'side'
    try { localStorage.setItem(LYRICS_LAYOUT_KEY, next) } catch {}
    return next
  })
  const [autoSynced, setAutoSynced] = useState(false)
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef(null)
  const recoverRef = useRef(0)

  // A new video (or the player reopened): start over. Not when the player
  // only comes back from being hidden behind the mini player (its effects
  // run again then, with the same video still loaded).
  const shownKey = useRef(null)
  useEffect(() => {
    const key = `${video?.videoId}\u0000${video?.src}\u0000${open}`
    if (shownKey.current === key) return
    shownKey.current = key
    setReady(false); setEverPlayed(false); setFailed(false); setErrorText(null)
    setStalled(false); setOutside(false)
    recoverRef.current = 0
  }, [video?.videoId, video?.src, open])
  // Hidden behind the mini player (or closed): the muted picture stops; the
  // sync below starts it again where the song is.
  const lastVideo = useRef(null)
  useEffect(() => () => { try { lastVideo.current?.pause() } catch {} }, [])
  useEffect(() => {
    setSlowLoad(false)
    if (!open || !loading) return undefined
    const timer = setTimeout(() => setSlowLoad(true), 500)
    return () => clearTimeout(timer)
  }, [open, loading, currentTrack?.id])
  useEffect(() => {
    const changed = () => setScreenFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])
  useEffect(() => {
    if (!open && screenOwned.current) {
      screenOwned.current = false
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    }
  }, [open])
  const toggleScreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    else {
      screenOwned.current = true
      document.documentElement.requestFullscreen?.().catch(() => { screenOwned.current = false })
    }
  }
  const toMiniPlayer = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    useMusicVideoView.getState().enterMini()
    if (!usePlayerStore.getState().showMiniPlayer) usePlayerStore.getState().toggleMiniPlayer()
  }
  useEffect(() => { if (!currentTrack) hide() }, [currentTrack, hide])
  useEffect(() => {
    if (open) api.getSettings?.().then(s => setAutoSynced(s?.unsynced_auto_sync === '1')).catch(() => {})
  }, [open])

  const wake = useCallback(() => {
    setIdle(false)
    clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS)
  }, [])
  useEffect(() => {
    if (!open || compact) return undefined
    wake()
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (document.fullscreenElement) { document.exitFullscreen?.().catch(() => {}); e.stopImmediatePropagation(); return }
      // Ours alone: the full screen player under this shouldn't close too.
      e.stopImmediatePropagation()
      e.preventDefault()
      hide()
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(idleTimer.current) }
  }, [open, compact, hide, wake])

  // The automatic sync, moved by the person's correction for this video.
  const videoOffset = useVideoOffsets(state => state.offsets[video?.videoId] || 0)
  const segments = useMemo(() => withOffset(video?.segments, videoOffset), [video?.segments, videoOffset])
  const sync = useCallback(() => {
    const result = syncVideo(videoRef.current, {
      time: songTime(), segments, clip: video?.clip, duration: video?.duration,
      isPlaying: usePlayerStore.getState().isPlaying, hidden: isWindowHidden(),
    })
    if (result) setOutside(result.outside)
  }, [video, segments])

  // Sync immediately on media readiness and play-state changes, with a small
  // periodic drift correction. Buffering the muted picture never pauses music.
  useEffect(() => {
    if (!open || !video?.src) return undefined
    let interval = null
    const updateVisibility = hidden => {
      if (interval !== null) clearInterval(interval)
      interval = null
      sync()
      if (!hidden) interval = setInterval(sync, 200)
    }
    const unsubscribe = onWindowVisibility(updateVisibility)
    updateVisibility(isWindowHidden())
    return () => {
      if (interval !== null) clearInterval(interval)
      unsubscribe()
    }
  }, [open, video?.src, isPlaying, sync])

  const onVideoError = useCallback(() => {
    const el = videoRef.current
    if (el && recoverRef.current < RECOVER_TRIES) {
      recoverRef.current += 1
      setStalled(true)
      try {
        el.load()
        el.addEventListener('loadeddata', () => {
          const target = playbackVideoTime(songTime(), { segments, clip: video?.clip, duration: el.duration })
          if (target != null && target >= 0) el.currentTime = target
          if (usePlayerStore.getState().isPlaying && !isWindowHidden()) el.play().catch(() => {})
        }, { once: true })
        return
      } catch {}
    }
    if (fallbackKey && fallbackAttempt.current !== fallbackKey) {
      fallbackAttempt.current = fallbackKey
      api.clipVideoSource(foundVideo.clip.link, { fallback: true }).then(result => {
        if (currentFallbackKey.current !== fallbackKey) return
        if (result?.src) setFallback({ key: fallbackKey, src: result.src })
        else {
          setFailed(true)
          setStalled(false)
          setErrorText(result?.error || 'Could not stream this clip')
        }
      })
      return
    }
    setFailed(true)
    setStalled(false)
    setErrorText(el?.error?.message || 'Could not open the video')
    // A streamed video: why YouTube stopped giving it (the player itself only
    // sees "data source error"); Lokal remembers the reason.
    if (video?.streamed && video.src) {
      fetch(video.src, { headers: { 'x-lokal-why': String(el?.error?.message || `error ${el?.error?.code ?? '?'}`).replace(/[^\x20-\x7e]/g, '').slice(0, 300) || '1' } })
        .then(res => res.ok ? res.text() : null)
        .then(reason => { if (reason?.trim()) setErrorText(reason.trim().slice(0, 600)) })
        .catch(() => {})
    }
  }, [video, segments, fallbackKey, foundVideo?.clip?.link])

  const art = trackArtURL(currentTrack)
  const showVideo = !!video?.src && !video.error && !failed && (ready || everPlayed) && !outside
  const status = loading ? 'loading'
    : !video ? 'none'
      : video.error ? 'failed'
      // Streamed until it fails; then, as without streaming, downloading plays it.
      : video.needsDownload && (!video.src || failed) ? 'download'
      : failed ? 'failed'
        : outside ? 'outside'
          : ready || everPlayed ? 'playing' : 'loading'
  // Looking for the video (or starting it): only the light sweeping over the
  // cover, no words under it (they pushed the cover up as they came and went).
  // A download you asked for still says how far along it is.
  const loadingText = !loading || !slowLoad ? null
    : lookupProgress?.stage === 'queued' ? t('Music video queued for download')
      : lookupProgress?.stage === 'downloading'
        ? t('Downloading music video{progress}', { progress: Number.isFinite(lookupProgress.percent) ? ` — ${lookupProgress.percent}%` : '' })
        : null
  const message = {
    none: lookupProgress?.message ? t(lookupProgress.message) : t('No verified music video for this song. Continuing with the song and artwork.'),
    failed: video?.error ? t("The music video couldn't be downloaded: {error}", { error: video.error }) : errorText ? t("The music video couldn't be played: {error}", { error: errorText }) : t("The music video couldn't be played"),
    download: video?.streamed && failed ? t("This video couldn't be streamed{error}. Download it to your Videos folder to try it that way. Your song keeps playing.", { error: errorText ? ` (${errorText.replace(/[.\s]+$/, '')})` : '' }) : t('Download this video to your Videos folder to play it. Your song keeps playing.'),
    outside: null,
    loading: loadingText,
  }[status]
  // A streamed video offers Download once it has failed, not while it's still starting.
  const canDownload = !!video?.needsDownload && (!video.src || failed) && !loading && !video.downloadId
  // The cover card never sits over open lyrics; the shade behind them is enough.
  // Synced lyrics show as subtitles under the picture (the mini player's
  // style); plain lyrics, which have no "now", keep the panel at the side.
  const lyric = useLyricLines(currentTrack, open && !compact && showLyrics)
  const subtitles = showLyrics && lyric.synced && lyricsLayout !== 'side'
  const lyricsPanel = showLyrics && lyric.loaded && !subtitles
  // Translation or romanization under the subtitles: the lyrics panel's choice.
  const sub = useLyricSubline({ trackId: subtitles ? currentTrack?.id : null, result: subtitles ? lyric.result : null, lines: subtitles ? lyric.lines : NO_LINES })
  const showCoverCard = !showVideo && !lyricsPanel
  const chromeHidden = idle && showVideo
  const fade = { duration: reduceMotion ? 0 : 0.5, ease: EASE }
  const seek = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    if (duration > 0) seekVideo(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration, {
      state: usePlayerStore.getState(), element: videoRef.current, segments, clip: video?.clip,
    })
  }

  if (compact) return open && currentTrack ? (
    <div className="relative aspect-video w-full overflow-hidden bg-black" aria-label={t('Music video: {title}', { title: currentTrack.title })}>
      {!showVideo && (art ? <img src={art} alt={t("Artwork")} className="absolute inset-0 h-full w-full object-contain" /> : <span className="absolute inset-0 flex items-center justify-center text-muted">♪</span>)}
      {video?.src && !video.error && !failed && <video key={video.src} ref={el => { videoRef.current = el; if (el) lastVideo.current = el }} src={video.src} muted playsInline preload="auto" disablePictureInPicture
        onPlaying={() => { setReady(true); setEverPlayed(true); recoverRef.current = 0 }} onCanPlay={sync} onLoadedMetadata={sync} onLoadedData={() => { setReady(true); sync() }} onSeeked={sync} onError={onVideoError}
        className={`absolute inset-0 h-full w-full object-contain ${showVideo ? '' : 'opacity-0'}`} />}
      {!showVideo && message && <p role="status" className="absolute inset-x-0 bottom-0 bg-black/65 px-3 py-1 text-center text-[10px] text-white/80">{message}</p>}
      {canDownload && !showVideo && <button onClick={download} title={t("Download to your Videos folder")} className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg bg-black/75 px-2 py-1 text-xs text-white"><Download size={13} />{t("Download")}</button>}
    </div>
  ) : null

  return (
    <AnimatePresence>
      {open && currentTrack && (
        <motion.div
          key="music-video"
          role="dialog"
          aria-label={t('Music video: {title}', { title: currentTrack.title })}
          initial={{ opacity: 0, scale: reduceMotion ? 1 : 1.03 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: reduceMotion ? 1 : 1.03 }}
          transition={{ duration: reduceMotion ? 0 : 0.42, ease: EASE }}
          onMouseMove={wake}
          onClick={wake}
          className={`fixed inset-0 z-[70] bg-black overflow-hidden select-none ${chromeHidden ? 'cursor-none' : ''}`}
        >
          {/* The cover, blurred behind and sharp in the middle, until the video plays;
              then the video's own colours fill the bars around it. */}
          {art && <img src={art} alt="" aria-hidden className={`absolute inset-0 w-full h-full object-cover scale-125 blur-3xl transition-opacity duration-700 ${showVideo ? 'opacity-0' : 'opacity-50'}`} />}
          <VideoGlow videoRef={videoRef} active={showVideo} />
          <div className={`absolute inset-0 transition-colors duration-700 ${showVideo ? 'bg-transparent' : 'bg-black/40'}`} />
          <AnimatePresence>
            {showCoverCard && (
              <motion.div key={`cover-${currentTrack.id}`} className="absolute inset-0 flex items-center justify-center"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: reduceMotion ? 1 : 1.08 }} transition={fade}>
                <div className="relative w-[min(40vh,22rem)] aspect-square rounded-2xl overflow-hidden shadow-[0_32px_80px_rgba(0,0,0,0.7)] border border-white/10 bg-white/5">
                  {art ? <img src={art} alt="" className="w-full h-full object-cover" /> : <span className="absolute inset-0 flex items-center justify-center text-white/10 text-7xl">♪</span>}
                  {/* Waiting (finding the video, or a found one starting): the light sweeps the cover. */}
                  {status === 'loading' && (
                    <div className="absolute inset-0 overflow-hidden" aria-hidden>
                      <div className="absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-white/15 to-transparent animate-[mv-shimmer_1.6s_ease-in-out_infinite]" />
                    </div>
                  )}
                </div>
                {/* Under the cover, out of the layout: a message coming or going never moves the cover. */}
                <div className="absolute inset-x-6 flex flex-col items-center gap-5 text-center" style={{ top: 'calc(50% + min(20vh, 11rem) + 1.75rem)' }}>
                  {message && (
                    <div className="flex items-center gap-2.5 text-sm text-white/70" aria-live="polite">
                      {status === 'loading' && (
                        <span className="flex items-end gap-[3px] h-3.5" aria-hidden>
                          {[0, 1, 2].map(i => <span key={i} className="w-[3px] h-full rounded-full bg-white/70 origin-bottom animate-[mv-bar_0.9s_ease-in-out_infinite]" style={{ animationDelay: `${i * 0.15}s` }} />)}
                        </span>
                      )}
                      {message}
                    </div>
                  )}
                  {canDownload && <button onClick={download} className="inline-flex items-center gap-2 rounded-full bg-white/90 px-5 py-2 text-sm text-black"><Download size={16} />{t("Download to Videos")}</button>}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* With the lyrics open the cover card stays away; the status still speaks. */}
          {!showVideo && lyricsPanel && message && (
            <div className="absolute top-20 left-8 text-sm text-white/60" aria-live="polite">{message}{canDownload && <button onClick={download} className="ml-3 rounded-lg bg-white/90 px-3 py-1 text-black">{t("Download to Videos")}</button>}</div>
          )}

          {video?.src && !video.error && !failed && (
            <motion.video
              key={video.src}
              ref={el => { videoRef.current = el; if (el) lastVideo.current = el }}
              src={video.src}
              muted
              playsInline
              preload="auto"
              disablePictureInPicture
              onPlaying={() => { setReady(true); setEverPlayed(true); setStalled(false); recoverRef.current = 0 }}
              onWaiting={() => setStalled(true)}
              onCanPlay={() => { setStalled(false); sync() }}
              onLoadedMetadata={sync}
              onLoadedData={() => { if (!videoRef.current?.seeking) setReady(true); sync() }}
              onSeeked={() => { setReady(true); setStalled(false); sync() }}
              onError={onVideoError}
              initial={{ opacity: 0 }}
              animate={{ opacity: showVideo ? 1 : 0 }}
              transition={fade}
              className="absolute inset-0 w-full h-full object-contain"
            />
          )}

          {/* Rebuffering after a seek: the frame stays (YouTube style), a quiet spinner over it. */}
          <AnimatePresence>
            {showVideo && stalled && (
              <motion.div key="stall" className="absolute inset-0 flex items-center justify-center pointer-events-none"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} aria-live="polite" aria-label={t("Loading the video")}>
                <span className="w-10 h-10 rounded-full border-2 border-white/25 border-t-white/90 animate-spin" aria-hidden />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Synced lyrics: subtitles under the picture, lower when the controls are away. */}
          {subtitles && <LyricSubtitles lines={lyric.lines} subLines={sub.subLines} progress={progress} wordSync={wordSyncEnabled()} bottom={chromeHidden ? '2.75rem' : '8.5rem'} />}

          {/* Plain lyrics over the video's side, on a soft shade. */}
          <AnimatePresence>
            {lyricsPanel && (
              <motion.div key="lyrics"
                initial={{ opacity: 0, x: reduceMotion ? 0 : 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduceMotion ? 0 : 40 }}
                transition={{ duration: reduceMotion ? 0 : 0.4, ease: EASE }}
                className="absolute inset-y-0 right-0 w-[min(44rem,46vw)] pt-20 pb-28"
                style={{ background: 'linear-gradient(to left, rgba(0,0,0,0.72), rgba(0,0,0,0.45) 60%, transparent)' }}>
                <div className="h-full pl-16 pr-8">
                  <LyricsPanel track={currentTrack} progress={progress} fullscreen wordSync={wordSyncEnabled()} textScale={0.62} isAutoSynced={autoSynced} toolbarHidden={chromeHidden} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Controls: fade out while the mouse rests on a playing video. */}
          <motion.div className="absolute inset-0 pointer-events-none" animate={{ opacity: chromeHidden ? 0 : 1 }} transition={{ duration: 0.3 }}>
            <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/60 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-black/70 to-transparent" />
            <div className={`absolute top-5 left-5 right-5 flex items-center gap-3 ${chromeHidden ? '' : 'pointer-events-auto'}`}>
              <button onClick={hide} title={t("Close the music video (Esc)")} aria-label={t("Close the music video")}
                className="w-10 h-10 flex items-center justify-center rounded-full border border-white/[0.14] bg-white/[0.08] backdrop-blur-md text-white/90 hover:bg-white/[0.16] hover:text-white transition-colors">
                <X size={18} />
              </button>
              <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-white/60"><Clapperboard size={13} /> {t("Music Video")}</span>
              <button onClick={toMiniPlayer} title={t("Mini player: keep watching in a small window")} aria-label={t("Open the video in the mini player")}
                className="ml-auto w-10 h-10 flex items-center justify-center rounded-full border border-white/[0.14] bg-white/[0.08] text-white/90 hover:bg-white/[0.16] transition-colors">
                <PictureInPicture2 size={18} />
              </button>
              <button onClick={toggleScreen} title={screenFull ? t('Exit full screen') : t('Enter full screen')} aria-label={screenFull ? t('Exit full screen') : t('Enter full screen')}
                className="w-10 h-10 flex items-center justify-center rounded-full border border-white/[0.14] bg-white/[0.08] text-white/90 hover:bg-white/[0.16] transition-colors">
                {screenFull ? <Minimize size={18} /> : <Expand size={18} />}
              </button>
            </div>
            <div className={`absolute left-8 right-8 bottom-7 flex flex-col gap-3 ${chromeHidden ? '' : 'pointer-events-auto'}`}>
              <div className="flex items-end justify-between gap-6">
                <div className="min-w-0">
                  <motion.div key={currentTrack.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
                    <p className="text-xl font-semibold text-white truncate drop-shadow-[0_1px_8px_rgba(0,0,0,0.5)]">{currentTrack.title}</p>
                    <p className="text-sm text-white/70 truncate">{currentTrack.artist}</p>
                  </motion.div>
                </div>
                <div className="flex items-center gap-6 flex-shrink-0">
                  <button onClick={prev} title={t("Previous")} aria-label={t("Previous")} className="text-white/90 hover:text-white hover:scale-105 active:scale-95 transition-transform"><SkipBack size={26} fill="currentColor" /></button>
                  <button onClick={togglePlay} title={isPlaying ? t('Pause') : t('Play')} aria-label={isPlaying ? t('Pause') : t('Play')} className="text-white hover:scale-105 active:scale-95 transition-transform">
                    {isPlaying ? <Pause size={36} fill="currentColor" strokeWidth={0} /> : <Play size={36} fill="currentColor" strokeWidth={0} className="translate-x-0.5" />}
                  </button>
                  <button onClick={() => next(false)} title={t("Next")} aria-label={t("Next")} className="text-white/90 hover:text-white hover:scale-105 active:scale-95 transition-transform"><SkipForward size={26} fill="currentColor" /></button>
                </div>
                <div className="flex-1 flex items-center justify-end gap-3 min-w-0">
                  {video?.videoId && <VideoOffsetControl videoId={video.videoId} />}
                  {subtitles && (
                    <>
                      <ChromeButton active={sub.wantTranslation} onClick={() => sub.toggle('translation')} label={t('Translate the lyrics ({language})', { language: sub.translateTarget })}>
                        {sub.translationBusy ? <Loader2 size={16} className="animate-spin" /> : <Languages size={16} />}
                      </ChromeButton>
                      {sub.canRomanize && (
                        <ChromeButton active={sub.subline === 'romanization'} onClick={() => sub.toggle('romanization')} label={t("Show the pronunciation in Latin letters")}>
                          {sub.romanizationBusy ? <Loader2 size={16} className="animate-spin" /> : <span className="text-[13px] font-semibold leading-none">Aa</span>}
                        </ChromeButton>
                      )}
                    </>
                  )}
                  {showLyrics && lyric.synced && (
                    <ChromeButton active={lyricsLayout === 'side'} onClick={switchLyricsLayout}
                      label={lyricsLayout === 'side' ? t('Lyrics as subtitles under the video') : t('Full lyrics at the side (other sources, plain lyrics)')}>
                      {lyricsLayout === 'side' ? <Captions size={17} /> : <PanelRight size={17} />}
                    </ChromeButton>
                  )}
                  <button onClick={() => setShowLyrics(v => !v)} title={showLyrics ? t('Hide the lyrics') : t('Show the lyrics')} aria-label={showLyrics ? t('Hide the lyrics') : t('Show the lyrics')} aria-pressed={showLyrics}
                    className={`w-10 h-10 flex items-center justify-center rounded-full border backdrop-blur-md transition-colors ${showLyrics ? 'border-white/30 bg-white/20 text-white' : 'border-white/[0.14] bg-white/[0.08] text-white/90 hover:bg-white/[0.16]'}`}>
                    <Mic2 size={17} />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-3 text-[11px] tabular-nums text-white/60">
                <span className="w-10 text-right">{fmt(progress)}</span>
                <div onClick={seek} className="group relative flex-1 h-4 flex items-center cursor-pointer" role="slider" aria-label={t("Seek")} aria-valuemin={0} aria-valuemax={Math.round(duration || 0)} aria-valuenow={Math.round(progress || 0)}>
                  <div className="relative w-full h-1 group-hover:h-1.5 transition-[height] rounded-full bg-white/20 overflow-hidden">
                    <div className="absolute inset-y-0 left-0 bg-white/85 rounded-full" style={{ width: `${duration > 0 ? Math.min(100, (progress / duration) * 100) : 0}%` }} />
                  </div>
                </div>
                <span className="w-10">{fmt(duration)}</span>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * YouTube's "ambient mode": a soft, blurred glow of the picture around the
 * video, fading into black. About ten times a second the whole frame is
 * blended into a 64×36 canvas (blurred there, at that size, which costs next
 * to nothing), so the colours drift from scene to scene instead of jumping.
 * The canvas is stretched a little larger than the video and centred behind
 * it, its edges faded out. No second video, no full-screen blur filter, no
 * pixels read back (a video from another origin works too), and nothing is
 * drawn while the window is hidden or the video is paused.
 */
// The bars around the video carry on its picture to the screen's edges, the
// way YouTube's ambient mode does: each side's outermost strip stretched out
// to the edge, blurred, fading a little toward the screen's edge. Drawn small
// (AMBIENT_WIDTH px across) and scaled up, fifteen times a second.
const AMBIENT_WIDTH = 96
const AMBIENT_EVERY_MS = 66
const AMBIENT_STRIP = 0.03 // the edge strip carried on, from the video's width or height
// How much of each new frame goes in (the glow's fade between scenes); a
// little more without the look-ahead, so it doesn't trail the picture.
const AMBIENT_BLEND = 0.3
const AMBIENT_BLEND_LIVE = 0.6
// The glow comes from a second, muted copy running this far ahead, so it
// changes just before the picture does (YouTube's feel). A streamed video's
// copy reads the same pieces the video reads next (kept in the main process,
// see videoPiece), so it isn't fetched twice; until the copy is ready (a
// seek), the playing video, blended faster.
const AMBIENT_LEAD_S = 0.4
const AMBIENT_SHADE = 'radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.4) 100%)'

/** The video's picture inside the window (object-contain): { x, y, width, height }. */
function pictureBox(video, width, height) {
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight)
  const w = video.videoWidth * scale
  const h = video.videoHeight * scale
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h }
}

/**
 * `source`'s frame on `context` (the window at `width` x `height`, scaled
 * down): the picture where it is on screen, its edge strips stretched to the
 * window's edges around it.
 */
function drawCarriedOn(context, source, width, height) {
  const sw = source.videoWidth
  const sh = source.videoHeight
  const { x, y, width: w, height: h } = pictureBox(source, width, height)
  const right = x + w
  const bottom = y + h
  const kx = Math.max(2, Math.round(sw * AMBIENT_STRIP))
  const ky = Math.max(2, Math.round(sh * AMBIENT_STRIP))
  const piece = (sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight) => {
    if (dWidth > 0.01 && dHeight > 0.01) context.drawImage(source, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
  }
  piece(0, 0, sw, sh, x, y, w, h)
  piece(0, 0, kx, sh, 0, y, x, h) // left
  piece(sw - kx, 0, kx, sh, right, y, width - right, h) // right
  piece(0, 0, sw, ky, x, 0, w, y) // top
  piece(0, sh - ky, sw, ky, x, bottom, w, height - bottom) // bottom
  piece(0, 0, kx, ky, 0, 0, x, y)
  piece(sw - kx, 0, kx, ky, right, 0, width - right, y)
  piece(0, sh - ky, kx, ky, 0, bottom, x, height - bottom)
  piece(sw - kx, sh - ky, kx, ky, right, bottom, width - right, height - bottom)
}

/** A muted copy of `video` kept AMBIENT_LEAD_S ahead of it, for the glow. Returns stop(). */
function leadCopy(video) {
  const copy = document.createElement('video')
  copy.muted = true
  copy.playsInline = true
  copy.preload = 'auto'
  copy.src = video.currentSrc || video.src
  const follow = () => {
    const target = video.currentTime + AMBIENT_LEAD_S * (video.playbackRate || 1)
    if (copy.readyState >= 1 && Math.abs(copy.currentTime - target) > 0.6) copy.currentTime = target
    copy.playbackRate = video.playbackRate || 1
    if (video.paused && !copy.paused) copy.pause()
    else if (!video.paused && copy.paused) copy.play().catch(() => {})
  }
  follow()
  const timer = setInterval(follow, 250)
  return {
    copy,
    // Ready, and where it should be (not still seeking after a jump).
    usable: () => copy.readyState >= 2 && !copy.seeking && Math.abs(copy.currentTime - video.currentTime - AMBIENT_LEAD_S) < 0.6,
    stop: () => { clearInterval(timer); copy.pause(); copy.removeAttribute('src'); copy.load() },
  }
}

export function VideoGlow({ videoRef, active }) {
  const canvasRef = useRef(null)
  const performanceMode = usePerformanceMode()
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    if (!active || performanceMode) { setDrawn(false); return undefined }
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d', { alpha: false })
    if (!context) return undefined
    // The new frame is drawn here, then blended (blurred) onto the canvas.
    const frame = document.createElement('canvas')
    const frameContext = frame.getContext('2d', { alpha: false })
    let last = null
    let first = true
    let lead = null
    let hidden = isWindowHidden()
    let timer = null
    const stopLead = () => {
      lead?.stop()
      lead = null
    }
    const draw = () => {
      const video = videoRef.current
      if (hidden || isWindowHidden() || !video || video.readyState < 2 || !video.videoWidth) return
      const src = video.currentSrc || video.src || ''
      if (!lead && src) lead = leadCopy(video)
      if (video.paused && last === video.currentTime) return
      const width = AMBIENT_WIDTH
      const height = Math.max(1, Math.round(AMBIENT_WIDTH * window.innerHeight / Math.max(1, window.innerWidth)))
      if (canvas.width !== width || canvas.height !== height) { canvas.width = frame.width = width; canvas.height = frame.height = height; first = true }
      const ahead = lead?.usable() ? lead.copy : null
      try {
        drawCarriedOn(frameContext, ahead || video, width, height)
        context.filter = 'blur(3px) saturate(1.3)'
        context.globalAlpha = first ? 1 : ahead ? AMBIENT_BLEND : AMBIENT_BLEND_LIVE
        context.drawImage(frame, 0, 0)
        first = false
        last = video.currentTime
        setDrawn(true)
      } catch {}
    }
    const start = () => {
      if (hidden || timer !== null) return
      draw()
      timer = setInterval(draw, AMBIENT_EVERY_MS)
    }
    const stop = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
      stopLead()
    }
    const unsubscribeVisibility = onWindowVisibility(nextHidden => {
      hidden = nextHidden
      if (hidden) {
        stop()
        setDrawn(false)
      } else {
        last = null
        first = true
        start()
      }
    })
    if (!hidden) start()
    return () => { unsubscribeVisibility(); stop() }
  }, [active, videoRef, performanceMode])
  if (performanceMode) return null
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 transition-opacity duration-1000 ${active && drawn ? 'opacity-95' : 'opacity-0'}`}>
      <canvas ref={canvasRef} width={AMBIENT_WIDTH} height={54} className="absolute inset-0 h-full w-full" />
      <div className="absolute inset-0" style={{ background: AMBIENT_SHADE }} />
    </div>
  )
}
