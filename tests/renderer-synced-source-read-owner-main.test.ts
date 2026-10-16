import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { EditorState } from '@codemirror/state'
import { markdownEngine } from '../src/shared/markdownEngine'
import type { SyncedBindingKey, SyncedBlocksApi, SyncedBlocksChangedEvent, SyncedGroupSaved,
  SyncedGroupSnapshot, SyncedRestoreGroupInput, SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import { captureSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { captureSyncedBaselineOwner, getSyncedOperationWithOwnedLinkSource, validateSyncedReadOwner, releaseSyncedReadOwner,
  resolveSyncedBindingSource } from '../src/main/database/synced-binding-sources'
import { getSyncedGroupSnapshots } from '../src/main/database/synced-blocks-read'
import { getSyncedOperation, updateSyncedBlockGroup, restoreSyncedGroupOperation } from '../src/main/database/synced-blocks-content'
import { installSyncedLifecycleSchema } from '../src/main/database/synced-lifecycle-schema'
import { getSyncedWorkspaceController, readSyncedCommittedEndpoint, type SyncedControllerOptions } from '../src/renderer/src/features/synced-blocks/controller'
import { openSyncedSourceCheckpoint, prepareSourceCheckpoint, applyPreparedSourceCheckpoint, readAcceptedSourceCheckpoint,
  createCanonicalSourceLedgerSession, openSyncedSourceReadOwner, adoptSyncedSourceBaseline, adoptSyncedAcceptedSource,
  closeSyncedSourceReadOwner, readAdoptedSourceSide, readSourceReadOwnerAccess,
  type SourceReadOwner, type SourceLedgerDraft } from '../src/renderer/src/features/synced-blocks/sourceLedger'
import { markdownSourceEditorText } from '../src/renderer/src/utils/markdownSourceSession'
import type { SyncedGroupBinding, SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'
import { now, host, other, groupId, initialize, addInstance, snapshot } from './helpers/synced-content-fixture'

type Baseline = Extract<ReturnType<typeof captureSyncedBaselineOwner>, { status: 'ready' }>
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const key = ({ blockId, from, to, raw, syntax }: SyncedBindingKey): SyncedBindingKey => ({ blockId, from, to, raw, syntax })
const keyId = (value: SyncedBindingKey) => canonicalSyncedPortableJson([value.blockId, value.from, value.to, value.raw, value.syntax])

/** The writer and ordinary operation lookup are the actual Main functions.
 * Tests control delivery separately from the already durable SQLite commit. */
class MainApi implements SyncedBlocksApi {
  readonly reads: string[][] = []
  readonly writes: SyncedUpdateGroupInput[] = []
  readonly lookups: string[] = []
  readonly listeners = new Set<(event: SyncedBlocksChangedEvent) => void>()
  deliver: (ack: SyncedGroupSaved) => Promise<SyncedGroupSaved> = async ack => ack
  snapshotReply = (value: ReturnType<typeof getSyncedGroupSnapshots>) => value
  constructor(public db: Database.Database) {}
  async getSyncedGroupSnapshots(input: { groupIds: string[] }) {
    this.reads.push([...input.groupIds]); return this.snapshotReply(getSyncedGroupSnapshots(this.db, input))
  }
  async listSyncedGroups() { return { items: [], total: 0 } }
  async updateSyncedBlockGroup(input: SyncedUpdateGroupInput) {
    this.writes.push(structuredClone(input))
    const result = updateSyncedBlockGroup(this.db, input)
    return 'snapshot' in result ? this.deliver(result) : result
  }
  async getSyncedOperation(input: { clientOperationId: string }) {
    this.lookups.push(input.clientOperationId); return getSyncedOperation(this.db, input)
  }
  async applySyncedHostStructure(): ReturnType<SyncedBlocksApi['applySyncedHostStructure']> { throw new Error('No structure writer in this slice') }
  async restoreSyncedGroupOperation(input: SyncedRestoreGroupInput) { return restoreSyncedGroupOperation(this.db, input) }
  async restoreSyncedHostOperation(): ReturnType<SyncedBlocksApi['restoreSyncedHostOperation']> { throw new Error('No host history in this slice') }
  async getSyncedHostHistory(): ReturnType<SyncedBlocksApi['getSyncedHostHistory']> { throw new Error('No host history in this slice') }
  onSyncedBlocksChanged(listener: (event: SyncedBlocksChangedEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}

/** Current schema with real opaque child IDs, two same-URL keys and two real
 * instances. No native window, Store, IPC or renderer production entry is used. */
async function withMain(run: (api: MainApi, file: string, connections: Database.Database[]) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-source-owner-')), file = join(directory, 'main.db')
  const db = new Database(file), connections = [db], api = new MainApi(db)
  try {
    initialize(db)
    db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Target', 'Original/Target', other)
    const before = snapshot(db), blocks = [{ ...before.blocks[0], content: '[A](Target.md) and [B](Target.md)' }]
    const bindings = captureSyncedGroupBindings(db, before.origin, blocks)
    db.prepare('UPDATE synced_group_blocks SET content=? WHERE group_id=?').run(blocks[0].content, groupId)
    db.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run(JSON.stringify(bindings), groupId)
    addInstance(db, randomUUID(), groupId, { owner: other })
    db.pragma('user_version=26')
    db.transaction(() => { installSyncedLifecycleSchema(db, now); db.pragma('user_version=27') })()
    await run(api, file, connections)
  } finally {
    for (const connection of connections) if (connection.open) connection.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('knowbook-source-owner-'), 'Only this fixture temporary directory is removed')
    rmSync(directory, { recursive: true, force: true })
  }
}
function makeScope(value: SyncedGroupSnapshot) {
  let current = true, callout = () => {}
  const scope: SyncedGroupScope = { owner: { kind: 'synced-group', groupId: value.groupId }, ...value.instances[0],
    windowSessionId: randomUUID(), hostSession: {}, mountEpoch: {}, bindingEpoch: {}, domNamespace: 'source-owner-fixture',
    root: () => null, isCurrent: () => { callout(); return current } }
  return { scope, expire: () => { current = false }, callout: (next: () => void) => { callout = next } }
}
function sourceSession(binding: SyncedGroupBinding) {
  const opened = openSyncedSourceCheckpoint(binding)
  assert.ok(opened, 'Source opens from the actual registered working endpoint')
  const session = createCanonicalSourceLedgerSession({ draft: opened.draft })
  let state = EditorState.create({ doc: markdownSourceEditorText(opened.draft.source), extensions: session.extension })
  const edit = (from: number, to: number, insert: string) => {
    state = state.update({ changes: { from, to, insert } }).state
    return session.read(state)
  }
  const apply = (draft: SourceLedgerDraft, transactionId: string = randomUUID()) => {
    const prepared = prepareSourceCheckpoint({ checkpoint: opened.checkpoint, draft })
    assert.equal(prepared.status, 'prepared')
    if (prepared.status !== 'prepared') throw new Error('A real CM descendant must prepare for this fixture')
    const result = applyPreparedSourceCheckpoint({ preparation: prepared.preparation, transactionId })
    assert.equal(result.status, 'accepted')
    if (result.status !== 'accepted') throw new Error('A real controller must accept this prepared CM descendant')
    return result.accepted
  }
  const replay = (draft: SourceLedgerDraft) => {
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: markdownSourceEditorText(draft.source) },
      annotations: session.replay.of(draft) }).state
    return session.read(state)
  }
  return { ...opened, edit, apply, replay, current: () => session.read(state) }
}

type ReadPort = NonNullable<SyncedControllerOptions['readSources']>
function mainSources(api: MainApi) {
  const captures: Baseline[] = [], operations: Array<{ readOwnerId: string; clientOperationId: string }> = [], validations: string[] = [], releases: string[] = []
  const connections = new Map<string, Database.Database>()
  const hooks = {
    capture: async (value: ReturnType<typeof captureSyncedBaselineOwner>) => value,
    operation: async (value: ReturnType<typeof getSyncedOperationWithOwnedLinkSource>) => value,
    validate: async (value: ReturnType<typeof validateSyncedReadOwner>) => value,
    release: async () => {}
  }
  const port: ReadPort = {
    captureBaseline: async input => {
      const result = captureSyncedBaselineOwner(api.db, input)
      if (result.status === 'ready') { captures.push(structuredClone(result)); connections.set(result.readOwnerId, api.db) }
      return hooks.capture(result)
    },
    operation: async input => { operations.push({ ...input }); return hooks.operation(getSyncedOperationWithOwnedLinkSource(api.db, input)) },
    validate: async input => { validations.push(input.readOwnerId); return hooks.validate(validateSyncedReadOwner(api.db, input)) },
    release: async input => {
      releases.push(input.readOwnerId); await hooks.release()
      releaseSyncedReadOwner(connections.get(input.readOwnerId) ?? api.db, input)
    }
  }
  return { port, hooks, captures, operations, validations, releases }
}
async function setup(api: MainApi, owned = true, reads = mainSources(api)) {
  const workspace = getSyncedWorkspaceController(api, owned ? { readSources: reads.port } : {})
  await workspace.load([groupId])
  const controller = workspace.getGroup(groupId)
  assert.ok(controller, 'The actual workspace registers its requested SQLite group')
  const lease = makeScope(controller.getSnapshot().snapshot), binding = controller.bind(lease.scope), source = sourceSession(binding)
  return { reads, workspace, controller, lease, binding, source }
}
async function sourceOwner(source: ReturnType<typeof sourceSession>): Promise<SourceReadOwner> {
  const owner = await openSyncedSourceReadOwner(source.checkpoint)
  assert.ok(owner, 'An original owned initial load supplies the private checkpoint owner')
  return owner
}
function adopted(result: Awaited<ReturnType<typeof adoptSyncedSourceBaseline>>) {
  assert.equal(result.status, 'adopted')
  if (result.status !== 'adopted') throw new Error('The actual retained Main source must be adoptable')
  const facts = readAdoptedSourceSide(result.side)
  assert.ok(facts, 'Only a privately minted adopted side has readable facts')
  return { side: result.side, facts }
}
function changes(db: Database.Database): number { return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n }

test('owned initial load adopts the exact SQLite baseline and closed key set without writes or operation probes', async () => withMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source), before = changes(api.db)
  const result = adopted(await adoptSyncedSourceBaseline(owner)), original = value.reads.captures[0]
  assert.equal(value.reads.captures.length, 1)
  assert.deepEqual(result.facts.snapshot, original.snapshot)
  assert.deepEqual(result.facts.bindingSource, original.bindingSource)
  assert.equal(result.facts.kind, 'baseline'); assert.equal(result.facts.committed, null)
  assert.deepEqual(result.facts.bindingSource.entries.map(entry => entry.key), original.snapshot.bindings.map(key))
  assert.equal(result.facts.bindingSource.entries.length, 2, 'Two same-URL occurrences keep distinct complete keys')
  assert.equal(Object.isFrozen(result.facts.snapshot), true); assert.equal(Object.isFrozen(result.facts.bindingSource.entries), true)
  assert.deepEqual(value.reads.operations, []); assert.deepEqual(api.writes, []); assert.deepEqual(api.lookups, [])
  assert.equal(changes(api.db), before)
  assert.equal(readAdoptedSourceSide({ ...result.side }), null, 'Public handle shape is not private side identity')
  await closeSyncedSourceReadOwner(owner)
}))

