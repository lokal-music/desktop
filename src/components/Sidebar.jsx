import React, { useEffect, useRef, useState } from 'react'
import { readViewState, writeViewState } from '../statePersistence.mjs'
import { usePanelWidths, usePanelWidth, PanelResizeHandle } from '../panelWidths.jsx'
import { useNavigate, useLocation } from 'react-router-dom'
import { Plus, Heart, LogIn, LogOut, PanelLeftClose, PanelLeftOpen, Sparkles, Import, MoreHorizontal, RefreshCw, ListMusic, Eye, EyeOff, Pin, PinOff, Search, X } from 'lucide-react'
import { useAppStore, usePlayerStore } from '../store/player'
import { api, peekSettings } from '../api'
import { SIDEBAR_ITEMS, sidebarNavOrder, splitSidebarNav } from '../sidebarNav'
import { latestPeriod, listenerTimeZone, nextPeriodBoundary, recapOpened, recapTree } from '../recapPeriods'
import PlaylistCover from './PlaylistCover'
import { openSmartPlaylistEditor } from '../smartPlaylists'
import { openPlaylistImport } from '../playlistImport'
import { getLastHomePath } from '../recommendationSession'
import { useTranslation } from '../i18n'
import { hiddenPlaylistIds, setPlaylistHidden } from '../providerPlaylistVisibility'



// The collapsed state survives an app restart only if the user opts in.
const readCollapsed = () => readViewState('sidebar:collapsed') === '1'

