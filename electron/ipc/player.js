const fs = require('fs')
const path = require('path')
const mm = require('../musicMetadata')
const { getDB } = require('./db')

const replayGainCache = new Map()
const REPLAYGAIN_CACHE_LIMIT = 512

function parseGainDb(value) {
  if (value && typeof value === 'object') {
    const db = Number(value.dB ?? value.db)
    if (Number.isFinite(db)) return db
    const ratio = Number(value.ratio)
    if (Number.isFinite(ratio) && ratio > 0) return 20 * Math.log10(ratio)
    return null
  }
  if (value === null || value === undefined || value === '') return null
  const parsed = Number.parseFloat(String(value).replace(/\s*dB\s*$/i, '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function parsePeak(value) {
  if (value && typeof value === 'object') value = value.ratio ?? value.peak ?? value.value
  if (value === null || value === undefined || value === '') return null
  const parsed = Number.parseFloat(String(value).trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function readReplayGain(common, format) {
  return {
    trackGainDb: parseGainDb(common.replaygain_track_gain ?? format.trackGain),
    trackPeak: parsePeak(common.replaygain_track_peak ?? format.trackPeak),
    albumGainDb: parseGainDb(common.replaygain_album_gain ?? format.albumGain),
    albumPeak: parsePeak(common.replaygain_album_peak ?? format.albumPeak),
  }
}

function registerPlayerHandlers(ipcMain) {
  ipcMain.handle('player:getReplayGain', async (_, trackId) => {
    if (typeof trackId !== 'string' || !trackId || trackId.length > 256) return null
    try {
      // Resolve paths through the library database; never accept a filesystem
      // path from the renderer.
      const track = require('../trackAlias').trackById(getDB(), trackId)
      if (!track?.file_path || track.file_path.startsWith('ghost://')) return null
      const filePath = path.resolve(track.file_path)
      const stat = await fs.promises.stat(filePath)
      if (!stat.isFile()) return null
      const cacheKey = `${filePath}\0${stat.size}\0${stat.mtimeMs}`
      if (replayGainCache.has(cacheKey)) return replayGainCache.get(cacheKey)

      const metadata = await mm.parseFile(filePath, { duration: false, skipCovers: true })
      const result = readReplayGain(metadata.common || {}, metadata.format || {})
      replayGainCache.set(cacheKey, result)
      if (replayGainCache.size > REPLAYGAIN_CACHE_LIMIT) replayGainCache.delete(replayGainCache.keys().next().value)
      return result
    } catch {
      return null
    }
  })

  
  ipcMain.handle('player:getFileURL', (e, filePath) => {
    const { pathToFileURL } = require('url')
    return pathToFileURL(filePath).href
  })
}

module.exports = { registerPlayerHandlers }