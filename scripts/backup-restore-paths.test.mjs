import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import restore from '../electron/backupRestorePaths.js'

const { planFolders, prepareRestore } = restore
const foreign = path === path.win32 ? path.posix : path.win32
const source = foreign === path.win32 ? 'D:\\Old Music' : '/old/music'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lokal-restore-paths-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const music = path.join(root, 'Music')
  const other = path.join(root, 'Lossless')
  const downloads = path.join(root, 'Downloads')
  const storageDir = path.join(root, 'data')
  for (const folder of [music, other, downloads, storageDir]) await fs.mkdir(folder)
  const readable = async folder => {
    try { return (await fs.stat(folder)).isDirectory() } catch { return false }
  }
  return { root, music, other, downloads, storageDir, readable }
}

test('preserves destination roots and machine settings and reconnects tracks without changing their IDs', async t => {
  const { music, other, downloads, storageDir, readable } = await fixture(t)
  const file = path.join(music, 'Album', 'Song.flac')
  const cover = path.join(music, 'Album', 'folder.jpg')
  const downloaded = path.join(downloads, 'Download.flac')
  await fs.mkdir(path.dirname(file))
  await Promise.all([file, cover, downloaded].map(file => fs.writeFile(file, 'fixture')))
  const downloadSource = foreign.join(source, 'Separate Downloads')
  const payload = {
    version: 1,
    settings: {
      music_folder: source,
      download_root: downloadSource,
      cache_root: foreign.join(source, 'cache'),
      cache_root_device: 'foreign-device',
      custom_ffmpeg_path: foreign.join(source, 'ffmpeg'),
      automatic_backup_directory: foreign.join(source, 'backups'),
      automatic_backup_directory_identity: 'old:volume',
      theme: 'dark',
    },
    tracks: [
      { id: 'song', file_path: foreign.join(source, 'Album', 'Song.flac'), artwork_path: foreign.join(source, 'Album', 'folder.jpg') },
      { id: 'download', file_path: foreign.join(downloadSource, 'Download.flac'), download_source: 'web' },
      { id: 'missing', file_path: foreign.join(source, 'Missing.flac'), artwork_path: foreign.join(source, 'missing.jpg') },
      { id: 'online', file_path: 'ghost://yt/song', artwork_url: 'https://example.com/cover.jpg' },
    ],
    playlist_tracks: [{ track_id: 'song' }],
    user_likes: [{ track_id: 'missing' }],
    play_history: [{ track_id: 'download' }],
  }
  const current = {
    music_folders: JSON.stringify([music, other]),
    download_root: downloads,
    download_root_device: 'download-device',
    custom_ffmpeg_path: path.join(storageDir, 'ffmpeg'),
    automatic_backup_directory: storageDir,
    automatic_backup_directory_identity: 'current:volume',
  }
  const plan = await planFolders(payload.settings, current, null, readable)
  assert.equal(plan.primary, music)
  assert.equal(plan.mappings[0].folder, music)
  const restored = await prepareRestore(payload, current, undefined, { storageDir, readable })
  assert.deepEqual(restored.plan.folders, [music, other])
  assert.deepEqual(restored.library, { relocated: 2, unmatched: 1 })
  assert.deepEqual(new Set(restored.refreshFolders), new Set([music, other]))
  assert.equal(restored.data.settings.music_folder, music)
  assert.equal(restored.data.settings.download_root, downloads)
  assert.equal(restored.data.settings.download_root_device, 'download-device')
  assert.equal(restored.data.settings.custom_ffmpeg_path, current.custom_ffmpeg_path)
  assert.equal(restored.data.settings.cache_root, undefined)
  assert.equal(restored.data.settings.cache_root_device, undefined)
  assert.equal(restored.data.settings.automatic_backup_directory_identity, 'current:volume')
  assert.equal(restored.data.settings.theme, 'dark')
  assert.deepEqual(restored.data.tracks.map(track => track.id), ['song', 'download', 'missing', 'online'])
  assert.deepEqual(restored.data.tracks.map(track => track.file_path), [file, downloaded, payload.tracks[2].file_path, 'ghost://yt/song'])
  assert.equal(restored.data.tracks[0].artwork_path, cover)
  assert.equal(restored.data.tracks[1].download_source, 'web')
  assert.equal(restored.data.tracks[2].artwork_path, null)
  assert.equal(restored.data.tracks[3].artwork_url, 'https://example.com/cover.jpg')
  for (const field of ['playlist_tracks', 'user_likes', 'play_history']) assert.deepEqual(restored.data[field], payload[field])
})

