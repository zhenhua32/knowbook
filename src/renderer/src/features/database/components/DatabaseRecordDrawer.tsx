import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DatabaseField, DatabaseRecord, DocumentCatalogEntry, DocumentDatabaseFieldValue } from '@shared/contracts'
import { DatabaseValueEditor } from './DatabaseValueEditor'
import { useDatabaseDialogFocus } from '../hooks/useDatabaseDialogFocus'
import type { DatabaseWorkspaceText } from '../databaseText'

type RecordDraft = {
  title: string
  documentId: string
  fieldValues: Record<string, DocumentDatabaseFieldValue>
}

function useRecordSubmission(session: string | true | null) {
  const generation = useRef(0)
  const mounted = useRef(false)
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useLayoutEffect(() => {
    generation.current += 1
    mounted.current = true
    lock.current = false
    setBusy(false)
    setFailed(false)
    return () => {
      mounted.current = false
      generation.current += 1
      lock.current = false
    }
  }, [session])

  const submit = async (action: () => Promise<boolean>, onSuccess?: () => void) => {
    if (!session || !mounted.current || lock.current) return
    const requestGeneration = generation.current
    const isCurrent = () => mounted.current && generation.current === requestGeneration
    lock.current = true
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
  const [draft, setDraft] = useState<RecordDraft>({ title: '', documentId: '', fieldValues: {} })
  const propertyFields = useMemo(() => fields.filter((field) => field.role === 'property'), [fields])
  const submission = useRecordSubmission(open ? record?.id ?? null : null)
  const close = () => { if (!submission.isBusy()) onClose() }
  const updateDraft = (update: (current: RecordDraft) => RecordDraft) => {
    if (!submission.isBusy()) setDraft(update)
  }

  useLayoutEffect(() => {
    // A refresh during submission must not replace the draft, including after failure.
    if (!open || !record || submission.isBusy()) return
    setDraft({
      title: record.title,
      documentId: record.documentId ?? '',
      fieldValues: Object.fromEntries(propertyFields.map((field) => [field.id, toDocumentValue(record.fieldValues[field.id])]))
    })
  }, [open, propertyFields, record])

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
              <div className="dbw-record-field" key={field.id}>
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
        {submission.failed ? <p className="dbw-record-submit-error" role="alert">{text.failed}</p> : null}
        <footer className="dbw-drawer-footer">
          <button className="dbw-danger-quiet-button" disabled={submission.busy} onClick={() => { if (!submission.isBusy()) onDelete(record) }} type="button">{text.deleteRecord}</button>
          <div><button className="dbw-quiet-button" disabled={submission.busy} onClick={close} type="button">{text.cancel}</button><button className="dbw-primary-button" disabled={submission.busy || !draft.title.trim()} onClick={() => { if (draft.title.trim()) void submission.submit(() => onSave(record, draft), onClose) }} type="button">{submission.busy ? text.saving : text.save}</button></div>
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
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const propertyFields = fields.filter((field) => field.role === 'property')
  const [draft, setDraft] = useState<RecordDraft>({ title: '', documentId: '', fieldValues: {} })
  const focusTitle = useRef(false)
  const submission = useRecordSubmission(open ? true : null)
  const cancel = () => { if (!submission.isBusy()) onCancel() }
  const updateDraft = (update: (current: RecordDraft) => RecordDraft) => {
    if (!submission.isBusy()) setDraft(update)
  }
  useLayoutEffect(() => {
    focusTitle.current = false
    if (!open) return
    setDraft({ title: '', documentId: '', fieldValues: {} })
  }, [open])
  useLayoutEffect(() => {
    if (open && !submission.busy && focusTitle.current) {
      focusTitle.current = false
      titleRef.current?.focus()
    }
  })
  useDatabaseDialogFocus({ containerRef: dialogRef, initialFocusRef: titleRef, onClose: cancel, open })
  if (!open) return null

  const submit = async (continueAdding: boolean) => {
    if (!draft.title.trim()) return
    await submission.submit(() => onCreate(draft, continueAdding), () => {
      if (!continueAdding) {
        onCancel()
        return
      }
      focusTitle.current = true
      setDraft({ title: '', documentId: '', fieldValues: {} })
    })
  }

  return (
    <div className="dbw-modal-layer">
      <button aria-label={text.close} className="dbw-modal-scrim" disabled={submission.busy} onClick={cancel} type="button" />
      <div aria-busy={submission.busy} aria-label={text.createRecord} aria-modal="true" className="dbw-dialog dbw-create-record-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
        <header><h2>{text.createRecord}</h2><button aria-label={text.close} className="dbw-icon-button" disabled={submission.busy} onClick={cancel} type="button">×</button></header>
        <fieldset className="dbw-record-form" disabled={submission.busy}>
          <label><span>{text.title} *</span><input onChange={(event) => updateDraft((current) => ({ ...current, title: event.target.value }))} ref={titleRef} value={draft.title} /></label>
          <label><span>{text.linkedDocument}</span><select onChange={(event) => updateDraft((current) => ({ ...current, documentId: event.target.value }))} value={draft.documentId}><option value="">{text.noLinkedDocument}</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.path}</option>)}</select></label>
          {propertyFields.map((field) => (
            <div className="dbw-record-field" key={field.id}><span>{field.name}</span><DatabaseValueEditor column={{ id: field.id, name: field.name, type: field.type, options: field.options, sortOrder: field.sortOrder }} onChangeValue={(value) => updateDraft((current) => ({ ...current, fieldValues: { ...current.fieldValues, [field.id]: value } }))} textCommitMode="change" value={draft.fieldValues[field.id] ?? null} /></div>
          ))}
        </fieldset>
        {submission.failed ? <p className="dbw-record-submit-error" role="alert">{text.failed}</p> : null}
        <footer><button className="dbw-quiet-button" disabled={submission.busy || !draft.title.trim()} onClick={() => void submit(true)} type="button">{submission.busy ? text.creating : text.createAndContinue}</button><button className="dbw-primary-button" disabled={submission.busy || !draft.title.trim()} onClick={() => void submit(false)} type="button">{submission.busy ? text.creating : text.create}</button></footer>
      </div>
    </div>
  )
}

function toDocumentValue(value: unknown): DocumentDatabaseFieldValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return null
}
