import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedGroupWire, SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import type { SyncedPortableHostRecord } from '../src/shared/syncedBlockPortable'
import { publicationCompare, publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { syncedProtocol5RecordKey, validateSyncedProtocol5Snapshot, type SyncedProtocol5Record, type SyncedProtocol5Snapshot } from '../src/main/sync/synced-protocol5-model'
import { planSyncedKnowledgeConflicts, deriveKnowledgeBothComponents } from '../src/main/sync/synced-exchange-knowledge-plan'
import { knowledgeSourceHash, validateKnowledgeSource, validateKnowledgeComponentFence, type KnowledgePlanInput } from '../src/main/sync/synced-exchange-knowledge-model'

// Pure graph fixtures only. These references do not claim to mint Main proofs or write authority.
const uuid = (value: number): string => '10000000-0000-0000-0000-' + String(value).padStart(12, '0')
const scope = uuid(1), remoteScope = uuid(2), groupId = uuid(3), groupKey = 'group:' + groupId
const originId = ' accepted deleted Origin ', originKey = 'doc:' + originId, uId = ' independent U ', uKey = 'doc:' + uId
const born = '2020-01-01T00:00:00.000Z', now = '2026-10-18T00:00:00.000Z', canonical = 'actual canonical id'
const hash = (value: unknown): string => publicationHash(publicationJson(value))
const clone = <T,>(value: T): T => structuredClone(value)
const paragraph = (id: string, content: string): SyncedStableBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })
const doc = (id: string, title: string, text: string): SyncedPortableHostRecord => ({ kind: 'document', id, parentId: null, sortOrder: 0,
  createdAt: born, content: { title, summary: '', blocks: [paragraph('block:' + id, text)] } })
const group = (text: string): SyncedGroupWire => ({ kind: 'synced-group', id: groupId, creationId: uuid(4), createdAt: born,
  origin: { version: 1, documentId: originId, pathAtCreation: 'Original Origin', firstInstanceId: uuid(5) },
  blocks: [{ ...paragraph(canonical, text), createdAt: born }], bindings: [] })
