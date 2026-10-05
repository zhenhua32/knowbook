import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useViewportMenuPosition } from './useViewportMenuPosition'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'

type Owner = { id: string; row: HTMLLIElement; title: string; x: number; y: number }
import type { TreeTitleEntries, TreeTitlePreviewProps } from './useTreeTitlePreview'

export default function TreeTitlePreviewController({ entries, dragging, isZh, id, register, onOwnerChange }: TreeTitlePreviewProps) {
  const preview = usePreview(entries, dragging, isZh, id)
  useLayoutEffect(() => { register(preview); return () => register(null) }, [register])
  useLayoutEffect(() => onOwnerChange(preview.ownerId), [preview.ownerId, onOwnerChange])
  return preview.content
}

function usePreview(entries: TreeTitleEntries, dragging: boolean, isZh: boolean, id: string) {
  const entriesRef = useRef(entries), owner = useRef<Owner | null>(null)
  const hovered = useRef(false), panelHovered = useRef(false), dismissed = useRef<string | null>(null), revision = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panel = useRef<HTMLDivElement>(null), reader = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState<Owner | null>(null)
  const shown = useRef(false), draggingRef = useRef(dragging)
  entriesRef.current = entries; draggingRef.current = dragging

  const cancel = () => { revision.current++; if (timer.current !== null) clearTimeout(timer.current); timer.current = null }
  const dismiss = (blockedId = owner.current?.id ?? null) => {
    cancel(); dismissed.current = blockedId; owner.current = null; hovered.current = false; panelHovered.current = false; shown.current = false; setVisible(null)
  }
  const inspect = (documentId: string, row: HTMLLIElement): Owner | null => {
    const title = row.querySelector<HTMLElement>('.tree-document-title'), text = entriesRef.current.get(documentId)?.node.title
    const viewport = row.closest<HTMLElement>('.tree-virtual-scroll'), rect = row.getBoundingClientRect(), clip = viewport?.getBoundingClientRect()
    if (draggingRef.current || !row.isConnected || !title || text === undefined || title.textContent !== text || title.scrollWidth <= title.clientWidth + 1
      || !clip || rect.width <= 0 || rect.height <= 0 || clip.width <= 0 || clip.height <= 0
      || rect.top < clip.top - 1 || rect.bottom > clip.bottom + 1 || rect.left < clip.left - 1 || rect.right > clip.right + 1) return null
    const doc = row.ownerDocument, hit = doc.elementFromPoint?.(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (typeof doc.elementFromPoint === 'function' && (!hit || !row.contains(hit))) return null
    return { id: documentId, row, title: text, x: rect.right + 8, y: rect.top }
  }
  const schedule = (next: Owner | null) => {
    cancel(); shown.current = false; setVisible(null); owner.current = next
    if (!next || dismissed.current === next.id) return
    const token = revision.current
    timer.current = setTimeout(() => {
      if (token !== revision.current || owner.current !== next || (!hovered.current && next.row.ownerDocument.activeElement !== next.row)) return
      timer.current = null
      const current = inspect(next.id, next.row)
      if (!current || current.title !== next.title) return
      owner.current = current; shown.current = true; setVisible(current)
    }, 350)
  }
  const leave = () => {
    hovered.current = false; cancel()
    const current = owner.current
    if (!current) return
    if (current.row.ownerDocument.activeElement === current.row) { if (!shown.current) schedule(current); return }
    const token = revision.current
    timer.current = setTimeout(() => { if (token === revision.current && !hovered.current) dismiss() }, 200)
  }
  const enter = (documentId: string, row: HTMLLIElement) => {
    const next = inspect(documentId, row), current = owner.current
    // Scrolling to a keyboard target can move a short row under a stationary
    // pointer. That row has no preview and must not discard the focused reader.
    if (!next && current && current.row.ownerDocument.activeElement === current.row && inspect(current.id, current.row)) return
    dismissed.current = null; panelHovered.current = false; hovered.current = true; schedule(next)
  }
  const focus = (documentId: string, row: HTMLLIElement) => {
    hovered.current = row.matches(':hover')
    schedule(inspect(documentId, row))
  }
  const blur = (documentId: string) => {
    if (owner.current?.id === documentId && !hovered.current && !panelHovered.current) dismiss(null)
    if (dismissed.current === documentId) dismissed.current = null
  }
  const scrolled = () => {
    // Keyboard revelation scrolls before its delayed focus preview opens.
    if (shown.current || owner.current?.row !== owner.current?.row.ownerDocument.activeElement) dismiss()
  }

  const validate = () => {
    const current = owner.current
    if (!current) return
    const next = inspect(current.id, current.row)
    if (draggingRef.current || !next || next.title !== current.title || (shown.current && (next.x !== current.x || next.y !== current.y))) dismiss()
  }
  useLayoutEffect(validate)
  useEffect(() => {
    const hide = () => dismiss()
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) scrolled() }
    const pointer = (event: PointerEvent) => { if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) dismiss() }
    const focusOutside = (event: FocusEvent) => {
      if (owner.current && event.target instanceof Node && !owner.current.row.contains(event.target) && !panel.current?.contains(event.target)
        && !(panelHovered.current && event.target === owner.current.row.ownerDocument.body)) dismiss()
    }
    const key = (event: globalThis.KeyboardEvent) => {
      const current = owner.current
      if (!current || isImeKeyboardEvent(event) || event.altKey || event.ctrlKey || event.metaKey) return
      const ownsFocus = current.row.ownerDocument.activeElement === current.row
      if (event.key === 'Escape') { dismiss(); if (ownsFocus) { event.preventDefault(); event.stopPropagation() } }
      else if (shown.current && ownsFocus && reader.current && reader.current.scrollHeight > reader.current.clientHeight + 1 && ['PageUp', 'PageDown'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        reader.current.scrollTop += (event.key === 'PageDown' ? 1 : -1) * reader.current.clientHeight * .8
      }
    }
    window.addEventListener('resize', hide); window.addEventListener('blur', hide); window.addEventListener('scroll', scroll, true)
    window.addEventListener('pointerdown', pointer, true); window.addEventListener('focusin', focusOutside, true); window.addEventListener('keydown', key, true)
    // React's development replay cancels the first mount's delay. Preserve its
    // owner so the replay starts a fresh delay while stale generations stay inert.
    if (owner.current && timer.current === null && !shown.current) schedule(owner.current)
    return () => {
      cancel(); shown.current = false; window.removeEventListener('resize', hide); window.removeEventListener('blur', hide); window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('focusin', focusOutside, true); window.removeEventListener('keydown', key, true)
    }
  }, [])

  return { id, ownerId: visible?.id, enter, leave, focus, blur, dismiss, scrolled,
    content: visible && createPortal(<TreeTitlePreview key={visible.id} owner={visible} id={id} panel={panel} reader={reader} isZh={isZh}
      onEnter={() => { panelHovered.current = true; cancel() }} onLeave={() => { panelHovered.current = false; leave() }} onMeasure={validate} />, visible.row.ownerDocument.body) }
}

