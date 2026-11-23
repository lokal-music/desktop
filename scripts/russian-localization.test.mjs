import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { RU_TRANSLATIONS } from '../src/i18n/ru.js'

const i18nSource = readFileSync(new URL('../src/i18n.jsx', import.meta.url), 'utf8')
const rowsStart = i18nSource.indexOf('const ROWS = Object.assign(')
const rowsEnd = i18nSource.indexOf('\nconst TRANSLATIONS =')
const ROWS = new Function(`${i18nSource.slice(rowsStart, rowsEnd)}; return ROWS;`)()

const placeholdersOf = value => [...String(value).matchAll(/\{([a-zA-Z0-9_.]+)\}/g)].map(m => m[1]).sort()

test('APP_LANGUAGES includes Russian (ru / Русский) and wires RU_TRANSLATIONS', () => {
  assert.match(i18nSource, /\{\s*code:\s*'ru',\s*name:\s*'Русский'\s*\}/)
  assert.match(i18nSource, /import\s+\{\s*RU_TRANSLATIONS\s*\}\s+from\s+'\.\/i18n\/ru'/)
  assert.match(i18nSource, /TRANSLATIONS\[phrase\]\.ru\s*=\s*translation/)
})

test('RU_TRANSLATIONS covers every key in ROWS with non-empty strings and matching placeholders', () => {
  const missing = []
  const empty = []
  const placeholderMismatches = []

  for (const key of Object.keys(ROWS)) {
    if (!Object.prototype.hasOwnProperty.call(RU_TRANSLATIONS, key)) {
      missing.push(key)
      continue
    }
    const translated = RU_TRANSLATIONS[key]
    if (typeof translated !== 'string' || !translated.trim()) {
      empty.push(key)
      continue
    }
    if (key.includes('|')) {
      const forms = translated.split('|')
      assert.equal(forms.length, 3, `Expected 3 Russian plural forms for ${JSON.stringify(key)}`)
      const expected = placeholdersOf(key.split('|')[0])
      for (const form of forms) {
        if (JSON.stringify(placeholdersOf(form)) !== JSON.stringify(expected)) {
          placeholderMismatches.push(`${key} -> ${form}`)
        }
      }
    } else if (JSON.stringify(placeholdersOf(key)) !== JSON.stringify(placeholdersOf(translated))) {
      placeholderMismatches.push(`${key} -> ${translated}`)
    }
  }

  assert.deepEqual(missing, [], `Missing Russian translations for ROWS keys: ${missing.slice(0, 10).join(', ')}`)
  assert.deepEqual(empty, [], `Empty Russian translations: ${empty.slice(0, 10).join(', ')}`)
  assert.deepEqual(placeholderMismatches, [], `Placeholder mismatches: ${placeholderMismatches.slice(0, 10).join(', ')}`)
})

test('RU_TRANSLATIONS covers static t() keys across src/', () => {
  const srcRoot = new URL('../src', import.meta.url).pathname
  const keys = new Set()
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(jsx?|mjs)$/.test(entry.name) && entry.name !== 'i18n.jsx' && entry.name !== 'ru.js') {
        const code = readFileSync(full, 'utf8')
        for (const match of code.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1)[^\\\n])+)\1/g)) {
          const phrase = match[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\')
          if (phrase.trim()) keys.add(phrase)
        }
      }
    }
  }
  walk(srcRoot)

  const missing = [...keys].filter(key => !Object.prototype.hasOwnProperty.call(RU_TRANSLATIONS, key))
  assert.deepEqual(missing, [], `Missing Russian translations for static t() calls: ${missing.join(', ')}`)
})

test('Russian 3-form plural rules select one, few, and many correctly', () => {
  const rules = new Intl.PluralRules('ru')
  const pick = (phrase, n) => {
    const forms = RU_TRANSLATIONS[phrase].split('|')
    const cat = rules.select(n)
    const idx = cat === 'one' ? 0 : cat === 'few' ? 1 : 2
    return forms[idx].replace(/\{n\}/g, String(n))
  }
  assert.equal(pick('{n} file|{n} files', 1), '1 файл')
  assert.equal(pick('{n} file|{n} files', 2), '2 файла')
  assert.equal(pick('{n} file|{n} files', 5), '5 файлов')
  assert.equal(pick('{n} file|{n} files', 21), '21 файл')
  assert.equal(pick('{n} file|{n} files', 24), '24 файла')
})
