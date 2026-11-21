const assert = require('node:assert/strict')
const { test } = require('node:test')

const rows = [
  { id: 'one', title: 'One', artist: 'Artist', file_path: 'C:\\music\\one.flac', file_hash: 'abc' },
  { id: 'ghost', title: 'Ghost', artist: 'Artist', file_path: 'ghost://youtube/online/123' },
]
let query = ''
let parameters = []
let queryCount = 0
const database = {
  prepare(sql) {
    query = sql
    return {
      all(...ids) {
        parameters = ids
        queryCount++
        return rows.filter(row => ids.includes(row.id) && !row.file_path.startsWith('ghost://'))
      },
    }
  },
}

const db = require('../electron/ipc/db')
const originalGetDB = db.getDB
db.getDB = () => database
const router = require('../server/routes/remote')
db.getDB = originalGetDB
const lookup = router.stack.find(layer => layer.route?.path === '/library/tracks/lookup')
  .route.stack[0].handle

function response() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this },
    set(name, value) { this.headers[name] = value; return this },
    json(body) { this.body = body; return this },
  }
}

function request(body, linkDevice = { id: 'phone', user_id: 'guest' }) {
  const res = response()
  lookup({ body, linkDevice }, res)
  return res
}

test('paired exact-ID lookup returns matching compact metadata and omits unknown or ghost tracks', () => {
  const res = request({ ids: ['one', 'missing', 'ghost'] })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(parameters, ['one', 'missing', 'ghost'])
  assert.match(query, /t\.id IN \(\?,\?,\?\)/)
  assert.doesNotMatch(query, /one|missing/)
  assert.match(query, /t\.file_path NOT LIKE 'ghost:\/\/%'/)
  assert.deepEqual(res.body.items.map(item => item.id), ['one'])
  assert.equal(res.body.items[0].fileType, 'flac')
  assert.equal(res.body.items[0].title, 'One')
  assert.equal(res.body.items[0].artist, 'Artist')
  assert.equal('file_path' in res.body.items[0], false)
  assert.equal(res.headers['Cache-Control'], 'private, no-store')
})

test('exact-ID lookup rejects malformed, duplicate, and oversized ID lists', () => {
  const before = queryCount
  for (const ids of [null, [], Array(101).fill('id'), ['one', 'one'], [''], ['  '], [1]]) {
    const res = request({ ids })
    assert.equal(res.statusCode, 400)
    assert.equal(typeof res.body.error, 'string')
  }
  assert.equal(queryCount, before)
})

test('exact-ID lookup rejects unpaired phones before querying', () => {
  const before = queryCount
  const res = request({ ids: ['one'] }, null)
  assert.equal(res.statusCode, 403)
  assert.match(res.body.error, /Pair this phone/)
  assert.equal(queryCount, before)
})
