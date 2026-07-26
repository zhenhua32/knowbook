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
}

type DocumentOutlineGroup = {
  heading: DocumentOutlineItem
  children: DocumentOutlineItem[]
}

export function DocumentOutlinePanel(props: DocumentOutlinePanelProps) {
  const { title, items, emptyHeadingTitleLevel1, emptyHeadingTitleLevel2, onSelect } = props

  if (items.length === 0) {
    return null
  }

  const groups = items.reduce<DocumentOutlineGroup[]>((result, item) => {
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
      className={`toc-item toc-item-h${item.level}`}
      onClick={() => onSelect(item.index)}
      type="button"
    >
      {item.title || (item.level === 1 ? emptyHeadingTitleLevel1 : emptyHeadingTitleLevel2)}
    </button>
  )

  return (
    <div className="toc-panel">
      <p className="panel-label">{title}</p>
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
