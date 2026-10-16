import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { markdownEngine } from '../src/shared/markdownEngine'
import type { SyncedBindingKey, SyncedGroupSaved, SyncedRestoreGroupInput } from '../src/shared/synced-blocks'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '../src/shared/markdownLinks'
import { getSyncedOperationWithOwnedLinkSource, releaseSyncedReadOwner, resolveSyncedBindingSource } from '../src/main/database/synced-binding-sources'
import { restoreSyncedGroupOperation, updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { captureSyncedWorkingEndpoint, readSyncedWorkingEndpoint, readSyncedWorkingEndpointCommitted,
  readSyncedWorkingEndpointBaselineAck, readSyncedBaselineAck, type SyncedBaselineAckReceipt } from '../src/renderer/src/features/synced-blocks/controller'
import { adoptSyncedSourceOpening, adoptSyncedSourceBaseline, openSyncedSourceReadOwner, closeSyncedSourceReadOwner,
  registerSyncedSourceHistorySide, readAdoptedSourceSide, prepareSourceCheckpoint, readPreparedSourceCheckpoint,
  applyPreparedSourceCheckpoint } from '../src/renderer/src/features/synced-blocks/sourceLedger'
import { withHistoryMain, setup, mainSources, sourceSession, sourceOwner, adopted, deferred, replaceTarget,
  snapshot, groupId, other, host, keyId, type HistoryMainApi } from './helpers/source-history-copy-main-fixture'
import { restore, update } from './helpers/synced-content-fixture'

type Fixture = Awaited<ReturnType<typeof setup>>
type ReadPort = ReturnType<typeof mainSources>['port']
type OperationResult = Awaited<ReturnType<ReadPort['operation']>>
function transport(api: HistoryMainApi) {
  const reads = mainSources(api), histories: SyncedRestoreGroupInput[] = [], acks: SyncedGroupSaved[] = []
  const delivery = {
    beforeHistory: async (_input: SyncedRestoreGroupInput): Promise<void> => {},
    history: async (ack: SyncedGroupSaved): Promise<SyncedGroupSaved> => ack,
    operation: async (result: OperationResult): Promise<OperationResult> => result
  }
  // Real Main commits/reads happen here; hooks affect transport timing or an
  // explicitly failed request, never synthesize a positive server result.
  api.restoreSyncedGroupOperation = async input => {
    histories.push(structuredClone(input)); await delivery.beforeHistory(input)
    const result = restoreSyncedGroupOperation(api.db, input)
    if (result.status !== 'saved' && result.status !== 'noop') return result
    acks.push(structuredClone(result)); return delivery.history(result)
  }
  reads.port.operation = input => {
    reads.operations.push(input.clientOperationId)
    return delivery.operation(getSyncedOperationWithOwnedLinkSource(api.db, input))
  }
  return { reads, histories, acks, delivery }
}
function keys(value: Fixture): SyncedBindingKey[] {
  const { snapshot: before, working } = value.binding.getCurrent()
  return collectDocumentMarkdownLinks(working).filter(link => link.kind !== 'image'
    && (link.kind === 'wiki' || resolveMarkdownDocumentPath(before.origin.pathAtCreation, link.url) !== null))
    .map(link => ({ blockId: working[link.blockIndex].id, from: link.start, to: link.end,
      raw: working[link.blockIndex].content.slice(link.start, link.end), syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' }))
}
function prefix(value: Fixture, text = 'content ', transactionId = 'local content transaction, not a Main UUID') {
  const before = value.binding.getCurrent(), first = before.working[0].id
  const blocks = before.working.map(block => ({ ...block, content: block.id === first ? text + block.content : block.content }))
  const bindingClaims = keys(value).map(source => ({ kind: 'continue' as const, source,
    destination: { ...source, from: source.from + (source.blockId === first ? text.length : 0), to: source.to + (source.blockId === first ? text.length : 0) } }))
  assert.equal(value.binding.apply({ expectedEditSequence: before.editSequence,
    guards: { groupId, expectedRevision: before.snapshot.revision, expectedTopologyRevision: before.snapshot.topologyRevision },
    blocks, bindingClaims, transactionId, bookmark: null }), true, 'The registered binding accepts this explicit content edit')
}
async function content(api: HistoryMainApi, wire = transport(api)) {
  const value = await setup(api, wire.reads)
  prefix(value); assert.equal(await value.binding.flush(), true)
  return { ...value, wire }
}
function baseline(value: Fixture) {
  const endpoint = captureSyncedWorkingEndpoint(value.binding)
  assert.ok(endpoint, 'The actual current working Endpoint is registered')
  const current = readSyncedWorkingEndpoint(endpoint)
  assert.ok(current.status === 'available' && current.kind === 'baseline', 'The actual history transition created a baseline Endpoint')
  const receipt = readSyncedWorkingEndpointBaselineAck(endpoint)
  assert.ok(receipt, 'Only the actual history ACK minted this baseline receipt')
  const facts = readSyncedBaselineAck(receipt)
  assert.ok(facts, 'The opaque receipt resolves to its original immutable history ACK')
  assert.equal(facts.kind, 'history')
  assert.deepEqual(facts.ack.snapshot, current.baseline)
  assert.equal(readSyncedWorkingEndpointCommitted(endpoint), null, 'A history baseline never fabricates a content mailbox')
  return { endpoint, receipt, ack: facts.ack }
}
async function history(api: HistoryMainApi, wire = transport(api)) {
  const value = await content(api, wire)
  assert.equal(await value.binding.undo(), true, 'There are no local frames; this is the actual server Undo path')
  const original = baseline(value), opening = sourceSession(value.binding), owner = await sourceOwner(opening)
  return { ...value, ...original, opening, owner }
}
/** A valid legacy/degenerate tail: both complete semantic sides and their
 * actual SHA agree with the current side. Main itself decides this is noop. */
function degenerateTail(api: HistoryMainApi) {
  const before = snapshot(api.db), token = before.history.undoToken
  assert.ok(token, 'The actual content commit created an Undo tail')
  const changed = api.db.prepare('UPDATE synced_group_history SET before_json=after_json,before_hash=after_hash WHERE id=? AND group_id=?').run(token, groupId)
  assert.equal(changed.changes, 1)
  assert.deepEqual(snapshot(api.db), before, 'Only the historical side fixture changed; current canonical rows and CAS did not')
}

test('a real server Undo ACK creates the exact B2 proof without borrowing initial B1 or a content receipt', async () => withHistoryMain(async api => {
  const value = await history(api)
  try {
    assert.equal(value.wire.histories.length, 1)
    assert.equal(value.wire.histories[0].direction, 'undo')
    assert.deepEqual(value.ack, value.wire.acks[0])
    assert.equal(value.ack.status, 'saved'); assert.equal(value.ack.replayed, false)
    assert.notDeepEqual(value.ack.snapshot, value.reads.captures[0].snapshot)
    assert.equal((await adoptSyncedSourceBaseline(value.owner)).status, 'unavailable')
    const proof = adopted(await adoptSyncedSourceOpening(value.owner))
    assert.equal(proof.facts.kind, 'opening'); assert.equal(proof.facts.committed, null)
    assert.deepEqual(proof.facts.snapshot, value.ack.snapshot)
    assert.deepEqual(syncedCanonicalEdits(proof.facts.snapshot.blocks), value.binding.getCurrent().working)
    assert.deepEqual(value.reads.operations, [value.wire.histories[0].clientOperationId])
    assert.deepEqual(api.lookups, []); assert.equal(api.writes.length, 1)
    assert.equal(value.reads.captures.length, 1, 'History does not capture a replacement Main owner')
  } finally { await closeSyncedSourceReadOwner(value.owner) }
}))

test('server Redo binds a distinct B3 receipt while the expired B2 receipt remains only a diagnostic fact', async () => withHistoryMain(async api => {
  const value = await history(api), undoProof = adopted(await adoptSyncedSourceOpening(value.owner))
  let redoOwner: Awaited<ReturnType<typeof sourceOwner>> | null = null
  try {
    assert.equal(await value.binding.redo(), true)
    const redo = baseline(value), opening = sourceSession(value.binding); redoOwner = await sourceOwner(opening)
    assert.notEqual(redo.receipt, value.receipt)
    assert.equal(value.wire.histories[1].direction, 'redo')
    assert.equal(redo.ack.operationId, value.wire.histories[1].clientOperationId)
    assert.notEqual(redo.ack.operationId, value.ack.operationId)
    assert.deepEqual(readSyncedBaselineAck(value.receipt)?.ack, value.ack)
    assert.equal(readSyncedWorkingEndpoint(value.endpoint).status, 'unavailable')
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable')
    assert.equal((await registerSyncedSourceHistorySide({ checkpoint: value.opening.checkpoint, side: undoProof.side })).status, 'unavailable')
    const proof = adopted(await adoptSyncedSourceOpening(redoOwner))
    assert.deepEqual(proof.facts.snapshot, redo.ack.snapshot)
    assert.equal((await adoptSyncedSourceBaseline(redoOwner)).status, 'unavailable')
    assert.deepEqual(value.reads.operations, [value.ack.operationId, redo.ack.operationId])
  } finally { await closeSyncedSourceReadOwner(value.owner); if (redoOwner) await closeSyncedSourceReadOwner(redoOwner) }
}))

test('the baseline ACK is already observable during publication and is never attached to the later F2 Endpoint', async () => withHistoryMain(async api => {
  const value = await content(api)
  const observed = { receipt: null as SyncedBaselineAckReceipt | null, ack: null as ReturnType<typeof readSyncedBaselineAck> }
  let armed = true
  const stop = value.binding.subscribe(() => {
    if (!armed || value.binding.getCurrent().pending || value.binding.getCurrent().snapshot.revision === value.reads.captures[0].snapshot.revision) return
    const endpoint = captureSyncedWorkingEndpoint(value.binding), current = endpoint && readSyncedWorkingEndpoint(endpoint)
    if (!endpoint || !current || current.status !== 'available' || current.kind !== 'baseline') return
    armed = false
    observed.receipt = readSyncedWorkingEndpointBaselineAck(endpoint)
    observed.ack = observed.receipt && readSyncedBaselineAck(observed.receipt)
    // Assertions belong outside publish: subscriber exceptions are isolated.
  })
  try {
    assert.equal(await value.binding.undo(), true)
    assert.equal(armed, false, 'The subscriber saw the actual history baseline publish')
    assert.ok(observed.receipt && observed.ack, 'The original receipt and ACK existed before the subscriber ran')
    const original = baseline(value)
    assert.equal(observed.receipt, original.receipt)
    assert.deepEqual(observed.ack.ack, original.ack)
    prefix(value, 'F2 after history ', 'independent F2 after historyBusy clears')
    const later = captureSyncedWorkingEndpoint(value.binding)
    assert.ok(later, 'The later real content Endpoint exists')
    assert.equal(readSyncedWorkingEndpointBaselineAck(later), null)
    assert.equal(readSyncedWorkingEndpointBaselineAck(original.endpoint), observed.receipt)
    assert.deepEqual(readSyncedBaselineAck(observed.receipt)?.ack, original.ack)
  } finally { armed = false; stop() }
}))

test('ordinary initial load local Undo and local Redo do not mint history baseline receipts or guess operations', async () => withHistoryMain(async api => {
  const value = await setup(api), initial = captureSyncedWorkingEndpoint(value.binding)
  assert.ok(initial, 'Initial B1 has an actual working receipt')
  assert.equal(readSyncedWorkingEndpointBaselineAck(initial), null)
  const firstOwner = await sourceOwner(value.source)
  try {
    assert.equal((await adoptSyncedSourceOpening(firstOwner)).status, 'unavailable')
    prefix(value)
    assert.equal(await value.binding.undo(), true, 'This Undo is local because the frame was never flushed')
    const local = captureSyncedWorkingEndpoint(value.binding)
    assert.ok(local, 'Local Undo made a real new working Endpoint')
    assert.equal(readSyncedWorkingEndpointBaselineAck(local), null)
    assert.equal(await value.binding.redo(), true)
    const redone = captureSyncedWorkingEndpoint(value.binding)
    assert.ok(redone, 'Local Redo made a real working Endpoint')
    assert.equal(readSyncedWorkingEndpointBaselineAck(redone), null)
    assert.deepEqual(value.reads.operations, []); assert.deepEqual(api.lookups, [])
    assert.equal(api.writes.length, 0)
  } finally { await closeSyncedSourceReadOwner(firstOwner) }
}))

test('an external real Main Undo followed by ordinary load cannot retrofit a B2 history ACK or owner', async () => withHistoryMain(async api => {
  const value = await content(api), external = restoreSyncedGroupOperation(api.db, restore(api.db, 'undo'))
  assert.equal(external.status, 'saved')
  await value.workspace.load([groupId])
  assert.deepEqual(value.binding.getCurrent().snapshot, snapshot(api.db))
  const endpoint = captureSyncedWorkingEndpoint(value.binding)
  assert.ok(endpoint, 'Ordinary load produced the actual current baseline')
  assert.equal(readSyncedWorkingEndpointBaselineAck(endpoint), null)
  const opening = sourceSession(value.binding)
  assert.equal(await openSyncedSourceReadOwner(opening.checkpoint), null)
  assert.deepEqual(value.reads.operations, []); assert.deepEqual(api.lookups, [])
  assert.equal(value.reads.captures.length, 1, 'Ordinary reload cannot sign a new initial owned read')
}))

test('a same-B reload retains the historical receipt fact but revokes new adoption from the original context', async () => withHistoryMain(async api => {
  const value = await history(api)
  try {
    const before = snapshot(api.db)
    await value.workspace.load([groupId])
    assert.deepEqual(value.binding.getCurrent().snapshot, before)
    assert.equal(readSyncedWorkingEndpointBaselineAck(value.endpoint), value.receipt)
    assert.deepEqual(readSyncedBaselineAck(value.receipt)?.ack, value.ack)
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable')
    const fresh = sourceSession(value.binding)
    assert.equal(await openSyncedSourceReadOwner(fresh.checkpoint), null)
    assert.deepEqual(value.reads.operations, [])
    assert.equal(value.reads.captures.length, 1)
  } finally { await closeSyncedSourceReadOwner(value.owner) }
}))

test('real Main history noop preserves its status epoch and the conditional original B1 baseline semantics', async () => {
  for (const sameInitial of [false, true]) await withHistoryMain(async api => {
    if (sameInitial) {
      const before = snapshot(api.db), blocks = syncedCanonicalEdits(before.blocks).map(block => ({ ...block, content: 'seed ' + block.content }))
      const input = update(api.db, blocks)
      input.bindingClaims = before.bindings.map(source => ({ kind: 'continue' as const, source: { blockId: source.blockId, from: source.from, to: source.to, raw: source.raw, syntax: source.syntax },
        destination: { blockId: source.blockId, from: source.from + 5, to: source.to + 5, raw: source.raw, syntax: source.syntax } }))
      assert.equal(updateSyncedBlockGroup(api.db, input).status, 'saved')
      degenerateTail(api)
    }
    const wire = transport(api), value = sameInitial ? { ...await setup(api, wire.reads), wire } : await content(api, wire)
    if (!sameInitial) degenerateTail(api)
    const before = snapshot(api.db), oldEndpoint = captureSyncedWorkingEndpoint(value.binding)
    assert.ok(oldEndpoint, 'The actual pre-noop Endpoint can witness the unchanged epoch')
    assert.equal(await value.binding.undo(), true)
    const original = baseline(value), opening = sourceSession(value.binding), owner = await sourceOwner(opening)
    try {
      assert.equal(original.ack.status, 'noop', 'The real Main restore, not a mutated saved DTO, returned noop')
      assert.deepEqual(original.ack.snapshot, before)
      assert.deepEqual(snapshot(api.db), before)
      assert.equal(readSyncedWorkingEndpoint(oldEndpoint).status, 'available', 'Noop does not expire the old content/history epoch')
      assert.equal(readSyncedWorkingEndpointBaselineAck(oldEndpoint), null, 'The old Endpoint is not backfilled with the new noop ACK')
      const proof = adopted(await adoptSyncedSourceOpening(owner))
      assert.deepEqual(proof.facts.snapshot, before); assert.equal(proof.facts.committed, null)
      assert.equal((await adoptSyncedSourceBaseline(owner)).status, sameInitial ? 'adopted' : 'unavailable',
        'The old API proves original full B1 only; it does not claim the history noop ACK')
      assert.deepEqual(value.reads.operations, [wire.histories[0].clientOperationId])
      assert.equal(value.reads.captures.length, 1)
    } finally { await closeSyncedSourceReadOwner(owner) }
  })
})

test('a lost history ACK gets its B2 receipt only after the actual original pending lookup commits the transition', async () => withHistoryMain(async api => {
  const value = await content(api), oldEndpoint = captureSyncedWorkingEndpoint(value.binding)
  assert.ok(oldEndpoint, 'The original content Endpoint exists before server Undo')
  value.wire.delivery.history = async () => { throw new Error('The actual durable history ACK was lost in transport') }
  assert.equal(await value.binding.undo(), false)
  assert.equal(value.wire.histories.length, 1)
  const input = value.wire.histories[0]
  assert.notDeepEqual(snapshot(api.db), value.binding.getCurrent().snapshot, 'Main committed before its ACK transport failed')
  assert.equal(readSyncedWorkingEndpointBaselineAck(oldEndpoint), null)
  assert.deepEqual(value.reads.operations, []); assert.deepEqual(api.lookups, [])
  assert.equal(await value.binding.flush(), true)
  assert.deepEqual(api.lookups, [input.clientOperationId])
  assert.equal(value.wire.histories.length, 1, 'A found original history operation is not resubmitted')
  const original = baseline(value), opening = sourceSession(value.binding), owner = await sourceOwner(opening)
  try {
    assert.equal(original.ack.operationId, input.clientOperationId)
    assert.equal(original.ack.replayed, true, 'This actual controller ACK came from its uncertain-operation lookup')
    adopted(await adoptSyncedSourceOpening(owner))
    assert.deepEqual(value.reads.operations, [input.clientOperationId])
  } finally { await closeSyncedSourceReadOwner(owner) }
}))

test('an unknown uncertain history lookup never mints a receipt and retries only its original exact request', async () => withHistoryMain(async api => {
  const value = await content(api), before = snapshot(api.db)
  let first = true
  value.wire.delivery.beforeHistory = async () => { if (first) { first = false; throw new Error('The first history request failed before Main') } }
  assert.equal(await value.binding.undo(), false)
  const old = captureSyncedWorkingEndpoint(value.binding)
  assert.ok(old, 'The pre-ACK working view is still registered')
  assert.deepEqual(snapshot(api.db), before)
  assert.equal(readSyncedWorkingEndpointBaselineAck(old), null)
  assert.deepEqual(value.reads.operations, [])
  assert.equal(await value.binding.flush(), true)
  assert.deepEqual(api.lookups, [value.wire.histories[0].clientOperationId])
  assert.equal(value.wire.histories.length, 2)
  assert.deepEqual(value.wire.histories[1], value.wire.histories[0], 'Unknown never chooses a new op, cursor, token or request body')
  const original = baseline(value)
  assert.equal(original.ack.operationId, value.wire.histories[0].clientOperationId)
}))

test('invalid actual history ACK transport cannot mint a new baseline receipt before the original operation is recovered', async () => {
  const mutations: Array<[string, (ack: SyncedGroupSaved) => void]> = [
    ['operation', ack => { ack.operationId = randomUUID() }],
    ['creation', ack => { ack.snapshot.creationId = randomUUID() }],
    ['Undo tail', ack => { ack.snapshot.history.redoToken = null }],
    ['false noop', ack => { ack.status = 'noop' }]
  ]
  for (const [label, mutate] of mutations) await withHistoryMain(async api => {
    const value = await content(api)
    value.wire.delivery.history = async ack => { const next = structuredClone(ack); mutate(next); return next }
    assert.equal(await value.binding.undo(), false, label)
    const old = captureSyncedWorkingEndpoint(value.binding)
    assert.ok(old, 'The rejected transport did not replace the original working view')
    assert.equal(readSyncedWorkingEndpointBaselineAck(old), null, label)
    assert.deepEqual(value.reads.operations, [])
    assert.equal(await value.binding.flush(), true, 'Actual pending lookup can recover the unchanged durable ACK')
    const original = baseline(value)
    assert.deepEqual(original.ack.snapshot, snapshot(api.db)); assert.equal(original.ack.replayed, true)
  })
})

test('history adoption performs full ACK and closed Key source validation rather than matching B2 by body or cursor', async () => {
  const changes: Array<[string, (result: Extract<OperationResult, { status: 'committed' }>) => void]> = [
    ['status', result => { result.result.status = 'noop' }], ['operation', result => { result.result.operationId = randomUUID() }],
    ['workspace', result => { result.workspaceScope = randomUUID() }], ['birth', result => { result.result.snapshot.createdAt = '2001-01-01T00:00:00.000Z' }],
    ['metadata', result => { result.result.snapshot.blocks[0].tags = ['transport changed'] }],
    ['target', result => { result.result.snapshot.bindings[0].target = { kind: 'document', id: host, state: 'live' } }],
    ['cursor', result => { result.result.snapshot.history.cursor = randomUUID() }],
    ['instance', result => { result.result.snapshot.instances[0].bindingVersion = randomUUID() }],
    ['entry UUID', result => { result.bindingSource.entries[0].entryId = 'invalid' }],
    ['Key coverage', result => { result.bindingSource.entries[1].key = structuredClone(result.bindingSource.entries[0].key) }],
    ['Key closure', result => { Object.assign(result.bindingSource.entries[0].key, { target: 'caller choice' }) }]
  ]
  for (const [label, mutate] of changes) await withHistoryMain(async api => {
    const value = await history(api)
    value.wire.delivery.operation = async result => {
      if (result.status !== 'committed') throw new Error('The fixture requires the actual original committed Main operation')
      const next = structuredClone(result); mutate(next); return next
    }
    try {
      assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable', label)
      assert.deepEqual(value.reads.operations, [value.ack.operationId], label)
      assert.equal(value.reads.captures.length, 1)
    } finally { await closeSyncedSourceReadOwner(value.owner) }
  })
})

test('a real history receipt distinguishes unknown operation from an unavailable original owner', async () => {
  for (const reason of ['unknown', 'released'] as const) await withHistoryMain(async api => {
    const value = await history(api)
    try {
      if (reason === 'unknown') api.db.prepare('DELETE FROM synced_operations WHERE client_operation_id=?').run(value.ack.operationId)
      else releaseSyncedReadOwner(api.db, { readOwnerId: value.reads.captures[0].readOwnerId })
      assert.equal((await adoptSyncedSourceOpening(value.owner)).status, reason === 'unknown' ? 'unknown-operation' : 'owner-unavailable')
      assert.deepEqual(value.reads.operations, [value.ack.operationId]); assert.deepEqual(api.lookups, [])
    } finally { await closeSyncedSourceReadOwner(value.owner) }
  })
})

test('recovery and replacement connection reject the old B2 owner despite the identical full current snapshot', async () => {
  for (const reason of ['epoch', 'connection'] as const) await withHistoryMain(async api => {
    const value = await history(api), original = api.db, before = snapshot(api.db)
    let next: Database.Database | null = null
    try {
      if (reason === 'epoch') api.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
      else { next = new Database(original.name); next.pragma('foreign_keys=ON'); api.db = next }
      assert.deepEqual(snapshot(api.db), before)
      assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'owner-unavailable', reason)
      assert.deepEqual(readSyncedBaselineAck(value.receipt)?.ack, value.ack)
      assert.equal(value.reads.captures.length, 1)
    } finally { api.db = original; await closeSyncedSourceReadOwner(value.owner); next?.close() }
  })
})

test('only the new B2 opening tokens restore exact historical same-URL targets through real ticket copy', async () => withHistoryMain(async api => {
  const wire = transport(api)
  wire.delivery.operation = async result => {
    if (result.status !== 'committed') return result
    const next = structuredClone(result); next.bindingSource.entries.reverse(); return next
  }
  const initial = await setup(api, wire.reads), oldOwner = await sourceOwner(initial.source)
  const oldProof = adopted(await adoptSyncedSourceBaseline(oldOwner))
  assert.equal((await registerSyncedSourceHistorySide({ checkpoint: initial.source.checkpoint, side: oldProof.side })).status, 'registered')
  prefix(initial); assert.equal(await initial.binding.flush(), true)
  assert.equal(await initial.binding.undo(), true)
  const opening = sourceSession(initial.binding), owner = await sourceOwner(opening), original = opening.draft
  try {
    assert.equal((await registerSyncedSourceHistorySide({ checkpoint: initial.source.checkpoint, side: oldProof.side })).status, 'unavailable')
    assert.equal(prepareSourceCheckpoint({ checkpoint: initial.source.checkpoint, draft: initial.source.append(' old epoch'), historyOwner: oldOwner }).status, 'unavailable')
    const proof = adopted(await adoptSyncedSourceOpening(owner))
    assert.deepEqual(new Set(proof.facts.bindingSource.entries.map(entry => keyId(entry.key))), new Set(proof.facts.snapshot.bindings.map(keyId)))
    for (const binding of proof.facts.snapshot.bindings) {
      const entry = proof.facts.bindingSource.entries.find(entry => keyId(entry.key) === keyId(binding))
      assert.ok(entry, 'Every full B2 Key has its own actual source entry regardless of array order')
      assert.deepEqual(resolveSyncedBindingSource(api.db, proof.facts.bindingSource.ticketId, entry.entryId).target, binding.target)
    }
    assert.equal((await registerSyncedSourceHistorySide({ checkpoint: opening.checkpoint, side: proof.side })).status, 'registered')
    const marker = '[A](Target.md)', from = original.source.indexOf(marker)
    assert.ok(from >= 0, 'The actual B2 root contains its original A token')
    opening.apply(opening.edit(from, from + marker.length, ''), 'delete B2 opening token')
    assert.equal(await initial.binding.flush(), true)
    const replacement = replaceTarget(api), draft = opening.replay(original), preparation = opening.prepare(draft, owner)
    const claims = readPreparedSourceCheckpoint(preparation).bindingClaims
    assert.equal(claims.filter(claim => claim.kind === 'copy').length, 1)
    assert.equal(claims.filter(claim => claim.kind === 'continue').length, 1)
    const copy = claims.find(claim => claim.kind === 'copy')
    assert.ok(copy && copy.kind === 'copy' && copy.source.kind === 'ticket', 'The vanished B2 token uses its actual original ticket')
    const first = proof.facts.snapshot.bindings[0], entry = proof.facts.bindingSource.entries.find(entry => keyId(entry.key) === keyId(first))
    assert.ok(entry, 'Full Key joins the reversed entries to the original first target')
    assert.deepEqual(copy.source, { kind: 'ticket', ticketId: proof.facts.bindingSource.ticketId, entryId: entry.entryId })
    assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'restore original B2 token' }).status, 'accepted')
    assert.equal(await initial.binding.flush(), true)
    assert.deepEqual(snapshot(api.db).bindings.map(binding => binding.target), [
      { kind: 'document', id: other, state: 'live' }, { kind: 'document', id: host, state: 'live' }])
    assert.notEqual(replacement, other)
  } finally { await closeSyncedSourceReadOwner(oldOwner); await closeSyncedSourceReadOwner(owner) }
}))

