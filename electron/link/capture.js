const { randomUUID } = require('crypto')
const { nextClock, trackKey } = require('./protocol')

// Observe existing SQLite writes rather than replacing the player's mutation paths.
// Sync application temporarily suppresses these triggers, preventing echo loops.
function installCapture(store, currentUser) {
  const db = store.db
  db.function('link_device', () => store.deviceId)
  db.function('link_user', () => currentUser())
  db.function('link_uuid', () => randomUUID())
  db.function('link_enabled', () => store.suppressed === 0 ? 1 : 0)
  db.function('link_clock', () => { store.clock = nextClock(store.clock); return store.clock })
  db.function('link_track_key', (artist, title, duration) => trackKey({ artist, title, duration }))
  const key = alias => `COALESCE((SELECT track_key FROM link_track_aliases WHERE track_id=${alias}.id ORDER BY track_key LIMIT 1),link_track_key(${alias}.artist,${alias}.title,${alias}.duration))`
  const log = (uid, entity, id, op, fields) => `INSERT INTO library_ops(op_id,user_id,device_id,hlc,entity,entity_id,op,fields_json) SELECT link_uuid(),${uid},link_device(),link_clock(),'${entity}',${id},'${op}',${fields} WHERE ${id} IS NOT NULL AND ${uid} IS NOT NULL;`
  const trigger = (name, event, table, sql, extraWhen = '') => db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table} WHEN link_enabled()=1 ${name==='link_track_edit' ? 'AND ('+['title','artist','album','album_artist','genre','year','track_num'].map(field=>`OLD.${field} IS NOT NEW.${field}`).join(' OR ')+')' : extraWhen} BEGIN ${sql} END;`)
  trigger('link_like_insert','INSERT','user_likes',log('NEW.user_id','like',`(SELECT ${key('t')} FROM tracks t WHERE t.id=NEW.track_id)`,'like',`json_object('file_hash',(SELECT file_hash FROM tracks WHERE id=NEW.track_id))`))
  trigger('link_like_delete','DELETE','user_likes',log('OLD.user_id','like',`(SELECT ${key('t')} FROM tracks t WHERE t.id=OLD.track_id)`,'unlike',`json_object('file_hash',(SELECT file_hash FROM tracks WHERE id=OLD.track_id))`))
  trigger('link_playlist_insert','INSERT','playlists',`UPDATE playlists SET uuid=COALESCE(NEW.uuid,link_uuid()) WHERE id=NEW.id;`+log('NEW.user_id','playlist','(SELECT uuid FROM playlists WHERE id=NEW.id)','playlist.create',"json_object('name',NEW.name)"))
  trigger('link_playlist_rename','UPDATE OF name','playlists',log('NEW.user_id','playlist','NEW.uuid','playlist.rename',"json_object('name',NEW.name)"))
  trigger('link_playlist_delete','DELETE','playlists',log('OLD.user_id','playlist','OLD.uuid','playlist.delete',"'{}'"))
  // Upgrade capture triggers once. CREATE IF NOT EXISTS alone would leave
  // old installations sending position/key only, losing online-only covers
  // and provider identities during desktop/mobile playlist synchronization.
  if (!db.prepare("SELECT 1 FROM link_meta WHERE key='playlist_online_refs_v2'").get()) {
    for (const op of ['add', 'move', 'remove'])
      db.exec('DROP TRIGGER IF EXISTS link_member_' + op)
    db.prepare("INSERT OR REPLACE INTO link_meta VALUES ('playlist_online_refs_v2', '1')").run()
  }
  for (const [event, alias, op] of [['INSERT','NEW','add'],['DELETE','OLD','remove'],['UPDATE OF position','NEW','move']]) {
    const id = `${alias}.track_id`
    const val = column => `(SELECT ${column} FROM tracks WHERE id=${id})`
    const fromYoutube = `(SELECT CASE WHEN file_path LIKE 'ghost://youtube/online/%' THEN 'yt:' || substr(file_path, length('ghost://youtube/online/')+1) WHEN file_path LIKE 'ghost://soundcloud/online/%' THEN 'sc:' || substr(file_path, length('ghost://soundcloud/online/')+1) END FROM tracks WHERE id=${id})`
    const fields=`json_object('track_key',(SELECT ${key('t')} FROM tracks t WHERE t.id=${id}),'file_hash',${val('file_hash')},'position',${alias}.position,'title',${val('title')},'artist',${val('artist')},'album',${val('album')},'duration',${val('duration')},'online_ref',(SELECT CASE WHEN file_path LIKE 'ghost://%' AND file_path NOT LIKE 'ghost://link/%' AND file_path NOT LIKE 'ghost://mobile/%' THEN 1 ELSE 0 END FROM tracks WHERE id=${id}),'source_ref',${fromYoutube},'artwork_url',${val('artwork_url')})`
    trigger('link_member_'+op,event,'playlist_tracks',log(`(SELECT user_id FROM playlists WHERE id=${alias}.playlist_id)`,'playlist',`(SELECT uuid FROM playlists WHERE id=${alias}.playlist_id)`,'playlist.'+op,fields))
  }
  const swapFields = alias => {
    const id = `${alias}.track_id`
    const val = column => `(SELECT ${column} FROM tracks WHERE id=${id})`
    const fromYoutube = `(SELECT CASE WHEN file_path LIKE 'ghost://youtube/online/%' THEN 'yt:' || substr(file_path, length('ghost://youtube/online/')+1) WHEN file_path LIKE 'ghost://soundcloud/online/%' THEN 'sc:' || substr(file_path, length('ghost://soundcloud/online/')+1) END FROM tracks WHERE id=${id})`
    return `json_object('track_key',(SELECT ${key('t')} FROM tracks t WHERE t.id=${id}),'file_hash',${val('file_hash')},'position',${alias}.position,'title',${val('title')},'artist',${val('artist')},'album',${val('album')},'duration',${val('duration')},'online_ref',(SELECT CASE WHEN file_path LIKE 'ghost://%' AND file_path NOT LIKE 'ghost://link/%' AND file_path NOT LIKE 'ghost://mobile/%' THEN 1 ELSE 0 END FROM tracks WHERE id=${id}),'source_ref',${fromYoutube},'artwork_url',${val('artwork_url')})`
  }
  trigger('link_member_swap','UPDATE OF track_id','playlist_tracks',
    log(`(SELECT user_id FROM playlists WHERE id=OLD.playlist_id)`,'playlist',`(SELECT uuid FROM playlists WHERE id=OLD.playlist_id)`,'playlist.remove',swapFields('OLD')) +
    log(`(SELECT user_id FROM playlists WHERE id=NEW.playlist_id)`,'playlist',`(SELECT uuid FROM playlists WHERE id=NEW.playlist_id)`,'playlist.add',swapFields('NEW')),
    'AND OLD.track_id IS NOT NEW.track_id')
  trigger('link_track_edit','UPDATE OF title,artist,album,album_artist,genre,year,track_num','tracks',`INSERT OR IGNORE INTO link_track_aliases VALUES (${key('OLD')},OLD.id);`+log('link_user()','track',key('OLD'),'track.edit',"(SELECT json_group_object(j.key,j.value) FROM json_each(json_object('file_hash',NEW.file_hash,'title',NEW.title,'artist',NEW.artist,'album',NEW.album,'album_artist',NEW.album_artist,'genre',NEW.genre,'year',NEW.year,'track_num',NEW.track_num)) j WHERE CASE j.key WHEN 'title' THEN OLD.title IS NOT NEW.title WHEN 'artist' THEN OLD.artist IS NOT NEW.artist WHEN 'album' THEN OLD.album IS NOT NEW.album WHEN 'album_artist' THEN OLD.album_artist IS NOT NEW.album_artist WHEN 'genre' THEN OLD.genre IS NOT NEW.genre WHEN 'year' THEN OLD.year IS NOT NEW.year WHEN 'track_num' THEN OLD.track_num IS NOT NEW.track_num ELSE 1 END)"))
  db.exec(`CREATE TRIGGER IF NOT EXISTS link_local_field_clock AFTER INSERT ON library_ops WHEN NEW.device_id=link_device() AND link_enabled()=1 BEGIN
    INSERT OR REPLACE INTO library_field_clocks(user_id,entity,entity_id,field,hlc,device_id,op_id)
      SELECT NEW.user_id,NEW.entity,NEW.entity_id,CASE WHEN NEW.entity='like' THEN 'liked' WHEN NEW.op='playlist.create' THEN 'created' WHEN NEW.op='playlist.rename' THEN 'name' WHEN NEW.op='playlist.delete' THEN 'deleted' ELSE 'member:'||json_extract(NEW.fields_json,'$.track_key') END,NEW.hlc,NEW.device_id,NEW.op_id WHERE NEW.entity<>'track';
    INSERT OR REPLACE INTO library_field_clocks(user_id,entity,entity_id,field,hlc,device_id,op_id)
      SELECT NEW.user_id,NEW.entity,NEW.entity_id,j.key,NEW.hlc,NEW.device_id,NEW.op_id FROM json_each(NEW.fields_json) j WHERE NEW.entity='track' AND j.key<>'file_hash';
    INSERT OR REPLACE INTO library_field_clocks SELECT NEW.user_id,NEW.entity,NEW.entity_id,'name',NEW.hlc,NEW.device_id,NEW.op_id WHERE NEW.op='playlist.create';
    INSERT OR REPLACE INTO link_tombstones SELECT NEW.user_id,NEW.entity,NEW.entity_id,NEW.hlc,NEW.device_id,NEW.op_id WHERE NEW.op='playlist.delete';
  END;`)
  const historySelect = `SELECT 'desktop_'||link_device()||'_'||e.id,e.user_id,link_device(),${key('t')},t.file_hash,COALESCE(e.ended_at,e.created_at)*1000,MAX(0,e.seconds_played)*1000,'desktop',json_object('id',t.id,'title',t.title,'artist',t.artist,'album',t.album,'duration',t.duration) FROM listening_events e JOIN tracks t ON t.id=e.track_id WHERE e.event_type='qualified_play'`
  db.exec(`INSERT OR IGNORE INTO history_events(event_id,user_id,device_id,track_key,file_hash,played_at,ms_played,source,track_json) ${historySelect};`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS link_history_insert AFTER INSERT ON listening_events WHEN link_enabled()=1 AND NEW.event_type='qualified_play' BEGIN
    INSERT OR IGNORE INTO history_events(event_id,user_id,device_id,track_key,file_hash,played_at,ms_played,source,track_json) ${historySelect} AND e.id=NEW.id;
  END;`)
  const alreadyBootstrapped = !!db.prepare("SELECT value FROM link_meta WHERE key='library_bootstrap_v1'").get()
  if (!db.prepare("SELECT value FROM link_meta WHERE key='library_bootstrap_v1'").get()) db.transaction(() => {
    for (const row of db.prepare('SELECT p.*,p.uuid AS entity_id FROM playlists p').all()) store.appendOp({entity:'playlist',entity_id:row.entity_id,op:'playlist.create',fields:{name:row.name}},row.user_id)
    for (const row of db.prepare('SELECT l.user_id,t.* FROM user_likes l JOIN tracks t ON t.id=l.track_id').all()) store.appendOp({entity:'like',entity_id:trackKey(row),op:'like',fields:{file_hash:row.file_hash}},row.user_id)
    for (const row of db.prepare('SELECT p.user_id,p.uuid,pt.position,t.* FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id JOIN tracks t ON t.id=pt.track_id').all()) store.appendOp({entity:'playlist',entity_id:row.uuid,op:'playlist.add',fields:{track_key:trackKey(row),file_hash:row.file_hash,position:row.position,
      title:row.title,artist:row.artist,album:row.album,duration:row.duration,
      online_ref:String(row.file_path || '').startsWith('ghost://') && !String(row.file_path || '').startsWith('ghost://link/') && !String(row.file_path || '').startsWith('ghost://mobile/'),
      source_ref:String(row.file_path || '').startsWith('ghost://youtube/online/') ? 'yt:' + row.file_path.slice('ghost://youtube/online/'.length) : String(row.file_path || '').startsWith('ghost://soundcloud/online/') ? 'sc:' + row.file_path.slice('ghost://soundcloud/online/'.length) : null,
      artwork_url:row.artwork_url}},row.user_id)
    db.prepare("INSERT INTO link_meta VALUES ('library_bootstrap_v1','1')").run()
  })()

  // Existing installations have historical playlist operations without
  // catalogue metadata. Re-emit enriched member positions ONCE, so a newly
  // paired device can reconstruct playable online references even when it
  // replays operations captured before this update.
  const backfillKey = 'playlist_online_refs_backfill_v3'
  if (!db.prepare('SELECT 1 FROM link_meta WHERE key=?').get(backfillKey)) {
    db.transaction(() => {
      if (alreadyBootstrapped) {
        const entries = db.prepare(
          "SELECT p.user_id,p.uuid,pt.position,t.* FROM playlist_tracks pt " +
          "JOIN playlists p ON p.id=pt.playlist_id JOIN tracks t ON t.id=pt.track_id " +
          "WHERE t.file_path LIKE 'ghost://youtube/online/%' " +
          "OR t.file_path LIKE 'ghost://soundcloud/online/%'"
        ).all()
        for (const row of entries) {
          const path = String(row.file_path || '')
          const source = path.startsWith('ghost://youtube/online/')
            ? 'yt:' + path.slice('ghost://youtube/online/'.length)
            : 'sc:' + path.slice('ghost://soundcloud/online/'.length)
          store.appendOp({
            entity: 'playlist', entity_id: row.uuid, op: 'playlist.move',
            fields: {
              track_key: trackKey(row), file_hash: row.file_hash,
              position: row.position, title: row.title, artist: row.artist,
              album: row.album, duration: row.duration, online_ref: true,
              source_ref: source, artwork_url: row.artwork_url,
            },
          }, row.user_id)
        }
      }
      db.prepare('INSERT OR REPLACE INTO link_meta VALUES (?, ?)').run(backfillKey, '1')
    })()
  }
}
module.exports = { installCapture }
