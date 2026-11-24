const path = require('node:path')
const fs = require('node:fs/promises')

const DEVICE_SETTINGS = new Set([
  'download_root', 'download_root_device', 'cache_root', 'cache_root_device',
  'phone_download_root', 'phone_download_root_device', 'automix_engine_path',
  'ffmpeg_path', 'ffprobe_path', 'custom_ytdlp_path', 'custom_ffmpeg_path',
  'cast_last_device', 'prefer_media_keys',
])

function absolute(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null
  const raw = value.trim()
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(raw)) {
    return { flavor: path.win32, value: path.win32.normalize(raw) }
  }
  return path.posix.isAbsolute(raw) ? { flavor: path.posix, value: path.posix.normalize(raw) } : null
}

function nativePath(value) {
  const parsed = absolute(value)
  return parsed?.flavor === path ? parsed.value : null
}

function key(value) {
  const parsed = absolute(value)
  return parsed?.flavor === path.win32 ? parsed.value.toLowerCase() : parsed?.value
}

function roots(values) {
  const seen = new Set()
  return values.map(value => absolute(value)?.value).filter(value => {
    if (!value || seen.has(key(value))) return false
    seen.add(key(value))
    return true
  })
}

function parseList(value) {
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return []
}

function musicFolders(settings) {
  const list = roots(parseList(settings.music_folders))
  return list.length ? list : roots([settings.music_folder])
}

function relativeParts(root, file) {
  const source = absolute(root)
  const target = absolute(file)
  if (!source || target?.flavor !== source.flavor) return null
  const relative = source.flavor.relative(source.value, target.value)
  if (!relative || relative === '..' || relative.startsWith('..' + source.flavor.sep) ||
      source.flavor.isAbsolute(relative)) return null
  return relative.split(source.flavor.sep)
}

const MOBILE_FOLDER_NAMES = ['Lokal Phone', 'Lokal Mobile']
const LEGACY_MOBILE_SEGMENTS = new Set(['phone-downloads', 'lokal phone', 'lokal mobile'])

