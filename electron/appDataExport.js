// Shared, import-compatible app-data export for manual and scheduled backups.
// No Electron/renderer dependencies: the worker opens its own read-only DB.
const fs = require('node:fs')
const path = require('node:path')

const SECRET_SETTING_KEYS = new Set([
  'soulseek_api_key', 'soulseek_password', 'spicylyrics_api_key',
  'spotify_sp_dc', 'apple_music_user_token', 'listenbrainz_token',
  'lastfm_api_secret', 'lastfm_session_key', 'yt_cookie_header',
])

function toDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  const ext = path.extname(filePath).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`
}

/** Scheduled/web backups omit credentials; native manual exports can opt in. */
function exportAppData(db, { includeCredentials = false } = {}) {
  const theme = db.prepare("SELECT value FROM settings WHERE key = 'theme'").get()?.value || 'dark'
  let themeOverrides = {}
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'theme_overrides'").get()?.value
    themeOverrides = raw ? JSON.parse(raw) : {}
  } catch {}
  const users = db.prepare('SELECT id, username, display_name, avatar_path, bio, created_at, password_hash FROM users ORDER BY created_at DESC').all().map(user => ({
    ...user,
    avatar_data: toDataUrl(user.avatar_path),
  }))
  return {
    exported_at: Date.now(),
    version: 1,
    theme,
    theme_overrides: themeOverrides,
    settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().filter(row => includeCredentials || !SECRET_SETTING_KEYS.has(row.key)).map(row => [row.key, row.value])),
    users,
    user_settings: db.prepare('SELECT user_id, key, value FROM user_settings ORDER BY user_id, key').all(),
    playlists: db.prepare('SELECT * FROM playlists ORDER BY created_at DESC').all().map(playlist => ({
      ...playlist,
      cover_data: toDataUrl(playlist.cover_path),
    })),
    playlist_tracks: db.prepare('SELECT * FROM playlist_tracks ORDER BY playlist_id, position, id').all(),
    user_likes: db.prepare('SELECT * FROM user_likes ORDER BY user_id, liked_at DESC').all(),
    play_history: db.prepare('SELECT * FROM play_history ORDER BY played_at DESC').all(),
    listening_events: db.prepare('SELECT * FROM listening_events ORDER BY created_at DESC').all(),
    artists: db.prepare('SELECT * FROM artists ORDER BY name').all(),
    artist_track_links: db.prepare('SELECT * FROM artist_track_links ORDER BY artist_id, track_id').all(),
    tracks: db.prepare('SELECT * FROM tracks ORDER BY added_at DESC').all(),
  }
}

module.exports = { exportAppData, SECRET_SETTING_KEYS }
