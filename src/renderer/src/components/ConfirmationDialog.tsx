import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { getActiveUiText } from '../i18n'
import { getErrorMessage } from '../utils/errorMessage'
import { trapFocusWithinDialog } from '../utils/dialogFocus'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'

export type ConfirmationOptions = {
  title: string
  description: string
  confirmLabel?: string
  tone?: 'danger' | 'warning'
  note?: string
  children?: ReactNode
  onConfirm: () => void | Promise<void>
}

export function ConfirmationDialog({ title, description, confirmLabel = title, tone = 'danger', note, children,
  onConfirm, onCancel, onComplete = onCancel, returnFocus,
}: ConfirmationOptions & { onCancel: () => void; onComplete?: () => void; returnFocus?: HTMLElement | null }) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null)
  const lock = useRef(false), mounted = useRef(false), composing = useRef(false)
  const dismiss = useRef(onCancel)
  dismiss.current = onCancel
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const titleId = useId(), descriptionId = useId(), noteId = useId()
  const zh = getActiveUiText().language === 'zh-CN'

  useEffect(() => {
    mounted.current = true
    const previous = returnFocus === undefined ? document.activeElement as HTMLElement | null : returnFocus
    const element = dialog.current!
    element.showModal()
    cancel.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (!element.open) return
      if (isImeKeyboardEvent(event, composing.current)) {
        if (event.key === 'Escape') event.preventDefault()
        event.stopPropagation()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!lock.current) dismiss.current()
      }
      trapFocusWithinDialog(event, element)
      // Keep application/editor shortcuts from changing the action's target.
      event.stopPropagation()
    }
    window.addEventListener('keydown', keydown, true)
    return () => {
      mounted.current = false
      window.removeEventListener('keydown', keydown, true)
      element.close()
      const restore = () => {
        if (previous?.isConnected && !previous.matches(':disabled')) previous.focus({ preventScroll: true })
      }
      restore()
      // The opener can remain disabled until the awaiting action has settled.
      if (previous?.matches(':disabled')) window.requestAnimationFrame?.(restore)
    }
  }, [returnFocus])

  useEffect(() => { if (!busy) cancel.current?.focus() }, [busy])

  const execute = async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    dialog.current?.focus()
    try { await onConfirm(); if (mounted.current) onComplete() }
    catch (cause) {
      if (mounted.current) setError(getErrorMessage(cause, zh ? '操作失败，请重试。' : 'Action failed. Please retry.'))
    } finally {
      lock.current = false
      if (mounted.current) { setBusy(false); cancel.current?.focus() }
    }
  }

  return createPortal(<dialog data-block-shortcuts ref={dialog} className={`app-confirm-dialog app-confirm-${tone}`} role="alertdialog" aria-modal="true"
    aria-labelledby={titleId} aria-describedby={`${descriptionId}${note ? ` ${noteId}` : ''}`} aria-busy={busy} tabIndex={-1}
    onCancel={(event) => { event.preventDefault(); if (!lock.current && !composing.current) onCancel() }}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}>
    <header><span className="app-confirm-icon" aria-hidden="true">!</span><h2 id={titleId}>{title}</h2></header>
    <div className="app-confirm-body">
      <p id={descriptionId}>{description}</p>
      {children && <fieldset disabled={busy}>{children}</fieldset>}
      {note && <p id={noteId} className="app-confirm-note">{note}</p>}
      {error && <p className="app-confirm-error" role="alert">{error}</p>}
    </div>
    <footer><span role="status">{busy ? (zh ? '正在处理，请稍候…' : 'Working, please wait…') : ''}</span>
      <div><button type="button" className="secondary-button" ref={cancel} disabled={busy} onClick={onCancel}>{zh ? '取消' : 'Cancel'}</button>
        <button type="button" className={tone === 'danger' ? 'danger-button' : 'primary-button'} disabled={busy} onClick={() => { void execute() }}>
          {error ? (zh ? '重试' : 'Retry') : confirmLabel}</button></div></footer>
  </dialog>, document.body)
}
