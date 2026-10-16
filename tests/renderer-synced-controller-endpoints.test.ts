import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedBindingClaim, SyncedBindingKey, SyncedBlocksApi, SyncedBlocksChangedEvent, SyncedCanonicalEdit,
  SyncedGroupMutationResult, SyncedGroupSaved, SyncedGroupSnapshot, SyncedRestoreGroupInput, SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { applySyncedGroupWithEndpoint, captureSyncedWorkingEndpoint, getSyncedWorkspaceController,
  readSyncedCommittedEndpoint, readSyncedWorkingEndpoint, type SyncedControllerOptions, type SyncedWorkingEndpointReceipt } from '../src/renderer/src/features/synced-blocks/controller'
import { syncedSnapshotGuard, type SyncedGroupBinding, type SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'

const time = '2026-10-16T00:00:00.000Z'
const block = (content: string): SyncedCanonicalEdit => ({ id: ' __proto__:原文 ', type: 'paragraph', content,
  depth: 0, parentBlockId: null, checked: false, tags: ['标签'], highlight: 'yellow' })
function snapshot(content = 'initial'): SyncedGroupSnapshot {
  const instances = [0, 1].map(index => ({ instanceId: randomUUID(), hostDocumentId: `host-${index}`, bindingVersion: randomUUID(),
    depth: 0, parentBlockId: null, parentType: null }))
  return { groupId: randomUUID(), creationId: randomUUID(), createdAt: time, revision: randomUUID(), topologyRevision: randomUUID(),
    blocks: [{ ...block(content), createdAt: time }], bindings: [], origin: { version: 1, documentId: 'origin',
      pathAtCreation: 'Original/Host', firstInstanceId: instances[0].instanceId }, instances,
    maxRelativeDepth: 0, history: { cursor: randomUUID(), undoToken: null, redoToken: null } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const keyId = (key: SyncedBindingKey) => JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])
const key = (value: SyncedCanonicalEdit): SyncedBindingKey => {
  const from = value.content.indexOf('Target.md')
  assert.ok(from >= 0)
  return { blockId: value.id, from, to: from + 'Target.md'.length, raw: 'Target.md', syntax: 'markdown' }
}
/** Actual controller with an injected contract port; no window/IPC/SQLite/UI
 * claim. The real Main operation-source implementation is an independent slice. */
class Api implements SyncedBlocksApi {
  workspaceScope = randomUUID()
  readonly updates: SyncedUpdateGroupInput[] = []
  readonly lookups: string[] = []
  readonly operations = new Map<string, SyncedGroupSaved>()
  readonly listeners = new Set<(event: SyncedBlocksChangedEvent) => void>()
  update: (input: SyncedUpdateGroupInput) => Promise<SyncedGroupMutationResult> = async input => this.saved(input)
  restore: (input: SyncedRestoreGroupInput) => Promise<SyncedGroupMutationResult> = async () => { throw new Error('Unexpected history') }
  constructor(public current = snapshot()) {}
  async getSyncedGroupSnapshots() { return { workspaceScope: this.workspaceScope, items: [{ status: 'ready' as const, snapshot: structuredClone(this.current) }] } }
  async listSyncedGroups() { return { items: [], total: 0 } }
  async updateSyncedBlockGroup(input: SyncedUpdateGroupInput) { this.updates.push(structuredClone(input)); return this.update(input) }
  async getSyncedOperation({ clientOperationId }: { clientOperationId: string }) {
    this.lookups.push(clientOperationId)
    const found = this.operations.get(clientOperationId)
    return found ? { status: 'committed' as const, result: { ...structuredClone(found), replayed: true } } : { status: 'unknown' as const }
  }
  async applySyncedHostStructure(): ReturnType<SyncedBlocksApi['applySyncedHostStructure']> { throw new Error('Not a host writer') }
  async restoreSyncedGroupOperation(input: SyncedRestoreGroupInput) { return this.restore(input) }
  async restoreSyncedHostOperation(): ReturnType<SyncedBlocksApi['restoreSyncedHostOperation']> { throw new Error('Not a host writer') }
  async getSyncedHostHistory() { return { cursor: randomUUID(), undoToken: null, redoToken: null } }
  onSyncedBlocksChanged(listener: (event: SyncedBlocksChangedEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(kind: 'content' | 'topology' = 'content', operationId: string = randomUUID()) {
    for (const listener of this.listeners) listener({ operationId, changes: [{ groupId: this.current.groupId,
      revision: this.current.revision, topologyRevision: this.current.topologyRevision, kind }],
      affectedInstanceIds: this.current.instances.map(value => value.instanceId) })
  }
  saved(input: SyncedUpdateGroupInput): SyncedGroupSaved {
    assert.equal(input.expectedRevision, this.current.revision)
    assert.equal(input.expectedTopologyRevision, this.current.topologyRevision)
    const oldBindings = this.current.bindings
    const bindings = input.bindingClaims === undefined ? oldBindings : input.bindingClaims.map(claim => {
      const source = claim.kind === 'continue' ? claim.source : claim.kind === 'copy' && claim.source.kind === 'current' ? claim.source.key : null
      const original = source && oldBindings.find(value => keyId(value) === keyId(source))
      if (source) assert.ok(original)
      return { ...claim.destination, target: original ? original.target : { kind: 'document' as const, id: 'new-target', state: 'live' as const } }
    })
    this.current = { ...this.current, revision: randomUUID(), bindings,
      blocks: input.blocks.map(value => ({ ...value, createdAt: this.current.blocks.find(old => old.id === value.id)?.createdAt ?? time })),
      history: { cursor: randomUUID(), undoToken: randomUUID(), redoToken: null } }
    const ack: SyncedGroupSaved = { status: 'saved', operationId: input.clientOperationId, replayed: false, snapshot: structuredClone(this.current) }
    this.operations.set(input.clientOperationId, structuredClone(ack))
    this.emit('content', input.clientOperationId)
    return ack
  }
}
function scope(value: SyncedGroupSnapshot, index: number): SyncedGroupScope {
  const item = value.instances[index]
  return { owner: { kind: 'synced-group', groupId: value.groupId }, ...item, hostSession: {}, mountEpoch: {}, bindingEpoch: {},
    windowSessionId: 'window', domNamespace: `instance-${index}`, root: () => null, isCurrent: () => true }
}
async function setup(api = new Api(), options: SyncedControllerOptions = {}) {
  const workspace = getSyncedWorkspaceController(api, options)
  await workspace.load([api.current.groupId])
  const controller = workspace.getGroup(api.current.groupId)!
  return { api, workspace, controller, first: controller.bind(scope(api.current, 0)), second: controller.bind(scope(api.current, 1)) }
}
function input(binding: SyncedGroupBinding, blocks: SyncedCanonicalEdit[], transactionId: string = randomUUID(), claims?: SyncedBindingClaim[]) {
  const current = binding.getCurrent()
  return { expectedEditSequence: current.editSequence, guards: syncedSnapshotGuard(current.snapshot), blocks, transactionId, bookmark: null,
    ...(claims === undefined ? {} : { bindingClaims: claims }) }
}
function accept(binding: SyncedGroupBinding, content: string, transactionId: string = randomUUID()) {
  const result = applySyncedGroupWithEndpoint(binding, input(binding, [block(content)], transactionId))
  assert.equal(result.accepted, true)
  assert.ok(result.accepted)
  return result.endpoint
}
function available(receipt: SyncedWorkingEndpointReceipt) {
  const read = readSyncedWorkingEndpoint(receipt)
  assert.equal(read.status, 'available'); assert.ok(read.status === 'available')
  return read
}
function committed(receipt: SyncedWorkingEndpointReceipt) {
  const read = available(receipt)
  assert.ok(read.kind === 'content' && read.committed)
  const result = readSyncedCommittedEndpoint(read.committed)
  assert.ok(result)
  return { handle: read.committed, facts: result }
}

test('clean baseline is captured only by a real live binding and exposes a deeply immutable exact baseline', async () => {
  const { first, api } = await setup(), receipt = captureSyncedWorkingEndpoint(first)
  assert.ok(receipt)
  const read = available(receipt)
  assert.equal(read.kind, 'baseline'); assert.ok(read.kind === 'baseline')
  assert.equal(read.current, true); assert.equal(read.editSequence, 0); assert.equal(read.committed, null)
  assert.deepEqual(read.baseline, api.current)
  assert.equal(Object.isFrozen(read.baseline.blocks[0].tags), true)
  assert.throws(() => Object.defineProperty(read.baseline.blocks[0], 'content', { value: 'mutated' }))
  assert.equal(captureSyncedWorkingEndpoint({ ...first }), null)
  assert.equal(readSyncedWorkingEndpoint({ kind: receipt.kind }).status, 'unavailable')
  assert.equal(api.updates.length, 0)
})

test('legacy bool apply uses the same actual accepted endpoint and ACK path', async () => {
  const { first, api } = await setup()
  assert.equal(first.apply(input(first, [block('bool update')], 'bool-action')), true)
  const receipt = captureSyncedWorkingEndpoint(first)
  assert.ok(receipt)
  assert.equal(available(receipt).kind, 'content')
  assert.equal(await first.flush(), true)
  const saved = committed(receipt).facts
  assert.equal(saved.transactionId, 'bool-action'); assert.equal(saved.submittedEditSequence, 1)
  assert.deepEqual(saved.ack, api.operations.get(api.updates[0].clientOperationId))
})

test('same-body new claims create a dirty content endpoint, never a baseline inferred from body equality', async () => {
  const value = snapshot('[A](Target.md)')
  value.bindings = [{ ...key(value.blocks[0]), target: { kind: 'document', id: 'old-target', state: 'live' } }]
  const { first, api } = await setup(new Api(value)), before = first.getCurrent().working[0]
  const result = applySyncedGroupWithEndpoint(first, input(first, [before], 'same-body', [{ kind: 'new', destination: key(before) }]))
  assert.ok(result.accepted)
  const read = available(result.endpoint)
  assert.equal(read.kind, 'content'); assert.equal(first.getCurrent().dirty, true)
  assert.equal(read.working[0].content, before.content)
  assert.equal(await first.flush(), true)
  assert.deepEqual(committed(result.endpoint).facts.ack.snapshot.bindings[0].target, { kind: 'document', id: 'new-target', state: 'live' })
  assert.equal(api.updates.length, 1)
})

test('coalescing changes the real frame version; the intermediate endpoint stays unavailable before and after ACK', async () => {
  const { first, api } = await setup(), firstEndpoint = accept(first, 'one', 'coalesced'), secondEndpoint = accept(first, 'two', 'coalesced')
  assert.equal(readSyncedWorkingEndpoint(firstEndpoint).status, 'unavailable')
  assert.equal(available(secondEndpoint).editSequence, 2)
  assert.equal(await first.flush(), true)
  assert.equal(api.updates.length, 1)
  assert.equal(committed(secondEndpoint).facts.submittedEditSequence, 2)
  assert.equal(readSyncedWorkingEndpoint(firstEndpoint).status, 'unavailable')
})

test('net-zero coalescing prunes the uncommitted frame and cannot manufacture an operation receipt', async () => {
  const { first, api } = await setup(), middle = accept(first, 'temporary', 'net-zero'), final = accept(first, 'initial', 'net-zero')
  assert.equal(readSyncedWorkingEndpoint(middle).status, 'unavailable')
  const read = available(final)
  assert.equal(read.kind, 'baseline'); assert.equal(read.committed, null)
  assert.equal(first.getCurrent().dirty, false); assert.equal(await first.flush(), true)
  assert.equal(api.updates.length, 0)
})

test('two real frames retain their own exact after ACK while a later frame remains current', async () => {
  const { first, second, api } = await setup(), started = deferred<void>(), gate = deferred<void>()
  api.update = async update => { if (api.updates.length === 1) { started.resolve(); await gate.promise }; return api.saved(update) }
  const firstEndpoint = accept(first, 'first frame', 'first-action'), saving = first.flush()
  await started.promise
  const laterEndpoint = accept(second, 'later frame', 'later-action')
  gate.resolve(); assert.equal(await saving, true)
  const firstRead = available(firstEndpoint), old = committed(firstEndpoint)
  assert.equal(firstRead.current, false); assert.equal(old.facts.ack.snapshot.blocks[0].content, 'first frame')
  assert.equal(available(laterEndpoint).committed, null); assert.equal(available(laterEndpoint).current, true)
  assert.equal(await second.flush(), true)
  assert.equal(committed(laterEndpoint).facts.ack.snapshot.blocks[0].content, 'later frame')
  assert.deepEqual(readSyncedCommittedEndpoint(old.handle), old.facts)
  assert.equal(readSyncedCommittedEndpoint(old.handle)!.ack.snapshot.blocks[0].content, 'first frame')
  assert.equal(api.updates.length, 2)
})

test('lost ACK lookup publishes the original pending frame receipt exactly once without a new write', async () => {
  const { first, api } = await setup()
  let lost = true
  api.update = async update => { const ack = api.saved(update); if (lost) { lost = false; throw new Error('Lost committed ACK') }; return ack }
  const endpoint = accept(first, 'committed before delivery', 'lost-ack')
  assert.equal(await first.flush(), false)
  assert.equal(available(endpoint).committed, null)
  assert.equal(await first.flush(), true)
  const receipt = committed(endpoint), operationId = api.updates[0].clientOperationId
  assert.equal(receipt.facts.ack.operationId, operationId); assert.equal(receipt.facts.ack.replayed, true)
  assert.deepEqual(receipt.facts.ack.snapshot, api.operations.get(operationId)!.snapshot)
  assert.deepEqual(api.lookups, [operationId]); assert.equal(api.updates.length, 1)
  assert.equal(await first.flush(), true)
  assert.equal(committed(endpoint).handle, receipt.handle)
})

test('a verified content noop ACK still commits its exact operation side and consumes no invented history', async () => {
  const value = snapshot('[A](Target.md)')
  value.bindings = [{ ...key(value.blocks[0]), target: { kind: 'document', id: 'old-target', state: 'live' } }]
  const { first, api } = await setup(new Api(value)), before = structuredClone(api.current)
  api.update = async update => {
    const ack: SyncedGroupSaved = { status: 'noop', operationId: update.clientOperationId, snapshot: structuredClone(api.current), replayed: false }
    api.operations.set(update.clientOperationId, structuredClone(ack)); return ack
  }
  const body = first.getCurrent().working[0], accepted = applySyncedGroupWithEndpoint(first,
    input(first, [body], 'noop-source', [{ kind: 'new', destination: key(body) }]))
  assert.ok(accepted.accepted)
  assert.equal(await first.flush(), true)
  const read = committed(accepted.endpoint).facts
  assert.equal(read.ack.status, 'noop'); assert.equal(read.submittedEditSequence, 1)
  assert.deepEqual(read.ack.snapshot, before); assert.equal(first.getCurrent().dirty, false)
  assert.equal(read.ack.snapshot.history.undoToken, null)
})

test('a mismatched ACK cannot publish committed authority; successful original lookup can later settle it', async () => {
  const { first, api } = await setup()
  api.update = async update => ({ ...api.saved(update), operationId: randomUUID() })
  const endpoint = accept(first, 'verified only', 'bad-ack')
  assert.equal(await first.flush(), false)
  assert.equal(available(endpoint).committed, null)
  assert.equal(await first.flush(), true)
  assert.equal(committed(endpoint).facts.ack.operationId, api.updates[0].clientOperationId)
  assert.equal(api.updates.length, 1)
})

test('local Undo and Redo never revive an old endpoint even when the same Frame/body returns', async () => {
  const { first } = await setup(), original = accept(first, 'editable', 'undo-redo')
  assert.equal(await first.undo(), true)
  assert.equal(readSyncedWorkingEndpoint(original).status, 'unavailable')
  const undone = captureSyncedWorkingEndpoint(first)
  assert.ok(undone); assert.equal(available(undone).kind, 'baseline')
  assert.equal(await first.redo(), true)
  const redone = captureSyncedWorkingEndpoint(first)
  assert.ok(redone); assert.equal(available(redone).editSequence, 3)
  assert.equal(readSyncedWorkingEndpoint(original).status, 'unavailable')
  assert.equal(readSyncedWorkingEndpoint(undone).status, 'unavailable')
  assert.equal(await first.flush(), true)
  assert.equal(committed(redone).facts.submittedEditSequence, 3)
})

test('Undo of a later frame creates a fresh surviving-prefix endpoint with the real submission sequence', async () => {
  const { first } = await setup(), prefix = accept(first, 'prefix', 'prefix'), later = accept(first, 'later', 'later')
  assert.equal(await first.undo(), true)
  assert.equal(readSyncedWorkingEndpoint(prefix).status, 'unavailable')
  assert.equal(readSyncedWorkingEndpoint(later).status, 'unavailable')
  const restoredPrefix = captureSyncedWorkingEndpoint(first)
  assert.ok(restoredPrefix); assert.equal(available(restoredPrefix).editSequence, 3)
  assert.equal(await first.flush(), true)
  const ack = committed(restoredPrefix).facts
  assert.equal(ack.acceptedEditSequence, 3); assert.equal(ack.submittedEditSequence, 1)
  assert.equal(ack.ack.snapshot.blocks[0].content, 'prefix')
})

test('pruning the local Redo branch does not let an old endpoint match a new equal-body frame', async () => {
  const { first, api } = await setup(), old = accept(first, 'same body', 'old')
  assert.equal(await first.undo(), true)
  const fresh = accept(first, 'same body', 'fresh')
  assert.equal(await first.redo(), false)
  assert.equal(readSyncedWorkingEndpoint(old).status, 'unavailable')
  assert.equal(await first.flush(), true)
  assert.equal(committed(fresh).facts.transactionId, 'fresh'); assert.equal(api.updates.length, 1)
})

test('server Undo Redo expire working epochs but never rewrite the already validated content ACK side', async () => {
  const { first, api } = await setup(), before = structuredClone(api.current), content = accept(first, 'server side', 'server-content')
  assert.equal(await first.flush(), true)
  const old = committed(content), after = structuredClone(api.current)
  api.restore = async request => {
    const target = request.direction === 'undo' ? before : after
    assert.equal(request.expectedRevision, api.current.revision)
    assert.equal(request.expectedHistoryCursor, api.current.history.cursor)
    api.current = { ...api.current, blocks: structuredClone(target.blocks), bindings: structuredClone(target.bindings), revision: randomUUID(),
      history: { cursor: randomUUID(), undoToken: request.direction === 'redo' ? randomUUID() : null,
        redoToken: request.direction === 'undo' ? randomUUID() : null } }
    const ack: SyncedGroupSaved = { status: 'saved', operationId: request.clientOperationId, replayed: false, snapshot: structuredClone(api.current) }
    api.operations.set(request.clientOperationId, structuredClone(ack)); return ack
  }
  assert.equal(await first.undo(), true)
  assert.equal(readSyncedWorkingEndpoint(content).status, 'unavailable')
  const undone = captureSyncedWorkingEndpoint(first)
  assert.ok(undone); assert.equal(available(undone).working[0].content, 'initial')
  assert.equal(await first.redo(), true)
  assert.equal(readSyncedWorkingEndpoint(undone).status, 'unavailable')
  const redone = captureSyncedWorkingEndpoint(first)
  assert.ok(redone); assert.equal(available(redone).working[0].content, 'server side')
  assert.deepEqual(readSyncedCommittedEndpoint(old.handle), old.facts)
  assert.equal(old.facts.ack.snapshot.revision, after.revision)
})

test('external content and topology observations expire prior working handles without rewriting historical ACK facts', async () => {
  const { first, api, workspace } = await setup(), endpoint = accept(first, 'local', 'saved')
  assert.equal(await first.flush(), true)
  const old = committed(endpoint)
  api.current = { ...api.current, revision: randomUUID(), blocks: [{ ...block('external'), createdAt: time }] }
  api.emit(); await workspace.load([api.current.groupId])
  assert.equal(readSyncedWorkingEndpoint(endpoint).status, 'unavailable')
  assert.equal(readSyncedCommittedEndpoint(old.handle)!.ack.snapshot.blocks[0].content, 'local')
  const baseline = captureSyncedWorkingEndpoint(first)
  assert.ok(baseline); assert.equal(available(baseline).working[0].content, 'external')
  api.current = { ...api.current, topologyRevision: randomUUID() }
  api.emit('topology'); await workspace.load([api.current.groupId])
  assert.equal(readSyncedWorkingEndpoint(baseline).status, 'unavailable')
  const current = captureSyncedWorkingEndpoint(first)
  assert.ok(current); assert.equal(available(current).current, true)
})

test('topology-only refresh expires a dirty frame endpoint and a fresh capture can settle the same real frame', async () => {
  const { first, api, workspace } = await setup(), old = accept(first, 'dirty topology', 'dirty')
  api.current = { ...api.current, topologyRevision: randomUUID() }
  api.emit('topology'); await workspace.load([api.current.groupId])
  assert.equal(readSyncedWorkingEndpoint(old).status, 'unavailable')
  const fresh = captureSyncedWorkingEndpoint(first)
  assert.ok(fresh); assert.equal(available(fresh).editSequence, 1)
  assert.equal(await first.flush(), true)
  assert.equal(committed(fresh).facts.ack.snapshot.topologyRevision, api.current.topologyRevision)
})

test('rebind/disposal and workspace invalidation make old working receipts unavailable', async () => {
  const { first, controller, workspace, api } = await setup(), old = captureSyncedWorkingEndpoint(first)
  assert.ok(old)
  const replacement = controller.bind(scope(api.current, 0))
  assert.equal(readSyncedWorkingEndpoint(old).status, 'unavailable')
  const fresh = captureSyncedWorkingEndpoint(replacement)
  assert.ok(fresh)
  replacement.dispose(); assert.equal(readSyncedWorkingEndpoint(fresh).status, 'unavailable')
  const other = controller.bind(scope(api.current, 1)), otherEndpoint = captureSyncedWorkingEndpoint(other)
  assert.ok(otherEndpoint)
  api.workspaceScope = randomUUID()
  await assert.rejects(workspace.load([api.current.groupId]), /identity changed/)
  assert.equal(readSyncedWorkingEndpoint(otherEndpoint).status, 'unavailable')
})

test('bare reader calls and throwing existing subscribers cannot corrupt ACK adoption or leak mutable receipt state', async () => {
  const { first } = await setup(new Api(), { onSubscriberError: () => { throw new Error('Nested subscriber error') } })
  const stop = first.subscribe(() => { throw new Error('Subscriber error') })
  const applyBare = applySyncedGroupWithEndpoint, readBare = readSyncedWorkingEndpoint, committedBare = readSyncedCommittedEndpoint
  const result = applyBare(first, input(first, [block('plain call')], 'bare'))
  assert.ok(result.accepted); assert.equal(await first.flush(), true)
  const read = readBare(result.endpoint)
  assert.ok(read.status === 'available' && read.kind === 'content' && read.committed)
  const facts = committedBare(read.committed)
  assert.ok(facts)
  assert.equal(Object.isFrozen(facts.ack.snapshot.history), true)
  assert.throws(() => Object.defineProperty(facts.ack, 'operationId', { value: 'forged' }))
  assert.equal(committedBare({ kind: 'synced-committed-endpoint' }), null)
  stop()
})

test('atomic apply returns its original unavailable handle after synchronous same-frame same-body new reentry', async () => {
  const value = snapshot('[A](Target.md)')
  value.bindings = [{ ...key(value.blocks[0]), target: { kind: 'document', id: 'old-target', state: 'live' } }]
  const { first } = await setup(new Api(value)), transactionId = 'same-frame-reentry'
  let entered = false
  const box: { endpoint?: SyncedWorkingEndpointReceipt } = {}
  const stop = first.subscribe(() => {
    if (entered) return
    entered = true
    const current = first.getCurrent().working[0]
    const result = applySyncedGroupWithEndpoint(first, input(first, [current], transactionId, [{ kind: 'new', destination: key(current) }]))
    assert.ok(result.accepted); box.endpoint = result.endpoint
  })
  const current = first.getCurrent().working[0]
  const result = applySyncedGroupWithEndpoint(first, input(first, [current], transactionId, [{ kind: 'new', destination: key(current) }]))
  assert.ok(result.accepted && box.endpoint)
  const reentrant = box.endpoint
  assert.notEqual(result.endpoint, reentrant)
  assert.equal(readSyncedWorkingEndpoint(result.endpoint).status, 'unavailable')
  assert.equal(available(reentrant).editSequence, 2)
  stop(); assert.equal(await first.flush(), true)
  assert.equal(readSyncedWorkingEndpoint(result.endpoint).status, 'unavailable')
  assert.equal(committed(reentrant).facts.submittedEditSequence, 2)
})

test('atomic apply returns the original first-frame endpoint rather than a synchronously accepted different frame', async () => {
  const { first, api } = await setup()
  let entered = false
  const box: { endpoint?: SyncedWorkingEndpointReceipt } = {}
  const stop = first.subscribe(() => { if (!entered) { entered = true; box.endpoint = accept(first, 'later', 'reentrant-frame') } })
  const original = accept(first, 'original', 'original-frame')
  assert.ok(box.endpoint)
  const reentrant = box.endpoint
  const firstRead = available(original), secondRead = available(reentrant)
  assert.equal(firstRead.kind, 'content'); assert.equal(firstRead.transactionId, 'original-frame')
  assert.equal(firstRead.working[0].content, 'original'); assert.equal(firstRead.current, false)
  assert.equal(secondRead.current, true); assert.equal(secondRead.working[0].content, 'later')
  stop(); assert.equal(await first.flush(), true)
  assert.equal(committed(original).facts.ack.snapshot.blocks[0].content, 'original')
  assert.equal(committed(reentrant).facts.ack.snapshot.blocks[0].content, 'later')
  assert.equal(api.updates.length, 2)
})

test('an unchanged pending prefix keeps its exact ACK when a later same-transaction frame cancels to that prefix', async () => {
  const { first, second, api } = await setup(), started = deferred<void>(), gate = deferred<void>()
  api.update = async update => { started.resolve(); await gate.promise; return api.saved(update) }
  const original = accept(first, 'pending prefix', 'prefix'), saving = first.flush()
  await started.promise
  const temporary = accept(second, 'temporary suffix', 'suffix')
  const returnedPrefix = accept(second, 'pending prefix', 'suffix')
  const beforeAck = available(returnedPrefix)
  assert.equal(beforeAck.kind, 'content'); assert.equal(beforeAck.editSequence, 3)
  assert.equal(beforeAck.current, true); assert.equal(beforeAck.committed, null)
  assert.equal(readSyncedWorkingEndpoint(temporary).status, 'unavailable')
  assert.equal(first.getCurrent().pending?.editSequence, 1)
  gate.resolve(); assert.equal(await saving, true)
  const exact = committed(returnedPrefix).facts
  assert.equal(exact.acceptedEditSequence, 3); assert.equal(exact.submittedEditSequence, 1)
  assert.equal(exact.transactionId, 'prefix'); assert.equal(exact.ack.snapshot.blocks[0].content, 'pending prefix')
  assert.equal(exact.ack.operationId, api.updates[0].clientOperationId)
  const old = committed(original).facts
  assert.equal(old.acceptedEditSequence, 1); assert.equal(old.submittedEditSequence, 1)
  assert.deepEqual(old.ack, exact.ack)
  assert.equal(available(original).current, false)
  assert.equal(await second.flush(), true); assert.equal(api.updates.length, 1)
})

test('atomic and bool entrypoints reject own guard accessors without executing their same-body reentry', async () => {
  for (const atomic of [false, true]) {
    const value = snapshot('[A](Target.md)')
    value.bindings = [{ ...key(value.blocks[0]), target: { kind: 'document', id: 'old-target', state: 'live' } }]
    const { first, api } = await setup(new Api(value)), before = first.getCurrent(), body = before.working[0]
    const outer = input(first, [body], 'outer-accessor', [{ kind: 'new', destination: key(body) }])
    let getterCalls = 0
    Object.defineProperty(outer.guards, 'groupId', { enumerable: true, get: () => {
      getterCalls++
      assert.equal(first.apply(input(first, [body], 'inner-accessor', [{ kind: 'new', destination: key(body) }])), true)
      return before.snapshot.groupId
    } })
    const accepted = atomic ? applySyncedGroupWithEndpoint(first, outer).accepted : first.apply(outer)
    assert.equal(accepted, false); assert.equal(getterCalls, 0)
    assert.equal(first.getCurrent(), before); assert.equal(first.getCurrent().editSequence, 0)
    assert.equal(first.getCurrent().dirty, false); assert.equal(api.updates.length, 0)
  }
})

test('a budget callback may accept its own same-body intent but cannot make an outer stale candidate accepted', async () => {
  for (const atomic of [false, true]) {
    const value = snapshot('[A](Target.md)')
    value.bindings = [{ ...key(value.blocks[0]), target: { kind: 'document', id: 'old-target', state: 'live' } }]
    let first!: SyncedGroupBinding, enter = true, innerAccepted = false
    const result = await setup(new Api(value), { validateBudget: () => {
      if (!enter) return
      enter = false
      const body = first.getCurrent().working[0]
      innerAccepted = first.apply(input(first, [body], 'inner-budget', [{ kind: 'new', destination: key(body) }]))
    } })
    first = result.first
    const body = first.getCurrent().working[0]
    const outer = input(first, [body], 'outer-budget', [{ kind: 'new', destination: key(body) }])
    const accepted = atomic ? applySyncedGroupWithEndpoint(first, outer).accepted : first.apply(outer)
    assert.equal(accepted, false); assert.equal(innerAccepted, true)
    assert.equal(first.getCurrent().editSequence, 1); assert.equal(first.getCurrent().dirty, true)
    const endpoint = captureSyncedWorkingEndpoint(first)
    assert.ok(endpoint)
    const current = available(endpoint)
    assert.equal(current.kind, 'content'); assert.equal(current.transactionId, 'inner-budget')
    assert.equal(await first.flush(), true)
    assert.equal(result.api.updates.length, 1)
    assert.equal(committed(endpoint).facts.transactionId, 'inner-budget')
  }
})
