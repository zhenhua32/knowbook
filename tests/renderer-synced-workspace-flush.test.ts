import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { SyncedBlocksApi, SyncedBlocksChangedEvent, SyncedCanonicalEdit, SyncedGroupSnapshot,
  SyncedGroupSaved, SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { getSyncedWorkspaceController, flushSyncedWorkspacePendingChanges } from '../src/renderer/src/features/synced-blocks/controller'
import { syncedSnapshotGuard, type SyncedGroupBinding, type SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'

const time = '2026-10-16T00:00:00.000Z'
const paragraph = (content: string): SyncedCanonicalEdit => ({ id: 'old child\0', type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null })
function snapshot(): SyncedGroupSnapshot {
  const instanceId = randomUUID()
  return { groupId: randomUUID(), creationId: randomUUID(), createdAt: time, revision: randomUUID(), topologyRevision: randomUUID(),
    origin: { version: 1, documentId: 'host', pathAtCreation: 'Origin', firstInstanceId: instanceId },
    bindings: [], blocks: [{ ...paragraph('original'), createdAt: time }], maxRelativeDepth: 0,
    instances: [{ instanceId, hostDocumentId: 'host', bindingVersion: randomUUID(), parentBlockId: null, parentType: null, depth: 0 }],
    history: { cursor: randomUUID(), undoToken: null, redoToken: null } }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function fixture() {
  const values = [snapshot(), snapshot()], saved = new Map(values.map(value => [value.groupId, value]))
  const updates: SyncedUpdateGroupInput[] = [], listeners = new Set<(event: SyncedBlocksChangedEvent) => void>()
  let write: ((input: SyncedUpdateGroupInput) => Promise<SyncedGroupSaved>) | undefined
  let read: (() => Promise<void>) | undefined
  const ack = (input: SyncedUpdateGroupInput): SyncedGroupSaved => {
    const before = saved.get(input.groupId)!; assert.equal(input.expectedRevision, before.revision)
    assert.equal(input.expectedTopologyRevision, before.topologyRevision)
    const after = { ...before, revision: randomUUID(), blocks: input.blocks.map(block => ({ ...block, createdAt: time })),
      history: { cursor: randomUUID(), undoToken: randomUUID(), redoToken: null } }
    saved.set(input.groupId, after)
    return { status: 'saved', operationId: input.clientOperationId, replayed: false, snapshot: structuredClone(after) }
  }
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected API operation') }
  // An injected persistence contract port, never a Main/SQLite acceptance oracle.
  let workspaceScope = randomUUID()
  const api: SyncedBlocksApi = {
    getSyncedGroupSnapshots: async ({ groupIds }) => { await read?.(); return { workspaceScope,
      items: groupIds.map(id => ({ status: 'ready' as const, snapshot: structuredClone(saved.get(id)!) })) } },
    listSyncedGroups: unexpected, updateSyncedBlockGroup: async input => { updates.push(input); return write ? write(input) : ack(input) },
    getSyncedOperation: async () => ({ status: 'unknown' }), applySyncedHostStructure: unexpected, restoreSyncedGroupOperation: unexpected,
    restoreSyncedHostOperation: unexpected, getSyncedHostHistory: unexpected,
    onSyncedBlocksChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
  const workspace = getSyncedWorkspaceController(api); await workspace.load(values.map(value => value.groupId))
  const bindings = values.map(value => {
    const instance = value.instances[0], scope: SyncedGroupScope = { ...instance, owner: { kind: 'synced-group', groupId: value.groupId },
      windowSessionId: 'window', hostSession: {}, mountEpoch: {}, bindingEpoch: {}, domNamespace: value.groupId,
      root: () => null, isCurrent: () => true }
    return workspace.getGroup(value.groupId)!.bind(scope)
  })
  return { workspace, bindings, updates, values, ack, setWrite: (next: typeof write) => { write = next }, setRead: (next: typeof read) => { read = next }, changeWorkspaceScope: () => { workspaceScope = randomUUID() } }
}
function edit(binding: SyncedGroupBinding, content: string) {
  const state = binding.getCurrent()
  assert.equal(binding.apply({ blocks: [paragraph(content)], transactionId: randomUUID(), bookmark: null,
    expectedEditSequence: state.editSequence, guards: syncedSnapshotGuard(state.snapshot) }), true)
}

test('workspace flush discovers every genuine registered group and drains both serial writers without a caller group list', async () => {
  const f = await fixture(); edit(f.bindings[0], 'first'); edit(f.bindings[1], 'second')
  const exposed = f.workspace.getGroup(f.values[0].groupId)!, snapshotMethod = exposed.getSnapshot, flushMethod = exposed.flush
  exposed.getSnapshot = () => { throw new Error('A public replacement cannot supply a clean state DTO') }
  exposed.flush = async () => { throw new Error('A public replacement cannot skip a real group queue') }
  try { assert.equal(await flushSyncedWorkspacePendingChanges(f.workspace), true) }
  finally { exposed.getSnapshot = snapshotMethod; exposed.flush = flushMethod }
  assert.deepEqual(f.updates.map(input => input.groupId), f.values.map(value => value.groupId))
  for (const binding of f.bindings) { assert.equal(binding.getCurrent().dirty, false); assert.equal(binding.getCurrent().pending, null); binding.dispose() }
  let calls = 0
  const fake = Object.create(f.workspace)
  assert.equal(await flushSyncedWorkspacePendingChanges(fake, Object.defineProperty({}, 'shouldContinue', { get() { calls++; return () => true } })), false)
  assert.equal(calls, 0)
  assert.equal(f.workspace.dispose(), true)
  assert.equal(await flushSyncedWorkspacePendingChanges(f.workspace), false)
})

test('a late working edit beyond the original throughSequence makes workspace drain false and remains available for the next real flush', async () => {
  const f = await fixture(), gate = deferred<SyncedGroupSaved>()
  edit(f.bindings[0], 'submitted'); f.setWrite(async () => gate.promise)
  const draining = flushSyncedWorkspacePendingChanges(f.workspace)
  await setImmediate(); assert.equal(f.updates.length, 1)
  edit(f.bindings[0], 'later local input')
  gate.resolve(f.ack(f.updates[0])); assert.equal(await draining, false)
  assert.equal(f.bindings[0].getCurrent().working[0].content, 'later local input')
  assert.equal(f.bindings[0].getCurrent().dirty, true)
  f.setWrite(undefined); assert.equal(await flushSyncedWorkspacePendingChanges(f.workspace), true)
  assert.equal(f.updates.length, 2); assert.equal(f.bindings[0].getCurrent().dirty, false)
  for (const binding of f.bindings) binding.dispose(); f.workspace.dispose()
})

test('active IME and cancellation refuse a drain while an actual pending read holds it without discarding registered drafts', async () => {
  const f = await fixture(); edit(f.bindings[1], 'keep draft')
  f.bindings[0].setComposing(true)
  assert.equal(await flushSyncedWorkspacePendingChanges(f.workspace), false); assert.equal(f.updates.length, 0)
  f.bindings[0].setComposing(false)
  assert.equal(await flushSyncedWorkspacePendingChanges(f.workspace, { shouldContinue: () => false }), false)
  assert.equal(f.updates.length, 0); assert.equal(f.bindings[1].getCurrent().dirty, true)
  const reading = deferred<void>(); f.setRead(() => reading.promise)
  const pending = f.workspace.load([f.values[0].groupId])
  let settled = false
  const draining = flushSyncedWorkspacePendingChanges(f.workspace).then(value => { settled = true; return value })
  await setImmediate(); assert.equal(settled, false, 'the actual registered read must finish before a clean close is proven')
  assert.equal(f.updates.length, 0)
  assert.equal(f.bindings[1].getCurrent().working[0].content, 'keep draft')
  assert.equal(f.bindings[1].getCurrent().dirty, true)
  reading.resolve(); await pending; f.setRead(undefined)
  assert.equal(await draining, true)
  assert.equal(f.bindings[1].getCurrent().working[0].content, 'keep draft')
  assert.equal(f.bindings[1].getCurrent().dirty, false)
  assert.equal(await flushSyncedWorkspacePendingChanges(f.workspace), true)
  for (const binding of f.bindings) binding.dispose(); f.workspace.dispose()
})

test('workspace retry keeps the original uncertain operation identity and lets the existing mailbox settle without dropping its pending draft', async () => {
  const f = await fixture(); edit(f.bindings[0], 'uncertain pending')
  f.setWrite(async () => { throw new Error('contract transport failed after submission') })
  assert.equal(await flushSyncedWorkspacePendingChanges(f.workspace), false)
  const pending = f.bindings[0].getCurrent().pending; assert.ok(pending)
  assert.equal(f.bindings[0].getCurrent().dirty, true)
  assert.equal(f.bindings[0].getCurrent().working[0].content, 'uncertain pending')
  f.setWrite(undefined)
  assert.equal(await flushSyncedWorkspacePendingChanges(f.workspace), true)
  assert.equal(f.updates.length, 2)
  assert.equal(f.updates[0].clientOperationId, f.updates[1].clientOperationId)
  assert.equal(f.updates[1].clientOperationId, pending.clientOperationId)
  assert.equal(f.bindings[0].getCurrent().pending, null); assert.equal(f.bindings[0].getCurrent().dirty, false)
  for (const binding of f.bindings) binding.dispose(); f.workspace.dispose()
})

test('an expired clean baseline can close without regaining write authority while an expired dirty original remains blocked', async () => {
  const clean = await fixture()
  clean.changeWorkspaceScope(); await assert.rejects(clean.workspace.load([clean.values[0].groupId]), /workspace identity changed/)
  assert.ok(clean.bindings[0].getCurrent().error)
  assert.equal(await flushSyncedWorkspacePendingChanges(clean.workspace), true)
  assert.equal(clean.updates.length, 0)
  const baseline = clean.bindings[0].getCurrent()
  assert.equal(clean.bindings[0].apply({ blocks: [paragraph('must not write')], transactionId: randomUUID(), bookmark: null,
    expectedEditSequence: baseline.editSequence, guards: syncedSnapshotGuard(baseline.snapshot) }), false)
  for (const binding of clean.bindings) binding.dispose(); clean.workspace.dispose()
  const dirty = await fixture(); edit(dirty.bindings[0], 'original retained across epoch')
  dirty.changeWorkspaceScope(); await assert.rejects(dirty.workspace.load([dirty.values[0].groupId]), /workspace identity changed/)
  assert.equal(await flushSyncedWorkspacePendingChanges(dirty.workspace), false)
  assert.equal(dirty.updates.length, 0)
  assert.equal(dirty.bindings[0].getCurrent().working[0].content, 'original retained across epoch')
  assert.equal(dirty.bindings[0].getCurrent().dirty, true)
  for (const binding of dirty.bindings) binding.dispose()
})
