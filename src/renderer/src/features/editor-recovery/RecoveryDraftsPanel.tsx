import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { EditorRecoveryCandidate, EditorRecoveryRecordSummary, LegacyEditorRecoveryPage, LegacyEditorRecoverySummary } from '@shared/editor-recovery-drafts'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import type { DocumentsDomainState } from '../../types/appDomains'
import type { AppMessageHandler } from '../../notify'
import type { CanonicalInlineRuntime } from '../synced-blocks/inlineRuntime'

/** Eligibility only shows the explicit check action. The actual Main original,
 * new read owner and complete private frame decoder still decide restoration. */
function canCheckCanonical(candidate: EditorRecoveryCandidate): boolean {
  if (candidate.canonicalFollowupAvailable === true) return true
  if (candidate.record.base.owner.kind !== 'group' || candidate.record.draft.sources.length || candidate.record.draft.pending.length
    || candidate.record.draft.composing || candidate.record.draft.importing || candidate.reasons.some(reason => reason !== 'cold-semantic-source-replay-required')) return false
  try {
    const replay = JSON.parse(candidate.record.draft.replayJson ?? 'null')
    return replay?.kind === 'knowbook-canonical-recovery-data' && replay.version === 2 && replay.accepted === null
      && Array.isArray(replay.frames) && Array.isArray(replay.redoFrames) && Array.isArray(replay.serverRedo) && !replay.serverRedo.length
  } catch { return false }
}

function legacyDraftBody(payload: string): string {
  try {
    const draft = JSON.parse(payload)
    if (draft?.version !== 1) return payload
    if (typeof draft.working?.source === 'string') return draft.working.source
    const host = draft.host?.workingBefore
    if (Array.isArray(host?.blocks)) return serializeBlocksToMarkdown(host.blocks)
    if (Array.isArray(draft.working)) return serializeBlocksToMarkdown(draft.working)
  } catch { /* The exact original remains available even when its shape is unknown. */ }
  return payload
}

/** Recovery is an explicit local draft decision. Reading, previewing and
 * restoring never calls Save, Source Apply, a business inverse or a nonce retry. */
