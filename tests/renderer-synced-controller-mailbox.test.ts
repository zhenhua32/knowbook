import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedBindingClaim, SyncedBindingKey, SyncedBlocksApi, SyncedBlocksChangedEvent, SyncedCanonicalEdit,
  SyncedGroupMutationResult, SyncedGroupSaved, SyncedGroupSnapshot, SyncedRestoreGroupInput, SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { applySyncedGroupWithEndpoint, captureSyncedWorkingEndpoint, getSyncedWorkspaceController,
  readSyncedCommittedEndpoint, readSyncedWorkingEndpoint, readSyncedWorkingEndpointCommitted,
  type SyncedControllerOptions, type SyncedWorkingEndpointReceipt } from '../src/renderer/src/features/synced-blocks/controller'
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

function mailbox(receipt: SyncedWorkingEndpointReceipt) {
  const handle = readSyncedWorkingEndpointCommitted(receipt)
  assert.ok(handle)
  const facts = readSyncedCommittedEndpoint(handle)
  assert.ok(facts)
  return { handle, facts }
}

test('mailbox rejects forged/baseline handles without consulting any scope or public binding method', async () => {
  const { first, api } = await setup(), baseline = captureSyncedWorkingEndpoint(first)!
  let calls = 0
  first.scope.isCurrent = () => { calls++; throw new Error('No live callback is allowed') }
  first.getCurrent = () => { calls++; throw new Error('No public getter is allowed') }
  assert.equal(readSyncedWorkingEndpointCommitted(baseline), null)
  assert.equal(readSyncedWorkingEndpointCommitted({ kind: 'synced-working-endpoint' }), null)
  assert.equal(calls, 0); assert.equal(api.updates.length, 0); assert.equal(api.lookups.length, 0)
})

test('mailbox first read after ACK and disposal preserves the original deeply immutable receipt', async () => {
  const { first, api } = await setup(), endpoint = accept(first, 'original committed body', 'local-action')
  assert.equal(readSyncedWorkingEndpointCommitted(endpoint), null)
  assert.equal(await first.flush(), true)
  first.dispose()
  const read = mailbox(endpoint)
  assert.equal(readSyncedWorkingEndpoint(endpoint).status, 'unavailable')
  assert.equal(read.facts.ack.operationId, api.updates[0].clientOperationId)
  assert.equal(read.facts.transactionId, 'local-action')
  assert.notEqual(read.facts.transactionId, read.facts.ack.operationId)
  assert.equal(Object.isFrozen(read.facts), true); assert.equal(Object.isFrozen(read.facts.ack.snapshot.blocks[0].tags), true)
  assert.throws(() => Object.defineProperty(read.facts.ack.snapshot.blocks[0], 'content', { value: 'mutated' }))
  assert.equal(mailbox(endpoint).handle, read.handle)
})

test('mailbox and the unchanged live reader share the exact committed handle', async () => {
  const { first } = await setup(), endpoint = accept(first, 'saved')
  assert.equal(await first.flush(), true)
  const live = committed(endpoint), read = mailbox(endpoint)
  assert.equal(read.handle, live.handle); assert.equal(read.facts, live.facts)
})

test('ACK is recorded before publication can synchronously dispose its original binding', async () => {
  const { first } = await setup(), endpoint = accept(first, 'publish dispose')
  let disposed = false, seenInsidePublish = false
  const stop = first.subscribe(() => {
    const state = first.getCurrent()
    if (!disposed && !state.pending && !state.dirty) {
      disposed = true; first.dispose()
      seenInsidePublish = readSyncedWorkingEndpointCommitted(endpoint) !== null
    }
  })
  assert.equal(await first.flush(), true)
  stop()
  assert.equal(disposed, true); assert.equal(seenInsidePublish, true)
  assert.equal(readSyncedWorkingEndpoint(endpoint).status, 'unavailable')
  assert.equal(mailbox(endpoint).facts.ack.snapshot.blocks[0].content, 'publish dispose')
})

