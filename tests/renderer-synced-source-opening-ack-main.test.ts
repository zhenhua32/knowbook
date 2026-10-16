import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { markdownEngine } from '../src/shared/markdownEngine'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '../src/shared/markdownLinks'
import type { SyncedBindingKey, SyncedGroupSaved } from '../src/shared/synced-blocks'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { getSyncedOperationWithOwnedLinkSource, releaseSyncedReadOwner, resolveSyncedBindingSource } from '../src/main/database/synced-binding-sources'
import { captureSyncedWorkingEndpoint, readSyncedWorkingEndpoint, readSyncedWorkingEndpointCommitted, readSyncedCommittedEndpoint } from '../src/renderer/src/features/synced-blocks/controller'
import { adoptSyncedSourceOpening, adoptSyncedSourceBaseline, adoptSyncedAcceptedSource, registerSyncedSourceHistorySide,
  applyPreparedSourceCheckpoint, readPreparedSourceCheckpoint, readAdoptedSourceSide,
  closeSyncedSourceReadOwner, type AcceptedSourceCheckpoint } from '../src/renderer/src/features/synced-blocks/sourceLedger'
import { withHistoryMain, setup, mainSources, sourceSession, sourceOwner, adopted, deferred, replaceTarget,
  snapshot, groupId, other, host, keyId, type HistoryMainApi } from './helpers/source-history-copy-main-fixture'

type Fixture = Awaited<ReturnType<typeof setup>>
type ReadPort = ReturnType<typeof mainSources>['port']
type OperationResult = Awaited<ReturnType<ReadPort['operation']>>
function transport(api: HistoryMainApi) {
  const reads = mainSources(api)
  const delivery = { read: async (value: OperationResult): Promise<OperationResult> => value }
  // Invoke the actual Main read synchronously before returning its transport
  // Promise, so ready-Promise/close ordering has no extra fixture microtask.
  reads.port.operation = input => {
    reads.operations.push(input.clientOperationId)
    return delivery.read(getSyncedOperationWithOwnedLinkSource(api.db, input))
  }
  return { reads, delivery }
}
/** Actual parser keys plus this fixture's explicit prefix/suffix operation.
 * The real controller and Main still validate every continue claim. */
