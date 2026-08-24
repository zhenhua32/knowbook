import { useState } from 'react'
import type { DatabaseField, DatabaseRecord, DatabaseSourceKind } from '@shared/contracts'
import type { DatabaseWorkspaceText } from '../databaseText'

export function DatabaseBoardView({
  field,
  groups,
  sourceKind,
  text,
  onMoveRecord,
  onOpenDocument,
  onOpenRecord
}: {
  field: DatabaseField | null
  groups: Array<{ id: string; label: string; records: DatabaseRecord[] }>
  sourceKind: DatabaseSourceKind
  text: DatabaseWorkspaceText
  onMoveRecord: (record: DatabaseRecord, field: DatabaseField | null, groupId: string) => Promise<void>
  onOpenDocument: (documentId: string) => void
  onOpenRecord: (record: DatabaseRecord) => void
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overGroupId, setOverGroupId] = useState<string | null>(null)
  const [groupLimits, setGroupLimits] = useState<Record<string, number>>({})

  return (
    <div className="dbw-board" data-testid="database-board-view">
      {groups.map((group) => (
        <section
          className={`dbw-board-column${overGroupId === group.id ? ' is-drag-over' : ''}`}
          key={group.id}
          onDragEnter={() => setOverGroupId(group.id)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            const record = group.records.find((candidate) => candidate.id === draggingId)
              ?? groups.flatMap((candidate) => candidate.records).find((candidate) => candidate.id === draggingId)
            setDraggingId(null)
            setOverGroupId(null)
            if (record) void onMoveRecord(record, field, group.id)
          }}
        >
          <header><span className="dbw-board-dot" /><strong>{group.label}</strong><b>{group.records.length}</b></header>
          <div className="dbw-board-stack">
            {group.records.slice(0, groupLimits[group.id] ?? 60).map((record) => (
              <article
                className={`dbw-board-card${draggingId === record.id ? ' is-dragging' : ''}`}
                draggable
                key={record.id}
                onDragEnd={() => { setDraggingId(null); setOverGroupId(null) }}
                onDragStart={() => setDraggingId(record.id)}
              >
                <button onClick={() => sourceKind === 'document-catalog' && record.documentId ? onOpenDocument(record.documentId) : onOpenRecord(record)} type="button">
                  <strong>{record.title}</strong>
                  <small>{field ? `${field.name} · ${group.label}` : text.noGrouping}</small>
                </button>
              </article>
            ))}
            {group.records.length > (groupLimits[group.id] ?? 60) ? (
              <button className="dbw-board-load-more" onClick={() => setGroupLimits((current) => ({ ...current, [group.id]: (current[group.id] ?? 60) + 60 }))} type="button">
                {text.records(group.records.length - (groupLimits[group.id] ?? 60))}
              </button>
            ) : null}
            {group.records.length === 0 ? <p className="dbw-board-empty">{text.noRecords}</p> : null}
          </div>
        </section>
      ))}
    </div>
  )
}
