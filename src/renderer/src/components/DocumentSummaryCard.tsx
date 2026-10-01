import { useId, useRef, useState } from 'react'
import { documentSummaryText } from '@shared/documentSummary'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'

type DocumentSummaryCardProps = {
  path: string
  title: string
  summary: string
  updatedText: string
  titleLabel: string
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
    summaryLabel,
    editLabel,
    collapseLabel,
    onTitleChange,
    onSummaryChange
  } = props
  const [isEditing, setIsEditing] = useState(false)
  const fieldsId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const composingRef = useRef(false)
  const summaryText = documentSummaryText(summary)

  return (
    <div className={`document-summary-card${isEditing ? ' document-summary-card-editing' : ''}`}>
      <div className="document-summary-card-head">
        <p className="document-path">{path}</p>
        <button aria-expanded={isEditing} aria-controls={isEditing ? fieldsId : undefined} ref={toggleRef}
          className="document-summary-edit-button" onClick={() => setIsEditing((current) => !current)} type="button">
          <EditIcon />
          {isEditing ? collapseLabel : editLabel}
        </button>
      </div>
      {isEditing ? (
        <div className="editor-fields" id={fieldsId}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onBlur={() => { composingRef.current = false }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || isImeKeyboardEvent(event.nativeEvent, composingRef.current)) return
            event.preventDefault()
            event.stopPropagation()
            setIsEditing(false)
            toggleRef.current?.focus()
          }}>
          <label className="editor-label">
            {titleLabel}
            <input autoFocus className="editor-input" onChange={(event) => onTitleChange(event.target.value)} type="text" value={title} />
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
      ) : summaryText ? <p className="document-summary-preview">{summaryText}</p> : null}
      <p className="document-updated">{updatedText}</p>
    </div>
  )
}

function EditIcon() {
  return (
    <svg aria-hidden="true" className="document-summary-edit-icon" viewBox="0 0 20 20">
      <path d="m12.5 4.5 3 3M4 16l1-4 8.5-8.5a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L8 15l-4 1Z" />
    </svg>
  )
}
