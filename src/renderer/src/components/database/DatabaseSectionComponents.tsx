import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { BoardColumn, BoardDropTarget } from '@shared/board'
import type {
  DatabaseEntity,
  DocumentCatalogEntry,
  DocumentDatabaseColumn,
  DocumentDatabaseColumnType,
  DocumentDatabaseFieldValue
} from '@shared/contracts'
import { getActiveUiText } from '../../i18n'
import {
  areDocumentDatabaseFieldValuesEqual,
  formatDocumentCatalogFieldValueForDisplay,
  formatDocumentDatabaseFieldValueForDraft,
  normalizeDatabaseColumnOptionsInput,
  normalizeDocumentDatabaseFieldValue
} from './databaseFieldUtils'

const CATALOG_ROW_HEIGHT = 108
const CATALOG_ROW_OVERSCAN = 6

function getDatabaseColumnTypeLabel(type: DocumentDatabaseColumnType): string {
  return getActiveUiText().databaseColumnTypes[type]
}

export const DocumentCatalogTable = memo(function DocumentCatalogTable({
  columns,
  documents,
  onSelect,
  onUpdateField,
  selectedDocumentId
}: {
  columns: DocumentDatabaseColumn[]
  documents: DocumentCatalogEntry[]
  onSelect: (documentId: string) => void
  onUpdateField: (documentId: string, columnId: string, value: DocumentDatabaseFieldValue) => Promise<void>
  selectedDocumentId: string | null
}) {
  const ui = getActiveUiText()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(CATALOG_ROW_HEIGHT * 5)

  const gridTemplateColumns = useMemo(() => {
    const dynamicColumns = columns.map(() => 'minmax(180px, 1.15fr)')
    return [
      'minmax(220px, 1.7fr)',
      'minmax(220px, 1.45fr)',
      ...dynamicColumns,
      'minmax(84px, 0.55fr)',
      'minmax(84px, 0.55fr)',
      'minmax(84px, 0.55fr)',
      'minmax(120px, 0.7fr)'
    ].join(' ')
  }, [columns])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) {
      return
    }

    const updateViewportHeight = () => {
      setViewportHeight(node.clientHeight || CATALOG_ROW_HEIGHT * 5)
    }

    updateViewportHeight()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateViewportHeight)
      return () => {
        window.removeEventListener('resize', updateViewportHeight)
      }
    }

    const observer = new ResizeObserver(() => {
      updateViewportHeight()
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [])

  const totalHeight = documents.length * CATALOG_ROW_HEIGHT
  const startIndex = Math.max(0, Math.floor(scrollTop / CATALOG_ROW_HEIGHT) - CATALOG_ROW_OVERSCAN)
  const visibleCount = Math.ceil(viewportHeight / CATALOG_ROW_HEIGHT) + (CATALOG_ROW_OVERSCAN * 2)
  const endIndex = Math.min(documents.length, startIndex + visibleCount)
  const visibleDocuments = documents.slice(startIndex, endIndex)

  return (
    <div className="catalog-table-wrap">
      <div className="catalog-virtual-table">
        <div className="catalog-virtual-head" style={{ gridTemplateColumns }}>
          <div className="catalog-virtual-header-cell">{ui.common.title}</div>
          <div className="catalog-virtual-header-cell">{ui.common.path}</div>
          {columns.map((column) => (
            <div className="catalog-virtual-header-cell" key={column.id}>{column.name}</div>
          ))}
          <div className="catalog-virtual-header-cell">{ui.tableHeaderBlocks}</div>
          <div className="catalog-virtual-header-cell">{ui.tableHeaderLinks}</div>
          <div className="catalog-virtual-header-cell">{ui.tableHeaderChildren}</div>
          <div className="catalog-virtual-header-cell">{ui.tableHeaderUpdated}</div>
        </div>

        <div
          className="catalog-virtual-scroll"
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop)
          }}
          ref={scrollRef}
        >
          <div className="catalog-virtual-spacer" style={{ height: totalHeight }}>
            {visibleDocuments.map((document, offset) => {
              const rowIndex = startIndex + offset

              return (
                <div
                  className={`catalog-virtual-row${selectedDocumentId === document.id ? ' catalog-row-active' : ''}`}
                  data-document-id={document.id}
                  key={document.id}
                  onClick={() => onSelect(document.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelect(document.id)
                    }
                  }}
                  role="button"
                  style={{
                    gridTemplateColumns,
                    transform: `translateY(${rowIndex * CATALOG_ROW_HEIGHT}px)`
                  }}
                  tabIndex={0}
                >
                  <div className="catalog-virtual-cell catalog-title-cell">
                    <strong className="catalog-title-text">{document.title}</strong>
                    <p className="catalog-summary">{document.summary}</p>
                  </div>
                  <div className="catalog-virtual-cell catalog-path-cell" title={document.path}>{document.path}</div>
                  {columns.map((column) => (
                    <div className="catalog-virtual-cell catalog-cell-field" data-column-id={column.id} key={`${document.id}-${column.id}`}>
                      <DocumentCatalogFieldCell
                        column={column}
                        documentId={document.id}
                        onUpdateField={onUpdateField}
                        value={document.fieldValues[column.id] ?? null}
                      />
                    </div>
                  ))}
                  <div className="catalog-virtual-cell catalog-metric-cell">{document.blockCount}</div>
                  <div className="catalog-virtual-cell catalog-metric-cell">{document.linkCount}</div>
                  <div className="catalog-virtual-cell catalog-metric-cell">{document.childCount}</div>
                  <div className="catalog-virtual-cell catalog-updated-cell">{new Date(document.updatedAt).toLocaleDateString(ui.locale)}</div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
})

export function StandaloneDatabaseEntityTable({
  columns,
  documentCatalog,
  entities,
  onDeleteEntity,
  onToggleSelection,
  onUpdateDocument,
  onUpdateField,
  selectedEntityIds
}: {
  columns: DocumentDatabaseColumn[]
  documentCatalog: DocumentCatalogEntry[]
  entities: Array<{ entity: DatabaseEntity; linkedDocument: DocumentCatalogEntry | null }>
  onDeleteEntity: (entityId: string) => Promise<void>
  onToggleSelection: (entityId: string, checked: boolean) => void
  onUpdateDocument: (entity: DatabaseEntity, documentId: string | null) => Promise<void>
  onUpdateField: (entity: DatabaseEntity, columnId: string, value: DocumentDatabaseFieldValue) => Promise<void>
  selectedEntityIds: Set<string>
}) {
  const ui = getActiveUiText()

  return (
    <div className="catalog-table-wrap database-entity-table-wrap">
      <table className="catalog-table database-entity-table">
        <thead>
          <tr>
            <th>{ui.common.select}</th>
            <th>{ui.databaseEntityTableEntity}</th>
            <th>{ui.linkToDocumentOptional}</th>
            {columns.map((column) => (
              <th key={column.id}>{column.name}</th>
            ))}
            <th>{ui.tableHeaderUpdated}</th>
            <th>{ui.databaseEntityTableActions}</th>
          </tr>
        </thead>
        <tbody>
          {entities.map(({ entity, linkedDocument }) => {
            const entityLabel = linkedDocument?.title ?? `Entity ${entity.id.slice(0, 8)}`

            return (
              <tr className={selectedEntityIds.has(entity.id) ? 'catalog-row-active' : ''} key={entity.id}>
                <td>
                  <label className="database-entity-select-toggle database-entity-table-select-toggle">
                    <input
                      aria-label={ui.selectDatabaseEntity(entityLabel)}
                      checked={selectedEntityIds.has(entity.id)}
                      className="database-entity-select-checkbox"
                      onChange={(event) => onToggleSelection(entity.id, event.target.checked)}
                      type="checkbox"
                    />
                  </label>
                </td>
                <td>
                  <strong>{entityLabel}</strong>
                  <p className="catalog-summary">{linkedDocument?.path ?? entity.id}</p>
                </td>
                <td className="catalog-cell-field">
                  <select
                    className="catalog-cell-input database-entity-document-select"
                    onChange={(event) => {
                      void onUpdateDocument(entity, event.target.value || null)
                    }}
                    value={entity.documentId ?? ''}
                  >
                    <option value="">{ui.noLinkedDocument}</option>
                    {documentCatalog.map((document) => (
                      <option key={document.id} value={document.id}>{document.path}</option>
                    ))}
                  </select>
                </td>
                {columns.map((column) => (
                  <td className="catalog-cell-field" data-column-id={column.id} key={`${entity.id}-${column.id}`}>
                    <DatabaseFieldEditor
                      column={column}
                      value={entity.fieldValues[column.id] ?? null}
                      onChangeValue={(value) => {
                        void onUpdateField(entity, column.id, value)
                      }}
                    />
                  </td>
                ))}
                <td>{new Date(entity.updatedAt).toLocaleDateString(ui.locale)}</td>
                <td>
                  <button className="secondary-button" onClick={() => void onDeleteEntity(entity.id)} type="button">
                    {ui.common.delete}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function DatabaseSchemaColumnCard({
  column,
  isFirst,
  isLast,
  onDelete,
  onMove,
  onUpdateOptions,
  onRename
}: {
  column: DocumentDatabaseColumn
  isFirst: boolean
  isLast: boolean
  onDelete: (columnId: string, columnName: string) => Promise<void>
  onMove: (columnId: string, direction: 'left' | 'right') => Promise<void>
  onUpdateOptions: (columnId: string, optionsInput: string) => Promise<void>
  onRename: (columnId: string, name: string) => Promise<void>
}) {
  const ui = getActiveUiText()
  const [draftName, setDraftName] = useState(column.name)
  const [draftOptions, setDraftOptions] = useState(column.options.join(', '))

  useEffect(() => {
    setDraftName(column.name)
  }, [column.id, column.name])

  useEffect(() => {
    setDraftOptions(column.options.join(', '))
  }, [column.id, column.options.join('\u0000')])

  const commitRename = async () => {
    const normalizedName = draftName.trim()
    if (!normalizedName) {
      setDraftName(column.name)
      return
    }

    if (normalizedName === column.name) {
      if (draftName !== column.name) {
        setDraftName(column.name)
      }
      return
    }

    await onRename(column.id, normalizedName)
  }

  const commitOptions = async () => {
    const normalizedOptions = normalizeDatabaseColumnOptionsInput(draftOptions)
    const currentOptionsKey = column.options.join('\u0000')
    const nextOptionsKey = normalizedOptions.join('\u0000')

    if (nextOptionsKey === currentOptionsKey) {
      if (draftOptions !== column.options.join(', ')) {
        setDraftOptions(column.options.join(', '))
      }
      return
    }

    if (normalizedOptions.length === 0) {
      setDraftOptions(column.options.join(', '))
      return
    }

    await onUpdateOptions(column.id, normalizedOptions.join(', '))
  }

  return (
    <div className="database-schema-chip">
      <input
        className="database-schema-name-input"
        onBlur={() => {
          void commitRename()
        }}
        onChange={(event) => setDraftName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          }
        }}
        type="text"
        value={draftName}
      />
      <small>
        {getDatabaseColumnTypeLabel(column.type)}
      </small>
      {(column.type === 'select' || column.type === 'multi-select') ? (
        <input
          className="database-schema-options-input"
          onBlur={() => {
            void commitOptions()
          }}
          onChange={(event) => setDraftOptions(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
          }}
          placeholder={ui.optionPlaceholder}
          type="text"
          value={draftOptions}
        />
      ) : null}
      <div className="database-schema-chip-actions">
        <button
          className="database-schema-chip-button"
          disabled={isFirst}
          onClick={() => {
            void onMove(column.id, 'left')
          }}
          type="button"
        >
          {ui.left}
        </button>
        <button
          className="database-schema-chip-button"
          disabled={isLast}
          onClick={() => {
            void onMove(column.id, 'right')
          }}
          type="button"
        >
          {ui.right}
        </button>
        <button
          className="database-schema-chip-button database-schema-chip-delete"
          onClick={() => {
            void onDelete(column.id, column.name)
          }}
          type="button"
        >
          {ui.common.delete}
        </button>
      </div>
    </div>
  )
}

const DocumentCatalogFieldCell = memo(function DocumentCatalogFieldCell({
  column,
  documentId,
  onUpdateField,
  value
}: {
  column: DocumentDatabaseColumn
  documentId: string
  onUpdateField: (documentId: string, columnId: string, value: DocumentDatabaseFieldValue) => Promise<void>
  value: DocumentDatabaseFieldValue
}) {
  const ui = getActiveUiText()
  const [isEditing, setIsEditing] = useState(false)
  const [draftValue, setDraftValue] = useState('')
  const [draftMultiValue, setDraftMultiValue] = useState<string[]>([])

  useEffect(() => {
    setDraftValue(formatDocumentDatabaseFieldValueForDraft(value))
    setDraftMultiValue(Array.isArray(value) ? value : [])
  }, [value])

  const stopEventPropagation = (event: { stopPropagation: () => void }) => {
    event.stopPropagation()
  }

  const closeEditor = () => {
    setIsEditing(false)
    setDraftValue(formatDocumentDatabaseFieldValueForDraft(value))
    setDraftMultiValue(Array.isArray(value) ? value : [])
  }

  const commitValue = async (nextValue: DocumentDatabaseFieldValue) => {
    const normalizedValue = normalizeDocumentDatabaseFieldValue(nextValue)
    setIsEditing(false)

    if (areDocumentDatabaseFieldValuesEqual(normalizedValue, value)) {
      return
    }

    await onUpdateField(documentId, column.id, normalizedValue)
  }

  const displayValue = formatDocumentCatalogFieldValueForDisplay(value)
  const emptyLabel = column.type === 'select' || column.type === 'multi-select' ? ui.common.select : ui.common.value

  if (column.type === 'checkbox') {
    return (
      <label className="catalog-checkbox" onClick={stopEventPropagation}>
        <input
          checked={value === true}
          onChange={(event) => {
            void onUpdateField(documentId, column.id, event.target.checked)
          }}
          type="checkbox"
        />
      </label>
    )
  }

  if (column.type === 'multi-select') {
    return (
      <div className="catalog-field-shell" onClick={stopEventPropagation}>
        {isEditing ? (
          <CatalogMultiSelectEditor
            column={column}
            onApply={() => {
              void commitValue(draftMultiValue)
            }}
            onCancel={closeEditor}
            onToggleOption={(option, checked) => {
              setDraftMultiValue((current) => {
                if (checked) {
                  return current.includes(option) ? current : [...current, option]
                }

                return current.filter((item) => item !== option)
              })
            }}
            selectedValues={draftMultiValue}
          />
        ) : (
          <button
            className={`catalog-value-button${displayValue ? '' : ' catalog-value-empty'}`}
            onClick={() => setIsEditing(true)}
            type="button"
          >
            {displayValue || emptyLabel}
          </button>
        )}
      </div>
    )
  }

  if (column.type === 'select') {
    return (
      <div className="catalog-field-shell" onClick={stopEventPropagation}>
        {isEditing ? (
          <select
            autoFocus
            className="catalog-cell-input"
            onBlur={() => setIsEditing(false)}
            onChange={(event) => {
              void commitValue(event.target.value || null)
            }}
            onClick={stopEventPropagation}
            value={typeof value === 'string' ? value : ''}
          >
            <option value="">{ui.common.select}</option>
            {column.options.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        ) : (
          <button
            className={`catalog-value-button${displayValue ? '' : ' catalog-value-empty'}`}
            onClick={() => setIsEditing(true)}
            type="button"
          >
            {displayValue || emptyLabel}
          </button>
        )}
      </div>
    )
  }

  if (column.type === 'date') {
    return (
      <div className="catalog-field-shell" onClick={stopEventPropagation}>
        {isEditing ? (
          <input
            autoFocus
            className="catalog-cell-input"
            onBlur={() => {
              void commitValue(draftValue)
            }}
            onChange={(event) => {
              setDraftValue(event.target.value)
            }}
            onClick={stopEventPropagation}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                closeEditor()
                return
              }

              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
            type="date"
            value={draftValue}
          />
        ) : (
          <button
            className={`catalog-value-button${displayValue ? '' : ' catalog-value-empty'}`}
            onClick={() => setIsEditing(true)}
            type="button"
          >
            {displayValue || emptyLabel}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="catalog-field-shell" onClick={stopEventPropagation}>
      {isEditing ? (
        <input
          autoFocus
          className="catalog-cell-input"
          onBlur={() => {
            void commitValue(draftValue)
          }}
          onChange={(event) => {
            setDraftValue(event.target.value)
          }}
          onClick={stopEventPropagation}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              closeEditor()
              return
            }

            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
          }}
          placeholder={ui.common.value}
          type="text"
          value={draftValue}
        />
      ) : (
        <button
          className={`catalog-value-button${displayValue ? '' : ' catalog-value-empty'}`}
          onClick={() => setIsEditing(true)}
          type="button"
        >
          {displayValue || emptyLabel}
        </button>
      )}
    </div>
  )
})

function CatalogMultiSelectEditor({
  column,
  onApply,
  onCancel,
  onToggleOption,
  selectedValues
}: {
  column: DocumentDatabaseColumn
  onApply: () => void
  onCancel: () => void
  onToggleOption: (option: string, checked: boolean) => void
  selectedValues: string[]
}) {
  const ui = getActiveUiText()

  return (
    <div className="catalog-multi-select-editor" onClick={(event) => event.stopPropagation()}>
      <div className="catalog-multi-select-options">
        {column.options.map((option) => (
          <label className="catalog-multi-select-option" key={option}>
            <input
              checked={selectedValues.includes(option)}
              onChange={(event) => {
                onToggleOption(option, event.target.checked)
              }}
              type="checkbox"
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
      <div className="catalog-inline-actions">
        <button className="secondary-button" onClick={onApply} type="button">{ui.common.save}</button>
        <button className="secondary-button" onClick={onCancel} type="button">{ui.common.cancel}</button>
      </div>
    </div>
  )
}

export function DatabaseFieldEditor({
  column,
  value,
  onChangeValue,
  stopPropagation = false,
  textCommitMode = 'blur'
}: {
  column: DocumentDatabaseColumn
  value: DocumentDatabaseFieldValue
  onChangeValue: (value: DocumentDatabaseFieldValue) => void | Promise<void>
  stopPropagation?: boolean
  textCommitMode?: 'blur' | 'change'
}) {
  const ui = getActiveUiText()
  const [draftValue, setDraftValue] = useState('')

  useEffect(() => {
    setDraftValue(formatDocumentDatabaseFieldValueForDraft(value))
  }, [value])

  const stopEventPropagation = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) {
      event.stopPropagation()
    }
  }

  const commitTextValue = (nextDraftValue: string) => {
    void onChangeValue(normalizeDocumentDatabaseFieldValue(nextDraftValue))
  }

  if (column.type === 'checkbox') {
    return (
      <label className="catalog-checkbox" onClick={stopEventPropagation}>
        <input
          checked={value === true}
          onChange={(event) => {
            void onChangeValue(event.target.checked)
          }}
          type="checkbox"
        />
      </label>
    )
  }

  if (column.type === 'select') {
    return (
      <select
        className="catalog-cell-input"
        onChange={(event) => {
          void onChangeValue(event.target.value || null)
        }}
        onClick={stopEventPropagation}
        value={typeof value === 'string' ? value : ''}
      >
        <option value="">{ui.common.select}</option>
        {column.options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    )
  }

  if (column.type === 'multi-select') {
    return (
      <select
        className="catalog-cell-input catalog-cell-multi-select"
        multiple
        onChange={(event) => {
          const nextValues = Array.from(event.target.selectedOptions, (option) => option.value)
          void onChangeValue(nextValues)
        }}
        onClick={stopEventPropagation}
        size={Math.min(Math.max(column.options.length, 3), 5)}
        value={Array.isArray(value) ? value : []}
      >
        {column.options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    )
  }

  if (column.type === 'date') {
    return (
      <input
        className="catalog-cell-input"
        onChange={(event) => {
          void onChangeValue(event.target.value || null)
        }}
        onClick={stopEventPropagation}
        type="date"
        value={typeof value === 'string' ? value : ''}
      />
    )
  }

  return (
    <input
      className="catalog-cell-input"
      onBlur={() => {
        if (textCommitMode === 'blur') {
          commitTextValue(draftValue)
        }
      }}
      onChange={(event) => {
        const nextDraftValue = event.target.value
        setDraftValue(nextDraftValue)
        if (textCommitMode === 'change') {
          commitTextValue(nextDraftValue)
        }
      }}
      onClick={stopEventPropagation}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        }
      }}
      placeholder={ui.common.value}
      type="text"
      value={draftValue}
    />
  )
}

export function DocumentBoard({
  columns,
  onSelect,
  selectedDocumentId,
  draggingDocumentId,
  dragOverColumnId,
  onDragStart,
  onDragEnd,
  onDragOverColumn,
  onDropOnColumn
}: {
  columns: BoardColumn[]
  onSelect: (documentId: string) => void
  selectedDocumentId: string | null
  draggingDocumentId: string | null
  dragOverColumnId: string | null
  onDragStart: (documentId: string) => void
  onDragEnd: () => void
  onDragOverColumn: (columnId: string) => void
  onDropOnColumn: (target: BoardDropTarget) => Promise<void>
}) {
  const ui = getActiveUiText()

  return (
    <div className="board-wrap">
      {columns.map((column) => (
        <section
          className={`board-column${dragOverColumnId === column.id ? ' board-column-drag-over' : ''}`}
          key={column.id}
          onDragOver={(event) => {
            event.preventDefault()
            if (draggingDocumentId) {
              onDragOverColumn(column.id)
            }
          }}
          onDrop={async (event) => {
            event.preventDefault()
            await onDropOnColumn(column.dropTarget)
          }}
        >
          <div className="board-column-head">
            <strong>{column.title}</strong>
            <span>{column.items.length}</span>
          </div>

          <div className="board-card-list">
            {column.items.map((document) => (
              <button
                className={`board-card${selectedDocumentId === document.id ? ' board-card-active' : ''}${draggingDocumentId === document.id ? ' board-card-dragging' : ''}`}
                key={document.id}
                onClick={() => onSelect(document.id)}
                type="button"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', document.id)
                  onDragStart(document.id)
                }}
                onDragEnd={onDragEnd}
              >
                <strong>{document.title}</strong>
                <p>{document.path}</p>
                <div className="board-card-meta">
                  <span>{document.blockCount} {ui.docStatBlocks}</span>
                  <span>{document.linkCount} {ui.common.links}</span>
                </div>
              </button>
            ))}
            {column.items.length === 0 ? <p className="board-column-drop-hint">{ui.boardDropHint}</p> : null}
          </div>
        </section>
      ))}
    </div>
  )
}