test('history opening requests close their real await fence against edits reload rebind disposal and owner close', async () => {
  for (const action of ['edit', 'reload', 'rebind', 'dispose', 'close', 'scope-close'] as const) await withHistoryMain(async api => {
    const value = await history(api), entered = deferred<void>(), gate = deferred<void>()
    value.wire.delivery.operation = async result => { entered.resolve(); await gate.promise; return result }
    const pending = adoptSyncedSourceOpening(value.owner); await entered.promise
    let closing: Promise<void> | null = null, rebound: ReturnType<typeof value.controller.bind> | null = null, scopeCalls = 0
    try {
      if (action === 'edit') prefix(value, 'during history read ', 'await edit')
      else if (action === 'reload') await value.workspace.load([groupId])
      else if (action === 'rebind') rebound = value.controller.bind(value.scope)
      else if (action === 'dispose') value.binding.dispose()
      else if (action === 'close') closing = closeSyncedSourceReadOwner(value.owner)
      else value.callout(() => { if (!scopeCalls++) closing = closeSyncedSourceReadOwner(value.owner) })
      gate.resolve(); assert.equal((await pending).status, 'unavailable', action)
      if (action === 'scope-close') assert.ok(scopeCalls > 0, 'The real final scope callback actually revoked this history owner')
    } finally { gate.resolve(); await pending; if (closing) await closing; else await closeSyncedSourceReadOwner(value.owner); rebound?.dispose() }
  })
})

