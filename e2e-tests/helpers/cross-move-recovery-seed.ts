import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostHash } from '../../src/main/database/synced-host-journal'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../../src/main/editor-close-barrier'
import { EditorRecoveryDraftService } from '../../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../../src/main/editor-recovery/draft-store'
import type { EditorRecoveryDraftInput } from '../../src/shared/editor-recovery-drafts'
import { syncedCanonicalEdits } from '../../src/shared/syncedBlockValidation'
import { addV3CrossMoveDependency, addV3OrdinaryListBranch, addV3SameGroupReference, createV3Fixture, keepOnlyV3SourceReference,
  randomUUID, request } from '../../tests/helpers/synced-backup-v3-fixture'
import { seedHotNestedCrossMove } from '../../tests/helpers/hot-nested-cross-move-fixture'

let nextContentsId = 21
class Contents extends EventEmitter {
  readonly id = nextContentsId++
  readonly mainFrame = { processId: 100, routingId: this.id, detached: false }
  isDestroyed() { return false }
  getOSProcessId() { return 300 }
  send() {}
}
class Window extends EventEmitter {
  readonly webContents = new Contents()
  isDestroyed() { return false }
  close() {}
}
function register(barrier: ReturnType<typeof createEditorCloseBarrier>): EditorCloseIpcEvent {
  const window = new Window()
  barrier.registerWindow(window)
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame }
}


