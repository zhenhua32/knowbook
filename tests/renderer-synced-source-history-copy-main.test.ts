import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { markdownEngine } from '../src/shared/markdownEngine'
import type { SyncedBindingSource, SyncedGroupSaved } from '../src/shared/synced-blocks'
import { SyncedValidationError } from '../src/shared/syncedBlockValidation'
import { resolveSyncedBindingSource, releaseSyncedReadOwner } from '../src/main/database/synced-binding-sources'
import { readSyncedCommittedEndpoint } from '../src/renderer/src/features/synced-blocks/controller'
import { registerSyncedSourceHistorySide, discardPreparedSourceCheckpoint, prepareSourceCheckpoint,
  applyPreparedSourceCheckpoint, readPreparedSourceCheckpoint, readAcceptedSourceCheckpoint,
  adoptSyncedSourceBaseline, adoptSyncedAcceptedSource, closeSyncedSourceReadOwner,
  type SourceReadOwner } from '../src/renderer/src/features/synced-blocks/sourceLedger'
import { withHistoryMain, setup, sourceOwner, sourceSession, mainSources, adopted, deferred, replaceTarget, keyId,
  groupId, other, host, snapshot, type HistoryMainApi } from './helpers/source-history-copy-main-fixture'

type Fixture = Awaited<ReturnType<typeof setup>>
const tickets = (facts: ReturnType<typeof readPreparedSourceCheckpoint>) => facts.bindingClaims.flatMap(claim =>
  claim.kind === 'copy' && claim.source.kind === 'ticket' ? [{ destination: claim.destination, ...claim.source }] : [])
function firstEntry(source: SyncedBindingSource) {
  const entry = source.entries[0]
  assert.ok(entry, 'The real original baseline has a parser-verified source entry')
  return entry
}
function alive(api: HistoryMainApi, source: SyncedBindingSource) {
  return resolveSyncedBindingSource(api.db, source.ticketId, firstEntry(source).entryId)
}
function released(api: HistoryMainApi, source: SyncedBindingSource) {
  assert.throws(() => alive(api, source), (error: unknown) => error instanceof SyncedValidationError && error.code === 'binding',
    'The original ticket becomes unavailable only after its last actual consumer releases')
}
function cutFirst(value: Fixture) {
  const current = value.source.current(), marker = '[A](Target.md)', at = current.source.indexOf(marker)
  assert.ok(at >= 0, 'The exact first link is present in this real CM document')
  return value.source.edit(at, at + marker.length, '')
}
async function baseline(value: Fixture) {
  const owner = await sourceOwner(value.source), side = adopted(await adoptSyncedSourceBaseline(owner))
  assert.equal((await registerSyncedSourceHistorySide({ checkpoint: value.source.checkpoint, side: side.side })).status, 'registered')
  return { owner, ...side }
}
async function removed(api: HistoryMainApi) {
  const value = await setup(api), witness = await baseline(value), original = value.source.draft, cut = cutFirst(value)
  value.source.apply(cut, 'remove-first'); assert.equal(await value.binding.flush(), true)
  assert.equal(snapshot(api.db).bindings.length, 1)
  return { value, witness, original, cut }
}
async function revokeGroup(value: Fixture) {
  const before = value.controller.getSnapshot()
  await value.workspace.load([groupId])
  assert.equal(value.controller.getSnapshot(), before, 'Equal B reload revokes the group owner without replacing its accepted queues')
  assert.equal(value.reads.captures.length, 1, 'Reload never signs a replacement initial owner')
}

