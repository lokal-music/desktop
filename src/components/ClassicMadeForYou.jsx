// Home → Local: the original cylindrical carousel, selectable in Appearance.
// carousel that rolls round like the outside of a cylinder: the card in the
// middle is the biggest and highest, the others shrink and sink toward the
// edges, and the row loops. Drag it, scroll it sideways or use the arrow
// keys; it settles on a card. A click plays (the card the press started on,
// unless it was a drag). Hovering a card lifts it a little. The row runs the
// full width of the page area (past the page's content column, edges faded),
// with more cards on a wide window rather than bigger ones.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { Play } from 'lucide-react'
import FadeImg from './FadeImg'
import { trackArtURL } from '../onlineTracks'
import { useTranslation } from '../i18n'

const ASPECT = 3 / 4 // card width / height
const MAX_HEIGHT = 250 // the middle card's height, when there's room
const SLOTS = [9, 7, 5] // card slots across the row: the most that fit at full size, at least 5
const MIN_SCALE = 0.72 // the edge cards' size, from the middle one's
const ARC = 0.27 // how far the edge cards sink, from the card height
const GAP = 0.08 // space between cards, from the card width
const DRAG_THRESHOLD = 6 // px: past this, a press is a drag, not a click
const SPRING = { type: 'spring', stiffness: 170, damping: 26, mass: 1 }
const TOP = 14 // px above the middle card (room for a hovered card to rise 8px)
const EDGE_FADE = 'linear-gradient(to right, transparent, #000 5%, #000 95%, transparent)'

// `half`: half the slots across the row.
// Size at `u` cards from the middle: full in the middle, MIN_SCALE from halfway out.
const scaleAt = (u, half) => Math.min(1, Math.abs(u) / half) >= 1 ? MIN_SCALE : MIN_SCALE + (1 - MIN_SCALE) * Math.cos((Math.abs(u) / half) * Math.PI / 2)
// Where the card's centre sits: the sizes of the cards before it added up, so
// smaller cards pack closer and nothing overlaps.
function centreAt(u, half) {
  const a = Math.abs(u)
  const inner = Math.min(a, half)
  const area = MIN_SCALE * inner + (1 - MIN_SCALE) * (2 * half / Math.PI) * Math.sin((inner / half) * Math.PI / 2) + MIN_SCALE * Math.max(0, a - half)
  return Math.sign(u) * area
}
const wrap = (value, count) => value - Math.round(value / count) * count
// The row's width, in card widths, for `slots` slots.
const rowOf = slots => (centreAt(slots / 2, slots / 2) * 2 + MIN_SCALE) * (1 + GAP)

function Card({ index, count, scroll, width, height, half, children, onPress }) {
  const offset = useTransform(scroll, s => wrap(index - s, count))
  const x = useTransform(offset, o => centreAt(o, half) * width * (1 + GAP))
  const scale = useTransform(offset, o => scaleAt(o, half))
  const y = useTransform(offset, o => height * ARC * (1 - Math.cos(Math.min(1, Math.abs(o) / half) * Math.PI / 2)) + height * ARC * Math.max(0, Math.abs(o) - half) * 0.5)
  const zIndex = useTransform(offset, o => 100 - Math.round(Math.abs(o) * 10))
  const opacity = useTransform(offset, o => Math.abs(o) > half + 1 ? 0 : 1)
  return (
    <motion.div style={{ x, y, scale, zIndex, opacity, width, height, marginLeft: -width / 2, top: TOP }}
      className="absolute left-1/2 will-change-transform" onClick={onPress}>
      {children}
    </motion.div>
  )
}

