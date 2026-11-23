import React, { useRef } from 'react'
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react'
import Modal from './Modal'
import {
  LOCAL_HOME_SECTION_TITLES,
  moveLocalHomeSection,
  restoreLocalHomeLayout,
  showLocalHomeSection,
} from '../localHomeLayout.mjs'
import { useTranslation } from '../i18n'

/** Drag-and-drop plus keyboard-accessible editor for Local Home sections.
 * Hidden sections remain listed here so users can always restore them.
 */
export default function LocalHomeSectionEditor({ open, layout, onChange, onClose }) {
  const { t } = useTranslation()
  const dragged = useRef(null)
  if (!layout) return null
  return (
    <Modal open={open} onClose={onClose} title={t('Edit Local Home sections')} width="max-w-lg">
      <p className="mb-4 text-sm text-muted">{t('Choose sections to show and drag to reorder.')}</p>
      <div className="space-y-2" data-local-home-layout-editor>
        {layout.order.map((id, index) => {
          const visible = !layout.hidden.includes(id)
          const label = t(LOCAL_HOME_SECTION_TITLES[id] || id)
          return (
            <div key={id} draggable
              onDragStart={event => { dragged.current = id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id) }}
              onDragOver={event => { if (dragged.current) event.preventDefault() }}
              onDrop={event => {
                event.preventDefault()
                const from = layout.order.indexOf(dragged.current)
                dragged.current = null
                if (from >= 0) onChange(moveLocalHomeSection(layout, from, index))
              }}
              onDragEnd={() => { dragged.current = null }}
              className="flex items-center gap-3 rounded-xl border border-border bg-card/70 px-3 py-2">
              <GripVertical size={17} className="shrink-0 cursor-grab text-muted" aria-hidden="true" />
              <span className={`min-w-0 flex-1 truncate text-sm ${visible ? 'text-white' : 'text-muted'}`}>{label}</span>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={visible} onChange={event => onChange(showLocalHomeSection(layout, id, event.target.checked))}
                  aria-label={t('Show {name}', { name: label })} className="accent-accent" />
                {t('Show')}
              </label>
              <div className="flex items-center gap-1">
                <button type="button" aria-label={t('Move {name} up', { name: label })}
                  disabled={index === 0} onClick={() => onChange(moveLocalHomeSection(layout, index, index - 1))}
                  className="rounded-md p-1.5 text-muted hover:bg-white/10 hover:text-white disabled:opacity-30"><ArrowUp size={15} /></button>
                <button type="button" aria-label={t('Move {name} down', { name: label })}
                  disabled={index === layout.order.length - 1} onClick={() => onChange(moveLocalHomeSection(layout, index, index + 1))}
                  className="rounded-md p-1.5 text-muted hover:bg-white/10 hover:text-white disabled:opacity-30"><ArrowDown size={15} /></button>
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <button type="button" onClick={() => onChange(restoreLocalHomeLayout())}
          className="rounded-lg border border-border px-3.5 py-2 text-xs text-muted hover:text-white transition-colors">
          {t('Reset')}
        </button>
        <button type="button" onClick={onClose} className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-base">{t('Done')}</button>
      </div>
    </Modal>
  )
}