test('real CM replay copies only the disappeared token by its full original key despite reordered entries rename and path reuse', async () => withHistoryMain(async api => {
  const reads = mainSources(api)
  reads.hooks.capture = async result => {
    if (result.status !== 'ready') throw new Error('The actual seeded group must be ready')
    const next = structuredClone(result); next.bindingSource.entries.reverse(); return next
  }
  const fresh = await setup(api, reads), witness = await baseline(fresh), original = fresh.source.draft
  const changes = (api.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  for (let i = 0; i < 3; i++) assert.equal((await registerSyncedSourceHistorySide({ checkpoint: fresh.source.checkpoint, side: witness.side })).status, 'registered')
  assert.equal((api.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
  assert.deepEqual(witness.facts.bindingSource.entries.map(entry => keyId(entry.key)), witness.facts.snapshot.bindings.map(keyId).reverse())
  fresh.source.apply(cutFirst(fresh)); assert.equal(await fresh.binding.flush(), true)
  const replacement = replaceTarget(api), restored = fresh.source.replay(original)
  const preparation = fresh.source.prepare(restored, witness.owner), facts = readPreparedSourceCheckpoint(preparation), copied = tickets(facts)
  assert.equal(copied.length, 1); assert.equal(facts.bindingClaims.filter(claim => claim.kind === 'continue').length, 1)
  const entry = witness.facts.bindingSource.entries.find(entry => keyId(entry.key) === keyId(witness.facts.snapshot.bindings[0]))
  assert.ok(entry, 'The vanished first token joins the original full key rather than the reversed array index')
  assert.deepEqual({ ticketId: copied[0].ticketId, entryId: copied[0].entryId }, { ticketId: witness.facts.bindingSource.ticketId, entryId: entry.entryId })
  assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'restore-original-token' }).status, 'accepted')
  assert.equal(await fresh.binding.flush(), true)
  assert.deepEqual(snapshot(api.db).bindings.map(binding => binding.target), [
    { kind: 'document', id: other, state: 'live' }, { kind: 'document', id: host, state: 'live' }
  ])
  const target = snapshot(api.db).bindings[0].target
  assert.equal(target.kind, 'document'); if (target.kind !== 'document') throw new Error('The real first link targets its original document')
  assert.notEqual(target.id, replacement)
  await closeSyncedSourceReadOwner(witness.owner)
}))

test('retyping equal text creates fresh births and cannot borrow the absent original token witness', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api), replacement = replaceTarget(api)
  const typed = value.source.replace(original.source), preparation = value.source.prepare(typed, witness.owner), facts = readPreparedSourceCheckpoint(preparation)
  assert.equal(tickets(facts).length, 0); assert.equal(facts.bindingClaims.every(claim => claim.kind === 'new'), true)
  assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'equal-text-fresh-birth' }).status, 'accepted')
  assert.equal(await value.binding.flush(), true)
  assert.deepEqual(snapshot(api.db).bindings.map(binding => binding.target), [
    { kind: 'document', id: replacement, state: 'live' }, { kind: 'document', id: replacement, state: 'live' }
  ])
  await closeSyncedSourceReadOwner(witness.owner)
}))

test('a newborn accepted F1 requires its actual ACK side before its removed token can copy', async () => withHistoryMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source), born = value.source.append(' [new](Target.md)')
  const f1 = value.source.apply(born, 'newborn-F1').accepted
  value.source.apply(value.source.replace('plain'), 'remove-newborn-F2')
  const replay = value.source.replay(born)
  assert.equal((await adoptSyncedAcceptedSource(owner, f1)).status, 'waiting-original-ack')
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: replay, historyOwner: owner }).status, 'needs-history-source')
  assert.deepEqual(api.writes, [] as HistoryMainApi['writes']); assert.deepEqual(value.reads.operations, []); assert.deepEqual(api.lookups, [])
  assert.equal(await value.binding.flush(), true)
  const side = adopted(await adoptSyncedAcceptedSource(owner, f1))
  assert.equal((await registerSyncedSourceHistorySide({ checkpoint: value.source.checkpoint, side: side.side })).status, 'registered')
  const result = value.source.apply(value.source.current(), 'copy-acknowledged-newborn', owner)
  assert.equal(tickets(result.facts).length, 1)
  assert.equal(await value.binding.flush(), true)
  assert.deepEqual(value.reads.operations, [api.writes[0].clientOperationId])
  await closeSyncedSourceReadOwner(owner)
}, 'plain'))

test('same-content accepted sides with different tokens cannot lend each other a witness', async () => withHistoryMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source), f1Draft = value.source.append(' [new](Target.md)')
  const f1 = value.source.apply(f1Draft, 'first-birth').accepted; assert.equal(await value.binding.flush(), true)
  const f1Side = adopted(await adoptSyncedAcceptedSource(owner, f1))
  const f2 = value.source.apply(value.source.replace(f1Draft.source), 'second-equal-text-birth').accepted
  assert.equal(await value.binding.flush(), true)
  const f2Side = adopted(await adoptSyncedAcceptedSource(owner, f2))
  assert.deepEqual(f1Side.facts.snapshot.blocks, f2Side.facts.snapshot.blocks)
  assert.equal((await registerSyncedSourceHistorySide({ checkpoint: value.source.checkpoint, side: f2Side.side })).status, 'registered')
  const replay = value.source.replay(f1Draft)
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: replay, historyOwner: owner }).status, 'needs-history-source')
  assert.equal((await registerSyncedSourceHistorySide({ checkpoint: value.source.checkpoint, side: f1Side.side })).status, 'registered')
  assert.equal(tickets(readPreparedSourceCheckpoint(value.source.prepare(replay, owner))).length, 1)
  await closeSyncedSourceReadOwner(owner)
}, 'plain'))

