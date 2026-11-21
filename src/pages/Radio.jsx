import { useTranslation } from '../i18n'
import React, { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, ListPlus, Loader2, Play, Radio as RadioIcon, RefreshCw } from 'lucide-react'
import TrackList from '../components/TrackList'
import { usePlayerStore, useAppStore } from '../store/player'
import { buildRadio, emptyRadioMessage } from '../radioActions'
import { saveAsPlaylist } from '../trackActions'
import { trackArtURL } from '../onlineTracks'
import FadeImg from '../components/FadeImg'
import { showToast } from '../components/Toaster'
import { api } from '../api'

// A radio starts playing once this many of its songs are found (or the seed,
// when it's the song already playing); the rest join the queue as they come.
const START_WITH = 3

export default function Radio() {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useAppStore()
  const playQueue = usePlayerStore(s => s.playQueue)
  const extendQueue = usePlayerStore(s => s.extendQueue)
  const continueAsQueue = usePlayerStore(s => s.continueAsQueue)
  const seed = location.state?.seed || location.state?.tracks?.[0]
  const name = location.state?.name || 'Song Radio'
  const [tracks, setTracks] = useState(() => location.state?.tracks || [])
  const [building, setBuilding] = useState(false)
  const [emptyMessage, setEmptyMessage] = useState('')
  const [playing, setPlaying] = useState(false)
  const sessionKeyRef = useRef(location.key)
  // The queue this radio plays as: songs found later are added to it while
  // it's still the one playing (its id tells it apart from any other).
  const contextRef = useRef(null)

  const newContext = () => {
    contextRef.current = { type: 'radio', name, id: `radio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }
    return contextRef.current
  }

  /** Build the radio, playing its first songs as soon as they're found. */
  const build = (buildSeed) => {
    const sessionKey = sessionKeyRef.current
    const isCurrent = () => sessionKeyRef.current === sessionKey
    const context = newContext()
    let started = false
    const play = list => {
      if (started || !list.length) return
      started = true
      setPlaying(true)
      // Started from the song that's playing: it carries on as the radio's
      // first song instead of starting over.
      const playing = usePlayerStore.getState().currentTrack
      if (playing && list[0].id === playing.id && continueAsQueue(list, context)) return
      playQueue(list, 0, context)
    }
    const take = list => {
      if (!isCurrent()) return
      setTracks(list)
      const playing = usePlayerStore.getState().currentTrack
      if (!started && (list.length >= START_WITH || (playing && list[0]?.id === playing.id))) play(list)
      else if (started) extendQueue(list, context)
    }
    setBuilding(true)
    setPlaying(false)
    setEmptyMessage('')
    setTracks([])
    buildRadio(buildSeed, user?.id, api, { onTracks: take, isCurrent })
      .then(list => {
        if (!isCurrent()) return
        setTracks(list)
        if (started) extendQueue(list, context)
        else play(list)
        if (!list.length) {
          const message = emptyRadioMessage(buildSeed)
          setEmptyMessage(message)
          showToast(message)
        }
      })
      .catch(() => { if (isCurrent()) setEmptyMessage(emptyRadioMessage(buildSeed)) })
      .finally(() => { if (isCurrent()) setBuilding(false) })
  }

  useEffect(() => {
    sessionKeyRef.current = location.key
    setBuilding(false)
    setEmptyMessage('')
    const incomingTracks = Array.isArray(location.state?.tracks) ? location.state.tracks : []
    if (location.state?.build && seed) {
      build(seed)
    } else {
      setTracks(incomingTracks)
      if (incomingTracks.length) playQueue(incomingTracks, 0, newContext())
    }
    // The queue should start only when this radio session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      sessionKeyRef.current = null
    }
  }, [location.key])

  const regenerate = () => {
    if (!seed || building) return
    // A new session: whatever the previous build still finds is dropped.
    sessionKeyRef.current = `${location.key}-${Date.now()}`
    build(seed)
  }

  const playRadio = () => { if (tracks.length) playQueue(tracks, 0, newContext()) }

  const save = async () => {
    const playlist = await saveAsPlaylist(`${seed?.title || seed?.artist || t('Song')} ${t('Radio')}`, tracks, { userId: user?.id, description: t('Generated radio from Lokal') }).catch(() => null)
    showToast(playlist ? t('Radio saved as a playlist') : t('Could not save radio'))
  }

  const heroArt = trackArtURL(seed)
  return <div className="min-h-full p-6 pb-10"><div className="mx-auto max-w-5xl space-y-7">
    <button type="button" onClick={() => navigate(-1)} className="inline-flex items-center gap-2 text-sm text-muted hover:text-white"><ArrowLeft size={15} />{t("Back")}</button>
    <div className="flex flex-col gap-5 @md:flex-row @md:items-end"><div className="h-36 w-36 overflow-hidden rounded-xl bg-card shadow-xl">{heroArt ? <FadeImg src={heroArt} className="h-full w-full object-cover" /> : <RadioIcon size={38} className="m-12 text-accent" />}</div><div><p className="text-[11px] font-display uppercase tracking-[0.3em] text-accent">{t("Radio")}</p><h1 className="mt-2 text-3xl font-medium text-white">{name}</h1><p className="mt-2 text-sm text-muted">{t('A continuous mix based on')} {seed?.title || seed?.artist || t('your selection')}.</p><div className="mt-4 flex gap-2"><button type="button" onClick={playRadio} disabled={!tracks.length} className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-2 text-sm font-medium text-black disabled:opacity-40"><Play size={15} fill="currentColor" />{t("Play radio")}</button><button type="button" onClick={regenerate} disabled={building} className="inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm text-white/75"><RefreshCw size={15} className={building ? 'animate-spin' : ''} />{t("Regenerate")}</button><button type="button" onClick={save} disabled={!tracks.length} className="inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm text-white/75 disabled:opacity-40"><ListPlus size={15} />{t('Save')}</button></div></div></div>
    {building && (
      <p className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
        <Loader2 size={14} className="animate-spin" />
        {tracks.length
          ? t(playing ? (tracks.length === 1 ? 'Building your radio… {count} song so far, playing' : 'Building your radio… {count} songs so far, playing') : (tracks.length === 1 ? 'Building your radio… {count} song so far' : 'Building your radio… {count} songs so far'), { count: tracks.length })
          : t('Building your radio… finding the first songs')}
      </p>
    )}
    {!building && emptyMessage && !tracks.length && (
      <div className="rounded-xl border border-border bg-card/40 px-4 py-6 text-center text-sm text-muted">{emptyMessage}</div>
    )}
    {tracks.length > 0 && <TrackList tracks={tracks} reduceMotion />}
  </div></div>
}