function currentKeys(value: Fixture): SyncedBindingKey[] {
  const current = value.binding.getCurrent(), blocks = current.working
  return collectDocumentMarkdownLinks(blocks).filter(link => link.kind !== 'image'
    && (link.kind === 'wiki' || resolveMarkdownDocumentPath(current.snapshot.origin.pathAtCreation, link.url) !== null))
    .map(link => ({ blockId: blocks[link.blockIndex].id, from: link.start, to: link.end,
      raw: blocks[link.blockIndex].content.slice(link.start, link.end), syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' }))
}
function richPrefix(value: Fixture, prefix = 'rich ', transactionId = 'Rich transaction is not a Main operation UUID') {
  const before = value.binding.getCurrent(), first = before.working[0].id
  const blocks = before.working.map(block => ({ ...block, content: block.id === first ? prefix + block.content : block.content }))
  const bindingClaims = currentKeys(value).map(source => ({ kind: 'continue' as const, source,
    destination: { ...source, from: source.from + (source.blockId === first ? prefix.length : 0), to: source.to + (source.blockId === first ? prefix.length : 0) } }))
  assert.equal(value.binding.apply({ expectedEditSequence: before.editSequence,
    guards: { groupId, expectedRevision: before.snapshot.revision, expectedTopologyRevision: before.snapshot.topologyRevision },
    blocks, bindingClaims, transactionId, bookmark: null }), true, 'The real generic Rich binding accepts this explicit prefix')
}
function richContent(value: Fixture, content: string, transactionId: string) {
  const before = value.binding.getCurrent(), blocks = before.working.map((block, index) => ({ ...block, content: index ? block.content : content }))
  const bindingClaims = currentKeys(value).map(source => ({ kind: 'continue' as const, source, destination: { ...source } }))
  assert.equal(value.binding.apply({ expectedEditSequence: before.editSequence,
    guards: { groupId, expectedRevision: before.snapshot.revision, expectedTopologyRevision: before.snapshot.topologyRevision },
    blocks, bindingClaims, transactionId, bookmark: null }), true, 'The real generic binding accepts this suffix-only edit')
}
async function opened(api: HistoryMainApi, options: { flushFirst?: boolean; port?: ReturnType<typeof transport> } = {}) {
  const wire = options.port ?? transport(api), value = await setup(api, wire.reads)
  richPrefix(value)
  if (options.flushFirst) assert.equal(await value.binding.flush(), true)
  const source = sourceSession(value.binding), owner = await sourceOwner(source)
  return { ...value, opening: source, owner, delivery: wire.delivery }
}

test('dirty controller content opening waits without lookup or flush and then adopts only its original full ACK', async () => withHistoryMain(async api => {
  const value = await opened(api), writes = api.writes.length
  assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'waiting-original-ack')
  assert.equal((await adoptSyncedSourceBaseline(value.owner)).status, 'waiting-original-ack')
  assert.deepEqual(value.reads.operations, []); assert.deepEqual(api.lookups, []); assert.equal(api.writes.length, writes)
  const working = structuredClone(value.binding.getCurrent().working)
  assert.notDeepEqual(syncedCanonicalEdits(value.binding.getCurrent().snapshot.blocks), working,
    'The original opening persisted B differs from its real dirty W')
  assert.equal(await value.binding.flush(), true)
  const result = adopted(await adoptSyncedSourceOpening(value.owner))
  assert.equal(result.facts.kind, 'opening'); assert.ok(result.facts.committed, 'The opening uses a real registered content mailbox')
  const committed = readSyncedCommittedEndpoint(result.facts.committed)
  assert.ok(committed, 'The opaque content receipt has its actual immutable ACK')
  assert.deepEqual(result.facts.snapshot, committed.ack.snapshot)
  assert.equal(committed.ack.replayed, false, 'The actual first writer ACK is not a replay')
  assert.deepEqual(syncedCanonicalEdits(result.facts.snapshot.blocks), working)
  assert.notEqual(api.writes[0].clientOperationId, committed.transactionId)
  assert.deepEqual(value.reads.operations, [api.writes[0].clientOperationId]); assert.deepEqual(api.lookups, [])
  assert.equal((await adoptSyncedSourceBaseline(value.owner)).status, 'unavailable', 'The old baseline API keeps its original meaning after this content ACK')
  await closeSyncedSourceReadOwner(value.owner)
}))

test('a Source opened after Rich has already ACKed still uses that original content Endpoint', async () => withHistoryMain(async api => {
  const value = await opened(api, { flushFirst: true })
  assert.equal(value.binding.getCurrent().dirty, false)
  const result = adopted(await adoptSyncedSourceOpening(value.owner))
  assert.equal(result.facts.kind, 'opening'); assert.deepEqual(result.facts.snapshot, snapshot(api.db))
  assert.deepEqual(value.reads.operations, [api.writes[0].clientOperationId]); assert.equal(api.writes.length, 1)
  await closeSyncedSourceReadOwner(value.owner)
}))

test('an opening side registers its original tokens and restores a disappeared same-URL target through real copy tickets', async () => withHistoryMain(async api => {
  const wire = transport(api)
  wire.delivery.read = async result => {
    if (result.status !== 'committed') return result
    const next = structuredClone(result); next.bindingSource.entries.reverse(); return next
  }
  const value = await opened(api, { port: wire }), original = value.opening.draft
  assert.equal(await value.binding.flush(), true)
  const proof = adopted(await adoptSyncedSourceOpening(value.owner))
  assert.deepEqual(new Set(proof.facts.bindingSource.entries.map(entry => keyId(entry.key))),
    new Set(proof.facts.snapshot.bindings.map(keyId)), 'The reversed entries cover each full original Key exactly once')
  for (const binding of proof.facts.snapshot.bindings) {
    const originalEntry = proof.facts.bindingSource.entries.find(entry => keyId(entry.key) === keyId(binding))
    assert.ok(originalEntry, 'A complete Key finds the actual original entry independently of array order')
    assert.deepEqual(resolveSyncedBindingSource(api.db, proof.facts.bindingSource.ticketId, originalEntry.entryId).target,
      binding.target, 'The actual Main resolver preserves the different target for each same-URL Key')
  }
  assert.equal((await registerSyncedSourceHistorySide({ checkpoint: value.opening.checkpoint, side: proof.side })).status, 'registered')
  const marker = '[A](Target.md)', at = original.source.indexOf(marker)
  assert.ok(at >= 0, 'The real opening contains the first exact link')
  value.opening.apply(value.opening.edit(at, at + marker.length, ''), 'remove-opening-token')
  assert.equal(await value.binding.flush(), true)
  const replacement = replaceTarget(api), restored = value.opening.replay(original), preparation = value.opening.prepare(restored, value.owner)
  const facts = readPreparedSourceCheckpoint(preparation), copy = facts.bindingClaims.find(claim => claim.kind === 'copy')
  assert.equal(facts.bindingClaims.filter(claim => claim.kind === 'copy').length, 1)
  assert.equal(facts.bindingClaims.filter(claim => claim.kind === 'continue').length, 1)
  assert.ok(copy && copy.kind === 'copy' && copy.source.kind === 'ticket', 'The vanished original token has one actual ticket copy')
  if (copy.kind !== 'copy' || copy.source.kind !== 'ticket') throw new Error('The copy must use the original Main source ticket')
  const entry = proof.facts.bindingSource.entries.find(entry => keyId(entry.key) === keyId(proof.facts.snapshot.bindings[0]))
  assert.ok(entry, 'Full key joins the reversed entry array')
  assert.deepEqual(copy.source, { kind: 'ticket', ticketId: proof.facts.bindingSource.ticketId, entryId: entry.entryId })
  assert.equal(applyPreparedSourceCheckpoint({ preparation, transactionId: 'restore-opening-token' }).status, 'accepted')
  assert.equal(await value.binding.flush(), true)
  const targets = snapshot(api.db).bindings.map(binding => binding.target)
  assert.deepEqual(targets, [{ kind: 'document', id: other, state: 'live' }, { kind: 'document', id: host, state: 'live' }])
  const target = targets[0]
  if (target.kind !== 'document') throw new Error('The original first document target survives the actual Main copy')
  assert.notEqual(target.id, replacement)
  await closeSyncedSourceReadOwner(value.owner)
}))

test('a delayed sealed F1 opening ACK cannot prove independent F2', async () => withHistoryMain(async api => {
  const value = await opened(api), sent = deferred<SyncedGroupSaved>(), delivered = deferred<SyncedGroupSaved>()
  api.deliver = async ack => { sent.resolve(ack); return delivered.promise }
  const flushing = value.binding.flush(), ack = await sent.promise
  let secondOwner: Awaited<ReturnType<typeof sourceOwner>> | null = null
  try {
    richPrefix(value, 'second ', 'independent F2')
    const second = sourceSession(value.binding); secondOwner = await sourceOwner(second)
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'waiting-original-ack')
    assert.equal((await adoptSyncedSourceOpening(secondOwner)).status, 'waiting-original-ack')
    assert.deepEqual(value.reads.operations, [])
    delivered.resolve(ack); await flushing
    const first = adopted(await adoptSyncedSourceOpening(value.owner))
    assert.deepEqual(first.facts.snapshot, ack.snapshot)
    assert.notDeepEqual(syncedCanonicalEdits(first.facts.snapshot.blocks), value.binding.getCurrent().working)
    assert.equal((await adoptSyncedSourceOpening(secondOwner)).status, 'waiting-original-ack')
    assert.equal((await registerSyncedSourceHistorySide({ checkpoint: second.checkpoint, side: first.side })).status, 'unavailable')
    api.deliver = async next => next
    assert.equal(await value.binding.flush(), true)
    const later = adopted(await adoptSyncedSourceOpening(secondOwner))
    assert.deepEqual(later.facts.snapshot, snapshot(api.db)); assert.equal(api.writes.length, 2)
  } finally { delivered.resolve(ack); await flushing; await closeSyncedSourceReadOwner(value.owner); if (secondOwner) await closeSyncedSourceReadOwner(secondOwner) }
}))

test('replacing an unsealed opening FrameVersion rejects it even when the same whole W later ACKs', async () => withHistoryMain(async api => {
  const value = await opened(api), working = value.binding.getCurrent().working[0].content
  richContent(value, working + '!', 'Rich transaction is not a Main operation UUID')
  richContent(value, working, 'Rich transaction is not a Main operation UUID')
  assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable')
  assert.equal(await value.binding.flush(), true)
  assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable')
  assert.deepEqual(value.reads.operations, [], 'No latest or equal-body ACK is guessed for the retired version')
  const fresh = sourceSession(value.binding), freshOwner = await sourceOwner(fresh)
  adopted(await adoptSyncedSourceOpening(freshOwner))
  await closeSyncedSourceReadOwner(value.owner); await closeSyncedSourceReadOwner(freshOwner)
}))

test('a local net return preserves an already ACKed original opening proof without blessing the fresh baseline', async () => withHistoryMain(async api => {
  const value = await opened(api, { flushFirst: true }), content = value.binding.getCurrent().working[0].content
  richContent(value, content + '!', 'temporary frame'); richContent(value, content, 'temporary frame')
  assert.equal(value.binding.getCurrent().dirty, false)
  adopted(await adoptSyncedSourceOpening(value.owner))
  const fresh = sourceSession(value.binding), owner = await sourceOwner(fresh)
  assert.equal((await adoptSyncedSourceOpening(owner)).status, 'unavailable', 'An equal new baseline is not an original content opening')
  await closeSyncedSourceReadOwner(owner); await closeSyncedSourceReadOwner(value.owner)
}))

test('opening adoption distinguishes an actual unknown operation from an unavailable original Main owner', async () => {
  for (const kind of ['unknown', 'released'] as const) await withHistoryMain(async api => {
    const value = await opened(api, { flushFirst: true })
    if (kind === 'unknown') api.db.prepare('DELETE FROM synced_operations WHERE client_operation_id=?').run(api.writes[0].clientOperationId)
    else releaseSyncedReadOwner(api.db, { readOwnerId: value.reads.captures[0].readOwnerId })
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, kind === 'unknown' ? 'unknown-operation' : 'owner-unavailable')
    assert.deepEqual(api.lookups, []); assert.equal(api.writes.length, 1)
    await closeSyncedSourceReadOwner(value.owner)
  })
})

