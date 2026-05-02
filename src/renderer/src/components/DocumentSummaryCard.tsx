type DocumentSummaryCardProps = {
  path: string
  title: string
  summary: string
  updatedText: string
  titleLabel: string
  summaryLabel: string
  onTitleChange: (value: string) => void
  onSummaryChange: (value: string) => void
}

export function DocumentSummaryCard(props: DocumentSummaryCardProps) {
  const {
    path,
    title,
    summary,
    updatedText,
    titleLabel,
    summaryLabel,
    onTitleChange,
    onSummaryChange
  } = props

  return (
    <div className="document-summary-card">
      <p className="document-path">{path}</p>
      <div className="editor-fields">
        <label className="editor-label">
          {titleLabel}
          <input className="editor-input" onChange={(event) => onTitleChange(event.target.value)} type="text" value={title} />
        </label>
        <label className="editor-label">
          {summaryLabel}
          <textarea
            className="editor-textarea"
            onChange={(event) => onSummaryChange(event.target.value)}
            rows={3}
            value={summary}
          />
        </label>
      </div>
      <p className="document-updated">{updatedText}</p>
    </div>
  )
}
