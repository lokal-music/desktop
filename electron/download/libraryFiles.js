// Downloads stay outside the scanner's inventory until tagging/conversion is
// complete. Publication paths are held while the queue commits their DB row.
const fs = require('fs-extra')
const path = require('path')
const DIRECTORY = '.lokal-download-incoming'
const publishing = new Set()
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
function isIncoming(file) {
  return typeof file === 'string' && file.split(/[\\/]/).some(part => part.toLowerCase() === DIRECTORY)
}
function isHidden(file) { return isIncoming(file) || publishing.has(key(file)) }
function stagingDirectory(root, jobId) {
  const dir = path.join(root, DIRECTORY, String(jobId).replace(/[^a-z0-9_-]/gi, '_'))
  fs.ensureDirSync(dir)
  return dir
}
function hold(file) { const id = key(file); publishing.add(id); return () => publishing.delete(id) }
function publish(file, root, stage) {
  const relative = path.relative(stage, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Download is outside its staging directory')
  let target = path.join(root, relative)
  const ext = path.extname(target), stem = target.slice(0, -ext.length)
  for (let suffix = 1; fs.existsSync(target); suffix++) target = `${stem} (${suffix})${ext}`
  const release = hold(target)
  try {
    fs.moveSync(file, target, { overwrite: false })
    for (const ext of ['.lrc', '.elrc', '.ttml', '.txt']) {
      const source = file.slice(0, -path.extname(file).length) + ext
      const dest = target.slice(0, -path.extname(target).length) + ext
      if (fs.existsSync(source) && !fs.existsSync(dest)) fs.moveSync(source, dest, { overwrite: false })
    }
    return { filePath: target, release }
  } catch (error) { release(); throw error }
}
module.exports = { DIRECTORY, isIncoming, isHidden, stagingDirectory, hold, publish }