test('fake side facts cross-checkpoint sides and another consumer owner cannot authorize an original token', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api), otherOwner = await sourceOwner(value.source)
  const foreign = sourceSession(value.binding)
  assert.equal((await registerSyncedSourceHistorySide({ checkpoint: value.source.checkpoint, side: { ...witness.side } })).status, 'unavailable')
  assert.equal((await registerSyncedSourceHistorySide({ checkpoint: foreign.checkpoint, side: witness.side })).status, 'unavailable')
  const replay = value.source.replay(original)
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: replay, historyOwner: otherOwner }).status, 'needs-history-source')
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: replay }).status, 'needs-history-source')
  const fakeOwner: SourceReadOwner = { ...witness.owner }
  assert.notEqual(prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: replay, historyOwner: fakeOwner }).status, 'prepared')
  assert.equal(api.writes.length, 1); assert.deepEqual(value.reads.operations, [])
  await closeSyncedSourceReadOwner(otherOwner); await closeSyncedSourceReadOwner(witness.owner)
}))

test('dirty Rich opening has no original Source acceptance and never borrows the initial baseline ticket after ACK', async () => withHistoryMain(async api => {
  const value = await setup(api), initial = await baseline(value), state = value.binding.getCurrent()
  const block = { ...state.working[0], content: 'dirty [R](Target.md)' }, from = block.content.indexOf('Target.md')
  assert.equal(value.binding.apply({ expectedEditSequence: state.editSequence,
    guards: { groupId, expectedRevision: state.snapshot.revision, expectedTopologyRevision: state.snapshot.topologyRevision },
    blocks: [block], bindingClaims: [{ kind: 'new', destination: { blockId: block.id, from, to: from + 9, raw: 'Target.md', syntax: 'markdown' } }],
    transactionId: 'genuine-rich-opening', bookmark: null }), true)
  const dirty = sourceSession(value.binding), owner = await sourceOwner(dirty)
  assert.equal((await adoptSyncedSourceBaseline(owner)).status, 'waiting-original-ack')
  assert.equal(await value.binding.flush(), true)
  assert.equal((await adoptSyncedSourceBaseline(owner)).status, 'unavailable')
  assert.equal((await registerSyncedSourceHistorySide({ checkpoint: dirty.checkpoint, side: initial.side })).status, 'unavailable')
  dirty.apply(dirty.replace('removed Rich token'))
  const replay = dirty.replay(dirty.draft)
  assert.equal(prepareSourceCheckpoint({ checkpoint: dirty.checkpoint, draft: replay, historyOwner: owner }).status, 'needs-history-source')
  assert.deepEqual(value.reads.operations, [], 'No random operation query or later owned capture substitutes the missing original Source acceptance')
  await closeSyncedSourceReadOwner(owner); await closeSyncedSourceReadOwner(initial.owner)
}))

test('copy preparation memo belongs to its exact issuer and discard is idempotent without erasing another owner witnesses', async () => withHistoryMain(async api => {
  const value = await setup(api), a = await baseline(value), b = await baseline(value), cut = cutFirst(value)
  value.source.apply(cut); assert.equal(await value.binding.flush(), true)
  const replay = value.source.replay(value.source.draft), preparation = value.source.prepare(replay, a.owner)
  assert.equal(value.source.prepare(replay, a.owner), preparation)
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: replay }).status, 'unavailable')
  assert.equal(prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: replay, historyOwner: b.owner }).status, 'unavailable')
  assert.equal(discardPreparedSourceCheckpoint(preparation), true); assert.equal(discardPreparedSourceCheckpoint(preparation), false)
  const again = value.source.prepare(replay, a.owner); assert.notEqual(again, preparation)
  await closeSyncedSourceReadOwner(b.owner)
  assert.equal(applyPreparedSourceCheckpoint({ preparation: again, transactionId: 'A-survives-B-close' }).status, 'accepted')
  assert.equal(discardPreparedSourceCheckpoint(again), false)
  assert.equal(discardPreparedSourceCheckpoint({ ...again }), false)
  assert.equal(await value.binding.flush(), true)
  await closeSyncedSourceReadOwner(a.owner)
}))

