// Settings > Library > "Delete files too": when a song is deleted in Lokal,
// its file goes as well. Off by default. Only files inside the music folder
// are touched (anything else is left alone and reported). The desktop app
// moves them to the Recycle Bin / Trash; the web server, which has no trash,
// deletes them for good.

const fs = require('fs-extra')
const path = require('path')

function deleteFilesEnabled(db) {
  try { return db.prepare("SELECT value FROM settings WHERE key = 'delete_files_from_disk'").get()?.value === '1' } catch { return false }
}

function musicFolder(db) {
  try { return db.prepare("SELECT value FROM settings WHERE key = 'music_folder'").get()?.value || '' } catch { return '' }
}

/** true when `file` is strictly inside `folder` (after resolving . and ..). */
function isInside(file, folder) {
  if (!file || !folder) return false
  const rel = path.relative(path.resolve(folder), path.resolve(file))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

async function moveToTrash(file) {
  let shell = null
  if (process.versions.electron) {
    try { shell = require('electron').shell } catch {}
  }
  if (shell?.trashItem) return shell.trashItem(file)
  return fs.remove(file)
}

const SIDECAR_EXTENSIONS = ['.lrc', '.elrc', '.ttml', '.txt']

function settingValue(db, key) {
  try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '' } catch { return '' }
}

/**
 * Every folder in which Lokal may delete audio: the music folders plus the
 * download and phone-download folders it manages itself.
 */
function authorizedRoots(db) {
  const roots = []
  try { roots.push(...require('../libraryFolder').configuredMusicRoots(db)) } catch { const legacy = musicFolder(db); if (legacy) roots.push(legacy) }
  for (const key of ['download_root', 'phone_download_root']) {
    const value = settingValue(db, key)
    if (value) roots.push(value)
  }
  try {
    const storage = require('./db').getStorageDir()
    if (storage) roots.push(path.join(storage, 'phone-downloads'))
  } catch {}
  return [...new Set(roots.map(root => path.resolve(root)))]
}

/** Lyrics/text files that sit beside an audio file and no other library track uses. */
async function sidecarsFor(db, file) {
  const base = file.slice(0, file.length - path.extname(file).length)
  const escaped = base.replace(/[\\%_]/g, '\\$&')
  let users = []
  try { users = db.prepare("SELECT file_path FROM tracks WHERE file_path LIKE ? ESCAPE '\\'").all(escaped + '.%') } catch {}
  const shared = users.some(row => row.file_path !== file)
  if (shared) return []
  const found = []
  for (const extension of SIDECAR_EXTENSIONS) {
    const sidecar = base + extension
    if (await fs.pathExists(sidecar)) found.push(sidecar)
  }
  return found
}

/**
 * Moves files to the Trash when they are inside an authorized root (by real
 * path), together with their sidecars. Files elsewhere are left alone.
 */
async function trashFilesInRoots(db, filePaths) {
  const roots = authorizedRoots(db)
  const realRoots = []
  for (const root of roots) { const real = await fs.realpath(root).catch(() => null); if (real) realRoots.push({ root, real }) }
  const result = { removed: [], skipped: [], failed: [] }
  for (const file of [...new Set((filePaths || []).filter(Boolean))]) {
    if (/^(ghost|stream):\/\//.test(file) || !roots.some(root => isInside(file, root))) { result.skipped.push(file); continue }
    try {
      if (!(await fs.pathExists(file))) continue
      const realFile = await fs.realpath(file)
      if (!realRoots.some(({ root, real }) => isInside(file, root) && isInside(realFile, real))) { result.skipped.push(file); continue }
      const sidecars = await sidecarsFor(db, file)
      await moveToTrash(file)
      result.removed.push(file)
      for (const sidecar of sidecars) { try { await moveToTrash(sidecar) } catch {} }
    } catch {
      result.failed.push(file)
    }
  }
  return result
}

/**
 * Deletes the files of songs just removed from the library, if the setting is
 * on. Returns { removed, skipped, failed } (paths), or null when it's off.
 */
async function removeTrackFiles(db, filePaths) {
  if (!deleteFilesEnabled(db)) return null
  return trashFilesInRoots(db, filePaths)
}

/**
 * Tells the download queue these songs are gone, so a finished download of
 * them stops showing as saved (and can be downloaded again).
 */
function forgetDownloads(trackIds) {
  try { require('../download/manager').getDownloadManager().forgetTracks(trackIds) } catch {}
}

module.exports = { moveToTrash, removeTrackFiles, trashFilesInRoots, authorizedRoots, sidecarsFor, forgetDownloads, deleteFilesEnabled, isInside }