test('the complete opening ACK handshake rejects altered status operation snapshot metadata target and history', async () => {
  const changes: Array<[string, (ack: SyncedGroupSaved) => void]> = [
    ['status', ack => { ack.status = 'noop' }], ['operation', ack => { ack.operationId = randomUUID() }],
    ['replayed', ack => { ack.replayed = false }], ['creation', ack => { ack.snapshot.creationId = randomUUID() }],
    ['birth', ack => { ack.snapshot.createdAt = '2001-01-01T00:00:00.000Z' }],
    ['origin', ack => { ack.snapshot.origin.pathAtCreation = 'Elsewhere/Origin' }],
    ['origin document', ack => { ack.snapshot.origin.documentId = other }],
    ['origin first instance', ack => { ack.snapshot.origin.firstInstanceId = randomUUID() }],
    ['revision', ack => { ack.snapshot.revision = randomUUID() }], ['topology', ack => { ack.snapshot.topologyRevision = randomUUID() }],
    ['body', ack => { ack.snapshot.blocks[0].content += 'changed' }],
    ['block type', ack => { ack.snapshot.blocks[0].type = 'heading1' }],
    ['block metadata', ack => { ack.snapshot.blocks[0].tags = ['different'] }], ['block birth', ack => { ack.snapshot.blocks[0].createdAt = '2002-01-01T00:00:00.000Z' }],
    ['target', ack => { ack.snapshot.bindings[0].target = { kind: 'document', id: host, state: 'live' } }],
    ['instance', ack => { ack.snapshot.instances[0].bindingVersion = randomUUID() }],
    ['instance identity', ack => { ack.snapshot.instances[0].instanceId = randomUUID() }],
    ['instance host', ack => { ack.snapshot.instances[0].hostDocumentId = other }],
    ['history', ack => { ack.snapshot.history.cursor = randomUUID() }],
    ['history tail', ack => { ack.snapshot.history.redoToken = randomUUID() }],
    ['depth budget', ack => { ack.snapshot.maxRelativeDepth++ }]
  ]
  for (const [label, change] of changes) await withHistoryMain(async api => {
    const wire = transport(api), value = await opened(api, { flushFirst: true, port: wire })
    wire.delivery.read = async result => {
      if (result.status !== 'committed') throw new Error('The negative response starts from the actual original durable operation')
      const next = structuredClone(result); change(next.result); return next
    }
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable', label)
    assert.deepEqual(value.reads.operations, [api.writes[0].clientOperationId], label)
    await closeSyncedSourceReadOwner(value.owner)
  })
})