test('closing one issuer invalidates only its staged copy and leaves the other issuer able to prepare the same draft', async () => withHistoryMain(async api => {
  const value = await setup(api), a = await baseline(value), b = await baseline(value)
  value.source.apply(cutFirst(value)); assert.equal(await value.binding.flush(), true)
  const replay = value.source.replay(value.source.draft), old = value.source.prepare(replay, a.owner)
  const closing = closeSyncedSourceReadOwner(a.owner)
  assert.equal(applyPreparedSourceCheckpoint({ preparation: old, transactionId: 'closed-A' }).status, 'unavailable')
  assert.equal(discardPreparedSourceCheckpoint(old), false)
  const next = value.source.prepare(replay, b.owner)
  assert.equal(applyPreparedSourceCheckpoint({ preparation: next, transactionId: 'retained-B' }).status, 'accepted')
  await closing; assert.equal(await value.binding.flush(), true)
  await closeSyncedSourceReadOwner(b.owner)
}))

test('queued frame alone keeps the original ticket after real equal-B reload and Source close until its exact ACK', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api), replay = value.source.replay(original)
  const result = value.source.apply(replay, 'queued-copy', witness.owner)
  await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  assert.deepEqual(value.reads.releases, [], 'The group and Source no longer mask the frame retain')
  assert.deepEqual(alive(api, witness.facts.bindingSource).target, witness.facts.snapshot.bindings[0].target)
  const memo = applyPreparedSourceCheckpoint({ preparation: result.preparation, transactionId: 'memo-after-owner-close' })
  assert.equal(memo.status, 'accepted'); assert.equal(discardPreparedSourceCheckpoint(result.preparation), false)
  assert.equal(await value.binding.flush(), true); await closeSyncedSourceReadOwner(witness.owner)
  assert.deepEqual(value.reads.releases, [value.reads.captures[0].readOwnerId]); released(api, witness.facts.bindingSource)
}))

test('a coalesced continue inherits the old copy ticket while Source close cannot clear its transferred batch', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api)
  value.source.apply(value.source.replay(original), 'one-coalesced-frame', witness.owner)
  const tail = value.source.apply(value.source.edit(0, 0, 'prefix '), 'one-coalesced-frame')
  assert.equal(tickets(tail.facts).length, 0, 'The second step contains continue claims and must inherit the earlier frame dependency')
  await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  assert.deepEqual(value.reads.releases, []); alive(api, witness.facts.bindingSource)
  assert.equal(await value.binding.flush(), true); await closeSyncedSourceReadOwner(witness.owner)
  assert.equal(api.writes.length, 2); assert.equal(api.writes[1].bindingClaims?.filter(claim => claim.kind === 'copy').length, 1)
  assert.equal(value.reads.releases.length, 1); released(api, witness.facts.bindingSource)
}))

test('coalescing away the temporary copy releases its frame dependency without retaining an empty queue', async () => withHistoryMain(async api => {
  const { value, witness, original, cut } = await removed(api)
  value.source.apply(value.source.replay(original), 'temporary-copy', witness.owner)
  value.source.apply(value.source.replay(cut), 'temporary-copy')
  assert.equal(value.controller.getSnapshot().dirty, false)
  await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  assert.equal(value.reads.releases.length, 1); released(api, witness.facts.bindingSource)
  assert.equal(await value.binding.flush(), true); assert.equal(api.writes.length, 1)
}))

test('a temporary copy tail popping back to pending F1 never installs its resources on F1 FrameVersion', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api), entered = deferred<void>(), gate = deferred<void>()
  const prefix = value.source.edit(0, 0, 'prefix '), f1 = value.source.apply(prefix, 'real-F1').accepted
  api.beforeWrite = async () => { entered.resolve(); await gate.promise }
  const flushing = value.binding.flush(); await entered.promise
  try {
    value.source.apply(value.source.replay(original), 'temporary-F2', witness.owner)
    const returned = value.source.apply(value.source.replay(prefix), 'temporary-F2').accepted
    await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
    assert.equal(value.reads.releases.length, 1, 'F1 has no ticket claims; eliminated F2 must not pin the old pending version')
    released(api, witness.facts.bindingSource)
    gate.resolve(); assert.equal(await flushing, true)
    assert.equal(api.writes.length, 2, 'Only the original cut and F1 reached the actual Main writer')
    assert.ok(readAcceptedSourceCheckpoint(f1)?.committed, 'F1 settles its own original mailbox')
    assert.ok(readAcceptedSourceCheckpoint(returned)?.committed, 'The returned prefix shares the original submitted version')
  } finally { gate.resolve(); await flushing }
}))

