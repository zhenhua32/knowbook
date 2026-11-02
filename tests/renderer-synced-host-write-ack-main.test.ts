import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { DocumentDetail, ElectronApi } from '../src/shared/contracts'
import type { SyncedStructureApplied, SyncedStructureInput } from '../src/shared/synced-blocks'
import type { SyncedHostSourceCurrent } from '../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog'
import { getCanonicalInlineRuntime } from '../src/renderer/src/features/synced-blocks/inlineRuntime'
import { applySyncedHostSourceChanges, createSyncedHostSourceDraft, prepareSyncedHostSourceApply } from '../src/renderer/src/features/synced-blocks/hostSource'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'
import { areDocumentDraftBlocksEqual } from '../src/renderer/src/utils/documentDraftComparison'
import { validateSyncedHostForest } from '../src/shared/syncedBlockValidation'

// Actual Store/sender/session/SQL operations and real runtime. Only transport
// reply loss is injected; the port adopts actual receipts as display state.
// This is not a React adoption or native Electron IPC oracle.
test('real host save and Source commits that remove instance fences recover the original ACK before retrying a write, and an actual epoch change cannot recover authority',
  { concurrency: false }, () => withCanonicalSearchFixture(async f => {
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), sender = Object.freeze({ sender: randomUUID() })
    const original = f.store.getDocumentDetail(f.hostId); assert.ok(original)
    let persisted: DocumentDetail = original, current: SyncedHostSourceCurrent = { hostSession: Object.freeze({}), editSequence: 1,
      host: { documentId: persisted.id, expectedPersistedUpdatedAt: persisted.updatedAt, workingBefore: { title: persisted.title,
        summary: persisted.summary, blocks: persisted.blocks.filter(block => block.id !== f.firstInstanceId)
          .map(({ sortOrder: _sort, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null })) } } }
    let dropReply = false, failLookup = false
    const applies: SyncedStructureInput[] = [], lookups: string[] = []
    const api: Pick<ElectronApi, 'openSyncedEditingSession' | 'invokeSyncedEditingSession' | 'releaseSyncedEditingSession'
      | 'onWorkspaceMutated' | 'onSyncedBlocksChanged' | 'getDocumentDetail'> = {
      openSyncedEditingSession: async input => f.store.openSyncedEditingSession(sender, input),
      releaseSyncedEditingSession: async id => f.store.releaseSyncedEditingSession(sender, id),
      getDocumentDetail: async id => f.store.getDocumentDetail(id),
      onWorkspaceMutated: () => () => {}, onSyncedBlocksChanged: () => () => {},
      invokeSyncedEditingSession: async request => {
        if (request.method === 'getSyncedOperation') {
          lookups.push((request.input as { clientOperationId: string }).clientOperationId)
        }
        const result = f.store.invokeSyncedEditingSession(sender, request)
        if (request.method === 'getSyncedOperation' && failLookup) {
          failLookup = false; assert.ok(result && typeof result === 'object' && 'status' in result); assert.equal(result.status, 'committed')
          throw Error('Transparent original receipt lookup transport loss after actual Main read')
        }
        if (request.method === 'applySyncedHostStructure') {
          applies.push(structuredClone(request.input as SyncedStructureInput))
          if (dropReply) {
            dropReply = false; assert.ok(result && typeof result === 'object' && 'status' in result)
            assert.equal(result.status, 'applied'); throw Error('Transparent reply loss after actual Main commit')
          }
        }
        return structuredClone(result)
      }
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { knowbook: api } })
    const runtime = getCanonicalInlineRuntime()
    const adopt = (before: SyncedHostSourceCurrent, result: SyncedStructureApplied) => {
      assert.equal(before.hostSession, current.hostSession); assert.equal(before.editSequence, current.editSequence)
      assert.deepEqual(result.hosts[0].logicalBefore, { ...before.host.workingBefore,
        blocks: validateSyncedHostForest(before.host.workingBefore.blocks) })
      persisted = result.hosts[0].after
      current = { ...current, editSequence: current.editSequence + 1, host: { documentId: persisted.id,
        expectedPersistedUpdatedAt: persisted.updatedAt, workingBefore: { title: persisted.title, summary: persisted.summary,
          blocks: persisted.blocks.map(({ sortOrder: _sort, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null })) } } }
      return true
    }
    const host = { getCurrent: () => current, getPersisted: () => persisted, adopt, adoptHistory: adopt,
      flushHost: async () => current.host.expectedPersistedUpdatedAt === persisted.updatedAt
        && current.host.workingBefore.title === persisted.title && current.host.workingBefore.summary === persisted.summary
        && areDocumentDraftBlocksEqual(current.host.workingBefore.blocks, persisted.blocks),
      navigateHost: async () => false, notify: () => {}, isReady: () => true, isComposing: () => false,
      canStartStructure: () => true, requiresHostSurface: () => false, isZh: false, selectedHostId: () => persisted.id }
    runtime.configure(host)
    try {
      const beforeSave = current, retainedSave = structuredClone(current.host)
      dropReply = true; failLookup = true
      await assert.rejects(() => runtime.saveHostWorking(beforeSave), /lookup transport loss/)
      assert.equal(applies.length, 1); assert.deepEqual(current.host, retainedSave)
      assert.equal(f.store.getDocumentDetail(f.hostId)!.blocks.some(block => block.id === f.firstInstanceId), false)
      assert.equal(runtime.hostSavePending(current.hostSession), true)
      const committedSave = f.store.getDocumentDetail(f.hostId), changesAfterSave = f.db.prepare('SELECT total_changes() AS n').get()
      const recovered = await runtime.saveHostWorking(beforeSave)
      assert.equal(applies.length, 1, 'spent instance fence was not retried before genuine lookup')
      assert.deepEqual(lookups, [applies[0].clientOperationId, applies[0].clientOperationId])
      assert.deepEqual(f.db.prepare('SELECT total_changes() AS n').get(), changesAfterSave)
      assert.deepEqual(f.store.getDocumentDetail(f.hostId), committedSave)
      assert.equal(runtime.hostSavePending(current.hostSession), false)
      assert.deepEqual(recovered.submitted.host, beforeSave.host)
      adopt(recovered.submitted, recovered.result)

      assert.equal(await runtime.openHostSource(null), true)
      const dialog = runtime.getSnapshot().dialog; assert.ok(dialog && dialog.kind === 'host')
      if (!dialog || dialog.kind !== 'host') throw Error('Actual Source opening missing')
      const draft = createSyncedHostSourceDraft(dialog.opening.host)
      const prepared = prepareSyncedHostSourceApply(applySyncedHostSourceChanges(draft, [{ from: 0, to: draft.source.length,
        insert: 'Actual Source A after removing original references' }]))
      dropReply = true; failLookup = true
      const retainedSource = structuredClone(current.host)
      await assert.rejects(() => runtime.applyHostSource(dialog, prepared), /lookup transport loss/)
      assert.equal(applies.length, 2); assert.deepEqual(current.host, retainedSource)
      assert.equal(f.store.getDocumentDetail(f.hostId)!.blocks.some(block => block.type === 'synced-block'), false)
      const committedSource = f.store.getDocumentDetail(f.hostId), changesAfterSource = f.db.prepare('SELECT total_changes() AS n').get()
      assert.equal(await runtime.applyHostSource(dialog, prepared), true)
      assert.equal(applies.length, 2)
      assert.deepEqual(lookups.slice(-2), [applies[1].clientOperationId, applies[1].clientOperationId])
      assert.deepEqual(f.db.prepare('SELECT total_changes() AS n').get(), changesAfterSource)
      assert.deepEqual(f.store.getDocumentDetail(f.hostId), committedSource)
      assert.equal(current.host.workingBefore.blocks[0].content, 'Actual Source A after removing original references')
      assert.equal(runtime.sourceIsCurrent(dialog), true, 'same epoch receipt did not poison the actual runtime session')
      dialog.close(); assert.equal(runtime.getSnapshot().dialog, null)

      current = { ...current, editSequence: current.editSequence + 1, host: { ...current.host, workingBefore: {
        ...current.host.workingBefore, blocks: current.host.workingBefore.blocks.map(block => ({ ...block, content: block.content + ' real epoch probe' })) } } }
      const epochOpening = current, retainedEpochW = structuredClone(current.host)
      dropReply = true; failLookup = true
      await assert.rejects(() => runtime.saveHostWorking(epochOpening), /lookup transport loss/)
      const committedEpoch = f.store.getDocumentDetail(f.hostId), callsBeforeEpoch = applies.length
      // Real schema state change, never a fabricated session/result. It must
      // invalidate today's old capability even when its old nonce committed.
      f.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
      await assert.rejects(() => runtime.saveHostWorking(epochOpening), /Synced editing session/)
      assert.equal(applies.length, callsBeforeEpoch); assert.deepEqual(current.host, retainedEpochW)
      assert.deepEqual(f.store.getDocumentDetail(f.hostId), committedEpoch)
      assert.equal(runtime.hostSavePending(epochOpening.hostSession), true)
      assert.equal(runtime.sourceIsCurrent(dialog), false)
    } finally {
      f.store.releaseSyncedEditingSessionsForSender(sender)
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  }))