test('opening source entries require closed UUID and exact physical Key coverage', async () => {
  const mutations: Array<[string, (value: Extract<OperationResult, { status: 'committed' }>) => void]> = [
    ['ticket', value => { value.bindingSource.ticketId = 'invalid' }], ['entry', value => { value.bindingSource.entries[0].entryId = 'invalid' }],
    ['duplicate entry', value => { value.bindingSource.entries[1].entryId = value.bindingSource.entries[0].entryId }],
    ['duplicate key', value => { value.bindingSource.entries[1].key = structuredClone(value.bindingSource.entries[0].key) }],
    ['missing key', value => { value.bindingSource.entries.pop() }],
    ['different block', value => { value.bindingSource.entries[0].key.blockId = 'another child' }],
    ['different from', value => { value.bindingSource.entries[0].key.from++ }],
    ['different to', value => { value.bindingSource.entries[0].key.to++ }],
    ['different raw', value => { value.bindingSource.entries[0].key.raw += ' ' }],
    ['different syntax', value => { value.bindingSource.entries[0].key.syntax = 'wiki' }],
    ['open key', value => { Object.assign(value.bindingSource.entries[0].key, { target: 'caller choice' }) }]
  ]
  for (const [label, mutate] of mutations) await withHistoryMain(async api => {
    const wire = transport(api), value = await opened(api, { flushFirst: true, port: wire })
    wire.delivery.read = async result => {
      if (result.status !== 'committed') throw new Error('The malformed source starts from the original Main operation')
      const next = structuredClone(result); mutate(next); return next
    }
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable', label)
    await closeSyncedSourceReadOwner(value.owner)
  })
})

