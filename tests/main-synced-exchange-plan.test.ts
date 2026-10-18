import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedGroupWire, SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import type { SyncedPortableHostRecord } from '../src/shared/syncedBlockPortable'
import type { SyncDatabases } from '../src/main/sync/model'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { validateSyncedProtocol5Snapshot, type SyncedProtocol5Record, type SyncedProtocol5Snapshot } from '../src/main/sync/synced-protocol5-model'
import type { ExchangeState } from '../src/main/sync/synced-exchange-model'
import { planSyncedExchange, type ExchangePlanInput, type ExchangePlanIdentity } from '../src/main/sync/synced-exchange-plan'

const uuid = (n: number): string => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const localScope = uuid(1), remoteScope = uuid(2), groupId = uuid(3), instanceId = uuid(5)
const now = '2026-10-18T00:00:00.000Z', born = '2020-01-01T00:00:00.000Z', localBirth = '2021-01-01T00:00:00.000Z'
const hash = (value: unknown): string => publicationHash(publicationJson(value))
const block = (id: string, content = id): SyncedStableBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })
function host(id: string, blocks = [block(id + '-body')]): SyncedPortableHostRecord {
  return { kind: 'document', id, parentId: null, sortOrder: 0, createdAt: born, content: { title: id, summary: '', blocks } }
}
const ref = (): SyncedStableBlockDraft => ({ ...block(instanceId), type: 'synced-block', content: JSON.stringify({ version: 1, groupId }) })
const group = (content = 'shared'): SyncedGroupWire => ({ kind: 'synced-group', id: groupId, creationId: uuid(4), createdAt: born,
  origin: { version: 1, documentId: 'Host', pathAtCreation: 'Host', firstInstanceId: instanceId },
  blocks: [{ ...block('shared-body', content), createdAt: born }], bindings: [] })
const catalog = (): SyncDatabases => ({ kind: 'databases', id: 'databases', tables: {
  databases: [{ id: 'catalog', name: 'Default', description: '', created_at: born }], document_database_columns: [], database_saved_views: [],
  database_entities: [], database_entity_values: [], document_database_values: [] } })
const key = (r: SyncedProtocol5Record): string => r.kind === 'databases' ? 'databases' : r.kind === 'synced-group' || r.kind === 'synced-group-deleted' ? 'group:' + r.id : 'doc:' + r.id
function snapshot(records: SyncedProtocol5Record[], workspaceId: string): SyncedProtocol5Snapshot {
  const values = records.map(record => ({ key: key(record), record })), entries = Object.fromEntries(values.map(v => [v.key, hash(v.record)]))
  const syncedInstances = records.flatMap(r => r.kind === 'document' ? r.content.blocks.filter(b => b.type === 'synced-block').map(b => {
    const id = (JSON.parse(b.content) as { groupId: string }).groupId
    return { documentId: r.id, instanceId: b.id, groupId: id, groupHash: entries['group:' + id] }
  }) : []).sort((a, b) => a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : a.instanceId < b.instanceId ? -1 : 1)
  return validateSyncedProtocol5Snapshot({ version: 5, workspaceId, entries, syncedInstances }, values)
}
function identities(local: SyncedProtocol5Snapshot): ExchangePlanIdentity[] {
  return local.records.flatMap(({ record }) => {
    if (record.kind !== 'document' && record.kind !== 'synced-group') return []
    const kind = record.kind === 'document' ? 'document' as const : 'group' as const
    const row = (id: string, created_at: string): ExchangePlanIdentity => ({ id, last_owner_kind: kind,
      last_owner_id: record.id, state: 'live', created_at })
    return record.kind === 'document' ? record.content.blocks.map(b => row(b.id, localBirth)) : record.blocks.map(b => row(b.id, b.createdAt))
  })
}
function input(base: SyncedProtocol5Record[], l = base, r = base): ExchangePlanInput {
  const local = snapshot(l, localScope), remote = snapshot(r, remoteScope), ancestor = snapshot(base, remoteScope)
  const state: ExchangeState = { kind: 'synced-exchange-state', version: 1, databasePath: '/isolated/storage/knowbook.db',
    targetFingerprint: hash('target'), workspaceScope: localScope, recoveryEpoch: uuid(8), remoteWorkspaceId: remoteScope, generation: uuid(9), currentOperationId: null,
    source: { kind: 'confirmed-publication', operationId: uuid(7), manifestHash: hash(ancestor.manifest), portableDigest: hash(ancestor.manifest.entries) },
    baseline: ancestor.records.map(v => ({ key: v.key, localHash: v.hash, remoteHash: v.hash, commonHash: v.hash,
      dependencyKeys: [], dependencySignature: hash([]), acceptedOperationId: uuid(7) })), deferred: [], lastSyncAt: now }
  return { operationId: uuid(6), local, remote, baseRecords: ancestor.records, state, localFingerprint: hash('current-capture'),
    authority: { catalogId: 'local-catalog', identities: identities(local), occupiedDocumentIds: local.records.filter(v => v.record.kind === 'document').map(v => (v.record as SyncedPortableHostRecord).id),
      historyComponents: [], pinnedGroupIds: [], knownGroupIds: local.records.filter(v => v.record.kind === 'synced-group').map(v => (v.record as SyncedGroupWire).id) } }
}
const base = (): SyncedProtocol5Record[] => [host('Host', [block('host-body'), ref()]), group(), host('Independent'), catalog()]
const edit = (records: SyncedProtocol5Record[], wanted: string, text: string): SyncedProtocol5Record[] => records.map(r => {
  if (key(r) !== wanted) return r
  if (r.kind === 'document') return { ...r, content: { ...r.content, blocks: r.content.blocks.map((b, i) => i === 0 ? { ...b, content: text } : b) } }
  if (r.kind === 'synced-group') return { ...r, blocks: r.blocks.map((b, i) => i === 0 ? { ...b, content: text } : b) }
  throw new Error('The oracle edits only an existing live body')
})

