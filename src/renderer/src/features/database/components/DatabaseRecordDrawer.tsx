import { useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { DatabaseField, DatabaseRecord, DocumentCatalogEntry, DocumentDatabaseFieldValue } from '@shared/contracts'
import { DatabaseValueEditor } from './DatabaseValueEditor'
import { useDatabaseDialogFocus } from '../hooks/useDatabaseDialogFocus'
import type { DatabaseWorkspaceText } from '../databaseText'
import { isImeKeyboardEvent } from '../../../utils/imeKeyboard'

type RecordDraft = {
  title: string
  documentId: string
  fieldValues: Record<string, DocumentDatabaseFieldValue>
}

type RecordSubmissionFocus = {
  container: HTMLElement
  origin: HTMLElement
  target: HTMLElement | null
  cleanup: () => void
}

function isRecordFocusVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse'
}

function useRecordSubmission(session: string | true | null, containerRef: RefObject<HTMLElement | null>) {
  const generation = useRef(0)
  const mounted = useRef(false)
  const lock = useRef(false)
  const pendingFocus = useRef<RecordSubmissionFocus | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const clearFocus = () => {
    pendingFocus.current?.cleanup()
    pendingFocus.current = null
  }

  const captureFocus = () => {
    clearFocus()
    const container = containerRef.current
    const document = container?.ownerDocument
    const window = document?.defaultView
    const origin = document?.activeElement
    if (!container || !document || !window || !(origin instanceof window.HTMLElement)
      || !document.hasFocus() || !container.contains(origin) || !isRecordFocusVisible(container)
      || !isRecordFocusVisible(origin) || origin.matches(':disabled, [aria-disabled="true"]')) return null

    const captured: RecordSubmissionFocus = { container, origin, target: null, cleanup: () => {} }
    const cancel = () => { if (pendingFocus.current === captured) clearFocus() }
    const onFocusIn = (event: FocusEvent) => {
      if (event.target !== document.body && event.target !== origin) cancel()
    }
    const onFocusOut = (event: FocusEvent) => {
      // Chromium moves a newly disabled submission button to BODY while work is pending.
      const toBody = !event.relatedTarget || event.relatedTarget === document.body
      if (!toBody || !origin.matches(':disabled') || !origin.isConnected) cancel()
    }
    captured.cleanup = () => {
      document.removeEventListener('pointerdown', cancel, true)
      document.removeEventListener('keydown', cancel, true)
      document.removeEventListener('compositionstart', cancel, true)
      document.removeEventListener('focusin', onFocusIn, true)
      origin.removeEventListener('focusout', onFocusOut)
      window.removeEventListener('blur', cancel)
    }
    pendingFocus.current = captured
    document.addEventListener('pointerdown', cancel, true)
    document.addEventListener('keydown', cancel, true)
    document.addEventListener('compositionstart', cancel, true)
    document.addEventListener('focusin', onFocusIn, true)
    origin.addEventListener('focusout', onFocusOut)
    window.addEventListener('blur', cancel)
    return captured
  }

  useLayoutEffect(() => {
    clearFocus()
    generation.current += 1
    mounted.current = true
    lock.current = false
    setBusy(false)
    setFailed(false)
    return () => {
      clearFocus()
      mounted.current = false
      generation.current += 1
      lock.current = false
    }
  }, [session])

  useLayoutEffect(() => {
    const captured = pendingFocus.current
    if (!captured?.target || busy) return
    const { container, origin, target } = captured
    const document = origin.ownerDocument
    const active = document.activeElement
    const canRestore = containerRef.current === container && document.hasFocus()
      && isRecordFocusVisible(container) && container.contains(origin) && isRecordFocusVisible(origin)
      && container.contains(target) && isRecordFocusVisible(target)
      && !target.matches(':disabled, [aria-disabled="true"]')
      && (active === document.body || active === origin)
      && ![...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [role="alertdialog"]')]
        .some(dialog => dialog !== container && isRecordFocusVisible(dialog))
    // Consume once after React re-enables the control; newer activity permanently cancels it.
    clearFocus()
    if (canRestore) target.focus()
  })

  const submit = async (
    action: () => Promise<boolean>,
    onSuccess?: () => void,
    successFocusRef?: RefObject<HTMLElement | null>
  ) => {
    if (!session || !mounted.current || lock.current) return
    const requestGeneration = generation.current
    const isCurrent = () => mounted.current && generation.current === requestGeneration
    lock.current = true
    const capturedFocus = captureFocus()
    setBusy(true)
    setFailed(false)
    let completed = false
    try {
      completed = await action()
    } catch {
      // The workspace reports operation errors; keep this form safe to retry.
    }
    if (!isCurrent()) return
    lock.current = false
    const target = completed === true ? successFocusRef?.current : capturedFocus?.origin
    if (capturedFocus && pendingFocus.current === capturedFocus && target) capturedFocus.target = target
    else clearFocus()
    setBusy(false)
    if (completed === true) onSuccess?.()
    else setFailed(true)
  }

  return { busy, failed, isBusy: () => lock.current, submit }
}

export function DatabaseRecordDrawer({
  documents,
  fields,
  open,
  record,
  text,
  onClose,
  onDelete,
  onOpenDocument,
  onSave
}: {
  documents: DocumentCatalogEntry[]
  fields: DatabaseField[]
  open: boolean
  record: DatabaseRecord | null
  text: DatabaseWorkspaceText
  onClose: () => void
  onDelete: (record: DatabaseRecord) => void
  onOpenDocument: (documentId: string) => void
  onSave: (record: DatabaseRecord, draft: RecordDraft) => Promise<boolean>
}) {
  const drawerRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const errorId = useId()
  const draftSession = useRef<string | null>(null)
  const edited = useRef(false)
  const [draft, setDraft] = useState<RecordDraft>({ title: '', documentId: '', fieldValues: {} })
  const propertyFields = useMemo(() => fields.filter((field) => field.role === 'property'), [fields])
  const submission = useRecordSubmission(open ? record?.id ?? null : null, drawerRef)
  const close = () => { if (!submission.isBusy()) onClose() }
  const updateDraft = (update: (current: RecordDraft) => RecordDraft) => {
    if (submission.isBusy()) return
    edited.current = true
    setDraft(update)
  }

  useLayoutEffect(() => {
    if (!open || !record) {
      draftSession.current = null
      edited.current = false
      return
    }
    const newSession = draftSession.current !== record.id
    if (newSession) {
      draftSession.current = record.id
      edited.current = false
    }
    if (!newSession && submission.isBusy()) return
    if (!newSession && (edited.current || submission.failed)) {
      // Catalog refreshes must preserve local edits, while reflecting added or removed properties.
      setDraft((current) => {
        if (Object.keys(current.fieldValues).length === propertyFields.length &&
          propertyFields.every((field) => Object.hasOwn(current.fieldValues, field.id))) return current
        return {
          ...current,
          fieldValues: Object.fromEntries(propertyFields.map((field) => [field.id,
            Object.hasOwn(current.fieldValues, field.id) ? current.fieldValues[field.id] : toDocumentValue(record.fieldValues[field.id])]))
        }
      })
      return
    }
    setDraft({
      title: record.title,
      documentId: record.documentId ?? '',
      fieldValues: Object.fromEntries(propertyFields.map((field) => [field.id, toDocumentValue(record.fieldValues[field.id])]))
    })
  }, [open, propertyFields, record, submission.busy, submission.failed])

  useDatabaseDialogFocus({ containerRef: drawerRef, initialFocusRef: closeRef, onClose: close, open })

  if (!open || !record) return null

  return (
    <>
      <button aria-label={text.close} className="dbw-drawer-scrim" disabled={submission.busy} onClick={close} type="button" />
      <aside aria-busy={submission.busy} aria-label={text.recordDetails} aria-modal="true" className="dbw-drawer dbw-record-drawer" ref={drawerRef} role="dialog" tabIndex={-1}>
        <header className="dbw-drawer-header">
          <div><p className="dbw-eyebrow">{text.recordDetails}</p><h2 title={record.title}>{record.title}</h2></div>
          <button aria-label={text.close} className="dbw-icon-button" disabled={submission.busy} onClick={close} ref={closeRef} type="button">×</button>
        </header>
        <fieldset className="dbw-record-form" disabled={submission.busy}>
          <label><span>{text.title}</span><input className="dbw-record-title-input" onChange={(event) => updateDraft((current) => ({ ...current, title: event.target.value }))} value={draft.title} /></label>
          <label>
            <span>{text.linkedDocument}</span>
            <select onChange={(event) => updateDraft((current) => ({ ...current, documentId: event.target.value }))} value={draft.documentId}>
              <option value="">{text.noLinkedDocument}</option>
              {documents.map((document) => <option key={document.id} value={document.id}>{document.path}</option>)}
            </select>
          </label>
          {draft.documentId ? <button className="dbw-open-document-button" onClick={() => { if (!submission.isBusy()) onOpenDocument(draft.documentId) }} type="button">↗ {text.openDocument}</button> : null}
          <div className="dbw-record-properties">
            {propertyFields.map((field) => (
              <div className="dbw-record-field" key={`${record.id}:${field.id}`}>
                <span>{field.name}</span>
                <DatabaseValueEditor
                  column={{ id: field.id, name: field.name, type: field.type, options: field.options, sortOrder: field.sortOrder }}
                  onChangeValue={(value) => updateDraft((current) => ({ ...current, fieldValues: { ...current.fieldValues, [field.id]: value } }))}
                  textCommitMode="change"
                  value={draft.fieldValues[field.id] ?? null}
                />
              </div>
            ))}
          </div>
        </fieldset>
        {submission.failed ? <p className="dbw-record-submit-error" id={errorId} role="alert">{text.formFailed}</p> : null}
        <footer className="dbw-drawer-footer">
          <button className="dbw-danger-quiet-button" disabled={submission.busy} onClick={() => { if (!submission.isBusy()) onDelete(record) }} type="button">{text.deleteRecord}</button>
          <div><button className="dbw-quiet-button" disabled={submission.busy} onClick={close} type="button">{text.cancel}</button><button aria-describedby={submission.failed ? errorId : undefined} className="dbw-primary-button" disabled={submission.busy || !draft.title.trim()} onClick={() => { if (draft.title.trim()) void submission.submit(() => onSave(record, draft), onClose) }} type="button">{submission.busy ? text.saving : text.save}</button></div>
        </footer>
      </aside>
    </>
  )
}

export function CreateRecordDialog({
  documents,
  fields,
  open,
  text,
  onCancel,
  onCreate
}: {
  documents: DocumentCatalogEntry[]
  fields: DatabaseField[]
  open: boolean
  text: DatabaseWorkspaceText
  onCancel: () => void
  onCreate: (draft: RecordDraft, continueAdding: boolean) => Promise<boolean>
}) {
  const dialogRef = useRef<HTMLFormElement | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const createComposingRef = useRef(false)
  const blockedImplicitSubmitRef = useRef(false)
  const errorId = useId()
  const propertyFields = fields.filter((field) => field.role === 'property')
  const [draft, setDraft] = useState<RecordDraft>({ title: '', documentId: '', fieldValues: {} })
  const submission = useRecordSubmission(open ? true : null, dialogRef)
  const cancel = () => { if (!submission.isBusy()) onCancel() }
  const updateDraft = (update: (current: RecordDraft) => RecordDraft) => {
    if (!submission.isBusy()) setDraft(update)
  }
  useLayoutEffect(() => {
    createComposingRef.current = false
    blockedImplicitSubmitRef.current = false
    if (!open) return
    setDraft({ title: '', documentId: '', fieldValues: {} })
  }, [open])
  useDatabaseDialogFocus({ containerRef: dialogRef, initialFocusRef: titleRef, onClose: cancel, open })
  if (!open) return null

  const submit = async (continueAdding: boolean) => {
    if (createComposingRef.current || blockedImplicitSubmitRef.current || !draft.title.trim()) return
    await submission.submit(() => onCreate(draft, continueAdding), () => {
      createComposingRef.current = false
      blockedImplicitSubmitRef.current = false
      if (!continueAdding) {
        onCancel()
        return
      }
      setDraft({ title: '', documentId: '', fieldValues: {} })
    }, continueAdding ? titleRef : undefined)
  }

  return (
    <div className="dbw-modal-layer">
      <button aria-label={text.close} className="dbw-modal-scrim" disabled={submission.busy} onClick={cancel} type="button" />
      <form aria-busy={submission.busy} aria-label={text.createRecord} aria-modal="true" className="dbw-dialog dbw-create-record-dialog" noValidate ref={dialogRef} role="dialog" tabIndex={-1}
        onCompositionStartCapture={() => { createComposingRef.current = true }}
        // Candidate confirmation can end composition before the browser's implicit submit.
        onCompositionEndCapture={() => { createComposingRef.current = false }}
        onBlurCapture={() => { createComposingRef.current = false; blockedImplicitSubmitRef.current = false }}
        onPointerDownCapture={() => { blockedImplicitSubmitRef.current = false }}
        onKeyDownCapture={event => { blockedImplicitSubmitRef.current = isImeKeyboardEvent(event.nativeEvent, createComposingRef.current) }}
        onSubmit={event => { event.preventDefault(); void submit(false) }}
        onKeyDown={event => { if (isImeKeyboardEvent(event.nativeEvent, createComposingRef.current)) event.stopPropagation() }}>
        <header><h2>{text.createRecord}</h2><button aria-label={text.close} className="dbw-icon-button" disabled={submission.busy} onClick={cancel} type="button">×</button></header>
        <fieldset className="dbw-record-form" disabled={submission.busy}>
          <label><span>{text.title} *</span><input onChange={(event) => updateDraft((current) => ({ ...current, title: event.target.value }))} ref={titleRef} value={draft.title} /></label>
          <label><span>{text.linkedDocument}</span><select onChange={(event) => updateDraft((current) => ({ ...current, documentId: event.target.value }))} value={draft.documentId}><option value="">{text.noLinkedDocument}</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.path}</option>)}</select></label>
          {propertyFields.map((field) => (
            <div className="dbw-record-field" key={field.id}><span>{field.name}</span><DatabaseValueEditor column={{ id: field.id, name: field.name, type: field.type, options: field.options, sortOrder: field.sortOrder }} onChangeValue={(value) => updateDraft((current) => ({ ...current, fieldValues: { ...current.fieldValues, [field.id]: value } }))} textCommitMode="change" value={draft.fieldValues[field.id] ?? null} /></div>
          ))}
        </fieldset>
        {submission.failed ? <p className="dbw-record-submit-error" id={errorId} role="alert">{text.formFailed}</p> : null}
        <footer><button aria-describedby={submission.failed ? errorId : undefined} className="dbw-quiet-button" disabled={submission.busy || !draft.title.trim()} onClick={() => void submit(true)} type="button">{submission.busy ? text.creating : text.createAndContinue}</button><button aria-describedby={submission.failed ? errorId : undefined} className="dbw-primary-button" disabled={submission.busy || !draft.title.trim()} type="submit">{submission.busy ? text.creating : text.create}</button></footer>
      </form>
    </div>
  )
}

function toDocumentValue(value: unknown): DocumentDatabaseFieldValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return null
}
