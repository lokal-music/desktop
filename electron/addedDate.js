// When a song joined the library lives in the file itself, in Lokal's own
// LOKAL_ADDED tag -- like the explicit mark and the music video (LOKAL_TRACK,
// see ./trackExtras.js): ID3v2 TXXX, a Vorbis field, an iTunes freeform atom.
// Other players ignore it. The value is the moment in UTC, ISO 8601
// ("2026-10-19T12:34:56Z"), readable in any tag editor.
//
// The tag is what the date is: a fresh library (or the same files on another
// computer) reads it back, so "New" and "Date added" survive a reinstall.
// tracks.added_at (seconds since 1970) stays as its copy in the library, for
// sorting and for the New tab's queries:
//   - a file read with the tag: added_at becomes the tag's date
//   - a new song read without it (the scan, the folder watcher, a single
//     file added): added_at is now, and that is written into the file
//     (stampAddedDates). A song already in the library is left as it is.
//   - a download or a file dropped onto a folder is added now: it gets now,
//     whatever tag it came with (someone else's library)
//   - a better copy replacing a song's file (lossless) isn't a new song: the
//     new file gets the song's own date, which doesn't change

const fs = require('fs')
const { isAc4Codec } = require('./quality/editionDuplicates')
const { isMobileFolderPath } = require('./mobileSource')
const { ensureTrackContentHashes, recordTrackContentHash } = require('./trackContentHashes')

const TAG = 'LOKAL_ADDED'
const IDS = new Set([`TXXX:${TAG}`, TAG, `----:com.apple.iTunes:${TAG}`])
// Older than this, or later than a day from now, is not a real "added" date.
const EARLIEST = Date.UTC(1990, 0, 1) / 1000

const tagText = (value) => (typeof value === 'string' ? value : value && typeof value.text === 'string' ? value.text : '')