test('same-URL keys with different historical targets preserve the Main entry mapping after transport reorders entries', async () => withMain(async api => {
  const original = snapshot(api.db), bindings = structuredClone(original.bindings)
  bindings[1].target = { kind: 'document', id: host, state: 'live' }
  // These are real stored historical targets; Main must preserve them rather
  // than resolve the identical current URL again. Both target documents exist.
  api.db.prepare('UPDATE synced_groups SET bindings_json=?,revision=? WHERE id=?').run(JSON.stringify(bindings), randomUUID(), groupId)
  const reads = mainSources(api)
  reads.hooks.capture = async result => {
    if (result.status !== 'ready') throw new Error('The real same-URL fixture must have an owned baseline')
    const reordered = structuredClone(result); reordered.bindingSource.entries.reverse(); return reordered
  }
  const value = await setup(api, true, reads), owner = await sourceOwner(value.source), side = adopted(await adoptSyncedSourceBaseline(owner))
  assert.deepEqual(side.facts.bindingSource.entries.map(entry => keyId(entry.key)), bindings.map(keyId).reverse())
  assert.notDeepEqual(bindings[0].target, bindings[1].target)
  for (const binding of bindings) {
    const entry = side.facts.bindingSource.entries.find(entry => keyId(entry.key) === keyId(binding))
    assert.ok(entry, 'Every complete key retains its own original Main entry ID after reordering')
    const actual = resolveSyncedBindingSource(api.db, side.facts.bindingSource.ticketId, entry.entryId)
    assert.deepEqual(actual.key, key(binding)); assert.deepEqual(actual.target, binding.target)
  }
  await closeSyncedSourceReadOwner(owner)
}))