test('exchange planner produces two complete simultaneous graphs for independent outbound and inbound edits', () => {
  const b = base(), value = input(b, edit(b, 'doc:Independent', 'local change'), edit(b, 'group:' + groupId, 'remote change'))
  const plan = planSyncedExchange(value)
  assert.deepEqual(plan.writes, ['doc:Independent']); assert.deepEqual(plan.incoming, ['group:' + groupId]); assert.deepEqual(plan.deferred, [])
  assert.equal(plan.nextRemote.manifest.workspaceId, remoteScope); assert.equal(plan.localFinal.manifest.workspaceId, localScope)
  assert.equal(plan.localFinal.manifest.entries['doc:Independent'], value.local.manifest.entries['doc:Independent'])
  assert.equal(plan.nextRemote.manifest.entries['group:' + groupId], value.remote.manifest.entries['group:' + groupId])
  assert.deepEqual(plan.nextRemote.manifest.entries, plan.localFinal.manifest.entries)
  assert.equal(plan.localFinal.manifest.entries['doc:Host'], value.local.manifest.entries['doc:Host'])
  assert.deepEqual(plan.historyBoundaryKeys, ['group:' + groupId])
  assert.equal(plan.nextRemote.manifest.syncedInstances[0].groupHash, plan.nextRemote.manifest.entries['group:' + groupId])
})

test('exchange planner defers the complete shared component while an unrelated outbound document really advances', () => {
  const b = base(), l = edit(edit(b, 'group:' + groupId, 'local shared'), 'doc:Independent', 'independent local'), r = edit(b, 'group:' + groupId, 'remote shared')
  const value = input(b, l, r), plan = planSyncedExchange(value)
  assert.deepEqual(plan.writes, ['doc:Independent']); assert.deepEqual(plan.incoming, [])
  assert.equal(plan.deferred.length, 1); assert.deepEqual(plan.deferred[0].keys, ['doc:Host', 'group:' + groupId]); assert.equal(plan.deferred[0].reason, 'diverged')
  for (const k of plan.deferred[0].keys) {
    assert.equal(plan.localFinal.manifest.entries[k], value.local.manifest.entries[k]); assert.equal(plan.nextRemote.manifest.entries[k], value.remote.manifest.entries[k])
    assert.deepEqual(plan.nextBaseline.find(v => v.key === k), value.state.baseline.find(v => v.key === k))
  }
  assert.equal(plan.nextBaseline.find(v => v.key === 'doc:Independent')?.commonHash, value.local.manifest.entries['doc:Independent'])
})

test('exchange planner proves paired ordinary to canonical transfer and adopts actual selected wire birth', () => {
  const b = [host('Host', [block('shared-body')]), host('Independent'), catalog()], r = [host('Host', [ref()]), group(), host('Independent'), catalog()]
  const value = input(b, b, r), plan = planSyncedExchange(value)
  assert.deepEqual(plan.deferred, []); assert.deepEqual(plan.writes, []); assert.deepEqual(plan.incoming, ['doc:Host', 'group:' + groupId])
  assert.deepEqual(plan.transfers, [{ id: 'shared-body', fromKind: 'document', fromId: 'Host', fromCreatedAt: localBirth,
    toKind: 'group', toId: groupId, toCreatedAt: born }])
  const accepted = plan.localFinal.records.find(v => v.key === 'group:' + groupId)?.record
  assert.ok(accepted?.kind === 'synced-group', 'The complete actual canonical candidate exists in the accepted graph')
  assert.equal(accepted.blocks[0].createdAt, born)
  assert.equal((plan.localFinal.records.find(v => v.key === 'doc:Host')?.record as SyncedPortableHostRecord).content.blocks.some(v => v.id === 'shared-body'), false)
})

