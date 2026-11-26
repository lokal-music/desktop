const { trackKey } = require('./protocol')

// Reconcile the actual desktop playlists against the last synchronized desktop
// state. SQL triggers usually capture changes, but legacy imports, database
// restores and operations that bypass those triggers may leave the event log
// incomplete. An incremental cursor cannot recover those omissions alone.
function snapshotPlaylists(store, userId) {
  const db = store.db
  const result = {}
  const playlists = db.prepare('SELECT id,uuid,name FROM playlists WHERE user_id=?').all(userId)
  const members = db.prepare(
    'SELECT pt.position,t.* FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id WHERE pt.playlist_id=? ORDER BY pt.position,pt.rowid'
  )
  for (const playlist of playlists) {
    if (!playlist.uuid) continue
    result[playlist.uuid] = {
      name: playlist.name,
      members: members.all(playlist.id).map(row => {
        const path = String(row.file_path || '')
        const youtube = 'ghost://youtube/online/'
        const soundcloud = 'ghost://soundcloud/online/'
        return {
          track_key: trackKey(row),
          position: row.position,
          file_hash: row.file_hash,
          title: row.title,
          artist: row.artist,
          album: row.album,
          duration: row.duration,
          online_ref: path.startsWith('ghost://') && !path.startsWith('ghost://link/') && !path.startsWith('ghost://mobile/'),
          source_ref: path.startsWith(youtube) ? 'yt:' + path.slice(youtube.length)
            : path.startsWith(soundcloud) ? 'sc:' + path.slice(soundcloud.length) : null,
          artwork_url: row.artwork_url
        }
      })
    }
  }
  return result
}

// Pure difference so the mutation semantics can be regression-tested without
// requiring a running Electron instance or audio library.
function diffPlaylistSnapshots(previous, current) {
  const changes = []
  for (const [id, former] of Object.entries(previous)) {
    if (!(id in current)) changes.push({ entity: 'playlist', entity_id: id, op: 'playlist.delete', fields: {} })
  }
  for (const [id, playlist] of Object.entries(current)) {
    const former = previous[id]
    if (!former) {
      changes.push({ entity: 'playlist', entity_id: id, op: 'playlist.create', fields: { name: playlist.name } })
    } else if (former.name !== playlist.name) {
      changes.push({ entity: 'playlist', entity_id: id, op: 'playlist.rename', fields: { name: playlist.name } })
    }
    const oldMembers = new Map((former?.members || []).map(member => [member.track_key, member]))
    const newMembers = new Map(playlist.members.map(member => [member.track_key, member]))
    for (const old of oldMembers.values()) {
      if (!newMembers.has(old.track_key)) {
        changes.push({ entity: 'playlist', entity_id: id, op: 'playlist.remove', fields: { track_key: old.track_key } })
      }
    }
    for (const member of playlist.members) {
      const old = oldMembers.get(member.track_key)
      if (!old || old.position !== member.position ||
          old.title !== member.title || old.artist !== member.artist ||
          old.album !== member.album || old.duration !== member.duration ||
          old.file_hash !== member.file_hash ||
          old.source_ref !== member.source_ref ||
          old.artwork_url !== member.artwork_url) {
        changes.push({
          entity: 'playlist', entity_id: id,
          op: old ? 'playlist.move' : 'playlist.add',
          fields: member
        })
      }
    }
  }
  return changes
}

// On an upgrade there may be no stored snapshot yet. Use the durable
// operations as a baseline, so a desktop playlist deleted outside the old
// capture triggers is not accidentally retained forever on the phone.
function snapshotFromJournal(rows) {
  const playlists = {}
  for (const row of rows) {
    const id = row.entity_id
    const op = row.op
    let fields
    try { fields = typeof row.fields_json === 'string' ? JSON.parse(row.fields_json) : row.fields || {} }
    catch { continue }
    if (op === 'playlist.create') {
      playlists[id] = { name: fields.name || 'Playlist', members: [] }
    } else if (op === 'playlist.delete') {
      delete playlists[id]
    } else {
      const playlist = playlists[id]
      if (!playlist) continue
      if (op === 'playlist.rename') playlist.name = fields.name || playlist.name
      if (op === 'playlist.remove') {
        playlist.members = playlist.members.filter(member => member.track_key !== fields.track_key)
      } else if ((op === 'playlist.add' || op === 'playlist.move') && fields.track_key) {
        const index = playlist.members.findIndex(member => member.track_key === fields.track_key)
        const member = { ...(playlist.members[index] || {}), ...fields }
        if (index < 0) playlist.members.push(member)
        else playlist.members[index] = member
      }
    }
  }
  return playlists
}

function _key(userId) {
  return 'link_playlist_reconciliation_v1:' + userId
}

function savePlaylistSnapshot(store, userId) {
  const snapshot = snapshotPlaylists(store, userId)
  store.db.prepare('INSERT OR REPLACE INTO link_meta (key,value) VALUES (?,?)')
    .run(_key(userId), JSON.stringify(snapshot))
  return snapshot
}

function reconcilePlaylists(store, userId) {
  const raw = store.db.prepare('SELECT value FROM link_meta WHERE key=?').get(_key(userId))?.value
  let previous = {}
  if (raw) {
    try {
      const decoded = JSON.parse(raw)
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) previous = decoded
    } catch {}
  } else {
    const history = store.db.prepare(
      "SELECT entity_id,op,fields_json FROM library_ops WHERE user_id=? AND entity='playlist' ORDER BY cursor"
    ).all(userId)
    previous = snapshotFromJournal(history)
  }
  const current = snapshotPlaylists(store, userId)
  const changes = diffPlaylistSnapshots(previous, current)
  // All operations are append-only: no playlist/audio file is removed here.
  // Desktop edits already journalled by triggers may be repeated harmlessly;
  // the phone's replay uses the later operation as the same desired state.
  for (const change of changes) store.appendOp(change, userId)
  savePlaylistSnapshot(store, userId)
  return changes.length
}

module.exports = { snapshotPlaylists, snapshotFromJournal, diffPlaylistSnapshots, savePlaylistSnapshot, reconcilePlaylists }
