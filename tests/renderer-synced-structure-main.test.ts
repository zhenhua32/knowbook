import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { DocumentDetail } from '../src/shared/contracts'
import type { SyncedStructureInput, SyncedStructureApplied } from '../src/shared/synced-blocks'
import type { SyncedEditingMethod, SyncedEditingRequest, SyncedEditingResult } from '../src/shared/synced-editing-session'
import type { SyncedHostSourceCurrent } from '../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog'
import { SyncedStructureCommands } from '../src/renderer/src/features/synced-blocks/structureCommands'
import { parseSyncedBlockPayload, validateSyncedHostForest } from '../src/shared/syncedBlockValidation'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'

test('real opaque Main sessions commit UI create/insert once, recover the actual lost ACK, keep complete W and real structure history, and reject stale openings',
  () => withCanonicalSearchFixture(async f => {
    const sender = Object.freeze({ renderer: randomUUID() }), requests: SyncedStructureInput[] = [], notices: string[] = []
    let sessionId: string | null = null, droppedReply = false, droppedLookup = false, adoptCount = 0
    const original = f.store.getDocumentDetail(f.ordinaryDocumentId); assert.ok(original)
    let persisted: DocumentDetail = original
    const identity = Object.freeze({})
    let current: SyncedHostSourceCurrent = { hostSession: identity, editSequence: 1, host: {
      documentId: persisted.id, expectedPersistedUpdatedAt: persisted.updatedAt,
      workingBefore: { title: persisted.title, summary: 'complete unsaved summary', blocks: persisted.blocks.map(({ sortOrder: _sort, ...block }) => ({ ...block, content: block.content + ' unpublished W', parentBlockId: block.parentBlockId ?? null })) }
    } }
    const invoke = async <M extends SyncedEditingMethod>(method: M, input: SyncedEditingRequest<M>['input']): Promise<SyncedEditingResult<M>> => {
      assert.ok(sessionId)
      return structuredClone(f.store.invokeSyncedEditingSession(sender, { sessionId, method, input } as SyncedEditingRequest<M>))
    }
    const open = async (input: Parameters<typeof f.store.openSyncedEditingSession>[1]) => {
      const result = f.store.openSyncedEditingSession(sender, input)
      if (result.status !== 'ready') return false
      sessionId = result.session.sessionId; return true
    }
    const adopt = (before: SyncedHostSourceCurrent, result: SyncedStructureApplied) => {
      assert.equal(before.hostSession, current.hostSession); assert.equal(before.editSequence, current.editSequence)
      assert.equal(result.operationId, requests.at(-1)!.clientOperationId)
      assert.deepEqual(result.hosts[0].logicalBefore, { ...before.host.workingBefore,
        blocks: validateSyncedHostForest(before.host.workingBefore.blocks) })
      // A real Main ACK supplies this fixture's presentation state. The actual
      // React adoption callback is independently exercised by the background E2E.
      persisted = result.hosts[0].after; adoptCount++
      current = { hostSession: identity, editSequence: current.editSequence + 1, host: { documentId: persisted.id,
        expectedPersistedUpdatedAt: persisted.updatedAt, workingBefore: { title: persisted.title, summary: persisted.summary,
          blocks: persisted.blocks.map(({ sortOrder: _sort, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null })) } } }
      return true
    }
    const commands = new SyncedStructureCommands({ current: () => current, blocked: () => false, isZh: () => false,
      openHost: documentId => open({ kind: 'host', hostDocumentId: documentId }), list: input => invoke('listSyncedGroups', input),
      guards: async (documentId, extra) => {
        const actual = f.store.getDocumentDetail(documentId); assert.ok(actual)
        const ids = [...new Set([...extra, ...actual.blocks.filter(b => b.type === 'synced-block').map(b => parseSyncedBlockPayload(b.content).groupId)])]
        const result = await invoke('getSyncedGroupSnapshots', { groupIds: ids })
        const ready = result.items.map(item => { assert.equal(item.status, 'ready'); if (item.status !== 'ready') throw Error('Actual group disappeared'); return item.snapshot })
        const instances = ready.flatMap(snapshot => snapshot.instances.filter(item => item.hostDocumentId === documentId).map(item => ({ ...item, groupId: snapshot.groupId })))
        for (const item of instances) assert.equal(await open({ kind: 'instance', hostDocumentId: documentId, instanceId: item.instanceId, groupId: item.groupId }), true)
        return { groups: ready.map(snapshot => ({ groupId: snapshot.groupId, expectedRevision: snapshot.revision, expectedTopologyRevision: snapshot.topologyRevision })),
          expectedInstances: instances.map(({ instanceId, hostDocumentId, bindingVersion }) => ({ instanceId, hostDocumentId, bindingVersion })) }
      }, flushGroups: async stillCurrent => stillCurrent(),
      apply: async input => {
        requests.push(structuredClone(input))
        const result = await invoke('applySyncedHostStructure', input)
        if (!droppedReply) { droppedReply = true; assert.equal(result.status, 'applied'); throw Error('Transparent transport loss after the real SQL commit') }
        return result
      }, operation: async clientOperationId => {
        const result = await invoke('getSyncedOperation', { clientOperationId })
        if (!droppedLookup) {
          droppedLookup = true; assert.equal(result.status, 'committed')
          throw Error('Transparent transport loss after the actual Main receipt read')
        }
        return result
      }, adopt,
      changed: () => {}, notify: (zh, en) => { notices.push(en) }
    })
    try {
      const selected = current.host.workingBefore.blocks[0], submitted = structuredClone(current.host.workingBefore)
      assert.equal(await commands.openCreate([selected.id], () => true, null), true)
      assert.equal(commands.pending(), true)
      assert.equal(await commands.apply(), false)
      assert.equal(commands.pending(), true); assert.equal(requests.length, 1); assert.equal(adoptCount, 0)
      assert.deepEqual(current.host.workingBefore, submitted, 'both lost replies preserve the complete original W')
      const committed = f.store.getDocumentDetail(original.id), changesAfterCommit = f.db.prepare('SELECT total_changes() AS n').get()
      assert.equal(await commands.apply(), true)
      assert.deepEqual(f.db.prepare('SELECT total_changes() AS n').get(), changesAfterCommit, 'receipt recovery does not submit a second writer')
      assert.deepEqual(f.store.getDocumentDetail(original.id), committed)
      assert.equal(commands.pending(), false); assert.equal(requests.length, 1); assert.equal(adoptCount, 1)
      const createdInput = requests[0]; assert.equal(createdInput.mode, 'command')
      if (createdInput.mode !== 'command' || createdInput.action.kind !== 'create') throw Error('Actual create command missing')
      const createdAction = createdInput.action
      assert.deepEqual(createdInput.hostsWorkingBefore[0].workingBefore, submitted)
      assert.equal(persisted.summary, submitted.summary)
      assert.equal(persisted.blocks.some(block => block.id === selected.id || block.content.includes('unpublished W')), false)
      const reference = persisted.blocks.find(block => block.id === createdAction.instanceId); assert.ok(reference)
      assert.equal(reference.type, 'synced-block')
      const groups = await invoke('getSyncedGroupSnapshots', { groupIds: [createdAction.groupId] }), group = groups.items[0]
      assert.equal(group.status, 'ready'); if (group.status !== 'ready') throw Error('Created group missing')
      assert.equal(group.snapshot.blocks.find(block => block.id === selected.id)?.content, selected.content)
      const history = await invoke('getSyncedHostHistory', { documentId: persisted.id }); assert.ok(history.undoToken)
      const known = await invoke('getSyncedOperation', { clientOperationId: createdInput.clientOperationId })
      assert.equal(known.status, 'committed'); if (known.status !== 'committed' || !('hosts' in known.result)) throw Error('Real operation receipt missing')
      assert.equal(known.result.historyToken, history.undoToken)

      assert.equal(await commands.openInsert(null, () => true, null), true)
      const listed = commands.getSnapshot(); assert.ok(listed)
      assert.ok(listed.items.some(item => item.groupId === createdAction.groupId))
      assert.equal(commands.choose(randomUUID()), false, 'a caller-supplied group id outside the real page is not a picker choice')
      assert.equal(commands.choose(createdAction.groupId), true)
      assert.equal(await commands.apply(), true); assert.equal(requests.length, 2); assert.equal(adoptCount, 2)
      assert.equal(f.store.getDocumentDetail(persisted.id)!.blocks.filter(block => block.type === 'synced-block').length, 2)
      assert.equal(f.store.getDocumentDetail(persisted.id)!.blocks.some(block => block.id === selected.id), false)

      assert.equal(await commands.openInsert(null, () => true, null), true)
      assert.equal(commands.choose(createdAction.groupId), true)
      const retained = structuredClone(current.host)
      current = { ...current, editSequence: current.editSequence + 1 }
      assert.equal(await commands.apply(), false); assert.equal(requests.length, 2)
      assert.deepEqual(current.host, retained); assert.equal(commands.cancel(), true)
      assert.deepEqual(notices, [])
    } finally { if (sessionId) f.store.releaseSyncedEditingSession(sender, sessionId) }
  }))
