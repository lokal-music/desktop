'use strict'

const fs = require('fs')
const { text, trackKey } = require('./protocol')
const { titleKey, artistKey, sameRecording } = require('../recordingIdentity')
const { cleanTransferMetadata } = require('../transferArtifacts')
const { splitArtists, keepCommaSet } = require('../artistSplit')

const MAX_ITEMS = 250
const MAX_SNAPSHOT = 50000

const normText = value => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()

const isGenericOwner = value => {
  const v = String(value || '').trim().toLowerCase()
  return !v || v === 'unknown artist' || v === 'various artists' || v === 'va'
}

const albumsCompatible = (left, right) => {
  const a = normText(left)
  const b = normText(right)
  return !a || !b || a === b
}

function findDesktopRecordingMatch(db, fields) {
  const cleaned = cleanTransferMetadata({ title: fields.title, artist: fields.artist })
  const probe = {
    title: cleaned.title || fields.title,
    artist: cleaned.artist || fields.artist,
    album: fields.album,
    album_artist: fields.album_artist,
    track_num: fields.track_num,
    disc_num: fields.disc_num,
    duration: fields.duration,
  }
  const wantedTitle = titleKey(probe.title)
  const wantedArtist = artistKey(probe)
  if (!wantedTitle || !wantedArtist) return null

  const duration = Number(probe.duration) || 0
  const candidates = duration > 0
    ? db.prepare("SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND (COALESCE(duration,0)=0 OR ABS(duration-?)<=2)").all(duration)
    : db.prepare("SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%'").all()

  const commaSet = keepCommaSet()
  const probeCredits = splitArtists(String(probe.artist || '').replace(/;|\s\/\s/g, ', '), commaSet).map(normText).filter(Boolean)
  const probeOwner = normText(probe.album_artist)

  for (const row of candidates) {
    if (sameRecording(probe, row, 2) && albumsCompatible(probe.album, row.album)) {
      return row
    }
    // Mirror mobile's creditedLeadArtist / album_artist matching:
    // If one side exposes a collaborator/multi-credit and the other uses the album owner,
    // match when the album owner is credited and title + duration + album agree.
    if (titleKey(row.title) === wantedTitle && albumsCompatible(probe.album, row.album)) {
      const rowOwner = normText(row.album_artist)
      const rowCredits = splitArtists(String(row.artist || '').replace(/;|\s\/\s/g, ', '), commaSet).map(normText).filter(Boolean)
      const rowLead = artistKey(row)
      if (!isGenericOwner(row.album_artist) && probeCredits.includes(rowOwner) && (rowLead === rowOwner || rowCredits.includes(rowOwner))) {
        return row
      }
      if (!isGenericOwner(probe.album_artist) && rowCredits.includes(probeOwner) && (wantedArtist === probeOwner || probeCredits.includes(probeOwner))) {
        return row
      }
    }
  }

  // Mirror mobile's matchesSplitCredit: e.g. "30 For 30 (with Kendrick Lamar)"
  // on Desktop under album owner SZA vs "30 For 30" by Kendrick Lamar on phone.
  const phoneAlbum = normText(probe.album)
  if (phoneAlbum && duration > 0) {
    for (const row of candidates) {
      if (Math.abs((Number(row.duration) || 0) - duration) > 1) continue
      if (normText(row.album) !== phoneAlbum) continue
      if (isGenericOwner(row.album_artist)) continue
      const rowOwner = normText(row.album_artist)
      const rowLead = artistKey(row)
      if (rowOwner !== rowLead || rowOwner === wantedArtist) continue
      if (probe.track_num != null && row.track_num != null && probe.track_num !== row.track_num) continue
      if (probe.disc_num != null && row.disc_num != null && probe.disc_num !== row.disc_num) continue
      if (titleKey(row.title) !== wantedTitle) continue
      const feat = String(row.title || '').match(/\b(?:with|feat\.?|ft\.?|featuring)\s+([^)[\]]*)/i)?.[1]
      if (!feat) continue
      const featCredits = splitArtists(feat.replace(/;|\s\/\s/g, ', '), commaSet).map(normText).filter(Boolean)
      if (featCredits.includes(wantedArtist)) return row
    }
  }
  return null
}

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
    const missingArtwork = []
    const seenMissingArt = new Set()
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
        const priorCatalog = db.prepare(`
          SELECT t.* FROM link_mobile_catalog c
          JOIN tracks t ON t.id = c.track_id
          WHERE c.user_id = ? AND c.device_id = ? AND c.track_key = ?
          LIMIT 1
        `).get(userId, deviceId, fields.track_key)

        // Always prefer a real desktop file when one exists (including files
        // scanned after an earlier mobile-only placeholder was created).
        const storeMatch = store.matchTrack(fields)
        const desktopMatch = (storeMatch && !String(storeMatch.file_path || '').startsWith('ghost://'))
          ? storeMatch
          : findDesktopRecordingMatch(db, fields)

        let track = desktopMatch
        if (!track) {
          const existing = priorCatalog || storeMatch
          const reusable = existing && (
            !String(existing.file_path || '').startsWith('ghost://') ||
            String(existing.file_path || '').startsWith('ghost://mobile/') ||
            /^ghost:\/\/(?:youtube\/online\/|soundcloud\/online\/|monochrome\/online\/|addon\/)/.test(String(existing.file_path || ''))
          )
          track = reusable ? existing : store.ensureTrack(fields, fields.track_key)
        }
        if (!track) continue

        if (desktopMatch && priorCatalog && priorCatalog.id !== desktopMatch.id &&
            String(priorCatalog.file_path || '').startsWith('ghost://mobile/')) {
          try {
            const { mergeTrackReferences } = require('../mergeTrackReferences')
            mergeTrackReferences(db, desktopMatch.id, priorCatalog)
          } catch {
            db.prepare('DELETE FROM tracks WHERE id=?').run(priorCatalog.id)
          }
          changed++
        }

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

        if (currentPath.startsWith('ghost://') && !seenMissingArt.has(fields.track_key)) {
          const latest = db.prepare('SELECT artwork_path, artwork_url FROM tracks WHERE id=?').get(track.id)
          const hasArtFile = Boolean(latest?.artwork_path) && fs.existsSync(latest.artwork_path)
          const hasArtUrl = Boolean(latest?.artwork_url)
          if (!hasArtFile && !hasArtUrl) {
            seenMissingArt.add(fields.track_key)
            missingArtwork.push(fields.track_key)
          }
        }
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
    return { accepted, page, pages, changed, missingArtwork }
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