function TreeTitlePreview({ owner, id, panel, reader, isZh, onEnter, onLeave, onMeasure }: {
  owner: Owner; id: string; panel: RefObject<HTMLDivElement | null>; reader: RefObject<HTMLDivElement | null>
  isZh: boolean; onEnter: () => void; onLeave: () => void; onMeasure: () => void
}) {
  const { menuRef, menuStyle } = useViewportMenuPosition<HTMLDivElement>(owner.x, owner.y)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    let active = true
    const measure = () => { if (!active) return; if (reader.current) setOverflow(reader.current.scrollHeight > reader.current.clientHeight + 1); onMeasure() }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (reader.current) observer?.observe(reader.current)
    observer?.observe(owner.row)
    const title = owner.row.querySelector('.tree-document-title'); if (title) observer?.observe(title)
    return () => { active = false; observer?.disconnect() }
  }, [owner.title])
  return <div className="block-context-menu tree-title-preview" role="tooltip" id={id} style={menuStyle}
    ref={element => { menuRef.current = element; panel.current = element }} onPointerEnter={onEnter} onPointerLeave={onLeave}>
    <div className="tree-title-preview-text" ref={reader}>{owner.title}</div>
    {overflow && <small className="tree-title-preview-hint">{isZh ? 'PageUp / PageDown 阅读标题' : 'PageUp / PageDown to read the title'}</small>}
  </div>
}
