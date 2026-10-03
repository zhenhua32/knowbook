import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
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
  const createFormRef = useRef<HTMLFormElement | null>(null)
  const addFieldRef = useRef<HTMLButtonElement | null>(null)
  const requiredHintId = useId()
  const optionsHintId = useId()
  const createComposingRef = useRef(false)
  const blockedImplicitSubmitRef = useRef(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<DocumentDatabaseColumnType>('text')
  const [options, setOptions] = useState('')
  const [failed, setFailed] = useState(false)
  const submission = useFieldSubmission(open ? sourceSessionKey : null)
  const createFocus = useFieldCreationFocus(drawerRef, createFormRef, addFieldRef, open ? sourceSessionKey : null)
  const close = () => { if (!submission.isBusy()) onClose() }

  useLayoutEffect(() => {
    createComposingRef.current = false
    blockedImplicitSubmitRef.current = false
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
    const pendingFocus = createFocus.capture()
    setFailed(false)
    const completed = await submission.run('create', () => onCreateField(normalizedName, type, normalizedOptions))
    createFocus.complete(pendingFocus, completed)
    if (completed === null) return
    if (!completed) { setFailed(true); return }
    setName('')
    setType('text')
    setOptions('')
    setCreating(false)
  }

  const cancelCreate = () => {
    if (submission.isBusy()) return
    const pendingFocus = createFocus.capture()
    createFocus.complete(pendingFocus, true)
    createComposingRef.current = false
    blockedImplicitSubmitRef.current = false
    setCreating(false)
    setFailed(false)
    setName('')
    setType('text')
    setOptions('')
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
            <form className="dbw-field-create-form" noValidate ref={createFormRef}
              onCompositionStartCapture={() => { createComposingRef.current = true }}
              // Candidate confirmation can end composition before the browser's implicit submit.
              onCompositionEndCapture={() => { createComposingRef.current = false }}
              onBlurCapture={() => { createComposingRef.current = false; blockedImplicitSubmitRef.current = false }}
              onPointerDownCapture={() => { blockedImplicitSubmitRef.current = false }}
              onKeyDownCapture={event => { blockedImplicitSubmitRef.current = isImeKeyboardEvent(event.nativeEvent, createComposingRef.current) }}
              onSubmit={event => {
                event.preventDefault()
                if (createComposingRef.current || blockedImplicitSubmitRef.current) return
                void submit()
              }}
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
                <button className="dbw-primary-button" disabled={submission.busy || !name.trim() || ((type === 'select' || type === 'multi-select') && !options.split(',').some(option => option.trim()))} type="submit">{submission.action === 'create' ? text.creating : text.create}</button>
                <button className="dbw-quiet-button" disabled={submission.busy} onClick={cancelCreate} type="button">{text.cancel}</button>
              </div>
            </form>
          ) : <button className="dbw-add-field-button" disabled={submission.busy} onClick={() => { if (!submission.isBusy()) { createComposingRef.current = false; blockedImplicitSubmitRef.current = false; setCreating(true) } }} ref={addFieldRef} type="button">＋ {text.addField}</button>}
        </div>
      </aside>
    </>
  )
}

type FieldCreationFocus = {
  origin: HTMLElement
  target: HTMLElement | 'add' | null
  cleanup: () => void
}

function isFieldFocusVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse'
}