test('an ordinary old load cannot acquire original provenance from later identical capture or retrofit options', async () => withMain(async api => {
  const value = await setup(api, false), later = captureSyncedBaselineOwner(api.db, { groupId })
  assert.equal(later.status, 'ready')
  if (later.status !== 'ready') throw new Error('The later real capture exists for the negative handshake')
  assert.deepEqual(later.snapshot, value.binding.getCurrent().snapshot)
  assert.equal(getSyncedWorkspaceController(api, { readSources: value.reads.port }), value.workspace)
  await value.workspace.load([groupId])
  assert.equal(await openSyncedSourceReadOwner(value.source.checkpoint), null)
  assert.deepEqual(value.reads.captures, [], 'A pre-existing ordinary workspace never retrofits a new owner')
  releaseSyncedReadOwner(api.db, { readOwnerId: later.readOwnerId })
}))

test('dirty W and accepted unacknowledged CM sides wait for their original ACK without lookup or flush', async () => withMain(async api => {
  const value = await setup(api), draft = value.source.edit(0, 0, 'dirty '), accepted = value.source.apply(draft, 'local-not-an-operation-id')
  const dirtySource = sourceSession(value.binding), owner = await sourceOwner(dirtySource)
  assert.equal((await adoptSyncedSourceBaseline(owner)).status, 'waiting-original-ack')
  const originalOwner = await sourceOwner(value.source)
  assert.equal((await adoptSyncedAcceptedSource(originalOwner, accepted)).status, 'waiting-original-ack')
  assert.deepEqual(value.reads.operations, []); assert.deepEqual(api.writes, []); assert.deepEqual(api.lookups, [])
  await closeSyncedSourceReadOwner(owner); await closeSyncedSourceReadOwner(originalOwner)
}))