test('full equal Main data after recovery or a connection replacement cannot revive the opening owner', async () => {
  for (const kind of ['epoch', 'connection'] as const) await withHistoryMain(async api => {
    const value = await opened(api, { flushFirst: true }), original = api.db, before = snapshot(api.db)
    let next: Database.Database | null = null
    try {
      if (kind === 'epoch') api.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
      else { next = new Database(original.name); next.pragma('foreign_keys=ON'); api.db = next }
      assert.deepEqual(snapshot(api.db), before)
      assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'owner-unavailable', kind)
    } finally { api.db = original; await closeSyncedSourceReadOwner(value.owner); next?.close() }
  })
})

test('opening requests reject edits scope callbacks reload rebind disposal and close across the real Main operation await', async () => {
  for (const action of ['edit', 'reload', 'rebind', 'dispose', 'close', 'scope-close'] as const) await withHistoryMain(async api => {
    const wire = transport(api), value = await opened(api, { flushFirst: true, port: wire }), entered = deferred<void>(), gate = deferred<void>()
    wire.delivery.read = async result => { entered.resolve(); await gate.promise; return result }
    const pending = adoptSyncedSourceOpening(value.owner); await entered.promise
    let closing: Promise<void> | null = null, rebound: ReturnType<typeof value.controller.bind> | null = null, scopeCalls = 0
    try {
      if (action === 'edit') richContent(value, value.binding.getCurrent().working[0].content + '!', 'during read')
      else if (action === 'reload') await value.workspace.load([groupId])
      else if (action === 'rebind') rebound = value.controller.bind(value.scope)
      else if (action === 'dispose') value.binding.dispose()
      else if (action === 'close') closing = closeSyncedSourceReadOwner(value.owner)
      else value.callout(() => { if (!scopeCalls++) closing = closeSyncedSourceReadOwner(value.owner) })
      gate.resolve(); assert.equal((await pending).status, 'unavailable', action)
      if (action === 'scope-close') assert.ok(scopeCalls > 0, 'The real post-response scope callback actually closed this opening owner')
    } finally { gate.resolve(); await pending; if (closing) await closing; else await closeSyncedSourceReadOwner(value.owner); rebound?.dispose() }
  })
})

test('loaded opening wrappers capture immediately and close revokes before queued operation continuations', async () => {
  for (const action of ['edit', 'close'] as const) await withHistoryMain(async api => {
    const value = await opened(api, { flushFirst: true }), before = value.reads.operations.length
    const pending = adoptSyncedSourceOpening(value.owner)
    assert.equal(value.reads.operations.length, before + 1, 'The loaded public wrapper enters the real query before returning its Promise')
    let closing: Promise<void> | null = null
    if (action === 'edit') richContent(value, value.binding.getCurrent().working[0].content + '!', 'immediate')
    else closing = closeSyncedSourceReadOwner(value.owner)
    assert.equal((await pending).status, 'unavailable', action)
    if (closing) await closing; else await closeSyncedSourceReadOwner(value.owner)
  })
})