test('disposal before delayed ACK cannot erase the original pending version acknowledgement', async () => {
  const { first, api } = await setup(), started = deferred<void>(), gate = deferred<void>()
  api.update = async input => { started.resolve(); await gate.promise; return api.saved(input) }
  const endpoint = accept(first, 'pending before dispose'), saving = first.flush()
  await started.promise; first.dispose()
  assert.equal(readSyncedWorkingEndpointCommitted(endpoint), null)
  gate.resolve(); assert.equal(await saving, true)
  assert.equal(mailbox(endpoint).facts.ack.operationId, api.updates[0].clientOperationId)
  assert.equal(readSyncedWorkingEndpoint(endpoint).status, 'unavailable')
})

test('workspace expiry before delayed ACK retains a mailbox for the exact retired pending version', async () => {
  const { first, controller, workspace, api } = await setup(), started = deferred<void>(), gate = deferred<void>()
  api.update = async input => { started.resolve(); await gate.promise; return api.saved(input) }
  const endpoint = accept(first, 'pending before workspace expiry'), saving = first.flush()
  await started.promise
  api.workspaceScope = randomUUID()
  await assert.rejects(workspace.load([api.current.groupId]), /workspace identity changed/)
  assert.equal(readSyncedWorkingEndpoint(endpoint).status, 'unavailable')
  assert.equal(readSyncedWorkingEndpointCommitted(endpoint), null)
  gate.resolve(); assert.equal(await saving, true)
  const read = mailbox(endpoint)
  assert.equal(read.facts.submittedEditSequence, 1); assert.equal(read.facts.acceptedEditSequence, 1)
  assert.equal(read.facts.ack.snapshot.blocks[0].content, 'pending before workspace expiry')
  assert.equal(await controller.flush(), false, 'diagnostic ACK does not restore workspace write authority')
})

test('a throwing stale scope callback cannot affect a committed mailbox read or cause a callout', async () => {
  const { first } = await setup(), endpoint = accept(first, 'saved without callback')
  assert.equal(await first.flush(), true)
  let calls = 0
  first.scope.isCurrent = () => { calls++; throw new Error('stale scope callback') }
  const read = mailbox(endpoint)
  assert.equal(calls, 0)
  assert.equal(read.facts.ack.snapshot.blocks[0].content, 'saved without callback')
  assert.equal(readSyncedWorkingEndpoint(endpoint).status, 'unavailable')
  assert.equal(calls, 1, 'the old live reader retains its original availability contract')
  assert.equal(mailbox(endpoint).handle, read.handle); assert.equal(calls, 1)
})

test('two real frames keep different original ACKs while F2 remains the current dirty side', async () => {
  const { first, second, api } = await setup(), started = deferred<void>(), gate = deferred<void>()
  api.update = async input => { if (api.updates.length === 1) { started.resolve(); await gate.promise }; return api.saved(input) }
  const original = accept(first, 'F1 body', 'F1'), saving = first.flush()
  await started.promise
  const later = accept(second, 'F2 body', 'F2')
  gate.resolve(); assert.equal(await saving, true)
  first.dispose()
  const one = mailbox(original)
  assert.equal(one.facts.ack.snapshot.blocks[0].content, 'F1 body')
  assert.equal(readSyncedWorkingEndpointCommitted(later), null)
  assert.equal(await second.flush(), true)
  const two = mailbox(later)
  assert.equal(two.facts.ack.snapshot.blocks[0].content, 'F2 body')
  assert.notEqual(one.facts.ack.operationId, two.facts.ack.operationId)
  assert.equal(mailbox(original).facts, one.facts)
})