test('accepted sources use the original validated mailbox operation and full ACK with only replayed normalized', async () => withMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source), accepted = value.source.apply(value.source.edit(0, 0, 'prefix '), 'local-transaction')
  assert.equal(await value.binding.flush(), true)
  const result = adopted(await adoptSyncedAcceptedSource(owner, accepted)), mailbox = readAcceptedSourceCheckpoint(accepted)
  assert.ok(mailbox?.committed, 'The real flush supplies this acceptance original mailbox')
  const ack = readSyncedCommittedEndpoint(mailbox.committed)
  assert.ok(ack, 'A registered immutable committed receipt has its actual original ACK')
  assert.deepEqual(value.reads.operations, [{ readOwnerId: value.reads.captures[0].readOwnerId, clientOperationId: api.writes[0].clientOperationId }])
  assert.notEqual(api.writes[0].clientOperationId, 'local-transaction')
  assert.deepEqual(result.facts.snapshot, ack.ack.snapshot)
  assert.equal(result.facts.kind, 'accepted'); assert.equal(result.facts.endpoint, mailbox.endpoint); assert.equal(result.facts.committed, mailbox.committed)
  assert.equal(ack.ack.replayed, false, 'The mailbox preserves the originally delivered ACK flag')
  assert.deepEqual(result.facts.bindingSource.entries.map(entry => entry.key), ack.ack.snapshot.bindings.map(key))
  assert.deepEqual(api.lookups, [], 'No ordinary operation probe is needed after direct ACK delivery')
  await closeSyncedSourceReadOwner(owner)
}))

test('F1 delayed ACK cannot be assigned to F2 or an identical but uncommitted whole-source replacement', async () => withMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source), delivered = deferred<SyncedGroupSaved>(), sent = deferred<SyncedGroupSaved>()
  api.deliver = async ack => { sent.resolve(ack); return delivered.promise }
  const first = value.source.edit(0, 0, 'first '), f1 = value.source.apply(first, 'F1')
  const flushing = value.binding.flush(); const ack = await sent.promise
  try {
    const second = value.source.edit(first.source.length, first.source.length, '!'), f2 = value.source.apply(second, 'F2')
    assert.equal((await adoptSyncedAcceptedSource(owner, f1)).status, 'waiting-original-ack')
    assert.equal((await adoptSyncedAcceptedSource(owner, f2)).status, 'waiting-original-ack')
    delivered.resolve(ack)
    // Stop before F2 is dispatched: this is the same controller writer queue,
    // and the read adoption itself must never submit the pending frame.
    api.deliver = async next => next
    await flushing
    const firstResult = await adoptSyncedAcceptedSource(owner, f1)
    assert.equal(firstResult.status, 'adopted')
    const f1Facts = readAcceptedSourceCheckpoint(f1)
    assert.ok(f1Facts?.committed, 'F1 keeps its original frame-version ACK even while another frame exists')
    const current = value.source.current(), sameText = value.source.edit(0, current.source.length, current.source)
    const f3 = value.source.apply(sameText, 'same-text-uncommitted')
    assert.equal((await adoptSyncedAcceptedSource(owner, f3)).status, 'waiting-original-ack')
    assert.equal(value.reads.operations.every(input => input.clientOperationId !== 'F1' && input.clientOperationId !== 'F2'), true)
  } finally { delivered.resolve(ack); await flushing; await closeSyncedSourceReadOwner(owner) }
}))

test('a genuine pending-prefix return shares the submitted ACK but retains its own accepted sequence', async () => withMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source), sent = deferred<SyncedGroupSaved>(), gate = deferred<SyncedGroupSaved>()
  api.deliver = async ack => { sent.resolve(ack); return gate.promise }
  const firstDraft = value.source.edit(0, 0, 'prefix '), first = value.source.apply(firstDraft, 'prefix')
  const flushing = value.binding.flush(), ack = await sent.promise
  try {
    const temporaryDraft = value.source.edit(firstDraft.source.length, firstDraft.source.length, '!')
    const temporary = value.source.apply(temporaryDraft, 'suffix')
    const returnedDraft = value.source.edit(temporaryDraft.source.length - 1, temporaryDraft.source.length, '')
    const returned = value.source.apply(returnedDraft, 'suffix')
    gate.resolve(ack); assert.equal(await flushing, true)
    const a = adopted(await adoptSyncedAcceptedSource(owner, first)), b = adopted(await adoptSyncedAcceptedSource(owner, returned))
    const firstMailbox = readSyncedCommittedEndpoint(a.facts.committed!), returnedMailbox = readSyncedCommittedEndpoint(b.facts.committed!)
    assert.ok(firstMailbox && returnedMailbox, 'Both actual prefix views have their own registered mailbox handles')
    assert.equal(firstMailbox.submittedEditSequence, 1); assert.equal(firstMailbox.acceptedEditSequence, 1)
    assert.equal(returnedMailbox.submittedEditSequence, 1); assert.equal(returnedMailbox.acceptedEditSequence, 3)
    assert.deepEqual(a.facts.snapshot, b.facts.snapshot)
    assert.equal((await adoptSyncedAcceptedSource(owner, temporary)).status, 'waiting-original-ack')
    assert.equal(api.writes.length, 1)
    assert.equal(value.reads.operations.every(input => input.clientOperationId === ack.operationId), true)
  } finally { gate.resolve(ack); await flushing; await closeSyncedSourceReadOwner(owner) }
}))