const tombstone: SyncedProtocol5Record = { kind: 'deleted', id: originId }
function snapshot(records: SyncedProtocol5Record[], workspaceId: string): SyncedProtocol5Snapshot {
  return validateSyncedProtocol5Snapshot({ version: 5, workspaceId,
    entries: Object.fromEntries(records.map(record => [syncedProtocol5RecordKey(record), hash(record)])), syncedInstances: [] },
  records.map(record => ({ key: syncedProtocol5RecordKey(record), record })))
}
function fixture(): KnowledgePlanInput {
  const catalog: SyncedProtocol5Record = { kind: 'databases', id: 'databases', tables: {
    databases: [{ id: 'catalog', name: 'Default', description: '', created_at: born }], document_database_columns: [],
    database_saved_views: [], database_entities: [], database_entity_values: [], document_database_values: [] } }
  const ancestor = [tombstone, group('base'), doc(uId, 'Independent', 'common U'), catalog]
  const local = [group('LOCAL'), doc(uId, 'Independent', 'common U'), catalog]
  const right = [tombstone, group('REMOTE'), doc(uId, 'Independent', 'common U'), catalog]
  const proof = { key: originKey, tombstoneHash: hash(tombstone), deletionOperationId: uuid(20), intentHash: hash('original deletion intent') }
  const original = snapshot(ancestor, remoteScope)
  return { operationId: uuid(10), localPhysical: snapshot(local, scope), localKnowledge: snapshot([tombstone, ...local], scope),
    remote: snapshot(right, remoteScope), baseRecords: original.records, localFingerprint: hash('actual whole capture'),
    state: { kind: 'synced-exchange-state', version: 2, databasePath: '/isolated/storage/knowbook.db', targetFingerprint: hash('same target'),
      workspaceScope: scope, recoveryEpoch: uuid(11), remoteWorkspaceId: remoteScope, generation: uuid(12), currentOperationId: uuid(20),
      source: { kind: 'current-equality', operationId: null, manifestHash: hash(original.manifest), portableDigest: hash(original.manifest.entries) },
      baseline: original.records.map(row => ({ key: row.key,
        local: row.key === originKey ? { kind: 'absent' as const, tombstoneHash: proof.tombstoneHash, deletionOperationId: proof.deletionOperationId, intentHash: proof.intentHash } : { kind: 'live' as const, hash: row.hash },
        remoteHash: row.hash, commonHash: row.hash, dependencyKeys: row.key === groupKey ? [originKey] : row.key === originKey ? [groupKey] : [],
        dependencySignature: hash(['original accepted signature', row.key]), acceptedOperationId: uuid(20) })), deferred: [], lastSyncAt: now },
    authority: { catalogId: 'catalog', identities: [
      { id: canonical, last_owner_kind: 'group', last_owner_id: groupId, state: 'live', created_at: born },
      { id: 'block:' + uId, last_owner_kind: 'document', last_owner_id: uId, state: 'live', created_at: born },
      { id: 'block:' + originId, last_owner_kind: 'document', last_owner_id: originId, state: 'retained', created_at: born }],
      occupiedDocumentIds: [originId, uId], historyComponents: [], pinnedGroupIds: [], knownGroupIds: [groupId],
      keyGuards: original.records.map(row => ({ key: row.key, fingerprint: hash(['actual key guard', row.key]) })),
      deletedFacts: [proof], deletionProofReferences: [{ ...proof, proofHash: hash('actual immutable marker row'), anchorId: 'synced:logical-deletion:v1:original' }], pins: [] } }
}
function component(input: KnowledgePlanInput) {
  const preview = planSyncedKnowledgeConflicts(input).conflictPreviews.find(row => row.keys.includes(groupKey))
  assert.ok(preview, 'A live conflict remains observable in the full Origin dependency component')
  return preview
}
function body(plan: ReturnType<typeof planSyncedKnowledgeConflicts>): string {
  const row = plan.localPhysicalFinal.records.find(row => row.key === groupKey)
  assert.ok(row?.record.kind === 'synced-group', 'The selected result is an actual live group wire')
  return row.record.blocks[0].content
}
function carried(input: KnowledgePlanInput, plan: ReturnType<typeof planSyncedKnowledgeConflicts>): void {
  assert.equal(publicationJson(plan.nextBaseline.find(row => row.key === originKey)), publicationJson(input.state.baseline.find(row => row.key === originKey)))
  assert.equal(plan.accepted.includes(originKey), false)
  assert.equal(plan.acceptedSides.some(row => row.key === originKey), false)
  assert.equal(plan.localPhysicalFinal.records.some(row => row.key === originKey), false)
  assert.equal(plan.localKnowledgeFinal.manifest.entries[originKey], hash(tombstone))
  assert.equal(plan.nextRemote.manifest.entries[originKey], hash(tombstone))
  assert.equal(Object.hasOwn(plan, 'deletions'), false)
}

test('knowledge pure preview preserves a fixed deleted Origin in the full selectable live component', () => {
  const input = fixture(), before = clone(input), preview = component(input), plan = planSyncedKnowledgeConflicts(input)
  assert.deepEqual(preview.keys, [originKey, groupKey].sort(publicationCompare))
  assert.deepEqual(preview.choices, ['local', 'remote', 'merge'])
  assert.equal(preview.records.find(row => row.key === originKey)?.merge, null)
  const fence = plan.componentFences.find(row => row.keys.includes(groupKey))
  assert.ok(fence, 'The private fence authenticates the same whole component')
  assert.deepEqual(fence.mutableKeys, [groupKey]); assert.deepEqual(fence.fixedDenialKeys, [originKey])
  assert.equal(fence.fixedDenials[0].baselineHash, hash(input.state.baseline.find(row => row.key === originKey)))
  assert.deepEqual(input, before); carried(input, plan)
})
for (const choice of ['local', 'remote'] as const) test('knowledge pure ' + choice + ' choice changes the live subset while carrying every original absent field', () => {
  const input = fixture(), preview = component(input)
  input.conflictSelections = [{ preview, decision: { componentId: preview.componentId, choice } }]
  const plan = planSyncedKnowledgeConflicts(input)
  assert.deepEqual(plan.deferred, []); assert.equal(body(plan), choice === 'local' ? 'LOCAL' : 'REMOTE')
  assert.equal(plan.accepted.includes(groupKey), true); carried(input, plan)
})

