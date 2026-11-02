import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { StructureCommandView, SyncedStructureCommands } from './structureCommands'
import { useDialogCloseFocus } from '../../hooks/useDialogCloseFocus'
import { trapFocusWithinDialog } from '../../utils/dialogFocus'
import { isImeKeyboardEvent } from '../../utils/imeKeyboard'
import '../../components/document-capture.css'
import '../../components/document-block-move.css'

export function SyncedStructureDialog({ commands, view, isZh }: {
  commands: SyncedStructureCommands; view: Readonly<StructureCommandView>; isZh: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null), search = useRef<HTMLInputElement>(null), composing = useRef(false)
  const current = useRef(view); current.current = view
  const [query, setQuery] = useState(view.query), titleId = useId(), hintId = useId(), choicesId = useId()
  const closeFocus = useDialogCloseFocus()
  useEffect(() => {
    const element = dialog.current!
    element.showModal(); search.current?.focus({ preventScroll: true })
    return closeFocus(element, view.opener, view.canReturnFocus)
  }, [view.id, closeFocus])
  const close = () => { if (!composing.current) commands.cancel() }
  const busy = view.busy || view.loading
  const searchGroups = () => { if (!composing.current && !view.hasRequest) commands.query(query) }
  return createPortal(<dialog ref={dialog} className="document-capture-dialog document-block-move-dialog synced-structure-dialog"
    data-block-shortcuts aria-labelledby={titleId} aria-describedby={hintId} aria-busy={busy} tabIndex={-1}
    onCancel={event => { event.preventDefault(); close() }}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
    onKeyDown={event => {
      event.stopPropagation()
      if (isImeKeyboardEvent(event.nativeEvent, composing.current)) { if (event.key === 'Escape' || event.key === 'Enter') event.preventDefault(); return }
      if (event.key === 'Escape') { event.preventDefault(); close() }
      trapFocusWithinDialog(event.nativeEvent, event.currentTarget)
    }}>
    <header className="document-capture-header"><div><h2 id={titleId}>{view.kind === 'create'
      ? isZh ? '创建同步块' : 'Create synced block' : isZh ? '插入同步块' : 'Insert synced block'}</h2>
      <p id={hintId}>{view.kind === 'create'
        ? isZh ? `将所选 ${view.blockCount} 个完整内容块转为同一份共享正文，宿主保留真实引用。` : `Turn the selected ${view.blockCount} complete blocks into one shared body; the host keeps its reference.`
        : isZh ? '选择已有共享正文，在原位置插入引用；不会复制共享正文到宿主。' : 'Choose an existing shared body and insert its reference at the original position.'}</p>
    </div></header>
    <div className="document-capture-body">
      {view.kind === 'insert' && <>
        <form onSubmit={event => { event.preventDefault(); searchGroups() }}>
          <label className="document-capture-field">{isZh ? '查找同步块' : 'Find synced blocks'}
            <input ref={search} value={query} disabled={view.busy || view.hasRequest} onChange={event => setQuery(event.target.value)} /></label>
          <button type="submit" className="secondary-button" disabled={view.busy || view.hasRequest}>{isZh ? '查找' : 'Search'}</button>
        </form>
        <fieldset disabled={busy || view.hasRequest} aria-labelledby={choicesId}>
          <legend id={choicesId}>{isZh ? '已有共享正文' : 'Existing shared bodies'}</legend>
          {view.items.map(item => <label key={item.groupId} className="document-capture-option" data-synced-group-choice={item.groupId}>
            <input type="radio" name={choicesId} value={item.groupId} checked={view.selectedGroupId === item.groupId}
              onChange={() => commands.choose(item.groupId)} />
            <span><strong>{item.preview || (isZh ? '空白共享正文' : 'Empty shared body')}</strong><small>{item.originPath}
              {' · '}{isZh ? `${item.liveInstances} 个引用` : `${item.liveInstances} references`}</small></span>
          </label>)}
          {!view.loading && !view.items.length && <p role="status">{isZh ? '没有匹配的同步块。' : 'No matching synced blocks.'}</p>}
        </fieldset>
        <div role="group" aria-label={isZh ? '同步块分页' : 'Synced block pages'}>
          <button type="button" disabled={busy || view.hasRequest || view.offset === 0} onClick={() => commands.query(view.query, Math.max(0, view.offset - 20))}>{isZh ? '上一页' : 'Previous page'}</button>
          <button type="button" disabled={busy || view.hasRequest || view.offset + view.items.length >= view.total} onClick={() => commands.query(view.query, view.offset + 20)}>{isZh ? '下一页' : 'Next page'}</button>
        </div>
      </>}
      {view.loading && <p role="status">{isZh ? '正在读取原宿主与同步块…' : 'Reading the original host and synced blocks…'}</p>}
      {view.error && <p role="alert">{view.error}</p>}
      {view.uncertain && <p role="status">{isZh ? '原操作回执尚未核定，请重试原操作。完整正文保持不变。' : 'The original operation is not settled. Retry that same operation; the complete body is retained.'}</p>}
    </div>
    <footer className="document-capture-footer">
      <button type="button" className="secondary-button" disabled={view.busy || view.uncertain} onClick={close}>{isZh ? '取消' : 'Cancel'}</button>
      <button type="button" className="primary-button" disabled={busy || view.kind === 'insert' && !view.selectedGroupId}
        onClick={() => { if (!composing.current && current.current.id === view.id) void commands.apply() }}>{view.hasRequest
          ? isZh ? '重试原操作' : 'Retry original operation' : view.kind === 'create' ? isZh ? '创建同步块' : 'Create synced block'
            : isZh ? '插入引用' : 'Insert reference'}</button>
    </footer>
  </dialog>, document.body)
}
