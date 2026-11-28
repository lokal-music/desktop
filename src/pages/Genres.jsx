import React, { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Music, Play, Search, Shuffle, Tags } from 'lucide-react'
import { api } from '../api'
import { usePlayerStore } from '../store/player'
import { peekCache, writeCache, usePageReady } from '../pageCache'
import { PlayGlyph } from '../components/CoverPlay'
import { plural } from '../plural'
import { useTranslation } from '../i18n'
import TrackList from '../components/TrackList'
import { isPlayable } from '../onlineTracks'
import { fetchAllTrackPages, shuffledLibraryTracks } from '../libraryHelpers'
import { GENRE_FOREGROUND, genreGradient, genreToneFor } from '../genrePalette'

// Songs without any genre, as a genre of its own (see genreFilter in
// electron/ipc/scanner.js).
export const NO_GENRE = '__none__'

const genrePath = name => `/genre/${encodeURIComponent(name)}`

/** Material Rounded 24x24 icon paths matching mobile's LokalGenrePalette. */
const GENRE_ICON_PATHS = {
  graphic_eq: 'M8 18c.55 0 1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1v10c0 .55.45 1 1 1zm4 4c.55 0 1-.45 1-1V3c0-.55-.45-1-1-1s-1 .45-1 1v18c0 .55.45 1 1 1zm-8-8c.55 0 1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1v2c0 .55.45 1 1 1zm12 4c.55 0 1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1v10c0 .55.45 1 1 1zm3-7v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1z',
  music_note: 'M12 5v8.55c-.94-.54-2.1-.75-3.33-.32-1.34.48-2.37 1.67-2.61 3.07-.46 2.74 1.86 5.08 4.59 4.65 1.96-.31 3.35-2.11 3.35-4.1V7h2c1.1 0 2-.9 2-2s-.9-2-2-2h-2c-1.1 0-2 .9-2 2z',
  album: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z',
  audiotrack: 'M12 5v8.55c-.94-.54-2.1-.75-3.33-.32-1.34.48-2.37 1.67-2.61 3.07-.46 2.74 1.86 5.08 4.59 4.65 1.96-.31 3.35-2.11 3.35-4.1V7h2c1.1 0 2-.9 2-2s-.9-2-2-2h-2c-1.1 0-2 .9-2 2z',
  music_video: 'M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 16H4c-.55 0-1-.45-1-1V6c0-.55.45-1 1-1h16c.55 0 1 .45 1 1v12c0 .55-.45 1-1 1zM8.05 15.54C7.72 13.79 9.1 12.1 10.9 12c.39-.02.77.04 1.1.16V7.85c0-.47.38-.85.85-.85h2.3c.47 0 .85.38.85.85v.3c0 .47-.38.85-.85.85H13v6.5c0 1.54-1.39 2.76-2.99 2.45-1.01-.2-1.78-1.01-1.96-2.41z',
  piano: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-6 11.5h.25V19h-2.5v-4.5H11c.55 0 1-.45 1-1V5h2v8.5c0 .55-.45 1-1 1zM5 5h2v8.5c0 .55.45 1 1 1h.25V19H5V5zm14 14h-3.25v-4.5H16c.55 0 1-.45 1-1V5h2v14z',
  headphones: 'M12 3a9 9 0 0 0-9 9v7c0 1.1.9 2 2 2h2c1.1 0 2-.9 2-2v-4c0-1.1-.9-2-2-2H5v-1c0-3.87 3.13-7 7-7s7 3.13 7 7v1h-2c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h2c1.1 0 2-.9 2-2v-7a9 9 0 0 0-9-9z',
  equalizer: 'M12 20c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2s-2 .9-2 2v12c0 1.1.9 2 2 2zm-6 0c1.1 0 2-.9 2-2v-4c0-1.1-.9-2-2-2s-2 .9-2 2v4c0 1.1.9 2 2 2zm10-9v7c0 1.1.9 2 2 2s2-.9 2-2v-7c0-1.1-.9-2-2-2s-2 .9-2 2z',
  library_music: 'M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 5h-3v5.5a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1 2.5-2.5c.57 0 1.08.19 1.5.51V6c0-.55.45-1 1-1h3c.55 0 1 .45 1 1s-.45 1-1 1zM3 6c-.55 0-1 .45-1 1v13c0 1.1.9 2 2 2h13c.55 0 1-.45 1-1s-.45-1-1-1H5c-.55 0-1-.45-1-1V7c0-.55-.45-1-1-1z',
  radio: 'M3.24 6.15C2.51 6.43 2 7.17 2 8v12c0 1.1.89 2 2 2h16c1.11 0 2-.9 2-2V8c0-1.1-.9-2-2-2H8.3l7.43-3c.46-.19.68-.71.49-1.17-.19-.46-.71-.68-1.17-.49L3.24 6.15zM7 20c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-8h-2v-1c0-.55-.45-1-1-1s-1 .45-1 1v1H4V9c0-.55.45-1 1-1h14c.55 0 1 .45 1 1v3z',
  queue_music: 'M14 6H4c-.55 0-1 .45-1 1s.45 1 1 1h10c.55 0 1-.45 1-1s-.45-1-1-1zm0 4H4c-.55 0-1 .45-1 1s.45 1 1 1h10c.55 0 1-.45 1-1s-.45-1-1-1zM4 16h6c.55 0 1-.45 1-1s-.45-1-1-1H4c-.55 0-1 .45-1 1s.45 1 1 1zm15-10h-1c-.55 0-1 .45-1 1v6.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h2c.55 0 1-.45 1-1s-.45-1-1-1h-2z',
}