test('exchange planner keeps complete transfer components deferred when their releasing side also diverged', () => {
  const b = [host('Host', [block('shared-body')]), host('Independent'), catalog()], r = [host('Host', [ref()]), group(), host('Independent'), catalog()]
  const value = input(b, edit(edit(b, 'doc:Host', 'local ownership edit'), 'doc:Independent', 'independent'), r), plan = planSyncedExchange(value)
  assert.deepEqual(plan.writes, ['doc:Independent']); assert.deepEqual(plan.incoming, []); assert.deepEqual(plan.transfers, [])
  assert.deepEqual(plan.deferred[0].keys, ['doc:Host', 'group:' + groupId]); assert.equal(plan.deferred[0].reason, 'diverged')
  assert.equal(Object.hasOwn(plan.localFinal.manifest.entries, 'group:' + groupId), false)
})

test('exchange planner retains historical baseline edges when the ancestor object is missing', () => {
  const b = base(), value = input(b, edit(edit(b, 'doc:Host', 'local host'), 'doc:Independent', 'independent'), edit(b, 'doc:Host', 'remote host'))
  const h = value.state.baseline.find(v => v.key === 'doc:Host')!, u = value.state.baseline.find(v => v.key === 'doc:Independent')!
  h.dependencyKeys = ['doc:Independent']; u.dependencyKeys = ['doc:Host']
  value.baseRecords = value.baseRecords.filter(v => v.key !== 'doc:Host')
  const plan = planSyncedExchange(value)
  assert.deepEqual(plan.writes, []); assert.deepEqual(plan.incoming, [])
  assert.deepEqual(plan.deferred[0].keys, ['doc:Host', 'doc:Independent', 'group:' + groupId]); assert.equal(plan.deferred[0].reason, 'baseline-missing')
})

test('exchange planner rejects a forged per-key ancestor and preserves caller snapshots and authority data', () => {
  const value = input(base()), before = structuredClone(value)
  planSyncedExchange(value); assert.deepEqual(value, before)
  const forged = structuredClone(value); forged.baseRecords[0].hash = hash('invented common object')
  assert.throws(() => planSyncedExchange(forged), 'Original common bytes must match the authenticated original key hash')
})

test('exchange planner exact semantic equality has no outgoing incoming transfer or executable history boundary', () => {
  const b = base(), same = edit(b, 'group:' + groupId, 'both actually reached the same content'), plan = planSyncedExchange(input(b, same, same))
  assert.deepEqual(plan.writes, []); assert.deepEqual(plan.incoming, []); assert.deepEqual(plan.transfers, []); assert.deepEqual(plan.historyBoundaryKeys, [])
  assert.deepEqual(plan.deferred, []); assert.equal(plan.nextBaseline.find(v => v.key === 'group:' + groupId)?.commonHash, hash(group('both actually reached the same content')))
})

test('exchange planner legal group tombstone and surviving-reference conflict retain both sides and spare independent edits', () => {
  const b = base(), l = edit(b, 'doc:Independent', 'independent'), remoteRecords: SyncedProtocol5Record[] = [host('Host', [block('host-body')]), host('Independent'), catalog(),
    { kind: 'synced-group-deleted', id: groupId, creationId: uuid(4), previousHash: hash(group()), deletedAt: now }]
  const value = input(b, l, remoteRecords), plan = planSyncedExchange(value)
  assert.deepEqual(plan.writes, ['doc:Independent']); assert.deepEqual(plan.incoming, []); assert.equal(plan.deferred[0].reason, 'tombstone')
  assert.deepEqual(plan.deferred[0].keys, ['doc:Host', 'group:' + groupId])
  assert.equal(plan.localFinal.records.find(v => v.key === 'group:' + groupId)?.record.kind, 'synced-group')
  assert.equal(plan.nextRemote.records.find(v => v.key === 'group:' + groupId)?.record.kind, 'synced-group-deleted')
  assert.deepEqual(plan.nextBaseline.find(v => v.key === 'group:' + groupId), value.state.baseline.find(v => v.key === 'group:' + groupId))
})