test('the final opening grammar callback cannot mutate an earlier parse identity and still adopt', async () => withHistoryMain(async api => {
  const wire = transport(api), value = await opened(api, { flushFirst: true, port: wire }), parse = markdownEngine.parse
  const option = Object.keys(markdownEngine.options).at(-1)
  assert.ok(option, 'The actual Markdown options have a final configurable value')
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
  wire.delivery.read = async result => { armed = true; return result }
  try {
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable')
    assert.equal(installed, true, 'The getter is installed by the real final scope callback after response collection')
    assert.equal(mutations, 1, 'The final grammar getter actually changed the earlier sampled parse function')
  } finally { armed = false; Object.defineProperty(markdownEngine.options, option, descriptor); markdownEngine.parse = parse; await closeSyncedSourceReadOwner(value.owner) }
}))

test('collector reentry accepting another Rich frame invalidates the opening request fence', async () => {
  const parse = markdownEngine.parse
  let armed = false, mutations = 0, reenter = () => {}
  markdownEngine.parse = (...args: Parameters<typeof parse>) => {
    const tokens = parse.apply(markdownEngine, args)
    if (armed) { armed = false; mutations++; reenter() }
    return tokens
  }
  try { await withHistoryMain(async api => {
    const wire = transport(api), value = await opened(api, { flushFirst: true, port: wire })
    reenter = () => richContent(value, value.binding.getCurrent().working[0].content + '!', 'collector reentry')
    wire.delivery.read = async result => { armed = true; return result }
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable')
    assert.equal(mutations, 1, 'The actual post-response parser accepted a nested local edit')
    assert.equal(api.writes.length, 1, 'The nested Rich edit stayed local')
    await closeSyncedSourceReadOwner(value.owner)
  }) } finally { armed = false; markdownEngine.parse = parse }
})

test('opening provenance cannot be forged or reassigned through an accepted handle or another checkpoint', async () => withHistoryMain(async api => {
  const value = await opened(api, { flushFirst: true })
  assert.equal((await adoptSyncedSourceOpening({ ...value.owner })).status, 'unavailable')
  assert.equal((await adoptSyncedAcceptedSource(value.owner, { kind: 'accepted-source-checkpoint' } as AcceptedSourceCheckpoint)).status, 'unavailable')
  assert.deepEqual(value.reads.operations, [])
  const first = adopted(await adoptSyncedSourceOpening(value.owner)), second = sourceSession(value.binding), owner = await sourceOwner(second)
  assert.equal((await registerSyncedSourceHistorySide({ checkpoint: second.checkpoint, side: first.side })).status, 'unavailable')
  assert.equal(readAdoptedSourceSide({ ...first.side }), null)
  assert.equal((await registerSyncedSourceHistorySide({ checkpoint: value.opening.checkpoint, side: { ...first.side } })).status, 'unavailable')
  assert.equal(value.reads.operations.length, 1)
  await closeSyncedSourceReadOwner(value.owner); await closeSyncedSourceReadOwner(owner)
}))

test('initial and actual history baselines remain outside this content-opening slice', async () => withHistoryMain(async api => {
  const initial = await setup(api), firstOwner = await sourceOwner(initial.source)
  adopted(await adoptSyncedSourceBaseline(firstOwner))
  assert.equal((await adoptSyncedSourceOpening(firstOwner)).status, 'unavailable')
  richPrefix(initial); assert.equal(await initial.binding.flush(), true)
  const content = sourceSession(initial.binding), owner = await sourceOwner(content)
  assert.equal(await initial.binding.undo(), true, 'The actual persisted content has a real server Undo ACK')
  assert.equal((await adoptSyncedSourceOpening(owner)).status, 'unavailable', 'History expired the old content Endpoint')
  const history = sourceSession(initial.binding), historyOwner = await sourceOwner(history)
  assert.equal((await adoptSyncedSourceBaseline(historyOwner)).status, 'unavailable', 'B2 cannot borrow the original full B1 proof')
  assert.equal((await adoptSyncedSourceOpening(historyOwner)).status, 'unavailable', 'No history receipt is invented by this content-only API')
  assert.deepEqual(initial.reads.operations, [])
  await closeSyncedSourceReadOwner(firstOwner); await closeSyncedSourceReadOwner(owner); await closeSyncedSourceReadOwner(historyOwner)
}))

