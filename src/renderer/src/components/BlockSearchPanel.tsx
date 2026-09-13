import { useState, useEffect, useRef } from 'react'

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
}

export function BlockSearchPanel({ isOpen, isZh, query, placeholder, noMatchText, items, onQueryChange, onClose, onSelect }: BlockSearchPanelProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const hasNavigated = useRef(false)
  const safeIndex = Math.min(activeIndex, Math.max(0, items.length - 1))
  // Keep the match list bounded even for a query found in thousands of blocks.
  const windowStart = Math.max(0, safeIndex - 30)
  const visibleItems = items.slice(windowStart, windowStart + 60)

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
  return <div className="block-find-panel" onKeyDown={(event) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
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
