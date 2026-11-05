import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { EditorRecoveryCandidate, EditorRecoveryRecordSummary } from '@shared/editor-recovery-drafts'
import type { DocumentsDomainState } from '../../types/appDomains'
import type { AppMessageHandler } from '../../notify'
import type { CanonicalInlineRuntime } from '../synced-blocks/inlineRuntime'

/** Recovery is an explicit local draft decision. Reading, previewing and
 * restoring never calls Save, Source Apply, a business inverse or a nonce retry. */
export function RecoveryDraftsPanel({ documents, runtime, isZh, notify, ready }: {
  documents: DocumentsDomainState; runtime: CanonicalInlineRuntime; isZh: boolean; notify: AppMessageHandler; ready: boolean
}) {
  const [rows, setRows] = useState<EditorRecoveryRecordSummary[]>([]), [next, setNext] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false), [candidate, setCandidate] = useState<EditorRecoveryCandidate | null>(null)
  const [busy, setBusy] = useState(false)
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
  const review = runtime.reviewingRecovery()
  const dialog = useRef<HTMLDialogElement>(null), latest = useRef({ documents, runtime }); latest.current = { documents, runtime }
  const labelId = useId()
  const text = (zh: string, en: string) => isZh ? zh : en
  const failed = (error: unknown) => notify(String(error), 'error')
  const load = async (after?: string) => {
    const page = await window.knowbook.listEditorRecoveryDrafts({ ...(after ? { afterSessionId: after } : {}), limit: 20 })
    setRows(previous => after ? [...previous, ...page.records] : page.records); setNext(page.next)
  }
  useEffect(() => { if (ready) void load().catch(failed) }, [ready])
  useEffect(() => {
    if (expanded) dialog.current?.showModal()
    else dialog.current?.close()
  }, [expanded])
  const inspect = async (row: EditorRecoveryRecordSummary) => {
    if (busy) return
    setBusy(true)
    try { setCandidate(await window.knowbook.readEditorRecoveryDraft({ recordId: row.recordId, generation: row.generation, hash: row.hash })) }
    catch (error) { failed(error); await load() }
    finally { setBusy(false) }
  }
  const decide = async (decision: 'restore-draft' | 'keep' | 'discard') => {
    if (!candidate || busy) return
    setBusy(true)
    try {
      if (decision === 'restore-draft') {
        const owner = candidate.record.base.owner
        if (owner.kind !== 'host' || candidate.mode === 'view-only') throw new Error(text('此草稿需要保留并检查当前内容。', 'Keep this draft and review the current content.'))
        const current = latest.current.documents.getSyncedHostEditorState()
        if (!current || current.host.documentId !== owner.documentId) {
          await latest.current.documents.openDocumentInDocumentsPage(owner.documentId)
          notify(text('文档已打开，请再次选择恢复以检查并载入草稿。', 'The document is open. Choose Restore again to review and load its draft.'))
          return
        }
        const detail = latest.current.documents.selectedDocument
        if (!detail || detail.updatedAt !== owner.updatedAt || current.host.expectedPersistedUpdatedAt !== owner.updatedAt
          || latest.current.documents.hasPendingDraftChanges || latest.current.documents.isSaving || latest.current.documents.isSyncedHostComposing()) {
          throw new Error(text('当前文档已有新内容或未保存的输入，请先保留并处理当前编辑。', 'The current document changed or has unsaved input. Keep this draft and finish the current edit first.'))
        }
        // Main independently rereads the original head, workspace, birth, CAS
        // and actual SQL. Then the unchanged UI visit adopts only the local W.
        if (candidate.mode === 'editable-source-draft') {
          if (!await latest.current.runtime.restoreRecoverySource(candidate.recoveryOwnerId, current)) throw new Error(text('当前编辑已变化，源码草稿仍保留。', 'The current edit changed. The source draft is retained.'))
          setCandidate(null); setExpanded(false); await load(); return
        }
        const restored = await window.knowbook.decideEditorRecoveryDraft({ recoveryOwnerId: candidate.recoveryOwnerId, decision })
        if (!restored || restored.draft.working.kind !== 'host' || !latest.current.runtime.beginRecoveryReview()) throw new Error(text('当前编辑会话已变化，草稿仍保留。', 'The current edit session changed. The draft is retained.'))
        const accepted = latest.current.documents.adoptRecoveryDraft(current, restored.draft.working)
        if (!accepted) { latest.current.runtime.finishRecoveryReview(); throw new Error(text('当前编辑已变化，未替换任何输入。', 'The current edit changed. No input was replaced.')) }
        setExpanded(false)
      } else await window.knowbook.decideEditorRecoveryDraft({ recoveryOwnerId: candidate.recoveryOwnerId, decision })
      setCandidate(null); await load()
    } catch (error) { failed(error) }
    finally { setBusy(false) }
  }
  if (!rows.length && !review) return null
  const working = candidate?.record.draft.working
  const preview = candidate?.record.draft.sources.map(source => source.source).join('\n\n')
    || (working?.kind === 'host' ? [working.title, working.summary, ...working.blocks.map(block => block.content)].join('\n\n')
      : working?.blocks.map(block => block.content).join('\n\n') ?? '')
  const changed = candidate?.reasons.some(reason => ['workspace-epoch-changed', 'host-birth-changed-or-missing', 'group-birth-changed-or-missing', 'base-version-changed', 'base-content-changed'].includes(reason))
  return <>
    <aside role="status" className="document-save-status">
      {review ? <>{text('恢复的草稿已载入，检查后再保存。', 'The restored draft is loaded. Review it before saving.')}
        <button type="button" className="primary-button" onClick={() => {
          runtime.finishRecoveryReview(); void documents.saveDocument()
        }}>{text('保存恢复的草稿', 'Save restored draft')}</button></>
        : <button type="button" className="secondary-button" onClick={() => { setExpanded(true); void load().catch(failed) }}>
          {text('检查保留的编辑草稿', 'Review retained editor drafts')} ({rows.length}{next ? '+' : ''})</button>}
    </aside>
    {expanded && <dialog ref={dialog} className="document-markdown-source" aria-labelledby={labelId} onCancel={event => { event.preventDefault(); setExpanded(false) }}>
      <header><h3 id={labelId}>{text('保留的编辑草稿', 'Retained editor drafts')}</h3><button type="button" className="secondary-button" disabled={busy} onClick={() => setExpanded(false)}>{text('关闭', 'Close')}</button></header>
      <p>{text('草稿保留了尚未保存的编辑。恢复后先检查，保存或应用源码时才更新正文。', 'These drafts preserve unsaved editing. Review a restored draft before saving or applying source changes.')}</p>
      <ul>{rows.map(row => <li key={row.recordId}><button type="button" className="secondary-button" disabled={busy} onClick={() => { void inspect(row) }}>
        {row.displayTitle || text(row.owner.kind === 'host' ? '未命名文档' : '共享正文', row.owner.kind === 'host' ? 'Untitled document' : 'Shared body')}
        {' · '}{new Date(row.capturedAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}
      </button></li>)}</ul>
      {next && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void load(next).catch(failed) }}>{text('更多草稿', 'More drafts')}</button>}
      {candidate && <section>
        <p>{changed ? text('当前内容已变化。草稿可保留或复制，不能直接替换当前正文。', 'The current content changed. Keep or copy this draft before reconciling it.')
          : candidate.mode !== 'view-only' ? text('当前内容未变化，可恢复为待检查的本地草稿。', 'The current content is unchanged. Restore this as a local draft for review.')
            : text('草稿已保留；这份源码或共享正文需要进一步检查后才能恢复。', 'The draft is retained. This source or shared body needs further review before restoration.')}</p>
        <textarea readOnly aria-label={text('草稿预览，可复制', 'Draft preview, available to copy')} value={preview} rows={14} />
        <footer><button type="button" className="primary-button" disabled={busy || candidate.mode === 'view-only'} onClick={() => { void decide('restore-draft') }}>{text('恢复', 'Restore')}</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { void decide('keep') }}>{text('保留', 'Keep')}</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { void decide('discard') }}>{text('丢弃', 'Discard')}</button></footer>
      </section>}
    </dialog>}
  </>
}