test('late first mailbox read after disposal retains the original ACK without granting opening adoption', async () => withHistoryMain(async api => {
  const value = await opened(api), diagnostic = captureSyncedWorkingEndpoint(value.binding)
  assert.ok(diagnostic, 'The diagnostic capability names the original real Rich working view')
  const sent = deferred<SyncedGroupSaved>(), release = deferred<SyncedGroupSaved>()
  api.deliver = async ack => { sent.resolve(ack); return release.promise }
  const flushing = value.binding.flush(), ack = await sent.promise
  try {
    value.binding.dispose(); release.resolve(ack); await flushing
    const receipt = readSyncedWorkingEndpointCommitted(diagnostic)
    assert.ok(receipt, 'The original version records its ACK even when the first diagnostic read is after disposal')
    assert.deepEqual(readSyncedCommittedEndpoint(receipt)?.ack, ack)
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable')
    assert.deepEqual(value.reads.operations, [])
  } finally { release.resolve(ack); await flushing; await closeSyncedSourceReadOwner(value.owner) }
}))

test('opening ACK proves the complete canonical W including metadata rather than just its Markdown text', async () => withHistoryMain(async api => {
  const value = await setup(api), before = value.binding.getCurrent()
  const blocks = before.working.map(block => ({ ...block, type: 'todo', checked: true, tags: ['opening-tag'],
    highlight: 'yellow', markdownFormat: { listMarker: '-' as const, listLoose: true } }))
  const bindingClaims = currentKeys(value).map(source => ({ kind: 'continue' as const, source, destination: { ...source } }))
  assert.equal(value.binding.apply({ expectedEditSequence: before.editSequence,
    guards: { groupId, expectedRevision: before.snapshot.revision, expectedTopologyRevision: before.snapshot.topologyRevision },
    blocks, bindingClaims, transactionId: 'complete W metadata', bookmark: null }), true)
  const opening = sourceSession(value.binding), owner = await sourceOwner(opening)
  try {
    assert.equal((await adoptSyncedSourceOpening(owner)).status, 'waiting-original-ack')
    assert.deepEqual(value.reads.operations, [])
    assert.equal(await value.binding.flush(), true)
    const proof = adopted(await adoptSyncedSourceOpening(owner))
    assert.deepEqual(syncedCanonicalEdits(proof.facts.snapshot.blocks), blocks)
    assert.deepEqual(proof.facts.snapshot.blocks[0].tags, ['opening-tag'])
    assert.equal(proof.facts.snapshot.blocks[0].checked, true)
    assert.equal(proof.facts.snapshot.blocks[0].highlight, 'yellow')
    assert.deepEqual(proof.facts.snapshot.blocks[0].markdownFormat, { listMarker: '-', listLoose: true })
  } finally { await closeSyncedSourceReadOwner(owner) }
}))

test('a lost transport ACK is not an opening proof until the actual pending operation lookup settles its mailbox', async () => withHistoryMain(async api => {
  const value = await opened(api)
  api.deliver = async () => { throw new Error('The real Main commit succeeded but its first ACK was lost in transport') }
  assert.equal(await value.binding.flush(), false)
  assert.equal(api.writes.length, 1)
  const operationId = api.writes[0].clientOperationId
  assert.deepEqual(snapshot(api.db).blocks.map(block => block.content), value.binding.getCurrent().working.map(block => block.content),
    'The original writer really committed before its transport failed')
  assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'waiting-original-ack')
  assert.deepEqual(value.reads.operations, [])
  assert.deepEqual(api.lookups, [])
  assert.equal(api.writes.length, 1, 'Adoption cannot retry or flush the uncertain writer')
  assert.equal(await value.binding.flush(), true)
  assert.deepEqual(api.lookups, [operationId], 'Only the real controller pending lookup settles the original operation')
  assert.equal(api.writes.length, 1, 'A found original operation is never resubmitted as a new write')
  const proof = adopted(await adoptSyncedSourceOpening(value.owner))
  assert.ok(proof.facts.committed, 'The original uncertain version acquired its actual mailbox receipt')
  assert.equal(readSyncedCommittedEndpoint(proof.facts.committed)?.ack.operationId, operationId)
  assert.deepEqual(value.reads.operations, [operationId])
  await closeSyncedSourceReadOwner(value.owner)
}))