/** The tag's text for a date (seconds since 1970). */
function toTag(seconds) {
  return new Date(Math.round(Number(seconds)) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** The tag's text as seconds since 1970, or null when it isn't a date. */
function parse(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  let seconds
  if (/^\d+(\.\d+)?$/.test(raw)) {
    // A bare number: seconds, or milliseconds when it's that big.
    const n = Number(raw)
    seconds = n > 1e11 ? n / 1000 : n
  } else {
    const ms = Date.parse(raw)
    if (!Number.isFinite(ms)) return null
    seconds = ms / 1000
  }
  if (!Number.isFinite(seconds) || seconds < EARLIEST || seconds > Date.now() / 1000 + 86400) return null
  return Math.floor(seconds)
}

/** The date in a music-metadata result (seconds since 1970), or null when the file has none. */
function fromMeta(meta) {
  for (const tag of Object.values(meta?.native || {}).flat()) {
    if (!tag || !(IDS.has(tag.id) || String(tag.id).toUpperCase() === TAG)) continue
    const values = Array.isArray(tag.value) ? tag.value : [tag.value]
    for (const value of values) {
      const seconds = parse(tagText(value))
      if (seconds != null) return seconds
    }
  }
  return null
}

/** The file's date (seconds since 1970), or null when it has none or can't be read. */
async function readAddedDate(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  try {
    const mm = require('./musicMetadata')
    return fromMeta(await mm.parseFile(filePath, { duration: false, skipCovers: true }))
  } catch { return null }
}

/** Writes the date (seconds since 1970) into the file's tags. Throws when the file can't be saved. */
function writeAddedDate(filePath, seconds) {
  let T
  try { T = require('node-taglib-sharp') } catch { throw new Error('Tag writer unavailable') }
  if (!filePath || !fs.existsSync(filePath)) throw new Error('File not found')
  if (!Number.isFinite(Number(seconds))) throw new Error('No date')
  const { setPrivateField } = require('./lyrics/fileLyrics')
  const { aimpSafeSylt } = require('./syltEncoding')
  let file
  try {
    file = T.File.createFromPath(filePath)
    const mp3 = /\.mp3$/i.test(filePath)
    const hadId3v1 = typeof file.tagTypesOnDisk === 'number' && (file.tagTypesOnDisk & T.TagTypes.Id3v1) !== 0
    setPrivateField(T, file, toTag(seconds), TAG)
    // taglib adds an ID3v1 tag to MP3s that never had one; don't.
    if (mp3 && !hadId3v1) { try { file.removeTags(T.TagTypes.Id3v1) } catch {} }
    aimpSafeSylt(T, file)
    file.save()
  } catch (e) {
    const busy = /EBUSY|EPERM|EACCES/i.test(String(e?.code || e?.message || ''))
    throw new Error(busy ? 'The file is in use or read-only' : (e?.message || String(e)))
  } finally {
    try { file?.dispose() } catch {}
  }
}

/**
 * A song just added to the library (downloaded, dropped onto a folder): its
 * file gets `seconds` (now by default). -> true when it was written; a file
 * that can't be written is left as it was.
 */
function stampNewFile(db, filePath, seconds = Math.floor(Date.now() / 1000), { log = console } = {}) {
  // AC-4 downloads retain their original MP4 atoms; date added stays in SQLite.
  if (/\.ac4\.(?:m4a|mp4)$/i.test(filePath)) return false
  try {
    writeAddedDate(filePath, seconds)
    if (db) require('./fileStamp').noteFileWritten(db, filePath)
    return true
  } catch (e) {
    log.warn?.(`[addedDate] couldn't write ${filePath}: ${e.message}`)
    return false
  }
}

/** A file read with the tag: the library's date becomes the tag's. */
function applyToRow(db, trackId, seconds) {
  if (seconds == null) return
  db.prepare('UPDATE tracks SET added_at = ? WHERE id = ?').run(seconds, trackId)
}

/**
 * Files read without the tag get the library's date (tracks.added_at) written
 * into them. -> { written, failed }. A file that's busy is tried again the
 * next time it's read without the tag. Writing is slow (taglib may rewrite the
 * whole file), so it lets the app breathe between files.
 */
function recordHash(db, trackId, filePath) {
  try {
    ensureTrackContentHashes(db)
    const bytes = fs.readFileSync(filePath)
    recordTrackContentHash(db, trackId, require('crypto').createHash('sha256').update(bytes).digest('hex'), bytes.length)
  } catch { /* identity is best-effort; never block stamping */ }
}

async function stampAddedDates(db, filePaths, { log = console } = {}) {
  const rowOf = db.prepare("SELECT * FROM tracks WHERE file_path = ? AND file_path NOT LIKE 'ghost://%'")
  const { noteFileWritten } = require('./fileStamp')
  let written = 0
  let failed = 0
  for (const filePath of filePaths) {
    const row = rowOf.get(filePath)
    if (isAc4Codec(row?.codec) || /\.ac4\.(?:m4a|mp4)$/i.test(filePath)) continue
    let seconds = Number(row?.added_at)
    if (!row || !Number.isFinite(seconds) || seconds <= 0) continue
    // An old row may hold milliseconds.
    if (seconds > 1e11) seconds = Math.floor(seconds / 1000)
    if (!fs.existsSync(filePath)) continue
    // Phone copies must stay byte-identical to what the phone sent.
    if (row.download_source === 'mobile' || isMobileFolderPath(filePath, { db })) continue
    await new Promise(resolve => setImmediate(resolve))
    try {
      recordHash(db, row.id, filePath)
      writeAddedDate(filePath, seconds)
      recordHash(db, row.id, filePath)
      noteFileWritten(db, filePath)
      written++
    } catch (e) {
      failed++
      log.warn?.(`[addedDate] couldn't write ${filePath}: ${e.message}`)
    }
  }
  return { written, failed }
}

module.exports = { TAG, toTag, parse, fromMeta, readAddedDate, writeAddedDate, stampNewFile, applyToRow, stampAddedDates }
