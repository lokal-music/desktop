'use strict'

/**
 * Find an existing indexed file matching the metadata AND physical audio
 * edition. Stereo and verified E-AC-3 JOC are independent library copies:
 * identical titles and durations are not enough to deduplicate them.
 *
 * AC-4 is a separate encoded edition without implying verified Atmos. Other
 * unknown/unverified media belongs to the ordinary (non-Atmos) edition.
 */
const AC4_CODEC_SQL = "LOWER(TRIM(COALESCE(codec, ''))) IN ('ac4', 'ac-4', '<ac4>', '<ac-4>')"

function isAc4Codec(codec) {
  return /^(?:ac-?4|<ac-?4>)$/i.test(String(codec || '').trim())
}

function recordingText(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[’‘`]/g, "'").replace(/[‐‑–—]/g, '-')
    .replace(/\s*\(original mix\)\s*$/i, '').replace(/\s+-\s+original mix\s*$/i, '')
    .replace(/\s+/g, ' ').trim()
}

function findAudioEditionDuplicate(db, { title, artist, album, duration, atmosVerified, codec, recordingMatch = false } = {}) {
  const edition = [atmosVerified === 1 ? 1 : 0, isAc4Codec(codec) ? 1 : 0]
  if (recordingMatch && duration > 0 && recordingText(title) && recordingText(artist)) {
    // Album packaging varies between providers. Preserve every mix/edit/live
    // qualifier; a loose token similarity score is unsafe for automatic reuse.
    const candidates = db.prepare(`SELECT * FROM tracks WHERE ABS(duration - ?) < 2 AND file_path NOT LIKE 'ghost://%' AND COALESCE(atmos_verified, 0) = ? AND (${AC4_CODEC_SQL}) = ?`)
      .all(Number(duration), ...edition)
      .filter(row => recordingText(row.title) === recordingText(title) && recordingText(row.artist) === recordingText(artist))
    return candidates.find(row => require('fs').existsSync(row.file_path)) || candidates[0]
  }
  const candidates = db.prepare(`SELECT * FROM tracks WHERE LOWER(title) = ? AND LOWER(artist) = ? AND (album IS NULL OR album = ? OR ? IS NULL) AND ABS(duration - ?) < 2 AND file_path NOT LIKE 'ghost://%' AND COALESCE(atmos_verified, 0) = ? AND (${AC4_CODEC_SQL}) = ?`)
    .all(String(title || '').toLowerCase(), String(artist || '').toLowerCase(), album || null, album || null, Number(duration) || 0, ...edition)
  return candidates.find(row => require('fs').existsSync(row.file_path)) || candidates[0]
}

module.exports = { findAudioEditionDuplicate, isAc4Codec, AC4_CODEC_SQL, recordingText }