/** A menu entry: icon and name, or just the icon (named on hover) when collapsed. */
function NavItem({ icon: Icon, label, active, onClick, collapsed, badge, tour }) {
  const { t } = useTranslation()
  return (
    <button
      data-tour={tour || undefined}
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? `${label}${badge ? ' (new)' : ''}` : undefined}
      aria-current={active ? 'page' : undefined}
      className={`relative w-full flex items-center gap-3 py-2 rounded-lg text-sm font-medium transition-all ${collapsed ? 'justify-center px-0' : 'px-3'} ${active ? 'bg-accent/15 text-accent' : 'text-muted hover:text-white hover:bg-elevated'}`}
    >
      <Icon size={15} className="flex-shrink-0" />
      {!collapsed && <span className="flex-1 truncate text-left">{label}</span>}
      {badge && (collapsed
        ? <span aria-hidden="true" className="absolute right-3 top-1.5 h-2 w-2 rounded-full bg-accent" />
        : <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-base">!</span>)}
    </button>
  )
}

const pinStorageKey = userId => `lokal:playlist-pins:v1:${userId || 'guest'}`
function readPlaylistPins(userId) {
  try {
    const stored = JSON.parse(localStorage.getItem(pinStorageKey(userId)) || '[]')
    return Array.isArray(stored) ? stored.filter(key => typeof key === 'string') : []
  } catch { return [] }
}

function PinButton({ pinned, name, onClick }) {
  const { t } = useTranslation()
  return <button type="button" onClick={onClick} aria-pressed={pinned}
    aria-label={t(pinned ? 'Unpin {name}' : 'Pin {name}', { name })}
    title={t(pinned ? 'Unpin playlist' : 'Pin playlist')}
    className={`shrink-0 rounded p-1 hover:text-white focus:opacity-100 group-hover:opacity-100 ${pinned ? 'text-accent' : 'text-muted opacity-0'}`}>
    {pinned ? <PinOff size={13} /> : <Pin size={13} />}
  </button>
}

function ProviderPlaylistRow({ pl, provider, collapsed, nav, pathname, pinned, onPin, off, onHide }) {
  const { t } = useTranslation()
  const name = pl.name || pl.title
  const route = `/${provider}/playlist/${encodeURIComponent(pl.id)}`
  return <div className="group flex items-center">
    <button type="button" onClick={() => nav(route)} title={name}
      aria-current={pathname === route ? 'page' : undefined}
      className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-2 text-xs transition-all ${collapsed ? 'justify-center px-0' : 'px-2'} ${pathname === route ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-elevated hover:text-white'} ${off ? 'opacity-50' : ''}`}>
      {pl.thumbnail
        ? <img src={pl.thumbnail} alt="" className="h-7 w-7 shrink-0 rounded object-cover" loading="lazy" />
        : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-accent/15"><ListMusic size={13} /></span>}
      {!collapsed && <span className="truncate">{name}</span>}
    </button>
    {!collapsed && <>
      <PinButton pinned={pinned} name={name} onClick={onPin} />
      <button type="button" onClick={onHide}
        title={t(off ? 'Show playlist' : 'Hide playlist')}
        aria-label={t(off ? 'Show {name}' : 'Hide {name}', { name })}
        className="shrink-0 rounded p-1 text-muted opacity-0 hover:text-white focus:opacity-100 group-hover:opacity-100">
        {off ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
    </>}
  </div>
}

/** Spotify and YouTube playlists share one compact, hideable sidebar shelf. */
function ProviderPlaylistSection({ title, playlists, hidden, loading, error, refresh, collapsed, searching, renderRow }) {
  const { t } = useTranslation()
  const [showHidden, setShowHidden] = useState(false)
  const visible = playlists.filter(pl => showHidden || !hidden.has(pl.id))
  if (searching && !visible.length && !hidden.size) return null
  return (
    <section className="mt-4" aria-label={title}>
      <div className={`mb-1 flex items-center ${collapsed ? 'justify-center' : 'justify-between px-1'}`}>
        {!collapsed && <p className="text-xs font-display text-muted uppercase tracking-widest">{t(title)}</p>}
        <div className="flex gap-1">
          {hidden.size > 0 && <button type="button"
            title={t(showHidden ? 'Hide disabled playlists' : 'Manage hidden playlists')}
            aria-label={t(showHidden ? 'Hide disabled playlists' : 'Manage hidden playlists')}
            aria-pressed={showHidden} onClick={() => setShowHidden(value => !value)}
            className="rounded p-1 text-muted hover:text-white">
            {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>}
          <button type="button" onClick={refresh} disabled={loading}
            title={t(`Update ${title} playlists`)} aria-label={t(`Update ${title} playlists`)}
            className="rounded p-1 text-muted hover:text-white disabled:opacity-40">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>
      {visible.map(renderRow)}
      {!collapsed && error && <p className="px-2 py-2 text-xs text-muted" role="status">{t(error)}</p>}
      {!collapsed && !searching && !loading && !error && visible.length === 0 && !playlists.length &&
        <p className="px-2 py-2 text-xs text-muted">{t('No unpinned playlists.')}</p>}
      {!collapsed && !searching && !loading && !error && visible.length === 0 && playlists.length > 0 &&
        <p className="px-2 py-2 text-xs text-muted">{t('All playlists are hidden. Use the eye button to manage them.')}</p>}
    </section>
  )
}

/** Left sidebar: account, navigation and playlists; collapsible to icons. */
export default function Sidebar() {
  const nav = useNavigate()
  const loc = useLocation()
  const { t } = useTranslation()
  const freeform = usePanelWidths(s => s.freeform)
  const panelWidth = usePanelWidth('left')
  const [playlists, setPlaylists] = useState([])
  const [spotifyPlaylists, setSpotifyPlaylists] = useState([])
  const [spotifyAccountId, setSpotifyAccountId] = useState('')
  const [youtubePlaylists, setYoutubePlaylists] = useState([])
  const [youtubeAccountId, setYoutubeAccountId] = useState('')
  const [youtubeLoading, setYoutubeLoading] = useState(api.isElectron)
  const [youtubeError, setYoutubeError] = useState('')
  const [spotifyLoading, setSpotifyLoading] = useState(api.isElectron)
  const [spotifyError, setSpotifyError] = useState('')
  const spotifyPlaylistLoad = useRef(null)
  const youtubePlaylistLoad = useRef(null)
  const [playlistSearchOpen, setPlaylistSearchOpen] = useState(false)
  const [playlistQuery, setPlaylistQuery] = useState('')
  const [, updatePlaylistPreferences] = useState(0)
  const [showNewPlaylist, setShowNewPlaylist] = useState(false)
  const [newPlName, setNewPlName] = useState('')
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [showRecapBadge, setShowRecapBadge] = useState(false)
  const [sidebarNavValue, setSidebarNavValue] = useState(() => peekSettings()?.sidebar_nav || '')
  const [moreOpen, setMoreOpen] = useState(false)
  const { visible: visibleNav, hidden: hiddenNav } = splitSidebarNav(sidebarNavOrder(sidebarNavValue))
  
  const { user, openAuth, logout } = useAppStore()
  const hasLikedSongs = usePlayerStore(state => state.likedIds.size > 0)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const pins = readPlaylistPins(user?.id)
  const pinned = new Set(pins)
  const togglePin = key => {
    const next = new Set(readPlaylistPins(user?.id))
    if (next.has(key)) next.delete(key)
    else next.add(key)
    try { localStorage.setItem(pinStorageKey(user?.id), JSON.stringify([...next])) } catch { return }
    updatePlaylistPreferences(value => value + 1)
  }
  const searchWords = collapsed ? [] : playlistQuery.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  const matches = playlist => {
    const name = String(playlist.name || playlist.title || '').toLocaleLowerCase()
    return searchWords.every(word => name.includes(word))
  }
  const toggleCollapsed = () => setCollapsed(value => {
    writeViewState('sidebar:collapsed', value ? '0' : '1')
    return !value
  })
  const togglePlaylistSearch = () => {
    if (collapsed) toggleCollapsed()
    const open = collapsed || !playlistSearchOpen
    setPlaylistSearchOpen(open)
    if (!open) setPlaylistQuery('')
  }
  // "+" on the collapsed sidebar: open it, with the new playlist's name to type.
  const startNewPlaylist = () => {
    if (collapsed) toggleCollapsed()
    setShowNewPlaylist(value => (collapsed ? true : !value))
  }

  const isNavItemActive = (path) => {
    if (path === '/') return loc.pathname === '/' || loc.pathname.startsWith('/home/')
    if (path === '/artists') {
      return loc.pathname === '/artists' || loc.pathname.startsWith('/artist/')
    }
    return loc.pathname === path
  }


  // The main-process cache survives restarts. Auto-update is opt-in and
  // at most daily; returning to the sidebar never fetches again by default.
  useEffect(() => {
    if (!api.isElectron) return
    let alive = true
    let request = 0
    const load = async (force = false, manual = false) => {
      const seq = ++request
      if (force) setSpotifyLoading(true)
      try {
        const result = await api.spotifyLibraryPlaylists(force)
        if (!alive || seq !== request) return
        if (Array.isArray(result?.playlists)) setSpotifyPlaylists(result.playlists)
        else if (!manual) setSpotifyPlaylists([])
        setSpotifyAccountId(result?.accountId || '')
        setSpotifyError(result?.error || '')
        // Populate from disk first, then perform one quiet due update.
        if (!force && result?.refreshDue) void load(true)
      } catch (error) {
        if (alive && seq === request) setSpotifyError(error.message || (manual ? 'Could not refresh Spotify playlists.' : 'Could not load Spotify playlists.'))
      } finally {
        if (alive && seq === request) setSpotifyLoading(false)
      }
    }
    spotifyPlaylistLoad.current = load
    void load()
    const refresh = () => { void load() } // settings edits are not forced resyncs
    const accessChanged = () => {
      setSpotifyAccountId('')
      setSpotifyPlaylists([])
      setSpotifyLoading(true)
      void load()
    }
    window.addEventListener('lokal:settings-saved', refresh)
    window.addEventListener('lokal:recommendation-access-changed', accessChanged)
    window.addEventListener('lokal:spotify-playlists-update', refresh)
    return () => {
      alive = false
      spotifyPlaylistLoad.current = null
      window.removeEventListener('lokal:settings-saved', refresh)
      window.removeEventListener('lokal:spotify-playlists-update', refresh)
      window.removeEventListener('lokal:recommendation-access-changed', accessChanged)
    }
  }, [])

  const refreshSpotifyPlaylists = () => {
    if (spotifyLoading) return
    void spotifyPlaylistLoad.current?.(true, true)
  }

  useEffect(() => {
    if (!api.isElectron) return
    let alive = true
    let counter = 0
    const load = async (force = false, manual = false) => {
      const number = ++counter
      if (force) setYoutubeLoading(true)
      try {
        const response = await api.youtubeLibraryPlaylists(force)
        if (!alive || counter !== number) return
        if (Array.isArray(response?.playlists)) setYoutubePlaylists(response.playlists)
        else if (!manual) setYoutubePlaylists([])
        setYoutubeAccountId(response?.accountId || '')
        setYoutubeError(response?.error || '')
        if (!force && response?.refreshDue) void load(true)
      } catch (error) {
        if (alive && counter === number) setYoutubeError(error.message || (manual ? 'Could not refresh YouTube Music playlists.' : 'Could not read YouTube Music playlists.'))
      } finally { if (alive && counter === number) setYoutubeLoading(false) }
    }
    youtubePlaylistLoad.current = load
    void load()
    const refresh = () => { void load() }
    const accessChanged = () => {
      setYoutubeAccountId('')
      setYoutubePlaylists([])
      setYoutubeLoading(true)
      void load()
    }
    window.addEventListener('lokal:settings-saved', refresh)
    window.addEventListener('lokal:recommendation-access-changed', accessChanged)
    return () => {
      alive = false
      youtubePlaylistLoad.current = null
      window.removeEventListener('lokal:settings-saved', refresh)
      window.removeEventListener('lokal:recommendation-access-changed', accessChanged)
    }
  }, [])

  const refreshYoutubePlaylists = () => {
    if (youtubeLoading) return
    void youtubePlaylistLoad.current?.(true, true)
  }

  const localPlaylistLoad = useRef(0)
  const loadPlaylists = () => {
    const request = ++localPlaylistLoad.current
    api.getPlaylists(user?.id).then(rows => {
      if (request === localPlaylistLoad.current) setPlaylists(Array.isArray(rows) ? rows : [])
    }).catch(() => {})
  }

  useEffect(() => {
    setPlaylists([])
    loadPlaylists()
    return () => { localPlaylistLoad.current++ }
  }, [user?.id])

  useEffect(() => {
    const reloadSidebarNav = () => {
      const cached = peekSettings()?.sidebar_nav
      if (cached !== undefined) setSidebarNavValue(cached || '')
      else api.getSettings().then(values => setSidebarNavValue(values?.sidebar_nav || '')).catch(() => {})
    }
    reloadSidebarNav()
    window.addEventListener('lokal:settings-saved', reloadSidebarNav)
    return () => window.removeEventListener('lokal:settings-saved', reloadSidebarNav)
  }, [])

  useEffect(() => {
    const handler = () => loadPlaylists();
    const createdHandler = (e) => {
      loadPlaylists();
      const pl = e?.detail?.playlistId;
      if (pl) nav(`/playlist/${pl}`);
    };

    window.addEventListener('lokal:playlist-created', createdHandler);
    window.addEventListener('lokal:playlists-changed', handler);
    window.addEventListener('lokal:playlist-deleted', handler);
    window.addEventListener('lokal:playlist-updated', handler);
    window.addEventListener('lokal:refresh', handler);

    return () => {
      window.removeEventListener('lokal:playlist-created', createdHandler);
      window.removeEventListener('lokal:playlists-changed', handler);
      window.removeEventListener('lokal:playlist-deleted', handler);
      window.removeEventListener('lokal:playlist-updated', handler);
      window.removeEventListener('lokal:refresh', handler);
    };
  }, [user?.id]);

  useEffect(() => {
    if (!confirmSignOut) return
    const timer = setTimeout(() => setConfirmSignOut(false), 2500)
    return () => clearTimeout(timer)
  }, [confirmSignOut])

  useEffect(() => {
    setConfirmSignOut(false)
  }, [user?.id])

  useEffect(() => {
    let alive = true
    const syncRecapBadge = async () => {
      // The latest finished period with plays (same rule as the Recap page).
      let latest = ''
      try {
        const result = await api.getListeningDays(user?.id || 'guest', { tz: listenerTimeZone() })
        latest = latestPeriod(recapTree(Array.isArray(result?.days) ? result.days : []))?.id || ''
        if (latest) localStorage.setItem('lokal-recap-latest-completed', latest)
      } catch {}
      if (!alive) return
      // Only for a new recap that hasn't been opened yet.
      setShowRecapBadge(Boolean(latest) && !recapOpened(latest, user?.id))
    }
    // Check again when the next period ends (e.g. Monday 00:00), and when
    // the app comes back (a timer doesn't fire while the computer sleeps).
    let boundaryTimer = null
    const scheduleNext = () => {
      clearTimeout(boundaryTimer)
      const wait = Math.max(1000, nextPeriodBoundary().getTime() - Date.now() + 1000)
      boundaryTimer = setTimeout(() => { syncRecapBadge(); scheduleNext() }, Math.min(wait, 2 ** 31 - 1))
    }
    const onResume = () => {
      if (document.visibilityState === 'hidden') return
      syncRecapBadge()
      scheduleNext()
    }
    syncRecapBadge()
    scheduleNext()
    window.addEventListener('storage', syncRecapBadge)
    window.addEventListener('lokal:recap-viewed', syncRecapBadge)
    window.addEventListener('lokal:recap-periods-changed', syncRecapBadge)
    window.addEventListener('focus', onResume)
    document.addEventListener('visibilitychange', onResume)
    return () => {
      window.removeEventListener('storage', syncRecapBadge)
      window.removeEventListener('lokal:recap-viewed', syncRecapBadge)
      window.removeEventListener('lokal:recap-periods-changed', syncRecapBadge)
      window.removeEventListener('focus', onResume)
      document.removeEventListener('visibilitychange', onResume)
      clearTimeout(boundaryTimer)
      alive = false
    }
  }, [user?.id])

  const createPlaylist = async () => {
    if (!newPlName.trim()) return

    const pl = await api.createPlaylist(newPlName.trim(), user?.id)

    if (pl?.id) {
      window.dispatchEvent(
        new CustomEvent('lokal:playlists-changed', {
          detail: { playlistId: pl.id, action: 'created' }
        })
      )

      nav(`/playlist/${pl.id}`)
    }

    setNewPlName('')
    setShowNewPlaylist(false)
  }

  const handleSignOut = () => {
    if (!confirmSignOut) {
      setConfirmSignOut(true)
      return
    }
    setConfirmSignOut(false)
    logout()
  }

  const renderLocalRow = pl => {
    const key = `local:${pl.id}`
    return (
      <div key={key} className="group flex items-center" onDragOver={(e) => { if (pl.smart_rules) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
        onDrop={async (e) => {
          e.preventDefault()
          if (pl.smart_rules) return
          try {
            const data = JSON.parse(e.dataTransfer.getData('application/json') || '{}')
            if (data.type === 'tracks' && data.tracks) {
              for (const track of data.tracks) {
                await api.addToPlaylist(pl.id, track.id)
              }
              loadPlaylists()
            }
          } catch (err) { console.error('Drop error:', err) }
        }}>
        <button onClick={() => nav(`/playlist/${pl.id}`)}
          title={collapsed ? pl.name : undefined}
          aria-label={collapsed ? pl.name : undefined}
          className={`min-w-0 flex-1 flex items-center gap-2.5 py-2 rounded-lg text-xs transition-all group ${collapsed ? 'justify-center px-0' : 'px-2'} ${loc.pathname === `/playlist/${pl.id}` ? 'bg-accent/10 text-accent' : 'text-muted hover:text-white hover:bg-elevated'}`}>
          <PlaylistCover playlistId={pl.id} coverPath={pl.cover_path} size={28} className="flex-shrink-0 rounded" />
          {!collapsed && <span className="truncate">{pl.name}</span>}
          {!collapsed && pl.smart_rules && <Sparkles size={11} className="ml-auto flex-shrink-0 text-accent/70" aria-label={t("Smart playlist")} />}
        </button>
        {!collapsed && <PinButton pinned={pinned.has(key)} name={pl.name} onClick={() => togglePin(key)} />}
      </div>
    )
  }
  const renderProviderRow = (provider, accountId, hidden, pl) => {
    const key = `${provider}:${pl.id}`
    const off = hidden.has(pl.id)
    return <ProviderPlaylistRow key={key} pl={pl} provider={provider} off={off} collapsed={collapsed}
      nav={nav} pathname={loc.pathname} pinned={pinned.has(key)} onPin={() => togglePin(key)}
      onHide={() => {
        setPlaylistHidden(provider, accountId, pl.id, !off)
        updatePlaylistPreferences(value => value + 1)
      }} />
  }
  const providers = api.isElectron ? [
    { provider: 'spotify', title: 'Spotify', playlists: spotifyPlaylists, accountId: spotifyAccountId, loading: spotifyLoading, error: spotifyError, refresh: refreshSpotifyPlaylists },
    { provider: 'youtube', title: 'YouTube', playlists: youtubePlaylists, accountId: youtubeAccountId, loading: youtubeLoading, error: youtubeError, refresh: refreshYoutubePlaylists },
  ].filter(section => section.accountId).map(section => ({
    ...section,
    rows: section.playlists.filter(matches),
    hidden: new Set(hiddenPlaylistIds(section.provider, section.accountId)),
  })) : []
  const localRows = playlists.filter(matches)
  const matchingPins = new Map(localRows.filter(pl => pinned.has(`local:${pl.id}`))
    .map(pl => [`local:${pl.id}`, renderLocalRow(pl)]))
  for (const { provider, accountId, hidden, rows } of providers) {
    for (const pl of rows) {
      const key = `${provider}:${pl.id}`
      if (pinned.has(key) && !hidden.has(pl.id)) matchingPins.set(key, renderProviderRow(provider, accountId, hidden, pl))
    }
  }
  const likedMatches = hasLikedSongs && matches({ name: t('Liked Songs') })
  const noMatches = searchWords.length > 0 && !likedMatches && !localRows.length && providers.every(section => !section.rows.length)

  return (
    <aside
      aria-label={t("Sidebar")}
      className={`${collapsed ? 'w-[4.5rem]' : freeform ? '' : 'w-56'} relative border-r border-border flex flex-col h-full pb-[var(--player-space,0px)] flex-shrink-0 overflow-hidden ${freeform ? '' : 'transition-[width] duration-200 ease-out'}`}
      style={{ backgroundColor: 'rgba(var(--surface-rgb), 0.85)', backdropFilter: 'blur(12px)', ...(freeform && !collapsed ? { width: panelWidth } : {}) }}
    >
      {!collapsed && <PanelResizeHandle side="left" />}
      <div className={`${collapsed ? 'px-0' : 'px-5'} py-4 flex-shrink-0`}>
        <div className={`flex items-center gap-2 ${collapsed ? 'flex-col' : ''}`}>
          {/* The logo's sticker takes the theme's accent colour: an accent
              layer cut to the sticker's shape (lokal-icon-sticker.png) over it. */}
          <div className="relative w-7 h-7 flex-shrink-0 rounded-full overflow-hidden">
            <img src="lokal-icon.png" alt={t("Lokal")} className="w-7 h-7" />
            <span
              aria-hidden="true"
              className="absolute inset-0"
              style={{
                background: 'var(--accent)',
                WebkitMaskImage: "url('lokal-icon-sticker.png')",
                WebkitMaskSize: '100% 100%',
                maskImage: "url('lokal-icon-sticker.png')",
                maskSize: '100% 100%',
              }}
            />
          </div>
          {!collapsed && <span className="font-display text-sm uppercase tracking-widest text-white">{t("Lokal")}</span>}
          <button
            onClick={toggleCollapsed}
            title={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
            aria-label={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
            aria-expanded={!collapsed}
            className={`${collapsed ? 'mt-1' : 'ml-auto'} flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-white`}
          >
            {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        </div>
      </div>

      <div className="px-3 mb-2 flex-shrink-0">
        {collapsed ? (
          user ? (
            <button
              onClick={() => nav('/profile')}
              title={`Your profile (${user.display_name || user.username})`}
              aria-label={t("Your profile")}
              aria-current={loc.pathname === '/profile' ? 'page' : undefined}
              className={`mx-auto flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${loc.pathname === '/profile' ? 'bg-accent/15' : 'hover:bg-elevated'}`}
            >
              <img src={api.getAvatarSrc(user)} alt="" className="h-7 w-7 rounded-full object-cover" />
            </button>
          ) : (
            <button onClick={() => openAuth('login')} title={t('Sign In / Register')} aria-label={t('Sign In / Register')}
              className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-all hover:bg-elevated hover:text-white">
              <LogIn size={15} />
            </button>
          )
        ) : user ? (
          <div className="space-y-2 rounded-lg px-2 py-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => nav('/profile')}
                title={t("Your profile")}
                aria-current={loc.pathname === '/profile' ? 'page' : undefined}
                className={`-mx-1 flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left transition-colors ${loc.pathname === '/profile' ? 'bg-accent/15' : 'hover:bg-elevated'}`}
              >
                <img 
                  src={api.getAvatarSrc(user)} 
                  alt={t("Profile")} 
                  className="w-7 h-7 rounded-full flex-shrink-0 object-cover" 
                />
                <p className="text-xs text-white truncate flex-1">{user.display_name || user.username}</p>
              </button>
              
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={handleSignOut}
                  title={confirmSignOut ? t('Confirm sign out') : t('Sign out')}
                  className={`transition-colors ${confirmSignOut ? 'text-red-400' : 'text-muted hover:text-red-400'}`}
                >
                  <LogOut size={13} />
                </button>
              </div>
            </div>

            {confirmSignOut && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2">
                <p className="text-[10px] font-display uppercase tracking-widest text-red-300">{t('Are you sure?')}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={handleSignOut}
                    className="flex-1 rounded-lg bg-red-500/20 px-2 py-1.5 text-[11px] font-medium text-red-200 hover:bg-red-500/30 transition-colors"
                  >
                    Sign Out
                  </button>
                  <button
                    onClick={() => setConfirmSignOut(false)}
                    className="flex-1 rounded-lg border border-border bg-card px-2 py-1.5 text-[11px] text-muted hover:text-white transition-colors"
                  >
                    {t('Cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <button onClick={() => openAuth('login')}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted hover:text-white hover:bg-elevated transition-all">
            <LogIn size={14} /> {t('Sign In / Register')}
          </button>
        )}
      </div>

      <nav className="px-3 space-y-0.5 flex-shrink-0">
        {visibleNav.map(({ icon, label, path, tour }) => (
          <NavItem key={path} icon={icon} label={t(label)} tour={tour} collapsed={collapsed}
            active={isNavItemActive(path)} onClick={() => nav(path === '/' ? getLastHomePath(user?.id) : path)}
            badge={path === '/recap' && showRecapBadge} />
        ))}
        {hiddenNav.length > 0 && (
          <>
            <NavItem icon={MoreHorizontal} label={t('More')} collapsed={collapsed}
              active={hiddenNav.some(item => isNavItemActive(item.path))} onClick={() => setMoreOpen(value => !value)} />
            {moreOpen && hiddenNav.map(({ icon, label, path, tour }) => (
              <NavItem key={path} icon={icon} label={t(label)} tour={tour} collapsed={collapsed}
                active={isNavItemActive(path)} onClick={() => nav(path === '/' ? getLastHomePath(user?.id) : path)}
                badge={path === '/recap' && showRecapBadge} />
            ))}
          </>
        )}
      </nav>

      <div className={`${collapsed ? 'mx-3' : 'mx-4'} my-2 border-t border-border flex-shrink-0`} />

      <div className="flex-1 overflow-y-auto px-3 min-h-0">
        <div className={`flex items-center py-2 ${collapsed ? 'justify-center' : 'justify-between px-1'}`}>
          {!collapsed && <p className="text-xs font-display text-muted uppercase tracking-widest">{t('Playlists')}</p>}
          <div className={`flex items-center ${collapsed ? 'flex-col gap-1' : 'gap-1'}`}>
            <button onClick={togglePlaylistSearch} title={t('Search playlists')} aria-label={t('Search playlists')}
              aria-expanded={!collapsed && playlistSearchOpen} className="rounded p-0.5 text-muted hover:text-white">
              <Search size={14} />
            </button>
            <button onClick={() => openSmartPlaylistEditor()} title={t('New smart playlist')} aria-label={t('New smart playlist')}
              className="text-muted hover:text-white transition-colors p-0.5 rounded">
              <Sparkles size={13} />
            </button>
            <button onClick={() => openPlaylistImport()} title={t('Import playlist')} aria-label={t('Import playlist')}
              className="text-muted hover:text-white transition-colors p-0.5 rounded">
              <Import size={13} />
            </button>
            <button onClick={startNewPlaylist} title={t('New playlist')} aria-label={t('New playlist')}
              className="text-muted hover:text-white transition-colors p-0.5 rounded">
              <Plus size={14} />
            </button>
          </div>
        </div>

        {playlistSearchOpen && !collapsed && <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1.5 focus-within:border-accent">
          <input autoFocus type="search" value={playlistQuery} onChange={event => setPlaylistQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') togglePlaylistSearch() }}
            aria-label={t('Search playlists')} placeholder={t('Search playlists')}
            className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden" />
          <button type="button" onClick={togglePlaylistSearch} aria-label={t('Close playlist search')} className="text-muted hover:text-white"><X size={13} /></button>
        </div>}

        {showNewPlaylist && !collapsed && (
          <div className="mb-2 flex gap-1.5">
            <input autoFocus value={newPlName} onChange={e => setNewPlName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createPlaylist(); if (e.key === 'Escape') setShowNewPlaylist(false) }}
              placeholder={t('Playlist name…')}
              className="flex-1 bg-card border border-border rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-accent/50 placeholder:text-muted/60" />
            <button onClick={createPlaylist}
              className="px-2 py-1 bg-accent text-base rounded-lg text-xs font-medium">{t('Add')}</button>
          </div>
        )}

        {matchingPins.size > 0 && <section aria-label={t('Pinned playlists')} className="mb-2">
          {!collapsed && <p className="px-1 text-xs font-display text-muted">{t('Pinned')}</p>}
          {pins.map(key => matchingPins.get(key))}
        </section>}
        {noMatches && <p role="status" className="px-2 py-2 text-xs text-muted">{t('No matching playlists.')}</p>}
        {likedMatches && <button onClick={() => nav('/playlist/liked')}
          title={collapsed ? t('Liked Songs') : undefined}
          aria-label={collapsed ? t('Liked Songs') : undefined}
          className={`w-full flex items-center gap-2.5 py-2 rounded-lg text-xs transition-all group ${collapsed ? 'justify-center px-0' : 'px-2'} ${loc.pathname === '/playlist/liked' ? 'bg-accent/10 text-accent' : 'text-muted hover:text-white hover:bg-elevated'}`}>
          <div className="w-7 h-7 rounded bg-accent/20 flex items-center justify-center flex-shrink-0">
            <Heart size={12} className="text-accent" fill="currentColor" />
          </div>
          {!collapsed && <span className="truncate font-medium">{t('Liked Songs')}</span>}
        </button>}

        {localRows.filter(pl => !pinned.has(`local:${pl.id}`)).map(renderLocalRow)}
        {providers.map(({ provider, title, rows, accountId, hidden, loading, error, refresh }) =>
          <ProviderPlaylistSection key={`${provider}:${accountId}`} title={title}
            playlists={rows.filter(pl => !pinned.has(`${provider}:${pl.id}`) || hidden.has(pl.id))}
            hidden={hidden} loading={loading} error={error} refresh={refresh} collapsed={collapsed}
            searching={searchWords.length > 0}
            renderRow={pl => renderProviderRow(provider, accountId, hidden, pl)} />)}
      </div>

    </aside>
  )
}
