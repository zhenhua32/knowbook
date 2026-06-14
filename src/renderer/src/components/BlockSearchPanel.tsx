import { useState, useEffect, useRef, useCallback } from 'react'

type BlockSearchItem = {
  index: number
  type: string
  contentPreview: string
}

type BlockSearchPanelProps = {
  isOpen: boolean
  query: string
  placeholder: string
  noMatchText: string
  items: BlockSearchItem[]
  onQueryChange: (query: string) => void
  onClose: () => void
  onSelect: (index: number) => void
}

export function BlockSearchPanel(props: BlockSearchPanelProps) {
  const {
    isOpen,
    query,
    placeholder,
    noMatchText,
    items,
    onQueryChange,
    onClose,
    onSelect
  } = props

  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isOpen) {
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [isOpen])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  const scrollActiveIntoView = useCallback((idx: number) => {
    const container = resultsRef.current
    if (!container) return
    const child = container.children[idx] as HTMLElement | undefined
    if (child) {
      child.scrollIntoView({ block: 'nearest' })
    }
  }, [])

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }

    if (items.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const next = (activeIndex + 1) % items.length
      setActiveIndex(next)
      scrollActiveIntoView(next)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      const prev = (activeIndex - 1 + items.length) % items.length
      setActiveIndex(prev)
      scrollActiveIntoView(prev)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      onSelect(items[activeIndex].index)
    }
  }, [activeIndex, items, onClose, onSelect, scrollActiveIntoView])

  if (!isOpen) return null

  const matchCount = items.length

  return (
    <div className="block-find-panel" onKeyDown={handleKeyDown}>
      <div className="block-find-input-row">
        <input
          ref={inputRef}
          className="block-find-input"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          type="text"
          value={query}
        />
        {query && (
          <span className="block-find-count">
            {matchCount > 0 ? `${activeIndex + 1} / ${matchCount}` : noMatchText}
          </span>
        )}
        <button className="block-find-nav-btn" disabled={matchCount === 0} onClick={() => {
          const prev = (activeIndex - 1 + matchCount) % matchCount
          setActiveIndex(prev)
          scrollActiveIntoView(prev)
        }} type="button">↑</button>
        <button className="block-find-nav-btn" disabled={matchCount === 0} onClick={() => {
          const next = (activeIndex + 1) % matchCount
          setActiveIndex(next)
          scrollActiveIntoView(next)
        }} type="button">↓</button>
        <button className="block-find-close" onClick={onClose} type="button">✕</button>
      </div>
      {query && (
        <div className="block-find-results" ref={resultsRef}>
          {items.length === 0
            ? <p className="block-find-empty">{noMatchText}</p>
            : items.map((item, idx) => (
              <div
                className={`block-find-result${idx === activeIndex ? ' block-find-result-active' : ''}`}
                key={`${item.index}-${item.type}-${idx}`}
                onClick={() => onSelect(item.index)}
                onMouseEnter={() => setActiveIndex(idx)}
              >
                <span className="block-find-result-index">{item.index + 1}</span>
                <span className="block-find-result-preview">{item.contentPreview}</span>
              </div>
            ))
          }
        </div>
      )}
    </div>
  )
}