test('a history ACK with identical old text has a new full baseline and cannot borrow the initial baseline ticket', async () => withMain(async api => {
  const value = await setup(api), initial = value.reads.captures[0].snapshot
  value.source.apply(value.source.edit(0, 0, 'temporary '))
  assert.equal(await value.binding.flush(), true)
  assert.equal(await value.binding.undo(), true)
  assert.deepEqual(value.binding.getCurrent().snapshot.blocks, initial.blocks)
  assert.notEqual(value.binding.getCurrent().snapshot.revision, initial.revision)
  assert.notEqual(value.binding.getCurrent().snapshot.history.cursor, initial.history.cursor)
  const reopened = sourceSession(value.binding), owner = await openSyncedSourceReadOwner(reopened.checkpoint)
  if (owner) { assert.equal((await adoptSyncedSourceBaseline(owner)).status, 'unavailable'); await closeSyncedSourceReadOwner(owner) }
  assert.equal(value.reads.captures.length, 1, 'History does not issue a replacement initial-load owner')
  assert.deepEqual(value.reads.operations, [], 'No arbitrary history operation is guessed from baseline equality')
}))

test('a subsequent real reload changes B without retrofitting its initial owner even when canonical content is identical', async () => withMain(async api => {
  const value = await setup(api), initial = value.reads.captures[0].snapshot
  api.db.prepare('UPDATE synced_groups SET topology_revision=? WHERE id=?').run(randomUUID(), groupId)
  await value.workspace.load([groupId])
  assert.deepEqual(value.binding.getCurrent().snapshot.blocks, initial.blocks)
  const reopened = sourceSession(value.binding), owner = await openSyncedSourceReadOwner(reopened.checkpoint)
  if (owner) { assert.equal((await adoptSyncedSourceBaseline(owner)).status, 'unavailable'); await closeSyncedSourceReadOwner(owner) }
  assert.equal(value.reads.captures.length, 1); assert.deepEqual(value.reads.operations, [])
}))

test('full original ACK matching rejects independent snapshot metadata history instance binding and envelope changes', async () => {
  const mutations: Array<[string, (ack: SyncedGroupSaved) => void]> = [
    ['status', ack => { ack.status = 'noop' }], ['operationId', ack => { ack.operationId = randomUUID() }],
    ['creation', ack => { ack.snapshot.creationId = randomUUID() }], ['birth time', ack => { ack.snapshot.createdAt = now }],
    ['revision', ack => { ack.snapshot.revision = randomUUID() }], ['topology', ack => { ack.snapshot.topologyRevision = randomUUID() }],
    ['origin', ack => { ack.snapshot.origin.pathAtCreation = 'Other/Original' }],
    ['body', ack => { ack.snapshot.blocks[0].content += ' same keys' }],
    ['block checked', ack => { ack.snapshot.blocks[0].checked = true }],
    ['block tags', ack => { ack.snapshot.blocks[0].tags = ['different metadata'] }],
    ['block birth', ack => { ack.snapshot.blocks[0].createdAt = now }],
    ['target', ack => { ack.snapshot.bindings[0].target = { kind: 'document', id: 'another-target', state: 'live' } }],
    ['instance binding', ack => { ack.snapshot.instances[0].bindingVersion = randomUUID() }],
    ['instance order', ack => { ack.snapshot.instances.reverse() }],
    ['history', ack => { ack.snapshot.history.cursor = randomUUID() }],
    ['depth', ack => { ack.snapshot.maxRelativeDepth = 1 }]
  ]
  for (const [label, mutate] of mutations) await withMain(async api => {
    const value = await setup(api), owner = await sourceOwner(value.source), accepted = value.source.apply(value.source.edit(0, 0, 'committed '))
    assert.equal(await value.binding.flush(), true)
    value.reads.hooks.operation = async result => {
      assert.equal(result.status, 'committed')
      if (result.status !== 'committed') throw new Error('The negative delivery starts from a real durable Main ACK')
      const changed = structuredClone(result); mutate(changed.result); return changed
    }
    assert.equal((await adoptSyncedAcceptedSource(owner, accepted)).status, 'unavailable', label)
    assert.equal(value.reads.operations.length, 1, label)
    await closeSyncedSourceReadOwner(owner)
  })
})

