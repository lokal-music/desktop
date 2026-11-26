const { randomUUID } = require('crypto')
const VERSION = 1
const TYPES = new Set(['hello', 'state', 'command', 'ack', 'queue', 'theme', 'history.push', 'history.pull', 'history.events', 'library.push', 'library.pull', 'library.ops', 'catalog.push', 'bye'])
const MAX_BATCH = 250
function envelope(type, body = {}, id = randomUUID()) {
  if (!TYPES.has(type)) throw new Error('Unsupported link message')
  return { v: VERSION, type, id, ts: Date.now(), body }
}
function decode(raw) {
  const value = JSON.parse(String(raw))
  if (!value || value.v !== VERSION || !TYPES.has(value.type) || typeof value.id !== 'string' || value.id.length > 128 || !Number.isFinite(value.ts) || !value.body || typeof value.body !== 'object' || Array.isArray(value.body)) throw new Error('Invalid link message')
  return value
}
function text(value, max = 500) { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function trackKey(track) {
  const normalize = value => text(value).toLowerCase().replace(/\s+/g, ' ').trim()
  return `${normalize(track.artist)}|${normalize(track.title)}|${Math.round(Number(track.duration) || 0)}`
}
function nextClock(previous = '', incoming = '', now = Date.now()) {
  const parse = value => { const [time, count] = String(value).split(':'); return [Number(time) || 0, Number(count) || 0] }
  const [pt, pc] = parse(previous), [it, ic] = parse(incoming)
  if (it > now + 5 * 60 * 1000) throw new Error('Clock is too far in the future')
  const time = Math.max(now, pt, it)
  const count = time === pt && time === it ? Math.max(pc, ic) + 1 : time === pt ? pc + 1 : time === it ? ic + 1 : 0
  return `${String(time).padStart(16, '0')}:${String(count).padStart(8, '0')}`
}
function compareStamp(a, b) {
  const aa = `${a.hlc}:${a.device_id}:${a.op_id}`, bb = `${b.hlc}:${b.device_id}:${b.op_id}`
  return aa < bb ? -1 : aa > bb ? 1 : 0
}
module.exports = { VERSION, MAX_BATCH, envelope, decode, text, trackKey, nextClock, compareStamp }
