import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const { findByPath } = require('../electron/libraryPathIdentity')
const workerFile = fileURLToPath(new URL('../electron/download/libraryRepairWorker.js', import.meta.url))

test('exact library paths resolve without stat probes and duplicate inserts', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-startup-path-'))
  const database = new Database(':memory:')
  t.after(() => { database.close(); fs.rmSync(folder, { recursive: true, force: true }) })
  database.exec('CREATE TABLE tracks (id TEXT PRIMARY KEY, file_path TEXT UNIQUE NOT NULL)')
  const file = path.join(folder, 'track.flac')
  database.prepare('INSERT INTO tracks (id, file_path) VALUES (?, ?)').run('existing', file)
  // A temporarily missing file is still the stored library entry, so a new
  // metadata scan must update it instead of inserting a conflicting path.
  assert.equal(findByPath(database, file)?.id, 'existing')
})

test('same-file repair runs in a separate worker against the existing SQLite file', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-startup-worker-'))
  const databasePath = path.join(folder, 'lokal.db')
  const database = new Database(databasePath)
  t.after(() => { database.close(); fs.rmSync(folder, { recursive: true, force: true }) })
  database.exec(`
    CREATE TABLE tracks (id TEXT PRIMARY KEY, file_path TEXT UNIQUE NOT NULL);
    CREATE TABLE track_aliases (old_id TEXT PRIMARY KEY, track_id TEXT NOT NULL);
  `)
  database.prepare('INSERT INTO tracks (id, file_path) VALUES (?, ?)').run('existing', path.join(folder, 'track.flac'))
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: { databasePath } })
    let message
    worker.once('message', value => { message = value })
    worker.once('error', reject)
    worker.once('exit', code => code === 0 ? resolve(message) : reject(new Error(`Worker exited with ${code}`)))
  })
  assert.deepEqual(result, { repaired: 0 })
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tracks').get().count, 1)
})
