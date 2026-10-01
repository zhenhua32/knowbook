import { useState, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'

type BlockSearchItem = { index: number; type: string; contentPreview: string }
type BlockSearchPanelProps = {
  isOpen: boolean
  isZh?: boolean
  query: string
  placeholder: string
  noMatchText: string
  items: BlockSearchItem[]
  onQueryChange: (query: string) => void
  onClose: () => void
  onSelect: (index: number) => void
  returnFocusRef?: RefObject<HTMLElement | null>
}

function isHidden(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return true
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
}

function isVisible(element: HTMLElement): boolean {
  return element.isConnected && !isHidden(element) && element.getClientRects().length > 0
}

export function BlockSearchPanel({ isOpen, isZh, query, placeholder, noMatchText, items, onQueryChange, onClose, onSelect, returnFocusRef }: BlockSearchPanelProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const resultsRef = useRef<HTMLDivElement>(null)
  const hasNavigated = useRef(false)
  const safeIndex = Math.min(activeIndex, Math.max(0, items.length - 1))
  // Keep the match list bounded even for a query found in thousands of blocks.
  const windowStart = Math.max(0, safeIndex - 30)
  const visibleItems = items.slice(windowStart, windowStart + 60)
  const previousOpenRef = useRef(false)
  const ownsFocusRef = useRef(false)
  const focusSessionRef = useRef<{ panel: HTMLElement; scope: HTMLElement } | null>(null)

  useLayoutEffect(() => () => {
    ownsFocusRef.current = false
    focusSessionRef.current = null
    previousOpenRef.current = false
  }, [])

  useLayoutEffect(() => {
    const panel = panelRef.current, scope = panel?.parentElement
    if (!isOpen || !returnFocusRef || !panel || !scope) return
    const document = panel.ownerDocument
    focusSessionRef.current = { panel, scope }
    ownsFocusRef.current = panel.contains(document.activeElement)
    const trackFocus = (event: FocusEvent) => {
      if (event.target !== document.body) ownsFocusRef.current = panel.contains(event.target as Node | null)
    }
    const trackPointer = (event: PointerEvent) => {
      if (!panel.contains(event.target as Node | null)) ownsFocusRef.current = false
    }
    const abandon = () => { ownsFocusRef.current = false }
    document.addEventListener('focusin', trackFocus, true)
    document.addEventListener('pointerdown', trackPointer, true)
    document.defaultView?.addEventListener('blur', abandon)
    return () => {
      document.removeEventListener('focusin', trackFocus, true)
      document.removeEventListener('pointerdown', trackPointer, true)
      document.defaultView?.removeEventListener('blur', abandon)
    }
  }, [isOpen, returnFocusRef])

  useLayoutEffect(() => {
    const wasOpen = previousOpenRef.current
    previousOpenRef.current = isOpen
    if (!wasOpen || isOpen) return
    const session = focusSessionRef.current, owned = ownsFocusRef.current
    focusSessionRef.current = null
    ownsFocusRef.current = false
    const target = returnFocusRef?.current
    if (!session || !owned || !target) return
    const document = session.panel.ownerDocument
    if (target.ownerDocument !== document || !document.hasFocus() || !isVisible(session.scope)
      || isHidden(session.panel) || !isVisible(target) || target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true'
      || (document.activeElement !== document.body && !session.panel.contains(document.activeElement))) return
    const modalOpen = [...document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')].some(isVisible)
    if (!modalOpen) target.focus({ preventScroll: true })
  }, [isOpen, returnFocusRef])

  useEffect(() => {
    if (isOpen) inputRef.current?.focus({ preventScroll: true })
    setActiveIndex(0)
    hasNavigated.current = false
  }, [isOpen, query])

  useEffect(() => {
    const container = resultsRef.current
    const child = container?.querySelector<HTMLElement>(`[data-result-index="${safeIndex}"]`)
    if (!container || !child) return
    const top = child.offsetTop - container.offsetTop
    if (top < container.scrollTop) container.scrollTop = top
    else if (top + child.offsetHeight > container.scrollTop + container.clientHeight) {
      container.scrollTop = top + child.offsetHeight - container.clientHeight
    }
  }, [safeIndex, windowStart])

  const select = (index: number) => {
    if (!items[index]) return
    setActiveIndex(index)
    hasNavigated.current = true
    onSelect(items[index].index)
    inputRef.current?.focus({ preventScroll: true })
  }
  const step = (delta: number) => {
    if (items.length) select((safeIndex + delta + items.length) % items.length)
  }

  if (!isOpen) return null
  return <div ref={panelRef} className="block-find-panel" onKeyDown={(event) => {
    if (isImeKeyboardEvent(event.nativeEvent, composingRef.current)) {
      event.stopPropagation()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.target !== inputRef.current) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      step(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (hasNavigated.current || event.shiftKey) step(event.shiftKey ? -1 : 1)
      else select(safeIndex)
    }
  }}>
    <div className="block-find-input-row">
      <input ref={inputRef} className="block-find-input" aria-label={placeholder}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onBlur={() => { composingRef.current = false }}
        onChange={(event) => onQueryChange(event.target.value)} placeholder={placeholder} type="text" value={query} />
      {query ? <span className="block-find-count" role="status">{items.length ? `${safeIndex + 1} / ${items.length}` : noMatchText}</span> : null}
      <button className="block-find-nav-btn" disabled={!items.length} type="button"
        aria-label={isZh ? '上一个匹配' : 'Previous match'} title="Shift+Enter" onClick={() => step(-1)}>↑</button>
      <button className="block-find-nav-btn" disabled={!items.length} type="button"
        aria-label={isZh ? '下一个匹配' : 'Next match'} title="Enter" onClick={() => step(1)}>↓</button>
      <button className="block-find-close" type="button" aria-label={isZh ? '关闭查找' : 'Close find'} onClick={onClose}>✕</button>
    </div>
    {query ? <div className="block-find-results" ref={resultsRef}>
      {!items.length ? <p className="block-find-empty">{noMatchText}</p> : visibleItems.map((item, offset) => {
        const index = windowStart + offset
        return <button className={`block-find-result${index === safeIndex ? ' block-find-result-active' : ''}`}
          key={item.index} type="button" data-result-index={index} onClick={() => select(index)}>
          <span className="block-find-result-index">{item.index + 1}</span>
          <span className="block-find-result-preview">{item.contentPreview}</span>
        </button>
      })}
    </div> : null}
  </div>
}