test('malformed initial-source UUIDs duplicate or missing keys and open key envelopes never create adoptable provenance', async () => {
  const mutations: Array<[string, (value: Baseline) => void]> = [
    ['owner UUID', value => { value.readOwnerId = 'invalid' }], ['workspace UUID', value => { value.workspaceScope = 'invalid' }],
    ['ticket UUID', value => { value.bindingSource.ticketId = 'invalid' }],
    ['entry UUID', value => { value.bindingSource.entries[0].entryId = 'invalid' }],
    ['duplicate entry', value => { value.bindingSource.entries[1].entryId = value.bindingSource.entries[0].entryId }],
    ['duplicate key', value => { value.bindingSource.entries[1].key = structuredClone(value.bindingSource.entries[0].key) }],
    ['missing key', value => { value.bindingSource.entries.pop() }],
    ['extra key field', value => { Object.assign(value.bindingSource.entries[0].key, { target: 'caller target' }) }]
  ]
  for (const [label, mutate] of mutations) await withMain(async api => {
    const reads = mainSources(api)
    reads.hooks.capture = async result => {
      assert.equal(result.status, 'ready')
      if (result.status !== 'ready') throw new Error('Malformed delivery starts from a real ready baseline')
      const changed = structuredClone(result); mutate(changed); return changed
    }
    const workspace = getSyncedWorkspaceController(api, { readSources: reads.port })
    let rejected = false
    try { await workspace.load([groupId]) } catch { rejected = true }
    if (!rejected) {
      const controller = workspace.getGroup(groupId)
      assert.ok(controller, 'A successful load must actually register its group')
      const binding = controller.bind(makeScope(controller.getSnapshot().snapshot).scope), source = sourceSession(binding)
      const owner = await openSyncedSourceReadOwner(source.checkpoint)
      if (owner) { assert.notEqual((await adoptSyncedSourceBaseline(owner)).status, 'adopted', label); await closeSyncedSourceReadOwner(owner) }
    }
    assert.deepEqual(api.writes, [], label); assert.deepEqual(reads.operations, [], label)
  })
})

test('same scope and full B after real recovery or a different SQLite connection cannot revive the original Source owner', async () => {
  for (const replacement of ['epoch', 'connection'] as const) await withMain(async (api, file, connections) => {
    const value = await setup(api), owner = await sourceOwner(value.source), before = snapshot(api.db)
    if (replacement === 'epoch') api.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
    else { const next = new Database(file); next.pragma('foreign_keys=ON'); connections.push(next); api.db = next }
    assert.deepEqual(snapshot(api.db), before, 'Recovery/connection replacement is invisible to full B and public workspace scope')
    assert.equal((await adoptSyncedSourceBaseline(owner)).status, 'owner-unavailable', replacement)
    const later = captureSyncedBaselineOwner(api.db, { groupId })
    assert.equal(later.status, 'ready')
    if (later.status !== 'ready') throw new Error('The new generation may independently capture its own baseline')
    assert.deepEqual(later.snapshot, before)
    assert.notEqual((await adoptSyncedSourceBaseline(owner)).status, 'adopted', 'A later same-B capture cannot repair the old context')
    assert.equal(value.reads.captures.length, 1); assert.deepEqual(value.reads.operations, []); assert.deepEqual(api.lookups, [])
    releaseSyncedReadOwner(api.db, { readOwnerId: later.readOwnerId }); await closeSyncedSourceReadOwner(owner)
  })
})

test('scope or grammar invalidation during a real validation await prevents late baseline adoption', async () => {
  for (const kind of ['scope', 'grammar'] as const) await withMain(async api => {
    const value = await setup(api), owner = await sourceOwner(value.source), entered = deferred<void>(), gate = deferred<void>()
    const option = markdownEngine.options.linkify
    value.reads.hooks.validate = async result => { entered.resolve(); await gate.promise; return result }
    const pending = adoptSyncedSourceBaseline(owner); await entered.promise
    try {
      if (kind === 'scope') value.lease.expire()
      else markdownEngine.options.linkify = !option
      gate.resolve(); assert.equal((await pending).status, 'unavailable', kind)
      assert.deepEqual(api.writes, []); assert.deepEqual(value.reads.operations, [])
    } finally { gate.resolve(); await pending; markdownEngine.options.linkify = option; await closeSyncedSourceReadOwner(owner) }
  })
})

test('a final caller scope callback cannot change its lease after the Source grammar check and still adopt', async () => withMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source)
  value.lease.callout(() => { value.lease.scope.mountEpoch = {} })
  assert.equal((await adoptSyncedSourceBaseline(owner)).status, 'unavailable')
  assert.deepEqual(api.writes, []); assert.deepEqual(value.reads.operations, [])
  await closeSyncedSourceReadOwner(owner)
}))

test('an actual unknown durable operation is distinct from an unavailable original Main owner', async () => {
  for (const kind of ['unknown', 'released'] as const) await withMain(async api => {
    const value = await setup(api), owner = await sourceOwner(value.source), accepted = value.source.apply(value.source.edit(0, 0, 'committed '))
    assert.equal(await value.binding.flush(), true)
    if (kind === 'unknown') api.db.prepare('DELETE FROM synced_operations WHERE client_operation_id=?').run(api.writes[0].clientOperationId)
    else releaseSyncedReadOwner(api.db, { readOwnerId: value.reads.captures[0].readOwnerId })
    assert.equal((await adoptSyncedAcceptedSource(owner, accepted)).status, kind === 'unknown' ? 'unknown-operation' : 'owner-unavailable')
    assert.deepEqual(api.lookups, [])
    await closeSyncedSourceReadOwner(owner)
  })
})