test('exchange planner selected canonical wire birth has an explicit guarded transfer even under the same owner', () => {
  const b = base(), incoming = b.map(r => r.kind === 'synced-group' ? { ...r, blocks: r.blocks.map(child => ({ ...child, createdAt: now })) } : r)
  const plan = planSyncedExchange(input(b, b, incoming))
  assert.deepEqual(plan.deferred, []); assert.deepEqual(plan.incoming, ['group:' + groupId])
  assert.deepEqual(plan.transfers, [{ id: 'shared-body', fromKind: 'group', fromId: groupId, fromCreatedAt: born,
    toKind: 'group', toId: groupId, toCreatedAt: now }])
})

test('exchange planner does not promote an unproven retained reservation by its owner spelling or a remote live body', () => {
  const b = [host('Host'), host('Independent'), catalog()], r = [host('Host', [block('Host-body'), ref()]), group(), host('Independent'), catalog()]
  const value = input(b, edit(b, 'doc:Independent', 'independent'), r)
  value.authority = { ...value.authority, identities: [...value.authority.identities, {
    id: 'shared-body', last_owner_kind: 'reserved', last_owner_id: groupId, state: 'retained', created_at: null }] }
  const plan = planSyncedExchange(value)
  assert.deepEqual(plan.writes, ['doc:Independent']); assert.deepEqual(plan.incoming, []); assert.deepEqual(plan.transfers, [])
  assert.equal(plan.deferred[0].reason, 'unknown-birth'); assert.deepEqual(plan.deferred[0].keys, ['doc:Host', 'group:' + groupId])
  assert.equal(Object.hasOwn(plan.localFinal.manifest.entries, 'group:' + groupId), false)
})

test('exchange planner defers a mixed parent cycle while preserving an independently valid outgoing component', () => {
  const b = [host('A'), host('B'), host('Independent'), catalog()]
  const l = edit(b.map(r => r.kind === 'document' && r.id === 'A' ? { ...r, parentId: 'B' } : r), 'doc:Independent', 'independent')
  const r = b.map(r => r.kind === 'document' && r.id === 'B' ? { ...r, parentId: 'A' } : r)
  const value = input(b, l, r), plan = planSyncedExchange(value)
  assert.deepEqual(plan.writes, ['doc:Independent']); assert.deepEqual(plan.incoming, [])
  assert.equal(plan.deferred.length, 1); assert.deepEqual(plan.deferred[0].keys, ['doc:A', 'doc:B'])
  assert.equal(plan.deferred[0].reason, 'dependency')
  for (const k of ['doc:A', 'doc:B']) {
    assert.equal(plan.localFinal.manifest.entries[k], value.local.manifest.entries[k])
    assert.equal(plan.nextRemote.manifest.entries[k], value.remote.manifest.entries[k])
    assert.deepEqual(plan.nextBaseline.find(v => v.key === k), value.state.baseline.find(v => v.key === k))
  }
  assert.equal(plan.localFinal.manifest.entries['doc:Independent'], plan.nextRemote.manifest.entries['doc:Independent'])
})

test('exchange planner defers independent canonical and ordinary claims of one new ID without rejecting unrelated work', () => {
  const b = [...base(), host('Collision')], id = 'independently-chosen-new-id'
  const l = edit(b.map(r => r.kind === 'document' && r.id === 'Collision' ? { ...r, content: {
    ...r.content, blocks: [...r.content.blocks, block(id, 'local ordinary')] } } : r), 'doc:Independent', 'independent')
  const r = b.map(r => r.kind === 'synced-group' ? { ...r, blocks: [...r.blocks, { ...block(id, 'remote canonical'), createdAt: born }] } : r)
  const value = input(b, l, r), plan = planSyncedExchange(value)
  assert.deepEqual(plan.writes, ['doc:Independent']); assert.deepEqual(plan.incoming, [])
  assert.equal(plan.deferred.length, 1); assert.equal(plan.deferred[0].reason, 'owner-source')
  assert.deepEqual(plan.deferred[0].keys, ['doc:Collision', 'doc:Host', 'group:' + groupId])
  for (const k of plan.deferred[0].keys) {
    assert.equal(plan.localFinal.manifest.entries[k], value.local.manifest.entries[k])
    assert.equal(plan.nextRemote.manifest.entries[k], value.remote.manifest.entries[k])
    assert.deepEqual(plan.nextBaseline.find(v => v.key === k), value.state.baseline.find(v => v.key === k))
  }
})