test('knowledge pure custom merge preserves text whitespace and never asks the fixed denial for a selector', () => {
  const input = fixture(), preview = component(input), record = preview.records.find(row => row.key === groupKey)
  assert.ok(record?.merge && record.merge.unresolved.length > 0, 'The actual common ancestor produces an unresolved live text part')
  assert.ok(record.merge.unresolved.every(part => part.canEditText), 'Only real editable text parts receive custom text')
  input.conflictSelections = [{ preview, decision: { componentId: preview.componentId, choice: 'merge', records: [{ key: groupKey,
    parts: record.merge.unresolved.map(part => ({ id: part.id, value: { choice: 'custom', text: '  preserved custom body  ' } })) }] } }]
  const plan = planSyncedKnowledgeConflicts(input)
  assert.deepEqual(plan.deferred, []); assert.equal(body(plan), '  preserved custom body  '); carried(input, plan)
})

test('knowledge pure remote resurrection blocks its whole Origin component while independent ordinary progress remains real', () => {
  const input = fixture(), records = input.remote.records.map(row => row.key === originKey ? doc(originId, 'Original Origin', 'attempted resurrection') : row.record)
  input.remote = snapshot(records, remoteScope)
  input.localPhysical = snapshot(input.localPhysical.records.map(row => row.key === uKey ? doc(uId, 'Independent', 'LOCAL outgoing U') : row.record), scope)
  input.localKnowledge = snapshot([tombstone, ...input.localPhysical.records.map(row => row.record)], scope)
  const plan = planSyncedKnowledgeConflicts(input), blocked = component(input)
  assert.deepEqual(blocked.choices, []); assert.deepEqual(plan.deferred.find(row => row.keys.includes(groupKey))?.keys, [originKey, groupKey].sort(publicationCompare))
  assert.equal(plan.accepted.includes(groupKey), false); assert.equal(plan.accepted.includes(uKey), true)
  assert.equal(plan.nextRemote.manifest.entries[uKey], input.localPhysical.manifest.entries[uKey])
  assert.equal(plan.localKnowledgeFinal.manifest.entries[originKey], hash(tombstone))
  assert.equal(plan.localPhysicalFinal.records.some(row => row.key === originKey), false)
  assert.deepEqual(plan.nextBaseline.find(row => row.key === originKey), input.state.baseline.find(row => row.key === originKey))
})

test('knowledge pure changed-back component guard invalidates an old choice without rewriting fixed absence', () => {
  const input = fixture(), old = component(input), guard = input.authority.keyGuards?.find(row => row.key === groupKey)
  assert.ok(guard, 'The independent negative changes an actual private guard rather than the wire text')
  guard.fingerprint = hash('same wire after real raw cursor change')
  input.conflictSelections = [{ preview: old, decision: { componentId: old.componentId, choice: 'local' } }]
  const plan = planSyncedKnowledgeConflicts(input)
  assert.equal(plan.accepted.includes(groupKey), false); assert.equal(body(plan), 'LOCAL')
  assert.ok(plan.deferred.some(row => row.keys.includes(groupKey)), 'The original full component choice cannot borrow a new private guard')
  carried(input, plan)
})

