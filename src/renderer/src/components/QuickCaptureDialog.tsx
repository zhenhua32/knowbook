import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CreateQuickNoteInput, DocumentTreeNode } from '@shared/contracts'
import { trapFocusWithinDialog } from '../utils/dialogFocus'
import { getErrorMessage } from '../utils/errorMessage'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
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
  const dialog = useRef<HTMLDialogElement>(null), contentInput = useRef<HTMLTextAreaElement>(null)
  const mounted = useRef(false), lock = useRef(false), composing = useRef(false)
  const [content, setContent] = useState(''), [title, setTitle] = useState(''), [parentId, setParentId] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const labelId = useId(), hintId = useId(), formId = useId(), keyboardHintId = useId()
  const parents = useMemo(() => flattenTree(documentTree), [documentTree])

  useEffect(() => {
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
    setBusy(true)
    setError('')
    dialog.current?.focus()
    try {
      await onSave({ content, title: title.trim() || undefined, parentId: parentId || null })
      if (mounted.current) onClose()
    } catch (cause) {
      if (mounted.current) setError(getErrorMessage(cause, isZh ? '保存记录失败，内容已保留，请重试。' : 'Could not save the note. Your content is preserved. Please retry.'))
    } finally {
      lock.current = false
      if (mounted.current) {
        setBusy(false)
        window.requestAnimationFrame(() => { if (mounted.current) contentInput.current?.focus() })
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
    <form id={formId} className="document-capture-body" onSubmit={event => { event.preventDefault(); void save() }}><fieldset disabled={busy}>
      <label className="document-capture-field">{isZh ? '正文' : 'Content'}<textarea ref={contentInput} className="document-quick-capture-content" value={content} required rows={9}
        aria-describedby={keyboardHintId} onChange={event => { setContent(event.target.value); setError('') }} placeholder={isZh ? '记录灵感、待办或一段 Markdown…' : 'Capture an idea, a task, or some Markdown…'} /></label>
      <div className="document-capture-fields-row"><label className="document-capture-field">{isZh ? '文档标题（可选）' : 'Document title (optional)'}<input value={title}
        onChange={event => { setTitle(event.target.value); setError('') }} placeholder={isZh ? '留空自动生成标题' : 'Leave blank for an automatic title'} /></label>
        <label className="document-capture-field">{isZh ? '父目录' : 'Parent folder'}<select value={parentId} onChange={event => { setParentId(event.target.value); setError('') }}>
          <option value="">{isZh ? '根目录' : 'Workspace root'}</option>{parents.map(parent => <option key={parent.id} value={parent.id}>{parent.path}</option>)}</select></label></div>
    </fieldset>
      {error && <p className="document-capture-error" role="alert">{error}</p>}
    </form>
    <footer className="document-capture-footer"><span id={keyboardHintId} role="status">{busy ? (isZh ? '正在保存记录…' : 'Saving note…') : <><kbd>Ctrl / ⌘ Enter</kbd> {isZh ? '保存记录' : 'Save note'}</>}</span>
      <button type="submit" form={formId} className="primary-button" disabled={busy || !content.trim()}>{isZh ? '保存记录' : 'Save note'}</button></footer>
  </dialog>, document.body)
}
