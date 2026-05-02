type BlockSearchItem = {
  index: number
  type: string
  contentPreview: string
  isHighlighted: boolean
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

  if (!isOpen) {
    return null
  }

  return (
    <div className="block-search-panel">
      <div className="block-search-header">
        <input
          autoFocus
          className="block-search-input"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
          placeholder={placeholder}
          type="text"
          value={query}
        />
        <button className="secondary-button" onClick={onClose} type="button">
          ✕
        </button>
      </div>
      <div className="block-search-results">
        {items.map((item) => (
          <div
            className={`block-search-result${item.isHighlighted ? ' block-search-result-highlighted' : ''}`}
            key={`${item.index}-${item.type}`}
            onClick={() => onSelect(item.index)}
          >
            <span className="block-type-badge">{item.type}</span>
            <span className="block-content">{item.contentPreview}</span>
          </div>
        ))}
        {items.length === 0 && query && <p className="mini-hint">{noMatchText}</p>}
      </div>
    </div>
  )
}
