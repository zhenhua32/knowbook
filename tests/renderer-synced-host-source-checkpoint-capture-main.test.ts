import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { DocumentDetail } from '../src/shared/contracts'
import type { SyncedStructureInput, SyncedStructureApplied } from '../src/shared/synced-blocks'
import type { SyncedEditingMethod, SyncedEditingMethods, SyncedEditingRequest } from '../src/shared/synced-editing-session'
import type { SyncedHostSourceCurrent } from '../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog'
import { acceptSyncedHostSourceCheckpoint, applySyncedHostSourceChanges, captureSyncedHostSourceSubmission,
  createSyncedHostSourceDraft, readSyncedHostSourceCheckpoint, readSyncedHostSourceSubmission,
  type SyncedHostSourceSubmission } from '../src/renderer/src/features/synced-blocks/hostSource'
import { parseSyncedBlockPayload, validateSyncedHostForest } from '../src/shared/syncedBlockValidation'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'

test('same captured parse and real Main ACK checkpoint new identities and raw CRLF changes twice without reviving a pre-A reference or accepting cloned receipts',
  () => withCanonicalSearchFixture(f => {
    const sender = Object.freeze({ sender: randomUUID() }), hostSession = Object.freeze({}), hostId = f.hostId
    let sessionId: string | null = null, sequence = 0
    const current = (document: DocumentDetail): SyncedHostSourceCurrent => ({ hostSession, editSequence: ++sequence, host: {
      documentId: document.id, expectedPersistedUpdatedAt: document.updatedAt, workingBefore: { title: document.title, summary: document.summary,
        blocks: validateSyncedHostForest(document.blocks.map(({ sortOrder: _sort, ...block }) => block)) } } })
    const open = (input: Parameters<typeof f.store.openSyncedEditingSession>[1]) => {
      const result = f.store.openSyncedEditingSession(sender, input); assert.equal(result.status, 'ready')
      if (result.status !== 'ready') throw Error('Genuine original Main session unavailable')
      sessionId = result.session.sessionId; return result
    }
    const invoke = <M extends SyncedEditingMethod>(method: M, input: SyncedEditingMethods[M]['input']) => {
      assert.ok(sessionId)
      return f.store.invokeSyncedEditingSession(sender, { sessionId, method, input } as SyncedEditingRequest<M>)
    }
    const commit = (submission: SyncedHostSourceSubmission) => {
      const prepared = readSyncedHostSourceSubmission(submission), p = f.store.getDocumentDetail(hostId); assert.ok(p)
      open({ kind: 'host', hostDocumentId: hostId })
      const ids = [...new Set([...p.blocks, ...prepared.finalAfter[0].blocks].flatMap(block => block.type === 'synced-block'
        ? [parseSyncedBlockPayload(block.content).groupId] : []))]
      const snapshots = invoke('getSyncedGroupSnapshots', { groupIds: ids }).items.map(item => {
        assert.equal(item.status, 'ready'); if (item.status !== 'ready') throw Error('Real group missing'); return item.snapshot
      })
      const instances = snapshots.flatMap(snapshot => snapshot.instances.filter(item => item.hostDocumentId === hostId)
        .map(item => ({ ...item, groupId: snapshot.groupId })))
      for (const item of instances) open({ kind: 'instance', hostDocumentId: hostId, instanceId: item.instanceId, groupId: item.groupId })
      const input: SyncedStructureInput = { clientOperationId: randomUUID(), mode: 'host-final', reason: 'source-apply', ...structuredClone(prepared),
        groups: snapshots.map(snapshot => ({ groupId: snapshot.groupId, expectedRevision: snapshot.revision, expectedTopologyRevision: snapshot.topologyRevision })),
        expectedInstances: instances.map(({ instanceId, hostDocumentId, bindingVersion }) => ({ instanceId, hostDocumentId, bindingVersion })) }
      const result = invoke('applySyncedHostStructure', input); assert.equal(result.status, 'applied')
      if (result.status !== 'applied') throw Error('Actual Main Source commit was refused')
      return { input, result: result as SyncedStructureApplied, next: current(result.hosts[0].after) }
    }
    try {
      const actual = f.store.getDocumentDetail(hostId); assert.ok(actual)
      const before = current(actual), initial = createSyncedHostSourceDraft(before.host)
      const removed = initial.references.anchors.find(anchor => anchor.instanceId === f.firstInstanceId); assert.ok(removed)
      const a = applySyncedHostSourceChanges(initial, [{ from: removed.from, to: removed.to, insert: '' },
        { from: initial.source.length, to: initial.source.length, insert: '\n\nRepeated repeated\r\nraw A' }])
      const submissionA = captureSyncedHostSourceSubmission(a)
      assert.equal(captureSyncedHostSourceSubmission(a), submissionA, 'one source value owns one exact original parse/allocation')
      const exactPreparedA = readSyncedHostSourceSubmission(submissionA)
      assert.deepEqual(Object.keys(exactPreparedA).sort(), ['finalAfter', 'hostsWorkingBefore', 'newRefSources'])
      const c = applySyncedHostSourceChanges(a, [{ from: a.source.lastIndexOf('raw A') + 3, to: a.source.lastIndexOf('raw A') + 3, insert: ' 中文🧭C' }])
      const first = commit(submissionA)
      assert.equal(first.result.hosts[0].after.blocks.some(block => block.id === f.firstInstanceId), false)
      const originalNewId = exactPreparedA.finalAfter[0].blocks.at(-1)!.id
      assert.equal(first.result.hosts[0].after.blocks.at(-1)?.id, originalNewId)
      const cp = acceptSyncedHostSourceCheckpoint(submissionA, first.input, first.result, before, first.next)
      const checkpoint = readSyncedHostSourceCheckpoint(cp), rebasedC = checkpoint.rebase(c); assert.ok(rebasedC)
      assert.equal(rebasedC.source, c.source); assert.ok(rebasedC.source.includes('\r\n'), 'raw bytes are not reconstructed from normalized CM positions')
      assert.equal(rebasedC.opening.expectedPersistedUpdatedAt, first.result.hosts[0].after.updatedAt)
      assert.equal(rebasedC.opening.workingBefore.blocks.at(-1)?.id, originalNewId)
      assert.equal(checkpoint.rebase(initial), null, 'pre-A replay cannot resurrect the removed reference with old null provenance')
      const sameTextForeignPath = applySyncedHostSourceChanges(initial, [{ from: 0, to: initial.source.length, insert: a.source }])
      assert.equal(sameTextForeignPath.source, a.source)
      assert.equal(checkpoint.rebase(sameTextForeignPath), null, 'same raw text is not a post-submit change receipt')
      assert.throws(() => readSyncedHostSourceSubmission(structuredClone(submissionA)), /original captured handle/)
      assert.throws(() => readSyncedHostSourceCheckpoint(structuredClone(cp)), /original accepted handle/)
      assert.throws(() => acceptSyncedHostSourceCheckpoint(submissionA, first.input, first.result, before,
        { ...first.next, hostSession: Object.freeze({}) }), /original Source acknowledgement/)
      assert.throws(() => acceptSyncedHostSourceCheckpoint(submissionA, first.input, first.result, before,
        { ...first.next, host: { ...first.next.host, expectedPersistedUpdatedAt: before.host.expectedPersistedUpdatedAt } }), /original Source acknowledgement/)
      const submissionC = captureSyncedHostSourceSubmission(rebasedC), preparedC = readSyncedHostSourceSubmission(submissionC)
      assert.equal(preparedC.finalAfter[0].blocks.at(-1)?.id, originalNewId)
      assert.deepEqual(preparedC.newRefSources, [])
      assert.ok(preparedC.finalAfter[0].blocks.at(-1)?.content.includes('中文🧭C'))
      const d = applySyncedHostSourceChanges(rebasedC, [{ from: rebasedC.source.length, to: rebasedC.source.length, insert: ' actual D' }])
      const second = commit(submissionC)
      assert.notEqual(second.input.clientOperationId, first.input.clientOperationId)
      assert.equal(second.input.hostsWorkingBefore[0].expectedPersistedUpdatedAt, first.result.hosts[0].after.updatedAt)
      assert.equal(second.result.hosts[0].after.blocks.at(-1)?.id, originalNewId)
      const secondCheckpoint = readSyncedHostSourceCheckpoint(acceptSyncedHostSourceCheckpoint(submissionC, second.input, second.result, first.next, second.next))
      const rebasedD = secondCheckpoint.rebase(d); assert.ok(rebasedD)
      assert.equal(rebasedD.source, d.source); assert.ok(rebasedD.source.includes('\r\n'))
      assert.equal(readSyncedHostSourceSubmission(captureSyncedHostSourceSubmission(rebasedD)).finalAfter[0].blocks.at(-1)?.id, originalNewId)
      assert.equal(secondCheckpoint.rebase(a), null, 'an earlier checkpoint cannot authorize the next accepted generation')
      assert.equal(f.store.getDocumentDetail(hostId)!.blocks.some(block => block.id === f.firstInstanceId), false)
    } finally { f.store.releaseSyncedEditingSessionsForSender(sender) }
  }))
