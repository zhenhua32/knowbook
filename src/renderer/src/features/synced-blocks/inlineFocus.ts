import type { WorkspaceSearchOccurrence } from '@shared/workspace-search-occurrence'
import type { SyncedGroupBinding } from './types'
import { restoreEditorHistoryBookmark } from '../../utils/editorHistoryFocus'

/** The resolver already proved this exact occurrence. Focus stays inside its
 * real instance root; opaque historical IDs are never interpolated in CSS. */
export function focusExactCanonicalSearchOccurrence(root: HTMLElement, binding: SyncedGroupBinding,
  target: WorkspaceSearchOccurrence, shouldContinue: () => boolean): boolean {
  const state = binding.getCurrent(), scope = binding.scope, snapshot = state.snapshot
  if (!shouldContinue() || !binding.isCurrent() || !scope.isCurrent() || scope.root() !== root
    || scope.hostDocumentId !== target.hostDocumentId || scope.instanceId !== target.instanceId
    || scope.bindingVersion !== target.bindingVersion || snapshot.groupId !== target.groupId
    || snapshot.creationId !== target.creationId || snapshot.createdAt !== target.groupCreatedAt
    || snapshot.revision !== target.revision || snapshot.topologyRevision !== target.topologyRevision
    || state.dirty || state.pending || state.incoming || state.failure || state.composingInstanceIds.length) return false
  const original = snapshot.blocks.find(block => block.id === target.canonicalBlockId && block.createdAt === target.canonicalCreatedAt)
  const index = state.working.findIndex(block => block.id === target.canonicalBlockId)
  if (!original || index < 0) return false
  const row = [...root.querySelectorAll<HTMLElement>('[data-block-id]')].find(element => element.dataset.blockId === target.canonicalBlockId
    && element.closest<HTMLElement>('[data-synced-instance-id]')?.dataset.syncedInstanceId === target.instanceId
    && !element.closest('[hidden], [inert], [aria-hidden="true"]'))
  if (!row || !shouldContinue()) return false
  row.scrollIntoView({ block: 'center', inline: 'nearest' })
  row.classList.add('block-editor-row-highlighted')
  // This is an already-proven address, never a URI/raw search or another
  // instance's global block selector. The existing bridge owns PM selection.
  if (restoreEditorHistoryBookmark({ blockId: target.canonicalBlockId, index, start: 0, end: 0, direction: 'forward',
    richText: { anchor: { blockId: target.canonicalBlockId, index, offset: 0 }, head: { blockId: target.canonicalBlockId, index, offset: 0 }, kind: 'text' } },
  state.working, root)) return true
  if (!shouldContinue() || !binding.isCurrent()) return false
  row.tabIndex = -1; row.focus({ preventScroll: true })
  return root.contains(document.activeElement)
}
