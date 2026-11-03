import type { SyncedEditingMethod } from '../shared/synced-editing-session'
import type { EditorCloseBarrier, EditorCloseIpcEvent } from './editor-close-barrier'

/** Main IPC admission only. A source baseline now persists an actual metadata2
 * original; it shares the existing entry/drain gate without wrapping its own
 * IMMEDIATE SQL transaction. Read-only methods and memory cleanup stay direct. */
export function runSyncedEditingSessionWithAdmission<T>(
  barrier: Pick<EditorCloseBarrier, 'runEditorMutation'>,
  event: EditorCloseIpcEvent,
  method: SyncedEditingMethod,
  operation: () => T
): T | Promise<T> {
  return method === 'updateSyncedBlockGroup' || method === 'restoreSyncedGroupOperation'
    || method === 'applySyncedHostStructure' || method === 'restoreSyncedHostOperation'
    || method === 'captureBaseline'
    ? barrier.runEditorMutation(event, operation) : operation()
}
