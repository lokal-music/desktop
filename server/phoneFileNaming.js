const path = require('node:path')
const { link } = require('node:fs/promises')
const { cleanTransferStem, cleanTransferMetadata } = require('../electron/transferArtifacts')

function sanitizeStem(value) {
  return Array.from(String(value ?? '').normalize('NFC')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')).slice(0, 160).join('').replace(/[. ]+$/g, '');
}

function phoneFileName({ originalFilename, artist, title, extension }) {
  const ext = String(extension || '').toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error('Invalid audio extension');
  let stem = '';
  if (typeof originalFilename === 'string' && originalFilename.length <= 1024) {
    const leaf = originalFilename.replace(/\\/g, '/').split('/').pop() || '';
    const lastDot = leaf.lastIndexOf('.');
    if (lastDot > 0 && leaf.slice(lastDot + 1).toLowerCase() === ext) {
      const proposed = sanitizeStem(cleanTransferStem(sanitizeStem(leaf.slice(0, lastDot))));
      // Temporary/staging filenames are identifiers, not user-facing names.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proposed)) {
        stem = proposed;
      }
    }
  }
  if (!stem) {
    const cleaned = cleanTransferMetadata({ title, artist });
    const safeArtist = sanitizeStem(cleaned.artist) || 'Unknown Artist';
    const safeTitle = sanitizeStem(cleaned.title) || 'Unknown Track';
    stem = sanitizeStem(`${safeArtist} - ${safeTitle}`);
  }
  if (!stem) stem = 'Track';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
  return `${stem}.${ext}`;
}

async function reservePhoneDestination(partial, directory, filename) {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) throw new Error('Invalid phone filename');
  const stem = filename.slice(0, dot);
  const ext = filename.slice(dot);
  for (let suffix = 1; suffix <= 10000; suffix++) {
    const candidate = path.join(directory, `${stem}${suffix === 1 ? '' : ` (${suffix})`}${ext}`);
    try {
      // Same-directory hard link is atomic and refuses to replace an existing
      // file. The staged path is removed after DB commit/rollback.
      await link(partial, candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Too many files with the same name.');
}

module.exports = { phoneFileName, reservePhoneDestination }