test('local redo alone retains its original ticket across group revocation and Source close', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api)
  value.source.apply(value.source.replay(original), 'will-redo', witness.owner)
  assert.equal(await value.binding.undo(), true); await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  assert.deepEqual(value.reads.releases, []); alive(api, witness.facts.bindingSource)
  assert.equal(await value.binding.redo(), true); assert.equal(await value.binding.flush(), true)
  await closeSyncedSourceReadOwner(witness.owner)
  assert.equal(value.reads.releases.length, 1); released(api, witness.facts.bindingSource)
}))

test('cutting a local redo branch releases its copy resources while a new ticket-free frame remains queued', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api)
  value.source.apply(value.source.replay(original), 'discarded-redo', witness.owner)
  assert.equal(await value.binding.undo(), true); await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  assert.deepEqual(value.reads.releases, [])
  const state = value.binding.getCurrent()
  assert.equal(value.binding.apply({ expectedEditSequence: state.editSequence,
    guards: { groupId, expectedRevision: state.snapshot.revision, expectedTopologyRevision: state.snapshot.topologyRevision },
    blocks: [{ ...state.working[0], content: 'new ticket-free branch' }], bindingClaims: [], transactionId: 'cut-redo', bookmark: null }), true)
  await closeSyncedSourceReadOwner(witness.owner)
  assert.equal(value.controller.getSnapshot().dirty, true); assert.equal(value.reads.releases.length, 1); released(api, witness.facts.bindingSource)
  assert.equal(await value.binding.flush(), true)
}))

test('lost committed ACK retains the exact frame and pending ticket until real original operation lookup settles it', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api), accepted = value.source.apply(value.source.replay(original), 'lost-copy-ACK', witness.owner).accepted
  await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  api.deliver = async () => { throw new Error('The actual Main committed before ACK transport failed') }
  assert.equal(await value.binding.flush(), false); assert.deepEqual(value.reads.releases, [])
  assert.equal(readAcceptedSourceCheckpoint(accepted)?.committed, null); alive(api, witness.facts.bindingSource)
  assert.equal(await value.binding.flush(), true); await closeSyncedSourceReadOwner(witness.owner)
  assert.deepEqual(api.lookups, [api.writes[1].clientOperationId]); assert.equal(api.writes.length, 2)
  assert.ok(readAcceptedSourceCheckpoint(accepted)?.committed, 'The original durable ACK settles without resending a copy')
  assert.equal(value.reads.releases.length, 1); released(api, witness.facts.bindingSource)
}))

test('unknown and disconnected lookups retain the exact uncertain body for a later retry instead of releasing or regenerating its tickets', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api)
  value.source.apply(value.source.replay(original), 'uncertain-copy', witness.owner)
  await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  api.beforeWrite = async () => { throw new Error('Transport failed before Main received the first copy request') }
  assert.equal(await value.binding.flush(), false)
  api.lookupDelivery = async value => { assert.equal(value.status, 'unknown'); throw new Error('Lookup delivery disconnected') }
  assert.equal(await value.binding.flush(), false); assert.equal(api.writes.length, 2)
  assert.deepEqual(value.reads.releases, []); alive(api, witness.facts.bindingSource)
  api.lookupDelivery = async value => value; api.beforeWrite = async () => {}
  assert.equal(await value.binding.flush(), true); await closeSyncedSourceReadOwner(witness.owner)
  assert.equal(api.writes.length, 3); assert.deepEqual(api.writes[1], api.writes[2])
  assert.deepEqual(api.lookups, [api.writes[1].clientOperationId, api.writes[1].clientOperationId])
  assert.equal(value.reads.releases.length, 1); released(api, witness.facts.bindingSource)
}))

test('a definitive failed pending attempt keeps a retryable queued copy frame and its original source alive', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api)
  value.source.apply(value.source.replay(original), 'retryable-copy', witness.owner)
  await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  // A real closed wire input rejected by Main is a definitive failure; the
  // controller still owns the valid local frame and may submit it again.
  api.wireInput = input => ({ ...structuredClone(input), bindingClaims: [] })
  assert.equal(await value.binding.flush(), false)
  assert.deepEqual(value.reads.releases, []); alive(api, witness.facts.bindingSource)
  api.wireInput = input => input
  assert.equal(await value.binding.flush(), true); await closeSyncedSourceReadOwner(witness.owner)
  assert.equal(api.writes.length, 3); assert.notEqual(api.writes[1].clientOperationId, api.writes[2].clientOperationId)
  assert.equal(value.reads.releases.length, 1); released(api, witness.facts.bindingSource)
}))

