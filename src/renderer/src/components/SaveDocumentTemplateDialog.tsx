import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DocumentBlockDraft } from '@shared/contracts'
import { trapFocusWithinDialog } from '../utils/dialogFocus'
import { getErrorMessage } from '../utils/errorMessage'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import './document-capture.css'

type Props = {
  isZh: boolean
  source: { title: string; summary: string; blocks: DocumentBlockDraft[] }
  onClose: () => void
  onSaved: () => void
}

export default function SaveDocumentTemplateDialog({ isZh, source, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), nameInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(false), lock = useRef(false), composing = useRef(false)
  const [name, setName] = useState(source.title), [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const labelId = useId(), hintId = useId(), variablesId = useId(), formId = useId()

  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current!
    element.showModal()
    nameInput.current?.focus()
    nameInput.current?.select()
    return () => {
      mounted.current = false
      element.close()
      const restore = () => { if (previous?.isConnected && !previous.matches(':disabled')) previous.focus({ preventScroll: true }) }
      restore()
      if (previous?.matches(':disabled')) window.requestAnimationFrame(restore)
    }
  }, [])

  const close = () => { if (!lock.current && !composing.current) onClose() }
  const save = async () => {
    if (lock.current || composing.current) return
    if (!name.trim()) {
      setError(isZh ? '请输入模板名称。' : 'Enter a template name.')
      nameInput.current?.focus()
      return
    }
    lock.current = true
    setBusy(true)
    setError('')
    dialog.current?.focus()
    try {
      await window.knowbook.saveDocumentTemplate({ ...source, name: name.trim(), description: description.trim() })
      if (mounted.current) { onSaved(); onClose() }
    } catch (cause) {
      if (mounted.current) setError(getErrorMessage(cause, isZh ? '保存模板失败，输入已保留，请重试。' : 'Could not save the template. Your input is preserved. Please retry.'))
    } finally {
      lock.current = false
      if (mounted.current) {
        setBusy(false)
        window.requestAnimationFrame(() => { if (mounted.current) nameInput.current?.focus() })
      }
    }
  }

  return createPortal(<dialog ref={dialog} data-block-shortcuts className="document-capture-dialog document-save-template-dialog"
    aria-labelledby={labelId} aria-describedby={hintId} aria-busy={busy} tabIndex={-1}
    onCancel={event => { event.preventDefault(); close() }}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
    onKeyDown={event => {
      event.stopPropagation()
      if (isImeKeyboardEvent(event.nativeEvent, composing.current)) { if (event.key === 'Escape') event.preventDefault(); return }
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (lock.current && event.key === 'Tab') { event.preventDefault(); event.currentTarget.focus(); return }
      trapFocusWithinDialog(event.nativeEvent, event.currentTarget)
    }}>
    <header className="document-capture-header"><div><h2 id={labelId}>{isZh ? '保存为模板' : 'Save as template'}</h2>
      <p id={hintId}>{isZh ? '按当前草稿保存标题、摘要和正文，不必先保存文档。' : 'Save the title, summary, and body from the current draft. You do not need to save the document first.'}</p></div>
      <button type="button" className="secondary-button" disabled={busy} onClick={close}>{isZh ? '取消' : 'Cancel'}</button></header>
    <form id={formId} className="document-capture-body" onSubmit={event => { event.preventDefault(); void save() }}><fieldset disabled={busy}>
      <label className="document-capture-field">{isZh ? '模板名称' : 'Template name'}<input ref={nameInput} value={name} required
        onChange={event => { setName(event.target.value); setError('') }} placeholder={isZh ? '例如：每周复盘' : 'For example: Weekly review'} /></label>
      <label className="document-capture-field">{isZh ? '模板说明（可选）' : 'Template description (optional)'}<textarea value={description} rows={3}
        onChange={event => { setDescription(event.target.value); setError('') }} placeholder={isZh ? '说明何时使用这个模板' : 'Describe when to use this template'} /></label>
    </fieldset>
      <div className="document-capture-source"><strong>{isZh ? '当前草稿' : 'Current draft'}</strong><span>{source.title || (isZh ? '未命名文档' : 'Untitled document')}</span>
        <small>{isZh ? `${source.blocks.length} 个内容块` : `${source.blocks.length} content blocks`}</small></div>
      <p id={variablesId} className="document-capture-hint">{isZh ? '在文档标题、摘要或正文中使用 {{date}} 和 {{title}}，从模板新建时会替换为当天日期和新文档标题。' : 'Use {{date}} and {{title}} in the title, summary, or body. They are filled with today’s date and the new document title when creating a document.'}</p>
      {error && <p className="document-capture-error" role="alert">{error}</p>}
    </form>
    <footer className="document-capture-footer"><span role="status">{busy ? (isZh ? '正在保存模板…' : 'Saving template…') : (isZh ? '模板会保存在本地知识库中。' : 'The template is saved in your local knowledge base.')}</span>
      <button type="submit" form={formId} className="primary-button" disabled={busy || !name.trim()}>{isZh ? '保存模板' : 'Save template'}</button></footer>
  </dialog>, document.body)
}
