import { useMemo, useState } from 'react'

type DocumentOutlineItem = {
  id?: string
  collapsed?: boolean
  hasChildren?: boolean
  index: number
  level: 1 | 2
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
  children: DocumentOutlineItem[]
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
    let parent: number | null = null
    for (const item of items) {
      if (item.level === 1) parent = item.index
      if (item.title.toLocaleLowerCase().includes(term)) {
        matched.add(item.index)
        if (parent !== null) matched.add(parent)
      }
    }
    return items.filter((item) => matched.has(item.index))
  }, [items, query])

  if (items.length === 0) {
    return null
  }

  const groups = filteredItems.reduce<DocumentOutlineGroup[]>((result, item) => {
    const currentGroup = result.at(-1)

    if (item.level === 2 && currentGroup?.heading.level === 1) {
      currentGroup.children.push(item)
      return result
    }

    result.push({ heading: item, children: [] })
    return result
  }, [])

  const renderOutlineButton = (item: DocumentOutlineItem) => (
    <div className="toc-item-row">
      {props.onToggleFold ? <button className="toc-fold-button" type="button" disabled={!item.hasChildren}
        aria-expanded={!item.collapsed} aria-label={`${item.collapsed ? (isZh ? '展开章节' : 'Expand section') : (isZh ? '折叠章节' : 'Collapse section')}：${item.title}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => props.onToggleFold?.(item.index)}>{item.collapsed ? '▸' : '▾'}</button> : null}
    <button
      className={`toc-item toc-item-h${item.level}${activeIndex === item.index ? ' toc-item-active' : ''}`}
      aria-current={activeIndex === item.index ? 'location' : undefined}
      title={item.title || (item.level === 1 ? emptyHeadingTitleLevel1 : emptyHeadingTitleLevel2)}
      onClick={() => onSelect(item.index)}
      type="button"
    >
      {item.title || (item.level === 1 ? emptyHeadingTitleLevel1 : emptyHeadingTitleLevel2)}
    </button>
      {props.onFocusSection ? <button className="toc-focus-button" type="button"
        aria-label={`${isZh ? '只看本章' : 'Focus section'}：${item.title}`}
        aria-pressed={props.focusedHeadingId === item.id}
        onClick={() => props.onFocusSection?.(item.index)}>{isZh ? '只看' : 'Focus'}</button> : null}
    </div>
  )

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
          {groups.map(({ heading, children }) => (
            <li
              className={`toc-entry toc-entry-h${heading.level}`}
              key={`${heading.index}-${heading.level}`}
            >
              {renderOutlineButton(heading)}
              {children.length > 0 ? (
                <ol className="toc-children">
                  {children.map((child) => (
                    <li className="toc-entry toc-entry-h2" key={`${child.index}-${child.level}`}>
                      {renderOutlineButton(child)}
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ol>
      </nav>
    </div>
  )
}
