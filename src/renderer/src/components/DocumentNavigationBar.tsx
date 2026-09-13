import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { DocumentOutlinePanel } from './DocumentOutlinePanel'
import { BlockSearchPanel } from './BlockSearchPanel'

export function DocumentNavigationBar({ outline, search, activeIndex, progress, reading, isZh, onToggleReading, onOpenSearch }: {
  outline: ComponentProps<typeof DocumentOutlinePanel> | null
  search: ComponentProps<typeof BlockSearchPanel>
  activeIndex: number | null
  progress: number
  reading: boolean
  isZh: boolean
  onToggleReading: () => void
  onOpenSearch: () => void
}) {
  const [outlineOpen, setOutlineOpen] = useState(false)
  const outlineRef = useRef<HTMLDivElement>(null)
  const outlineButtonRef = useRef<HTMLButtonElement>(null)
  const activeHeading = outline?.items.find((item) => item.index === activeIndex)
  const outlineTitle = activeHeading?.title || (isZh ? '文档开头' : 'Document start')

  useEffect(() => {
    if (!outlineOpen) return
    const dismiss = (event: MouseEvent) => {
      if (!outlineRef.current?.contains(event.target as Node)) setOutlineOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [outlineOpen])

  return <div className="document-navigation">
    <div className="document-navigation-bar">
      <div className="document-outline-control" ref={outlineRef} onKeyDown={(event) => {
        if (event.key === 'Escape' && outlineOpen) {
          event.stopPropagation()
          setOutlineOpen(false)
          outlineButtonRef.current?.focus()
        }
      }}>
        <button className="document-navigation-button" type="button" ref={outlineButtonRef}
          disabled={!outline?.items.length} aria-expanded={outlineOpen} aria-controls="document-outline-popover"
          onClick={() => setOutlineOpen(!outlineOpen)}>
          <span aria-hidden="true">☷</span> {isZh ? '大纲' : 'Outline'}
          {outline?.items.length ? <small>{outline.items.length}</small> : null}
        </button>
        {outlineOpen && outline ? <div id="document-outline-popover" className="document-outline-popover">
          <DocumentOutlinePanel {...outline} activeIndex={activeIndex} onSelect={(index) => {
            outline.onSelect(index)
            setOutlineOpen(false)
            outlineButtonRef.current?.focus({ preventScroll: true })
          }} />
        </div> : null}
      </div>
      <span className="document-current-heading" title={outlineTitle}>{outlineTitle}</span>
      <span className="document-reading-progress" aria-label={isZh ? `阅读进度 ${progress}%` : `Reading progress ${progress}%`}>{progress}%</span>
      <button className="document-navigation-button" type="button" onClick={onOpenSearch}
        title={isZh ? '文内查找 (Ctrl/Cmd+F)' : 'Find in document (Ctrl/Cmd+F)'}>{isZh ? '查找' : 'Find'}</button>
      <button className="document-navigation-button document-view-toggle" type="button" aria-pressed={reading}
        onClick={onToggleReading}>{reading ? (isZh ? '编辑' : 'Edit') : (isZh ? '阅读' : 'Read')}</button>
    </div>
    <div className="document-progress-track" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
    <BlockSearchPanel {...search} />
  </div>
}
