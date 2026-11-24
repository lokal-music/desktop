import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const AdmZip = require('adm-zip')
const { PackageService, validateManifest, effectivePermissions } = require('../electron/mornye/packages')
const { domainAllowed, validateURL } = require('../electron/mornye/network')

function buildArchive(manifest, code) {
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('index.js', Buffer.from(code))
  return zip.toBuffer()
}

async function createService(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lokal-jellyfin-'))
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  const service = new PackageService(db, { root, tools: () => ({}) })
  t.after(async () => {
    for (const runtime of service.runtimes.values()) runtime.close()
    db.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  return { service, db, root }
}

const jellyfinManifest = {
  name: 'jellyfin',
  displayName: 'Jellyfin',
  version: '1.1.1',
  type: ['metadata_provider', 'download_provider', 'lyrics_provider'],
  permissions: {
    network: ['*'],
    storage: true,
    file: true,
    allowHttp: true,
  },
  urlHandler: { enabled: true, patterns: ['#/details?id='] },
  settings: [
    { key: 'server_url', label: 'Server URL', type: 'string', required: true },
    { key: 'username', label: 'Username', type: 'string', required: true },
    { key: 'password', label: 'Password', type: 'string', secret: true },
    { key: 'test_button', label: 'Test connection', type: 'button', action: 'testConnection' },
  ],
  minAppVersion: '5.3.0',
}

test('validateManifest accepts wildcard "*" network permission while rejecting malformed entries', () => {
  assert.doesNotThrow(() => validateManifest(jellyfinManifest))
  assert.equal(domainAllowed('jellyfin.example.com', ['*']), true)
  assert.equal(domainAllowed('192.168.1.50', ['*']), true)
  assert.doesNotThrow(() => validateURL('https://jellyfin.example.com/Users', { network: ['*'] }))
  assert.doesNotThrow(() => validateURL('http://192.168.1.50:8096/Users', { network: ['*'], allowHttp: true }))

  for (const bad of ['', ' ', '*.', 'a*b.com', 'https://example.com', 'example.com/path', 'example.com:8096', 42]) {
    assert.throws(
      () => validateManifest({ ...jellyfinManifest, permissions: { ...jellyfinManifest.permissions, network: [bad] } }),
      /Invalid addon network permissions/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    )
  }
})

test('Jellyfin addon installs and connects to a user-configured local server while blocking unconfigured private hosts', async t => {
  const { service } = await createService(t)
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port

  const code = `
    var cfg = {};
    registerExtension({
      initialize(s) { cfg = s || {}; },
      handleURL() { return { tracks: [] }; },
      download() { return { success: false, error: 'not used' }; },
      testConnection() {
        var r = http.get(cfg.server_url + '/System/Info/Public');
        return { ok: r.ok, body: r.body };
      },
      probeOtherPrivate() {
        return http.get('http://127.0.0.2:8096/System/Info/Public');
      },
    });
  `

  const installed = await service.install({ buffer: buildArchive(jellyfinManifest, code) })
  assert.equal(installed.id, 'jellyfin')
  const runtime = await service.runtime(installed.key)
  assert.deepEqual(await runtime.invoke('handleUrl'), { tracks: [] }, 'legacy handleURL registration remains callable through handleUrl')

  service.setSettings(installed.key, {
    server_url: `http://127.0.0.1:${port}`,
    username: 'demo',
  })

  const ping = await service.invokeAction(installed.key, 'testConnection')
  assert.equal(ping.ok, true)
  assert.deepEqual(JSON.parse(ping.body), { ok: true, path: '/System/Info/Public' })

  const blocked = await runtime.invoke('probeOtherPrivate')
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /private address without explicit permission/i)
})

test('grantsNetwork custom endpoint setting permits user-configured local HTTP hosts', () => {
  const addon = {
    manifest: {
      permissions: { network: ['api.example.com'], storage: true, file: true },
      settings: [
        { key: 'customEndpoint', type: 'string', grantsNetwork: true },
        { key: 'apiKey', type: 'string', secret: true },
      ],
    },
  }
  const perms = effectivePermissions(addon, {
    customEndpoint: 'http://192.168.1.10:8000',
    apiKey: 'http://ignored-secret.local',
  })
  assert.ok(perms.network.includes('192.168.1.10'))
  assert.ok(perms.localHosts.includes('192.168.1.10'))
  assert.ok(perms.httpHosts.includes('192.168.1.10'))
  assert.ok(!perms.network.includes('ignored-secret.local'))
  assert.doesNotThrow(() => validateURL('http://192.168.1.10:8000/track?id=1', perms))
  assert.throws(() => validateURL('http://api.example.com/track?id=1', perms), /requires HTTPS/)
})

test('preload multiplexes IPC listeners per channel without triggering MaxListenersExceededWarning', () => {
  const preloadSource = readFileSync(new URL('../electron/preload.js', import.meta.url), 'utf8')
  const ipcRenderer = new EventEmitter()
  ipcRenderer.setMaxListeners(10)
  ipcRenderer.invoke = () => Promise.resolve()
  ipcRenderer.send = () => {}
  ipcRenderer.postMessage = () => {}

  let exposedApi = null
  const sandbox = {
    require: name => {
      if (name === 'electron') {
        return {
          ipcRenderer,
          contextBridge: {
            exposeInMainWorld: (_name, api) => { exposedApi = api },
          },
        }
      }
      throw new Error(`Unexpected require: ${name}`)
    },
    window: { addEventListener: () => {} },
    Map,
    Set,
    Object,
  }
  vm.runInNewContext(preloadSource, sandbox)
  assert.ok(exposedApi?.onAddonAuthChanged)

  const received = []
  const unsubscribers = []
  for (let i = 0; i < 20; i++) {
    unsubscribers.push(exposedApi.onAddonAuthChanged(status => received.push(`${i}:${status.key}`)))
  }
  assert.equal(ipcRenderer.listenerCount('addons:auth-changed'), 1)

  ipcRenderer.emit('addons:auth-changed', {}, { key: 'jellyfin', authenticated: true })
  assert.equal(received.length, 20)
  assert.equal(received[0], '0:jellyfin')
  assert.equal(received[19], '19:jellyfin')

  for (const unsubscribe of unsubscribers) unsubscribe()
  assert.equal(ipcRenderer.listenerCount('addons:auth-changed'), 0)
})

test('AddonsSettings subscribes to addon auth changes once rather than per AddonCard', () => {
  const source = readFileSync(new URL('../src/components/AddonsSettings.jsx', import.meta.url), 'utf8')
  const cardStart = source.indexOf('function AddonCard(')
  const settingsStart = source.indexOf('export default function AddonsSettings(')
  assert.ok(cardStart >= 0 && settingsStart > cardStart)
  const cardSource = source.slice(cardStart, settingsStart)
  const settingsSource = source.slice(settingsStart)
  assert.doesNotMatch(cardSource, /onAddonAuthChanged/)
  assert.match(settingsSource, /onAddonAuthChanged/)
})
