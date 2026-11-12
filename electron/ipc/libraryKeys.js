// What the library has as files, in short: each song's artist, title, where
// it was downloaded from (source_ref, e.g. "yt:<videoId>") and whether its
// file is low quality (the Audio Quality page's "low" tier, or a lossless
// file found to come from a lossy source). The save buttons of streamed songs
// (Search, Home, the player) check it to show "In your library", or to offer
// a better copy of a low-quality one, before anything is clicked.

const { getDB } = require('./db')
const quality = require('../quality')

/** [[artist, title, source_ref, low (0/1)], ...] of the library's files (not streamed or imported songs). */
function libraryKeys(db = getDB()) {
  try { quality.ensureColumns(db) } catch {}
  let rows = []
  try {
    rows = db.prepare("SELECT artist, title, source_ref, lossless, bitrate, codec, bit_depth, sample_rate, spectral_verdict FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND COALESCE(atmos_verified, 0) != 1").all()
  } catch {
    // An older library without these columns.
    try { rows = db.prepare("SELECT artist, title FROM tracks WHERE file_path NOT LIKE 'ghost://%'").all() } catch {}
  }
  return rows.map(row => {
    const low = quality.tierOf(row) === 'low' || (Number(row.lossless) === 1 && row.spectral_verdict === 'lossy')
    return [row.artist || '', row.title || '', row.source_ref || null, low ? 1 : 0]
  })
}

function registerLibraryKeysHandlers(ipcMain) {
  ipcMain.handle('library:keys', () => libraryKeys())
  ipcMain.handle('library:owned', (_, candidates) => require('../libraryOwned').findOwnedTracks(getDB(), candidates))
}

module.exports = { libraryKeys, registerLibraryKeysHandlers }
