import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { DatabaseField, DocumentDatabaseColumnType } from '@shared/contracts'
import { useDatabaseDialogFocus } from '../hooks/useDatabaseDialogFocus'
import type { DatabaseWorkspaceText } from '../databaseText'
import { isImeKeyboardEvent } from '../../../utils/imeKeyboard'

export function DatabaseFieldDrawer({
  fields,
  fieldOrder,
  open,
  sourceSessionKey,
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
  sourceSessionKey: string
  text: DatabaseWorkspaceText
  visibleFieldIds: string[]
  onClose: () => void
  onCreateField: (name: string, type: DocumentDatabaseColumnType, options: string[]) => Promise<boolean>
  onDeleteField: (field: DatabaseField) => void
  onMoveField: (fieldId: string, direction: 'up' | 'down') => void
  onMoveDatabaseField: (fieldId: string, direction: 'left' | 'right') => Promise<boolean>
  onRenameField: (fieldId: string, name: string) => Promise<boolean>
  onToggleField: (fieldId: string) => void
  onUpdateOptions: (fieldId: string, options: string[]) => Promise<boolean>
}) {
  const drawerRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const requiredHintId = useId()
  const optionsHintId = useId()
  const createComposingRef = useRef(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<DocumentDatabaseColumnType>('text')
  const [options, setOptions] = useState('')
  const [failed, setFailed] = useState(false)
  const submission = useFieldSubmission(open ? sourceSessionKey : null)
  const close = () => { if (!submission.isBusy()) onClose() }

  useLayoutEffect(() => {
    createComposingRef.current = false
    setCreating(false)
    setName('')
    setType('text')
    setOptions('')
    setFailed(false)
  }, [open, sourceSessionKey])

  useDatabaseDialogFocus({ containerRef: drawerRef, initialFocusRef: closeRef, onClose: close, open })

  if (!open) return null

  const visibleCount = fields.filter((field) => visibleFieldIds.includes(field.id)).length
  const orderedFields = [...fields].sort((left, right) => {
    const leftIndex = fieldOrder.indexOf(left.id)
    const rightIndex = fieldOrder.indexOf(right.id)
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
  })

  const submit = async () => {
    if (submission.isBusy()) return
    const normalizedName = name.trim()
    const normalizedOptions = [...new Set(options.split(',').map((option) => option.trim()).filter(Boolean))]
    if (!normalizedName || ((type === 'select' || type === 'multi-select') && normalizedOptions.length === 0)) return
    setFailed(false)
    const completed = await submission.run('create', () => onCreateField(normalizedName, type, normalizedOptions))
    if (completed === null) return
    if (!completed) { setFailed(true); return }
    setName('')
    setType('text')
    setOptions('')
    setCreating(false)
  }

  return (
    <>
      <button aria-label={text.close} className="dbw-drawer-scrim" disabled={submission.busy} onClick={close} type="button" />
      <aside aria-busy={submission.busy} aria-label={text.manageFields} aria-modal="true" className="dbw-drawer dbw-field-drawer" ref={drawerRef} role="dialog" tabIndex={-1}>
        <header className="dbw-drawer-header">
          <div><h2>{text.manageFields}</h2><p>{text.visibleFields(visibleCount, fields.length)}</p></div>
          <button aria-label={text.close} className="dbw-icon-button" disabled={submission.busy} onClick={close} ref={closeRef} type="button">×</button>
        </header>
        {submission.busy ? <p className="dbw-field-operation-status" role="status">{submission.action === 'create' ? text.creating : text.saving}</p> : null}
        <div className="dbw-field-list">
          {orderedFields.map((field, index) => (
            <FieldRow
              field={field}
              isFirst={index === 0}
              isLast={index === orderedFields.length - 1}
              key={`${sourceSessionKey}:${field.id}`}
              onDelete={() => onDeleteField(field)}
              onMove={(direction) => onMoveField(field.id, direction)}
              onMoveDefault={(direction) => onMoveDatabaseField(field.id, direction)}
              onRename={(nextName) => onRenameField(field.id, nextName)}
              onToggle={() => onToggleField(field.id)}
              onUpdateOptions={(nextOptions) => onUpdateOptions(field.id, nextOptions)}
              text={text}
              submission={submission}
              visible={visibleFieldIds.includes(field.id)}
            />
          ))}
        </div>
        <div className="dbw-field-create">
          {creating ? (
            <div className="dbw-field-create-form"
              onCompositionStartCapture={() => { createComposingRef.current = true }}
              onCompositionEndCapture={() => { createComposingRef.current = false }}
              onBlurCapture={() => { createComposingRef.current = false }}
              onKeyDown={event => { if (isImeKeyboardEvent(event.nativeEvent, createComposingRef.current)) event.stopPropagation() }}>
              <p className="dbw-field-create-hint" id={requiredHintId}>{text.requiredFieldsHint}</p>
              <label className="dbw-field-create-label">
                <span>{text.name} <span aria-hidden="true">*</span></span>
                <input aria-describedby={requiredHintId} aria-label={text.name} aria-required="true" autoFocus disabled={submission.busy} onChange={(event) => setName(event.target.value)} placeholder={text.name} value={name} />
              </label>
              <label className="dbw-field-create-label">
                <span>{text.fieldType}</span>
                <select aria-label={text.fieldType} disabled={submission.busy} onChange={(event) => setType(event.target.value as DocumentDatabaseColumnType)} value={type}>
                  {(['text', 'select', 'multi-select', 'date', 'checkbox'] as DocumentDatabaseColumnType[]).map(value =>
                    <option key={value} value={value}>{fieldTypeLabel(value, text)}</option>)}
                </select>
              </label>
              {type === 'select' || type === 'multi-select' ? (
                <label className="dbw-field-create-label">
                  <span>{text.options} <span aria-hidden="true">*</span></span>
                  <input aria-describedby={optionsHintId} aria-label={text.options} aria-required="true" disabled={submission.busy} onChange={(event) => setOptions(event.target.value)} placeholder={text.options} value={options} />
                  <span className="dbw-field-create-hint" id={optionsHintId}>{text.fieldOptionsHint}</span>
                </label>
              ) : null}
              {failed ? <p className="dbw-field-submit-error" role="alert">{text.failed}</p> : null}
              <div className="dbw-inline-actions">
                <button className="dbw-primary-button" disabled={submission.busy || !name.trim() || ((type === 'select' || type === 'multi-select') && !options.split(',').some(option => option.trim()))} onClick={() => void submit()} type="button">{submission.action === 'create' ? text.creating : text.create}</button>
                <button className="dbw-quiet-button" disabled={submission.busy} onClick={() => { if (!submission.isBusy()) { setCreating(false); setFailed(false); setName(''); setType('text'); setOptions('') } }} type="button">{text.cancel}</button>
              </div>
            </div>
          ) : <button className="dbw-add-field-button" disabled={submission.busy} onClick={() => { if (!submission.isBusy()) setCreating(true) }} type="button">＋ {text.addField}</button>}
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
  submission,
  text,
  visible
}: {
  field: DatabaseField
  isFirst: boolean
  isLast: boolean
  onDelete: () => void
  onMove: (direction: 'up' | 'down') => void
  onMoveDefault: (direction: 'left' | 'right') => Promise<boolean>
  onRename: (name: string) => Promise<boolean>
  onToggle: () => void
  onUpdateOptions: (options: string[]) => Promise<boolean>
  submission: ReturnType<typeof useFieldSubmission>
  text: DatabaseWorkspaceText
  visible: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(field.name)
  const [options, setOptions] = useState(field.options.join(', '))
  const [nameFailed, setNameFailed] = useState(false)
  const [optionsFailed, setOptionsFailed] = useState(false)
  const [moveFailed, setMoveFailed] = useState(false)
  const nameButtonRef = useRef<HTMLButtonElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const nameEditingRef = useRef(false)
  const composingRef = useRef(false)
  const optionsComposingRef = useRef(false)
  const restoreNameFocusRef = useRef(false)
  const restoreEditorFocusRef = useRef(false)
  const mounted = useRef(false)
  const savedNameRef = useRef(field.name)
  const savedOptionsRef = useRef(field.options)
  const nameSavingRef = useRef(false)
  const optionsSavingRef = useRef(false)
  const nameFailedRef = useRef(false)
  const optionsFailedRef = useRef(false)
  const optionsKey = JSON.stringify(field.options)

  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    savedNameRef.current = field.name
    if (!nameSavingRef.current && !nameFailedRef.current) setName(field.name)
  }, [field.name])
  useEffect(() => {
    savedOptionsRef.current = field.options
    if (!optionsSavingRef.current && !optionsFailedRef.current) setOptions(field.options.join(', '))
  }, [optionsKey])
  useLayoutEffect(() => {
    if (!editing && restoreNameFocusRef.current) {
      restoreNameFocusRef.current = false
      nameButtonRef.current?.focus({ preventScroll: true })
    }
    if (editing && !submission.busy && restoreEditorFocusRef.current) {
      restoreEditorFocusRef.current = false
      nameInputRef.current?.focus({ preventScroll: true })
    }
  }, [editing, nameFailed, submission.busy])

  const commitName = async (value: string) => {
    if (!nameEditingRef.current || submission.isBusy()) return
    nameEditingRef.current = false
    const normalized = value.trim()
    if (!normalized || normalized === savedNameRef.current) {
      setName(savedNameRef.current)
      nameFailedRef.current = false
      setNameFailed(false)
      setEditing(false)
      return
    }
    setName(value)
    nameSavingRef.current = true
    nameFailedRef.current = false
    setNameFailed(false)
    const completed = await submission.run('name', () => onRename(normalized))
    if (!mounted.current || completed === null) return
    nameSavingRef.current = false
    if (completed) {
      savedNameRef.current = normalized
      setName(normalized)
      setEditing(false)
    } else {
      nameFailedRef.current = true
      nameEditingRef.current = true
      restoreEditorFocusRef.current = restoreNameFocusRef.current
      restoreNameFocusRef.current = false
      setNameFailed(true)
    }
  }
  const commitOptions = async (value: string) => {
    if (submission.isBusy()) return
    if (value === savedOptionsRef.current.join(', ')) return
    const normalized = [...new Set(value.split(',').map((option) => option.trim()).filter(Boolean))]
    if (normalized.length === 0) return
    optionsSavingRef.current = true
    optionsFailedRef.current = false
    setOptionsFailed(false)
    const completed = await submission.run('options', () => onUpdateOptions(normalized))
    if (!mounted.current || completed === null) return
    optionsSavingRef.current = false
    if (completed) { savedOptionsRef.current = normalized; setOptions(normalized.join(', ')) }
    else { optionsFailedRef.current = true; setOptionsFailed(true) }
  }
  const moveDefault = async (direction: 'left' | 'right') => {
    if (submission.isBusy()) return
    setMoveFailed(false)
    const completed = await submission.run('move', () => onMoveDefault(direction))
    if (mounted.current && completed !== null) setMoveFailed(!completed)
  }

  return (
    <div className={`dbw-field-row${visible ? '' : ' is-hidden'}`}>
      <span aria-hidden="true" className="dbw-field-grip">⠿</span>
      <div className="dbw-field-copy">
        {editing && field.role === 'property' ? (
          <input aria-label={`${text.name} · ${field.name}`} autoFocus disabled={submission.busy} ref={nameInputRef}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={() => { composingRef.current = false }}
            onBlur={(event) => { composingRef.current = false; void commitName(event.currentTarget.value) }}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (isImeKeyboardEvent(event.nativeEvent, composingRef.current)) {
                event.stopPropagation()
                return
              }
              if (submission.isBusy()) { event.preventDefault(); event.stopPropagation(); return }
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                restoreNameFocusRef.current = true
                event.currentTarget.blur()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                nameEditingRef.current = false
                restoreNameFocusRef.current = true
                nameFailedRef.current = false
                setNameFailed(false)
                setName(savedNameRef.current)
                setEditing(false)
                event.currentTarget.blur()
              }
            }} value={name} />
        ) : <button className="dbw-field-name" disabled={field.role !== 'property' || submission.busy} ref={nameButtonRef} onClick={() => {
          if (submission.isBusy()) return
          nameEditingRef.current = true
          composingRef.current = false
          setName(savedNameRef.current)
          setEditing(true)
        }} type="button">{editing ? field.name : name}</button>}
        {nameFailed ? <p className="dbw-field-submit-error" role="alert">{text.failed}</p> : null}
        {editing ? <button aria-label={`${text.save} · ${text.name} · ${field.name}`} className="dbw-field-submit" disabled={submission.busy || !name.trim()} onClick={() => void commitName(name)} type="button">{text.save}</button> : null}
        <small>{field.role === 'property' ? fieldTypeLabel(field.type, text) : `${text.system} · ${fieldTypeLabel(field.type, text)}`}</small>
        {(field.type === 'select' || field.type === 'multi-select') && field.role === 'property' ? (
          <>
            <input aria-label={`${text.options} · ${field.name}`} className="dbw-field-options" disabled={submission.busy}
              onCompositionStart={() => { optionsComposingRef.current = true }}
              onCompositionEnd={() => { optionsComposingRef.current = false }}
              onKeyDown={event => { if (isImeKeyboardEvent(event.nativeEvent, optionsComposingRef.current)) event.stopPropagation() }}
              onBlur={event => { optionsComposingRef.current = false; void commitOptions(event.currentTarget.value) }} onChange={(event) => setOptions(event.target.value)} value={options} />
            {optionsFailed ? <p className="dbw-field-submit-error" role="alert">{text.failed}</p> : null}
            {options !== savedOptionsRef.current.join(', ') || optionsFailed ? <button aria-label={`${text.save} · ${text.options} · ${field.name}`} className="dbw-field-submit" disabled={submission.busy || !options.split(',').some(option => option.trim())} onClick={() => void commitOptions(options)} type="button">{text.save}</button> : null}
          </>
        ) : null}
        {moveFailed ? <p className="dbw-field-submit-error" role="alert">{text.failed}</p> : null}
      </div>
      <button className="dbw-field-visibility" disabled={!field.hideable || submission.busy} onClick={() => { if (!submission.isBusy()) onToggle() }} type="button">{visible ? text.hide : text.show}</button>
      <div className="dbw-field-row-actions">
        <button aria-label={text.moveUp} disabled={isFirst || submission.busy} onClick={() => { if (!submission.isBusy()) onMove('up') }} type="button">↑</button>
        <button aria-label={text.moveDown} disabled={isLast || submission.busy} onClick={() => { if (!submission.isBusy()) onMove('down') }} type="button">↓</button>
        {field.role === 'property' ? <button aria-label={`${text.moveUp} · ${text.system}`} disabled={submission.busy} onClick={() => void moveDefault('left')} title={text.moveUp} type="button">←</button> : null}
        {field.role === 'property' ? <button aria-label={`${text.moveDown} · ${text.system}`} disabled={submission.busy} onClick={() => void moveDefault('right')} title={text.moveDown} type="button">→</button> : null}
        {field.deletable ? <button aria-label={text.deleteField} className="dbw-danger-text" disabled={submission.busy} onClick={() => { if (!submission.isBusy()) onDelete() }} type="button">×</button> : null}
      </div>
    </div>
  )
}

