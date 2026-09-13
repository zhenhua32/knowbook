import { useMemo, useState } from 'react'

type DocumentOutlineItem = {
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
}

type DocumentOutlineGroup = {
  heading: DocumentOutlineItem
  children: DocumentOutlineItem[]
}

export function DocumentOutlinePanel(props: DocumentOutlinePanelProps) {
  const { title, items, emptyHeadingTitleLevel1, emptyHeadingTitleLevel2, onSelect, activeIndex, filterPlaceholder, noMatchText } = props
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
    <button
      className={`toc-item toc-item-h${item.level}${activeIndex === item.index ? ' toc-item-active' : ''}`}
      aria-current={activeIndex === item.index ? 'location' : undefined}
      title={item.title || (item.level === 1 ? emptyHeadingTitleLevel1 : emptyHeadingTitleLevel2)}
      onClick={() => onSelect(item.index)}
      type="button"
    >
      {item.title || (item.level === 1 ? emptyHeadingTitleLevel1 : emptyHeadingTitleLevel2)}
    </button>
  )

  return (
    <div className="document-outline-panel toc-panel">
      <p className="panel-label">{title}</p>
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
