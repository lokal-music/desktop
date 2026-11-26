// Shared helpers for Link track lifecycle: aliases and content hashes of
// removed duplicates, deletion of track rows, and the op emitted afterwards.
const fs = require('fs')
const { trackKey, text } = require('./protocol')
const { sameRecording, recordingKey } = require('../recordingIdentity')

const isVirtual = file => !file || /^(ghost|stream):\/\//.test(String(file))
// Online catalogue placeholders are not library files a phone could hold.
const isOnlinePlaceholder = file => /^(stream:\/\/|ghost:\/\/(youtube|soundcloud)\/)/.test(String(file || ''))
const HEX64 = /^[0-9a-f]{64}$/i

function ensureTables(db) {
  db.exec('CREATE TABLE IF NOT EXISTS link_track_aliases (track_key TEXT PRIMARY KEY, track_id TEXT NOT NULL)')
  try { require('../trackContentHashes').ensureTrackContentHashes(db) } catch {}
  db.exec('CREATE TABLE IF NOT EXISTS track_content_hashes (sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, track_id TEXT NOT NULL, PRIMARY KEY(sha256,bytes))')
}

function fileSize(file) {
  if (isVirtual(file)) return 0
  try { return fs.statSync(file).size } catch { return 0 }
}

/** Distinct sha256 identities of a track row with the byte size they describe. */
function contentHashes(track) {
  const bytes = Number(track._bytes ?? fileSize(track.file_path)) || 0
  if (!bytes) return []
  const hashes = new Set()
  for (const value of [track.audio_sha256, track.file_hash]) {
    if (HEX64.test(String(value || ''))) hashes.add(String(value).toLowerCase())
  }
  return [...hashes].map(sha256 => ({ sha256, bytes }))
}

function aliasKeys(track) {
  return [...new Set([trackKey(track), ...(track._aliases || [])].filter(Boolean))]
}

/** Rows plus the facts that disappear with them (file size, Link aliases). */
function snapshot(db, ids) {
  ensureTables(db)
  return [...new Set(ids)].map(id => db.prepare('SELECT * FROM tracks WHERE id=?').get(id)).filter(Boolean).map(track => ({
    ...track,
    _bytes: fileSize(track.file_path),
    _aliases: db.prepare('SELECT track_key FROM link_track_aliases WHERE track_id=?').all(track.id).map(row => row.track_key),
  }))
}

function recordKeysAndHashes(db, survivorId, keys, hashes) {
  ensureTables(db)
  for (const key of keys) {
    if (key) db.prepare('INSERT OR REPLACE INTO link_track_aliases (track_key,track_id) VALUES (?,?)').run(key, survivorId)
  }
  for (const { sha256, bytes } of hashes) {
    db.prepare('INSERT OR REPLACE INTO track_content_hashes (sha256,bytes,track_id) VALUES (?,?,?)').run(sha256, bytes, survivorId)
  }
}

/** Remember a loser's identity so phones and rescans resolve it to the survivor. */
function recordLoser(db, survivorId, loser) {
  recordKeysAndHashes(db, survivorId, aliasKeys(loser), contentHashes(loser))
}

/** Remove every reference to a track, then the row (suppress Link capture outside). */
function deleteTrackRows(db, id) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'tracks'").all()
  for (const { name } of tables) {
    const quoted = '"' + name.replace(/"/g, '""') + '"'
    if (!db.prepare(`PRAGMA table_info(${quoted})`).all().some(column => column.name === 'track_id')) continue
    if (['link_track_aliases', 'track_aliases', 'track_content_hashes'].includes(name)) continue
    db.prepare(`DELETE FROM ${quoted} WHERE track_id=?`).run(id)
  }
  db.prepare('DELETE FROM tracks WHERE id=?').run(id)
}

function currentUser(db) {
  try { return String(db._linkStore?.currentUser?.() || 'guest') } catch { return 'guest' }
}

function dedupFields(survivor, losers) {
  return {
    keep_key: trackKey(survivor),
    keep_hash: HEX64.test(String(survivor.file_hash || '')) ? survivor.file_hash : (survivor.audio_sha256 || survivor.file_hash || ''),
    recording_key: recordingKey(survivor),
    title: survivor.title || '', artist: survivor.artist || '', album: survivor.album || '',
    duration: Number(survivor.duration) || 0,
    removed_keys: [...new Set(losers.flatMap(aliasKeys))].filter(key => key !== trackKey(survivor)).slice(0, 200),
    removed_hashes: losers.flatMap(contentHashes).slice(0, 200),
  }
}

function appendDeduplicate(db, survivor, losers) {
  const store = db._linkStore
  if (!store || !survivor) return null
  const fields = dedupFields(survivor, losers)
  return store.appendOp({ entity: 'track', entity_id: fields.keep_key, op: 'track.deduplicate', fields }, currentUser(db))
}

function appendDelete(db, track) {
  const store = db._linkStore
  if (!store) return null
  const key = trackKey(track)
  const raw = (track._aliases || []).find(alias => alias !== key)
  const fields = { track_key: key, file_hash: track.file_hash || '', title: track.title || '', artist: track.artist || '', album: track.album || '', duration: Number(track.duration) || 0 }
  if (raw) fields.raw_track_key = raw
  return store.appendOp({ entity: 'track', entity_id: key, op: 'track.delete', fields }, currentUser(db))
}

/** A non-ghost library track (other than `removed`) that is the same recording. */
function survivorFor(db, track, removedIds, tolerance = 4) {
  const duration = Number(track.duration) || 0
  const rows = db.prepare("SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND file_path NOT LIKE 'stream://%' AND (COALESCE(duration,0)=0 OR ?=0 OR ABS(duration-?)<=?)").all(duration, duration, tolerance)
  const matches = rows.filter(row => !removedIds.has(row.id) && sameRecording(track, row, tolerance))
  const { tierRank } = require('../duplicateGroups')
  matches.sort((a, b) => Number(fs.existsSync(b.file_path)) - Number(fs.existsSync(a.file_path)) || tierRank(b) - tierRank(a))
  return matches[0] || null
}

/**
 * After tracks were deleted by the user: a surviving copy of the recording
 * records aliases/hashes and emits track.deduplicate; otherwise track.delete.
 * `snapshots` come from snapshot() taken BEFORE the delete.
 */
async function afterDelete(db, snapshots) {
  const removedIds = new Set(snapshots.map(track => track.id))
  const dedup = new Map()
  const deletes = []
  db.transaction(() => {
    for (const track of snapshots) {
      if (isOnlinePlaceholder(track.file_path)) continue
      const survivor = survivorFor(db, track, removedIds)
      if (survivor) {
        recordLoser(db, survivor.id, track)
        if (!dedup.has(survivor.id)) dedup.set(survivor.id, { survivor, losers: [] })
        dedup.get(survivor.id).losers.push(track)
      } else deletes.push(track)
    }
    for (const { survivor, losers } of dedup.values()) appendDeduplicate(db, survivor, losers)
    for (const track of deletes) appendDelete(db, track)
  })()
  try { await db._linkStore?.flushPendingTrash() } catch {}
}

module.exports = {
  isVirtual, isOnlinePlaceholder, ensureTables, snapshot, contentHashes, aliasKeys,
  recordKeysAndHashes, recordLoser, deleteTrackRows, appendDeduplicate, appendDelete,
  survivorFor, afterDelete, dedupFields, currentUser, text,
}
