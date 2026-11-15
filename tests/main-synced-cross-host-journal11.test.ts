import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'
import { withCrossMoveDraftCheck } from '../src/main/database/synced-cross-move-draft-guard'
import { DocumentBlockMoveNeedsControlledWrite } from '../src/main/database/document-block-transfers'
import { decodeCrossHostJournal10, decodeCrossHostJournal11 } from '../src/main/database/synced-cross-host-journal4'
import { hostEncode, hostHash } from '../src/main/database/synced-host-journal'
import type { SyncedHostHistoryBranchRow } from '../src/main/database/synced-host-history-branch'
import type { HostMoveInput } from '../src/main/database/synced-host-move-plan'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import type { EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import type { SyncedEditingMethod, SyncedEditingRequest } from '../src/shared/synced-editing-session'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { restoreInput } from './helpers/synced-host-final-fixture'
import { allTables, applySyncedHostCommand, createRequest, request, snapshot, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('the dependent page rewrites its indexed ordinary link without touching its registered shared instance or its group', () => withV3Fixture(async fixture => {
  const { store, db, hostId, targetId, instanceId } = fixture
  const pageId = store.createDocument(null), linkId = randomUUID(), childId = randomUUID()
  const link = (title: string) => `Use [block][source].\n\n[source]: <${encodeURIComponent(title)}.md#^${instanceId}> "unchanged title"`
  store.updateDocument(pageId, { title: 'Registered third host', summary: '', blocks: [
    { id: linkId, type: 'paragraph', content: link('V3 Host'), checked: false, depth: 0 },
    { id: childId, type: 'paragraph', content: 'Separate shared body stays byte-for-byte', checked: false, depth: 0 }
  ] })
  const create = createRequest(db, { documentId: pageId, selectedRootIds: [childId] })
  assert.equal(applySyncedHostCommand(db, create).status, 'applied')
  const { groupId, instanceId: stationaryId } = create.action
  const stationary = () => ({ group: snapshot(db, groupId),
    block: db.prepare('SELECT * FROM blocks WHERE id=?').get(stationaryId),
    registry: db.prepare('SELECT * FROM synced_instances WHERE instance_id=?').get(stationaryId) })
  const originalStationary = stationary()
  const side = new EditorRecoveryDraftStore(join(fixture.root, 'editor-recovery'))
  try {
    const event = { sender: {}, senderFrame: {} } as EditorCloseIpcEvent, sender = event.senderFrame!
    const recovery = new EditorRecoveryDraftService(side, store, () => undefined)
    const open = (id: string) => {
      const value = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: id })
      assert.ok(value.status === 'ready')
      return value.session.sessionId
    }
    const sessionId = open(hostId); open(targetId)
    const invoke = <M extends SyncedEditingMethod>(packet: SyncedEditingRequest<M>) => withCrossMoveDraftCheck(db, recovery.crossMoveDraftCheck(event),
      () => store.invokeSyncedEditingSession<M>(sender, packet))
    const move = (ids: string[]): HostMoveInput => {
      const { clientOperationId, groups, expectedInstances, hostsWorkingBefore } = request(db, ids)
      return { clientOperationId, groups, expectedInstances, hostsWorkingBefore, mode: 'command', action: { kind: 'move',
        selection: { documentId: hostId, selectedRootIds: [instanceId] },
        target: { documentId: targetId, beforeBlockId: null, parentBlockId: null, depth: 0 } } }
    }
    const preview = () => invoke({ sessionId, method: 'prepareSyncedCrossHostMove', input: move([hostId, targetId]) })
    const apply = (input: HostMoveInput) => invoke({ sessionId, method: 'applySyncedHostStructure', input })
    const detail = store.getDocumentDetail(pageId)!
    assert.deepEqual(preview(), { status: 'ready', dependencies: [{ documentId: pageId, updatedAt: detail.updatedAt }] })
    open(pageId)
    const input = move([hostId, targetId, pageId]), before = allTables(db)
    const missing = structuredClone(input)
    missing.expectedInstances = missing.expectedInstances.filter(guard => guard.instanceId !== stationaryId)
    assert.equal(apply(missing).status, 'invalid')
    const stale = structuredClone(input)
    stale.groups.find(guard => guard.groupId === groupId)!.expectedRevision = randomUUID()
    assert.equal(apply(stale).status, 'conflict')
    assert.deepEqual(allTables(db), before)

    const producer = recovery.open(event, { kind: 'host', documentId: pageId, openRequestId: randomUUID(), expectedUpdatedAt: detail.updatedAt })
    const draft = { draftSessionId: producer.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: { ...producer.base.persistedWorking, summary: 'Independent parked host W' }, sources: [], pending: [], selection: null, composing: false, importing: false }
    const { recordId, generation, hash } = recovery.write(event, { records: [draft] }, { kind: 'background' }).records[0]
    const expectedHead = { recordId, generation, hash }
    recovery.park(event, { draftSessionId: producer.draftSessionId, expectedHead })
    assert.equal(preview().status, 'unsupported')
    assert.equal(apply(input).status, 'conflict')
    assert.deepEqual(side.head(producer.draftSessionId)?.record.draft.working, draft.working)
    assert.deepEqual(allTables(db), before)
    recovery.releaseSender(event.sender); side.decide(expectedHead, 'discard')

    const moved = apply(input)
    assert.ok(moved.status === 'applied' && moved.historyToken, JSON.stringify(moved))
    const token = moved.historyToken
    assert.equal(store.getDocumentDetail(pageId)!.blocks[0].content, link('V3 Target'))
    assert.deepEqual(stationary(), originalStationary)
    await withCapsule2RawCopy(fixture, reader => reader.transaction(() => {
      const workspace = readRawCapsule2WorkspaceHistoryOwned(reader)
      assert.ok(workspace.historyDocuments.includes(pageId) && workspace.historyBlocks.includes(stationaryId))
      const row = reader.prepare('SELECT * FROM synced_host_history WHERE id=?').get(token) as SyncedHostHistoryBranchRow
      const journal = decodeCrossHostJournal11(row), packet = JSON.parse(row.action_json)
      assert.deepEqual(journal.crossMove.outsideIncoming, [pageId])
      assert.throws(() => decodeCrossHostJournal10({ ...row, action_json: hostEncode({ ...packet, version: 10 }) }))
      packet.input.expectedInstances = packet.input.expectedInstances.filter((guard: { instanceId: string }) => guard.instanceId !== stationaryId)
      const { kind, version, originalHash: _prior, ...facts } = packet
      assert.throws(() => decodeCrossHostJournal11({ ...row, action_json: hostEncode({ kind, version, ...facts, originalHash: hostHash(facts) }) }))
    })())

    for (const direction of ['undo', 'redo'] as const) {
      for (const id of [pageId, hostId, targetId]) open(id)
      const history = invoke({ sessionId, method: 'getSyncedCrossHostMoveHistory', input: { documentId: pageId } })
      assert.equal(history.find(item => item.direction === direction)?.historyToken, token)
      const result = invoke({ sessionId, method: 'restoreSyncedHostOperation', input: restoreInput(db, moved, direction) })
      assert.ok(result.status === 'applied' && result.historyToken === token, JSON.stringify(result))
      assert.equal(store.getDocumentDetail(pageId)!.blocks[0].content, link(direction === 'undo' ? 'V3 Host' : 'V3 Target'))
      assert.deepEqual(stationary(), originalStationary)
    }

    const canonicalSource = store.createDocument(null), canonicalChild = randomUUID()
    store.updateDocument(canonicalSource, { title: 'Canonical dependency in another host', summary: '', blocks: [{ id: canonicalChild,
      type: 'paragraph', content: `[ordinary target](V3%20Target.md#^${instanceId})`, checked: false, depth: 0 }] })
    const canonicalCreate = createRequest(db, { documentId: canonicalSource, selectedRootIds: [canonicalChild] })
    assert.equal(applySyncedHostCommand(db, canonicalCreate).status, 'applied')
    const canonicalGroup = snapshot(db, canonicalCreate.action.groupId)
    assert.deepEqual(canonicalGroup.bindings.map(binding => binding.target),
      [{ kind: 'block', documentId: targetId, id: instanceId, state: 'live' }])
    assert.equal(db.prepare('SELECT 1 FROM markdown_link_sources WHERE source_document_id=?').get(canonicalSource), undefined)

    const mounted = store.resolveSyncedInlineInstance({ hostDocumentId: canonicalSource, groupId: canonicalCreate.action.groupId,
      instanceId: canonicalCreate.action.instanceId })
    assert.ok(mounted.status === 'ready')
    const { target: _hint, ...binding } = canonicalGroup.bindings[0]
    const address = { source: mounted.instance, binding }
    const resolve = (documentId: string) => {
      const original = allTables(db)
      assert.deepEqual(store.resolveSyncedStoredBlockLink(address), { status: 'ready', kind: 'document', documentId, blockId: instanceId })
      assert.deepEqual(allTables(db), original)
    }
    resolve(targetId)
    assert.deepEqual(store.resolveSyncedStoredBlockLink({ ...address, source: { ...address.source, revision: randomUUID() } }), { status: 'stale' })
    assert.deepEqual(store.resolveSyncedStoredBlockLink({ ...address, binding: { ...binding, blockId: randomUUID() } }), { status: 'missing' })

    for (const [direction, documentId] of [['undo', hostId], ['redo', targetId]] as const) {
      for (const id of [pageId, hostId, targetId]) open(id)
      const accepted = invoke({ sessionId, method: 'restoreSyncedHostOperation', input: restoreInput(db, moved, direction) })
      assert.ok(accepted.status === 'applied' && accepted.historyToken === token, JSON.stringify(accepted))
      assert.deepEqual(snapshot(db, canonicalCreate.action.groupId), canonicalGroup)
      resolve(documentId)
    }
  } finally { side.close() }
}))