test('private owner identity and same-checkpoint acceptance are required before any Main operation query', async () => withMain(async api => {
  const value = await setup(api), otherSource = sourceSession(value.binding), owner = await sourceOwner(value.source), otherOwner = await sourceOwner(otherSource)
  const accepted = value.source.apply(value.source.edit(0, 0, 'committed '))
  assert.equal(await value.binding.flush(), true)
  assert.equal((await adoptSyncedAcceptedSource(otherOwner, accepted)).status, 'unavailable')
  assert.equal((await adoptSyncedSourceBaseline({ ...owner })).status, 'unavailable')
  const forgedOwner = { ...owner, readOwnerId: value.reads.captures[0].readOwnerId }
  assert.equal((await adoptSyncedAcceptedSource(forgedOwner, accepted)).status, 'unavailable')
  assert.deepEqual(value.reads.operations, [], 'Neither public handle shape nor a real visible Main UUID can forge private association')
  adopted(await adoptSyncedAcceptedSource(owner, accepted))
  await closeSyncedSourceReadOwner(owner); await closeSyncedSourceReadOwner(otherOwner)
}))

test('the last checkpoint consumer alone releases the original owner after the group has been cleanly released', async () => withMain(async api => {
  const value = await setup(api), otherSource = sourceSession(value.binding), left = await sourceOwner(value.source), right = await sourceOwner(otherSource)
  const original = value.reads.captures[0], independent = captureSyncedBaselineOwner(api.db, { groupId })
  assert.equal(independent.status, 'ready')
  if (independent.status !== 'ready') throw new Error('Independent Main owner must exist before testing release isolation')
  value.binding.dispose(); assert.equal(value.workspace.releaseClean(groupId), true)
  assert.deepEqual(value.reads.releases, [])
  await closeSyncedSourceReadOwner(left); await closeSyncedSourceReadOwner(left)
  assert.deepEqual(value.reads.releases, [])
  await closeSyncedSourceReadOwner(right); await closeSyncedSourceReadOwner(right)
  assert.deepEqual(value.reads.releases, [original.readOwnerId])
  assert.deepEqual(validateSyncedReadOwner(api.db, { readOwnerId: original.readOwnerId }), { status: 'owner-unavailable' })
  assert.equal(validateSyncedReadOwner(api.db, { readOwnerId: independent.readOwnerId }).status, 'ready')
  const entry = independent.bindingSource.entries[0]
  assert.deepEqual(resolveSyncedBindingSource(api.db, independent.bindingSource.ticketId, entry.entryId).key, entry.key)
  releaseSyncedReadOwner(api.db, { readOwnerId: independent.readOwnerId })
}))

test('closing the last owner during an operation await prevents adoption and defers release until the in-flight read settles', async () => withMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source), accepted = value.source.apply(value.source.edit(0, 0, 'committed '))
  assert.equal(await value.binding.flush(), true)
  const entered = deferred<void>(), gate = deferred<void>()
  value.reads.hooks.operation = async result => { entered.resolve(); await gate.promise; return result }
  const pending = adoptSyncedAcceptedSource(owner, accepted); await entered.promise
  value.binding.dispose(); assert.equal(value.workspace.releaseClean(groupId), true)
  const closing = closeSyncedSourceReadOwner(owner)
  try {
    assert.deepEqual(value.reads.releases, [], 'An in-flight consumer still retains its original Main owner')
    gate.resolve(); assert.equal((await pending).status, 'unavailable'); await closing
    assert.deepEqual(value.reads.releases, [value.reads.captures[0].readOwnerId])
  } finally { gate.resolve(); await pending; await closing }
}))

test('a real local CM acceptance during a validation await invalidates the original request fence', async () => withMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source), entered = deferred<void>(), gate = deferred<void>()
  value.reads.hooks.validate = async result => { entered.resolve(); await gate.promise; return result }
  const pending = adoptSyncedSourceBaseline(owner); await entered.promise
  try {
    value.source.apply(value.source.edit(0, 0, 'during await '))
    gate.resolve(); assert.equal((await pending).status, 'unavailable')
    assert.deepEqual(api.writes, []); assert.deepEqual(value.reads.operations, [])
  } finally { gate.resolve(); await pending; await closeSyncedSourceReadOwner(owner) }
}))

test('a collector grammar callback cannot accept another local side and leave its earlier operation adoption valid', async () => {
  const parse = markdownEngine.parse
  let reenter = () => {}, armed = false, edited = false
  markdownEngine.parse = (...args: Parameters<typeof parse>) => {
    const tokens = parse.apply(markdownEngine, args)
    if (armed) { armed = false; reenter(); edited = true }
    return tokens
  }
  try { await withMain(async api => {
    const value = await setup(api), owner = await sourceOwner(value.source), accepted = value.source.apply(value.source.edit(0, 0, 'committed '))
    assert.equal(await value.binding.flush(), true)
    reenter = () => {
      const current = value.source.current()
      value.source.apply(value.source.edit(current.source.length, current.source.length, '!'), 'collector-reentry')
    }
    value.reads.hooks.operation = async result => { armed = true; return result }
    assert.equal((await adoptSyncedAcceptedSource(owner, accepted)).status, 'unavailable')
    assert.equal(edited, true, 'The actual post-response collector invoked the installed grammar callback and accepted the nested edit')
    assert.equal(api.writes.length, 1, 'The nested edit remains local')
    await closeSyncedSourceReadOwner(owner)
  }) } finally { armed = false; markdownEngine.parse = parse }
})

