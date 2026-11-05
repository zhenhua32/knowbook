import { useMemo, useRef, useState } from 'react'
import type { SyncedHostWorkingBefore } from '@shared/synced-blocks'
import { MarkdownSourceDialog, type MarkdownSourceLocalState } from '../../components/DocumentMarkdownSourceDialog'
import { areDocumentDraftBlocksEqual } from '../../utils/documentDraftComparison'
import { applySyncedHostSourceChanges, createSyncedHostSourceDraft, prepareSyncedHostSourceApply,
  captureSyncedHostSourceSubmission, readSyncedHostSourceCheckpoint, readSyncedHostSourceRecovery, hasSyncedHostSourceChanges,
  type PreparedSyncedHostSource, type SyncedHostSourceSubmission, type SyncedHostSourceApplyOutcome, type SyncedHostSourceCheckpoint, type RestoredSyncedHostSource } from './hostSource'

export type SyncedHostSourceCurrent = {
  hostSession: object
  editSequence: number
  host: SyncedHostWorkingBefore
}
export type SyncedHostSourceDialogProps = {
  sessionKey: object
  getCurrent: () => SyncedHostSourceCurrent | null
  isCurrent: () => boolean
  opener: HTMLElement | null
  applyPrepared: (prepared: PreparedSyncedHostSource) => Promise<boolean>
  applySubmission?: (submission: SyncedHostSourceSubmission) => Promise<SyncedHostSourceApplyOutcome>
  onCompositionChange?: (composing: boolean) => void
  isZh: boolean
  onLocalStateChange?: (state: Readonly<MarkdownSourceLocalState>) => void
  onClose: () => void | boolean
  restored?: RestoredSyncedHostSource
}

/** A renderer-only adapter. Its coordinator owns real structure guards, IPC,
 * history and acknowledgement adoption; no ordinary document save is a fallback. */
export function SyncedHostSourceDialog(props: SyncedHostSourceDialogProps) {
  const latest = useRef(props.sessionKey)
  latest.current = props.sessionKey
  const openingKey = useMemo(() => crypto.randomUUID(), [props.sessionKey])
  return <HostSourceOpening key={openingKey} {...props} ownsOpening={() => latest.current === props.sessionKey} />
}

function HostSourceOpening(props: SyncedHostSourceDialogProps & { ownsOpening: () => boolean }) {
  const latest = useRef(props); latest.current = props
  const [opening] = useState(() => {
    const state = props.getCurrent()
    if (!state || !state.hostSession || typeof state.hostSession !== 'object' || !Number.isSafeInteger(state.editSequence)
      || state.editSequence < 0) throw new Error('The host Source opening is unavailable')
    const draft = props.restored?.draft ?? createSyncedHostSourceDraft(state.host)
    return { sessionKey: {}, draft, hostSession: state.hostSession, editSequence: state.editSequence,
      hasSyncedReferences: state.host.workingBefore.blocks.some(block => block.type === 'synced-block'),
      checkpoint: null as SyncedHostSourceCheckpoint | null,
      opener: props.opener, isCurrent: props.isCurrent, applyPrepared: props.applyPrepared,
      applySubmission: props.applySubmission, onCompositionChange: props.onCompositionChange }
  })
  const isCurrent = () => {
    if (!latest.current.ownsOpening() || !opening.isCurrent() || !latest.current.isCurrent()) return false
    const current = latest.current.getCurrent()
    return current !== null && current.hostSession === opening.hostSession && current.host.documentId === opening.draft.opening.documentId
  }
  return <MarkdownSourceDialog sessionKey={opening.sessionKey} isZh={props.isZh} onClose={props.onClose} onLocalStateChange={props.onLocalStateChange}
    recoveryAddress={{ kind: 'host', documentId: opening.draft.opening.documentId }}
    readRecoveryProvenance={readSyncedHostSourceRecovery}
    hasUnappliedChanges={hasSyncedHostSourceChanges}
    restored={props.restored}
    createDraft={() => opening.draft} replaceChanges={applySyncedHostSourceChanges}
    isCurrent={isCurrent} getReturnFocus={() => opening.opener} onCompositionChange={opening.onCompositionChange}
    readApplyCheckpoint={() => {
      const handle = opening.checkpoint
      if (!handle) return null
      const checkpoint = readSyncedHostSourceCheckpoint(handle)
      const originalCurrent = () => {
        const current = latest.current.getCurrent(), expected = checkpoint.next
        return isCurrent() && current?.hostSession === opening.hostSession && current.hostSession === expected.hostSession
          && current.editSequence === expected.editSequence && current.host.documentId === expected.host.documentId
          && current.host.expectedPersistedUpdatedAt === expected.host.expectedPersistedUpdatedAt
          && current.host.workingBefore.title === expected.host.workingBefore.title
          && current.host.workingBefore.summary === expected.host.workingBefore.summary
          && areDocumentDraftBlocksEqual(current.host.workingBefore.blocks, expected.host.workingBefore.blocks)
      }
      if (!originalCurrent()) throw new Error('The actual accepted Source opening changed; retained input cannot borrow a latest opening')
      return { baseDraft: checkpoint.baseDraft, acceptedSource: checkpoint.baseDraft.source, rebase: checkpoint.rebase,
        committed: () => {
          if (opening.checkpoint !== handle || !originalCurrent()) throw new Error('The original Source checkpoint is no longer current')
          opening.draft = checkpoint.baseDraft; opening.editSequence = checkpoint.next.editSequence; opening.checkpoint = null
        } }
    }}
    text={{ title: props.isZh ? '编辑宿主正文源码' : 'Edit host body source',
      editorLabel: opening.hasSyncedReferences
        ? props.isZh ? '宿主正文 Markdown 源码' : 'Host body Markdown source'
        : props.isZh ? 'Markdown 正文源码' : 'Markdown body source',
      hint: props.isZh ? '引用以受保护的源码块显示；应用后保存正文。'
        : 'References appear as protected source blocks. Apply saves your body changes.',
      conflict: props.isZh ? '宿主正文、标题、摘要或编辑会话已变化。当前源码已保留，请复制后重新打开。'
        : 'The host body, title, summary or editing session changed. Your source is retained; copy it and reopen.' }}
    onApply={draft => {
      if (!isCurrent()) return false
      const current = latest.current.getCurrent(), before = opening.draft.opening
      if (!current || current.hostSession !== opening.hostSession || current.editSequence !== opening.editSequence
        || current.host.documentId !== before.documentId || current.host.expectedPersistedUpdatedAt !== before.expectedPersistedUpdatedAt
        || current.host.workingBefore.title !== before.workingBefore.title || current.host.workingBefore.summary !== before.workingBefore.summary
        || !areDocumentDraftBlocksEqual(current.host.workingBefore.blocks, before.workingBefore.blocks)) return false
      // This exact opening callback owns coordinator adoption. It receives only
      // the existing prepared fields, never a fabricated successful Main result.
      // Its successful adoption may advance host editSequence, so W equality is
      // a submission preflight rather than a condition for closing after ACK.
      if (!opening.applySubmission) return opening.applyPrepared(prepareSyncedHostSourceApply(draft))
      return opening.applySubmission(captureSyncedHostSourceSubmission(draft)).then(outcome => {
        if (!isCurrent()) return false
        if (outcome.checkpoint) opening.checkpoint = outcome.checkpoint
        return outcome.accepted
      })
    }} />
}