function joinCandidate(folder, parts) {
  if (!folder || !parts?.length) return null
  // Backslashes are legal in POSIX filenames but would become separators on
  // Windows. Joining them there could resolve to a different file or root.
  if (path === path.win32 && parts.some(part => /[\\/:*?"<>|]/.test(part))) return null
  return path.join(folder, ...parts)
}

function rebaseCandidates(file, mappings, { mobileRoots = [], mobileAsset = false } = {}) {
  const candidates = []
  const seen = new Set()
  const add = (folder, parts) => {
    const candidate = joinCandidate(folder, parts)
    const id = key(candidate)
    if (!candidate || !id || seen.has(id)) return
    seen.add(id)
    candidates.push(candidate)
  }

  for (const { source, folder } of mappings) {
    if (!folder) continue
    const parts = relativeParts(source, file)
    if (!parts) continue
    add(folder, parts)
  }

  // Legacy phone uploads lived in <storageDir>/phone-downloads or an unmapped
  // Lokal Mobile / Lokal Phone directory. Match trailing segments beneath that
  // marker against the destination's phone/library folders.
  const parsed = absolute(file)
  if (parsed && mobileRoots.length) {
    const segments = parsed.value.split(parsed.flavor.sep).filter(Boolean)
    for (let i = segments.length - 2; i >= 0; i--) {
      const segment = segments[i]
      const lower = segment.toLowerCase()
      if (!LEGACY_MOBILE_SEGMENTS.has(lower)) continue
      // Only treat generic phone-downloads or mobile-tagged tracks as mobile roots;
      // Lokal Phone / Lokal Mobile subfolders are always explicit Lokal folders.
      if (lower === 'phone-downloads' || mobileAsset || lower === 'lokal phone' || lower === 'lokal mobile') {
        const tail = segments.slice(i + 1)
        if (tail.length) {
          const ordered = [...mobileRoots].sort((a, b) =>
            (path.basename(b).toLowerCase() === lower ? 1 : 0) -
            (path.basename(a).toLowerCase() === lower ? 1 : 0),
          )
          for (const root of ordered) add(root, tail)
        }
        break
      }
    }
  }

  return candidates
}

async function planFolders(incoming, current, selection, readable) {
  const sourceFolders = musicFolders(incoming)
  const currentFolders = musicFolders(current).filter(nativePath)
  const checked = new Map()
  const available = folder => {
    const native = nativePath(folder)
    if (!native) return Promise.resolve(false)
    if (!checked.has(key(native))) checked.set(key(native), readable(native))
    return checked.get(key(native))
  }
  const [sourceAvailable, currentAvailable] = await Promise.all([
    Promise.all(sourceFolders.map(folder =>
      // Do not contact a network share found only in an unconfirmed backup.
      folder.startsWith('\\') && !currentFolders.some(current => key(current) === key(folder))
        ? false
        : available(folder),
    )),
    Promise.all(currentFolders.map(available)),
  ])
  const existingDefault = currentFolders[0]
  let primary = existingDefault || sourceFolders[sourceAvailable.indexOf(true)] || null
  const mappings = sourceFolders.map((source, index) => ({
    source,
    folder: sourceAvailable[index] ? nativePath(source) : null,
  }))
  if (mappings[0] && !mappings[0].folder && currentAvailable[0]) mappings[0].folder = existingDefault

  if (selection) {
    const selected = async (value, fallback) => {
      if (value === undefined) return fallback
      const folder = nativePath(value)
      if (folder && await available(folder)) return folder
      // A previously configured removable drive remains selected while offline.
      if (folder && currentFolders.some(existing => key(existing) === key(folder))) return folder
      throw new Error('A selected music folder is unavailable. Choose an accessible folder and try again.')
    }
    const requested = Array.isArray(selection.mappings) ? selection.mappings : []
    const [chosenPrimary] = await Promise.all([
      selected(selection.primary ?? undefined, primary),
      ...mappings.map(async (entry, index) => {
        entry.folder = await selected(requested[index] ?? undefined, entry.folder)
      }),
    ])
    primary = chosenPrimary
  }

  const folders = roots([primary, ...currentFolders, ...mappings.map(entry => entry.folder)])
  const folderAvailable = await Promise.all(folders.map(available))
  return {
    primary: folders[0] || null,
    mappings,
    folders,
    onlineFolders: folders.filter((_, index) => folderAvailable[index]),
    phoneRoot: nativePath(current.phone_download_root),
  }
}

function restoredSettings(incoming, current, plan) {
  const settings = { ...incoming }
  for (const setting of new Set([...Object.keys(incoming), ...Object.keys(current)])) {
    if (!DEVICE_SETTINGS.has(setting) && !setting.startsWith('automatic_backup_')) continue
    if (Object.hasOwn(current, setting)) settings[setting] = current[setting]
    else if (setting !== 'automatic_backup_frequency') delete settings[setting]
  }
  if (plan.folders.length) {
    settings.music_folder = plan.folders[0]
    settings.music_folders = JSON.stringify(plan.folders)
  } else {
    delete settings.music_folder
    delete settings.music_folders
  }

  const network = parseList(current.network_music_folders)
  const sourceNetwork = new Set(parseList(incoming.network_music_folders).map(key))
  for (const { source, folder } of plan.mappings) {
    // A mounted NAS on the source PC may become a normal local drive here.
    if (key(source) === key(folder) && sourceNetwork.has(key(source))) network.push(folder)
  }
  const networkKeys = new Set(network.map(key))
  const networkFolders = plan.folders.filter(folder => networkKeys.has(key(folder)))
  if (networkFolders.length) settings.network_music_folders = JSON.stringify(networkFolders)
  else delete settings.network_music_folders
  return settings
}

async function prepareRestore(payload, current, selection, {
  storageDir, readable, stat = fs.stat, readdir = fs.readdir,
}) {
  const incoming = payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)
    ? payload.settings : {}
  const plan = await planFolders(incoming, current, selection, readable)
  const settings = restoredSettings(incoming, current, plan)
  const selectedPhoneRoot = selection && Object.hasOwn(selection, 'phoneRoot')
    ? nativePath(selection.phoneRoot)
    : null
  if (selection && Object.hasOwn(selection, 'phoneRoot')) {
    if (!selectedPhoneRoot || !await readable(selectedPhoneRoot)) {
      throw new Error('The selected mobile folder is unavailable. Choose an accessible folder and try again.')
    }
    settings.phone_download_root = selectedPhoneRoot
    settings.phone_download_root_device = String((await stat(selectedPhoneRoot)).dev)
  }

  // Explicit library folder mappings, ordered most-specific first.
  const folderMappings = [...plan.mappings]
    .sort((a, b) => b.source.length - a.source.length)

  const mappings = []
  const seenMappings = new Set()
  const addMapping = (source, folder) => {
    if (!source || !folder) return
    const pairKey = `${key(source)}\0${key(folder)}`
    if (seenMappings.has(pairKey)) return
    seenMappings.add(pairKey)
    mappings.push({ source, folder })
  }

  const sourceDownloads = absolute(incoming.download_root)
  const destinationDownloads = nativePath(settings.download_root) || plan.primary
  const explicitDestinationPhone = nativePath(settings.phone_download_root)
  const sourcePhoneParsed = absolute(incoming.phone_download_root)
  const sourcePhoneBase = sourceDownloads || absolute(musicFolders(incoming)[0])
  const sourcePhone = sourcePhoneParsed?.value ||
    sourcePhoneBase?.flavor.join(sourcePhoneBase.value, 'Lokal Phone')
  const sourcePhoneName = sourcePhoneParsed
    ? sourcePhoneParsed.flavor.basename(sourcePhoneParsed.value)
    : null

  const phoneDestinationCandidates = roots([
    selectedPhoneRoot,
    explicitDestinationPhone,
    ...(sourcePhoneName ? [
      destinationDownloads && path.join(destinationDownloads, sourcePhoneName),
      ...plan.folders.map(folder => path.join(folder, sourcePhoneName)),
    ] : []),
    ...MOBILE_FOLDER_NAMES.flatMap(name => [
      destinationDownloads && path.join(destinationDownloads, name),
      ...plan.folders.map(folder => path.join(folder, name)),
    ]),
    storageDir && path.join(storageDir, 'phone-downloads'),
  ])

  // Collect weighted mappings:
  // 1) Explicit user-selected folder mappings (including nested libraries)
  // 2) Explicit destination phone/download overrides
  // 3) Preserved subfolder names / fallback mobile folder names (Lokal Mobile, Lokal Phone)
  const explicitEntries = folderMappings.map(entry => ({ ...entry, priority: 0 }))
  const extraEntries = []
  if (sourcePhone) {
    if (selectedPhoneRoot) {
      extraEntries.push({ source: sourcePhone, folder: selectedPhoneRoot, priority: 0 })
    }
    if (explicitDestinationPhone) {
      extraEntries.push({ source: sourcePhone, folder: explicitDestinationPhone, priority: 0 })
    }
    // If sourcePhone was nested under a mapped music folder (e.g. D:\Music\Lokal Mobile),
    // the parent mapping in explicitEntries preserves its exact subfolder name; also add
    // fallback destinations (source basename, Lokal Phone, Lokal Mobile) for separate roots.
    for (const candidate of phoneDestinationCandidates) {
      if (candidate === explicitDestinationPhone) continue
      extraEntries.push({ source: sourcePhone, folder: candidate, priority: 1 })
    }
  }
  if (sourceDownloads?.value && destinationDownloads) {
    const priority = nativePath(settings.download_root) ? 0 : 1
    extraEntries.push({ source: sourceDownloads.value, folder: destinationDownloads, priority })
  }

  // Sort: primary mappings (explicit roots & explicit overrides) by longest source first,
  // followed by fallback download/phone mappings by longest source first.
  const combined = [...explicitEntries, ...extraEntries].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return b.source.length - a.source.length
  })
  for (const entry of combined) addMapping(entry.source, entry.folder)

  const mediaRoots = roots([
    ...plan.folders, nativePath(settings.download_root), nativePath(settings.phone_download_root), storageDir,
  ]).sort((a, b) => b.length - a.length)

  const failedRoots = new Set()
  const dirEntriesCache = new Map()

  async function lookupCaseInsensitive(dir, targetLower) {
    if (!dirEntriesCache.has(dir)) {
      dirEntriesCache.set(dir, (async () => {
        try {
          const names = await readdir(dir)
          const byLower = new Map()
          for (const entry of names) {
            const name = typeof entry === 'string' ? entry : entry?.name
            if (!name) continue
            const lower = name.toLowerCase()
            const list = byLower.get(lower)
            if (list) list.push(name)
            else byLower.set(lower, [name])
          }
          return byLower
        } catch {
          return null
        }
      })())
    }
    const byLower = await dirEntriesCache.get(dir)
    const matches = byLower?.get(targetLower)
    return matches && matches.length === 1 ? matches[0] : null
  }

  async function resolveExistingFile(file, { caseInsensitive = false } = {}) {
    const root = mediaRoots.find(candidate => relativeParts(candidate, file))
    if (!root || failedRoots.has(root)) return null
    try {
      if ((await stat(file)).isFile()) return file
      return null
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A disconnected drive must not incur one timeout per backed-up file.
        if (!['ENOTDIR', 'EACCES'].includes(error?.code)) failedRoots.add(root)
        return null
      }
    }
    if (!caseInsensitive || path !== path.posix) return null
    const parts = relativeParts(root, file)
    if (!parts?.length) return null
    let currentDir = root
    for (const part of parts) {
      const match = await lookupCaseInsensitive(currentDir, part.toLowerCase())
      if (!match) return null
      currentDir = path.join(currentDir, match)
    }
    try {
      return (await stat(currentDir)).isFile() ? currentDir : null
    } catch {
      return null
    }
  }

  const assetCache = new Map()
  async function asset(file) {
    if (!file || /^https?:\/\//i.test(file)) return file || null
    const cacheKey = String(file)
    if (!assetCache.has(cacheKey)) {
      assetCache.set(cacheKey, (async () => {
        const parsed = absolute(file)
        const caseInsensitive = path === path.posix && parsed?.flavor === path.win32
        const candidates = rebaseCandidates(file, mappings, {
          mobileRoots: phoneDestinationCandidates,
        })
        const native = nativePath(file)
        if (native && !candidates.some(entry => key(entry) === key(native))) {
          candidates.push(native)
        }
        for (const candidate of candidates) {
          const found = await resolveExistingFile(candidate, { caseInsensitive })
          if (found) return found
        }
        return null
      })())
    }
    return await assetCache.get(cacheKey)
  }

  async function mapRows(rows, transform) {
    if (!Array.isArray(rows)) return rows
    const result = new Array(rows.length)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(rows.length, 24) }, async () => {
      while (cursor < rows.length) {
        const index = cursor++
        result[index] = await transform(rows[index], index)
      }
    }))
    return result
  }

  const tracks = Array.isArray(payload.tracks) ? payload.tracks : []
  const originals = new Set(tracks.map(track => key(track?.file_path)).filter(Boolean))

  // First pass: resolve each track's first existing relocated path, then detect
  // collisions so two tracks never claim the same destination file.
  const resolvedTargets = await mapRows(tracks, async track => {
    const file = track?.file_path
    if (!file || typeof file !== 'string') return null
    const parsed = absolute(file)
    if (!parsed) return null
    const caseInsensitive = path === path.posix && parsed.flavor === path.win32
    const candidates = rebaseCandidates(file, mappings, {
      mobileRoots: phoneDestinationCandidates,
      mobileAsset: track.download_source === 'mobile',
    })
    for (const candidate of candidates) {
      const found = await resolveExistingFile(candidate, { caseInsensitive })
      if (!found) continue
      const identity = key(found)
      if (!identity || key(file) === identity || originals.has(identity)) continue
      return found
    }
    return null
  })

  const movedCounts = new Map()
  for (const target of resolvedTargets) {
    const identity = key(target)
    if (identity) movedCounts.set(identity, (movedCounts.get(identity) || 0) + 1)
  }

  const scanFolders = new Set(plan.folders.filter(folder =>
    !plan.mappings.some(entry => key(entry.source) === key(folder)),
  ))
  let relocated = 0
  let unmatched = 0
  async function restoreTrack(track, index) {
    if (!track || typeof track !== 'object') return track
    const target = resolvedTargets[index]
    const moved = Boolean(target && movedCounts.get(key(target)) === 1)
    if (moved) relocated++
    else if (absolute(track.file_path) &&
      (!nativePath(track.file_path) || mappings.some(entry =>
        key(entry.source) !== key(entry.folder) && relativeParts(entry.source, track.file_path)))) unmatched++

    const artwork = await asset(track.artwork_path)
    const file = moved ? target : track.file_path
    const refreshArtwork = track.artwork_path && !artwork
    const containing = plan.folders.find(folder => relativeParts(folder, file))
    if (containing && (refreshArtwork || moved)) scanFolders.add(containing)
    return {
      ...track,
      file_path: file,
      artwork_path: artwork,
      // Missing cached art should be read again even if audio mtime survived.
      last_modified: refreshArtwork || moved ? null : track.last_modified,
    }
  }

  const restoredTracks = await mapRows(tracks, restoreTrack)
  const artists = await mapRows(payload.artists, async row =>
    row && { ...row, image_path: await asset(row.image_path) })
  const playlists = await mapRows(payload.playlists, async row =>
    row && { ...row, cover_path: row.cover_data ? null : await asset(row.cover_path) })
  const users = await mapRows(payload.users, async row =>
    row && { ...row, avatar_path: row.avatar_data ? null : await asset(row.avatar_path) })

  return {
    plan,
    refreshFolders: plan.onlineFolders.filter(folder => scanFolders.has(folder) && !failedRoots.has(folder)),
    library: {
      relocated, unmatched,
    },
    data: { ...payload, settings, tracks: restoredTracks, artists, playlists, users },
  }
}

module.exports = { planFolders, prepareRestore }