function useFieldCreationFocus(
  drawerRef: RefObject<HTMLElement | null>,
  formRef: RefObject<HTMLFormElement | null>,
  addRef: RefObject<HTMLButtonElement | null>,
  session: string | null
) {
  const pendingRef = useRef<FieldCreationFocus | null>(null)
  const clear = () => {
    pendingRef.current?.cleanup()
    pendingRef.current = null
  }
  useLayoutEffect(() => clear, [session])
  useLayoutEffect(() => {
    const pending = pendingRef.current
    if (!pending?.target) return
    const drawer = drawerRef.current
    const document = pending.origin.ownerDocument
    const target = pending.target === 'add' ? addRef.current : pending.target
    if (!drawer || !target || !isFieldFocusVisible(drawer) || !isFieldFocusVisible(target)
      || !drawer.contains(target) || !document.hasFocus()
      || (document.activeElement !== document.body && document.activeElement !== pending.origin)
      || [...document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')]
        .some(dialog => dialog !== drawer && isFieldFocusVisible(dialog))) {
      clear()
      return
    }
    if (target.matches(':disabled, [aria-disabled="true"]')) return
    // Failure feedback can push the retry control below the form's scroll viewport.
    const preventScroll = pending.target === 'add'
    clear()
    target.focus({ preventScroll })
  })

  const capture = (): FieldCreationFocus | null => {
    clear()
    const form = formRef.current
    const drawer = drawerRef.current
    const document = form?.ownerDocument
    const origin = document?.activeElement
    if (!session || !form || !drawer || !(origin instanceof HTMLElement) || !form.contains(origin)
      || !document?.hasFocus() || !isFieldFocusVisible(drawer) || !isFieldFocusVisible(origin)) return null
    const abandon = () => { if (pendingRef.current === pending) clear() }
    const moved = (event: FocusEvent) => { if (event.target !== document.body) abandon() }
    const blurred = (event: FocusEvent) => {
      // Disabling a control or removing the completed form can move focus to BODY.
      const toBody = !event.relatedTarget || event.relatedTarget === document.body
      if (origin.isConnected && (!toBody || (!origin.matches(':disabled') && pending.target !== 'add'))) abandon()
    }
    const pending: FieldCreationFocus = { origin, target: null, cleanup: () => {
      document.removeEventListener('pointerdown', abandon, true)
      document.removeEventListener('keydown', abandon, true)
      document.removeEventListener('focusin', moved, true)
      origin.removeEventListener('focusout', blurred)
      document.defaultView?.removeEventListener('blur', abandon)
    } }
    pendingRef.current = pending
    document.addEventListener('pointerdown', abandon, true)
    document.addEventListener('keydown', abandon, true)
    document.addEventListener('focusin', moved, true)
    origin.addEventListener('focusout', blurred)
    document.defaultView?.addEventListener('blur', abandon)
    return pending
  }
  const complete = (pending: FieldCreationFocus | null, success: boolean | null) => {
    if (!pending || pendingRef.current !== pending) return
    if (success === null) { clear(); return }
    pending.target = success ? 'add' : pending.origin
  }
  return { capture, complete }
}

type FieldRenameFocus = {
  origin: HTMLInputElement
  drawer: HTMLElement
  blurring: boolean
  bodyTransition: boolean
  target: 'name' | 'editor' | null
  cleanup: () => void
}

function useFieldRenameFocus(
  inputRef: RefObject<HTMLInputElement | null>,
  buttonRef: RefObject<HTMLButtonElement | null>
) {
  const pendingRef = useRef<FieldRenameFocus | null>(null)
  const clear = () => {
    pendingRef.current?.cleanup()
    pendingRef.current = null
  }
  const hasForeignModal = (drawer: HTMLElement) => [...drawer.ownerDocument.querySelectorAll<HTMLElement>(
    'dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]'
  )].some(dialog => dialog !== drawer && isFieldFocusVisible(dialog))
  useLayoutEffect(() => clear, [])
  useLayoutEffect(() => {
    const pending = pendingRef.current
    if (!pending?.target) return
    const target = pending.target === 'name' ? buttonRef.current : inputRef.current
    const document = pending.origin.ownerDocument
    if (!target || (pending.target === 'editor' && target !== pending.origin)
      || !isFieldFocusVisible(pending.drawer) || !isFieldFocusVisible(target)
      || !pending.drawer.contains(target) || !document.hasFocus() || hasForeignModal(pending.drawer)
      || (document.activeElement !== document.body && document.activeElement !== pending.origin)) {
      clear()
      return
    }
    if (target.matches(':disabled') || target.closest('[aria-disabled="true"]')) { clear(); return }
    clear()
    target.focus({ preventScroll: true })
  })

  const blur = (origin: HTMLInputElement) => {
    clear()
    const document = origin.ownerDocument
    const drawer = origin.closest<HTMLElement>('.dbw-field-drawer')
    if (inputRef.current !== origin || !drawer || document.activeElement !== origin || !document.hasFocus()
      || !isFieldFocusVisible(drawer) || !isFieldFocusVisible(origin) || origin.matches(':disabled')
      || origin.closest('[aria-disabled="true"]') || hasForeignModal(drawer)) { origin.blur(); return }
    const abandon = () => { if (pendingRef.current === pending) clear() }
    const moved = (event: FocusEvent) => {
      if (event.target === document.body && (pending.blurring || pending.bodyTransition)) {
        pending.bodyTransition = false
        return
      }
      abandon()
    }
    const blurred = (event: FocusEvent) => {
      const toBody = !event.relatedTarget || event.relatedTarget === document.body
      if (!toBody || (!pending.blurring && !origin.matches(':disabled'))) { abandon(); return }
      pending.bodyTransition = true
      queueMicrotask(() => { pending.bodyTransition = false })
    }
    const pending: FieldRenameFocus = { origin, drawer, blurring: true, bodyTransition: false, target: null, cleanup: () => {
      document.removeEventListener('pointerdown', abandon, true)
      document.removeEventListener('keydown', abandon, true)
      document.removeEventListener('compositionstart', abandon, true)
      document.removeEventListener('focusin', moved, true)
      origin.removeEventListener('focusout', blurred)
      document.defaultView?.removeEventListener('blur', abandon)
    } }
    pendingRef.current = pending
    document.addEventListener('pointerdown', abandon, true)
    document.addEventListener('keydown', abandon, true)
    document.addEventListener('compositionstart', abandon, true)
    document.addEventListener('focusin', moved, true)
    origin.addEventListener('focusout', blurred)
    document.defaultView?.addEventListener('blur', abandon)
    // Enter deliberately blurs before the asynchronous submission disables its editor.
    try { origin.blur() } finally { pending.blurring = false; pending.bodyTransition = false }
  }
  const complete = (pending: FieldRenameFocus | null, completed: boolean | null) => {
    if (!pending || pendingRef.current !== pending) return
    if (completed === null) { clear(); return }
    pending.target = completed ? 'name' : 'editor'
  }
  return { blur, current: () => pendingRef.current, complete }
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
  const renameFocus = useFieldRenameFocus(nameInputRef, nameButtonRef)
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
    const pendingFocus = renameFocus.current()
    const completed = await submission.run('name', () => onRename(normalized))
    renameFocus.complete(pendingFocus, completed)
    if (!mounted.current || completed === null) return
    nameSavingRef.current = false
    if (completed) {
      savedNameRef.current = normalized
      setName(normalized)
      setEditing(false)
    } else {
      nameFailedRef.current = true
      nameEditingRef.current = true
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
                const normalized = event.currentTarget.value.trim()
                restoreNameFocusRef.current = !normalized || normalized === savedNameRef.current
                if (restoreNameFocusRef.current) event.currentTarget.blur()
                else renameFocus.blur(event.currentTarget)
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
