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
        // Reuse a real desktop recording when it matches. Otherwise create a
        // metadata-only Link row; no phone path or provider URL is accepted.
        const existing = store.matchTrack(fields)
        const track = existing && !String(existing.file_path || '').startsWith('ghost://')
          ? existing : store.ensureTrack(fields, fields.track_key)
        if (!track) continue
        if (String(track.file_path || '').startsWith('ghost://link/')) {
          db.prepare("UPDATE tracks SET file_path=?, download_source='mobile' WHERE id=?").run('ghost://mobile/' + track.id, track.id)
        }
        if (String(track.file_path || '').startsWith('ghost://mobile/')) {
          db.prepare(`UPDATE tracks SET
            album_artist=COALESCE(NULLIF(album_artist,''),?),
            track_num=COALESCE(track_num,?), disc_num=COALESCE(disc_num,?),
            year=COALESCE(year,?), genre=COALESCE(NULLIF(genre,''),?)
            WHERE id=?`).run(fields.album_artist, fields.track_num, fields.disc_num, fields.year, fields.genre, track.id)
        }
        insert.run(userId, deviceId, fields.track_key, track.id, snapshotId, now)
      }
      if (page === pages - 1 && body.complete) {
        // Only prune after the final page. An interrupted snapshot therefore
        // cannot make previously published phone songs disappear.
        const stale = db.prepare('SELECT track_id FROM link_mobile_catalog WHERE user_id=? AND device_id=? AND snapshot_id<>?')
          .all(userId, deviceId, snapshotId)
        db.prepare('DELETE FROM link_mobile_catalog WHERE user_id=? AND device_id=? AND snapshot_id<>?')
          .run(userId, deviceId, snapshotId)
        for (const { track_id: trackId } of stale) {
          const retained = db.prepare('SELECT 1 FROM link_mobile_catalog WHERE user_id=? AND track_id=? LIMIT 1').get(userId, trackId)
          if (retained) continue
          const track = db.prepare('SELECT file_path FROM tracks WHERE id=?').get(trackId)
          if (String(track?.file_path || '') === 'ghost://mobile/' + trackId) {
            db.prepare("UPDATE tracks SET file_path=?,download_source=NULL WHERE id=?")
              .run('ghost://link/' + trackId, trackId)
          }
        }
      }
      return items.length
    })()
    return { accepted, page, pages }
  }

  return { accept }
}

module.exports = { createMobileCatalog }