test('loaded history opening wrappers capture synchronously before immediate edits and ready-Promise close', async () => {
  for (const action of ['edit', 'close'] as const) await withHistoryMain(async api => {
    const value = await history(api), before = value.reads.operations.length
    const pending = adoptSyncedSourceOpening(value.owner)
    assert.equal(value.reads.operations.length, before + 1, 'The public wrapper enters the actual original Main operation before returning')
    let closing: Promise<void> | null = null
    try {
      if (action === 'edit') prefix(value, 'immediate ', 'immediate edit after history adopt')
      else closing = closeSyncedSourceReadOwner(value.owner)
      assert.equal((await pending).status, 'unavailable', action)
    } finally { await pending; if (closing) await closing; else await closeSyncedSourceReadOwner(value.owner) }
  })
})

test('the final history grammar getter cannot mutate an earlier parse identity and still adopt B2', async () => withHistoryMain(async api => {
  const value = await history(api), parse = markdownEngine.parse, option = Object.keys(markdownEngine.options).at(-1)
  assert.ok(option, 'The actual grammar has a final configurable option')
  const descriptor = Object.getOwnPropertyDescriptor(markdownEngine.options, option)
  assert.ok(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.configurable, 'The grammar fixture starts from real own data')
  let armed = false, installed = false, mutations = 0
  value.callout(() => {
    if (!armed || installed) return
    installed = true
    Object.defineProperty(markdownEngine.options, option, { configurable: true, enumerable: descriptor.enumerable, get() {
      if (!mutations) { mutations++; markdownEngine.parse = (...args: Parameters<typeof parse>) => parse.apply(markdownEngine, args) }
      return descriptor.value
    } })
  })
  value.wire.delivery.operation = async result => { armed = true; return result }
  try {
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable')
    assert.equal(installed, true); assert.equal(mutations, 1, 'The last grammar getter actually changed the already sampled parse function')
  } finally { armed = false; Object.defineProperty(markdownEngine.options, option, descriptor); markdownEngine.parse = parse; await closeSyncedSourceReadOwner(value.owner) }
}))

