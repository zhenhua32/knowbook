import { useId, useRef, useState } from 'react'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'

type DocumentSummaryCardProps = {
  path: string
  title: string
  summary: string
  updatedText: string
  titleLabel: string
  compactTitleLabel?: string
  summaryLabel: string
  editLabel: string
  collapseLabel: string
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
    compactTitleLabel,
    summaryLabel,
    editLabel,
    collapseLabel,
    onTitleChange,
    onSummaryChange
  } = props
  const [isEditing, setIsEditing] = useState(false)
  const fieldsId = useId()
  const titleId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const composingRef = useRef(false)

  return (
    <div className={`document-summary-card document-heading${isEditing ? ' document-summary-card-editing' : ''}`}
      onCompositionStart={() => { composingRef.current = true }}
      onCompositionEnd={() => { composingRef.current = false }}
      onBlur={() => { composingRef.current = false }}
      onKeyDown={(event) => {
        if (!isEditing || event.key !== 'Escape' || isImeKeyboardEvent(event.nativeEvent, composingRef.current)) return
        event.preventDefault()
        event.stopPropagation()
        setIsEditing(false)
        toggleRef.current?.focus()
      }}>
      <div className={`document-title-field${compactTitleLabel ? ' document-title-field-compact' : ''}`}>
        {compactTitleLabel ? <label className="document-title-label" htmlFor={titleId}>{compactTitleLabel}</label> : null}
        <input
          aria-label={compactTitleLabel ?? titleLabel}
          className="editor-input document-title-input"
          id={titleId}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder={titleLabel}
          type="text"
          value={title}
        />
      </div>
      <div className="document-summary-card-head">
        <p className="document-path" title={path}>{path}</p>
        <button aria-expanded={isEditing} aria-controls={isEditing ? fieldsId : undefined} ref={toggleRef}
          className="document-summary-edit-button" onClick={() => setIsEditing((current) => !current)} type="button">
          <PropertiesIcon />
          {isEditing ? collapseLabel : editLabel}
        </button>
      </div>
      {isEditing ? (
        <div className="editor-fields document-properties" id={fieldsId}>
          <label className="editor-label">
            {summaryLabel}
            <textarea
              autoFocus
              className="editor-textarea"
              onChange={(event) => onSummaryChange(event.target.value)}
              rows={3}
              value={summary}
            />
          </label>
          <p className="document-updated">{updatedText}</p>
        </div>
      ) : null}
    </div>
  )
}

function PropertiesIcon() {
  return (
    <svg aria-hidden="true" className="document-summary-edit-icon" viewBox="0 0 20 20">
      <path d="M4 6h12M4 14h12M8 4v4M12 12v4" />
    </svg>
  )
}
