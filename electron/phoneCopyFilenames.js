const fs = require('node:fs')
const path = require('node:path')
const { phoneFileName } = require('../server/phoneFileNaming')
const { cleanTransferMetadata } = require('./transferArtifacts')

// One-time-in-place repair of older phone uploads saved as bare UUID names.
// Updates the file path, never the track ID, tags, artwork, likes or playlists.
// Safe to retry: once renamed, the path no longer matches the UUID pattern.

function repairPhoneCopyFilenames(db, storageDir) {
  const directory = path.resolve(storageDir, 'phone-downloads');
  const rows = db.prepare('SELECT id, file_path, title, artist FROM tracks WHERE file_path LIKE ?')
    .all('%phone-downloads%');
  const update = db.prepare('UPDATE tracks SET file_path = ? WHERE id = ? AND file_path = ?');
  let repaired = 0;
  for (const row of rows) {
    if (!row.file_path || path.dirname(path.resolve(row.file_path)) !== directory) continue;
    const oldName = path.basename(row.file_path);
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z0-9]{1,8})$/i.exec(oldName);
    if (!match || !fs.existsSync(row.file_path)) continue;
    const name = phoneFileName({
      artist: row.artist,
      title: row.title,
      extension: match[2],
    });
    const dot = name.lastIndexOf('.');
    const stem = name.slice(0, dot), ext = name.slice(dot);
    for (let suffix = 1; suffix <= 10000; suffix++) {
      const candidate = path.join(directory, `${stem}${suffix === 1 ? '' : ` (${suffix})`}${ext}`);
      try {
        // Atomic no-overwrite hard link, so failure always leaves the old
        // file and its database reference intact.
        fs.linkSync(row.file_path, candidate);
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        console.warn('[phone-copy] Could not repair filename:', error.message);
        break;
      }
      let changed = false;
      try {
        changed = update.run(candidate, row.id, row.file_path).changes === 1;
      } catch (error) {
        console.warn('[phone-copy] Could not update library path:', error.message);
      }
      if (!changed) {
        fs.unlinkSync(candidate);
        break;
      }
      // The new hard link already contains exactly the same bytes, so a failed
      // removal of the legacy pathname cannot lose an audio file.
      try { fs.unlinkSync(row.file_path); }
      catch (error) { console.warn('[phone-copy] Old filename remains:', error.message); }
      repaired++;
      break;
    }
  }
  repairPollutedMobileMetadata(db);
  return repaired;
}

// Clean machine suffixes / placeholder artists left in mobile rows' titles and
// artists. Never touches the file, its hash, or the track ID.
function repairPollutedMobileMetadata(db) {
  try {
    const rows = db.prepare("SELECT id, title, artist FROM tracks WHERE download_source = 'mobile'").all();
    const update = db.prepare('UPDATE tracks SET title = ?, artist = ? WHERE id = ?');
    for (const row of rows) {
      const next = cleanTransferMetadata({ title: row.title, artist: row.artist });
      if (!next.cleaned || !next.title.trim()) continue;
      update.run(next.title, next.artist, row.id);
    }
  } catch (error) { console.warn('[phone-copy] Could not clean mobile metadata:', error.message); }
}

module.exports = { repairPhoneCopyFilenames }
