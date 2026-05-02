type BlockTagFilterPanelProps = {
  title: string
  clearLabel: string
  showingLabel: string
  totalCount: number
  filteredCount: number
  allTags: string[]
  selectedTags: Set<string>
  tagCounts: Map<string, number>
  onClear: () => void
  onToggleTag: (tag: string) => void
}

export function BlockTagFilterPanel(props: BlockTagFilterPanelProps) {
  const {
    title,
    clearLabel,
    showingLabel,
    totalCount,
    filteredCount,
    allTags,
    selectedTags,
    tagCounts,
    onClear,
    onToggleTag
  } = props

  if (allTags.length === 0) {
    return null
  }

  return (
    <div className="block-tags-filter-panel">
      <div className="block-tags-filter-header">
        <span className="panel-label">{title}</span>
        {selectedTags.size > 0 ? (
          <button
            className="secondary-button"
            onClick={onClear}
            style={{ fontSize: '0.8rem', padding: '4px 8px' }}
            type="button"
          >
            {clearLabel}
          </button>
        ) : null}
      </div>
      <div className="block-tags-filter-list">
        {allTags.map((tag) => {
          const isSelected = selectedTags.has(tag)
          const blockCount = tagCounts.get(tag) ?? 0
          return (
            <button
              className={`block-tag-filter${isSelected ? ' block-tag-filter-active' : ''}`}
              key={tag}
              onClick={() => onToggleTag(tag)}
              type="button"
            >
              <span className="block-tag-filter-name">{tag}</span>
              <span className="block-tag-filter-count">{blockCount}</span>
            </button>
          )
        })}
      </div>
      {selectedTags.size > 0 ? (
        <p className="mini-hint">{showingLabel} {filteredCount} / {totalCount}</p>
      ) : null}
    </div>
  )
}
