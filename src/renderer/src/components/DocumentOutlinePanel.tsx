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

export function DocumentOutlinePanel(props: DocumentOutlinePanelProps) {
  const { title, items, emptyHeadingTitleLevel1, emptyHeadingTitleLevel2, onSelect } = props

  if (items.length === 0) {
    return null
  }

  return (
    <div className="toc-panel">
      <p className="panel-label">{title}</p>
      <nav className="toc-list">
        {items.map((item) => (
          <button
            className={`toc-item toc-item-h${item.level}`}
            key={`${item.index}-${item.level}`}
            onClick={() => onSelect(item.index)}
            type="button"
          >
            {item.title || (item.level === 1 ? emptyHeadingTitleLevel1 : emptyHeadingTitleLevel2)}
          </button>
        ))}
      </nav>
    </div>
  )
}