test('knowledge pure independent U drift preserves an unchanged whole-component choice', () => {
  const input = fixture(), old = component(input)
  input.localFingerprint = hash('new global capture from independent U')
  input.localPhysical = snapshot(input.localPhysical.records.map(row => row.key === uKey ? doc(uId, 'Independent', 'later U') : row.record), scope)
  input.localKnowledge = snapshot([tombstone, ...input.localPhysical.records.map(row => row.record)], scope)
  const guard = input.authority.keyGuards?.find(row => row.key === uKey); assert.ok(guard, 'The independent U has its own captured guard'); guard.fingerprint = hash('later U guard')
  input.conflictSelections = [{ preview: old, decision: { componentId: old.componentId, choice: 'remote' } }]
  const plan = planSyncedKnowledgeConflicts(input)
  assert.deepEqual(plan.deferred, []); assert.equal(body(plan), 'REMOTE'); assert.equal(plan.accepted.includes(uKey), true); carried(input, plan)
})

test('knowledge pure both derivation keeps the original fixed denial in its outer component and excludes it from fork sources', () => {
  const input = fixture(), facts = deriveKnowledgeBothComponents(input), fact = facts.find(row => row.component.keys.includes(groupKey))
  assert.ok(fact, 'The both description derives its component from the full actual knowledge graph')
  assert.deepEqual(fact.component.keys, [originKey, groupKey].sort(publicationCompare)); assert.deepEqual(fact.mutableKeys, [groupKey])
  assert.deepEqual(fact.fixedDenialKeys, [originKey]); assert.deepEqual(fact.conflictedKeys, [groupKey])
  assert.equal(fact.reason, null, 'An ordinary live divergence is the reason to offer both rather than a hard denial')
  assert.ok(fact.selectedOriginal, 'The retained original is a complete strict candidate graph including fixed denial')
  assert.equal(fact.selectedOriginal.manifest.entries[originKey], hash(tombstone))
})

test('knowledge pure source decoder authenticates complete original absence fields and rejects extra or swapped provenance', () => {
  const source = planSyncedKnowledgeConflicts(fixture()).knowledgeSource
  assert.equal(knowledgeSourceHash(source), hash(source))
  assert.throws(() => validateKnowledgeSource({ ...source, deletions: [] }), 'The new private source has a finite closed shape')
  const swapped = clone(source); swapped.absentBaseline[0].acceptedOperationId = uuid(99)
  assert.notEqual(knowledgeSourceHash(swapped), knowledgeSourceHash(source), 'Even an otherwise well-formed accepted operation substitution changes the original preimage hash')
  const forged = clone(source); if (forged.absentBaseline[0].local.kind === 'absent') forged.absentBaseline[0].local.intentHash = hash('different intent')
  assert.throws(() => validateKnowledgeSource(forged), 'The accepted absent row must join its exact original denial reference')
})

test('knowledge pure fence decoder rejects omitted denial keys overlapping partitions and reused proof anchors', () => {
  const plan = planSyncedKnowledgeConflicts(fixture()), fence = plan.componentFences.find(row => row.keys.includes(groupKey))
  assert.ok(fence, 'The negative controls begin with the real complete fixed/live partition')
  assert.throws(() => validateKnowledgeComponentFence({ ...fence, fixedDenialKeys: [] }), 'The full component cannot omit its fixed denial')
  assert.throws(() => validateKnowledgeComponentFence({ ...fence, mutableKeys: fence.keys }), 'Fixed and mutable source sets cannot overlap')
  const source = clone(plan.knowledgeSource), extra = { ...source.deleted[0], key: 'doc:another absent fact' }
  source.deleted.push(extra); source.deleted.sort((a, b) => publicationCompare(a.key, b.key))
  assert.throws(() => validateKnowledgeSource(source), 'Separate deleted keys cannot reuse one immutable denial anchor')
})
