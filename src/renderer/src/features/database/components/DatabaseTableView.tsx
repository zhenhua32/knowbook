import { useEffect, useRef, useState } from 'react'
import type { DatabaseField, DatabaseRecord, DatabaseSourceKind, DocumentCatalogEntry, DocumentDatabaseFieldValue } from '@shared/contracts'
import { DATABASE_SYSTEM_FIELD_IDS } from '@shared/database-workspace'
import { DatabaseValueEditor } from './DatabaseValueEditor'
import type { DatabaseWorkspaceText } from '../databaseText'

export function DatabaseTableView({
  documents,
  fields,
  columnWidths,
  records,
  selectedIds,
  sourceKind,
  text,
  onOpenDocument,
  onOpenRecord,
  onSelect,
  onColumnWidthChange,
  onUpdateDocument,
  onUpdateValue
}: {
  documents: DocumentCatalogEntry[]
  fields: DatabaseField[]
  columnWidths: Record<string, number>
  records: DatabaseRecord[]
  selectedIds: Set<string>
  sourceKind: DatabaseSourceKind
  text: DatabaseWorkspaceText
  onOpenDocument: (documentId: string) => void
  onOpenRecord: (record: DatabaseRecord) => void
  onSelect: (recordId: string, selected: boolean) => void
  onColumnWidthChange: (fieldId: string, width: number) => void
  onUpdateDocument: (record: DatabaseRecord, documentId: string | null) => Promise<void>
  onUpdateValue: (record: DatabaseRecord, field: DatabaseField, value: DocumentDatabaseFieldValue) => Promise<void>
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const rowHeight = 58
  const overscan = 8
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2
  const endIndex = Math.min(records.length, startIndex + visibleCount)
  const visibleRecords = records.slice(startIndex, endIndex)

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const update = () => setViewportHeight(node.clientHeight || 600)
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="dbw-table-scroll" data-testid="database-table-view" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} ref={scrollRef}>
      <table
        className="dbw-table"
        onKeyDown={(event) => {
          if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
          const target = event.target as HTMLElement
          if (target.matches('input:not([type="checkbox"]), select, textarea')) return
          const cell = target.closest('td') as HTMLTableCellElement | null
          const row = cell?.parentElement as HTMLTableRowElement | null
          if (!cell || !row) return
          const rows = [...row.parentElement!.querySelectorAll<HTMLTableRowElement>('tr:not(.dbw-virtual-spacer)')]
          const rowIndex = rows.indexOf(row)
          const cellIndex = [...row.cells].indexOf(cell)
          const nextRowIndex = event.key === 'ArrowUp' ? rowIndex - 1 : event.key === 'ArrowDown' ? rowIndex + 1 : rowIndex
          const nextCellIndex = event.key === 'ArrowLeft' ? cellIndex - 1 : event.key === 'ArrowRight' ? cellIndex + 1 : cellIndex
          const nextCell = rows[nextRowIndex]?.cells[nextCellIndex]
          if (!nextCell) return
          event.preventDefault()
          const focusTarget = nextCell.querySelector<HTMLElement>('button, input, select, [tabindex]') ?? nextCell
          focusTarget.focus()
        }}
      >
        <colgroup>
          <col style={{ width: 44 }} />
          {fields.map((field) => <col key={field.id} style={{ width: columnWidths[field.id] ?? (field.role === 'title' ? 270 : 180) }} />)}
        </colgroup>
        <thead><tr>
          <th className="dbw-select-column"><span className="sr-only">{text.selected(0)}</span></th>
          {fields.map((field) => {
            const width = columnWidths[field.id] ?? (field.role === 'title' ? 270 : 180)
            return (
              <th className={field.role === 'title' ? 'dbw-title-column' : ''} key={field.id} style={{ minWidth: width, width }}>
                {field.name}{field.role === 'system' ? <span className="dbw-lock-mark">⌁</span> : null}
                <span
                  aria-hidden="true"
                  className="dbw-column-resizer"
                  onDoubleClick={() => {
                    const longest = Math.max(field.name.length, ...records.slice(0, 100).map((record) => String(field.role === 'title' ? record.title : record.fieldValues[field.id] ?? '').length))
                    onColumnWidthChange(field.id, Math.max(120, Math.min(480, 44 + longest * 7)))
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    const startX = event.clientX
                    const startWidth = width
                    const move = (moveEvent: MouseEvent) => onColumnWidthChange(field.id, Math.max(80, Math.min(1200, startWidth + moveEvent.clientX - startX)))
                    const stop = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', stop) }
                    window.addEventListener('mousemove', move)
                    window.addEventListener('mouseup', stop)
                  }}
                />
              </th>
            )
          })}
        </tr></thead>
        <tbody>
          {startIndex > 0 ? <tr aria-hidden="true" className="dbw-virtual-spacer"><td colSpan={fields.length + 1} style={{ height: startIndex * rowHeight }} /></tr> : null}
          {visibleRecords.map((record) => (
            <tr className={selectedIds.has(record.id) ? 'is-selected' : ''} key={record.id}>
              <td className="dbw-select-column" tabIndex={-1}><input aria-label={text.selected(1)} checked={selectedIds.has(record.id)} onChange={(event) => onSelect(record.id, event.target.checked)} type="checkbox" /></td>
              {fields.map((field) => (
                <td className={field.role === 'title' ? 'dbw-title-column' : field.role === 'system' ? 'is-system' : ''} key={field.id} style={{ minWidth: columnWidths[field.id] ?? (field.role === 'title' ? 270 : 180), width: columnWidths[field.id] ?? (field.role === 'title' ? 270 : 180) }} tabIndex={-1}>
                  {field.role === 'title' ? (
                    <button className="dbw-record-title" onClick={() => sourceKind === 'document-catalog' && record.documentId ? onOpenDocument(record.documentId) : onOpenRecord(record)} type="button">
                      <strong>{record.title}</strong>
                      <small>{sourceKind === 'document-catalog' ? String(record.fieldValues[DATABASE_SYSTEM_FIELD_IDS.path] ?? '') : String(record.fieldValues[DATABASE_SYSTEM_FIELD_IDS.document] ?? '')}</small>
                    </button>
                  ) : field.id === DATABASE_SYSTEM_FIELD_IDS.document && sourceKind === 'custom' ? (
                    <select className="dbw-inline-select" onChange={(event) => void onUpdateDocument(record, event.target.value || null)} value={record.documentId ?? ''}>
                      <option value="">{text.noLinkedDocument}</option>
                      {documents.map((document) => <option key={document.id} value={document.id}>{document.path}</option>)}
                    </select>
                  ) : field.editable && field.role === 'property' ? (
                    <DatabaseValueEditor
                      column={{ id: field.id, name: field.name, type: field.type, options: field.options, sortOrder: field.sortOrder }}
                      onChangeValue={(value) => onUpdateValue(record, field, value)}
                      value={toDocumentValue(record.fieldValues[field.id])}
                    />
                  ) : <ReadOnlyValue field={field} record={record} />}
                </td>
              ))}
            </tr>
          ))}
          {endIndex < records.length ? <tr aria-hidden="true" className="dbw-virtual-spacer"><td colSpan={fields.length + 1} style={{ height: (records.length - endIndex) * rowHeight }} /></tr> : null}
        </tbody>
      </table>
    </div>
  )
}

function ReadOnlyValue({ field, record }: { field: DatabaseField; record: DatabaseRecord }) {
  const value = field.role === 'title' ? record.title : record.fieldValues[field.id]
  if (value === null || value === undefined || value === '') return <span className="dbw-empty-value">—</span>
  if (typeof value === 'boolean') return <span>{value ? '✓' : '—'}</span>
  if (Array.isArray(value)) return <div className="dbw-tag-list">{value.map((item) => <span className="dbw-tag" key={item}>{item}</span>)}</div>
  if (field.type === 'date') {
    const date = new Date(String(value))
    return <span>{Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString()}</span>
  }
  return <span title={String(value)}>{String(value)}</span>
}

function toDocumentValue(value: unknown): DocumentDatabaseFieldValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return String(value)
}