test('baseline receipt readers preserve facts after disposal without callbacks Main reads or forged-handle authority', async () => withHistoryMain(async api => {
  const value = await history(api), operations = value.reads.operations.length, validations = value.reads.validations.length
  try {
    assert.equal(readSyncedBaselineAck({ ...value.receipt }), null)
    assert.equal(readSyncedWorkingEndpointBaselineAck({ ...value.endpoint }), null)
    assert.equal((await adoptSyncedSourceOpening({ ...value.owner })).status, 'unavailable')
    const proof = adopted(await adoptSyncedSourceOpening(value.owner)), second = sourceSession(value.binding), owner = await sourceOwner(second)
    try {
      assert.equal((await registerSyncedSourceHistorySide({ checkpoint: second.checkpoint, side: proof.side })).status, 'unavailable')
      assert.equal(readAdoptedSourceSide({ ...proof.side }), null)
    } finally { await closeSyncedSourceReadOwner(owner) }
    const afterAdopt = value.reads.operations.length
    value.binding.dispose()
    value.callout(() => { throw new Error('Read-only history readers must never call scope/live') })
    assert.equal(readSyncedWorkingEndpointBaselineAck(value.endpoint), value.receipt)
    assert.deepEqual(readSyncedBaselineAck(value.receipt)?.ack, value.ack)
    assert.equal(value.reads.operations.length, afterAdopt)
    assert.equal(value.reads.validations.length, validations)
    assert.equal(afterAdopt, operations + 1)
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable')
  } finally { await closeSyncedSourceReadOwner(value.owner) }
}))