function fieldTypeLabel(type: DocumentDatabaseColumnType, text: DatabaseWorkspaceText): string {
  return { text: text.typeText, select: text.typeSelect, 'multi-select': text.typeMultiSelect, date: text.typeDate, checkbox: text.typeCheckbox }[type]
}

function useFieldSubmission(session: string | null) {
  const generation = useRef(0)
  const currentSession = useRef<string | null>(null)
  const mounted = useRef(false)
  const lock = useRef(false)
  const [action, setAction] = useState<'create' | 'name' | 'options' | 'move' | null>(null)
  useLayoutEffect(() => {
    ++generation.current
    mounted.current = true
    currentSession.current = session
    lock.current = false
    setAction(null)
    return () => { mounted.current = false; ++generation.current; currentSession.current = null; lock.current = false }
  }, [session])
  const run = async (kind: NonNullable<typeof action>, operation: () => Promise<boolean>): Promise<boolean | null> => {
    if (!session || !mounted.current || currentSession.current !== session || lock.current) return null
    const requestGeneration = generation.current
    lock.current = true
    setAction(kind)
    let completed = false
    try { completed = await operation() === true } catch { /* Show a safe inline failure and retain the draft. */ }
    if (!mounted.current || generation.current !== requestGeneration) return null
    lock.current = false
    setAction(null)
    return completed
  }
  return { action, busy: action !== null, isBusy: () => lock.current, run }
}
