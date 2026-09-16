import type { HeadingLevel } from '@shared/markdownEngine'
import { useMemo, useState } from 'react'

type DocumentOutlineItem = {
  id?: string
  collapsed?: boolean
  hasChildren?: boolean
  index: number
  level: HeadingLevel
  title: string
}

type DocumentOutlinePanelProps = {
  title: string
  items: DocumentOutlineItem[]
  emptyHeadingTitleLevel1: string
  emptyHeadingTitleLevel2: string
  onSelect: (index: number) => void
  activeIndex?: number | null
  filterPlaceholder?: string
  noMatchText?: string
  isZh?: boolean
  focusedHeadingId?: string | null
  onToggleFold?: (index: number) => void
  onCollapseAll?: () => void
  onExpandAll?: () => void
  onFocusSection?: (index: number) => void
  onExitFocus?: () => void
}

type DocumentOutlineGroup = {
  heading: DocumentOutlineItem
  children: DocumentOutlineGroup[]
}

export function DocumentOutlinePanel(props: DocumentOutlinePanelProps) {
  const { title, items, emptyHeadingTitleLevel1, emptyHeadingTitleLevel2, onSelect, activeIndex, filterPlaceholder, noMatchText } = props
  const isZh = props.isZh ?? true
  const [query, setQuery] = useState('')
  const filteredItems = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    if (!term) return items
    // Preserve the parent heading of each match to keep similarly named
    // subsections distinguishable in a large outline.
    const matched = new Set<number>()
    const ancestors: DocumentOutlineItem[] = []
    for (const item of items) {
      while (ancestors.length && ancestors.at(-1)!.level >= item.level) ancestors.pop()
      if (item.title.toLocaleLowerCase().includes(term)) {
        matched.add(item.index)
        ancestors.forEach((parent) => matched.add(parent.index))
      }
      ancestors.push(item)
    }
    return items.filter((item) => matched.has(item.index))
  }, [items, query])

  if (items.length === 0) {
    return null
  }

  const groups: DocumentOutlineGroup[] = []
  const stack: DocumentOutlineGroup[] = []
  for (const item of filteredItems) {
    while (stack.length && stack.at(-1)!.heading.level >= item.level) stack.pop()
    const group = { heading: item, children: [] }
    ;(stack.at(-1)?.children ?? groups).push(group)
    stack.push(group)
  }
  const headingTitle = (item: DocumentOutlineItem) => item.title || (item.level === 1 ? emptyHeadingTitleLevel1
    : item.level === 2 ? emptyHeadingTitleLevel2 : (isZh ? '标题 ' : 'Heading ') + item.level)

  const renderOutlineButton = (item: DocumentOutlineItem) => (
    <div className="toc-item-row">
      {props.onToggleFold ? <button className="toc-fold-button" type="button" disabled={!item.hasChildren}
        aria-expanded={!item.collapsed} aria-label={`${item.collapsed ? (isZh ? '展开章节' : 'Expand section') : (isZh ? '折叠章节' : 'Collapse section')}：${item.title}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => props.onToggleFold?.(item.index)}>{item.collapsed ? '▸' : '▾'}</button> : null}
    <button
      className={`toc-item toc-item-h${item.level}${activeIndex === item.index ? ' toc-item-active' : ''}`}
      aria-current={activeIndex === item.index ? 'location' : undefined}
      title={headingTitle(item)}
      onClick={() => onSelect(item.index)}
      type="button"
    >
      {headingTitle(item)}
    </button>
      {props.onFocusSection ? <button className="toc-focus-button" type="button"
        aria-label={`${isZh ? '只看本章' : 'Focus section'}：${item.title}`}
        aria-pressed={props.focusedHeadingId === item.id}
        onClick={() => props.onFocusSection?.(item.index)}>{isZh ? '只看' : 'Focus'}</button> : null}
    </div>
  )

  const renderGroups = (entries: DocumentOutlineGroup[]): React.ReactNode => entries.map(({ heading, children }) => (
    <li className={'toc-entry toc-entry-h' + heading.level} key={heading.index}>
      {renderOutlineButton(heading)}
      {children.length > 0 ? <ol className="toc-children">{renderGroups(children)}</ol> : null}
    </li>
  ))

  return (
    <div className="document-outline-panel toc-panel">
      <p className="panel-label">{title}</p>
      {props.onCollapseAll ? <div className="outline-fold-actions">
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={props.onCollapseAll}>{isZh ? '全部折叠' : 'Fold all'}</button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={props.onExpandAll}>{isZh ? '全部展开' : 'Expand all'}</button>
        <button type="button" disabled={activeIndex == null} onClick={() => { if (activeIndex != null) props.onFocusSection?.(activeIndex) }}>{isZh ? '只看本章' : 'Focus current'}</button>
      </div> : null}
      {filterPlaceholder ? <input className="outline-filter" type="search" value={query}
        aria-label={filterPlaceholder} placeholder={filterPlaceholder} onChange={(event) => setQuery(event.target.value)} /> : null}
      {filteredItems.length === 0 ? <p className="empty-text">{noMatchText}</p> : null}
      <nav aria-label={title}>
        <ol className="toc-list">
          {renderGroups(groups)}
        </ol>
      </nav>
    </div>
  )
}
