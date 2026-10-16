import { useMemo, useRef, useState } from 'react'
import type { SyncedHostWorkingBefore } from '@shared/synced-blocks'
import { MarkdownSourceDialog } from '../../components/DocumentMarkdownSourceDialog'
import { areDocumentDraftBlocksEqual } from '../../utils/documentDraftComparison'
import { applySyncedHostSourceChanges, createSyncedHostSourceDraft, prepareSyncedHostSourceApply,
  type PreparedSyncedHostSource } from './hostSource'

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
  onCompositionChange?: (composing: boolean) => void
  isZh: boolean
  onClose: () => void
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
    const draft = createSyncedHostSourceDraft(state.host)
    return { sessionKey: {}, draft, hostSession: state.hostSession, editSequence: state.editSequence,
      opener: props.opener, isCurrent: props.isCurrent, applyPrepared: props.applyPrepared, onCompositionChange: props.onCompositionChange }
  })
  const isCurrent = () => {
    if (!latest.current.ownsOpening() || !opening.isCurrent() || !latest.current.isCurrent()) return false
    const current = latest.current.getCurrent()
    return current !== null && current.hostSession === opening.hostSession && current.host.documentId === opening.draft.opening.documentId
  }
  return <MarkdownSourceDialog sessionKey={opening.sessionKey} isZh={props.isZh} onClose={props.onClose}
    createDraft={() => opening.draft} replaceChanges={applySyncedHostSourceChanges}
    isCurrent={isCurrent} getReturnFocus={() => opening.opener} onCompositionChange={opening.onCompositionChange}
    text={{ title: props.isZh ? '编辑宿主正文源码' : 'Edit host body source',
      editorLabel: props.isZh ? '宿主正文 Markdown 源码' : 'Host body Markdown source',
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
      return opening.applyPrepared(prepareSyncedHostSourceApply(draft))
    }} />
}
