import { useEffect, useRef, useState } from 'react'
import type { DatabaseField, DocumentDatabaseColumnType } from '@shared/contracts'
import { useDatabaseDialogFocus } from '../hooks/useDatabaseDialogFocus'
import type { DatabaseWorkspaceText } from '../databaseText'

export function DatabaseFieldDrawer({
  fields,
  fieldOrder,
  open,
  text,
  visibleFieldIds,
  onClose,
  onCreateField,
  onDeleteField,
  onMoveField,
  onMoveDatabaseField,
  onRenameField,
  onToggleField,
  onUpdateOptions
}: {
  fields: DatabaseField[]
  fieldOrder: string[]
  open: boolean
  text: DatabaseWorkspaceText
  visibleFieldIds: string[]
  onClose: () => void
  onCreateField: (name: string, type: DocumentDatabaseColumnType, options: string[]) => Promise<void>
  onDeleteField: (field: DatabaseField) => void
  onMoveField: (fieldId: string, direction: 'up' | 'down') => void
  onMoveDatabaseField: (fieldId: string, direction: 'left' | 'right') => Promise<void>
  onRenameField: (fieldId: string, name: string) => Promise<void>
  onToggleField: (fieldId: string) => void
  onUpdateOptions: (fieldId: string, options: string[]) => Promise<void>
}) {
  const drawerRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<DocumentDatabaseColumnType>('text')
  const [options, setOptions] = useState('')

  useDatabaseDialogFocus({ containerRef: drawerRef, initialFocusRef: closeRef, onClose, open })

  if (!open) return null

  const visibleCount = fields.filter((field) => visibleFieldIds.includes(field.id)).length
  const orderedFields = [...fields].sort((left, right) => {
    const leftIndex = fieldOrder.indexOf(left.id)
    const rightIndex = fieldOrder.indexOf(right.id)
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
  })

  const submit = async () => {
    const normalizedName = name.trim()
    const normalizedOptions = [...new Set(options.split(',').map((option) => option.trim()).filter(Boolean))]
    if (!normalizedName || ((type === 'select' || type === 'multi-select') && normalizedOptions.length === 0)) return
    await onCreateField(normalizedName, type, normalizedOptions)
    setName('')
    setType('text')
    setOptions('')
    setCreating(false)
  }

  return (
    <>
      <button aria-label={text.close} className="dbw-drawer-scrim" onClick={onClose} type="button" />
      <aside aria-label={text.manageFields} aria-modal="true" className="dbw-drawer dbw-field-drawer" ref={drawerRef} role="dialog" tabIndex={-1}>
        <header className="dbw-drawer-header">
          <div><h2>{text.manageFields}</h2><p>{text.visibleFields(visibleCount, fields.length)}</p></div>
          <button aria-label={text.close} className="dbw-icon-button" onClick={onClose} ref={closeRef} type="button">×</button>
        </header>
        <div className="dbw-field-list">
          {orderedFields.map((field, index) => (
            <FieldRow
              field={field}
              isFirst={index === 0}
              isLast={index === orderedFields.length - 1}
              key={field.id}
              onDelete={() => onDeleteField(field)}
              onMove={(direction) => onMoveField(field.id, direction)}
              onMoveDefault={(direction) => onMoveDatabaseField(field.id, direction)}
              onRename={(nextName) => onRenameField(field.id, nextName)}
              onToggle={() => onToggleField(field.id)}
              onUpdateOptions={(nextOptions) => onUpdateOptions(field.id, nextOptions)}
              text={text}
              visible={visibleFieldIds.includes(field.id)}
            />
          ))}
        </div>
        <div className="dbw-field-create">
          {creating ? (
            <div className="dbw-field-create-form">
              <input autoFocus onChange={(event) => setName(event.target.value)} placeholder={text.name} value={name} />
              <select onChange={(event) => setType(event.target.value as DocumentDatabaseColumnType)} value={type}>
                <option value="text">Text</option><option value="select">Select</option><option value="multi-select">Multi-select</option><option value="date">Date</option><option value="checkbox">Checkbox</option>
              </select>
              {type === 'select' || type === 'multi-select' ? <input onChange={(event) => setOptions(event.target.value)} placeholder={text.options} value={options} /> : null}
              <div className="dbw-inline-actions">
                <button className="dbw-primary-button" onClick={() => void submit()} type="button">{text.create}</button>
                <button className="dbw-quiet-button" onClick={() => setCreating(false)} type="button">{text.cancel}</button>
              </div>
            </div>
          ) : <button className="dbw-add-field-button" onClick={() => setCreating(true)} type="button">＋ {text.addField}</button>}
        </div>
      </aside>
    </>
  )
}