test('pending prefix views distinguish submitted sequence from each accepted view sequence', async () => {
  const { first, second, api } = await setup(), started = deferred<void>(), gate = deferred<void>()
  api.update = async input => { started.resolve(); await gate.promise; return api.saved(input) }
  const original = accept(first, 'pending prefix', 'prefix'), saving = first.flush()
  await started.promise
  const temporary = accept(second, 'temporary suffix', 'suffix'), returned = accept(second, 'pending prefix', 'suffix')
  assert.equal(available(returned).editSequence, 3)
  gate.resolve(); assert.equal(await saving, true)
  first.dispose(); second.dispose()
  const one = mailbox(original), three = mailbox(returned)
  assert.equal(one.facts.submittedEditSequence, 1); assert.equal(one.facts.acceptedEditSequence, 1)
  assert.equal(three.facts.submittedEditSequence, 1); assert.equal(three.facts.acceptedEditSequence, 3)
  assert.equal(three.facts.transactionId, 'prefix'); assert.deepEqual(three.facts.ack, one.facts.ack)
  assert.notEqual(one.handle, three.handle)
  assert.equal(readSyncedWorkingEndpointCommitted(temporary), null)
  assert.equal(api.updates.length, 1)
})

test('retired unsubmitted coalesced versions never inherit their replacement version ACK', async () => {
  const { first } = await setup(), retired = accept(first, 'old coalesced view', 'same'), final = accept(first, 'new coalesced view', 'same')
  assert.equal(readSyncedWorkingEndpointCommitted(retired), null)
  assert.equal(await first.flush(), true)
  first.dispose()
  assert.equal(readSyncedWorkingEndpointCommitted(retired), null)
  assert.equal(mailbox(final).facts.acceptedEditSequence, 2)
  assert.equal(mailbox(final).facts.submittedEditSequence, 2)
})

test('net cancellation creates neither a committed retired version nor a baseline mailbox', async () => {
  const { first, api } = await setup(), temporary = accept(first, 'temporary', 'net-zero'), baseline = accept(first, 'initial', 'net-zero')
  assert.equal(await first.flush(), true)
  first.dispose()
  assert.equal(readSyncedWorkingEndpointCommitted(temporary), null)
  assert.equal(readSyncedWorkingEndpointCommitted(baseline), null)
  assert.equal(api.updates.length, 0)
})

test('lost ACK remains unknown until the original operation lookup passes existing validation', async () => {
  const { first, controller, api } = await setup()
  api.update = async input => { api.saved(input); throw new Error('Lost committed ACK') }
  const endpoint = accept(first, 'committed before delivery', 'local-transaction')
  assert.equal(await first.flush(), false)
  assert.equal(readSyncedWorkingEndpointCommitted(endpoint), null); assert.equal(api.lookups.length, 0)
  first.dispose()
  assert.equal(await first.flush(), false, 'the stale binding does not regain write authority')
  assert.equal(readSyncedWorkingEndpointCommitted(endpoint), null); assert.equal(api.lookups.length, 0)
  assert.equal(await controller.flush(), true)
  const read = mailbox(endpoint), operationId = api.updates[0].clientOperationId
  assert.equal(read.facts.ack.operationId, operationId); assert.equal(read.facts.ack.replayed, true)
  assert.deepEqual(api.lookups, [operationId]); assert.equal(api.updates.length, 1)
  assert.notEqual(operationId, read.facts.transactionId)
})

for (const corrupted of ['operation', 'creation', 'content'] as const) test(`invalid ${corrupted} ACK cannot enter a mailbox; original validated lookup can settle it`, async () => {
  const { first, api } = await setup()
  api.update = async input => {
    const ack = api.saved(input)
    if (corrupted === 'operation') return { ...ack, operationId: randomUUID() }
    if (corrupted === 'creation') return { ...ack, snapshot: { ...ack.snapshot, creationId: randomUUID() } }
    return { ...ack, snapshot: { ...ack.snapshot, blocks: ack.snapshot.blocks.map(value => ({ ...value, content: 'invalid different content' })) } }
  }
  const endpoint = accept(first, 'valid pending content')
  assert.equal(await first.flush(), false)
  assert.equal(readSyncedWorkingEndpointCommitted(endpoint), null)
  assert.equal(await first.flush(), true)
  assert.equal(mailbox(endpoint).facts.ack.operationId, api.updates[0].clientOperationId)
  assert.deepEqual(api.lookups, [api.updates[0].clientOperationId]); assert.equal(api.updates.length, 1)
})

