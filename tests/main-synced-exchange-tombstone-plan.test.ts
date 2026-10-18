import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedGroupWire, SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import type { SyncedPortableHostRecord } from '../src/shared/syncedBlockPortable'
import type { SyncDatabases } from '../src/main/sync/model'
import { publicationCompare, publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { parseSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { syncedProtocol5RecordKey, validateSyncedProtocol5Snapshot,
  type SyncedProtocol5Record, type SyncedProtocol5Snapshot } from '../src/main/sync/synced-protocol5-model'
import type { ExchangePlanIdentity } from '../src/main/sync/synced-exchange-plan'
import { planSyncedTombstoneExchange } from '../src/main/sync/synced-exchange-tombstone-plan'
import type { TombstoneDeletedFact, TombstonePlanInput } from '../src/main/sync/synced-exchange-tombstone-types'

const uuid = (n: number): string => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const scope = uuid(1), peer = uuid(2), groupId = uuid(3), creationId = uuid(4), instanceId = uuid(5)
const nextGroupId = uuid(6), nextCreationId = uuid(7), nextFirstInstanceId = uuid(8)
const operationId = uuid(9), previousOperationId = uuid(10)
const documentId = ' source:doc ', independentId = ' independent:doc '
const ordinaryId = ' source:ordinary ', canonicalId = ' canonical:body ', independentBlockId = ' independent:body '
const documentKey = 'doc:' + documentId, independentKey = 'doc:' + independentId, groupKey = 'group:' + groupId
const born = '2020-01-01T00:00:00.000Z', localOrdinaryBorn = '2026-01-01T00:00:00.000Z'
const selectedCanonicalBorn = '2024-01-01T00:00:00.000Z', now = '2026-10-18T00:00:00.000Z'
const digest = (value: unknown): string => publicationHash(publicationJson(value))
const clone = <T,>(value: T): T => structuredClone(value)
const paragraph = (id: string, content = id): SyncedStableBlockDraft => ({ id, type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null })
const reference = (): SyncedStableBlockDraft => ({ ...paragraph(instanceId), type: 'synced-block',
  content: JSON.stringify({ version: 1, groupId }) })
const host = (id: string, title: string, blocks: SyncedStableBlockDraft[]): SyncedPortableHostRecord => ({
  kind: 'document', id, parentId: null, sortOrder: 0, createdAt: born, content: { title, summary: '', blocks }
})
const group = (): SyncedGroupWire => ({ kind: 'synced-group', id: groupId, creationId, createdAt: born,
  origin: { version: 1, documentId, pathAtCreation: 'Source', firstInstanceId: instanceId },
  blocks: [{ ...paragraph(canonicalId, 'base canonical'), createdAt: born }], bindings: [] })
const catalog = (): SyncDatabases => ({ kind: 'databases', id: 'databases', tables: {
  databases: [{ id: 'catalog', name: 'Default', description: '', created_at: born }], document_database_columns: [],
  database_saved_views: [], database_entities: [], database_entity_values: [], document_database_values: []
} })
const base = (): SyncedProtocol5Record[] => [host(documentId, 'Source', [paragraph(ordinaryId)]), group(),
  host(independentId, 'Independent', [paragraph(independentBlockId)]), catalog()]

function snapshot(records: SyncedProtocol5Record[], workspaceId: string): SyncedProtocol5Snapshot {
  const rows = records.map(record => ({ key: syncedProtocol5RecordKey(record), record }))
  const entries = Object.fromEntries(rows.map(row => [row.key, digest(row.record)]))
  const syncedInstances: SyncedProtocol5Snapshot['manifest']['syncedInstances'] = []
  for (const record of records) if (record.kind === 'document') for (const block of record.content.blocks) {
    if (block.type !== 'synced-block') continue
    const actualGroup = parseSyncedBlockPayload(block.content).groupId
    const groupHash = entries['group:' + actualGroup]
    assert.ok(groupHash, 'The fixture gives each actual live reference its exact live group record')
    syncedInstances.push({ documentId: record.id, instanceId: block.id, groupId: actualGroup, groupHash })
  }
  syncedInstances.sort((a, b) => publicationCompare(a.documentId, b.documentId) || publicationCompare(a.instanceId, b.instanceId))
  return validateSyncedProtocol5Snapshot({ version: 5, workspaceId, entries, syncedInstances }, rows)
}
function entry(value: SyncedProtocol5Snapshot, key: string): SyncedProtocol5Snapshot['records'][number] {
  const result = value.records.find(row => row.key === key)
  assert.ok(result, 'The fixture or result contains the exact requested record key')
  return result
}
function tombstone(records: SyncedProtocol5Record[]): SyncedProtocol5Record {
  const previous = records.find(record => record.kind === 'synced-group' && record.id === groupId)
  assert.ok(previous?.kind === 'synced-group', 'A group tombstone fixture has a real complete live predecessor')
  return { kind: 'synced-group-deleted', id: groupId, creationId: previous.creationId, previousHash: digest(previous), deletedAt: now }
}
function replace(records: SyncedProtocol5Record[], key: string, record: SyncedProtocol5Record): SyncedProtocol5Record[] {
  assert.equal(syncedProtocol5RecordKey(record), key, 'A fixture replacement keeps its original exact record key')
  return records.map(row => syncedProtocol5RecordKey(row) === key ? record : clone(row))
}
function edit(records: SyncedProtocol5Record[], key: string, text: string): SyncedProtocol5Record[] {
  return records.map(record => {
    if (syncedProtocol5RecordKey(record) !== key) return clone(record)
    if (record.kind === 'document') return { ...clone(record), content: { ...record.content,
      blocks: record.content.blocks.map((block, index) => index === 0 ? { ...block, content: text } : clone(block)) } }
    if (record.kind === 'synced-group') return { ...clone(record), blocks: record.blocks.map((block, index) => index === 0 ? { ...block, content: text } : clone(block)) }
    throw new Error('The fixture edits only an explicitly live body')
  })
}
function identities(local: SyncedProtocol5Snapshot): ExchangePlanIdentity[] {
  return local.records.flatMap(({ record }) => {
    if (record.kind !== 'document' && record.kind !== 'synced-group') return []
    const ownerKind = record.kind === 'document' ? 'document' as const : 'group' as const
    const row = (id: string, createdAt: string): ExchangePlanIdentity => ({ id, last_owner_kind: ownerKind,
      last_owner_id: record.id, state: 'live', created_at: createdAt })
    return record.kind === 'document' ? record.content.blocks.map(block => row(block.id, localOrdinaryBorn))
      : record.blocks.map(block => row(block.id, block.createdAt))
  })
}
function input(original: SyncedProtocol5Record[], left = original,
  right = replace(original, groupKey, tombstone(original))): TombstonePlanInput {
  const ancestor = snapshot(original, peer), local = snapshot(left, scope), remote = snapshot(right, peer)
  const hasOriginPair = ancestor.manifest.entries[groupKey] !== undefined && ancestor.manifest.entries[documentKey] !== undefined
  const dependencies = (key: string): string[] => hasOriginPair && key === documentKey ? [groupKey]
    : hasOriginPair && key === groupKey ? [documentKey] : []
  return { operationId, localPhysical: local, localKnowledge: snapshot(left, scope), remote, baseRecords: ancestor.records,
    localFingerprint: digest('actual private fixture capture'),
    state: { kind: 'synced-exchange-state', version: 2, databasePath: '/isolated/storage/knowbook.db', targetFingerprint: digest('same target'),
      workspaceScope: scope, recoveryEpoch: uuid(11), remoteWorkspaceId: peer, generation: uuid(12), currentOperationId: null,
      source: { kind: 'current-equality', operationId: null, manifestHash: digest(ancestor.manifest), portableDigest: digest(ancestor.manifest.entries) },
      baseline: ancestor.records.map(row => ({ key: row.key, local: { kind: 'live', hash: row.hash }, remoteHash: row.hash,
        commonHash: row.hash, dependencyKeys: dependencies(row.key),
        dependencySignature: digest([row.key, row.hash, dependencies(row.key)]), acceptedOperationId: previousOperationId })),
      deferred: [], lastSyncAt: now },
    authority: { catalogId: 'catalog', identities: identities(local), occupiedDocumentIds: left.flatMap(record => record.kind === 'document' ? [record.id] : []),
      historyComponents: [], pinnedGroupIds: [], knownGroupIds: left.flatMap(record => record.kind === 'synced-group' ? [record.id] : []),
      keyGuards: ancestor.records.map(row => ({ key: row.key, fingerprint: digest(['real capture row', row.key, row.hash]) })),
      deletedFacts: [], pins: [] } }
}
function expectIndependentOutbound(value: TombstonePlanInput, plan: ReturnType<typeof planSyncedTombstoneExchange>): void {
  assert.deepEqual(plan.writes, [independentKey])
  assert.equal(plan.nextRemote.manifest.entries[independentKey], value.localPhysical.manifest.entries[independentKey])
  assert.equal(plan.localPhysicalFinal.manifest.entries[independentKey], value.localPhysical.manifest.entries[independentKey])
  assert.equal(plan.deferred.some(component => component.keys.includes(independentKey)), false)
}

test('tombstone pure planner separates exact group absence from durable knowledge and retains its old identity', () => {
  const value = input(base()), before = clone(value), plan = planSyncedTombstoneExchange(value)
  assert.deepEqual(value, before)
  assert.deepEqual(plan.deferred, []); assert.deepEqual(plan.writes, []); assert.deepEqual(plan.incoming, [groupKey])
  assert.equal(Object.hasOwn(plan.localPhysicalFinal.manifest.entries, groupKey), false)
  assert.equal(entry(plan.localKnowledgeFinal, groupKey).record.kind, 'synced-group-deleted')
  assert.equal(plan.localPhysicalFinal.manifest.entries[documentKey], value.localPhysical.manifest.entries[documentKey])
  assert.equal(plan.localPhysicalFinal.records.some(row => row.record.kind === 'synced-group'), false)
  assert.deepEqual(plan.localPhysicalFinal.manifest.syncedInstances, [])
  assert.equal(plan.deletions.length, 1)
  const intent = plan.deletions[0], effect = intent.identities[0]
  assert.equal(intent.baseLiveHash, value.state.baseline.find(row => row.key === groupKey)?.commonHash)
  assert.equal(intent.tombstoneHash, entry(value.remote, groupKey).hash)
  assert.deepEqual(effect, { before: { id: canonicalId, last_owner_kind: 'group', last_owner_id: groupId, state: 'live', created_at: born }, after: { kind: 'retained' } })
  assert.deepEqual(plan.acceptedSides.find(row => row.key === groupKey)?.local,
    { kind: 'absent', tombstoneHash: intent.tombstoneHash, deletionOperationId: operationId, intentHash: intent.intentHash })
})

test('tombstone pure planner rejects a wrong previous hash by component while an independent outbound record advances', () => {
  const b = base(), dead = tombstone(b)
  assert.ok(dead.kind === 'synced-group-deleted', 'The negative changes only a real group tombstone predecessor hash')
  const value = input(b, edit(b, independentKey, 'independent local'), replace(b, groupKey, { ...dead, previousHash: digest('not the real B') }))
  const plan = planSyncedTombstoneExchange(value)
  expectIndependentOutbound(value, plan)
  assert.deepEqual(plan.deferred.map(row => ({ keys: row.keys, reason: row.reason })), [{ keys: [documentKey, groupKey], reason: 'tombstone' }])
  assert.equal(plan.localPhysicalFinal.manifest.entries[groupKey], value.localPhysical.manifest.entries[groupKey])
  assert.deepEqual(plan.deletions, [])
})

test('tombstone pure planner throws on a forged original B body hash without mutating the input', () => {
  const value = input(base()), before = clone(value)
  const forged = clone(value)
  forged.baseRecords = forged.baseRecords.map(row => row.key === groupKey ? { ...row, hash: digest('forged predecessor') } : row)
  assert.throws(() => planSyncedTombstoneExchange(forged), 'An original B row must match both its strict body and authenticated baseline hash')
  assert.deepEqual(value, before)
  const forgedSide = clone(value)
  entry(forgedSide.remote, groupKey).hash = digest('not the manifest body hash')
  assert.throws(() => planSyncedTombstoneExchange(forgedSide), 'An original remote side cannot supply a forged record hash')
})

test('tombstone pure planner preserves old dependency edges when the exact B object is missing', () => {
  const b = base(), value = input(b, edit(edit(b, groupKey, 'local changed canonical'), independentKey, 'independent local'))
  value.baseRecords = value.baseRecords.filter(row => row.key !== groupKey)
  value.authority.missingBaseKeys = [groupKey]
  const plan = planSyncedTombstoneExchange(value)
  expectIndependentOutbound(value, plan)
  assert.deepEqual(plan.deferred.map(row => ({ keys: row.keys, reason: row.reason })), [{ keys: [documentKey, groupKey], reason: 'baseline-missing' }])
  assert.deepEqual(plan.nextBaseline.find(row => row.key === groupKey), value.state.baseline.find(row => row.key === groupKey))
  assert.deepEqual(plan.deletions, [])
})

test('tombstone pure planner never grants an unknown first group tombstone while a separate live edit continues', () => {
  const b = base().filter(record => syncedProtocol5RecordKey(record) !== groupKey)
  const remote = [...clone(b), { kind: 'synced-group-deleted' as const, id: groupId, creationId, previousHash: digest('unknown historical group'), deletedAt: now }]
  const value = input(b, edit(b, independentKey, 'independent local'), remote), plan = planSyncedTombstoneExchange(value)
  expectIndependentOutbound(value, plan)
  assert.deepEqual(plan.deferred.map(row => ({ keys: row.keys, reason: row.reason })), [{ keys: [groupKey], reason: 'baseline-missing' }])
  assert.equal(plan.accepted.includes(groupKey), false); assert.deepEqual(plan.deletions, [])
  assert.equal(Object.hasOwn(plan.localKnowledgeFinal.manifest.entries, groupKey), false)
  assert.equal(plan.nextRemote.manifest.entries[groupKey], entry(value.remote, groupKey).hash)
})

test('tombstone pure planner preserves the original authenticated absent source without minting another deletion', () => {
  const b = base(), dead = tombstone(b), knowledge = replace(b, groupKey, dead), physical = b.filter(record => syncedProtocol5RecordKey(record) !== groupKey)
  const value = input(b, b, knowledge), fact: TombstoneDeletedFact = { key: groupKey, tombstoneHash: digest(dead),
    deletionOperationId: previousOperationId, intentHash: digest('actual previous accepted intent') }
  value.localKnowledge = snapshot(knowledge, scope); value.localPhysical = snapshot(physical, scope)
  value.authority.deletedFacts = [fact]
  value.authority.identities = value.authority.identities.map(row => row.id === canonicalId ? { ...row, state: 'retained' } : row)
  const old = value.state.baseline.find(row => row.key === groupKey)
  assert.ok(old, 'The existing absent baseline is addressed by its exact group key')
  old.local = { kind: 'absent', tombstoneHash: fact.tombstoneHash, deletionOperationId: fact.deletionOperationId, intentHash: fact.intentHash }
  old.remoteHash = fact.tombstoneHash; old.commonHash = fact.tombstoneHash
  value.baseRecords = snapshot(knowledge, peer).records
  const plan = planSyncedTombstoneExchange(value)
  assert.deepEqual(plan.deferred, []); assert.deepEqual(plan.incoming, []); assert.deepEqual(plan.deletions, [])
  assert.deepEqual(plan.acceptedSides.find(row => row.key === groupKey)?.local, old.local)
  const missingProof = clone(value); missingProof.authority.deletedFacts = []
  assert.throws(() => planSyncedTombstoneExchange(missingProof), 'Knowledge-only absence cannot replace the original durable deletion source')
  const swappedSource = clone(value)
  const swapped = swappedSource.state.baseline.find(row => row.key === groupKey)
  assert.ok(swapped?.local.kind === 'absent', 'The source-swapping negative changes a real absent baseline')
  swapped.local.deletionOperationId = uuid(99)
  assert.throws(() => planSyncedTombstoneExchange(swappedSource), 'The baseline must bind the original deletion operation rather than a fresh operation')
})

test('tombstone pure planner transfers a deleted canonical child to an ordinary owner with its original canonical birth', () => {
  const b = base(), remote = replace(replace(b, groupKey, tombstone(b)), independentKey,
    host(independentId, 'Independent', [paragraph(independentBlockId), paragraph(canonicalId, 'base canonical')]))
  const value = input(b, b, remote), plan = planSyncedTombstoneExchange(value)
  assert.deepEqual(plan.deferred, [])
  assert.deepEqual(plan.transfers, [{ id: canonicalId, fromKind: 'group', fromId: groupId, fromCreatedAt: born,
    toKind: 'document', toId: independentId, toCreatedAt: born }])
  assert.equal(Object.hasOwn(plan.localPhysicalFinal.manifest.entries, groupKey), false)
  const result = entry(plan.localPhysicalFinal, independentKey).record
  assert.ok(result.kind === 'document', 'The actual receiving ordinary owner exists in the complete final physical graph')
  assert.deepEqual(result.content.blocks.map(row => row.id), [independentBlockId, canonicalId])
  assert.deepEqual(plan.deletions[0].identities[0].after,
    { kind: 'transferred', ownerKind: 'document', ownerId: independentId, createdAt: born })
})

test('tombstone pure planner transfers a deleted ordinary child using local old birth and the exact selected canonical wire birth', () => {
  const b = base(), next: SyncedGroupWire = { kind: 'synced-group', id: nextGroupId, creationId: nextCreationId, createdAt: selectedCanonicalBorn,
    origin: { version: 1, documentId, pathAtCreation: 'Source', firstInstanceId: nextFirstInstanceId },
    blocks: [{ ...paragraph(ordinaryId), createdAt: selectedCanonicalBorn }], bindings: [] }
  const remote = [...replace(b, documentKey, { kind: 'deleted', id: documentId }), next]
  const value = input(b, b, remote), plan = planSyncedTombstoneExchange(value)
  assert.notEqual(localOrdinaryBorn, selectedCanonicalBorn)
  assert.deepEqual(plan.deferred, [])
  assert.deepEqual(plan.transfers, [{ id: ordinaryId, fromKind: 'document', fromId: documentId, fromCreatedAt: localOrdinaryBorn,
    toKind: 'group', toId: nextGroupId, toCreatedAt: selectedCanonicalBorn }])
  assert.equal(Object.hasOwn(plan.localPhysicalFinal.manifest.entries, documentKey), false)
  const result = entry(plan.localPhysicalFinal, 'group:' + nextGroupId).record
  assert.ok(result.kind === 'synced-group', 'The actual selected canonical owner exists in the complete final physical graph')
  assert.equal(result.blocks[0].createdAt, selectedCanonicalBorn)
  const deletion = plan.deletions.find(row => row.key === documentKey)
  assert.ok(deletion, 'The releasing document has a real deletion intent in the same accepted component')
  assert.deepEqual(deletion.identities[0].after,
    { kind: 'transferred', ownerKind: 'group', ownerId: nextGroupId, createdAt: selectedCanonicalBorn })
})

test('tombstone pure planner counts an unknown durable pin kind and preserves the complete deletion component', () => {
  const b = base(), value = input(b, edit(b, independentKey, 'independent local'))
  value.authority.pins = [{ groupId, kind: 'future:opaque pin', pinId: ' original:pin ', sourceHash: digest('original pin source') }]
  const plan = planSyncedTombstoneExchange(value)
  expectIndependentOutbound(value, plan)
  assert.deepEqual(plan.deferred.map(row => ({ keys: row.keys, reason: row.reason })), [{ keys: [documentKey, groupKey], reason: 'history-pin' }])
  assert.equal(plan.localPhysicalFinal.manifest.entries[groupKey], value.localPhysical.manifest.entries[groupKey])
  assert.deepEqual(plan.deletions, [])
})

test('tombstone pure planner includes the prospective host archive pin before accepting a paired host and group deletion', () => {
  const b = replace(base(), documentKey, host(documentId, 'Source', [paragraph(ordinaryId), reference()]))
  const remote = replace(replace(b, documentKey, { kind: 'deleted', id: documentId }), groupKey, tombstone(b))
  const value = input(b, edit(b, independentKey, 'independent local'), remote), plan = planSyncedTombstoneExchange(value)
  assert.deepEqual(value.authority.pins, [])
  expectIndependentOutbound(value, plan)
  assert.deepEqual(plan.deferred.map(row => ({ keys: row.keys, reason: row.reason })), [{ keys: [documentKey, groupKey], reason: 'history-pin' }])
  assert.equal(plan.localPhysicalFinal.manifest.entries[documentKey], value.localPhysical.manifest.entries[documentKey])
  assert.equal(plan.localPhysicalFinal.manifest.entries[groupKey], value.localPhysical.manifest.entries[groupKey])
  assert.deepEqual(plan.deletions, [])
})

test('tombstone pure planner defers delete versus a new actual live reference while an unrelated component advances', () => {
  const b = base(), left = replace(edit(b, independentKey, 'independent local'), documentKey,
    host(documentId, 'Source', [paragraph(ordinaryId), reference()]))
  const value = input(b, left), plan = planSyncedTombstoneExchange(value)
  expectIndependentOutbound(value, plan)
  assert.deepEqual(plan.deferred.map(row => ({ keys: row.keys, reason: row.reason })), [{ keys: [documentKey, groupKey], reason: 'dependency' }])
  assert.deepEqual(plan.localPhysicalFinal.manifest.syncedInstances, value.localPhysical.manifest.syncedInstances)
  assert.equal(plan.nextRemote.manifest.entries[groupKey], value.remote.manifest.entries[groupKey])
  assert.deepEqual(plan.deletions, [])
})

test('tombstone pure planner closes physical knowledge and component fences without converting them into deletion permission', () => {
  const b = base(), malformed = input(b)
  malformed.localKnowledge = snapshot(edit(b, documentKey, 'knowledge only edit'), scope)
  assert.throws(() => planSyncedTombstoneExchange(malformed), 'Live knowledge cannot disagree with the real physical projection')
  const value = input(b, edit(b, independentKey, 'independent local'))
  value.authority.deferredKeys = [groupKey]
  const plan = planSyncedTombstoneExchange(value)
  expectIndependentOutbound(value, plan)
  assert.deepEqual(plan.deferred.map(row => ({ keys: row.keys, reason: row.reason })), [{ keys: [documentKey, groupKey], reason: 'dependency' }])
  assert.equal(plan.accepted.includes(groupKey), false); assert.deepEqual(plan.deletions, [])
})
