import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { EditorRecoveryDraft, EditorRecoveryDraftSummary } from '@shared/editor-recovery-drafts'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { appNotifications } from '../../app-notifications'
import type { AppMessageHandler } from '../../notify'
import { createSyncedHostSourceDraft } from './hostSource'
import type { CanonicalInlineRuntime } from './inlineRuntime'
import { isDirectlyRecoverable, readRecoveryPayload, type RecoveryPayload } from './editorRecoveryPayload'

function recoveryText(draft: EditorRecoveryDraft, payload: RecoveryPayload | null) {
  try {
    if (draft.kind === 'source' && payload?.working && 'source' in payload.working) return payload.working.source
    if (draft.kind === 'group' && Array.isArray(payload?.working)) return serializeBlocksToMarkdown(payload.working)
    if (draft.kind === 'document' && payload?.host) return createSyncedHostSourceDraft(payload.host).source
  } catch { /* Offer the unchanged recovery record if a damaged draft cannot render. */ }
  return draft.payload
}

export function RecoveredEditorDrafts({ runtime, ready, isZh, notify }: {
  runtime: CanonicalInlineRuntime; ready: boolean; isZh: boolean; notify: AppMessageHandler
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [records, setRecords] = useState<EditorRecoveryDraftSummary[]>([])
  const [selected, setSelected] = useState<EditorRecoveryDraft | null>(null)
  const [text, setText] = useState(''), [operation, setOperation] = useState<'committed' | 'unknown' | 'unavailable' | null>(null)
  const [canRecover, setCanRecover] = useState(false), [restoreError, setRestoreError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), action = useRef(false)
  const title = isZh ? '可恢复的编辑草稿' : 'Recoverable editor drafts'
  const list = async () => (await window.knowbook.listEditorRecoveryDrafts()).filter(row => !runtime.recovery.ownsSession(row.draftSessionId))

  useEffect(() => {
    if (!ready || typeof window.knowbook?.listEditorRecoveryDrafts !== 'function') return
    let current = true
    let notice: ReturnType<typeof appNotifications.show> | undefined
    void list().then(drafts => {
      if (!current || !drafts.length) return
      setRecords(drafts)
      notice = appNotifications.show({ title, level: 'info',
        message: isZh ? '上次会话的草稿已保留。' : 'Drafts from an earlier session were retained.',
        actions: [{ label: isZh ? '查看草稿' : 'View drafts', run: () => setOpen(true), closeNotificationCenter: true }] })
    }).catch(error => { if (current) notify(String(error), 'error') })
    return () => { current = false; notice?.dismiss() }
  }, [runtime, ready, isZh, title, notify])

  useEffect(() => {
    if (!open || !dialog.current) return
    const element = dialog.current
    element.showModal()
    return () => { if (element.open) element.close() }
  }, [open])

  const run = async (work: () => Promise<void>) => {
    if (action.current || runtime.isLocked()) return
    action.current = true; setBusy(true)
    try { await work() } catch (error) { notify(String(error), 'error') }
    finally { action.current = false; setBusy(false) }
  }
  const select = (record: EditorRecoveryDraftSummary) => run(async () => {
    const draft = await window.knowbook.readEditorRecoveryDraft(record.recordId)
    if (!draft || draft.generation !== record.generation || draft.hash !== record.hash) { setSelected(null); setRecords(await list()); return }
    const payload = readRecoveryPayload(draft), pending = payload?.pending?.input ?? payload?.pending
    const documentId = payload?.host?.documentId ?? payload?.base?.host?.documentId ?? payload?.pending?.input?.expectedInstanceBinding?.hostDocumentId
    const status = pending?.clientOperationId && documentId
      ? await runtime.readRecoveryOperation(draft.workspace, documentId, pending.clientOperationId).catch(() => 'unavailable' as const) : null
    setSelected(draft); setOperation(status); setText(recoveryText(draft, payload))
    setCanRecover(isDirectlyRecoverable(draft, payload)); setRestoreError('')
  })
  const restore = (record: EditorRecoveryDraft) => run(async () => {
    setRestoreError('')
    try {
      if (await runtime.recoverDraft(record)) { setOpen(false); return }
    } catch (error) { console.warn('The retained editor draft could not be reopened.', error) }
    setRestoreError(isZh ? '原编辑版本或链接来源无法确认。草稿仍可复制。' : 'The original editor version or link provenance could not be verified. You can still copy the draft.')
  })

  if (!open) return null
  return createPortal(<dialog ref={dialog} className="document-capture-dialog document-block-move-dialog" data-block-shortcuts
    aria-labelledby={titleId} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!action.current) setOpen(false) }}
    onKeyDown={event => event.stopPropagation()}>
    <header className="document-capture-header"><div><h2 id={titleId}>{title}</h2>
      <p>{isZh ? '核对草稿后可恢复到编辑器，或复制正文和原始记录。' : 'Review a draft, then restore it to the editor or copy its contents.'}</p>
    </div></header>
    <div className="document-capture-body">
      {records.length ? records.map(record => <button key={record.recordId} type="button" className="secondary-button" disabled={busy}
        onClick={() => { void select(record) }} aria-pressed={selected?.recordId === record.recordId}>
        {record.kind === 'source' ? (isZh ? '源码' : 'Source') : record.kind === 'group' ? (isZh ? '共享正文' : 'Shared body') : (isZh ? '文档' : 'Document')}
        {' · '}{new Date(record.updatedAt).toLocaleString()}{' · '}{record.targetId}
      </button>) : <p>{isZh ? '没有保留的草稿。' : 'No retained drafts.'}</p>}
      {operation && <p role="status">{operation === 'committed' ? (isZh ? '原提交已确认，请将草稿与已保存正文核对。' : 'The original operation committed. Compare this draft with the saved body.')
        : (isZh ? '原提交状态待核对，完整记录可复制。' : 'The original operation could not be confirmed. The full record is available to copy.')}</p>}
      {restoreError && <p role="alert">{restoreError}</p>}
      {selected && <textarea className="document-capture-field" readOnly rows={12} aria-label={isZh ? '恢复草稿正文' : 'Recovered draft body'} value={text} />}
    </div>
    <footer className="document-capture-footer">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => setOpen(false)}>{isZh ? '关闭' : 'Close'}</button>
      {selected && <>
        {canRecover && <button type="button" className="primary-button" disabled={busy} onClick={() => { void restore(selected) }}>
          {isZh ? '恢复到编辑器' : 'Restore to editor'}</button>}
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(() => window.knowbook.writeClipboardText(selected.payload)) }}>
          {isZh ? '复制完整记录' : 'Copy full record'}</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => { void run(() => window.knowbook.writeClipboardText(text)) }}>
          {isZh ? '复制正文' : 'Copy body'}</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(async () => {
          const { recordId, generation, hash } = selected
          await window.knowbook.discardEditorRecoveryDraft({ recordId, generation, hash })
          setSelected(null); setOperation(null); setText(''); setRecords(await list())
        }) }}>{isZh ? '丢弃此草稿' : 'Discard this draft'}</button>
      </>}
    </footer>
  </dialog>, document.body)
}