test('Main operation facts describe the read instant and cannot bypass later recovery at registration or ticket resolution', async () => withHistoryMain(async api => {
  const value = await history(api), entered = deferred<OperationResult>(), gate = deferred<OperationResult>()
  value.wire.delivery.operation = result => { entered.resolve(result); return gate.promise }
  const pending = adoptSyncedSourceOpening(value.owner), actual = await entered.promise
  try {
    assert.equal(actual.status, 'committed')
    const before = snapshot(api.db)
    api.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
    assert.deepEqual(snapshot(api.db), before)
    gate.resolve(actual)
    const proof = adopted(await pending)
    assert.deepEqual(proof.facts.snapshot, before, 'Frozen facts prove the earlier actual Main read, not transport-time freshness')
    assert.equal((await registerSyncedSourceHistorySide({ checkpoint: value.opening.checkpoint, side: proof.side })).status, 'owner-unavailable')
    const entry = proof.facts.bindingSource.entries[0]
    assert.throws(() => resolveSyncedBindingSource(api.db, proof.facts.bindingSource.ticketId, entry.entryId), /失效|恢复/)
    assert.deepEqual(snapshot(api.db), before)
    assert.equal(value.reads.captures.length, 1)
  } finally { gate.resolve(actual); await pending; await closeSyncedSourceReadOwner(value.owner) }
}))

test('the last delayed history read retains its original Main owner until completion even after group release and immediate close', async () => withHistoryMain(async api => {
  const value = await history(api), entered = deferred<OperationResult>(), gate = deferred<OperationResult>()
  value.wire.delivery.operation = result => { entered.resolve(result); return gate.promise }
  const pending = adoptSyncedSourceOpening(value.owner), actual = await entered.promise
  let closing: Promise<void> | null = null
  try {
    await value.workspace.load([groupId])
    assert.deepEqual(value.reads.releases, [])
    gate.resolve(actual); closing = closeSyncedSourceReadOwner(value.owner)
    assert.deepEqual(value.reads.releases, [], 'Neither group release nor immediate close can release the in-flight read retain')
    assert.equal((await pending).status, 'unavailable')
    await closing
    assert.deepEqual(value.reads.releases, [value.reads.captures[0].readOwnerId])
    assert.equal(value.reads.captures.length, 1)
  } finally { gate.resolve(actual); await pending; if (closing) await closing; else await closeSyncedSourceReadOwner(value.owner) }
}))
