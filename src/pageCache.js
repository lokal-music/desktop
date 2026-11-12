// Page polish: pages keep what they last showed, and only fade in once they
// have something real to show.
//
// Every page fetches its data when it mounts, so it used to paint its empty
// state first ("No tracks yet", "Folder not set", "Loading artists..."), then
// swap in the data a few frames later. Two small tools fix that:
//
//   useCachedState  a useState that remembers its value across visits, so
//                   coming back to a page paints the last data on frame one
//                   (and the page still refetches it quietly).
//   usePageReady    tells the route transition the page has its data; the
//                   page stays invisible until then (or PAGE_READY_TIMEOUT_MS,
//                   so a slow load never hides a page for long).

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { readViewState, writeViewState } from './statePersistence.mjs'

const cache = new Map()
const MAX_PAGE_CACHE_ENTRIES = 32
export function clearPageCache() { cache.clear() }

function readCache(key) {
  if (!cache.has(key)) return undefined
  const value = cache.get(key)
  cache.delete(key)
  cache.set(key, value)
  return value
}

function storeCache(key, value) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_PAGE_CACHE_ENTRIES) cache.delete(cache.keys().next().value)
}

/** The value a page last stored under `key`, or undefined. */
export function peekCache(key) {
  return readCache(key)
}

/** Store a value for the next visit of a page. */
export function writeCache(key, value) {
  storeCache(key, value)
}

/**
 * useState whose value outlives the page: the next mount starts from the
 * last value instead of `initial`. `key` should include whatever the data
 * depends on (e.g. the user id), and must not change while the component is
 * mounted: give the component a React `key` that changes with it instead,
 * so it remounts (see Home and Recap). Returns [value, setValue, wasCached].
 */
export function useCachedState(key, initial) {
  const wasCached = useRef(cache.has(key)).current
  const [value, setValue] = useState(() => (cache.has(key) ? readCache(key) : (readViewState(key) ?? (typeof initial === 'function' ? initial() : initial))))
  const keyRef = useRef(key)
  keyRef.current = key
  // Only values set through `set` are stored (not the initial one), and only
  // once React has committed them: the updater itself stays pure.
  const dirty = useRef(false)
  const set = useCallback((next) => {
    dirty.current = true
    setValue(next)
  }, [])
  useEffect(() => {
    if (dirty.current) {
      storeCache(keyRef.current, value)
      if (typeof value === 'string') writeViewState(keyRef.current, value)
    }
  }, [value])
  return [value, set, wasCached]
}

// How long a page may stay hidden waiting for its data before it's shown anyway.
export const PAGE_READY_TIMEOUT_MS = 350

export const PageReadyContext = createContext(null)

// True once the page has finished fading in (always true outside a page).
// Artwork waits for it before fading itself in, so the page's fade doesn't
// share its frames with dozens of image fades.
export const PageShownContext = createContext(true)

/**
 * Hold the page's fade-in until `ready` is true. Layout effect, so a page
 * whose data is already cached is released before its first paint.
 */
export function usePageReady(ready) {
  const markReady = useContext(PageReadyContext)
  useLayoutEffect(() => {
    if (ready) markReady?.()
  }, [ready, markReady])
}