test('registration cannot install a partial witness across an awaited local acceptance or its immediate public-wrapper race', async () => {
  for (const immediate of [false, true]) await withHistoryMain(async api => {
    const value = await setup(api), owner = await sourceOwner(value.source), side = adopted(await adoptSyncedSourceBaseline(owner))
    const entered = deferred<void>(), gate = deferred<void>(), count = value.reads.validations.length
    value.reads.hooks.validate = async result => { entered.resolve(); await gate.promise; return result }
    const registering = registerSyncedSourceHistorySide({ checkpoint: value.source.checkpoint, side: side.side })
    try {
      if (immediate) assert.equal(value.reads.validations.length, count + 1, 'The loaded public registration captures its fence before returning')
      else await entered.promise
      value.source.apply(value.source.edit(0, 0, 'concurrent ')); gate.resolve()
      assert.equal((await registering).status, 'unavailable')
      value.source.apply(cutFirst(value))
      const replay = value.source.replay(value.source.draft)
      assert.equal(prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: replay, historyOwner: owner }).status, 'needs-history-source')
      assert.deepEqual(api.writes, [])
    } finally { gate.resolve(); await registering; await closeSyncedSourceReadOwner(owner) }
  })
})

test('closing the issuer from the final apply scope callback rejects a staged copy without queue or resource residue', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api), replay = value.source.replay(original), preparation = value.source.prepare(replay, witness.owner)
  const before = value.controller.getSnapshot(); let called = 0
  value.callout(() => { if (++called === 4) void closeSyncedSourceReadOwner(witness.owner) })
  try { assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'close-in-scope' }).status, 'unavailable') }
  finally { value.callout(() => {}) }
  assert.equal(called, 4, 'The real final controller scope callback ran after the resource plan and revoked its issuer')
  assert.equal(value.controller.getSnapshot(), before)
  await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  assert.equal(value.reads.releases.length, 1); released(api, witness.facts.bindingSource)
}))

test('a missing original Main owner returns owner-unavailable without a replacement capture or operation guess', async () => withHistoryMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source), side = adopted(await adoptSyncedSourceBaseline(owner))
  releaseSyncedReadOwner(api.db, { readOwnerId: value.reads.captures[0].readOwnerId })
  assert.equal((await registerSyncedSourceHistorySide({ checkpoint: value.source.checkpoint, side: side.side })).status, 'owner-unavailable')
  assert.equal(value.reads.captures.length, 1); assert.deepEqual(value.reads.operations, []); assert.deepEqual(api.writes, [])
  await closeSyncedSourceReadOwner(owner)
}))

test('registered historical sources remain bounded to the original content epoch after local history or a real external reload', async () => {
  for (const change of ['history', 'reload'] as const) await withHistoryMain(async api => {
    const { value, witness, original } = await removed(api)
    if (change === 'history') assert.equal(await value.binding.undo(), true)
    else await value.workspace.load([groupId])
    assert.equal((await registerSyncedSourceHistorySide({ checkpoint: value.source.checkpoint, side: witness.side })).status, 'unavailable')
    const replay = value.source.replay(original)
    assert.notEqual(prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: replay, historyOwner: witness.owner }).status, 'prepared')
    assert.equal(value.reads.captures.length, 1)
    await closeSyncedSourceReadOwner(witness.owner)
  })
})

