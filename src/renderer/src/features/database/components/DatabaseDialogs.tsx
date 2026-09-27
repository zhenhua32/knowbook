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
      <form aria-modal="true" className="dbw-dialog" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onSubmit() }} ref={dialogRef} role="dialog" tabIndex={-1}>
        <header><h2>{title}</h2><button aria-label={text.close} className="dbw-icon-button" onClick={onCancel} type="button">×</button></header>
        <label><span>{text.name}</span><input onChange={(event) => onNameChange(event.target.value)} ref={inputRef} value={name} /></label>
        {withDescription ? <label><span>{text.description}</span><textarea onChange={(event) => onDescriptionChange(event.target.value)} rows={3} value={description} /></label> : null}
        <footer><button className="dbw-quiet-button" onClick={onCancel} type="button">{text.cancel}</button><button className="dbw-primary-button" disabled={!name.trim()} type="submit">{submitLabel ?? text.save}</button></footer>
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