test('unknown lost operation queries never manufacture a committed mailbox', async () => {
  const { first, api } = await setup()
  api.update = async () => { throw new Error('Not known to be committed') }
  const endpoint = accept(first, 'not known committed')
  assert.equal(await first.flush(), false); assert.equal(readSyncedWorkingEndpointCommitted(endpoint), null)
  assert.equal(await first.flush(), false); assert.equal(readSyncedWorkingEndpointCommitted(endpoint), null)
  assert.equal(api.lookups.length, 1); assert.equal(api.updates.length, 2)
  assert.equal(api.updates[0].clientOperationId, api.updates[1].clientOperationId)
})

test('a validated content noop ACK remains the exact original operation mailbox', async () => {
  const value = snapshot('[A](Target.md)')
  value.bindings = [{ ...key(value.blocks[0]), target: { kind: 'document', id: 'original-target', state: 'live' } }]
  const { first, api } = await setup(new Api(value)), before = structuredClone(api.current)
  api.update = async input => {
    const ack: SyncedGroupSaved = { status: 'noop', operationId: input.clientOperationId, snapshot: structuredClone(api.current), replayed: false }
    api.operations.set(input.clientOperationId, ack); return ack
  }
  const body = first.getCurrent().working[0], applied = applySyncedGroupWithEndpoint(first,
    input(first, [body], 'noop-local-transaction', [{ kind: 'new', destination: key(body) }]))
  assert.ok(applied.accepted)
  assert.equal(await first.flush(), true)
  first.dispose()
  const read = mailbox(applied.endpoint)
  assert.equal(read.facts.ack.status, 'noop'); assert.deepEqual(read.facts.ack.snapshot, before)
  assert.equal(read.facts.ack.snapshot.history.undoToken, null)
})

test('workspace expiry during F1 ACK prevents a queued F2 write while retaining the original diagnostic mailbox', async () => {
  const { first, second, controller, workspace, api } = await setup(), started = deferred<void>(), gate = deferred<void>()
  api.update = async input => {
    if (api.updates.length === 1) { started.resolve(); await gate.promise }
    return api.saved(input)
  }
  // Both frames precede flush, so its original throughSequence includes F2.
  // Different mounts/transaction IDs keep them as two real frames.
  const original = accept(first, 'F1 before expiry', 'expiry-F1')
  const queued = accept(second, 'F2 queued before expiry', 'expiry-F2')
  const saving = first.flush()
  await started.promise
  api.workspaceScope = randomUUID()
  try {
    await assert.rejects(workspace.load([api.current.groupId]), /workspace identity changed/)
  } finally {
    gate.resolve()
  }
  assert.equal(await saving, false, 'expiry must stop the included F2 instead of completing the whole flush')
  assert.equal(api.updates.length, 1, 'only the already-pending F1 may reach the contract port')
  const read = mailbox(original)
  assert.equal(read.facts.ack.operationId, api.updates[0].clientOperationId)
  assert.equal(read.facts.ack.snapshot.blocks[0].content, 'F1 before expiry')
  assert.equal(read.facts.submittedEditSequence, 1)
  assert.equal(read.facts.acceptedEditSequence, 1)
  assert.equal(readSyncedWorkingEndpointCommitted(queued), null, 'unsent F2 must not acquire an ACK')
  assert.equal(readSyncedWorkingEndpoint(original).status, 'unavailable')
  assert.equal(readSyncedWorkingEndpoint(queued).status, 'unavailable')
  assert.equal(controller.getSnapshot().dirty, true, 'the unsent original F2 draft is retained')
  assert.equal(controller.getSnapshot().working[0].content, 'F2 queued before expiry')
  assert.equal(await controller.flush(), false, 'diagnostic receipt does not restore workspace write authority')
  assert.equal(api.updates.length, 1)
})