test('a final copy-prepare grammar getter cannot mutate an earlier sampled parse and install a staged resource batch', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api), replay = value.source.replay(original)
  const parse = markdownEngine.parse, option = Object.keys(markdownEngine.options).at(-1)
  assert.ok(option, 'The actual Markdown grammar has a final own option')
  const descriptor = Object.getOwnPropertyDescriptor(markdownEngine.options, option)
  assert.ok(descriptor && 'value' in descriptor && descriptor.configurable, 'The existing option is configurable own data before this callout fixture')
  let scopes = 0, mutations = 0
  let preparation: ReturnType<typeof value.source.prepare> | undefined
  const injectFinalGetter = () => Object.defineProperty(markdownEngine.options, option, { configurable: true, enumerable: descriptor.enumerable,
    get() {
      if (scopes >= 3 && !mutations) {
        mutations++; markdownEngine.parse = (...args: Parameters<typeof parse>) => parse.apply(markdownEngine, args)
      }
      return descriptor.value
    } })
  value.callout(() => { if (++scopes === 3) injectFinalGetter() })
  try {
    const result = prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: replay, historyOwner: witness.owner })
    if (result.status === 'prepared') preparation = result.preparation
    assert.equal(mutations, 1, 'The actual option getter ran in the final endpoint capture after earlier grammar checks')
    assert.equal(result.status, 'unavailable', 'Changed final grammar cannot install a prepared copy or keep its resource batch')
  } finally {
    value.callout(() => {}); Object.defineProperty(markdownEngine.options, option, descriptor); markdownEngine.parse = parse
    if (preparation) discardPreparedSourceCheckpoint(preparation)
    await closeSyncedSourceReadOwner(witness.owner)
  }
  await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  assert.equal(value.reads.releases.length, 1); released(api, witness.facts.bindingSource)
}))

test('workspace expiry during a real unknown lookup prevents resending while the unresolved original copy keeps its ticket', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api)
  value.source.apply(value.source.replay(original), 'unknown-copy-expiry', witness.owner)
  await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  api.beforeWrite = async () => { throw new Error('The copy request failed before Main dispatch') }
  assert.equal(await value.binding.flush(), false)
  api.lookupDelivery = async result => {
    assert.equal(result.status, 'unknown', 'The real operation ledger has not committed this original request')
    api.snapshotReply = value => ({ ...value, workspaceScope: randomUUID() })
    await assert.rejects(value.workspace.load([groupId]), /workspace identity changed/i)
    return result
  }
  assert.equal(await value.controller.flush(), false)
  assert.equal(api.writes.length, 2, 'Expiry blocks the unknown retry before another request is dispatched')
  assert.deepEqual(value.reads.releases, []); alive(api, witness.facts.bindingSource)
  assert.equal(value.controller.getSnapshot().pending?.clientOperationId, api.writes[1].clientOperationId)
  // There is no abandon protocol in this slice. This unresolved request is
  // deliberately retained; expiry and fixture teardown are not an ACK.
}))

test('the original in-flight copy ACK may settle after workspace expiry and releases only its source while later work stays queued', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api), sent = deferred<SyncedGroupSaved>(), gate = deferred<SyncedGroupSaved>()
  const first = value.source.apply(value.source.replay(original), 'late-copy-F1', witness.owner).accepted
  value.source.apply(value.source.append('!'), 'later-continue-F2')
  await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  api.deliver = async ack => { sent.resolve(ack); return gate.promise }
  const flushing = value.binding.flush(), ack = await sent.promise
  try {
    api.snapshotReply = value => ({ ...value, workspaceScope: randomUUID() })
    await assert.rejects(value.workspace.load([groupId]), /workspace identity changed/i)
    assert.deepEqual(value.reads.releases, []); alive(api, witness.facts.bindingSource)
    gate.resolve(ack); assert.equal(await flushing, false); await closeSyncedSourceReadOwner(witness.owner)
    assert.ok(readAcceptedSourceCheckpoint(first)?.committed, 'The actual original ACK remains recordable after expiry')
    assert.equal(api.writes.length, 2, 'The later F2 was never dispatched after expiry')
    assert.equal(value.controller.getSnapshot().dirty, true)
    assert.equal(value.reads.releases.length, 1); released(api, witness.facts.bindingSource)
  } finally { gate.resolve(ack); await flushing }
}))

test('a recovery after the actual validation read cannot turn its delayed reply into future copy writer authority', async () => withHistoryMain(async api => {
  const value = await setup(api), owner = await sourceOwner(value.source), side = adopted(await adoptSyncedSourceBaseline(owner))
  value.source.apply(cutFirst(value)); assert.equal(await value.binding.flush(), true)
  value.reads.hooks.validate = async result => {
    assert.equal(result.status, 'ready', 'The original Main owner was valid at the actual read instant')
    api.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
    return result
  }
  const registration = await registerSyncedSourceHistorySide({ checkpoint: value.source.checkpoint, side: side.side })
  // This trusted reply can describe the pre-recovery read instant. Even when
  // registration succeeds, a future writer must resolve its old ticket again.
  assert.ok(['registered', 'owner-unavailable', 'unavailable'].includes(registration.status), 'Registration stays within its documented read-time statuses')
  released(api, side.facts.bindingSource)
  const before = snapshot(api.db)
  if (registration.status === 'registered') {
    const replay = value.source.replay(value.source.draft)
    const result = prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: replay, historyOwner: owner })
    if (result.status === 'prepared') {
      const applied = applyPreparedSourceCheckpoint({ preparation: result.preparation, transactionId: 'stale-read-instant-copy' })
      if (applied.status === 'accepted') {
        assert.equal(await value.binding.flush(), false)
        assert.equal(value.controller.getSnapshot().failure?.status, 'invalid')
      }
    }
  }
  assert.deepEqual(snapshot(api.db), before, 'The real Main writer never commits an expired historical source')
  assert.equal(value.reads.captures.length, 1); assert.deepEqual(value.reads.operations, [])
  await closeSyncedSourceReadOwner(owner)
}))

