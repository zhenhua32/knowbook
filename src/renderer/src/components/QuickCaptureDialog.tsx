import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CreateQuickNoteInput, DocumentTreeNode } from '@shared/contracts'
import { trapFocusWithinDialog } from '../utils/dialogFocus'
import { getErrorMessage } from '../utils/errorMessage'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { useDialogActionFocus } from '../hooks/useDialogActionFocus'
import './document-capture.css'

type Props = {
  isZh: boolean
  documentTree: DocumentTreeNode[]
  onClose: () => void
  onSave: (input: CreateQuickNoteInput) => Promise<void>
}

function flattenTree(nodes: DocumentTreeNode[]): DocumentTreeNode[] {
  const result: DocumentTreeNode[] = [], pending = [...nodes].reverse()
  while (pending.length) {
    const node = pending.pop()!
    result.push(node)
    for (let index = node.children.length - 1; index >= 0; index--) pending.push(node.children[index])
  }
  return result
}

export default function QuickCaptureDialog({ isZh, documentTree, onClose, onSave }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), body = useRef<HTMLFormElement>(null), contentInput = useRef<HTMLTextAreaElement>(null)
  const adjustBodyLayout = useRef<(() => void) | null>(null)
  const mounted = useRef(false), lock = useRef(false), composing = useRef(false)
  const [content, setContent] = useState(''), [title, setTitle] = useState(''), [parentId, setParentId] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const labelId = useId(), hintId = useId(), formId = useId(), keyboardHintId = useId()
  const parents = useMemo(() => flattenTree(documentTree), [documentTree])
  const actionFocus = useDialogActionFocus(dialog)

  useLayoutEffect(() => {
    mounted.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current!
    element.showModal()
    contentInput.current?.focus()
    return () => {
      mounted.current = false
      element.close()
      const restore = () => { if (previous?.isConnected && !previous.matches(':disabled')) previous.focus({ preventScroll: true }) }
      restore()
      if (previous?.matches(':disabled')) window.requestAnimationFrame(restore)
    }
  }, [])
  useLayoutEffect(() => {
    const fields = body.current, content = contentInput.current
    if (!fields || !content || !window.ResizeObserver) return
    let observing = true, frame: number | null = null, requestedField: HTMLElement | null = null
    const visible = (element: HTMLElement) => {
      if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length) return false
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    const measure = () => {
      if (!observing || !visible(fields) || fields.clientHeight <= 0) return
      const style = window.getComputedStyle(content)
      // Reserve the existing 2px outline and 3px offset even when the textarea is not focused.
      const outline = Math.max(5, (Number.parseFloat(style.outlineWidth) || 0) + (Number.parseFloat(style.outlineOffset) || 0))
      const limit = `${Math.max(0, Math.floor(fields.clientHeight - outline * 2))}px`
      if (fields.style.getPropertyValue('--quick-capture-content-limit') !== limit) fields.style.setProperty('--quick-capture-content-limit', limit)
    }
    const reveal = (field: HTMLElement | null) => {
      if (!observing || !field || document.activeElement !== field || !document.hasFocus() || !visible(fields)
        || !fields.contains(field) || !field.matches('input, textarea, select') || !visible(field)) return
      if ([...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [role="alertdialog"]')]
        .some(element => element !== dialog.current && !element.contains(fields) && visible(element))) return
      const bounds = fields.getBoundingClientRect(), top = bounds.top + fields.clientTop
      const bottom = Math.min(bounds.bottom, top + fields.clientHeight), fieldBounds = field.getBoundingClientRect()
      if (fieldBounds.height > bottom - top || bottom <= top) return
      const style = window.getComputedStyle(field)
      const outline = Math.min(Math.max(0, (Number.parseFloat(style.outlineWidth) || 0) + (Number.parseFloat(style.outlineOffset) || 0)),
        (bottom - top - fieldBounds.height) / 2)
      if (fieldBounds.top - outline < top) fields.scrollTop -= Math.ceil(top - fieldBounds.top + outline)
      else if (fieldBounds.bottom + outline > bottom) fields.scrollTop += Math.ceil(fieldBounds.bottom + outline - bottom)
    }
    const schedule = () => {
      if (!observing) return
      requestedField = document.activeElement instanceof HTMLElement && fields.contains(document.activeElement) ? document.activeElement : null
      if (frame !== null) return
      // Intrinsic dialog height can change after updating the limit; write outside the observer delivery.
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (!observing) return
        measure()
        reveal(requestedField)
      })
    }
    const adjust = () => {
      measure()
      reveal(document.activeElement instanceof HTMLElement ? document.activeElement : null)
    }
    adjustBodyLayout.current = adjust
    measure()
    const observer = new window.ResizeObserver(schedule)
    observer.observe(fields)
    observer.observe(content)
    fields.addEventListener('focusin', schedule)
    schedule()
    return () => {
      observing = false
      if (adjustBodyLayout.current === adjust) adjustBodyLayout.current = null
      observer.disconnect()
      fields.removeEventListener('focusin', schedule)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [])
  // Error and busy changes alter the available space before a deferred observer delivery.
  useLayoutEffect(() => { adjustBodyLayout.current?.() }, [busy, error, isZh])
  useEffect(() => {
    if (parentId && !parents.some(parent => parent.id === parentId)) setParentId('')
  }, [parentId, parents])

  const close = () => { if (!lock.current && !composing.current) onClose() }
  const save = async () => {
    if (lock.current || composing.current) return
    if (!content.trim()) {
      setError(isZh ? '请先输入要记录的内容。' : 'Enter the content you want to capture.')
      contentInput.current?.focus()
      return
    }
    lock.current = true
    const operation = actionFocus.begin()
    if (!operation) { lock.current = false; return }
    setBusy(true)
    setError('')
    try {
      await onSave({ content, title: title.trim() || undefined, parentId: parentId || null })
      if (mounted.current && actionFocus.isCurrent(operation)) { actionFocus.cancel(operation); onClose() }
    } catch (cause) {
      if (mounted.current && actionFocus.isCurrent(operation)) setError(getErrorMessage(cause, isZh ? '保存记录失败，内容已保留，请重试。' : 'Could not save the note. Your content is preserved. Please retry.'))
    } finally {
      if (mounted.current && actionFocus.isCurrent(operation)) {
        lock.current = false
        setBusy(false)
        actionFocus.restore(operation, () => contentInput.current, () => adjustBodyLayout.current?.())
      }
    }
  }

  return createPortal(<dialog ref={dialog} data-block-shortcuts className="document-capture-dialog document-quick-capture-dialog"
    aria-labelledby={labelId} aria-describedby={hintId} aria-busy={busy} tabIndex={-1}
    onCancel={event => { event.preventDefault(); close() }}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
    onKeyDown={event => {
      event.stopPropagation()
      if (isImeKeyboardEvent(event.nativeEvent, composing.current)) { if (event.key === 'Escape') event.preventDefault(); return }
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === 'Enter') { event.preventDefault(); void save() }
      if (lock.current && event.key === 'Tab') { event.preventDefault(); event.currentTarget.focus(); return }
      trapFocusWithinDialog(event.nativeEvent, event.currentTarget)
    }}>
    <header className="document-capture-header"><div><h2 id={labelId}>{isZh ? '快速记录' : 'Quick capture'}</h2>
      <p id={hintId}>{isZh ? '先记下想法，再保存成文档。标题可留空，默认放在根目录。' : 'Write down an idea, then save it as a document. The title is optional, and the default location is the workspace root.'}</p></div>
      <button type="button" className="secondary-button" disabled={busy} onClick={close}>{isZh ? '取消' : 'Cancel'}</button></header>
    <form ref={body} id={formId} className="document-capture-body" onSubmit={event => { event.preventDefault(); void save() }}><fieldset disabled={busy}>
      <label className="document-capture-field">{isZh ? '正文' : 'Content'}<textarea ref={contentInput} className="document-quick-capture-content" value={content} required rows={9}
        aria-describedby={keyboardHintId} onChange={event => { setContent(event.target.value); setError('') }} placeholder={isZh ? '记录灵感、待办或一段 Markdown…' : 'Capture an idea, a task, or some Markdown…'} /></label>
      <div className="document-capture-fields-row"><label className="document-capture-field">{isZh ? '文档标题（可选）' : 'Document title (optional)'}<input value={title}
        onChange={event => { setTitle(event.target.value); setError('') }} placeholder={isZh ? '留空自动生成标题' : 'Leave blank for an automatic title'} /></label>
        <label className="document-capture-field">{isZh ? '父目录' : 'Parent folder'}<select value={parentId} onChange={event => { setParentId(event.target.value); setError('') }}>
          <option value="">{isZh ? '根目录' : 'Workspace root'}</option>{parents.map(parent => <option key={parent.id} value={parent.id}>{parent.path}</option>)}</select></label></div>
    </fieldset></form>
    {error && <p className="document-capture-error" role="alert">{error}</p>}
    <footer className="document-capture-footer"><span id={keyboardHintId} role="status">{busy ? (isZh ? '正在保存记录…' : 'Saving note…') : <><kbd>Ctrl / ⌘ Enter</kbd> {isZh ? '保存记录' : 'Save note'}</>}</span>
      <button type="submit" form={formId} className="primary-button" disabled={busy || !content.trim()}>{isZh ? '保存记录' : 'Save note'}</button></footer>
  </dialog>, document.body)
}
