const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { createPendingCommands } = require('../electron/link/pendingCommands')

test('pending requests are socket-bound and settled when their phone disconnects', async () => {
  const timers = []
  const pending = createPendingCommands({
    setTimer(callback, timeout) {
      const timer = { callback, timeout, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) { timer.cleared = true },
  })
  const socket = {}
  const anotherSocket = {}
  const request = pending.wait({ requestId: 'copy-1', socket, timeout: 900000 })
  const unrelated = pending.wait({ requestId: 'copy-2', socket: anotherSocket, timeout: 7000 })

  assert.equal(timers[0].timeout, 900000)
  assert.equal(pending.resolve('copy-1', anotherSocket, { ok: true }), false)
  assert.equal(pending.size, 2)

  pending.settleSocket(socket, { ok: false, error: 'Phone is no longer connected.' })
  assert.deepEqual(await request, { ok: false, error: 'Phone is no longer connected.' })
  assert.equal(timers[0].cleared, true)
  assert.equal(pending.size, 1)

  pending.settleAll({ ok: false, error: 'Link closed' })
  assert.deepEqual(await unrelated, { ok: false, error: 'Link closed' })
  assert.equal(timers[1].cleared, true)
  assert.equal(pending.size, 0)
})

test('pending requests still time out while the phone remains connected', async () => {
  const timers = []
  const pending = createPendingCommands({
    setTimer(callback, timeout) {
      const timer = { callback, timeout }
      timers.push(timer)
      return timer
    },
    clearTimer() {},
  })
  const request = pending.wait({ requestId: 'copy', socket: {}, timeout: 900000 })

  assert.equal(timers[0].timeout, 15 * 60 * 1000)
  timers[0].callback()
  assert.deepEqual(await request, { ok: false, error: 'Phone did not respond.' })
  assert.equal(pending.size, 0)
})

test('copy command keeps its long timeout and socket association in the link', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'link', 'index.js'), 'utf8')
  assert.match(source, /command\.action === 'copyTracksToPhone' \? 15 \* 60 \* 1000/)
  assert.match(source, /pending\.wait\(\{ requestId, socket, timeout \}\)/)
  assert.match(source, /pending\.settleSocket\(socket, \{ ok: false, error: 'Phone is no longer connected\.' \}\)/)
})
