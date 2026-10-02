import { useRef } from 'react'
import { useDatabaseDialogFocus } from '../hooks/useDatabaseDialogFocus'
import type { DatabaseWorkspaceText } from '../databaseText'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import '../../../components/confirmation-dialog.css'

export function DatabaseFormDialog({
  description,
  name,
  open,
  text,
  title,
  submitLabel,
  busy = false,
  blocked = false,
  pendingLabel,
  error,
  withDescription = false,
  onCancel,
  onDescriptionChange,
  onNameChange,
  onSubmit
}: {
  description: string
  name: string
  open: boolean
  text: DatabaseWorkspaceText
  title: string
  submitLabel?: string
  busy?: boolean
  blocked?: boolean
  pendingLabel?: string
  error?: string | null
  withDescription?: boolean
  onCancel: () => void
  onDescriptionChange: (value: string) => void
  onNameChange: (value: string) => void
  onSubmit: () => void
}) {
  const dialogRef = useRef<HTMLFormElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  useDatabaseDialogFocus({ containerRef: dialogRef, initialFocusRef: inputRef, onClose: onCancel, open })
  if (!open) return null

  return (
    <div className="dbw-modal-layer" role="presentation">
      <button aria-label={text.close} className="dbw-modal-scrim" onClick={onCancel} type="button" />
      <form aria-modal="true" className="dbw-dialog" onSubmit={(event) => { event.preventDefault(); if (!busy && !blocked && name.trim()) onSubmit() }} ref={dialogRef} role="dialog" tabIndex={-1}>
        <header><h2>{title}</h2><button aria-label={text.close} className="dbw-icon-button" onClick={onCancel} type="button">×</button></header>
        <label><span>{text.name}</span><input onChange={(event) => { if (!busy) onNameChange(event.target.value) }} readOnly={busy} ref={inputRef} value={name} /></label>
        {withDescription ? <label><span>{text.description}</span><textarea onChange={(event) => { if (!busy) onDescriptionChange(event.target.value) }} readOnly={busy} rows={3} value={description} /></label> : null}
        {busy || blocked ? <p className="dbw-view-form-notice" role="status">{busy ? text.viewOperationContinues : text.viewRenameWaitsForSave}</p> : null}
        {error ? <p className="dbw-record-submit-error" role="alert">{error}</p> : null}
        <footer><button className="dbw-quiet-button" onClick={onCancel} type="button">{busy ? text.close : text.cancel}</button><button aria-busy={busy || blocked} aria-disabled={busy || blocked || !name.trim()} className="dbw-primary-button" disabled={!name.trim() && !busy} type="submit">{busy ? pendingLabel ?? text.saving : blocked ? text.waitingForSave : submitLabel ?? text.save}</button></footer>
      </form>
    </div>
  )
}

export function DatabaseConfirmDialog({
  body,
  confirmLabel,
  open,
  text,
  title,
  onCancel,
  onConfirm
}: {
  body: string
  confirmLabel: string
  open: boolean
  text: DatabaseWorkspaceText
  title: string
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}) {
  if (!open) return null
  return <ConfirmationDialog title={title} description={body} note={text.dangerCannotUndo} confirmLabel={confirmLabel}
    onCancel={onCancel} onConfirm={onConfirm} />
}
