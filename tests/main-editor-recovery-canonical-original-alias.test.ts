import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import test from 'node:test'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { verifyCanonicalOriginalAlias } from '../src/main/editor-recovery/canonical-copy-original'
import type { EditorRecoveryDraftInput } from '../src/shared/editor-recovery-drafts'
import { decodeCanonicalRecoveryData } from '../src/shared/editor-recovery-canonical'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { allTables, withV3Fixture } from './helpers/synced-backup-v3-fixture'

class Contents extends EventEmitter {
  readonly id = 12
  readonly mainFrame = { processId: 102, routingId: 202, detached: false }
  isDestroyed() { return false }
  getOSProcessId() { return 302 }
  send() {}
}
class FixtureWindow extends EventEmitter {
  readonly webContents = new Contents()
  isDestroyed() { return false }
  close() {}
}

test('the durable Main alias digest authenticates each old entry to its exact Key and rejects a swap within the same genuine URL and key set', () => withV3Fixture(f => {
  const barrier = createEditorCloseBarrier({ beginShutdown() {} }), window = new FixtureWindow()
  barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const side = new EditorRecoveryDraftStore(join(f.root, 'alias-side'))
  const service = new EditorRecoveryDraftService(side, f.store, input => barrier.assertEditorMutationAllowed(input))
  try {
    const session = f.store.openSyncedEditingSession(event.senderFrame!, { kind: 'instance', hostDocumentId: f.hostId, instanceId: f.instanceId, groupId: f.groupId })
    if (session.status !== 'ready') throw new Error('Actual group session required')
    const sessionId = session.session.sessionId, snapshot = session.snapshot
    if (!snapshot) throw new Error('Actual group snapshot required')
    const instance = snapshot.instances[0]
    const { target: _target, ...existing } = snapshot.bindings[0]
    const offset = (f.raw + ' and ').length
    const secondKey = { ...existing, from: existing.from + offset, to: existing.to + offset }
    const actual = f.store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'updateSyncedBlockGroup', input: {
      clientOperationId: randomUUID(), groupId: f.groupId, expectedRevision: snapshot.revision, expectedTopologyRevision: snapshot.topologyRevision,
      expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
      blocks: syncedCanonicalEdits(snapshot.blocks).map(block => ({ ...block, content: f.raw + ' and ' + f.raw.replace('[target]', '[second]') })),
      bindingClaims: [{ kind: 'continue', source: existing, destination: existing },
        { kind: 'copy', source: { kind: 'current', key: existing }, destination: secondKey }]
    } })
    assert.equal(actual.status, 'saved')
    const original = f.store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'captureBaseline', input: { groupId: f.groupId } })
    if (original.status !== 'ready') throw new Error('Actual original source required')
    assert.equal(original.bindingSource.entries.length, 2)
    const draftOwner = service.open(event, { kind: 'group', groupId: f.groupId, sessionId, readOwnerId: original.readOwnerId, openRequestId: randomUUID() })
    const { status: _status, ...readSource } = original, blocks = syncedCanonicalEdits(original.snapshot.blocks)
    const [destination, originalCopy] = original.bindingSource.entries
    const held = { ticketId: original.bindingSource.ticketId, entryId: originalCopy.entryId }
    const replay = { kind: 'knowbook-canonical-recovery-data', version: 2, snapshot: original.snapshot, readSource, accepted: null,
      frames: [{ before: blocks, after: blocks, copySources: [held], instance: { instanceId: instance.instanceId,
        hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion }, transactionId: randomUUID(), sequence: 1,
        bindingClaims: [{ kind: 'copy', source: { kind: 'ticket', ...held }, destination: destination.key },
          { kind: 'continue', source: originalCopy.key, destination: originalCopy.key }] }], redoFrames: [], serverRedo: [], cutServerRedo: true }
    const draft: EditorRecoveryDraftInput = { draftSessionId: draftOwner.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: { kind: 'group', blocks, incoming: null }, pending: [], sources: [], selection: null, composing: false, importing: false,
      canonicalReadOwnerId: original.readOwnerId, replayJson: JSON.stringify(replay) }
    const before = allTables(f.db), changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const first = service.write(event, { records: [draft] }, { kind: 'background' }).records[0]
    const recorded = side.read({ recordId: first.recordId, generation: first.generation, hash: first.hash })
    assert.match(recorded.canonicalOriginalAliasHash ?? '', /^[a-f0-9]{64}$/)
    assert.equal(verifyCanonicalOriginalAlias(recorded), true)
    const cold = service.read(event, { recordId: first.recordId, generation: first.generation, hash: first.hash })
    const prepared = service.prepareGroup(event, { sessionId, recoveryOwnerId: cold.recoveryOwnerId })
    assert.equal(prepared.canonicalOriginalAliasVerified, true)
    assert.equal(prepared.baseline.status, 'ready')
    if (prepared.baseline.status !== 'ready') throw new Error('The genuine source must reopen')
    const mapped = decodeCanonicalRecoveryData(prepared.record, prepared.baseline, true).frames[0].bindingClaims?.[0]
    const expectedNew = prepared.baseline.bindingSource.entries.find(entry => entry.key.from === originalCopy.key.from)
    assert.ok(expectedNew)
    assert.deepEqual(mapped, { kind: 'copy', source: { kind: 'ticket', ticketId: prepared.baseline.bindingSource.ticketId, entryId: expectedNew.entryId }, destination: destination.key })

    const forged = structuredClone(replay), entries = forged.readSource.bindingSource.entries
    ;[entries[0].entryId, entries[1].entryId] = [entries[1].entryId, entries[0].entryId]
    const next = { ...draft, generation: 2, expectedPreviousGeneration: 1, replayJson: JSON.stringify(forged) }
    const second = service.write(event, { records: [next] }, { kind: 'background' }).records[0]
    const badRecord = side.read({ recordId: second.recordId, generation: second.generation, hash: second.hash })
    assert.equal(badRecord.canonicalOriginalAliasHash, recorded.canonicalOriginalAliasHash, 'Main commits only the actual alias hash even when the preserved raw draft is forged')
    assert.equal(verifyCanonicalOriginalAlias(badRecord), false)
    const nextCold = service.read(event, { recordId: second.recordId, generation: second.generation, hash: second.hash })
    const view = service.prepareGroup(event, { sessionId, recoveryOwnerId: nextCold.recoveryOwnerId })
    assert.equal(view.canonicalOriginalAliasVerified, undefined)
    assert.throws(() => decodeCanonicalRecoveryData(view.record, view.baseline), /sealed Main entry-to-Key proof/)
    assert.throws(() => service.write(event, { records: [{ ...next, canonicalOriginalAliasHash: recorded.canonicalOriginalAliasHash }] }, { kind: 'background' }), /closed fields/)
    f.store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'releaseOwner', input: { readOwnerId: original.readOwnerId } })
    assert.deepEqual(service.write(event, { records: [next] }, { kind: 'background' }).records[0], second,
      'Exact same-generation transport replay keeps the stored proof after the old Main read owner expires')
    assert.deepEqual(allTables(f.db), before)
    assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
  } finally { service.dispose(); side.close() }
}))