test('the ordinary transaction identifies only its actual synchronized link dependency before any writes', () => withV3Fixture(fixture => {
  const { store, db } = fixture
  const paragraph = (content: string) => ({ id: randomUUID(), type: 'paragraph' as const, content, checked: false, depth: 0 })
  const create = (title: string, blocks: ReturnType<typeof paragraph>[]) => {
    const id = store.createDocument(null)
    store.updateDocument(id, { title, summary: '', blocks })
    return id
  }
  const linked = paragraph('The incoming link targets this block'), unrelated = paragraph('No incoming link')
  const source = create('Plain Source', [linked, unrelated]), target = create('Plain Target', [paragraph('Existing target')])
  const shared = paragraph('Separate referenced shared body')
  const dependent = create('Link holder', [paragraph(`[stable link](Plain%20Source.md#^${linked.id})`), shared])
  const updatedAt = (id: string) => store.getDocumentDetail(id)!.updatedAt
  const input = (id: string) => ({ fromDocumentId: source, toDocumentId: target, blockIds: [id],
    expectedFromUpdatedAt: updatedAt(source), expectedToUpdatedAt: updatedAt(target) })
  const move = (id: string) => store.moveDocumentBlocks(input(id))
  const original = input(linked.id)
  assert.equal(store.readControlledDocumentBlockMoveDependencies(original), null)
  const registered = createRequest(db, { documentId: dependent, selectedRootIds: [shared.id] })
  assert.equal(applySyncedHostCommand(db, registered).status, 'applied')
  const before = allTables(db)
  assert.deepEqual(store.readControlledDocumentBlockMoveDependencies(input(linked.id)), {
    state: 'controlled-required', dependencies: [{ documentId: dependent, updatedAt: updatedAt(dependent) }] })
  assert.equal(store.readControlledDocumentBlockMoveDependencies(input(unrelated.id)), null)
  assert.throws(() => store.moveDocumentBlocks(original), error => {
    assert.ok(error instanceof DocumentBlockMoveNeedsControlledWrite)
    assert.deepEqual(error.dependencies, [{ documentId: dependent, updatedAt: updatedAt(dependent) }])
    return true
  })
  assert.deepEqual(allTables(db), before)
  const direct = move(unrelated.id)
  assert.equal(direct.state, 'applied')
  assert.deepEqual(new Set(direct.affectedDocumentIds), new Set([source, target]))
  assert.equal(store.undoDocumentBlockMove({ operationId: direct.operationId, expectedUpdatedAtByDocument: direct.expectedUpdatedAtByDocument }).state, 'undone')
}))
