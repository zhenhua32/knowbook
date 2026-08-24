import { useEffect, useMemo, useRef, useState } from 'react'
import type { DatabaseField, DatabaseRecord, DocumentCatalogEntry, DocumentDatabaseFieldValue } from '@shared/contracts'
import { DatabaseValueEditor } from './DatabaseValueEditor'
import { useDatabaseDialogFocus } from '../hooks/useDatabaseDialogFocus'
import type { DatabaseWorkspaceText } from '../databaseText'

type RecordDraft = {
  title: string
  documentId: string
  fieldValues: Record<string, DocumentDatabaseFieldValue>
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
  onSave: (record: DatabaseRecord, draft: RecordDraft) => Promise<void>
}) {
  const drawerRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const [draft, setDraft] = useState<RecordDraft>({ title: '', documentId: '', fieldValues: {} })
  const propertyFields = useMemo(() => fields.filter((field) => field.role === 'property'), [fields])

  useEffect(() => {
    if (!record) return
    setDraft({
      title: record.title,
      documentId: record.documentId ?? '',
      fieldValues: Object.fromEntries(propertyFields.map((field) => [field.id, toDocumentValue(record.fieldValues[field.id])]))
    })
  }, [propertyFields, record])

  useDatabaseDialogFocus({ containerRef: drawerRef, initialFocusRef: closeRef, onClose, open })

  if (!open || !record) return null

  return (
    <>
      <button aria-label={text.close} className="dbw-drawer-scrim" onClick={onClose} type="button" />
      <aside aria-label={text.recordDetails} aria-modal="true" className="dbw-drawer dbw-record-drawer" ref={drawerRef} role="dialog" tabIndex={-1}>
        <header className="dbw-drawer-header">
          <div><p className="dbw-eyebrow">{text.recordDetails}</p><h2>{record.title}</h2></div>
          <button aria-label={text.close} className="dbw-icon-button" onClick={onClose} ref={closeRef} type="button">×</button>
        </header>
        <div className="dbw-record-form">
          <label><span>{text.title}</span><input className="dbw-record-title-input" onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} value={draft.title} /></label>
          <label>
            <span>{text.linkedDocument}</span>
            <select onChange={(event) => setDraft((current) => ({ ...current, documentId: event.target.value }))} value={draft.documentId}>
              <option value="">{text.noLinkedDocument}</option>
              {documents.map((document) => <option key={document.id} value={document.id}>{document.path}</option>)}
            </select>
          </label>
          {draft.documentId ? <button className="dbw-open-document-button" onClick={() => onOpenDocument(draft.documentId)} type="button">↗ {text.openDocument}</button> : null}
          <div className="dbw-record-properties">
            {propertyFields.map((field) => (
              <label key={field.id}>
                <span>{field.name}</span>
                <DatabaseValueEditor
                  column={{ id: field.id, name: field.name, type: field.type, options: field.options, sortOrder: field.sortOrder }}
                  onChangeValue={(value) => setDraft((current) => ({ ...current, fieldValues: { ...current.fieldValues, [field.id]: value } }))}
                  textCommitMode="change"
                  value={draft.fieldValues[field.id] ?? null}
                />
              </label>
            ))}
          </div>
        </div>
        <footer className="dbw-drawer-footer">
          <button className="dbw-danger-quiet-button" onClick={() => onDelete(record)} type="button">{text.deleteRecord}</button>
          <div><button className="dbw-quiet-button" onClick={onClose} type="button">{text.cancel}</button><button className="dbw-primary-button" disabled={!draft.title.trim()} onClick={() => void onSave(record, draft)} type="button">{text.save}</button></div>
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
  onCreate: (draft: RecordDraft, continueAdding: boolean) => Promise<void>
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const propertyFields = fields.filter((field) => field.role === 'property')
  const [draft, setDraft] = useState<RecordDraft>({ title: '', documentId: '', fieldValues: {} })
  useEffect(() => {
    if (!open) return
    setDraft({ title: '', documentId: '', fieldValues: {} })
  }, [open])
  useDatabaseDialogFocus({ containerRef: dialogRef, initialFocusRef: titleRef, onClose: onCancel, open })
  if (!open) return null

  const submit = async (continueAdding: boolean) => {
    if (!draft.title.trim()) return
    await onCreate(draft, continueAdding)
    if (continueAdding) setDraft({ title: '', documentId: '', fieldValues: {} })
  }

  return (
    <div className="dbw-modal-layer">
      <button aria-label={text.close} className="dbw-modal-scrim" onClick={onCancel} type="button" />
      <div aria-label={text.createRecord} aria-modal="true" className="dbw-dialog dbw-create-record-dialog" ref={dialogRef} role="dialog" tabIndex={-1}>
        <header><h2>{text.createRecord}</h2><button aria-label={text.close} className="dbw-icon-button" onClick={onCancel} type="button">×</button></header>
        <div className="dbw-record-form">
          <label><span>{text.title} *</span><input onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} ref={titleRef} value={draft.title} /></label>
          <label><span>{text.linkedDocument}</span><select onChange={(event) => setDraft((current) => ({ ...current, documentId: event.target.value }))} value={draft.documentId}><option value="">{text.noLinkedDocument}</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.path}</option>)}</select></label>
          {propertyFields.map((field) => (
            <label key={field.id}><span>{field.name}</span><DatabaseValueEditor column={{ id: field.id, name: field.name, type: field.type, options: field.options, sortOrder: field.sortOrder }} onChangeValue={(value) => setDraft((current) => ({ ...current, fieldValues: { ...current.fieldValues, [field.id]: value } }))} textCommitMode="change" value={draft.fieldValues[field.id] ?? null} /></label>
          ))}
        </div>
        <footer><button className="dbw-quiet-button" disabled={!draft.title.trim()} onClick={() => void submit(true)} type="button">{text.createAndContinue}</button><button className="dbw-primary-button" disabled={!draft.title.trim()} onClick={() => void submit(false)} type="button">{text.create}</button></footer>
      </div>
    </div>
  )
}

function toDocumentValue(value: unknown): DocumentDatabaseFieldValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return null
}
