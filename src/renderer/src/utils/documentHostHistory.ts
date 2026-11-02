import type { DocumentBlockDraft } from '@shared/contracts'
import type { SyncedHostHistoryTransition } from '../features/synced-blocks/hostHistoryTypes'
import type { SyncedHostSourceCurrent } from '../features/synced-blocks/SyncedHostSourceDialog'
import { restoreCanonicalHostHistory } from '../features/synced-blocks/inlineBridge'
import { areDocumentDraftBlocksEqual } from './documentDraftComparison'
import type { EditorHistoryBookmark, captureAsyncHistoryFocusPermission } from './editorHistoryFocus'
import type { BlockMoveCompletionContext } from './blockMoveActions'
import type { SyncedStructureApplied } from '@shared/synced-blocks'
import { normalizeDraftBlocks } from './draftTreeNormalization'
import { toDraftBlock } from './draftBlockShape'

type Ref<T> = { current: T }
type HistoryEntry = { blocks: DocumentBlockDraft[]; bookmark: EditorHistoryBookmark | null; hostStructure?: SyncedHostHistoryTransition }
export type DocumentHostAdoptContext = {
  editor: BlockMoveCompletionContext
  hooks: readonly [current: () => SyncedHostSourceCurrent | null, historyBusy: Ref<boolean>, clearTimer: () => void,
    checkpoint: () => void, commit: (blocks: DocumentBlockDraft[], bookmark?: EditorHistoryBookmark | null, marker?: SyncedHostHistoryTransition) => void,
    pending: Ref<DocumentBlockDraft[] | null>]
}

/** Synchronous local UI adoption, registered by the actual lazy inline runtime.
 * This context grants no Main authority or new ACK; callers still supply only
 * their actual original opening and the runtime's genuine Main receipt. */
export function adoptDocumentHostResult(context: DocumentHostAdoptContext, before: SyncedHostSourceCurrent,
  result: SyncedStructureApplied, history: boolean): boolean {
  const editor = context.editor, [readCurrent, busy, clearTimer, checkpoint, commit, pending] = context.hooks
  const current = readCurrent(), row = result.hosts[0]
  if (history && !busy.current || !current || current.hostSession !== before.hostSession || current.editSequence !== before.editSequence
    || JSON.stringify(current.host) !== JSON.stringify(before.host) || result.hosts.length !== 1 || row?.documentId !== before.host.documentId
    || row.after.id !== before.host.documentId || row.logicalBefore.title !== before.host.workingBefore.title
    || row.logicalBefore.summary !== before.host.workingBefore.summary
    || !areDocumentDraftBlocksEqual(row.logicalBefore.blocks, before.host.workingBefore.blocks)) return false
  clearTimer()
  if (!history) checkpoint()
  const detail = row.after, blocks = normalizeDraftBlocks(detail.blocks.map(toDraftBlock))
  editor.selected.current = detail; editor.title.current = detail.title; editor.summary.current = detail.summary; editor.blocks.current = blocks
  editor.onDocument(detail); editor.setTitle(detail.title); editor.setSummary(detail.summary); editor.setBlocks(blocks)
  if (!history) {
    if (result.historyToken) commit(blocks, null, Object.freeze({ documentId: before.host.documentId,
      operationId: result.operationId, historyToken: result.historyToken }))
    else commit(blocks)
  }
  editor.checkpointed.current = blocks; pending.current = null
  editor.clearFailure(null)
  if (!history) editor.onRevision(value => value + 1)
  void window.knowbook.getHomeData().then(home => { if (editor.mounted.current) editor.onHome(home) })
    .catch(error => console.warn('Failed to refresh after shared host acknowledgement', error))
  return true
}
/** Local renderer timeline references only. Main restore permission still comes
 * exclusively from the registered runtime, its real session and original ACK.
 * Named tuples avoid duplicating a large mutable context or long runtime keys. */
export type DocumentHostHistoryContext = {
  opening: readonly [transition: SyncedHostHistoryTransition, direction: 'undo' | 'redo', history: HistoryEntry[],
    pointer: number, session: number, owner: object, before: SyncedHostSourceCurrent, draft: DocumentBlockDraft[]]
  refs: readonly [history: Ref<HistoryEntry[]>, pointer: Ref<number>, session: Ref<number>, draft: Ref<DocumentBlockDraft[]>,
    pending: Ref<DocumentBlockDraft[] | null>, checkpoint: Ref<DocumentBlockDraft[] | null>,
    pendingFocus: Ref<EditorHistoryBookmark | null>, lastFocus: Ref<EditorHistoryBookmark | null>,
    busy: Ref<boolean>, owner: Ref<object | null>, restoring: Ref<boolean>, mounted: Ref<boolean>]
  focus: ReturnType<typeof captureAsyncHistoryFocusPermission>
  current: () => SyncedHostSourceCurrent | null
  changed: () => void
}

/** Loaded only by the actual async Undo/Redo branch. The opening and focus
 * token were captured before loading; today's history is never a substitute. */
export async function restoreDocumentHostHistory(context: DocumentHostHistoryContext): Promise<boolean> {
  const [transition, direction, history, pointer, session, original, before, draft] = context.opening
  const [historyRef, pointerRef, sessionRef, draftRef, pendingRef, checkpointRef,
    pendingFocusRef, lastFocusRef, busyRef, ownerRef, restoringRef, mountedRef] = context.refs
  const owns = () => ownerRef.current === original && mountedRef.current && sessionRef.current === session
  let succeeded = false
  try {
    // A cold chunk is not authority to adopt a changed host or cursor.
    const current = context.current()
    if (!owns() || historyRef.current !== history || pointerRef.current !== pointer || draftRef.current !== draft
      || !current || current.hostSession !== before.hostSession || current.editSequence !== before.editSequence
      || JSON.stringify(current.host) !== JSON.stringify(before.host)) return false
    const marker = direction === 'undo' ? history[pointer]?.hostStructure : history[pointer + 1]?.hostStructure
    if (marker !== transition || !await restoreCanonicalHostHistory(transition, direction) || !owns()
      || historyRef.current !== history || pointerRef.current !== pointer) return false
    const next = pointer + (direction === 'undo' ? -1 : 1), target = history[next]
    if (!target || !areDocumentDraftBlocksEqual(target.blocks, draftRef.current)) return false
    pointerRef.current = next
    pendingRef.current = null; checkpointRef.current = draftRef.current
    pendingFocusRef.current = context.focus.canRestore() ? target.bookmark ?? lastFocusRef.current : null
    context.changed(); succeeded = true; return true
  } finally {
    context.focus.dispose()
    if (owns()) {
      busyRef.current = false; context.changed()
      if (succeeded) setTimeout(() => {
        if (owns()) { restoringRef.current = false; ownerRef.current = null }
      }, 0)
      else { restoringRef.current = false; ownerRef.current = null }
    }
  }
}
