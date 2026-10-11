import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RenameTitleResult } from '../hooks/useDocumentEditorState'
import type { DocumentRenameOpening } from '../pages/documentRenameOpening'
import { useDialogActionFocus } from '../hooks/useDialogActionFocus'
import { useDialogCloseFocus } from '../hooks/useDialogCloseFocus'
import { trapFocusWithinDialog } from '../utils/dialogFocus'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { getErrorMessage } from '../utils/errorMessage'
import './document-capture.css'
import './document-rename.css'

export default function DocumentRenameDialog({ opening, isZh, onRename }: {
  opening: DocumentRenameOpening
  isZh: boolean
  onRename: (name: string) => Promise<RenameTitleResult>
}) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null)
  const mounted = useRef(false), lock = useRef(false), composing = useRef(false)
  const [name, setName] = useState(opening.target.title), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const labelId = useId(), hintId = useId(), formId = useId()
  const actionFocus = useDialogActionFocus(dialog), trackCloseFocus = useDialogCloseFocus()
  useEffect(() => {
    if (!opening.claim()) { opening.invalidate(); return }
    mounted.current = true
    const element = dialog.current!
    element.showModal()
    input.current?.focus({ preventScroll: true })
    input.current?.select()
    const closeDialog = trackCloseFocus(element, opening.opener, opening.canReturnFocus)
    return () => { mounted.current = false; closeDialog() }
  }, [opening, trackCloseFocus])

  const close = () => { if (!lock.current && !composing.current) opening.close() }
  const rename = async () => {
    if (lock.current || composing.current || !opening.isCurrent()) return
    const value = name.trim()
    if (!value) { setError(isZh ? '请输入文档名称。' : 'Enter a document name.'); input.current?.focus(); return }
    if (value === opening.target.title.trim()) { opening.close(); return }
    const operation = actionFocus.begin()
    if (!operation) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const result = await onRename(value)
      if (!mounted.current || !actionFocus.isCurrent(operation) || !opening.isCurrent()) return
      if (result.status === 'saved') { actionFocus.cancel(operation); opening.saved() }
      else if (result.status === 'stale') { actionFocus.cancel(operation); opening.invalidate() }
      else setError(result.status === 'failed' ? result.message : isZh ? '文档正在保存，请稍后重试。' : 'The document is saving. Try again shortly.')
    } catch (cause) {
      if (mounted.current && actionFocus.isCurrent(operation) && opening.isCurrent()) {
        setError(getErrorMessage(cause, isZh ? '重命名失败，输入已保留，请重试。' : 'Could not rename the document. Your input is preserved. Please retry.'))
      }
    } finally {
      if (mounted.current && actionFocus.isCurrent(operation) && opening.isCurrent()) {
        lock.current = false
        setBusy(false)
        actionFocus.restore(operation, () => input.current)
      }
    }
  }
  return createPortal(<dialog ref={dialog} data-block-shortcuts className="document-capture-dialog document-rename-dialog"
    aria-labelledby={labelId} aria-describedby={hintId} aria-busy={busy} tabIndex={-1}
    onCancel={event => { event.preventDefault(); close() }}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
    onKeyDown={event => {
      event.stopPropagation()
      if (isImeKeyboardEvent(event.nativeEvent, composing.current)) {
        if (event.key === 'Escape' || event.key === 'Enter') event.preventDefault()
        return
      }
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (lock.current && event.key === 'Tab') { event.preventDefault(); event.currentTarget.focus(); return }
      trapFocusWithinDialog(event.nativeEvent, event.currentTarget)
    }}>
    <header className="document-capture-header"><div><h2 id={labelId}>{isZh ? '重命名文档' : 'Rename document'}</h2>
      <p id={hintId}>{isZh ? '正文和摘要保持原样。' : 'Your document content and summary are kept.'}</p></div></header>
    <form id={formId} className="document-capture-body" onSubmit={event => { event.preventDefault(); void rename() }}>
      <fieldset disabled={busy}><label className="document-capture-field">{isZh ? '文档名称' : 'Document name'}
        <input ref={input} value={name} required onChange={event => { setName(event.target.value); setError('') }} />
      </label></fieldset>
      {error && <p className="document-capture-error" role="alert">{error}</p>}
    </form>
    <footer className="document-capture-footer"><span role="status">{busy ? (isZh ? '正在重命名…' : 'Renaming…') : ''}</span>
      <button type="button" className="secondary-button" disabled={busy} onClick={close}>{isZh ? '取消' : 'Cancel'}</button>
      <button type="submit" form={formId} className="primary-button" disabled={busy || !name.trim()}>{isZh ? '重命名' : 'Rename'}</button>
    </footer>
  </dialog>, document.body)
}
