import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { DocumentsDomainState } from '../../types/appDomains'
import type { AppMessageHandler } from '../../notify'
import { getCanonicalInlineRuntime } from './inlineRuntime'
import { SyncedCanonicalSourceDialog } from './SyncedCanonicalSourceDialog'
import { SyncedHostSourceDialog } from './SyncedHostSourceDialog'
import { SyncedStructureDialog } from './SyncedStructureDialog'
import { RecoveryDraftsPanel } from '../editor-recovery/RecoveryDraftsPanel'

/** Global lifetime: an expired document mount cannot silently discard the
 * exact opening Source buffer. Only its actual Cancel/accepted Apply closes it. */
export default function CanonicalInlineShell({ documents, isZh, notify, workspaceReady, initialDocumentId, isDocumentsPage }: {
  documents: DocumentsDomainState; isZh: boolean; notify: AppMessageHandler
  workspaceReady: boolean; initialDocumentId: string | null; isDocumentsPage: boolean
}) {
  const runtime = getCanonicalInlineRuntime(), latest = useRef({ documents, notify, isZh, workspaceReady, initialDocumentId, isDocumentsPage })
  latest.current = { documents, notify, isZh, workspaceReady, initialDocumentId, isDocumentsPage }
  runtime.configure({ getPersisted: () => latest.current.documents.selectedDocument, getCurrent: () => latest.current.documents.getSyncedHostEditorState(),
    applyOrdinarySource: (before, after) => latest.current.documents.applyOrdinaryMarkdownSource(before, after),
    adopt: (before, result) => latest.current.documents.adoptSyncedHostStructureResult(before, result),
    adoptHistory: (before, result) => latest.current.documents.adoptSyncedHostHistoryResult(before, result),
    flushHost: () => latest.current.documents.flushPendingChanges(),
    isComposing: () => latest.current.documents.isSyncedHostComposing(),
    canStartStructure: () => !latest.current.documents.isSaving && !latest.current.documents.isBlockMoveBusy && !latest.current.documents.isSyncedHostComposing(),
    navigateHost: (id, instanceId, current) => latest.current.documents.openDocumentBlockInDocumentsPage(id, instanceId, current),
    isReady: () => {
      const current = latest.current, editor = current.documents
      if (!current.workspaceReady || editor.detailLoading || editor.documentLoadError) return false
      const expected = editor.selectedDocumentId ?? current.initialDocumentId
      return expected ? editor.selectedDocumentId === expected && editor.getSyncedHostEditorState()?.host.documentId === expected : true
    },
    requiresHostSurface: () => latest.current.isDocumentsPage && Boolean(latest.current.documents.selectedDocumentId),
    selectedHostId: () => latest.current.documents.selectedDocumentId,
    notify: message => latest.current.notify(message, 'error'), isZh })
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
  useEffect(() => { runtime.observeRecoveryHost() })
  useEffect(() => {
    const attention = () => runtime.cancelNavigation()
    const events = ['pointerdown', 'keydown', 'wheel', 'compositionstart'] as const
    for (const type of events) document.addEventListener(type, attention, true)
    return () => { for (const type of events) document.removeEventListener(type, attention, true) }
  }, [runtime])
  useEffect(() => {
    const root = document.documentElement
    let previousInert = false, inertOwned = false
    const blockedEvents = ['beforeinput', 'keydown', 'pointerdown', 'click', 'paste', 'drop', 'dragstart'] as const
    const stop = (event: Event) => { if (runtime.isLocked()) { event.preventDefault(); event.stopImmediatePropagation() } }
    const lock = () => {
      if (!inertOwned) { previousInert = root.inert; inertOwned = true }
      root.inert = true
      for (const type of blockedEvents) document.addEventListener(type, stop, true)
    }
    const unlock = () => {
      if (inertOwned) { root.inert = previousInert; inertOwned = false }
      for (const type of blockedEvents) document.removeEventListener(type, stop, true)
    }
    const request = window.knowbook.onEditorCloseRequest(input => {
      // Freeze synchronously before awaiting any writer. No unload cleanup,
      // timer, stale callback or failed IPC is interpreted as a successful save.
      const composing = runtime.hasComposition()
      runtime.freeze(input.requestId)
      // Keep the native input candidate attached until Main cancels the close.
      if (!composing) lock()
      void (async () => {
        let flushed = false
        try {
          flushed = !composing && runtime.closeReady()
            && await runtime.flush({ shouldContinue: () => runtime.ownsClose(input.requestId) })
            && await latest.current.documents.flushPendingChanges()
            && await runtime.flush({ shouldContinue: () => runtime.ownsClose(input.requestId) }) && runtime.closeReady()
        } catch (error) { latest.current.notify(String(error), 'error') }
        if (!runtime.ownsClose(input.requestId)) return
        if (flushed) {
          try { flushed = await runtime.checkpointFlushedClose(input.requestId) }
          catch (error) {
            // The business drain already succeeded. A failed private cleanup
            // checkpoint retains its old draft; it cannot undo a real Save.
            console.warn('Saved editor recovery checkpoint was deferred.', error)
          }
        }
        try {
          if (!flushed && !composing && input.reason !== 'reload') {
            try {
              const receipt = await runtime.journalClose(input.requestId)
              if (!runtime.ownsClose(input.requestId) || receipt.closeGeneration === null) return
              await window.knowbook.acknowledgeEditorClose({ requestId: input.requestId, status: 'draft-journaled',
                closeGeneration: receipt.closeGeneration, receiptId: receipt.receiptId })
              return
            } catch (error) { latest.current.notify(String(error), 'error') }
          }
          await window.knowbook.acknowledgeEditorClose({ requestId: input.requestId,
            status: flushed ? 'flushed' : 'blocked', message: flushed ? undefined
              : latest.current.isZh ? '编辑草稿或源码尚未保存，窗口保持打开。' : 'Unsaved editor or source changes keep this window open.' })
        }
        catch (error) { latest.current.notify(String(error), 'error') }
        // ACK means remain frozen. Only matching Main cancellation unlocks.
      })()
    })
    const cancel = window.knowbook.onEditorCloseCancelled(input => {
      if (!runtime.ownsClose(input.requestId)) return
      runtime.cancelFreeze(input.requestId); unlock()
      if (input.message) latest.current.notify(input.message, 'error')
    })
    return () => {
      request(); cancel()
      // Component cleanup is never a flush or an ACK. The app owns this shell
      // for the full window lifetime, not the document route.
      if (!runtime.isLocked()) unlock()
    }
  }, [runtime])
  const recovery = <RecoveryDraftsPanel documents={documents} runtime={runtime} isZh={isZh} notify={notify} ready={workspaceReady} />
  if (state.command) return <>{recovery}<SyncedStructureDialog commands={runtime.commands} view={state.command} isZh={isZh} /></>
  const dialog = state.dialog
  if (!dialog) return recovery
  return <>{recovery}{dialog.kind === 'canonical'
    ? <SyncedCanonicalSourceDialog binding={dialog.binding} isZh={isZh}
      opener={dialog.opener} onLocalStateChange={dialog.report} onClose={dialog.close} />
    : <SyncedHostSourceDialog sessionKey={dialog.id} getCurrent={runtime.sourceCurrent}
      restored={dialog.restored}
      isCurrent={() => runtime.sourceIsCurrent(dialog)} opener={dialog.opener} isZh={isZh}
      applyPrepared={prepared => runtime.applyHostSource(dialog, prepared)}
      applySubmission={submission => runtime.applyHostSourceSubmission(dialog, submission)}
      onLocalStateChange={dialog.report} onClose={dialog.close} />}</>
}