test('the loaded public adoption wrapper captures its fence before an immediate synchronous local edit', async () => withMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source), before = value.reads.validations.length
  const pending = adoptSyncedSourceBaseline(owner)
  assert.equal(value.reads.validations.length, before + 1, 'A loaded public wrapper reaches the real validation await synchronously')
  value.source.apply(value.source.edit(0, 0, 'immediate edit '))
  assert.equal((await pending).status, 'unavailable')
  await closeSyncedSourceReadOwner(owner)
}))

test('the loaded public close wrapper revokes synchronously before an already-resolved operation continuation', async () => withMain(async api => {
  const reads = mainSources(api), reply = deferred<ReturnType<typeof getSyncedOperationWithOwnedLinkSource>>()
  let actual: ReturnType<typeof getSyncedOperationWithOwnedLinkSource> | undefined
  reads.port.operation = input => {
    reads.operations.push({ ...input }); actual = getSyncedOperationWithOwnedLinkSource(api.db, input); return reply.promise
  }
  const value = await setup(api, true, reads), owner = await sourceOwner(value.source), accepted = value.source.apply(value.source.edit(0, 0, 'committed '))
  assert.equal(await value.binding.flush(), true)
  const pending = adoptSyncedAcceptedSource(owner, accepted)
  assert.ok(actual, 'The already-loaded public wrapper has synchronously entered this actual Main operation read')
  reply.resolve(actual)
  const closing = closeSyncedSourceReadOwner(owner)
  assert.equal((await pending).status, 'unavailable'); await closing
}))

test('the raw read-owner kernel cannot mint an owner from even a genuine exported access adapter', async () => withMain(async api => {
  const value = await setup(api), kernel = await import('../src/renderer/src/features/synced-blocks/sourceReadOwner')
  const access = readSourceReadOwnerAccess(value.source.checkpoint)
  assert.ok(access, 'The negative adapter starts with a real registered checkpoint context')
  assert.equal(kernel.openSourceReadOwner(access as unknown as Parameters<typeof kernel.openSourceReadOwner>[0]), null)
  assert.equal(await openSyncedSourceReadOwner({ ...value.source.checkpoint }), null)
  value.lease.expire()
  assert.equal(await openSyncedSourceReadOwner(value.source.checkpoint), null)
  assert.deepEqual(value.reads.operations, []); assert.deepEqual(api.writes, [])
}))

test('a successful private source read alone cannot restore a removed Lineage token or authorize historical Apply', async () => withMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source)
  adopted(await adoptSyncedSourceBaseline(owner))
  const removed = value.source.edit(0, value.source.draft.source.length, 'plain'), accepted = value.source.apply(removed)
  assert.equal(await value.binding.flush(), true)
  adopted(await adoptSyncedAcceptedSource(owner, accepted))
  const restored = value.source.replay(value.source.draft)
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: restored }).status, 'needs-history-source')
  assert.equal(api.writes.length, 1, 'Adoption did not add a flush or write for the restored raw side')
  await closeSyncedSourceReadOwner(owner)
}))

test('a final same-value grammar option getter cannot change an already sampled parse identity and still adopt', async () => withMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source), entered = deferred<void>(), gate = deferred<void>()
  const parse = markdownEngine.parse, option = Object.keys(markdownEngine.options).at(-1)
  assert.ok(option, 'The actual Markdown grammar has an existing final option to observe')
  const descriptor = Object.getOwnPropertyDescriptor(markdownEngine.options, option)
  assert.ok(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.configurable, 'The option is real configurable own data before the callout fixture')
  let mutations = 0
  value.reads.hooks.validate = async result => { entered.resolve(); await gate.promise; return result }
  const pending = adoptSyncedSourceBaseline(owner); await entered.promise
  try {
    Object.defineProperty(markdownEngine.options, option, { configurable: true, enumerable: descriptor.enumerable,
      get() {
        if (!mutations) { mutations++; markdownEngine.parse = (...args: Parameters<typeof parse>) => parse.apply(markdownEngine, args) }
        return descriptor.value
      } })
    gate.resolve()
    assert.equal((await pending).status, 'unavailable', 'The option callback changed the earlier parse identity during final grammar sampling')
    assert.equal(mutations, 1, 'The actual final grammar callout executed once after the request entered its port await')
  } finally {
    gate.resolve(); await pending
    Object.defineProperty(markdownEngine.options, option, descriptor); markdownEngine.parse = parse
    await closeSyncedSourceReadOwner(owner)
  }
}))