export default function ClassicMadeForYou({ picks, onPlay, onContextMenu }) {
  const { t } = useTranslation()
  const scroll = useMotionValue(0)
  const stage = useRef(null)
  const [size, setSize] = useState({ width: 0, height: MAX_HEIGHT, half: 2.5 })
  // How far the row reaches past the page's content column, each side, to
  // the page area's edges.
  const [bleed, setBleed] = useState({ left: 0, right: 0 })
  const drag = useRef(null)
  const dragged = useRef(false)
  const moving = useRef(null)
  const wheelTimer = useRef(null)
  const count = picks.length
  // The middle card at rest on the first pick.
  useEffect(() => { scroll.set(0) }, [count]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const element = stage.current
    const host = element?.parentElement
    if (!element || !host) return undefined
    const page = element.closest('main')
    const measure = () => {
      // The page area, between the sidebars (its scrollbar left out).
      if (page) {
        const area = page.getBoundingClientRect()
        const column = host.getBoundingClientRect()
        const left = Math.max(0, Math.round(column.left - area.left))
        const right = Math.max(0, Math.round(area.left + page.clientWidth - column.right))
        setBleed(current => current.left === left && current.right === right ? current : { left, right })
      }
      const width = element.clientWidth
      // The most slots that fit at full card size; at least the fewest, smaller.
      const slots = SLOTS.find(n => width / rowOf(n) >= MAX_HEIGHT * ASPECT) || SLOTS[SLOTS.length - 1]
      const cardWidth = Math.min(MAX_HEIGHT * ASPECT, width / rowOf(slots))
      setSize(current => current.width === cardWidth && current.half === slots / 2 ? current : { width: cardWidth, height: cardWidth / ASPECT, half: slots / 2 })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(host)
    if (page) observer.observe(page)
    return () => observer.disconnect()
  }, [])

  const settle = (target, velocity = 0) => {
    moving.current?.stop()
    const to = Math.round(target)
    moving.current = animate(scroll, to, { ...SPRING, velocity })
  }
  const step = by => settle(Math.round(scroll.get()) + by)

  const onPointerDown = event => {
    if (event.button !== 0) return
    dragged.current = false
    moving.current?.stop()
    drag.current = { x: event.clientX, start: scroll.get(), moved: false, last: [{ x: event.clientX, t: performance.now() }], pointer: event.pointerId }
  }
  const onPointerMove = event => {
    const state = drag.current
    if (!state || event.pointerId !== state.pointer) return
    const dx = event.clientX - state.x
    if (!state.moved && Math.abs(dx) > DRAG_THRESHOLD) { state.moved = true; event.currentTarget.setPointerCapture?.(event.pointerId) }
    if (!state.moved) return
    scroll.set(state.start - dx / (size.width * (1 + GAP)))
    state.last = [...state.last.slice(-4), { x: event.clientX, t: performance.now() }]
  }
  const onPointerUp = event => {
    const state = drag.current
    if (!state || event.pointerId !== state.pointer) return
    if (state.moved) {
      // A flick keeps rolling a little before it settles.
      const [first, last] = [state.last[0], state.last[state.last.length - 1]]
      const seconds = Math.max(0.016, (last.t - first.t) / 1000)
      const velocity = -((last.x - first.x) / seconds) / (size.width * (1 + GAP)) // cards per second
      settle(scroll.get() + Math.max(-4, Math.min(4, velocity * 0.25)), velocity)
    }
    // The click that ends a drag isn't a click (cleared by the next press).
    dragged.current = state.moved
    drag.current = null
  }
  // Sideways scrolling (trackpad, shift + wheel) rolls it; up and down still scroll the page.
  const onWheel = event => {
    const dx = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0
    if (!dx) return
    moving.current?.stop()
    scroll.set(scroll.get() + dx / (size.width * (1 + GAP)))
    clearTimeout(wheelTimer.current)
    wheelTimer.current = setTimeout(() => settle(scroll.get()), 120)
  }
  useEffect(() => () => { clearTimeout(wheelTimer.current); moving.current?.stop() }, [])
  const onKeyDown = event => {
    if (event.key === 'ArrowRight') { event.preventDefault(); step(1) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1) }
  }

  if (!picks.length) return null
  // The middle card at the top; down to the bottom of the lowest whole card
  // (half way out: sunk by ARC, at MIN_SCALE, scaled about its centre).
  const stageHeight = TOP + size.height * (ARC + (1 + MIN_SCALE) / 2) + 14
  return (
    <section aria-roledescription="carousel" aria-label={t('Made for you')}>
      <div ref={stage} tabIndex={0} onKeyDown={onKeyDown} onWheel={onWheel}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        className="relative isolate cursor-grab touch-pan-y select-none overflow-hidden outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-accent/40"
        // isolate: the cards' z-index (the middle one on top) stays inside the carousel, under the full screen player.
        // The row reaches the page area's edges, fading out there.
        style={{ height: stageHeight, marginLeft: -bleed.left, marginRight: -bleed.right, WebkitMaskImage: EDGE_FADE, maskImage: EDGE_FADE }}>
        {size.width > 0 && picks.map((pick, index) => (
          <Card key={pick.track.id} index={index} count={count} scroll={scroll} width={size.width} height={size.height} half={size.half}
            onPress={() => { if (dragged.current) { dragged.current = false; return } onPlay(index) }}>
            <button type="button" aria-label={t('Play {title} by {artist}', { title: pick.track.title, artist: pick.track.artist })} onContextMenu={event => onContextMenu?.(event, pick.track)}
              className="group relative block h-full w-full overflow-hidden rounded-2xl border border-white/10 bg-card text-left shadow-[0_18px_40px_rgba(0,0,0,0.45)] transition-[translate,box-shadow] duration-300 ease-out hover:shadow-[0_26px_50px_rgba(0,0,0,0.55)] hover:-translate-y-2">
              {trackArtURL(pick.track) ? <FadeImg src={trackArtURL(pick.track)} className="pointer-events-none absolute inset-0 h-full w-full object-cover" /> : <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-black" />}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/85 via-black/40 to-transparent" />
              <span className="absolute left-1/2 top-1/2 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-[rgb(var(--bg-rgb))] opacity-0 shadow-lg transition-opacity group-hover:opacity-100"><Play size={20} fill="currentColor" /></span>
              <span className="absolute inset-x-0 bottom-0 p-3.5">
                <span className="block truncate text-sm font-semibold text-white">{pick.track.title}</span>
                <span className="block truncate text-xs text-white/70">{pick.track.artist}</span>
                <span className="mt-1.5 inline-block max-w-full truncate rounded-full bg-white/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/80 backdrop-blur-sm">{pick.mix.name}</span>
              </span>
            </button>
          </Card>
        ))}
      </div>
    </section>
  )
}
