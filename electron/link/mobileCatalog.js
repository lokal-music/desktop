'use strict'

const { text, trackKey } = require('./protocol')

const MAX_ITEMS = 250
const MAX_SNAPSHOT = 50000

function createMobileCatalog(db, store) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS link_mobile_catalog (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      track_key TEXT NOT NULL,
      track_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, device_id, track_key)
    );
    CREATE INDEX IF NOT EXISTS link_mobile_catalog_track ON link_mobile_catalog(user_id, track_id);
  `)
  let hasDiscNum = false
  try {
    hasDiscNum = db.prepare('PRAGMA table_info(tracks)').all().some(col => col.name === 'disc_num')
    if (!hasDiscNum) {
      db.exec('ALTER TABLE tracks ADD COLUMN disc_num INTEGER')
      hasDiscNum = true
    }
  } catch {}

  const insert = db.prepare(`
    INSERT INTO link_mobile_catalog
      (user_id,device_id,track_key,track_id,snapshot_id,updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id,device_id,track_key) DO UPDATE SET
      track_id=excluded.track_id,snapshot_id=excluded.snapshot_id,updated_at=excluded.updated_at
  `)

  function accept({ userId, deviceId, body }) {
    const snapshotId = text(body.snapshot_id, 80)
    const items = body.items
    const page = Number(body.page)
    const pages = Number(body.pages)
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(snapshotId) ||
        !Array.isArray(items) || items.length > MAX_ITEMS ||
        !Number.isInteger(page) || !Number.isInteger(pages) ||
        pages < 1 || pages > Math.ceil(MAX_SNAPSHOT / MAX_ITEMS) ||
        page < 0 || page >= pages || typeof body.complete !== 'boolean') throw new Error('Invalid mobile catalogue page')

    const now = Date.now()
    let changed = 0
    const accepted = db.transaction(() => {
      for (const raw of items) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid mobile catalogue entry')
        const title = text(raw.title, 1000), artist = text(raw.artist, 1000)
        const duration = Number(raw.duration)
        if (!title || !artist || !Number.isFinite(duration) || duration <= 0 || duration > 86400) continue
        const fields = {
          title, artist, album: text(raw.album, 1000),
          album_artist: text(raw.album_artist, 1000),
          track_num: Number.isInteger(raw.track_num) && raw.track_num > 0 ? raw.track_num : null,
          disc_num: Number.isInteger(raw.disc_num) && raw.disc_num > 0 ? raw.disc_num : null,
          year: Number.isInteger(raw.year) && raw.year >= 1000 && raw.year <= 2999 ? raw.year : null,
          genre: text(raw.genre, 500),
          duration, artwork_url: text(raw.artwork_url, 2000),
          track_key: trackKey({ title, artist, duration }),
        }
        // Reuse a real desktop recording or an already-resolved mobile stream
        // when it matches. Otherwise create a metadata-only Link row; no phone
        // path or provider URL is accepted.
        const priorCatalog = db.prepare(`
          SELECT t.* FROM link_mobile_catalog c
          JOIN tracks t ON t.id = c.track_id
          WHERE c.user_id = ? AND c.device_id = ? AND c.track_key = ?
          LIMIT 1
        `).get(userId, deviceId, fields.track_key)
        const existing = priorCatalog || store.matchTrack(fields)
        const reusable = existing && (
          !String(existing.file_path || '').startsWith('ghost://') ||
          String(existing.file_path || '').startsWith('ghost://mobile/') ||
          /^ghost:\/\/(?:youtube\/online\/|soundcloud\/online\/|monochrome\/online\/|addon\/)/.test(String(existing.file_path || ''))
        )
        const track = reusable ? existing : store.ensureTrack(fields, fields.track_key)
        if (!track) continue
        let currentPath = String(track.file_path || '')
        if (currentPath.startsWith('ghost://link/')) {
          currentPath = 'ghost://mobile/' + track.id
          changed += db.prepare("UPDATE tracks SET file_path=?, download_source='mobile' WHERE id=?").run(currentPath, track.id).changes
        }
        if (currentPath.startsWith('ghost://mobile/')) {
          if (hasDiscNum) {
            changed += db.prepare(`UPDATE tracks SET
              album=COALESCE(NULLIF(album,''),?),
              album_artist=COALESCE(NULLIF(album_artist,''),?),
              track_num=COALESCE(track_num,?), disc_num=COALESCE(disc_num,?),
              year=COALESCE(year,?), genre=COALESCE(NULLIF(genre,''),?),
              artwork_url=COALESCE(NULLIF(artwork_url,''),?)
              WHERE id=?`).run(fields.album || null, fields.album_artist || null, fields.track_num, fields.disc_num, fields.year, fields.genre || null, fields.artwork_url || null, track.id).changes
          } else {
            changed += db.prepare(`UPDATE tracks SET
              album=COALESCE(NULLIF(album,''),?),
              album_artist=COALESCE(NULLIF(album_artist,''),?),
              track_num=COALESCE(track_num,?),
              year=COALESCE(year,?), genre=COALESCE(NULLIF(genre,''),?),
              artwork_url=COALESCE(NULLIF(artwork_url,''),?)
              WHERE id=?`).run(fields.album || null, fields.album_artist || null, fields.track_num, fields.year, fields.genre || null, fields.artwork_url || null, track.id).changes
          }
        }
        const prior = db.prepare('SELECT track_id FROM link_mobile_catalog WHERE user_id=? AND device_id=? AND track_key=?').get(userId, deviceId, fields.track_key)
        insert.run(userId, deviceId, fields.track_key, track.id, snapshotId, now)
        if (!prior || prior.track_id !== track.id) changed++
      }
      if (page === pages - 1 && body.complete) {
        // Only prune after the final page. An interrupted snapshot therefore
        // cannot make previously published phone songs disappear.
        const stale = db.prepare('SELECT track_id FROM link_mobile_catalog WHERE user_id=? AND device_id=? AND snapshot_id<>?')
          .all(userId, deviceId, snapshotId)
        changed += db.prepare('DELETE FROM link_mobile_catalog WHERE user_id=? AND device_id=? AND snapshot_id<>?')
          .run(userId, deviceId, snapshotId).changes
        for (const { track_id: trackId } of stale) {
          const retained = db.prepare('SELECT 1 FROM link_mobile_catalog WHERE track_id=? LIMIT 1').get(trackId)
          if (retained) continue
          const track = db.prepare('SELECT file_path FROM tracks WHERE id=?').get(trackId)
          if (String(track?.file_path || '') === 'ghost://mobile/' + trackId) {
            changed += db.prepare("UPDATE tracks SET file_path=?,download_source=NULL WHERE id=?")
              .run('ghost://link/' + trackId, trackId).changes
          }
        }
      }
      return items.length
    })()
    return { accepted, page, pages, changed }
  }

  function revokeDevice(userId, deviceId) {
    let changed = 0
    db.transaction(() => {
      const stale = db.prepare('SELECT track_id FROM link_mobile_catalog WHERE user_id=? AND device_id=?').all(userId, deviceId)
      changed += db.prepare('DELETE FROM link_mobile_catalog WHERE user_id=? AND device_id=?').run(userId, deviceId).changes
      for (const { track_id: trackId } of stale) {
        const retained = db.prepare('SELECT 1 FROM link_mobile_catalog WHERE track_id=? LIMIT 1').get(trackId)
        if (retained) continue
        const track = db.prepare('SELECT file_path FROM tracks WHERE id=?').get(trackId)
        if (String(track?.file_path || '') === 'ghost://mobile/' + trackId) {
          changed += db.prepare("UPDATE tracks SET file_path=?,download_source=NULL WHERE id=?")
            .run('ghost://link/' + trackId, trackId).changes
        }
      }
    })()
    return changed
  }

  return { accept, revokeDevice }
}

module.exports = { createMobileCatalog }