/** Semantic chromatic cover matching mobile's _LokalGenreCard surface. */
function GenreCover({ name, compact = false, children }) {
  const tone = genreToneFor(name)
  const iconPath = GENRE_ICON_PATHS[tone.icon] || GENRE_ICON_PATHS.music_note
  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ backgroundImage: genreGradient(tone) }}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="pointer-events-none absolute transition-transform duration-300 group-hover:scale-[1.04]"
        style={{
          right: compact ? -14 : -25,
          bottom: compact ? -18 : -31,
          width: compact ? 76 : 126,
          height: compact ? 76 : 126,
          rotate: '-0.18rad',
          color: 'rgba(255, 255, 255, 0.19)',
        }}
      >
        <path d={iconPath} fill="currentColor" />
      </svg>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-[1px] right-[1px] top-[1px] h-[1px]"
        style={{ backgroundColor: 'rgba(255, 255, 255, 0.21)' }}
      />
      {children}
    </div>
  )
}

function GenreCard({ label, count, onOpen, onPlay }) {
  const { t } = useTranslation()
  const tone = genreToneFor(label)
  return (
    <motion.div
      initial={false}
      whileHover={{ y: -3 }}
      className="group relative aspect-[1/0.91] overflow-hidden rounded-[1.5rem] shadow-[0_8px_24px_rgba(0,0,0,0.22)]"
      style={{ contentVisibility: 'auto', containIntrinsicSize: '220px' }}
    >
      <GenreCover name={label}>
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${label}, ${plural(count, 'track')}`}
          className="relative flex h-full w-full flex-col items-start justify-between px-4 pb-3.5 pt-4 pr-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-inset"
        >
          <p
            title={label}
            className={`line-clamp-3 text-[22px] font-extrabold leading-[1.06] tracking-[-0.03em] ${tone.italic ? 'italic' : ''}`}
            style={{ color: GENRE_FOREGROUND }}
          >
            {label}
          </p>
          <span
            className="inline-flex max-w-full items-center truncate rounded-[30px] px-2.5 py-[5px] text-[11px] font-bold leading-none"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.13)',
              border: '1px solid rgba(255, 255, 255, 0.22)',
              color: GENRE_FOREGROUND,
            }}
          >
            {plural(count, 'track')}
          </span>
        </button>
        <button
          type="button"
          aria-label={t('Play {name}', { name: label })}
          title={t('Play {name}', { name: label })}
          onClick={(event) => { event.stopPropagation(); onPlay?.(event) }}
          className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full opacity-0 shadow-[0_6px_18px_rgba(0,0,0,0.35)] backdrop-blur-md outline-none transition duration-200 hover:scale-105 active:scale-95 group-hover:opacity-100 focus-visible:opacity-100"
          style={{
            backgroundColor: 'rgba(0, 0, 0, 0.34)',
            border: '1px solid rgba(255, 255, 255, 0.24)',
            color: GENRE_FOREGROUND,
          }}
        >
          <PlayGlyph className="h-5 w-5 translate-x-[0.5px]" />
        </button>
      </GenreCover>
    </motion.div>
  )
}

/**
 * The Genres tab: every genre in the library as a card (a song tagged
 * "Рэп/Караоке" is in both "Рэп" and "Караоке"), plus "No genre". A card
 * opens the genre's songs, sorted and filtered like the Library tab's.
 */
export default function Genres() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const playQueue = usePlayerStore(s => s.playQueue)
  const [summary, setSummaryState] = useState(() => peekCache('genres:summary') || null)
  const [query, setQuery] = useState('')
  usePageReady(!!summary)

  useEffect(() => {
    const load = () => Promise.resolve(api.getGenreSummary())
      .then(result => {
        if (!result || result.error) return
        writeCache('genres:summary', result)
        setSummaryState(result)
      })
      .catch(() => {})
    load()
    window.addEventListener('lokal:refresh', load)
    return () => window.removeEventListener('lokal:refresh', load)
  }, [])

  const shown = useMemo(() => {
    const lower = query.trim().toLocaleLowerCase()
    const list = summary?.genres || []
    return lower ? list.filter(item => item.name.toLocaleLowerCase().includes(lower)) : list
  }, [summary, query])
  const noGenre = summary?.none || 0
  const showNoGenre = noGenre > 0 && (!query.trim() || t('No genre').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  const play = async (genre) => {
    const tracks = await Promise.resolve(api.getTracks({ genre, sort: 'added_at DESC', limit: 5000 })).catch(() => null)
    if (Array.isArray(tracks) && tracks.length) playQueue(tracks, 0)
  }

  return (
    <div className="min-h-full p-6 pb-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <div className="flex flex-col gap-4 @md:flex-row @md:items-end @md:justify-between">
          <div>
            <p className="text-[11px] font-display uppercase tracking-[0.32em] text-muted">{t('Collection')}</p>
            <h1 className="mt-2 font-display text-3xl uppercase tracking-[0.14em] text-white">{t('Genres')}</h1>
            <p className="mt-3 text-sm text-muted">{summary ? t('{n} genres', { n: (summary.genres?.length || 0).toLocaleString() }) : ' '}</p>
          </div>
          <div className="relative w-full max-w-xl">
            <Search size={15} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search genres...')}
              className="w-full rounded-2xl border border-border bg-elevated/90 pl-11 pr-4 py-3 text-sm text-white outline-none transition-colors focus:border-accent/50 placeholder:text-muted" />
          </div>
        </div>

        {summary && !shown.length && !showNoGenre && (
          <div className="py-24 text-center text-muted">
            <Tags size={48} className="mx-auto mb-4 opacity-20" />
            <p>{query.trim() ? t('No genres match your search.') : t('No genres in your library yet.')}</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 @sm:grid-cols-3 @lg:grid-cols-4 @xl:grid-cols-5 @2xl:grid-cols-6">
          {shown.map(item => (
            <GenreCard key={item.name} label={item.name} count={item.count}
              onOpen={() => navigate(genrePath(item.name))} onPlay={() => play(item.name)} />
          ))}
          {showNoGenre && (
            <GenreCard label={t('No genre')} count={noGenre}
              onOpen={() => navigate(genrePath(NO_GENRE))} onPlay={() => play(NO_GENRE)} />
          )}
        </div>
      </div>
    </div>
  )
}

/** /genre/:name -- a dedicated playlist view for one genre. */
export function GenreTracks() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { name = '' } = useParams()
  const genre = name
  const [tracks, setTracks] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const playQueue = usePlayerStore(s => s.playQueue)
  usePageReady(loaded)

  useEffect(() => {
    let live = true
    setLoaded(false)
    setLoadError(false)
    setTracks([])
    fetchAllTrackPages(options => api.getTracks(options), { genre, sort: 'added_at DESC' }, 5000)
      .then(result => {
        if (!live) return
        setTracks(Array.isArray(result) ? result : [])
        setLoaded(true)
      })
      .catch(() => {
        if (!live) return
        setTracks([])
        setLoadError(true)
        setLoaded(true)
      })
    return () => { live = false }
  }, [genre])

  const playableTracks = useMemo(() => tracks.filter(track => isPlayable(track)), [tracks])
  const title = genre === NO_GENRE ? t('No genre') : genre
  const shuffle = () => {
    if (playableTracks.length) playQueue(shuffledLibraryTracks(playableTracks), 0)
  }

  return (
    <div className="min-h-full p-6 pb-10 space-y-6">
      <button type="button" onClick={() => navigate('/genres')}
        className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-white">
        <ArrowLeft size={16} />{t('Back to Genres')}
      </button>

      <div className="flex items-end gap-4">
        <div className="h-28 w-28 flex-shrink-0 overflow-hidden rounded-3xl shadow-xl">
          <GenreCover name={title} compact />
        </div>
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs font-display uppercase tracking-widest text-muted">{t('Genre playlist')}</p>
          <h1 className="truncate font-display text-2xl text-white" title={title}>{title}</h1>
          <p className="mt-1 text-sm text-muted">{loaded ? plural(tracks.length, 'track') : t('Loading...')}</p>
        </div>
      </div>

      <TrackList
        tracks={tracks}
        showQuality
        reduceMotion
        toolbarStart={(
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => playableTracks.length && playQueue(playableTracks, 0)}
              disabled={!playableTracks.length} aria-label={t('Play All')} title={t('Play All')}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-[rgb(var(--bg-rgb))] transition-colors hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-40">
              <Play size={17} fill="currentColor" className="translate-x-px" />
            </button>
            <button type="button" onClick={shuffle} disabled={!playableTracks.length}
              aria-label={t('Shuffle')} title={t('Shuffle')}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-muted transition-colors hover:bg-elevated hover:text-white disabled:cursor-not-allowed disabled:opacity-40">
              <Shuffle size={17} />
            </button>
          </div>
        )}
      />

      {loaded && !tracks.length && (
        <div className="py-16 text-center text-muted">
          <Music size={40} className="mx-auto mb-3 opacity-20" />
          <p className="text-sm">{loadError ? t('Could not load this genre. Please try again.') : t('No tracks in this genre yet.')}</p>
        </div>
      )}
    </div>
  )
}
