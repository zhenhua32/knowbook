import { useState } from 'react'
import type { DatabaseField, DatabaseRecord, DatabaseSourceKind } from '@shared/contracts'
import { DATABASE_SYSTEM_FIELD_IDS } from '@shared/database-workspace'
import type { DatabaseWorkspaceText } from '../databaseText'

export function DatabaseCardView({
  fields,
  records,
  selectedIds,
  sourceKind,
  text,
  onOpenDocument,
  onOpenRecord,
  onSelect
}: {
  fields: DatabaseField[]
  records: DatabaseRecord[]
  selectedIds: Set<string>
  sourceKind: DatabaseSourceKind
  text: DatabaseWorkspaceText
  onOpenDocument: (documentId: string) => void
  onOpenRecord: (record: DatabaseRecord) => void
  onSelect: (recordId: string, selected: boolean) => void
}) {
  const summaryFields = fields.filter((field) => field.role !== 'title').slice(0, 4)
  const [limit, setLimit] = useState(120)

  return (
    <div className="dbw-card-grid" data-testid="database-card-view">
      {records.slice(0, limit).map((record) => (
        <article className={`dbw-record-card${selectedIds.has(record.id) ? ' is-selected' : ''}`} key={record.id}>
          <input aria-label={text.selected(1)} checked={selectedIds.has(record.id)} className="dbw-card-checkbox" onChange={(event) => onSelect(record.id, event.target.checked)} type="checkbox" />
          <button className="dbw-card-body" onClick={() => sourceKind === 'document-catalog' && record.documentId ? onOpenDocument(record.documentId) : onOpenRecord(record)} type="button">
            <span aria-hidden="true" className="dbw-card-icon">{sourceKind === 'document-catalog' ? '▤' : '▦'}</span>
            <strong>{record.title}</strong>
            <small>{String(record.fieldValues[sourceKind === 'document-catalog' ? DATABASE_SYSTEM_FIELD_IDS.path : DATABASE_SYSTEM_FIELD_IDS.document] ?? '')}</small>
            <dl>
              {summaryFields.map((field) => {
                const value = record.fieldValues[field.id]
                return <div key={field.id}><dt>{field.name}</dt><dd>{formatValue(value)}</dd></div>
              })}
            </dl>
          </button>
        </article>
      ))}
      {records.length > limit ? <button className="dbw-card-load-more" onClick={() => setLimit((current) => current + 120)} type="button">＋ {text.records(records.length - limit)}</button> : null}
    </div>
  )
}

function formatValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.join(' · ')
  if (typeof value === 'boolean') return value ? '✓' : '—'
  return String(value)
}