const f = createV3Fixture(process.argv[2])
const mode = process.argv[3]
if (['hot-before-move', 'hot-empty-before-move', 'hot-wiki-before-move', 'hot-v7-before-move', 'hot-v9-before-move',
  'hot-v10-before-move', 'hot-v11-before-move', 'hot-nested-before-move', 'hot-list-parent-before-move', 'hot-list-parent-target-peer-before-move',
  'hot-list-parent-source-peer-before-move', 'hot-mixed-target-peer-before-move',
  'hot-shared-target-before-move', 'hot-shared-source-before-move', 'hot-batch-before-move', 'hot-mixed-root-pair-before-move',
  'hot-shared-wiki-before-move', 'hot-shared-markdown-before-move', 'hot-shared-multiple-dependencies-before-move',
  'hot-mixed-forest-before-move'].includes(mode)) {
  try {
    if (mode === 'hot-empty-before-move' || mode === 'hot-v9-before-move') keepOnlyV3SourceReference(f)
    const listSourcePeer = mode === 'hot-list-parent-source-peer-before-move'
    const listParent = mode === 'hot-list-parent-before-move' || mode === 'hot-list-parent-target-peer-before-move' || listSourcePeer
    const placement = mode === 'hot-nested-before-move' || listParent
      ? seedHotNestedCrossMove(f, 0, listParent ? 'single-reference' : undefined) : undefined
    const sharedWiki = mode === 'hot-shared-wiki-before-move', sharedMarkdown = mode === 'hot-shared-markdown-before-move'
    const sharedMultiple = mode === 'hot-shared-multiple-dependencies-before-move'
    const dependencies = mode === 'hot-wiki-before-move' || mode === 'hot-batch-before-move' || sharedWiki ? [addV3CrossMoveDependency(f)]
      : mode === 'hot-v7-before-move' || sharedMarkdown ? [addV3CrossMoveDependency(f, 'markdown', { title: 'V7 Markdown dependency' })]
      : mode === 'hot-v9-before-move' ? [addV3CrossMoveDependency(f, 'wiki', { title: 'V9 outside Wiki' }),
        addV3CrossMoveDependency(f, 'markdown', { title: 'V9 outside Markdown' })]
      : mode === 'hot-v10-before-move' ? [addV3CrossMoveDependency(f, 'html', { title: 'V10 outside HTML' })]
      : sharedMultiple ? [addV3CrossMoveDependency(f, 'wiki', { title: 'Independent outside Wiki' }),
        addV3CrossMoveDependency(f, 'reference', { title: 'Independent outside definition', stationary: true })]
      : mode === 'hot-v11-before-move' ? [addV3CrossMoveDependency(f, 'reference', { title: 'V11 outside reference', stationary: true })] : []
    const sharedSourceId = mode === 'hot-shared-source-before-move' || sharedWiki || sharedMarkdown || sharedMultiple || listSourcePeer ? addV3SameGroupReference(f, f.hostId) : undefined
    const sharedTargetId = sharedSourceId && !listSourcePeer || mode === 'hot-shared-target-before-move' || mode === 'hot-list-parent-target-peer-before-move'
      || mode === 'hot-mixed-target-peer-before-move'
      ? addV3SameGroupReference(f, f.targetId) : undefined
    const stagedSource = mode === 'hot-batch-before-move'
      ? { documentId: f.store.createDocument(null), title: 'Independent move source', blockId: randomUUID() } : undefined
    if (stagedSource) f.store.updateDocument(stagedSource.documentId, { title: stagedSource.title, summary: '', blocks: [
      { id: stagedSource.blockId, type: 'paragraph', content: 'The staged ordinary block', depth: 0, parentBlockId: null, checked: false }
    ] })
    const ordinaryBranch = mode === 'hot-mixed-forest-before-move' ? addV3OrdinaryListBranch(f) : undefined
    writeFileSync(join(f.userDataRoot, 'cross-move-recovery-seed.json'), JSON.stringify({
      groupId: f.groupId, instanceId: f.instanceId, sourceId: f.hostId, targetId: f.targetId, raw: f.raw,
      primaryId: f.created.groups[0].blocks[0].id, dependencies, placement, sharedSourceId, sharedTargetId, stagedSource,
      ordinaryRootId: ordinaryBranch || mode === 'hot-mixed-root-pair-before-move' || mode === 'hot-mixed-target-peer-before-move' ? f.hostBodyId : undefined, ordinaryBranch
    }))
  } finally { f.close() }
} else {
try {
    const barrier = createEditorCloseBarrier({ beginShutdown() {} })
    const groupEvent = register(barrier), hostEvent = groupEvent
    const folder = join(f.userDataRoot, 'storage', 'recovery'), side = new EditorRecoveryDraftStore(folder)
    const service = new EditorRecoveryDraftService(side, f.store, event => barrier.assertEditorMutationAllowed(event))
    try {
      const from = f.store.openSyncedEditingSession(groupEvent.senderFrame!, { kind: 'instance', hostDocumentId: f.hostId,
        groupId: f.groupId, instanceId: f.instanceId })
      assert.ok(from.status === 'ready' && from.instance)
      const sessionId = from.session.sessionId
      const baseline = f.store.invokeSyncedEditingSession(groupEvent.senderFrame!, { sessionId, method: 'captureBaseline', input: { groupId: f.groupId } })
      assert.ok(baseline.status === 'ready')
      const group = service.open(groupEvent, { kind: 'group', groupId: f.groupId, readOwnerId: baseline.readOwnerId, sessionId, openRequestId: randomUUID() })
      const { instanceId, hostDocumentId, bindingVersion } = from.instance
      const blocks = syncedCanonicalEdits(baseline.snapshot.blocks), after = blocks.map(block => ({ ...block, content: block.content + ' unsaved W' }))
      const redo = after.map(block => ({ ...block, content: block.content + ' unsaved Redo' }))
      const instance = { instanceId, hostDocumentId, bindingVersion }
      const working = { kind: 'group' as const, blocks: after, incoming: null }
      const groupDraft: EditorRecoveryDraftInput = { draftSessionId: group.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
        working, sources: [], pending: [], selection: null, composing: false, importing: false,
        replayJson: JSON.stringify({ kind: 'knowbook-canonical-recovery-data', version: 2, snapshot: baseline.snapshot,
          readSource: { workspaceScope: baseline.workspaceScope, readOwnerId: baseline.readOwnerId, snapshot: baseline.snapshot, bindingSource: baseline.bindingSource },
          accepted: null, frames: [{ before: blocks, after, instance, copySources: [], sequence: 1, transactionId: randomUUID() }],
          redoFrames: [{ before: after, after: redo, instance, copySources: [], sequence: 2, transactionId: randomUUID() }],
          serverRedo: [], cutServerRedo: true }) }
      const groupReceipt = service.write(groupEvent, { records: [groupDraft] }, { kind: 'background' })
      const [groupHead] = groupReceipt.records

      const hostSource = f.store.openSyncedEditingSession(hostEvent.senderFrame!, { kind: 'host', hostDocumentId: f.hostId })
      const hostTarget = f.store.openSyncedEditingSession(hostEvent.senderFrame!, { kind: 'host', hostDocumentId: f.targetId })
      assert.ok(hostSource.status === 'ready' && hostTarget.status === 'ready' && hostSource.session.sessionId === hostTarget.session.sessionId)
      const { clientOperationId, hostsWorkingBefore, groups, expectedInstances } = request(f.db, [f.hostId, f.targetId])
      const input = { clientOperationId, hostsWorkingBefore, groups, expectedInstances, mode: 'command' as const,
        action: { kind: 'move' as const, selection: { documentId: f.hostId, selectedRootIds: [f.instanceId] },
          target: { documentId: f.targetId, parentBlockId: null, beforeBlockId: null, depth: 0 } } }
      const source = hostsWorkingBefore.find(host => host.documentId === f.hostId)!
      const host = service.open(hostEvent, { kind: 'host', documentId: f.hostId, expectedUpdatedAt: source.expectedPersistedUpdatedAt, openRequestId: randomUUID() })
      const hostWorking = { kind: 'host' as const, ...source.workingBefore }
      const method = 'applySyncedHostStructure' as const
      const hostDraft: EditorRecoveryDraftInput = { draftSessionId: host.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
        working: hostWorking, sources: [], selection: null, composing: false, importing: false,
        pending: [{ method, clientOperationId, inputJson: JSON.stringify(input), requestHash: hostHash({ method, input }), submittedWorking: hostWorking }] }
      assert.throws(() => service.write(hostEvent, { records: [{ ...hostDraft, crossMoveGroupHead: groupHead }] }, { kind: 'background' }), /recovery/i)
      const [{ draftSessionId: _hostSession, ...hostHead }] = service.write(hostEvent, { records: [hostDraft] }, { kind: 'background' }).records
      assert.equal(Boolean(side.read(hostHead).crossMoveGroupHead), true)
      assert.throws(() => side.readReceipt(groupReceipt.receiptId), /receipt absent/)
      assert.equal(service.read(hostEvent, hostHead).canonicalCrossMoveRecovery, undefined, 'An uncommitted nonce is never prepared')

      const result = f.store.invokeSyncedEditingSession(hostEvent.senderFrame!, { sessionId: hostSource.session.sessionId, method, input })
      assert.ok(result.status === 'applied' && result.historyToken, JSON.stringify(result))
      assert.equal(result.groups[0].revision, baseline.snapshot.revision)
      assert.deepEqual(result.groups[0].history, baseline.snapshot.history)

      writeFileSync(join(f.userDataRoot, 'cross-move-recovery-seed.json'), JSON.stringify({
        groupId: f.groupId, instanceId: f.instanceId, targetId: f.targetId, raw: f.raw, hostHead
      }))
    } finally { service.dispose(); side.close() }
} finally { f.close() }
}
