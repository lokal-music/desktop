import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

test('the app and the web server keep the same secret settings, passwords and tokens included', () => {
  const scanner = read('electron/ipc/scanner.js')
  const list = read('electron/appDataExport.js').match(/const SECRET_SETTING_KEYS = new Set\(\[([^\]]*)\]\)/)?.[1] || ''
  for (const key of ['soulseek_password', 'soulseek_api_key', 'apple_music_user_token', 'spotify_sp_dc']) assert.ok(list.includes(`'${key}'`), key)
  assert.match(scanner, /module\.exports = \{[^}]*SECRET_SETTING_KEYS/)
  const route = read('server/routes/settings.js')
  assert.match(route, /SECRET_SETTING_KEYS \} = require\('\.\.\/\.\.\/electron\/ipc\/scanner'\)/)
  assert.match(route, /const SECRET_KEYS = SECRET_SETTING_KEYS/)
})