test('pending-prefix net return preserves F1 provenance only for the actual same FrameVersion', async () => withHistoryMain(async api => {
  const value = await opened(api), sent = deferred<SyncedGroupSaved>(), gate = deferred<SyncedGroupSaved>()
  api.deliver = async ack => { sent.resolve(ack); return gate.promise }
  const flushing = value.binding.flush(), ack = await sent.promise
  let freshOwner: Awaited<ReturnType<typeof sourceOwner>> | null = null
  try {
    const content = value.binding.getCurrent().working[0].content
    richContent(value, content + '!', 'pending-prefix tail')
    richContent(value, content, 'pending-prefix tail')
    const endpoint = captureSyncedWorkingEndpoint(value.binding)
    assert.ok(endpoint, 'The actual prefix-return working endpoint is registered')
    const current = readSyncedWorkingEndpoint(endpoint)
    assert.ok(current.status === 'available' && current.kind === 'content', 'The canceled F2 tail returns to the still-pending actual F1 version')
    const fresh = sourceSession(value.binding); freshOwner = await sourceOwner(fresh)
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'waiting-original-ack')
    assert.equal((await adoptSyncedSourceOpening(freshOwner)).status, 'waiting-original-ack')
    assert.deepEqual(value.reads.operations, [])
    gate.resolve(ack); assert.equal(await flushing, true)
    const original = adopted(await adoptSyncedSourceOpening(value.owner))
    assert.deepEqual(original.facts.snapshot, ack.snapshot)
    const prefix = adopted(await adoptSyncedSourceOpening(freshOwner))
    assert.deepEqual(prefix.facts.snapshot, ack.snapshot)
    assert.ok(original.facts.committed && prefix.facts.committed, 'Both actual same-version openings have original F1 receipts')
    const firstReceipt = readSyncedCommittedEndpoint(original.facts.committed), prefixReceipt = readSyncedCommittedEndpoint(prefix.facts.committed)
    assert.ok(firstReceipt && prefixReceipt, 'Each original endpoint has a real immutable mailbox receipt')
    assert.equal(firstReceipt.submittedEditSequence, prefixReceipt.submittedEditSequence)
    assert.notEqual(firstReceipt.acceptedEditSequence, prefixReceipt.acceptedEditSequence, 'Accepted prefix sequence is not guessed from equal text')
    assert.deepEqual(value.reads.operations, [ack.operationId, ack.operationId])
    assert.equal(api.writes.length, 1, 'The canceled tail adds no independent Main operation')
  } finally { gate.resolve(ack); await flushing; await closeSyncedSourceReadOwner(value.owner); if (freshOwner) await closeSyncedSourceReadOwner(freshOwner) }
}))

test('an already resolved operation Promise cannot outrun immediate close or release its last owner before read completion', async () => withHistoryMain(async api => {
  const wire = transport(api), value = await opened(api, { flushFirst: true, port: wire })
  const entered = deferred<OperationResult>(), gate = deferred<OperationResult>()
  wire.delivery.read = result => { entered.resolve(result); return gate.promise }
  const pending = adoptSyncedSourceOpening(value.owner), actual = await entered.promise
  let closing: Promise<void> | null = null
  try {
    assert.equal(actual.status, 'committed', 'The held response is the actual original owned Main operation')
    // Removing the group retain makes final release timing an independent oracle.
    await value.workspace.load([groupId])
    assert.deepEqual(value.reads.releases, [])
    gate.resolve(actual)
    closing = closeSyncedSourceReadOwner(value.owner)
    assert.deepEqual(value.reads.releases, [], 'The still-running query retains its original Main owner')
    assert.equal((await pending).status, 'unavailable')
    await closing
    assert.deepEqual(value.reads.releases, [value.reads.captures[0].readOwnerId], 'The final request releases exactly its original Main owner')
    assert.equal(value.reads.captures.length, 1, 'Reload and delayed close do not issue a replacement owned capture')
    assert.equal((await adoptSyncedSourceOpening(value.owner)).status, 'unavailable')
  } finally { gate.resolve(actual); await pending; if (closing) await closing; else await closeSyncedSourceReadOwner(value.owner) }
}))