test('workspace expiry during original operation lookup cannot start a new history request after the ACK settles', async () => {
  const { first, controller, workspace, api } = await setup(), started = deferred<void>(), gate = deferred<void>()
  const restores: SyncedRestoreGroupInput[] = []
  api.update = async input => { api.saved(input); throw new Error('Original content ACK was lost') }
  api.restore = async input => {
    restores.push(structuredClone(input))
    return { status: 'missing', kind: 'group', id: api.current.groupId }
  }
  const original = accept(first, 'original before history expiry', 'history-expiry-original')
  assert.equal(await first.flush(), false)
  const operationId = api.updates[0].clientOperationId
  api.getSyncedOperation = async ({ clientOperationId }: { clientOperationId: string }) => {
    api.lookups.push(clientOperationId)
    started.resolve(); await gate.promise
    const ack = api.operations.get(clientOperationId)
    assert.ok(ack, 'the original stored operation must exist before resolving the lookup')
    return { status: 'committed' as const, result: { ...structuredClone(ack), replayed: true } }
  }
  const undoing = first.undo()
  await started.promise
  api.workspaceScope = randomUUID()
  try {
    await assert.rejects(workspace.load([api.current.groupId]), /workspace identity changed/)
  } finally {
    gate.resolve()
  }
  assert.equal(await undoing, false, 'the original ACK may settle, but expiry must stop the subsequent history operation')
  assert.equal(restores.length, 0, 'no history write may start after the read-only original lookup returned')
  assert.equal(api.updates.length, 1)
  assert.deepEqual(api.lookups, [operationId])
  assert.equal(mailbox(original).facts.ack.operationId, operationId)
  assert.equal(controller.getSnapshot().pending, null, 'do not stage a new unsent history request in an expired workspace')
  assert.equal(controller.getSnapshot().working[0].content, 'original before history expiry')
  assert.equal(readSyncedWorkingEndpoint(original).status, 'unavailable')
})

test('workspace expiry during an unknown operation lookup retains the original pending request without resending it', async () => {
  const { first, controller, workspace, api } = await setup(), started = deferred<void>(), gate = deferred<void>()
  api.update = async () => { throw new Error('The original request has no known committed result') }
  const original = accept(first, 'unsettled original content', 'unknown-expiry-original')
  assert.equal(await first.flush(), false)
  const operationId = api.updates[0].clientOperationId
  api.getSyncedOperation = async ({ clientOperationId }: { clientOperationId: string }) => {
    api.lookups.push(clientOperationId)
    started.resolve(); await gate.promise
    return { status: 'unknown' as const }
  }
  const settling = controller.flush()
  await started.promise
  api.workspaceScope = randomUUID()
  try {
    await assert.rejects(workspace.load([api.current.groupId]), /workspace identity changed/)
  } finally {
    gate.resolve()
  }
  assert.equal(await settling, false)
  assert.equal(api.updates.length, 1, 'an unknown read result must not resend even the same operation ID after expiry')
  assert.deepEqual(api.lookups, [operationId])
  assert.equal(readSyncedWorkingEndpointCommitted(original), null, 'unknown remains unknown')
  assert.equal(controller.getSnapshot().pending?.clientOperationId, operationId, 'preserve the exact unresolved original request')
  assert.equal(controller.getSnapshot().working[0].content, 'unsettled original content')
  assert.equal(await controller.flush(), false)
  assert.equal(api.updates.length, 1); assert.equal(api.lookups.length, 1)
})

