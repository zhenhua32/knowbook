import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type {
  SyncedBindingClaim, SyncedBindingKey, SyncedBlocksApi, SyncedBlocksChangedEvent, SyncedCanonicalEdit, SyncedGroupMutationResult,
  SyncedGroupSaved, SyncedGroupSnapshot, SyncedGroupSnapshotsResult, SyncedOperationResult,
  SyncedRestoreGroupInput, SyncedUpdateGroupInput
} from '../src/shared/synced-blocks'
import { getSyncedWorkspaceController } from '../src/renderer/src/features/synced-blocks/controller'
import { syncedScopeDomKey, syncedSnapshotGuard, type SyncedGroupBinding, type SyncedGroupScope,
  type SyncedScopeBookmark } from '../src/renderer/src/features/synced-blocks/types'

const time = '2026-10-16T00:00:00.000Z'
const paragraph = (content: string, id = '  旧:正文  '): SyncedCanonicalEdit => ({ id, type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null, tags: ['保留'], highlight: 'yellow' })
function snapshot(blocks: SyncedCanonicalEdit[] = [paragraph('initial')]): SyncedGroupSnapshot {
  const first = randomUUID(), second = randomUUID()
  return { groupId: randomUUID(), creationId: randomUUID(), createdAt: time, revision: randomUUID(), topologyRevision: randomUUID(),
    origin: { version: 1, documentId: 'origin', pathAtCreation: 'Home/Origin', firstInstanceId: first }, bindings: [],
    blocks: blocks.map(block => ({ ...block, createdAt: time })), maxRelativeDepth: Math.max(...blocks.map(block => block.depth)),
    instances: [{ instanceId: first, hostDocumentId: 'host-a', bindingVersion: randomUUID(), depth: 0, parentBlockId: null, parentType: null },
      { instanceId: second, hostDocumentId: 'host-b', bindingVersion: randomUUID(), depth: 0, parentBlockId: null, parentType: null }],
    history: { cursor: randomUUID(), undoToken: null, redoToken: null } }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** This is the injected contract port, not a fabricated Electron/window API. */
class Api implements SyncedBlocksApi {
  workspaceScope = randomUUID()
  updates: SyncedUpdateGroupInput[] = []
  restores: SyncedRestoreGroupInput[] = []
  lookups: string[] = []
  reads = 0
  listeners = new Set<(event: SyncedBlocksChangedEvent) => void>()
  operations = new Map<string, SyncedGroupSaved>()
  update: (input: SyncedUpdateGroupInput) => Promise<SyncedGroupMutationResult> = async input => this.saved(input)
  restore: (input: SyncedRestoreGroupInput) => Promise<SyncedGroupMutationResult> = async () => { throw new Error('Unexpected history request') }
  read: () => Promise<SyncedGroupSnapshotsResult> = async () => ({ workspaceScope: this.workspaceScope,
    items: [{ status: 'ready', snapshot: structuredClone(this.current) }] })
  operation: (id: string) => Promise<SyncedOperationResult> = async id => {
    const result = this.operations.get(id)
    return result ? { status: 'committed', result } : { status: 'unknown' }
  }
  constructor(public current = snapshot()) {}
  async getSyncedGroupSnapshots() { this.reads++; return this.read() }
  async listSyncedGroups() { return { items: [], total: 0 } }
  async updateSyncedBlockGroup(input: SyncedUpdateGroupInput) { this.updates.push(structuredClone(input)); return this.update(input) }
  async getSyncedOperation({ clientOperationId }: { clientOperationId: string }) { this.lookups.push(clientOperationId); return this.operation(clientOperationId) }
  async applySyncedHostStructure(): ReturnType<SyncedBlocksApi['applySyncedHostStructure']> { throw new Error('Controller must not write host structure') }
  async restoreSyncedGroupOperation(input: SyncedRestoreGroupInput) { this.restores.push(structuredClone(input)); return this.restore(input) }
  async restoreSyncedHostOperation(): ReturnType<SyncedBlocksApi['restoreSyncedHostOperation']> { throw new Error('Controller must not restore host history') }
  async getSyncedHostHistory() { return { cursor: randomUUID(), undoToken: null, redoToken: null } }
  onSyncedBlocksChanged(listener: (event: SyncedBlocksChangedEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  saved(input: SyncedUpdateGroupInput): SyncedGroupSaved {
    assert.equal(input.expectedRevision, this.current.revision)
    assert.equal(input.expectedTopologyRevision, this.current.topologyRevision)
    const created = new Map(this.current.blocks.map(block => [block.id, block.createdAt]))
    this.current = { ...this.current, revision: randomUUID(), blocks: input.blocks.map(block => ({ ...block, createdAt: created.get(block.id) ?? time })),
      maxRelativeDepth: Math.max(...input.blocks.map(block => block.depth)), history: { cursor: randomUUID(), undoToken: randomUUID(), redoToken: null } }
    const result: SyncedGroupSaved = { status: 'saved', operationId: input.clientOperationId, snapshot: structuredClone(this.current), replayed: false }
    this.operations.set(input.clientOperationId, result)
    this.emit(input.clientOperationId)
    return result
  }
  emit(operationId: string = randomUUID(), kind: 'content' | 'topology' = 'content') {
    for (const listener of this.listeners) listener({ operationId, changes: [{ groupId: this.current.groupId,
      revision: this.current.revision, topologyRevision: this.current.topologyRevision, kind }],
    affectedInstanceIds: this.current.instances.map(instance => instance.instanceId) })
  }
}

function scope(group: SyncedGroupSnapshot, index = 0): SyncedGroupScope {
  const instance = group.instances[index]
  return { owner: { kind: 'synced-group', groupId: group.groupId }, instanceId: instance.instanceId,
    bindingVersion: instance.bindingVersion, hostDocumentId: instance.hostDocumentId, windowSessionId: 'window',
    hostSession: {}, mountEpoch: {}, bindingEpoch: {}, domNamespace: 'workspace', root: () => null, isCurrent: () => true }
}
function bookmark(scope: SyncedGroupScope): SyncedScopeBookmark {
  return { owner: scope.owner, instanceId: scope.instanceId, mountEpoch: scope.mountEpoch, bindingEpoch: scope.bindingEpoch,
    selection: { blockId: '  旧:正文  ', index: 0, start: 1, end: 1, direction: 'none' } }
}
function apply(binding: SyncedGroupBinding, blocks: SyncedCanonicalEdit[], transactionId: string = randomUUID(), mark: SyncedScopeBookmark | null = null) {
  const state = binding.getCurrent()
  return binding.apply({ blocks, transactionId, bookmark: mark, expectedEditSequence: state.editSequence, guards: syncedSnapshotGuard(state.snapshot) })
}
async function setup(api = new Api()) {
  const workspace = getSyncedWorkspaceController(api)
  await workspace.load([api.current.groupId])
  const controller = workspace.getGroup(api.current.groupId)
  assert.ok(controller)
  const first = controller.bind(scope(api.current)), second = controller.bind(scope(api.current, 1))
  return { api, workspace, controller, first, second }
}
function nested(depth: number): SyncedCanonicalEdit[] {
  return Array.from({ length: depth + 1 }, (_, index) => ({ id: `nested-${index}`, type: index === depth ? 'paragraph' : 'toggle',
    content: `Depth ${index}`, checked: false, depth: index, parentBlockId: index ? `nested-${index - 1}` : null }))
}

function singleCommittedHistory(api: Api, before: SyncedGroupSnapshot, after: SyncedGroupSnapshot) {
  api.restore = async input => {
    assert.equal(input.expectedRevision, api.current.revision)
    assert.equal(input.expectedTopologyRevision, api.current.topologyRevision)
    assert.equal(input.expectedHistoryCursor, api.current.history.cursor)
    assert.equal(input.historyToken, input.direction === 'undo' ? api.current.history.undoToken : api.current.history.redoToken)
    const target = input.direction === 'undo' ? before : after
    api.current = { ...api.current, blocks: structuredClone(target.blocks), revision: randomUUID(),
      history: { cursor: randomUUID(), undoToken: input.direction === 'redo' ? randomUUID() : null,
        redoToken: input.direction === 'undo' ? randomUUID() : null } }
    const result: SyncedGroupSaved = { status: 'saved', operationId: input.clientOperationId, replayed: false,
      snapshot: structuredClone(api.current) }
    api.operations.set(input.clientOperationId, result)
    api.emit(input.clientOperationId)
    return result
  }
}

function linkKey(block: SyncedCanonicalEdit): SyncedBindingKey {
  const raw = 'Target.md', from = block.content.indexOf(raw)
  assert.ok(from >= 0)
  return { blockId: block.id, from, to: from + raw.length, raw, syntax: 'markdown' }
}
function tracedApi() {
  const initial = paragraph('[old](Target.md)'), current = snapshot([initial])
  current.bindings = [{ ...linkKey(initial), target: { kind: 'document', id: 'original-target', state: 'live' } }]
  const api = new Api(current)
  api.update = async input => {
    const old = api.current.bindings
    api.current = { ...api.current, bindings: input.bindingClaims!.map(claim => {
      const source = claim.kind === 'continue' ? claim.source : claim.kind === 'copy' && claim.source.kind === 'current' ? claim.source.key : null
      const previous = source && old.find(binding => binding.blockId === source.blockId && binding.from === source.from && binding.to === source.to
        && binding.raw === source.raw && binding.syntax === source.syntax)
      if (source) assert.ok(previous)
      return { ...claim.destination, target: previous ? previous.target : { kind: 'document' as const, id: 'new-target', state: 'live' as const } }
    }) }
    return api.saved(input)
  }
  return api
}
function applyClaims(binding: SyncedGroupBinding, blocks: SyncedCanonicalEdit[], bindingClaims: SyncedBindingClaim[], transactionId: string) {
  const state = binding.getCurrent()
  return binding.apply({ blocks, bindingClaims, transactionId, bookmark: null, expectedEditSequence: state.editSequence,
    guards: syncedSnapshotGuard(state.snapshot) })
}

test('coalesced link traces compose exact keys, mirror across instances and survive local Undo Redo before one submission', async () => {
  const { api, first, second } = await setup(tracedApi()), original = first.getCurrent().working[0]
  const middle = paragraph('prefix ' + original.content), final = paragraph(middle.content + ' suffix')
  assert.equal(applyClaims(first, [middle], [{ kind: 'continue', source: linkKey(original), destination: linkKey(middle) }], 'trace-action'), true)
  assert.equal(second.getCurrent(), first.getCurrent())
  assert.equal(applyClaims(first, [final], [{ kind: 'continue', source: linkKey(middle), destination: linkKey(final) }], 'trace-action'), true)
  assert.equal(await second.undo(), true); assert.deepEqual(first.getCurrent().working, [original])
  assert.equal(await first.redo(), true); assert.deepEqual(second.getCurrent().working, [final])
  assert.equal(await first.flush(), true); assert.equal(api.updates.length, 1)
  assert.deepEqual(api.updates[0].bindingClaims, [{ kind: 'continue', source: linkKey(original), destination: linkKey(final) }])
  assert.deepEqual(first.getCurrent().snapshot.bindings[0].target, { kind: 'document', id: 'original-target', state: 'live' })
})

test('same-text new-link intent and a coalesced return to original text remain dirty and submit their provenance', async () => {
  for (const returnToOriginal of [false, true]) {
    const { api, first } = await setup(tracedApi()), original = first.getCurrent().working[0]
    let source = original
    if (returnToOriginal) {
      source = paragraph('prefix ' + original.content)
      assert.equal(applyClaims(first, [source], [{ kind: 'continue', source: linkKey(original), destination: linkKey(source) }], 'replace-link'), true)
    }
    assert.equal(applyClaims(first, [original], [{ kind: 'new', destination: linkKey(original) }], 'replace-link'), true)
    assert.equal(first.getCurrent().dirty, true)
    assert.equal(await first.flush(), true)
    assert.deepEqual(api.updates[0].bindingClaims, [{ kind: 'new', destination: linkKey(original) }])
    assert.deepEqual(first.getCurrent().snapshot.bindings[0].target, { kind: 'document', id: 'new-target', state: 'live' })
  }
})

test('late ACK keeps the next frame trace relative to its exact submitted predecessor and preserves the source across occurrences', async () => {
  const { api, first, second } = await setup(tracedApi()), original = first.getCurrent().working[0]
  const middle = paragraph('prefix ' + original.content), final = paragraph(middle.content + ' suffix')
  const gate = deferred<void>(), writer = api.update
  api.update = async input => { if (api.updates.length === 1) await gate.promise; return writer(input) }
  assert.equal(applyClaims(first, [middle], [{ kind: 'continue', source: linkKey(original), destination: linkKey(middle) }], 'first-action'), true)
  const firstFlush = first.flush()
  await setImmediate()
  assert.equal(api.updates.length, 1)
  assert.equal(applyClaims(second, [final], [{ kind: 'continue', source: linkKey(middle), destination: linkKey(final) }], 'later-action'), true)
  gate.resolve(); assert.equal(await firstFlush, true)
  assert.deepEqual(first.getCurrent().working, [final]); assert.equal(first.getCurrent().dirty, true)
  assert.equal(await second.flush(), true)
  assert.deepEqual(api.updates[1].bindingClaims, [{ kind: 'continue', source: linkKey(middle), destination: linkKey(final) }])
  assert.equal(first.getCurrent().dirty, false)
})

test('invalid local trace leaves working content, sequence and Undo intact', async () => {
  const { first } = await setup(tracedApi()), before = first.getCurrent(), block = before.working[0]
  const next = paragraph('prefix ' + block.content)
  assert.equal(applyClaims(first, [next], [{ kind: 'continue', source: { ...linkKey(block), blockId: 'foreign' }, destination: linkKey(next) }], 'invalid'), false)
  assert.deepEqual(first.getCurrent().working, before.working)
  assert.equal(first.getCurrent().editSequence, before.editSequence)
  assert.equal(first.getCurrent().canUndo, before.canUndo)
  assert.equal(first.getCurrent().failure?.status, 'invalid')
})

test('one injected workspace shares its group controller, request and subscriptions across occurrences', async () => {
  const api = new Api(), workspace = getSyncedWorkspaceController(api)
  assert.equal(getSyncedWorkspaceController(api), workspace)
  await Promise.all([workspace.load([api.current.groupId, api.current.groupId]), workspace.load([api.current.groupId])])
  assert.equal(api.reads, 1); assert.equal(api.listeners.size, 1)
  const controller = workspace.getGroup(api.current.groupId)!
  const first = controller.bind(scope(api.current)), second = controller.bind(scope(api.current, 1))
  let a = 0, b = 0
  const stopA = first.subscribe(() => a++), stopB = second.subscribe(() => b++)
  const blocks = [paragraph('shared working')]
  assert.equal(apply(first, blocks), true)
  assert.equal(first.getCurrent(), second.getCurrent()); assert.equal(a, 1); assert.equal(b, 1)
  blocks[0].content = 'mutated caller object'
  assert.equal(second.getCurrent().working[0].content, 'shared working')
  assert.equal(Object.hasOwn(second.getCurrent().working[0], 'createdAt'), false)
  assert.equal(second.getCurrent().working[0].id, '  旧:正文  ')
  stopA(); stopB(); first.dispose(); second.dispose()
  assert.equal(workspace.releaseClean(api.current.groupId), false, 'dirty groups survive their last occurrence')
  assert.equal(await controller.flush(), true)
  assert.equal(workspace.releaseClean(api.current.groupId), true)
  assert.equal(workspace.dispose(), true); assert.equal(api.listeners.size, 0)
})

test('raw invalid forests, nested references and empty last deletion are rejected without accepting an edit or filler', async () => {
  const { first, api } = await setup()
  const initial = first.getCurrent().working
  const invalid = [paragraph('bad child')]; invalid[0].depth = 1
  assert.equal(apply(first, invalid), false)
  assert.equal(apply(first, []), false)
  assert.equal(apply(first, [{ ...paragraph(''), type: 'synced-block', content: JSON.stringify({ version: 1, groupId: randomUUID() }) }]), false)
  assert.equal(apply(first, [Object.assign(paragraph('metadata'), { createdAt: time })]), false)
  assert.equal(first.getCurrent().working, initial); assert.equal(first.getCurrent().editSequence, 0)
  assert.equal(first.getCurrent().canUndo, false); assert.equal(api.updates.length, 0)
  const explicit = paragraph('', randomUUID())
  assert.equal(apply(first, [explicit]), true)
  assert.deepEqual(first.getCurrent().working, [explicit], 'only an explicit real empty paragraph replaces the last block')
})

test('local checkpoints, cross-occurrence Undo and Redo preserve the shared branch after invalid and no-op edits', async () => {
  const { first, second } = await setup()
  assert.equal(apply(first, [paragraph('one')], 'typing'), true)
  assert.equal(apply(first, [paragraph('two')], 'typing'), true)
  assert.equal(await second.undo(), true)
  assert.equal(second.getCurrent().working[0].content, 'initial', 'one typing transaction undoes once')
  const sequence = first.getCurrent().editSequence
  assert.equal(apply(first, []), false)
  assert.equal(apply(first, [paragraph('initial')]), false)
  assert.equal(first.getCurrent().editSequence, sequence); assert.equal(first.getCurrent().canRedo, true)
  assert.equal(await first.redo(), true); assert.equal(first.getCurrent().working[0].content, 'two')
})

test('mount and binding epochs isolate bookmarks and permanently invalidate A to B to A callbacks', async () => {
  const { controller, api, first, second } = await setup()
  assert.equal(apply(first, [paragraph('owner')], 'owner', bookmark(first.scope)), true)
  assert.equal(second.getBookmark(), null)
  assert.equal(apply(second, [paragraph('foreign bookmark')], 'other', bookmark(first.scope)), false)
  const replacement = controller.bind(scope(api.current))
  assert.equal(first.isCurrent(), false); assert.equal(apply(first, [paragraph('stale')]), false)
  replacement.dispose()
  const returned = controller.bind(scope(api.current))
  assert.equal(apply(first, [paragraph('still stale')]), false)
  assert.equal(apply(returned, [paragraph('fresh')]), true)
  returned.scope.mountEpoch = {}
  assert.equal(returned.isCurrent(), false, 'mutating a reused scope object cannot renew its captured lease')
  assert.notEqual(syncedScopeDomKey(first.scope, 'a:b', 'c'), syncedScopeDomKey(second.scope, 'a', 'b:c'))
})

test('selection-only bookmark capture does not publish or create history and supplies the first edit before-caret', async () => {
  const { first, second } = await setup()
  let publications = 0
  first.subscribe(() => publications++)
  const before = bookmark(first.scope), after = { ...before, selection: { ...before.selection, start: 4, end: 4 } }
  first.setBookmark(before)
  assert.equal(publications, 0); assert.equal(first.getCurrent().canUndo, false)
  assert.equal(apply(first, [paragraph('caret transaction')], 'caret', after), true)
  assert.equal(await first.undo(), true); assert.deepEqual(first.getBookmark(), before)
  assert.equal(second.getBookmark(), null)
  assert.equal(await first.redo(), true); assert.deepEqual(first.getBookmark(), after)
  first.setBookmark(bookmark(second.scope))
  assert.deepEqual(first.getBookmark(), after, 'another occurrence cannot replace this caret')
})

test('a single physical writer confirms only the submitted sequence while a newer occurrence keeps typing', async () => {
  const { api, first, second } = await setup(), responses = [deferred<SyncedGroupMutationResult>(), deferred<SyncedGroupMutationResult>()]
  api.update = input => responses[api.updates.length - 1].promise
  apply(first, [paragraph('submitted')])
  const savedFirst = first.flush(); await setImmediate()
  assert.equal(api.updates.length, 1)
  apply(second, [paragraph('typed while saving')])
  const savedSecond = second.flush(); await setImmediate()
  assert.equal(api.updates.length, 1, 'the second occurrence cannot start another writer')
  responses[0].resolve(api.saved(api.updates[0]))
  assert.equal(await savedFirst, true)
  assert.equal(first.getCurrent().working[0].content, 'typed while saving'); assert.equal(first.getCurrent().dirty, true)
  await setImmediate(); assert.equal(api.updates.length, 2)
  assert.equal(api.updates[1].expectedRevision, api.current.revision)
  responses[1].resolve(api.saved(api.updates[1]))
  assert.equal(await savedSecond, true); assert.equal(first.getCurrent().dirty, false)
  assert.equal(first.getCurrent().working[0].content, 'typed while saving')
  assert.equal(api.reads, 1, 'its own typed events never race an extra snapshot over the acknowledgement')
})

test('each closed checkpoint persists in order and committed Undo sends the exact server tail and cursor', async () => {
  const { api, first, second } = await setup()
  apply(first, [paragraph('first action')]); first.checkpoint(); apply(first, [paragraph('second action')])
  assert.equal(await first.flush(), true); assert.equal(api.updates.length, 2)
  const before = first.getCurrent().snapshot
  api.restore = async input => {
    assert.equal(input.historyToken, before.history.undoToken); assert.equal(input.expectedHistoryCursor, before.history.cursor)
    assert.equal(input.expectedRevision, before.revision); assert.equal(input.expectedTopologyRevision, before.topologyRevision)
    assert.equal(input.expectedInstanceBinding.instanceId, second.scope.instanceId)
    api.current = { ...api.current, revision: randomUUID(), blocks: [{ ...paragraph('first action'), createdAt: time }],
      history: { cursor: randomUUID(), undoToken: randomUUID(), redoToken: randomUUID() } }
    return { status: 'saved', operationId: input.clientOperationId, replayed: false, snapshot: structuredClone(api.current) }
  }
  assert.equal(await second.undo(), true); assert.equal(api.restores.length, 1)
  assert.equal(first.getCurrent().working[0].content, 'first action'); assert.equal(first.getCurrent().canRedo, true)
})

test('local Redo survives an earlier committed Undo and runs only after the exact server side has been redone', async () => {
  const { api, first, second } = await setup(), initial = structuredClone(api.current)
  assert.equal(apply(first, [paragraph('committed A')]), true)
  assert.equal(await first.flush(), true)
  const savedA = structuredClone(api.current)
  singleCommittedHistory(api, initial, savedA)
  assert.equal(apply(second, [paragraph('local B')]), true)
  assert.equal(await first.undo(), true)
  assert.equal(first.getCurrent().working[0].content, 'committed A')
  assert.equal(api.restores.length, 0); assert.equal(api.updates.length, 1)

  assert.equal(await second.undo(), true)
  assert.equal(first.getCurrent().working[0].content, 'initial')
  assert.equal(api.restores.length, 1); assert.equal(first.getCurrent().canRedo, true)
  assert.equal(await first.redo(), true)
  assert.equal(first.getCurrent().working[0].content, 'committed A', 'the server A side must precede the local B frame')
  assert.equal(api.restores.length, 2); assert.equal(first.getCurrent().canRedo, true)
  assert.equal(api.restores[1].historyToken, api.operations.get(api.restores[0].clientOperationId)!.snapshot.history.redoToken)
  assert.equal(api.restores[1].expectedHistoryCursor, api.operations.get(api.restores[0].clientOperationId)!.snapshot.history.cursor)

  assert.equal(await second.redo(), true)
  assert.equal(first.getCurrent().working[0].content, 'local B')
  assert.equal(first.getCurrent().dirty, true); assert.equal(first.getCurrent().canRedo, false)
  assert.equal(api.updates.length, 1, 'Undo/Redo must not eagerly persist local B')
  assert.equal(api.restores.length, 2); assert.equal(api.lookups.length, 0)
  assert.equal(await first.flush(), true)
  assert.equal(api.updates.length, 2); assert.equal(api.current.blocks[0].content, 'local B')
})

test('new local content after a committed Undo cuts both the server continuation and suspended local Redo', async () => {
  const { api, first } = await setup(), initial = structuredClone(api.current)
  apply(first, [paragraph('committed A')]); assert.equal(await first.flush(), true)
  singleCommittedHistory(api, initial, structuredClone(api.current))
  apply(first, [paragraph('local B')]); assert.equal(await first.undo(), true)
  assert.equal(await first.undo(), true)
  assert.equal(apply(first, [paragraph('new C')]), true)
  assert.equal(await first.undo(), true)
  assert.equal(first.getCurrent().working[0].content, 'initial')
  assert.equal(await first.redo(), true)
  assert.equal(first.getCurrent().working[0].content, 'new C')
  assert.equal(first.getCurrent().canRedo, false)
  assert.equal(await first.undo(), true)
  assert.equal(apply(first, [paragraph('temporary')], 'same-transaction'), true)
  assert.equal(apply(first, [paragraph('initial')], 'same-transaction'), true)
  assert.equal(first.getCurrent().dirty, false)
  assert.equal(first.getCurrent().canRedo, false, 'returning new input to baseline cannot revive the earlier A/B branch')
  assert.equal(await first.redo(), false)
  assert.equal(api.updates.length, 1); assert.equal(api.restores.length, 1)
})

test('an external semantic boundary discards the suspended local branch instead of rebasing it onto a new server cursor', async () => {
  const { api, workspace, first } = await setup(), initial = structuredClone(api.current)
  apply(first, [paragraph('committed A')]); assert.equal(await first.flush(), true)
  singleCommittedHistory(api, initial, structuredClone(api.current))
  apply(first, [paragraph('local B')]); assert.equal(await first.undo(), true)
  assert.equal(await first.undo(), true)
  api.current = { ...api.current, revision: randomUUID(), blocks: [{ ...paragraph('external boundary'), createdAt: time }],
    history: { cursor: randomUUID(), undoToken: null, redoToken: null } }
  api.emit(); await workspace.load([api.current.groupId])
  assert.equal(first.getCurrent().working[0].content, 'external boundary')
  assert.equal(first.getCurrent().canRedo, false)
  assert.equal(await first.redo(), false)
  assert.equal(api.updates.length, 1); assert.equal(api.restores.length, 1)
})

test('invalid snapshot history is rejected at initial load, acknowledgement and refresh without consuming a draft', async () => {
  const invalid = snapshot(); invalid.history.cursor = 'not-a-history-uuid'
  const invalidApi = new Api(invalid), invalidWorkspace = getSyncedWorkspaceController(invalidApi)
  await assert.rejects(invalidWorkspace.load([invalid.groupId]))
  assert.equal(invalidWorkspace.getGroup(invalid.groupId), undefined)
  assert.equal(invalidWorkspace.dispose(), true)

  const { api, workspace, first } = await setup(), baseline = first.getCurrent().snapshot
  api.update = async input => {
    const saved = api.saved(input)
    return { ...saved, snapshot: { ...saved.snapshot, history: { ...saved.snapshot.history, cursor: 'not-a-history-uuid' } } }
  }
  apply(first, [paragraph('draft with a malformed acknowledgement')])
  assert.equal(await first.flush(), false)
  assert.equal(first.getCurrent().snapshot, baseline)
  assert.equal(first.getCurrent().working[0].content, 'draft with a malformed acknowledgement')
  assert.equal(first.getCurrent().dirty, true); assert.ok(first.getCurrent().pending)
  assert.equal(await first.flush(), true, 'the original operation lookup supplies the valid committed acknowledgement')
  assert.equal(api.updates.length, 1); assert.equal(api.lookups.length, 1)
  const accepted = first.getCurrent().snapshot
  api.read = async () => ({ workspaceScope: api.workspaceScope, items: [{ status: 'ready',
    snapshot: { ...api.current, history: { ...api.current.history, cursor: 'not-a-history-uuid' } } }] })
  await assert.rejects(workspace.load([api.current.groupId]))
  assert.equal(first.getCurrent().snapshot, accepted)
  assert.equal(first.getCurrent().working[0].content, 'draft with a malformed acknowledgement')
  assert.equal(first.getCurrent().phase, 'error')
})

test('committed history retains its original scoped bookmark but a late reply cannot replace newer selection activity', async () => {
  const { api, first } = await setup()
  const before = bookmark(first.scope), after = { ...before, selection: { ...before.selection, start: 4, end: 4 } }
  first.setBookmark(before); apply(first, [paragraph('saved action')], 'action', after)
  assert.equal(await first.flush(), true)
  const reply = deferred<SyncedGroupMutationResult>()
  api.restore = () => reply.promise
  const undone = first.undo(); await setImmediate()
  const newer = { ...after, selection: { ...after.selection, start: 2, end: 2 } }
  first.setBookmark(newer)
  const restore = api.restores[0]
  api.current = { ...api.current, revision: randomUUID(), blocks: [{ ...paragraph('initial'), createdAt: time }],
    history: { cursor: randomUUID(), undoToken: null, redoToken: randomUUID() } }
  reply.resolve({ status: 'saved', operationId: restore.clientOperationId, replayed: false, snapshot: structuredClone(api.current) })
  assert.equal(await undone, true); assert.equal(first.getCurrent().working[0].content, 'initial')
  assert.deepEqual(first.getBookmark(), newer)
})

test('an uncertain content acknowledgement queries the original operation and never resends it under a fresh ID', async () => {
  const { api, first } = await setup()
  api.update = async input => { api.saved(input); throw new Error('IPC reply lost after commit') }
  apply(first, [paragraph('committed reply lost')])
  assert.equal(await first.flush(), false)
  const pendingId = first.getCurrent().pending!.clientOperationId
  assert.equal(first.getCurrent().phase, 'error')
  apply(first, [paragraph('newer unsaved input')])
  api.update = async input => api.saved(input)
  assert.equal(await first.flush(), true)
  assert.deepEqual(api.lookups, [pendingId]); assert.equal(api.updates.length, 2)
  assert.equal(api.updates[0].clientOperationId, pendingId); assert.notEqual(api.updates[1].clientOperationId, pendingId)
  assert.equal(first.getCurrent().working[0].content, 'newer unsaved input')
})

test('an unknown operation lookup retries only its identical original request', async () => {
  const { api, first } = await setup()
  api.update = async () => { throw new Error('Request did not reach main') }
  apply(first, [paragraph('retained request')]); assert.equal(await first.flush(), false)
  api.update = async input => api.saved(input)
  assert.equal(await first.flush(), true)
  assert.equal(api.lookups.length, 1); assert.deepEqual(api.updates[1], api.updates[0])
})

test('external content while dirty retains the original CAS, working forest and incoming conflict without a write', async () => {
  const { api, workspace, first } = await setup(), baseline = first.getCurrent().snapshot
  apply(first, [paragraph('local draft')])
  const sequence = first.getCurrent().editSequence
  api.current = { ...api.current, revision: randomUUID(), blocks: [{ ...paragraph('remote'), createdAt: time }] }
  api.emit(); await workspace.load([api.current.groupId])
  assert.equal(first.getCurrent().phase, 'conflict'); assert.equal(first.getCurrent().snapshot.revision, baseline.revision)
  assert.equal(first.getCurrent().working[0].content, 'local draft'); assert.equal(first.getCurrent().incoming!.blocks[0].content, 'remote')
  assert.equal(first.getCurrent().editSequence, sequence); assert.equal(await first.flush(), false)
  assert.equal(api.updates.length, 0); assert.equal(first.getCurrent().canUndo, true)
})

test('a failed history tail does not advance local content, replace CAS or consume Redo', async () => {
  const initial = snapshot(); initial.history = { cursor: randomUUID(), undoToken: randomUUID(), redoToken: randomUUID() }
  const { api, first } = await setup(new Api(initial)), before = first.getCurrent()
  api.restore = async () => ({ status: 'conflict', kind: 'history', groups: [structuredClone(api.current)], hosts: [] })
  assert.equal(await first.undo(), false)
  assert.equal(first.getCurrent().working, before.working); assert.equal(first.getCurrent().snapshot, before.snapshot)
  assert.equal(first.getCurrent().editSequence, before.editSequence); assert.equal(first.getCurrent().canRedo, true)
})

test('pure topology constraints retain dirty frames and permit a later shallow correction without flushing the group first', async () => {
  const { api, workspace, first } = await setup()
  apply(first, nested(5)); const originalRevision = first.getCurrent().snapshot.revision
  const deep = { instanceId: randomUUID(), hostDocumentId: 'other-host', bindingVersion: randomUUID(), depth: 2,
    parentBlockId: 'parent', parentType: 'toggle' }
  api.current = { ...api.current, topologyRevision: randomUUID(), instances: [...api.current.instances, deep] }
  api.emit(randomUUID(), 'topology'); await workspace.load([api.current.groupId])
  assert.equal(first.getCurrent().snapshot.revision, originalRevision)
  assert.equal(first.getCurrent().failure?.status, 'invalid'); assert.equal(first.getCurrent().working.at(-1)!.depth, 5)
  assert.equal(await first.flush(), false); assert.equal(api.updates.length, 0)
  // The actual structural owner can move the reference using committed content;
  // the controller receives that topology result without any group flush.
  api.current = { ...api.current, topologyRevision: randomUUID(), instances: api.current.instances.map(instance =>
    instance.instanceId === deep.instanceId ? { ...instance, depth: 1, parentBlockId: 'shallower-parent',
      parentType: 'callout', bindingVersion: randomUUID() } : instance) }
  api.emit(randomUUID(), 'topology'); await workspace.load([api.current.groupId])
  assert.equal(first.getCurrent().failure, null); assert.equal(first.getCurrent().dirty, true)
  assert.equal(await first.flush(), true); assert.equal(api.updates.length, 1)
  assert.equal(api.updates[0].expectedTopologyRevision, api.current.topologyRevision)
})

test('IME belongs to its occurrence and unmounting does not fabricate its completion or permit a flush', async () => {
  const { api, workspace, controller, first, second } = await setup()
  first.setComposing(true)
  assert.equal(apply(first, [paragraph('IME committed draft')]), true)
  assert.equal(apply(second, [paragraph('other occurrence')]), false)
  assert.equal(await first.flush(), false); assert.equal(api.updates.length, 0)
  first.dispose(); second.dispose()
  assert.deepEqual(controller.getSnapshot().composingInstanceIds, [first.scope.instanceId])
  assert.equal(await controller.flush(), false); assert.equal(workspace.dispose(), false)
  first.setComposing(false)
  assert.equal(await controller.flush(), true)
})

test('an external clean snapshot during composition is parked rather than replacing the IME document', async () => {
  const { api, workspace, first } = await setup()
  first.setComposing(true)
  api.current = { ...api.current, revision: randomUUID(), blocks: [{ ...paragraph('external during IME'), createdAt: time }] }
  await workspace.load([api.current.groupId])
  assert.equal(first.getCurrent().working[0].content, 'initial')
  assert.equal(first.getCurrent().incoming!.blocks[0].content, 'external during IME')
  assert.equal(first.getCurrent().phase, 'conflict')
})

test('a late accepted acknowledgement updates its group after unmount without reviving its old callback', async () => {
  const { api, controller, first } = await setup(), reply = deferred<SyncedGroupMutationResult>()
  api.update = () => reply.promise
  apply(first, [paragraph('accepted old occurrence')]); const flushed = first.flush(); await setImmediate()
  first.dispose()
  reply.resolve(api.saved(api.updates[0])); assert.equal(await flushed, true)
  assert.equal(controller.getSnapshot().working[0].content, 'accepted old occurrence')
  assert.equal(apply(first, [paragraph('late new host write')]), false)
})

test('a snapshot read overtaken by a local acknowledgement is reread instead of replacing the newer state', async () => {
  const { api, workspace, first } = await setup(), read = deferred<SyncedGroupSnapshotsResult>(), old = structuredClone(api.current)
  api.read = () => read.promise
  const refresh = workspace.load([old.groupId])
  apply(first, [paragraph('new saved content')]); assert.equal(await first.flush(), true)
  api.read = async () => ({ workspaceScope: api.workspaceScope, items: [{ status: 'ready', snapshot: structuredClone(api.current) }] })
  read.resolve({ workspaceScope: api.workspaceScope, items: [{ status: 'ready', snapshot: old }] })
  await refresh
  assert.equal(api.reads, 3); assert.equal(first.getCurrent().working[0].content, 'new saved content')
  assert.equal(first.getCurrent().snapshot.revision, api.current.revision)
})

test('an event during the first request invalidates that read before a controller can publish it', async () => {
  const api = new Api(), workspace = getSyncedWorkspaceController(api), pending = deferred<SyncedGroupSnapshotsResult>()
  const before = structuredClone(api.current)
  api.read = () => pending.promise
  const load = workspace.load([api.current.groupId])
  api.current = { ...api.current, revision: randomUUID(), blocks: [{ ...paragraph('new first read'), createdAt: time }] }
  api.emit()
  api.read = async () => ({ workspaceScope: api.workspaceScope, items: [{ status: 'ready', snapshot: structuredClone(api.current) }] })
  pending.resolve({ workspaceScope: api.workspaceScope, items: [{ status: 'ready', snapshot: before }] })
  await load
  assert.equal(api.reads, 2)
  assert.equal(workspace.getGroup(api.current.groupId)!.getSnapshot().working[0].content, 'new first read')
})

test('a failing subscriber cannot abort an accepted edit or prevent another occurrence from receiving it', async () => {
  const api = new Api(), observed: unknown[] = []
  const workspace = getSyncedWorkspaceController(api, { onSubscriberError: error => { observed.push(error); throw new Error('Reporter failed') } })
  await workspace.load([api.current.groupId])
  const controller = workspace.getGroup(api.current.groupId)!, first = controller.bind(scope(api.current))
  let notified = 0
  controller.subscribe(() => { throw new Error('Broken subscriber') })
  controller.subscribe(() => notified++)
  assert.equal(apply(first, [paragraph('accepted once')]), true)
  assert.equal(first.getCurrent().editSequence, 1); assert.equal(notified, 1); assert.equal(observed.length, 1)
})

test('a changed workspace identity fails closed and preserves a dirty controller for explicit recovery', async () => {
  const { api, workspace, first } = await setup()
  apply(first, [paragraph('private retained draft')]); const before = first.getCurrent()
  api.workspaceScope = randomUUID()
  await assert.rejects(workspace.load([api.current.groupId]), /workspace identity changed/)
  assert.equal(first.getCurrent().working, before.working); assert.equal(first.getCurrent().snapshot, before.snapshot)
  assert.equal(first.getCurrent().phase, 'error'); assert.equal(workspace.dispose(), false)
  assert.equal(await first.flush(), false); assert.equal(api.updates.length, 0)
  assert.equal(apply(first, [paragraph('cannot apply into replacement workspace')]), false)
})
