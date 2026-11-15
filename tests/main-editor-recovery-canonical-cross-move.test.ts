import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { getSyncedGroupSnapshots } from '../src/main/database/synced-blocks-read'
import { BlockIdentityRepository } from '../src/main/database/block-identities'
import { captureCrossHostJournal4, decodeCrossHostJournal4 } from '../src/main/database/synced-cross-host-journal4'
import { withCrossMoveDraftCheck } from '../src/main/database/synced-cross-move-draft-guard'
import { readCanonicalLinkedCrossMoveJournal, readCanonicalLinkedCrossMoveOriginalOwned } from '../src/main/editor-recovery/canonical-cross-move-original4'
import type { SyncedHostHistoryBranchRow } from '../src/main/database/synced-host-history-branch'
import { readCanonicalCrossMoveOriginal4Owned } from '../src/main/editor-recovery/canonical-cross-move-original4'
import { hostHash } from '../src/main/database/synced-host-journal'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { readCanonicalRecoveryClosedFrames } from '../src/shared/editor-recovery-canonical'
import type { EditorRecoveryDraftInput, EditorRecoveryReceipt } from '../src/shared/editor-recovery-drafts'
import type { ElectronApi } from '../src/shared/contracts'
import type { SyncedEditingMethod, SyncedEditingRequest, SyncedEditingResult } from '../src/shared/synced-editing-session'
import { syncedCanonicalEdits, validateSyncedCanonicalProjection } from '../src/shared/syncedBlockValidation'
import { addV3CrossMoveDependency, addV3OrdinaryListBranch, addV3SameGroupReference, keepOnlyV3SourceReference, randomUUID, request,
  withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { restoreInput } from './helpers/synced-host-command-move-fixture'
import { seedHotNestedCrossMove } from './helpers/hot-nested-cross-move-fixture'

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

const states = ['exact', 'different-frame', 'newer-group', 'transfer', 'renderer', 'hot', 'hot-empty', 'hot-wiki', 'hot-wiki-dirty',
  'hot-markdown', 'hot-multiple', 'hot-v9-empty', 'hot-reference', 'hot-html', 'hot-stationary', 'hot-stationary-dirty',
  'hot-nested', 'hot-nested-redo-too-deep', 'hot-list-parent', 'hot-list-parent-other-ref', 'hot-list-parent-outside',
  'hot-list-parent-redo-too-deep', 'hot-list-parent-stationary-same-group',
  'hot-shared-both-pages', 'hot-shared-foreign-redo', 'hot-shared-unproved-third-page',
  'hot-mixed-roots', 'hot-mixed-roots-stationary', 'hot-mixed-roots-outside', 'hot-mixed-forest', 'hot-mixed-forest-other-ref',
  'hot-shared-wiki', 'hot-shared-markdown', 'hot-shared-wiki-source-only', 'hot-shared-wiki-target-only',
  'hot-shared-v9-empty', 'hot-shared-v10', 'hot-shared-v11', 'hot-shared-wiki-dirty',
  'hot-shared-third-member', 'hot-shared-two-dependencies', 'hot-shared-v10-multiple', 'hot-shared-v11-multiple',
  'hot-shared-v11-multiple-group-draft', 'hot-shared-v11-multiple-host-draft', 'hot-shared-later-outside-member'] as const
const linkedCases: Partial<Record<typeof states[number], {
  version: number; links: readonly NonNullable<Parameters<typeof addV3CrossMoveDependency>[1]>[]; stationary?: true; reject?: true
}>> = {
  'hot-wiki': { version: 6, links: ['wiki'] }, 'hot-wiki-dirty': { version: 6, links: ['wiki'], reject: true },
  'hot-markdown': { version: 7, links: ['markdown'] },
  'hot-multiple': { version: 9, links: ['wiki', 'markdown'] }, 'hot-v9-empty': { version: 9, links: ['wiki'] },
  'hot-reference': { version: 10, links: ['reference'] }, 'hot-html': { version: 10, links: ['html'] },
  'hot-stationary': { version: 11, links: ['reference'], stationary: true },
  'hot-stationary-dirty': { version: 11, links: ['reference'], stationary: true, reject: true },
  'hot-shared-wiki': { version: 6, links: ['wiki'] },
  'hot-shared-markdown': { version: 7, links: ['markdown'] },
  'hot-shared-wiki-source-only': { version: 6, links: ['wiki'] },
  'hot-shared-wiki-target-only': { version: 6, links: ['wiki'] },
  'hot-shared-v9-empty': { version: 9, links: ['wiki'] },
  'hot-shared-v10': { version: 10, links: ['reference'] },
  'hot-shared-v11': { version: 11, links: ['reference'], stationary: true },
  'hot-shared-wiki-dirty': { version: 6, links: ['wiki'], reject: true },
  'hot-shared-third-member': { version: 11, links: ['wiki'], reject: true },
  'hot-shared-two-dependencies': { version: 9, links: ['wiki', 'markdown'] },
  'hot-shared-v10-multiple': { version: 10, links: ['wiki', 'reference'] },
  'hot-shared-v11-multiple': { version: 11, links: ['wiki', 'reference'], stationary: true },
  'hot-shared-v11-multiple-group-draft': { version: 11, links: ['wiki', 'reference'], stationary: true, reject: true },
  'hot-shared-v11-multiple-host-draft': { version: 11, links: ['wiki', 'reference'], stationary: true, reject: true },
  'hot-shared-later-outside-member': { version: 11, links: ['wiki', 'markdown'], reject: true }
}
for (const state of states) {
  test(`actual cold v${linkedCases[state]?.version ?? 4} recovery offers only the original durable associated W (${state})`, () => withV3Fixture(async f => {
    const emptiesSource = state === 'hot-empty' || state === 'hot-v9-empty' || state === 'hot-shared-v9-empty', spec = linkedCases[state]
    const shared = state === 'hot-shared-both-pages' || Boolean(spec && state.startsWith('hot-shared-'))
    const wrongOrigin = state === 'hot-shared-foreign-redo'
    const outsideMember = state === 'hot-shared-third-member' || state === 'hot-shared-later-outside-member'
    const largerForest = state.startsWith('hot-mixed-forest'), mixed = largerForest || state.startsWith('hot-mixed-roots')
    const mixedPositive = state === 'hot-mixed-roots' || state === 'hot-mixed-forest'
    const unprovedThird = state === 'hot-shared-unproved-third-page', parentWithStationary = state === 'hot-list-parent-stationary-same-group'
    const receives = state === 'transfer' || emptiesSource || shared || mixedPositive || Boolean(spec && !spec.reject) || state === 'hot-nested' || state === 'hot-list-parent'
    const dependencies = spec?.links.map((syntax, index) =>
      addV3CrossMoveDependency(f, syntax, { title: 'Outside link ' + index, stationary: spec.stationary && index === spec.links.length - 1 })) ?? []
    if (state === 'hot-list-parent-outside' || state === 'hot-mixed-roots-outside') dependencies.push(addV3CrossMoveDependency(f, 'wiki'))
    const [dependency] = dependencies, stationary = dependencies.find(peer => peer.stationary)?.stationary
    const stationaryFacts = (db: ReturnType<KnowbookStore['getUnsafeDatabaseHandle']>) => stationary && ({
      group: getSyncedGroupSnapshots(db, { groupIds: [stationary.groupId] }).items[0],
      registry: db.prepare('SELECT * FROM synced_instances WHERE instance_id=?').get(stationary.instanceId),
      block: db.prepare('SELECT * FROM blocks WHERE id=?').get(stationary.instanceId)
    })
    const untouched = stationaryFacts(f.db)
    const blockedForest = state === 'hot-list-parent-other-ref' || state === 'hot-list-parent-outside' || parentWithStationary || mixed && !mixedPositive
    const tooDeep = state === 'hot-nested-redo-too-deep' || state === 'hot-list-parent-redo-too-deep'
    const nested = state.startsWith('hot-list-parent') ? seedHotNestedCrossMove(f, tooDeep ? 4 : 0,
      state === 'hot-list-parent-other-ref' ? 'two-references' : 'single-reference')
      : state === 'hot-nested' || tooDeep ? seedHotNestedCrossMove(f, tooDeep ? 5 : 0) : undefined
    const targetPeer = shared && state !== 'hot-shared-wiki-source-only' || wrongOrigin || parentWithStationary || state === 'hot-mixed-roots-stationary'
      ? addV3SameGroupReference(f, f.targetId) : undefined
    const sourcePeer = shared && !emptiesSource && state !== 'hot-shared-wiki-target-only' ? addV3SameGroupReference(f, f.hostId) : undefined
    const branch = largerForest ? addV3OrdinaryListBranch(f) : undefined
    if (state === 'hot-mixed-forest-other-ref') addV3SameGroupReference(f, f.hostId)
    if (unprovedThird) addV3SameGroupReference(f, f.store.createDocument(null))
    if (outsideMember) addV3SameGroupReference(f, dependencies.at(-1)!.documentId)
    const sameGroupPeers = (db: typeof f.db) => [targetPeer, sourcePeer].flatMap(instanceId => instanceId ? [{
      binding: db.prepare('SELECT * FROM synced_instances WHERE instance_id=?').get(instanceId), identity: new BlockIdentityRepository(db).get(instanceId)
    }] : [])
    const sameGroupBefore = sameGroupPeers(f.db)
    if (emptiesSource) keepOnlyV3SourceReference(f)
    const sourceBefore = f.store.getDocumentDetail(f.hostId)!.blocks, sourceBeforeIds = sourceBefore.map(block => block.id)
    const identities = new BlockIdentityRepository(f.db)
    const births = new Map(mixedPositive ? sourceBeforeIds.map(id => [id, identities.get(id)?.createdAt]) : [])
    const assertMovedBirths = (db: typeof f.db, documentId: string) => {
      const actual = new BlockIdentityRepository(db)
      for (const [id, createdAt] of births) assert.deepEqual(actual.get(id), { id, owner: { kind: 'document', id: documentId }, state: 'live', createdAt })
    }
    const barrier = createEditorCloseBarrier({ beginShutdown() {} })
    const groupEvent = register(barrier), hostEvent = state === 'different-frame' ? register(barrier) : groupEvent
    const folder = join(f.root, 'editor-recovery'), side = new EditorRecoveryDraftStore(folder)
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
      if (tooDeep) redo.push({ ...redo[0], id: randomUUID(), parentBlockId: redo[0].id, depth: 1 })
      if (nested) assert.deepEqual([from.instance.parentBlockId, from.instance.depth], [nested.sourceParentId, 1])
      const instance = { instanceId, hostDocumentId, bindingVersion }
      const other = baseline.snapshot.instances.find(item => item.instanceId === targetPeer)
      const redoInstance = wrongOrigin && other ? { instanceId: other.instanceId, hostDocumentId: other.hostDocumentId, bindingVersion: other.bindingVersion } : instance
      const working = { kind: 'group' as const, blocks: after, incoming: null }
      const groupDraft: EditorRecoveryDraftInput = { draftSessionId: group.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
        working, sources: [], pending: [], selection: null, composing: false, importing: false,
        replayJson: JSON.stringify({ kind: 'knowbook-canonical-recovery-data', version: 2, snapshot: baseline.snapshot,
          readSource: { workspaceScope: baseline.workspaceScope, readOwnerId: baseline.readOwnerId, snapshot: baseline.snapshot, bindingSource: baseline.bindingSource },
          accepted: null, frames: [{ before: blocks, after, instance, copySources: [], sequence: 1, transactionId: randomUUID() }],
          redoFrames: [{ before: after, after: redo, instance: redoInstance, copySources: [], sequence: 2, transactionId: randomUUID() }],
          serverRedo: [], cutServerRedo: true }) }
      const groupReceipt = service.write(groupEvent, { records: [groupDraft] }, { kind: 'background' })
      const [groupHead] = groupReceipt.records

      const hostSource = f.store.openSyncedEditingSession(hostEvent.senderFrame!, { kind: 'host', hostDocumentId: f.hostId })
      const hostTarget = f.store.openSyncedEditingSession(hostEvent.senderFrame!, { kind: 'host', hostDocumentId: f.targetId })
      assert.ok(hostSource.status === 'ready' && hostTarget.status === 'ready' && hostSource.session.sessionId === hostTarget.session.sessionId)
      const participants = [f.hostId, f.targetId]
      for (const peer of dependencies) {
        assert.equal(f.store.openSyncedEditingSession(hostEvent.senderFrame!, { kind: 'host', hostDocumentId: peer.documentId }).status, 'ready')
        participants.push(peer.documentId)
      }
      const { clientOperationId, hostsWorkingBefore, groups, expectedInstances } = request(f.db, participants)
      const input = { clientOperationId, hostsWorkingBefore, groups, expectedInstances, mode: 'command' as const,
        action: { kind: 'move' as const, selection: { documentId: f.hostId, selectedRootIds: largerForest
          ? sourceBefore.filter(block => block.parentBlockId === null).map(block => block.id)
          : mixed ? [f.instanceId, f.hostBodyId] : [nested?.forest ? nested.sourceParentId : f.instanceId] },
          target: { documentId: f.targetId, parentBlockId: nested?.targetParentId ?? null, beforeBlockId: null, depth: nested?.targetDepth ?? 0 } } }
      const source = hostsWorkingBefore.find(host => host.documentId === f.hostId)!
      const host = service.open(hostEvent, { kind: 'host', documentId: f.hostId, expectedUpdatedAt: source.expectedPersistedUpdatedAt, openRequestId: randomUUID() })
      const hostWorking = { kind: 'host' as const, ...source.workingBefore }
      const method = 'applySyncedHostStructure' as const
      const hostDraft: EditorRecoveryDraftInput = { draftSessionId: host.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
        working: hostWorking, sources: [], selection: null, composing: false, importing: false,
        pending: [{ method, clientOperationId, inputJson: JSON.stringify(input), requestHash: hostHash({ method, input }), submittedWorking: hostWorking }] }
      assert.throws(() => service.write(hostEvent, { records: [{ ...hostDraft, crossMoveGroupHead: groupHead }] }, { kind: 'background' }), /recovery/i)
      const [{ draftSessionId: _hostSession, ...hostHead }] = service.write(hostEvent, { records: [hostDraft] }, { kind: 'background' }).records
      assert.equal(Boolean(side.read(hostHead).crossMoveGroupHead), state !== 'different-frame' && !blockedForest && !wrongOrigin && !unprovedThird
        && !outsideMember)
      assert.throws(() => side.readReceipt(groupReceipt.receiptId), /receipt absent/)
      assert.equal(service.read(hostEvent, hostHead).canonicalCrossMoveRecovery, undefined, 'An uncommitted nonce is never prepared')
      if (state === 'newer-group') service.write(groupEvent, { records: [{ ...groupDraft, generation: 2, expectedPreviousGeneration: 1 }] },
        { kind: 'background' })
      let outsideHead: EditorRecoveryReceipt['records'][number] | undefined
      if (state === 'hot-wiki-dirty' || state === 'hot-shared-wiki-dirty' || state === 'hot-shared-v11-multiple-host-draft') {
        const { documentId } = dependencies.at(-1)!
        const { expectedPersistedUpdatedAt, workingBefore } = hostsWorkingBefore.find(page => page.documentId === documentId)!
        const third = service.open(hostEvent, { kind: 'host', documentId, expectedUpdatedAt: expectedPersistedUpdatedAt, openRequestId: randomUUID() })
        outsideHead = service.write(hostEvent, { records: [{ ...hostDraft, draftSessionId: third.draftSessionId, pending: [],
          working: { kind: 'host', ...workingBefore, blocks: workingBefore.blocks.map(block => block.type === 'synced-block' ? block
            : { ...block, content: block.content + ' third-page W' }) } }] }, { kind: 'background' }).records[0]
      }
      if ((state === 'hot-stationary-dirty' || state === 'hot-shared-v11-multiple-group-draft') && stationary) {
        const baseline = f.store.invokeSyncedEditingSession(hostEvent.senderFrame!, { sessionId, method: 'captureBaseline', input: { groupId: stationary.groupId } })
        assert.equal(baseline.status, 'ready')
        const owner = service.open(hostEvent, { kind: 'group', groupId: stationary.groupId, sessionId, readOwnerId: baseline.readOwnerId, openRequestId: randomUUID() })
        outsideHead = service.write(hostEvent, { records: [{ ...hostDraft, draftSessionId: owner.draftSessionId, pending: [],
          working: { kind: 'group', blocks: syncedCanonicalEdits(baseline.snapshot.blocks).map(block => ({ ...block, content: block.content + ' separate W' })), incoming: null } }] },
        { kind: 'background' }).records[0]
      }

      const hotRequest = { sessionId: hostSource.session.sessionId, hostHead }
      let commits = 0
      const hotApply = () => barrier.runEditorMutation(hostEvent, () => service.applyHotCrossMove(hostEvent, hotRequest, original => {
        commits++
        return withCrossMoveDraftCheck(f.db, service.crossMoveDraftCheck(hostEvent), () =>
          f.store.invokeSyncedEditingSession(hostEvent.senderFrame!, original))
      }))
      if (tooDeep || blockedForest) {
        if (tooDeep) {
          const plan = f.db.transaction(() => decodeCrossHostJournal4(captureCrossHostJournal4(f.db, input, new Date().toISOString())))()
          const leaf = plan.after.find(page => page.documentId === f.targetId)!.content.blocks.find(block => block.id === f.instanceId)
          assert.equal(leaf?.depth, 6)
          const target = { ...from.instance, hostDocumentId: f.targetId, depth: 6, parentBlockId: leaf!.parentBlockId, parentType: 'bulleted-list' as const }
          assert.doesNotThrow(() => validateSyncedCanonicalProjection(blocks, [target]))
          assert.throws(() => validateSyncedCanonicalProjection(redo, [target]), /六层/)
        }
        const before = f.db.prepare('SELECT total_changes() AS count').get()
        assert.deepEqual(await hotApply(), { status: 'rejected' })
        assert.equal(commits, 0)
        assert.deepEqual(f.db.prepare('SELECT total_changes() AS count').get(), before)
        assert.equal(side.head(group.draftSessionId)?.expected.hash, groupHead.hash)
        assert.deepEqual(side.read(groupHead).draft, groupDraft)
        assert.deepEqual(sameGroupPeers(f.db), sameGroupBefore)
        assert.equal(f.store.getDocumentDetail(f.hostId)!.blocks.find(block => block.id === f.instanceId)?.parentBlockId, nested?.sourceParentId ?? null)
        if (mixed) assert.deepEqual(f.store.getDocumentDetail(f.hostId)!.blocks.map(block => block.id), sourceBeforeIds)
        if (state === 'hot-list-parent-other-ref') assert.ok(f.store.getDocumentDetail(f.hostId)!.blocks.some(block =>
          block.id === nested!.forest!.otherReferenceId && block.type === 'synced-block' && block.parentBlockId === nested!.sourceParentId))
        if (dependency) assert.equal(f.store.getDocumentDetail(dependency.documentId)?.blocks[0].content, dependency.before)
        return
      }
      if (spec?.reject || wrongOrigin || unprovedThird) {
        assert.deepEqual(await hotApply(), { status: 'rejected' })
        assert.equal(commits, 0)
        assert.ok(f.store.getDocumentDetail(f.hostId)?.blocks.some(block => block.id === f.instanceId))
        for (const peer of dependencies) assert.equal(f.store.getDocumentDetail(peer.documentId)?.blocks[0].content, peer.before)
        if (outsideHead) assert.equal(side.head(outsideHead.draftSessionId)?.expected.hash, outsideHead.hash)
        assert.deepEqual(side.read(groupHead).draft, groupDraft)
        return
      }
      const moved = state === 'hot' || emptiesSource || shared || spec || mixedPositive || state === 'hot-nested' || state === 'hot-list-parent' ? await hotApply() : undefined
      if (moved) {
        assert.equal(moved.status, 'moved')
        assert.deepEqual(await hotApply(), moved)
        assert.equal(commits, 1)
        assert.equal(service.activeDraftSessionIds(hostEvent).length, 0)
      }
      if (state === 'different-frame' || state === 'newer-group') {
        assert.deepEqual(await hotApply(), { status: 'rejected' })
        assert.equal(commits, 0)
      }
      const result = moved?.status === 'moved' ? moved.result
        : f.store.invokeSyncedEditingSession(hostEvent.senderFrame!, { sessionId: hostSource.session.sessionId, method, input })
      assert.ok(result.status === 'applied' && result.historyToken, JSON.stringify(result))
      const movedGroup = result.groups.find(group => group.groupId === f.groupId)
      assert.ok(movedGroup)
      assert.equal(movedGroup.revision, baseline.snapshot.revision)
      assert.deepEqual(movedGroup.history, baseline.snapshot.history)
      assert.deepEqual(stationaryFacts(f.db), untouched)
      if (mixedPositive) {
        const journal = f.db.prepare('SELECT * FROM synced_host_history WHERE id=?').get(result.historyToken) as SyncedHostHistoryBranchRow
        const original = decodeCrossHostJournal4(journal), [baseline] = group.base.originals
        assert.deepEqual(original.crossMove.transfers.map(item => item.blockId), sourceBeforeIds)
        assert.deepEqual(result.affectedInstanceIds, [f.instanceId])
        assertMovedBirths(f.db, f.targetId)
        if (branch) {
          assert.deepEqual(input.action.selection.selectedRootIds, [f.hostBodyId, f.instanceId, branch.root])
          assert.deepEqual(f.store.getDocumentDetail(f.targetId)!.blocks.filter(block => sourceBeforeIds.includes(block.id))
            .map(({ id, parentBlockId, depth }) => ({ id, parentBlockId, depth })), sourceBefore.map(({ id, parentBlockId, depth }) => ({ id, parentBlockId, depth })))
        }
        const rollback = new Error('restore the proved ordinary physical birth')
        assert.throws(f.db.transaction(() => {
          const changed = '2099-01-01T00:00:00.000Z'
          const ordinaryId = branch?.leaf ?? f.hostBodyId
          f.db.exec('DROP TRIGGER trg_synced_blocks_identity_update_guard; DROP TRIGGER trg_synced_identity_update_consistency')
          assert.equal(f.db.prepare('UPDATE blocks SET created_at=? WHERE id=?').run(changed, ordinaryId).changes, 1)
          assert.equal(f.db.prepare('UPDATE block_identities SET created_at=? WHERE id=?').run(changed, ordinaryId).changes, 1)
          assert.throws(() => readCanonicalCrossMoveOriginal4Owned(f.db, { operationId: clientOperationId,
            requestHash: hostHash({ method: 'applySyncedHostCommand', input }), baselineKey: baseline.key, baselineHash: baseline.requestHash }, f.instanceId), /cannot be proved/)
          throw rollback
        }), error => error === rollback)
      }
      if (nested) assert.deepEqual(movedGroup.instances.map(item => [item.hostDocumentId, item.parentBlockId, item.depth, item.parentType]),
        [[f.targetId, nested.forest ? nested.sourceParentId : nested.targetParentId, nested.targetDepth + (nested.forest ? 1 : 0), 'bulleted-list']])
      if (nested?.forest) {
        assert.deepEqual(f.store.getDocumentDetail(f.hostId)?.blocks.map(block => block.id), [nested.forest.outsideId])
        const movedIds = new Set([nested.sourceParentId, f.instanceId, nested.forest.childId])
        assert.deepEqual(f.store.getDocumentDetail(f.targetId)?.blocks.filter(block => movedIds.has(block.id))
          .map(({ id, parentBlockId, depth }) => [id, parentBlockId, depth]), [
          [nested.sourceParentId, nested.targetParentId, nested.targetDepth], [f.instanceId, nested.sourceParentId, nested.targetDepth + 1],
          [nested.forest.childId, nested.sourceParentId, nested.targetDepth + 1]
        ])
      }
      assert.deepEqual(sameGroupPeers(f.db), sameGroupBefore)
      if (shared) {
        const [original] = group.base.originals
        const read = dependency ? readCanonicalLinkedCrossMoveOriginalOwned : readCanonicalCrossMoveOriginal4Owned
        const prove = () => read(f.db, { operationId: clientOperationId,
          requestHash: hostHash({ method: 'applySyncedHostCommand', input }), baselineKey: original.key, baselineHash: original.requestHash })
        const proof = f.db.transaction(prove)()
        assert.equal(proof.kind, `canonical-cross-move-original${spec?.version ?? 4}-multi-instance`)
        assert.deepEqual(proof.beforeInstances, baseline.snapshot.instances)
        const rollback = new Error('rollback the same-group stationary binding drift')
        assert.throws(f.db.transaction(() => {
          assert.equal(f.db.prepare('UPDATE synced_instances SET binding_version=? WHERE instance_id=?').run(randomUUID(), sourcePeer ?? targetPeer).changes, 1)
          assert.throws(prove, /cannot be proved/)
          throw rollback
        }), error => error === rollback)
        if (state === 'hot-shared-wiki') assert.throws(f.db.transaction(() => {
          const changed = '2099-01-01T00:00:00.000Z'
          f.db.exec('DROP TRIGGER trg_synced_blocks_identity_update_guard; DROP TRIGGER trg_synced_identity_update_consistency')
          assert.equal(f.db.prepare('UPDATE blocks SET created_at=? WHERE id=?').run(changed, sourcePeer).changes, 1)
          assert.equal(f.db.prepare('UPDATE block_identities SET created_at=? WHERE id=?').run(changed, sourcePeer).changes, 1)
          assert.deepEqual(getSyncedGroupSnapshots(f.db, { groupIds: [f.groupId] }).items[0], { status: 'ready', snapshot: movedGroup })
          assert.throws(prove, /cannot be proved/)
          throw rollback
        }), error => error === rollback)
      }
      if (dependency) {
        const journal = f.db.prepare('SELECT * FROM synced_host_history WHERE id=?').get(result.historyToken) as SyncedHostHistoryBranchRow
        const { version, dependents } = readCanonicalLinkedCrossMoveJournal(journal)
        assert.equal(version, spec?.version)
        assert.deepEqual(dependents.map(page => page.documentId).sort(), dependencies.map(peer => peer.documentId).sort())
        for (const peer of dependencies) assert.equal(f.store.getDocumentDetail(peer.documentId)?.blocks[0].content, peer.after)
        if (stationary) {
          const [original] = group.base.originals
          const prove = () => readCanonicalLinkedCrossMoveOriginalOwned(f.db, { operationId: clientOperationId,
            requestHash: hostHash({ method: 'applySyncedHostCommand', input }), baselineKey: original.key, baselineHash: original.requestHash })
          const rollback = new Error('rollback the unrelated binding drift probe')
          assert.throws(f.db.transaction(() => {
            assert.equal(f.db.prepare('UPDATE synced_instances SET binding_version=? WHERE instance_id=?').run(randomUUID(), stationary.instanceId).changes, 1)
            assert.throws(prove, /cannot be proved/)
            throw rollback
          }), error => error === rollback)
          if (dependencies.length > 1) assert.throws(f.db.transaction(() => {
            const birth = '2099-01-01T00:00:00.000Z'
            f.db.exec('DROP TRIGGER trg_synced_blocks_identity_update_guard; DROP TRIGGER trg_synced_identity_update_consistency')
            assert.equal(f.db.prepare('UPDATE blocks SET created_at=? WHERE id=?').run(birth, stationary.instanceId).changes, 1)
            assert.equal(f.db.prepare('UPDATE block_identities SET created_at=? WHERE id=?').run(birth, stationary.instanceId).changes, 1)
            assert.deepEqual(stationaryFacts(f.db)?.group, untouched?.group)
            assert.throws(prove, /cannot be proved/)
            throw rollback
          }), error => error === rollback)
        }
      }
      const sourceAfter = f.store.getDocumentDetail(f.hostId)!, placeholder = emptiesSource || mixedPositive ? sourceAfter.blocks[0] : undefined
      const oldBirth = placeholder && new BlockIdentityRepository(f.db).get(placeholder.id)?.createdAt
      if (placeholder) {
        assert.equal(sourceAfter.blocks.length, 1)
        assert.notEqual(placeholder.id, f.instanceId)
        assert.equal(placeholder.type, 'paragraph'); assert.equal(placeholder.content, '')
        assert.ok(oldBirth)
        const [original] = group.base.originals
        const readOriginal = dependency ? readCanonicalLinkedCrossMoveOriginalOwned : readCanonicalCrossMoveOriginal4Owned
        const prove = () => readOriginal(f.db, { operationId: clientOperationId,
          requestHash: hostHash({ method: 'applySyncedHostCommand', input }), baselineKey: original.key, baselineHash: original.requestHash })
        assert.equal(f.db.transaction(prove)().writePermit, false)
        const rollback = new Error('rollback altered placeholder originals')
        const corrupt = [
          () => {
            // Model an altered persisted image inside this rollback probe.
            f.db.exec('DROP TRIGGER trg_synced_blocks_identity_update_guard')
            return f.db.prepare('UPDATE blocks SET created_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z', placeholder.id).changes
          },
          () => {
            f.db.exec('DROP TRIGGER trg_synced_identity_update_consistency')
            return f.db.prepare('UPDATE block_identities SET last_owner_id=? WHERE id=?').run(f.targetId, placeholder.id).changes
          }
        ]
        for (const change of corrupt) assert.throws(f.db.transaction(() => {
          assert.equal(change(), 1)
          assert.throws(prove, /cannot be proved/)
          throw rollback
        }), error => error === rollback)
      }
      service.dispose(); side.close(); f.close()

      const cold = KnowbookStore.openCanonicalRuntime(f.file)
      try {
        const coldSide = new EditorRecoveryDraftStore(folder, { readonly: !receives && state !== 'renderer' })
        const coldBarrier = createEditorCloseBarrier({ beginShutdown() {} }), coldEvent = register(coldBarrier)
        const coldService = new EditorRecoveryDraftService(coldSide, cold, event => coldBarrier.assertEditorMutationAllowed(event))
        try {
          const db = cold.getUnsafeDatabaseHandle(), before = db.prepare('SELECT total_changes() AS count').get()
          const candidate = coldService.read(coldEvent, hostHead)
          assert.equal(candidate.mode, 'view-only')
          assert.equal(candidate.writePermit, false)
          assert.deepEqual(candidate.pending, [{ clientOperationId, status: 'committed-attested' }])
          assert.throws(() => coldService.decide(coldEvent, candidate.recoveryOwnerId, 'restore-draft'), /explicit review/)
          if (state === 'exact' || receives || state === 'renderer' || state === 'hot') {
            const prepared = candidate.canonicalCrossMoveRecovery
            assert.ok(prepared)
            assert.equal(prepared.writePermit, false)
            assert.equal(prepared.hostDocumentId, f.targetId)
            assert.equal(prepared.instanceId, shared ? f.instanceId : undefined)
            assert.match(prepared.proofHash, /^[a-f0-9]{64}$/)
            assert.deepEqual(coldSide.read(prepared.group).draft, groupDraft)
            assert.deepEqual(db.prepare('SELECT total_changes() AS count').get(), before)
            if (receives) {
              const arrival = cold.openSyncedEditingSession(coldEvent.senderFrame!, { kind: 'instance', hostDocumentId: f.targetId,
                groupId: f.groupId, instanceId: f.instanceId })
              assert.ok(arrival.status === 'ready' && arrival.instance)
              const sessionId = arrival.session.sessionId
              const arrivalBaseline = cold.invokeSyncedEditingSession(coldEvent.senderFrame!, { sessionId, method: 'captureBaseline', input: { groupId: f.groupId } })
              assert.ok(arrivalBaseline.status === 'ready')
              const target = coldService.open(coldEvent, { kind: 'group', groupId: f.groupId, sessionId, readOwnerId: arrivalBaseline.readOwnerId, openRequestId: randomUUID() })
              const { hostDocumentId, instanceId, bindingVersion } = arrival.instance
              const moved = { instanceId, hostDocumentId, bindingVersion }
              const transfer = { recoveryOwnerId: candidate.recoveryOwnerId, sessionId, instance: moved, targetDraftSessionId: target.draftSessionId, proofHash: prepared.proofHash }
              if (shared && targetPeer) {
                const stationary = cold.openSyncedEditingSession(coldEvent.senderFrame!, { kind: 'instance', hostDocumentId: f.targetId,
                  groupId: f.groupId, instanceId: targetPeer })
                assert.ok(stationary.status === 'ready' && stationary.instance && stationary.session.sessionId === sessionId)
                assert.throws(() => coldService.prepareGroupCrossMove(coldEvent, { ...transfer, instance: { ...moved,
                  instanceId: targetPeer, bindingVersion: stationary.instance!.bindingVersion } }), /mounted occurrence changed/)
              }
              assert.throws(() => coldService.prepareGroupCrossMove(coldEvent, { ...transfer, proofHash: '0'.repeat(64) }), /no longer proves/)
              assert.throws(() => coldService.prepareGroupCrossMove(coldEvent, { ...transfer, instance: { ...moved, bindingVersion: randomUUID() } }), /not read in this actual host session/)
              assert.equal(coldSide.head(target.draftSessionId), null)
              assert.equal(coldSide.head(group.draftSessionId)?.expected.hash, groupHead.hash)
              const clean = db.prepare('SELECT total_changes() AS count').get()
              const received = coldService.prepareGroupCrossMove(coldEvent, transfer)
              assert.deepEqual(received, coldService.prepareGroupCrossMove(coldEvent, transfer), 'Exact lost response replay')
              const anotherWindow = register(coldBarrier), offered = coldService.read(anotherWindow, received.head)
              assert.throws(() => coldService.decide(anotherWindow, offered.recoveryOwnerId, 'discard'), /actual live or dormant/)
              assert.throws(() => coldService.prepareGroup(anotherWindow, { recoveryOwnerId: offered.recoveryOwnerId, sessionId }), /receiving producer/)
              assert.equal(coldService.list(anotherWindow, { limit: 20 }).records.some(item => item.recordId === received.head.recordId), false)
              assert.deepEqual(db.prepare('SELECT total_changes() AS count').get(), clean)
              assert.equal(coldSide.head(group.draftSessionId), null)
              assert.equal(coldSide.read(hostHead).draft.pending[0].clientOperationId, clientOperationId)
              assert.equal(coldService.read(coldEvent, hostHead).canonicalCrossMoveRecovery, undefined)
              assert.equal(received.writePermit, false)
              assert.deepEqual(received.record.draft.working, groupDraft.working)
              assert.deepEqual(received.baseline, arrivalBaseline.snapshot)
              const read = readCanonicalRecoveryClosedFrames(received.record, received.baseline, target.base.workspaceScope)
              assert.deepEqual(read.frames[0].instance, moved)
              assert.deepEqual(read.frames[0].after, after)
              assert.deepEqual(read.redoFrames[0].instance, moved)
              assert.deepEqual(read.redoFrames[0].after, redo)
              const reopened = new EditorRecoveryDraftStore(folder, { readonly: true })
              try {
                assert.equal(reopened.head(group.draftSessionId), null)
                assert.deepEqual(reopened.read(received.head), received.record)
              } finally { reopened.close() }
              const first = cold.invokeSyncedEditingSession(coldEvent.senderFrame!, { sessionId, method: 'updateSyncedBlockGroup', input: {
                clientOperationId: randomUUID(), groupId: f.groupId, expectedInstanceBinding: moved, expectedRevision: received.baseline.revision,
                expectedTopologyRevision: received.baseline.topologyRevision, blocks: read.frames[0].after
              } })
              assert.ok(first.status === 'saved')
              assert.deepEqual(sameGroupPeers(db), sameGroupBefore)
              assert.throws(() => coldService.prepareGroupCrossMove(coldEvent, transfer), /receiving group changed/)
              if (dependency) {
                const peer = cold.getDocumentDetail(dependency.documentId)!
                const opened = coldService.open(coldEvent, { kind: 'host', documentId: peer.id, expectedUpdatedAt: peer.updatedAt, openRequestId: randomUUID() })
                let generation = 0
                const reverse = (direction: 'undo' | 'redo') => {
                  for (const hostDocumentId of participants) {
                    const current = cold.openSyncedEditingSession(coldEvent.senderFrame!, { kind: 'host', hostDocumentId })
                    assert.equal(current.status, 'ready')
                    assert.equal(current.session.sessionId, sessionId)
                  }
                  const inverse = restoreInput(db, result, direction)
                  const working = { kind: 'host' as const, ...request(db, [peer.id]).hostsWorkingBefore[0].workingBefore }
                  const method = 'restoreSyncedHostOperation' as const
                  coldService.write(coldEvent, { records: [{ ...hostDraft, draftSessionId: opened.draftSessionId,
                    expectedPreviousGeneration: generation, generation: ++generation, working,
                    pending: [{ method, clientOperationId: inverse.clientOperationId, inputJson: JSON.stringify(inverse),
                      requestHash: hostHash({ method, input: inverse }), submittedWorking: working }] }] }, { kind: 'background' })
                  const reply = withCrossMoveDraftCheck(db, coldService.crossMoveDraftCheck(coldEvent), () =>
                    cold.invokeSyncedEditingSession(coldEvent.senderFrame!, { sessionId, method, input: inverse }))
                  assert.ok(reply.status === 'applied' && reply.historyToken === result.historyToken, JSON.stringify(reply))
                }
                reverse('undo')
                for (const peer of dependencies) assert.equal(cold.getDocumentDetail(peer.documentId)?.blocks[0].content, peer.before)
                assert.ok(cold.getDocumentDetail(f.hostId)?.blocks.some(block => block.id === f.instanceId))
                assert.deepEqual(stationaryFacts(db), untouched)
                reverse('redo')
                for (const peer of dependencies) assert.equal(cold.getDocumentDetail(peer.documentId)?.blocks[0].content, peer.after)
                assert.ok(cold.getDocumentDetail(f.targetId)?.blocks.some(block => block.id === f.instanceId))
                assert.deepEqual(stationaryFacts(db), untouched)
              }
              if (placeholder && !dependency) {
                const source = cold.openSyncedEditingSession(coldEvent.senderFrame!, { kind: 'host', hostDocumentId: f.hostId })
                assert.equal(source.status, 'ready')
                const reverse = (direction: 'undo' | 'redo') => {
                  for (const hostDocumentId of [f.hostId, f.targetId]) {
                    const current = cold.openSyncedEditingSession(coldEvent.senderFrame!, { kind: 'host', hostDocumentId })
                    assert.equal(current.status, 'ready')
                    assert.equal(current.session.sessionId, source.session.sessionId)
                  }
                  return cold.invokeSyncedEditingSession(coldEvent.senderFrame!, {
                    sessionId: source.session.sessionId, method: 'restoreSyncedHostOperation', input: restoreInput(db, result, direction)
                  })
                }
                const reversed = reverse('undo')
                assert.ok(reversed.status === 'applied' && reversed.historyToken === result.historyToken)
                assert.deepEqual(cold.getDocumentDetail(f.hostId)?.blocks.map(block => block.id), sourceBeforeIds)
                const repo = new BlockIdentityRepository(db)
                assert.equal(repo.get(placeholder.id)?.state, 'retained')
                assertMovedBirths(db, f.hostId)
                const redone = reverse('redo')
                assert.ok(redone.status === 'applied' && redone.historyToken === result.historyToken)
                assert.deepEqual(cold.getDocumentDetail(f.hostId)?.blocks, [placeholder])
                assert.deepEqual(repo.get(placeholder.id), { id: placeholder.id, createdAt: oldBirth, owner: { kind: 'document', id: f.hostId }, state: 'live' })
                assert.deepEqual(db.prepare('SELECT document_id,created_at FROM blocks WHERE id=?').get(placeholder.id),
                  { document_id: f.hostId, created_at: oldBirth })
                assertMovedBirths(db, f.targetId)
              }
              if (placeholder && dependency) assert.deepEqual(db.prepare('SELECT document_id,created_at FROM blocks WHERE id=?').get(placeholder.id),
                { document_id: f.hostId, created_at: oldBirth })
            }
            if (state === 'renderer') {
              const { getCanonicalInlineRuntime } = await import('../src/renderer/src/features/synced-blocks/inlineRuntime')
              const { acceptSyncedCanonicalRecoveryReview } = await import('../src/renderer/src/features/synced-blocks/controller')
              const detail = cold.getDocumentDetail(f.targetId)!
              const current = { hostSession: Object.freeze({}), editSequence: 0, host: { documentId: f.targetId,
                expectedPersistedUpdatedAt: detail.updatedAt, workingBefore: { title: detail.title, summary: detail.summary,
                  blocks: detail.blocks.map(({ sortOrder: _order, ...block }) => block) } } }
              let transfers = 0
              const api: Pick<ElectronApi, 'openSyncedEditingSession' | 'invokeSyncedEditingSession' | 'releaseSyncedEditingSession'
                | 'onSyncedBlocksChanged' | 'onWorkspaceMutated' | 'openEditorRecoveryDraft' | 'prepareEditorRecoveryCrossMove'
                | 'writeEditorRecoveryDrafts' | 'parkEditorRecoveryDraft'> = {
                openSyncedEditingSession: async input => cold.openSyncedEditingSession(coldEvent.senderFrame!, input),
                invokeSyncedEditingSession: async <M extends SyncedEditingMethod>(input: SyncedEditingRequest<M>): Promise<SyncedEditingResult<M>> =>
                  cold.invokeSyncedEditingSession(coldEvent.senderFrame!, input),
                releaseSyncedEditingSession: async id => cold.releaseSyncedEditingSession(coldEvent.senderFrame!, id),
                onSyncedBlocksChanged: () => () => {}, onWorkspaceMutated: () => () => {},
                openEditorRecoveryDraft: async input => coldService.open(coldEvent, input),
                prepareEditorRecoveryCrossMove: async input => {
                  const result = coldService.prepareGroupCrossMove(coldEvent, input)
                  if (++transfers === 1) throw new Error('Actual receiving journal committed before the reply was lost')
                  return result
                },
                writeEditorRecoveryDrafts: async input => coldService.write(coldEvent, { records: input.records }, { kind: 'background' }),
                parkEditorRecoveryDraft: async input => coldService.park(coldEvent, input)
              }
              const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
              Object.defineProperty(globalThis, 'window', { configurable: true, value: { knowbook: api } })
              const runtime = getCanonicalInlineRuntime()
              runtime.configure({ getCurrent: () => current, getPersisted: () => detail, adopt: () => false, adoptHistory: () => false,
                flushHost: async () => false, navigateHost: async () => false, selectedHostId: () => f.targetId, notify: () => {}, isZh: false })
              try {
                const mount = await runtime.bind({ hostDocumentId: f.targetId, hostSession: current.hostSession, instanceId: f.instanceId,
                  groupId: f.groupId, parentBlockId: null, depth: 0, mountEpoch: Object.freeze({}), root: () => null, isCurrent: () => true })
                assert.ok(mount)
                assert.ok(mount.binding.isCurrent())
                assert.equal(await runtime.restoreRecoveryGroup(candidate.recoveryOwnerId, f.groupId, current, { proofHash: prepared.proofHash }), true)
                assert.equal(transfers, 2)
                assert.equal(coldSide.head(group.draftSessionId), null)
                assert.equal(mount.binding.getCurrent().recoveryReview, true)
                assert.deepEqual(mount.binding.getCurrent().working, after)
                assert.deepEqual(getSyncedGroupSnapshots(db, { groupIds: [f.groupId] }).items[0],
                  { status: 'ready', snapshot: movedGroup })
                assert.equal(await mount.binding.redo(), true)
                assert.deepEqual(mount.binding.getCurrent().working, redo)
                assert.equal(await mount.binding.undo(), true)
                assert.deepEqual(mount.binding.getCurrent().working, after)
                assert.equal(acceptSyncedCanonicalRecoveryReview(mount.binding), true)
                assert.equal(await mount.group.flush(), true)
                assert.deepEqual(syncedCanonicalEdits(mount.binding.getCurrent().snapshot.blocks), after)
                runtime.unbind(mount)
              } finally {
                runtime.freeze(randomUUID())
                if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
                else Reflect.deleteProperty(globalThis, 'window')
              }
            }
          } else assert.equal(candidate.canonicalCrossMoveRecovery, undefined)
          if (!receives && state !== 'renderer') assert.deepEqual(db.prepare('SELECT total_changes() AS count').get(), before)
        } finally { coldService.dispose(); coldSide.close() }
      } finally { cold.destroy() }
    } finally { service.dispose(); side.close() }
  }))
}