test('reuses a readable backup location on a fresh install and skips an unnecessary scan', async t => {
  const { music, storageDir, readable } = await fixture(t)
  const file = path.join(music, 'Song.flac')
  const cover = path.join(storageDir, 'cover.jpg')
  await Promise.all([file, cover].map(file => fs.writeFile(file, 'fixture')))
  const payload = {
    settings: { music_folder: music },
    tracks: [{ id: 'song', file_path: file, artwork_path: cover, last_modified: 123 }],
  }
  const result = await prepareRestore(payload, {}, null, { storageDir, readable })
  assert.equal(result.plan.primary, music)
  assert.deepEqual(result.library, { relocated: 0, unmatched: 0 })
  assert.deepEqual(result.refreshFolders, [])
  assert.deepEqual(result.data.tracks, payload.tracks)

  await fs.unlink(cover)
  const migrated = await prepareRestore(payload, {}, null, { storageDir, readable })
  assert.deepEqual(migrated.refreshFolders, [music])
  assert.equal(migrated.data.tracks[0].last_modified, null)
  assert.equal(migrated.data.tracks[0].artwork_path, null)
})

test('maps multiple explicitly chosen folders and preserves ambiguous or absent files', async t => {
  const { root, music, other, storageDir, readable } = await fixture(t)
  const nested = foreign.join(source, 'Nested')
  const separate = foreign.resolve(foreign.dirname(source), 'Other Backup Root')
  const absoluteSong = path.join(music, 'Shared.flac')
  const mostSpecific = path.join(other, 'Nested.flac')
  await Promise.all([absoluteSong, mostSpecific].map(file => fs.writeFile(file, 'fixture')))
  const payload = {
    settings: { music_folders: JSON.stringify([source, nested, separate]) },
    tracks: [
      { id: 'a', file_path: foreign.join(source, 'Shared.flac') },
      { id: 'b', file_path: foreign.join(separate, 'Shared.flac') },
      { id: 'c', file_path: foreign.join(nested, 'Nested.flac') },
    ],
  }
  const selected = { primary: music, mappings: [music, other, music] }
  const options = { storageDir, readable }
  const result = await prepareRestore(payload, {}, selected, options)
  assert.deepEqual(result.plan.folders, [music, other])
  assert.deepEqual(result.data.tracks.map(track => track.file_path), [
    payload.tracks[0].file_path, payload.tracks[1].file_path, mostSpecific,
  ])
  assert.equal(result.library.unmatched, 2)
  await assert.rejects(
    prepareRestore(payload, {}, { primary: path.join(root, 'unavailable') }, options),
    /selected music folder is unavailable/,
  )
})

test('keeps a configured removable library even while it is disconnected', async t => {
  const { root, other, readable } = await fixture(t)
  const offline = path.join(root, 'Offline Drive')
  const current = { music_folders: JSON.stringify([offline, other]) }
  const result = await planFolders({ music_folder: source }, current, null, readable)
  assert.deepEqual(result.folders, [offline, other])
  assert.deepEqual(result.onlineFolders, [other])
  assert.equal(result.mappings[0].folder, null)
})

test('relocates Lokal Mobile tracks nested inside the main music folder when importing from Windows to Linux', async t => {
  const { music, storageDir, readable } = await fixture(t)
  const mobileDir = path.join(music, 'Lokal Mobile')
  const mobileTrack = path.join(mobileDir, 'A Good Day.flac')
  const mobileCover = path.join(mobileDir, 'cover.jpg')
  const nestedDownloadsDir = path.join(music, 'Downloads')
  const nestedDownload = path.join(nestedDownloadsDir, 'Track.flac')
  await fs.mkdir(mobileDir, { recursive: true })
  await fs.mkdir(nestedDownloadsDir, { recursive: true })
  await Promise.all([mobileTrack, mobileCover, nestedDownload].map(f => fs.writeFile(f, 'fixture')))

  const winRoot = 'D:\\Music'
  const winMobile = 'D:\\Music\\Lokal Mobile'
  const winDownloads = 'D:\\Music\\Downloads'
  const payload = {
    version: 1,
    settings: {
      music_folder: winRoot,
      music_folders: JSON.stringify([winRoot]),
      phone_download_root: winMobile,
      download_root: winDownloads,
    },
    tracks: [
      {
        id: 'mobile-1',
        file_path: 'D:\\Music\\Lokal Mobile\\A Good Day.flac',
        artwork_path: 'D:\\Music\\Lokal Mobile\\cover.jpg',
        download_source: 'mobile',
        last_modified: 999,
      },
      {
        id: 'dl-1',
        file_path: 'D:\\Music\\Downloads\\Track.flac',
        download_source: 'web',
        last_modified: 888,
      },
    ],
  }

  // Fresh destination with only the main music folder selected (no phone_download_root).
  const restored = await prepareRestore(
    payload,
    {},
    { primary: music, mappings: [music] },
    { storageDir, readable },
  )

  assert.deepEqual(restored.library, { relocated: 2, unmatched: 0 })
  assert.equal(restored.data.tracks[0].file_path, mobileTrack)
  assert.equal(restored.data.tracks[0].artwork_path, mobileCover)
  assert.equal(restored.data.tracks[0].download_source, 'mobile')
  assert.equal(restored.data.tracks[0].last_modified, null)
  assert.equal(restored.data.tracks[1].file_path, nestedDownload)
  assert.ok(restored.refreshFolders.includes(music))
})

