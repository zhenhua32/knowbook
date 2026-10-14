import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DocumentTreeNode } from '@shared/contracts'
import { useDialogActionFocus } from '../hooks/useDialogActionFocus'
import { useDialogCloseFocus } from '../hooks/useDialogCloseFocus'
import { trapFocusWithinDialog } from '../utils/dialogFocus'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { getErrorMessage } from '../utils/errorMessage'
import './document-capture.css'
import './document-block-move.css'

export type DocumentBlockMoveDialogProps = {
  isZh: boolean
  sourceDocumentId: string
  sourceDocumentTitle: string
  selectedBlockCount: number
  documents: DocumentTreeNode[]
  busy: boolean
  error?: string | null
  onClose: () => void
  onMove: (targetDocumentId: string) => Promise<boolean> | boolean
  opener?: HTMLElement | null
  canOpen?: () => boolean
  canReturnFocus?: () => boolean
}

function flattenDocuments(nodes: DocumentTreeNode[]): DocumentTreeNode[] {
  return nodes.flatMap(node => [node, ...flattenDocuments(node.children)])
}

export default function DocumentBlockMoveDialog(props: DocumentBlockMoveDialogProps) {
  const { isZh, sourceDocumentId, sourceDocumentTitle, selectedBlockCount, documents, busy, error, onMove } = props
  const currentProps = useRef(props)
  currentProps.current = props
  const dialog = useRef<HTMLDialogElement>(null), search = useRef<HTMLInputElement>(null)
  const selectedControl = useRef<HTMLInputElement | null>(null)
  const mounted = useRef(false), submittingLock = useRef(false), composing = useRef(false)
  const [query, setQuery] = useState(''), [targetId, setTargetId] = useState('')
  const [submitting, setSubmitting] = useState(false), [localError, setLocalError] = useState('')
  const labelId = useId(), hintId = useId(), formId = useId(), destinationsId = useId()
  const actionFocus = useDialogActionFocus(dialog), trackCloseFocus = useDialogCloseFocus()
  const available = useMemo(() => flattenDocuments(documents).filter(node => node.id !== sourceDocumentId), [documents, sourceDocumentId])
  const matches = useMemo(() => {
    const filter = query.trim().toLocaleLowerCase()
    return available.filter(node => !filter || `${node.title}\n${node.path}`.toLocaleLowerCase().includes(filter))
  }, [available, query])
  const target = available.find(node => node.id === targetId)
  const disabled = busy || submitting

  useEffect(() => {
    const opening = currentProps.current
    if (opening.canOpen && !opening.canOpen()) { opening.onClose(); return }
    mounted.current = true
    const element = dialog.current!
    const opener = opening.opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    element.showModal()
    search.current?.focus({ preventScroll: true })
    const closeDialog = trackCloseFocus(element, opener, () => currentProps.current.canReturnFocus?.() ?? true)
    return () => { mounted.current = false; closeDialog() }
  }, [trackCloseFocus])

  const close = () => {
    if (!submittingLock.current && !currentProps.current.busy && !composing.current) currentProps.current.onClose()
  }
  const move = async () => {
    if (submittingLock.current || currentProps.current.busy || composing.current || !target) return
    const operation = actionFocus.begin()
    if (!operation) return
    submittingLock.current = true
    setSubmitting(true)
    setLocalError('')
    try {
      const completed = await onMove(target.id)
      if (!mounted.current || !actionFocus.isCurrent(operation)) return
      if (completed) { actionFocus.cancel(operation); currentProps.current.onClose() }
    } catch (cause) {
      if (mounted.current && actionFocus.isCurrent(operation)) {
        setLocalError(getErrorMessage(cause, isZh ? '移动失败，请重试。' : 'Could not move the blocks. Please retry.'))
      }
    } finally {
      if (mounted.current && actionFocus.isCurrent(operation)) {
        submittingLock.current = false
        setSubmitting(false)
        actionFocus.restore(operation, () => selectedControl.current ?? search.current)
      }
    }
  }

  return createPortal(<dialog ref={dialog} data-block-shortcuts
    className="document-capture-dialog document-block-move-dialog" aria-labelledby={labelId}
    aria-describedby={hintId} aria-busy={disabled} tabIndex={-1}
    onCancel={event => { event.preventDefault(); close() }}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
    onKeyDown={event => {
      event.stopPropagation()
      if (isImeKeyboardEvent(event.nativeEvent, composing.current)) {
        if (event.key === 'Escape' || event.key === 'Enter') event.preventDefault()
        return
      }
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (disabled && event.key === 'Tab') { event.preventDefault(); event.currentTarget.focus(); return }
      trapFocusWithinDialog(event.nativeEvent, event.currentTarget)
    }}>
    <header className="document-capture-header"><div><h2 id={labelId}>{isZh ? '移动内容块' : 'Move blocks'}</h2>
      <p id={hintId}>{isZh ? `将「${sourceDocumentTitle}」中的 ${selectedBlockCount} 个内容块移动到目标文档末尾。` : `Move ${selectedBlockCount} block${selectedBlockCount === 1 ? '' : 's'} from “${sourceDocumentTitle}” to the end of the destination document.`}</p>
    </div></header>
    <form id={formId} className="document-capture-body" onSubmit={event => { event.preventDefault(); void move() }}>
      <fieldset disabled={disabled}>
        <label className="document-capture-field">{isZh ? '查找目标文档' : 'Find a destination document'}
          <input ref={search} value={query} onChange={event => { setQuery(event.target.value); setLocalError('') }}
            placeholder={isZh ? '搜索名称或路径…' : 'Search name or path…'} autoComplete="off" />
        </label>
        <div className="document-block-move-destinations" role="group" aria-labelledby={destinationsId}>
          <p id={destinationsId} className="document-block-move-label">{isZh ? '目标文档' : 'Destination document'}</p>
          {matches.map(node => <label key={node.id} className={`document-block-move-option${node.id === targetId ? ' document-block-move-option-selected' : ''}`}>
            <input ref={element => { if (node.id === targetId) selectedControl.current = element }} type="radio" name="block-move-destination"
              value={node.id} checked={node.id === targetId} onChange={() => { setTargetId(node.id); setLocalError('') }} />
            <span><strong>{node.title}</strong><small>{node.path}</small></span>
          </label>)}
          {!matches.length ? <p className="mini-hint" role="status">{available.length ? (isZh ? '没有匹配的文档。' : 'No matching documents.') : (isZh ? '请先创建另一个文档。' : 'Create another document first.')}</p> : null}
        </div>
      </fieldset>
      {target ? <p className="document-capture-hint">{isZh ? '将移动到：' : 'Move to: '}{target.path}</p> : null}
      {localError || error ? <p className="document-capture-error" role="alert">{localError || error}</p> : null}
    </form>
    <footer className="document-capture-footer"><span role="status">{disabled ? (isZh ? '正在移动…' : 'Moving…') : ''}</span>
      <button type="button" className="secondary-button" disabled={disabled} onClick={close}>{isZh ? '取消' : 'Cancel'}</button>
      <button type="submit" form={formId} className="primary-button" disabled={disabled || !target}>{isZh ? '移动' : 'Move'}</button>
    </footer>
  </dialog>, document.body)
}
