const path = require('path')

// The old upload receiver used this private directory exclusively. Do not
// infer mobile provenance from a filename, tags, or an unrelated PC original
// which happened to match a phone copy.
function isMobileImportPath(filePath, storageDir) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false
  const relative = path.relative(path.join(storageDir, 'phone-downloads'), filePath)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

const MOBILE_SEGMENTS = new Set(['phone-downloads', 'lokal phone', 'lokal mobile'])
// True for files living in a mobile-copy folder: the legacy phone-downloads
// directory, the configured settings.phone_download_root, or any path segment
// named Lokal Phone / Lokal Mobile.
function isMobileFolderPath(filePath, { db, storageDir } = {}) {
  if (typeof filePath !== 'string' || !filePath) return false
  if (filePath.split(/[\\/]+/).some(part => MOBILE_SEGMENTS.has(part.toLowerCase()))) return true
  const roots = []
  if (storageDir) roots.push(path.join(storageDir, 'phone-downloads'))
  try {
    const value = db?.prepare("SELECT value FROM settings WHERE key = 'phone_download_root'").get()?.value
    if (value) roots.push(value)
  } catch { /* settings table may not exist */ }
  return roots.some(root => {
    if (!path.isAbsolute(filePath) || !path.isAbsolute(root)) return false
    const relative = path.relative(root, filePath)
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  })
}

function backfillMobileSources(db, storageDir) {
  const update = db.prepare("UPDATE tracks SET download_source='mobile' WHERE id=? AND download_source IS NULL")
  let changed = 0
  for (const row of db.prepare('SELECT id,file_path FROM tracks WHERE download_source IS NULL').iterate()) {
    if (isMobileImportPath(row.file_path, storageDir)) changed += Number(update.run(row.id).changes)
  }
  return changed
}
module.exports = { isMobileFolderPath, isMobileImportPath, backfillMobileSources }
