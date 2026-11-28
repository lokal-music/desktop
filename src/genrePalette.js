/**
 * Semantic colour families for the editorial genre covers, matching mobile's
 * LokalGenrePalette. Dark chromatic surfaces keep white type legible
 * independently of the active theme or accent preset, and inserting a new
 * genre never recolours existing ones.
 */

export const GENRE_FOREGROUND = '#FFFFFF'

export const GENRE_TONES = Object.freeze([
  Object.freeze({ base: '#503787', highlight: '#8260D1', icon: 'graphic_eq', italic: false }),
  Object.freeze({ base: '#866011', highlight: '#966B18', icon: 'music_note', italic: false }),
  Object.freeze({ base: '#23503D', highlight: '#307755', icon: 'album', italic: true }),
  Object.freeze({ base: '#075B79', highlight: '#116C8F', icon: 'audiotrack', italic: false }),
  Object.freeze({ base: '#713B55', highlight: '#A45D7F', icon: 'music_video', italic: true }),
  Object.freeze({ base: '#514F80', highlight: '#5E68A0', icon: 'piano', italic: false }),
  Object.freeze({ base: '#854D28', highlight: '#985C35', icon: 'headphones', italic: false }),
  Object.freeze({ base: '#22586B', highlight: '#28748A', icon: 'equalizer', italic: true }),
  Object.freeze({ base: '#4C6224', highlight: '#60762F', icon: 'library_music', italic: false }),
  Object.freeze({ base: '#76404A', highlight: '#A9616D', icon: 'radio', italic: true }),
  Object.freeze({ base: '#36517A', highlight: '#496F9C', icon: 'music_note', italic: false }),
  Object.freeze({ base: '#604784', highlight: '#795F9E', icon: 'queue_music', italic: true }),
])

/**
 * Deterministic tone lookup mirroring mobile's LokalGenrePalette.of(name).
 */
export function genreToneFor(name) {
  const normalized = String(name || '').trim().toLowerCase()
  if (normalized.includes('jazz')) return GENRE_TONES[0]
  if (normalized.includes('afro')) return GENRE_TONES[1]
  if (normalized.includes('indie') || normalized.includes('alternative')) return GENRE_TONES[2]
  if (normalized.includes('r&b') || normalized.includes('soul')) return GENRE_TONES[3]
  if (normalized.includes('hip') || normalized.includes('rap')) return GENRE_TONES[7]
  if (normalized.includes('rock')) return GENRE_TONES[4]
  if (normalized.includes('electronic') || normalized.includes('dance')) return GENRE_TONES[5]
  if (normalized.includes('pop')) return GENRE_TONES[9]
  if (normalized.includes('classical')) return GENRE_TONES[10]
  if (normalized.includes('soundtrack')) return GENRE_TONES[11]
  let hash = 0
  for (let i = 0; i < normalized.length; i++) {
    hash = (Math.imul(hash, 31) + normalized.charCodeAt(i)) & 0x7fffffff
  }
  return GENRE_TONES[hash % GENRE_TONES.length]
}

/**
 * Exact gradient CSS value matching mobile's LinearGradient(topLeft -> bottomRight,
 * [highlight, base, base], stops: [0, 0.45, 1]).
 */
export function genreGradient(tone) {
  return `linear-gradient(135deg, ${tone.highlight} 0%, ${tone.base} 45%, ${tone.base} 100%)`
}
