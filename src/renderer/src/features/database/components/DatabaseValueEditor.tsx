import { useEffect, useState } from 'react'
import type { DocumentDatabaseColumn, DocumentDatabaseFieldValue } from '@shared/contracts'

export function DatabaseValueEditor({
  column,
  value,
  onChangeValue,
  textCommitMode = 'blur'
}: {
  column: DocumentDatabaseColumn
  value: DocumentDatabaseFieldValue
  onChangeValue: (value: DocumentDatabaseFieldValue) => void | Promise<void>
  textCommitMode?: 'blur' | 'change'
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(formatDraft(value))
  const [multiDraft, setMultiDraft] = useState<string[]>(Array.isArray(value) ? value : [])

  useEffect(() => {
    if (isEditing) return
    setDraft(formatDraft(value))
    setMultiDraft(Array.isArray(value) ? value : [])
  }, [isEditing, value])

  if (column.type === 'checkbox') {
    return <label className="dbw-checkbox-editor"><input checked={value === true} onChange={(event) => void onChangeValue(event.target.checked)} type="checkbox" /></label>
  }

  if (column.type === 'select') {
    return (
      <select className="catalog-cell-input" onChange={(event) => void onChangeValue(event.target.value || null)} value={typeof value === 'string' ? value : ''}>
        <option value="">—</option>
        {column.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    )
  }

  if (column.type === 'multi-select') {
    return (
      <details className="dbw-multi-editor" onToggle={(event) => setIsEditing(event.currentTarget.open)}>
        <summary>{multiDraft.length > 0 ? multiDraft.join(' · ') : '—'}</summary>
        <div className="dbw-multi-editor-menu">
          {column.options.map((option) => (
            <label key={option}><input checked={multiDraft.includes(option)} onChange={(event) => {
              const next = event.target.checked ? [...new Set([...multiDraft, option])] : multiDraft.filter((item) => item !== option)
              setMultiDraft(next)
              void onChangeValue(next.length > 0 ? next : null)
            }} type="checkbox" />{option}</label>
          ))}
        </div>
      </details>
    )
  }

  if (column.type === 'date') {
    return <input className="catalog-cell-input" onBlur={() => setIsEditing(false)} onChange={(event) => void onChangeValue(event.target.value || null)} onFocus={() => setIsEditing(true)} type="date" value={typeof value === 'string' ? value : ''} />
  }

  const commit = (nextDraft: string) => void onChangeValue(nextDraft.trim() || null)
  return (
    <input
      className="catalog-cell-input"
      onBlur={() => { setIsEditing(false); if (textCommitMode === 'blur') commit(draft) }}
      onChange={(event) => { setDraft(event.target.value); if (textCommitMode === 'change') commit(event.target.value) }}
      onFocus={() => setIsEditing(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') { setDraft(formatDraft(value)); event.currentTarget.blur() }
      }}
      value={draft}
    />
  )
}

function formatDraft(value: DocumentDatabaseFieldValue): string {
  if (Array.isArray(value)) return value.join(', ')
  return typeof value === 'string' ? value : ''
}