test('subscriber reentry closes the issuer and accepts later work only after the original frame has taken its own source batch', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api), replay = value.source.replay(original), preparation = value.source.prepare(replay, witness.owner)
  const facts = readPreparedSourceCheckpoint(preparation); let called = 0
  const unsubscribe = value.controller.subscribe(() => {
    unsubscribe(); called++; void closeSyncedSourceReadOwner(witness.owner)
    const state = value.binding.getCurrent(), prefix = 'subscriber '
    assert.equal(value.binding.apply({ expectedEditSequence: state.editSequence,
      guards: { groupId, expectedRevision: state.snapshot.revision, expectedTopologyRevision: state.snapshot.topologyRevision },
      blocks: [{ ...state.working[0], content: prefix + state.working[0].content }],
      bindingClaims: facts.bindingClaims.map(claim => ({ kind: 'continue', source: { ...claim.destination },
        destination: { ...claim.destination, from: claim.destination.from + prefix.length, to: claim.destination.to + prefix.length } })),
      transactionId: 'subscriber-second-frame', bookmark: null }), true)
  })
  const accepted = applyPreparedSourceCheckpoint({ preparation, transactionId: 'subscriber-original-copy' })
  unsubscribe(); assert.equal(called, 1); assert.equal(accepted.status, 'accepted')
  assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'memo-after-subscriber' }), accepted,
    'Subscriber close cannot discard the accepted batch or replace the original acceptance memo')
  await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  assert.deepEqual(value.reads.releases, []); alive(api, witness.facts.bindingSource)
  assert.equal(await value.binding.flush(), true); await closeSyncedSourceReadOwner(witness.owner)
  assert.equal(api.writes.length, 3)
  assert.equal(api.writes[1].blocks[0].content.startsWith('subscriber '), false)
  assert.equal(api.writes[2].blocks[0].content.startsWith('subscriber '), true)
  if (accepted.status !== 'accepted') throw new Error('The actual outer Source Apply must have accepted F1')
  const committed = readAcceptedSourceCheckpoint(accepted.accepted)?.committed
  assert.ok(committed, 'The original F1 acceptance keeps its own mailbox after F2 subscriber reentry')
  assert.equal(readSyncedCommittedEndpoint(committed)?.ack.operationId, api.writes[1].clientOperationId)
  assert.equal(value.reads.releases.length, 1); released(api, witness.facts.bindingSource)
}))

test('re-reading a staged copy cannot return prepared with a revoked or null preparation after its scope callback closes the issuer', async () => withHistoryMain(async api => {
  const { value, witness, original } = await removed(api), replay = value.source.replay(original)
  const preparation = value.source.prepare(replay, witness.owner), before = value.controller.getSnapshot()
  let closes = 0
  value.callout(() => { if (!closes++) void closeSyncedSourceReadOwner(witness.owner) })
  let result: ReturnType<typeof prepareSourceCheckpoint>
  try { result = prepareSourceCheckpoint({ checkpoint: value.source.checkpoint, draft: replay, historyOwner: witness.owner }) }
  finally { value.callout(() => {}) }
  assert.equal(closes, 1, 'The repeated prepare reached its actual scope callback and synchronously revoked the staged owner')
  assert.equal(result.status, 'unavailable', 'A closed stage cannot return prepared, including prepared with a null handle')
  assert.equal(value.controller.getSnapshot(), before, 'Stage re-read and issuer closure do not enqueue or alter accepted work')
  assert.equal(discardPreparedSourceCheckpoint(preparation), false)
  await revokeGroup(value); await closeSyncedSourceReadOwner(witness.owner)
  assert.equal(value.reads.releases.length, 1); released(api, witness.facts.bindingSource)
}))