test('relocates separate Lokal Mobile, legacy phone-downloads, unmapped nested roots, and Windows case differences', async t => {
  const { music, storageDir, readable } = await fixture(t)
  const mobileDir = path.join(music, 'Lokal Mobile')
  const separateTrack = path.join(mobileDir, 'Oui oui xtndo.flac')
  const legacyTrack = path.join(mobileDir, 'Legacy Phone.flac')
  const casedDir = path.join(mobileDir, 'Artist')
  const casedTrack = path.join(casedDir, 'Midnight Communication.flac')
  await fs.mkdir(casedDir, { recursive: true })
  await Promise.all([separateTrack, legacyTrack, casedTrack].map(f => fs.writeFile(f, 'fixture')))

  const payload = {
    version: 1,
    settings: {
      music_folder: 'D:\\Music',
      music_folders: JSON.stringify(['D:\\Music', 'D:\\Music\\Lokal Mobile']),
      phone_download_root: 'E:\\Lokal Mobile',
    },
    tracks: [
      {
        id: 'sep-mobile',
        file_path: 'E:\\Lokal Mobile\\Oui oui xtndo.flac',
        download_source: 'mobile',
      },
      {
        id: 'legacy-mobile',
        file_path: 'C:\\Users\\user\\AppData\\Roaming\\lokal\\data\\phone-downloads\\Legacy Phone.flac',
        download_source: 'mobile',
      },
      {
        id: 'cased-mobile',
        file_path: 'D:\\Music\\lokal mobile\\artist\\MIDNIGHT COMMUNICATION.FLAC',
        download_source: 'mobile',
      },
    ],
  }

  // Only primary music folder mapped; nested D:\Music\Lokal Mobile left unmapped (null).
  const restored = await prepareRestore(
    payload,
    {},
    { primary: music, mappings: [music, undefined] },
    { storageDir, readable },
  )

  assert.deepEqual(restored.library, { relocated: 3, unmatched: 0 })
  assert.deepEqual(
    restored.data.tracks.map(track => track.file_path),
    [separateTrack, legacyTrack, casedTrack],
  )
})


test('maps a separate Lokal Mobile destination independently from the main music folder', async t => {
  const { root, music, storageDir, readable } = await fixture(t)
  const mobileRoot = path.join(root, 'Lokal Mobile')
  const mobileTrack = path.join(mobileRoot, 'Artist', 'Track.flac')
  const mainTrack = path.join(music, 'Album', 'Main.flac')
  await Promise.all([mobileTrack, mainTrack].map(async file => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'fixture')
  }))

  const sourceMusic = 'C:\\\\Music'
  const sourceMobile = 'C:\\\\Music\\\\Lokal Mobile'
  const payload = {
    settings: {
      music_folder: sourceMusic,
      music_folders: JSON.stringify([sourceMusic]),
      phone_download_root: sourceMobile,
    },
    tracks: [
      { id: 'phone-track', file_path: 'C:\\\\Music\\\\Lokal Mobile\\\\Artist\\\\Track.flac', download_source: 'mobile' },
      { id: 'main-track', file_path: 'C:\\\\Music\\\\Album\\\\Main.flac' },
    ],
  }
  const restored = await prepareRestore(payload, {}, {
    primary: music,
    mappings: [music],
    phoneRoot: mobileRoot,
  }, { storageDir, readable })

  assert.equal(restored.data.settings.music_folder, music)
  assert.equal(restored.data.settings.phone_download_root, mobileRoot)
  assert.equal(restored.data.settings.phone_download_root_device, String((await fs.stat(mobileRoot)).dev))
  assert.equal(restored.data.tracks[0].file_path, mobileTrack)
  assert.equal(restored.data.tracks[1].file_path, mainTrack)
  assert.deepEqual(restored.library, { relocated: 2, unmatched: 0 })
  assert.ok(restored.refreshFolders.includes(music))
})