export function RecoveryDraftsPanel({ documents, runtime, isZh, notify, ready }: {
  documents: DocumentsDomainState; runtime: CanonicalInlineRuntime; isZh: boolean; notify: AppMessageHandler; ready: boolean
}) {
  const [rows, setRows] = useState<EditorRecoveryRecordSummary[]>([]), [next, setNext] = useState<string | null>(null)
  const [legacy, setLegacy] = useState<LegacyEditorRecoveryPage>({ records: [], next: null })
  const [legacyDraft, setLegacyDraft] = useState<{ original: string; body: string } | null>(null)
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
  const loadLegacy = async (after?: string) => {
    if (typeof window.knowbook.listLegacyEditorRecoveryDrafts !== 'function') return
    const page = await window.knowbook.listLegacyEditorRecoveryDrafts(after)
    setLegacy(previous => after ? { records: [...previous.records, ...page.records], next: page.next } : page)
  }
  const refresh = () => { void load().catch(failed); void loadLegacy().catch(failed) }
  useEffect(() => { if (ready) refresh() }, [ready])
  useEffect(() => {
    if (expanded) dialog.current?.showModal()
    else dialog.current?.close()
  }, [expanded])
  const inspect = async (row: EditorRecoveryRecordSummary) => {
    if (busy) return
    setLegacyDraft(null)
    setBusy(true)
    try { setCandidate(await window.knowbook.readEditorRecoveryDraft({ recordId: row.recordId, generation: row.generation, hash: row.hash })) }
    catch (error) { failed(error); await load() }
    finally { setBusy(false) }
  }
  const inspectLegacy = async ({ recordId, generation, hash }: LegacyEditorRecoverySummary) => {
    if (busy) return
    setCandidate(null); setLegacyDraft(null); setBusy(true)
    try {
      const payload = await window.knowbook.readLegacyEditorRecoveryDraft({ recordId, generation, hash })
      if (payload === null) await loadLegacy()
      else setLegacyDraft({ original: payload, body: legacyDraftBody(payload) })
    } catch (error) { failed(error) }
    finally { setBusy(false) }
  }
  const decide = async (decision: 'restore-draft' | 'keep' | 'discard') => {
    if (!candidate || busy) return
    setBusy(true)
    try {
      if (decision === 'restore-draft') {
        const owner = candidate.record.base.owner
        if (owner.kind === 'group') {
          if (!canCheckCanonical(candidate)) throw new Error(text('此草稿需要保留并检查当前内容。', 'Keep this draft and review the current content.'))
          const target = latest.current.runtime.recoveryGroupTarget(owner.groupId, candidate.canonicalHostDocumentId)
          if (!target) throw new Error(text('找不到这组共享正文的当前位置，草稿仍保留。', 'This shared body has no current location. Its draft is retained.'))
          const current = latest.current.documents.getSyncedHostEditorState()
          if (!current || current.host.documentId !== target) {
            await latest.current.documents.openDocumentInDocumentsPage(target)
            notify(text('文档已打开，请展开共享正文后再次选择恢复。', 'The document is open. Expand the shared body, then choose Restore again.'))
            return
          }
          if (latest.current.documents.hasPendingDraftChanges || latest.current.documents.isSaving || latest.current.documents.isSyncedHostComposing()) {
            throw new Error(text('请先保留并处理当前文档中的输入，草稿仍保留。', 'Finish the current document input first. The draft is retained.'))
          }
          try {
            if (!await latest.current.runtime.restoreRecoveryGroup(candidate.recoveryOwnerId, owner.groupId, current, candidate.canonicalFollowupAvailable)) throw new Error('The actual recovery visit changed')
          } catch (error) {
            console.warn('Canonical recovery original/source verification did not finish', error)
            throw new Error(text('当前正文或原有记录无法核对，草稿仍保留；可复制后手动处理。', 'The current body or original record could not be verified. The draft is retained and available to copy.'))
          }
          setCandidate(null); setExpanded(false); await load(); return
        }
        if (candidate.mode === 'view-only') throw new Error(text('此草稿需要保留并检查当前内容。', 'Keep this draft and review the current content.'))
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
  if (!rows.length && !legacy.records.length && !review) return null
  const working = candidate?.record.draft.working
  const canonicalCheck = candidate ? canCheckCanonical(candidate) : false
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
        : <button type="button" className="secondary-button" onClick={() => { setExpanded(true); refresh() }}>
          {text('检查保留的编辑草稿', 'Review retained editor drafts')} ({rows.length + legacy.records.length}{next || legacy.next ? '+' : ''})</button>}
    </aside>
    {expanded && <dialog ref={dialog} className="document-markdown-source" aria-labelledby={labelId} onCancel={event => { event.preventDefault(); setExpanded(false) }}>
      <header><h3 id={labelId}>{text('保留的编辑草稿', 'Retained editor drafts')}</h3><button type="button" className="secondary-button" disabled={busy} onClick={() => setExpanded(false)}>{text('关闭', 'Close')}</button></header>
      <p>{text('草稿保留了尚未保存的编辑。恢复后先检查，保存或应用源码时才更新正文。', 'These drafts preserve unsaved editing. Review a restored draft before saving or applying source changes.')}</p>
      <ul>{rows.map(row => <li key={row.recordId}><button type="button" className="secondary-button" disabled={busy} onClick={() => { void inspect(row) }}>
        {row.displayTitle || text(row.owner.kind === 'host' ? '未命名文档' : '共享正文', row.owner.kind === 'host' ? 'Untitled document' : 'Shared body')}
        {' · '}{new Date(row.capturedAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}
      </button></li>)}</ul>
      {next && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void load(next).catch(failed) }}>{text('更多草稿', 'More drafts')}</button>}
      {legacy.records.length > 0 && <section>
        <h4>{text('旧版本草稿', 'Drafts from an earlier version')}</h4>
        <p>{text('旧版本草稿可查看和复制。', 'Review or copy drafts saved by an earlier version.')}</p>
        <ul>{legacy.records.map(row => <li key={row.recordId}>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { void inspectLegacy(row) }}>
            {row.kind === 'source' ? text('源码', 'Source') : row.kind === 'group' ? text('共享正文', 'Shared body') : text('文档', 'Document')}
            {' · '}{row.targetId}{' · '}{new Date(row.updatedAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}
          </button>
        </li>)}</ul>
        {legacy.next && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void loadLegacy(legacy.next!).catch(failed) }}>
          {text('更多旧版本草稿', 'More drafts from earlier versions')}</button>}
        {legacyDraft && <>
          <textarea readOnly aria-label={text('旧版本草稿预览，可复制', 'Earlier draft preview, available to copy')} value={legacyDraft.body} rows={14} />
          <footer>
            {legacyDraft.body !== legacyDraft.original && <button type="button" className="secondary-button" disabled={busy}
              onClick={() => { void window.knowbook.writeClipboardText(legacyDraft.body).catch(failed) }}>{text('复制正文', 'Copy body')}</button>}
            <button type="button" className="secondary-button" disabled={busy}
              onClick={() => { void window.knowbook.writeClipboardText(legacyDraft.original).catch(failed) }}>{text('复制完整记录', 'Copy full record')}</button>
          </footer>
        </>}
      </section>}
      {candidate && <section>
        <p>{candidate.canonicalFollowupAvailable ? text('原提交已确认。恢复只载入后续未保存的正文，等待你明确保存。', 'The original save is confirmed. Restore loads the later unsaved body for your review before you save it.')
          : changed ? text('当前内容已变化。草稿可保留或复制，不能直接替换当前正文。', 'The current content changed. Keep or copy this draft before reconciling it.')
          : canonicalCheck ? text('选择恢复后将再次核对当前共享正文与原有记录，再载入待检查的本地草稿。', 'Restore checks the current shared body and its original record before loading a local draft for review.')
            : candidate.mode !== 'view-only' ? text('当前内容未变化，可恢复为待检查的本地草稿。', 'The current content is unchanged. Restore this as a local draft for review.')
            : text('草稿已保留；这份源码或共享正文需要进一步检查后才能恢复。', 'The draft is retained. This source or shared body needs further review before restoration.')}</p>
        <textarea readOnly aria-label={text('草稿预览，可复制', 'Draft preview, available to copy')} value={preview} rows={14} />
        <footer><button type="button" className="primary-button" disabled={busy || candidate.mode === 'view-only' && !canonicalCheck} onClick={() => { void decide('restore-draft') }}>{text('恢复', 'Restore')}</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { void decide('keep') }}>{text('保留', 'Keep')}</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => { void decide('discard') }}>{text('丢弃', 'Discard')}</button></footer>
      </section>}
    </dialog>}
  </>
}