function FieldRow({
  field,
  isFirst,
  isLast,
  onDelete,
  onMove,
  onMoveDefault,
  onRename,
  onToggle,
  onUpdateOptions,
  text,
  visible
}: {
  field: DatabaseField
  isFirst: boolean
  isLast: boolean
  onDelete: () => void
  onMove: (direction: 'up' | 'down') => void
  onMoveDefault: (direction: 'left' | 'right') => Promise<void>
  onRename: (name: string) => Promise<void>
  onToggle: () => void
  onUpdateOptions: (options: string[]) => Promise<void>
  text: DatabaseWorkspaceText
  visible: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(field.name)
  const [options, setOptions] = useState(field.options.join(', '))

  useEffect(() => setName(field.name), [field.name])
  useEffect(() => setOptions(field.options.join(', ')), [field.options])

  const commitName = async () => {
    const normalized = name.trim()
    setEditing(false)
    if (!normalized) setName(field.name)
    else if (normalized !== field.name) await onRename(normalized)
  }
  const commitOptions = async () => {
    const normalized = [...new Set(options.split(',').map((option) => option.trim()).filter(Boolean))]
    if (normalized.length > 0 && normalized.join('\u0000') !== field.options.join('\u0000')) await onUpdateOptions(normalized)
  }

  return (
    <div className={`dbw-field-row${visible ? '' : ' is-hidden'}`}>
      <span aria-hidden="true" className="dbw-field-grip">⠿</span>
      <div className="dbw-field-copy">
        {editing && field.role === 'property' ? (
          <input autoFocus onBlur={() => void commitName()} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setName(field.name); setEditing(false) } }} value={name} />
        ) : <button className="dbw-field-name" disabled={field.role !== 'property'} onClick={() => setEditing(true)} type="button">{field.name}</button>}
        <small>{field.role === 'property' ? field.type : `系统 · ${field.type}`}</small>
        {(field.type === 'select' || field.type === 'multi-select') && field.role === 'property' ? (
          <input className="dbw-field-options" onBlur={() => void commitOptions()} onChange={(event) => setOptions(event.target.value)} value={options} />
        ) : null}
      </div>
      <button className="dbw-field-visibility" disabled={!field.hideable} onClick={onToggle} type="button">{visible ? text.hide : text.show}</button>
      <div className="dbw-field-row-actions">
        <button aria-label={text.moveUp} disabled={isFirst} onClick={() => onMove('up')} type="button">↑</button>
        <button aria-label={text.moveDown} disabled={isLast} onClick={() => onMove('down')} type="button">↓</button>
        {field.role === 'property' ? <button aria-label={`${text.moveUp} · default`} onClick={() => void onMoveDefault('left')} title="Move in database default order" type="button">←</button> : null}
        {field.role === 'property' ? <button aria-label={`${text.moveDown} · default`} onClick={() => void onMoveDefault('right')} title="Move in database default order" type="button">→</button> : null}
        {field.deletable ? <button aria-label={text.deleteField} className="dbw-danger-text" onClick={onDelete} type="button">×</button> : null}
      </div>
    </div>
  )
}
