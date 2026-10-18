import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedGroupWire, SyncedLinkTarget } from '../src/shared/synced-blocks'
import type { SyncedPortableHostRecord } from '../src/shared/syncedBlockPortable'
import { collectSyncedBindingOccurrences } from '../src/main/database/synced-block-links'
import { captureSyncedCreateSourceFacts } from '../src/main/database/synced-host-create-plan'
import { collectMarkdownSourceLinks } from '../src/shared/markdownLinks'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { validateSyncedProtocol5Snapshot, type SyncedProtocol5Record, type SyncedProtocol5Snapshot } from '../src/main/sync/synced-protocol5-model'
import { describeSyncedBothComponent, planSyncedBothFork } from '../src/main/sync/synced-exchange-fork'
import type { SyncedBothForkInput, SyncedBothOwnerSourceLinks, SyncedBothSourceKey } from '../src/main/sync/synced-exchange-both-types'
import type { SyncDatabases } from '../src/main/sync/model'

const id = (n: number) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const born = '2020-01-01T00:00:00.000Z', accepted = '2026-10-18T01:02:03.000Z'
const digest = (value: unknown) => publicationHash(publicationJson(value))
const D = id(1), G = id(2), C = id(3), I = id(4), B = ' ordinary/body:opaque ', F = id(20), FC = id(21), FIRST = id(22), CHILD = id(23), FI = id(24), COPY = id(30), COPYB = id(31), COPYI = id(32)
const catalog = (): SyncDatabases => ({ kind: 'databases', id: 'databases', tables: {
  databases: [{ id: 'catalog', name: 'Default', description: 'Default', created_at: born }],
  document_database_columns: [], database_saved_views: [], database_entities: [], database_entity_values: [], document_database_values: [] } })
function snapshot(records: SyncedProtocol5Record[], workspaceId = id(100)): SyncedProtocol5Snapshot {
  const groups = new Map(records.flatMap(record => record.kind === 'synced-group' ? [[record.id, digest(record)] as const] : []))
  const rows = records.map(record => ({ key: record.kind === 'databases' ? 'databases' : (record.kind === 'synced-group' || record.kind === 'synced-group-deleted' ? 'group:' : 'doc:') + record.id, record }))
  const syncedInstances = records.flatMap(record => record.kind === 'document' ? record.content.blocks.flatMap(child => child.type === 'synced-block' ? [{ documentId: record.id, instanceId: child.id, groupId: G, groupHash: groups.get(G)! }] : []) : [])
  return validateSyncedProtocol5Snapshot({ version: 5, workspaceId, entries: Object.fromEntries(rows.map(row => [row.key, digest(row.record)])), syncedInstances }, rows)
}
function sources(value: SyncedProtocol5Snapshot, targets = new Map<string, SyncedLinkTarget>()): SyncedBothOwnerSourceLinks[] {
  return value.records.flatMap(({ key: ownerKey, hash: recordHash, record }) => {
    if (record.kind !== 'document' && record.kind !== 'synced-group') return []
    const facts = captureSyncedCreateSourceFacts(record.kind === 'document' ? record.content.blocks : record.blocks.map(({ createdAt: _createdAt, ...draft }) => draft))
    const links: SyncedBothOwnerSourceLinks['links'] = facts.links.filter(link => !link.image).map(link => ({ key: { field: 'block' as const, ...link.key }, url: link.url,
      target: targets.get(publicationJson([ownerKey, link.key.blockId, link.key.from])) ?? { kind: 'document' as const, id: D, state: 'live' as const } }))
    if (record.kind === 'document') for (const link of collectMarkdownSourceLinks(record.content.summary)) if (link.kind !== 'image') links.push({
      key: { field: 'summary', blockId: null, from: link.start, to: link.end, raw: record.content.summary.slice(link.start, link.end), syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' }, url: link.url,
      target: targets.get(publicationJson([ownerKey, null, link.start])) ?? { kind: 'document', id: D, state: 'live' } })
    return [{ ownerKey, recordHash, path: record.kind === 'document' ? record.content.title : null, complete: true, links,
      images: facts.links.filter(link => link.image).map(link => ({ key: { field: 'block' as const, ...link.key }, url: link.url })) }]
  })
}
function input(options: { copied?: boolean; link?: boolean } = {}): SyncedBothForkInput {
  const doc: SyncedPortableHostRecord = { kind: 'document', id: D, createdAt: born, parentId: null, sortOrder: 0, content: { title: 'Host', summary: '', blocks: [
    { id: B, type: 'paragraph', content: '  local ordinary body  ', checked: false, depth: 0, parentBlockId: null },
    { id: I, type: 'synced-block', content: publicationJson({ version: 1, groupId: G }), checked: false, depth: 0, parentBlockId: null }] } }
  const text = options.link ? `[self](#%5E${encodeURIComponent(B)}) local` : 'local canonical'
  const group: SyncedGroupWire = { kind: 'synced-group', id: G, creationId: C, createdAt: born, origin: { version: 1, documentId: D, pathAtCreation: 'Host', firstInstanceId: I },
    blocks: [{ id: ' canonical:opaque ', type: 'paragraph', content: text, checked: false, depth: 0, parentBlockId: null, createdAt: born }], bindings: [] }
  if (options.link) group.bindings = collectSyncedBindingOccurrences(group.origin, group.blocks).map(({ url: _url, ...key }) => ({ ...key, target: { kind: 'block', id: B, documentId: D, state: 'live' } }))
  const remoteDoc = structuredClone(doc), remoteGroup = structuredClone(group)
  if (options.copied) remoteDoc.content.title = 'Remote host'
  remoteGroup.blocks[0].content += ' remote'
  const local = snapshot([doc, group, catalog()]), remote = snapshot([remoteDoc, remoteGroup, catalog()], id(101))
  const sourceTargets = new Map(group.bindings.map(binding => [publicationJson(['group:' + G, binding.blockId, binding.from]), binding.target]))
  const component = { componentId: digest('actual-component'), keys: ['databases', 'doc:' + D, 'group:' + G], localSignature: digest(local.manifest), remoteSignature: digest(remote.manifest), dependencySignature: digest('actual-dependencies') }
  return { local, remote, selectedOriginal: remote, conflictedKeys: ['group:' + G, ...(options.copied ? ['doc:' + D] : [])], component, sourceLinks: sources(local, sourceTargets),
    retainedLocal: local, retainedRemote: remote,
    decision: { componentId: component.componentId, copyDocumentIds: options.copied ? [D] : [], groups: [{ groupId: G, hosts: options.copied ? [{ sourceDocumentId: D, sourceInstanceId: I, destination: 'copied' }] : [] }] },
    allocation: { kind: 'synced-exchange-both-allocation', version: 1, previewId: id(80), allocatedAt: accepted,
      documents: [{ sourceDocumentId: D, documentId: COPY, createdAt: accepted, title: 'Host（本机分叉）', parentId: null, path: 'Host（本机分叉）' }],
      groups: [{ sourceGroupId: G, groupId: F, creationId: FC, createdAt: accepted, firstInstanceId: options.copied ? COPYI : FIRST }],
      blocks: [{ sourceOwnerKey: 'group:' + G, sourceBlockId: group.blocks[0].id, ownerKey: 'group:' + F, blockId: CHILD, createdAt: accepted },
        { sourceOwnerKey: 'doc:' + D, sourceBlockId: B, ownerKey: 'doc:' + COPY, blockId: COPYB, createdAt: accepted }],
      instances: [{ sourceDocumentId: D, sourceInstanceId: I, destination: 'existing', documentId: D, instanceId: FI, groupId: F, createdAt: accepted },
        { sourceDocumentId: D, sourceInstanceId: I, destination: 'copied', documentId: COPY, instanceId: COPYI, groupId: F, createdAt: accepted }], entities: [], missing: [] } }
}
function planned(value: SyncedBothForkInput) { const result = planSyncedBothFork(value); assert.equal(result.status, 'planned'); if (result.status !== 'planned') throw new Error('Expected a complete planned fork'); return result }
function getGroup(value: SyncedProtocol5Snapshot, groupId: string) { const record = value.records.find(row => row.key === 'group:' + groupId)?.record; assert.ok(record?.kind === 'synced-group', 'The exact intended group record is present'); return record }
function getDoc(value: SyncedProtocol5Snapshot, documentId: string) { const record = value.records.find(row => row.key === 'doc:' + documentId)?.record; assert.ok(record?.kind === 'document', 'The exact intended ordinary host record is present'); return record }

test('both pure description permits an active orphan fork without forcing an unchanged origin host copy', () => {
  const value = input(), result = describeSyncedBothComponent(value)
  assert.equal(result.status, 'eligible'); if (result.status !== 'eligible') throw new Error('Expected eligible source')
  assert.equal(result.copyDocuments.some(row => row.required), false)
  assert.deepEqual(result.groups.filter(row => row.required).map(row => row.sourceGroupId), [G])
  const final = planned(value)
  assert.equal(getGroup(final.nextRemote, G).blocks[0].content, 'local canonical remote')
  assert.equal(getGroup(final.nextRemote, F).blocks[0].content, 'local canonical')
  assert.equal(final.nextRemote.manifest.syncedInstances.some(row => row.groupId === F), false)
  assert.equal(getDoc(final.nextRemote, D).content.blocks[1].id, I)
})

test('both pure existing occurrence gets one fresh instance while the original group retains remote bytes', () => {
  const value = input(); value.decision.groups[0].hosts = [{ sourceDocumentId: D, sourceInstanceId: I, destination: 'existing' }]; value.allocation.groups[0].firstInstanceId = FI
  const final = planned(value), host = getDoc(final.nextRemote, D)
  assert.equal(host.content.blocks[1].id, FI)
  assert.deepEqual(JSON.parse(host.content.blocks[1].content), { version: 1, groupId: F })
  assert.equal(host.content.blocks[0].content, '  local ordinary body  ')
  assert.equal(getGroup(final.nextRemote, G).blocks[0].content, 'local canonical remote')
  assert.equal(final.fork.summary.groups.length, 1)
})

test('both pure copied document and canonical forest use complete fresh identity maps and fixed births', () => {
  const value = input({ copied: true }), original = publicationJson({ local: value.local.records, remote: value.remote.records, allocation: value.allocation }), result = planned(value)
  const copy = getDoc(result.nextRemote, COPY), fork = getGroup(result.nextRemote, F)
  assert.equal(getDoc(result.nextRemote, D).content.title, 'Remote host')
  assert.equal(copy.content.title, 'Host（本机分叉）'); assert.equal(copy.content.blocks[0].id, COPYB); assert.equal(copy.content.blocks[1].id, COPYI)
  assert.equal(copy.content.blocks[0].content, '  local ordinary body  ')
  assert.equal(copy.createdAt, accepted); assert.equal(fork.blocks[0].createdAt, accepted)
  assert.deepEqual(fork.origin, { version: 1, documentId: COPY, pathAtCreation: 'Host（本机分叉）', firstInstanceId: COPYI })
  assert.equal(publicationJson({ local: value.local.records, remote: value.remote.records, allocation: value.allocation }), original)
  assert.deepEqual(result.localFinal.manifest.entries, result.nextRemote.manifest.entries)
})

test('both pure canonical complete Key projection maps an internal ordinary target without URL lookup authority', () => {
  const result = planned(input({ copied: true, link: true })), fork = getGroup(result.nextRemote, F), binding = fork.bindings[0]
  assert.equal(binding.blockId, CHILD); assert.equal(binding.target.kind, 'block')
  if (binding.target.kind !== 'block') throw new Error('Expected exact block target')
  assert.equal(binding.target.id, COPYB); assert.equal(binding.target.documentId, COPY)
  assert.equal(fork.blocks[0].content.slice(binding.from, binding.to), binding.raw)
  assert.equal(result.projections.length, 1)
  assert.equal(result.projections[0].source.blockId, ' canonical:opaque ')
  assert.equal(result.projections[0].destination.blockId, CHILD)
})

test('both pure source known typed targets are not exchanged by equal URL spelling or source array order', () => {
  const value = input({ copied: true, link: true }), source = value.sourceLinks.find(row => row.ownerKey === 'group:' + G)!
  source.links[0].target = { kind: 'document', id: D, state: 'live' }
  assert.throws(() => planSyncedBothFork(value), /canonical typed target/)
})

test('both pure missing a required copy or its copied instance selector is invalid before a candidate exists', () => {
  const missingDoc = input({ copied: true }); missingDoc.decision.copyDocumentIds = []
  assert.throws(() => planSyncedBothFork(missingDoc), /强制doc copy/)
  const missingInstance = input({ copied: true }); missingInstance.decision.groups[0].hosts = []
  assert.throws(() => planSyncedBothFork(missingInstance), /必需fork occurrence/)
})

test('both pure accepts only complete authenticated source scopes and rejects a foreign canonical incarnation', () => {
  const incomplete = input(); incomplete.sourceLinks.find(row => row.ownerKey === 'group:' + G)!.complete = false
  assert.deepEqual(describeSyncedBothComponent(incomplete).status, 'blocked')
  const foreign = input(), records = foreign.remote.records.map(row => structuredClone(row.record))
  const group = records.find(record => record.kind === 'synced-group')!
  if (group.kind !== 'synced-group') throw new Error('Expected group')
  group.creationId = id(70); foreign.remote = snapshot(records, id(101)); foreign.selectedOriginal = foreign.remote
  const result = describeSyncedBothComponent(foreign); assert.equal(result.status, 'blocked'); if (result.status === 'blocked') assert.equal(result.reason, 'incarnation')
})

test('both pure collision detection includes a different already-retained component and never overwrites its document', () => {
  const value = input({ copied: true }), retained = value.retainedLocal.records.map(row => structuredClone(row.record))
  retained.push({ kind: 'document', id: COPY, createdAt: born, parentId: null, sortOrder: 0, content: { title: 'Foreign', summary: '', blocks: [] } })
  value.retainedLocal = snapshot(retained)
  const result = planSyncedBothFork(value); assert.equal(result.status, 'blocked'); if (result.status === 'blocked') assert.equal(result.reason, 'owner-source')
  assert.equal(getDoc(value.retainedLocal, COPY).content.title, 'Foreign')
})

test('both pure catalog clone preserves direct NULL values and independent linked entity titles exactly', () => {
  const value = input({ copied: true }), rewrite = (snapshotValue: SyncedProtocol5Snapshot) => {
    const records = snapshotValue.records.map(row => structuredClone(row.record)), db = records.find(record => record.kind === 'databases')!
    if (db.kind !== 'databases') throw new Error('Expected catalog')
    db.tables.document_database_columns.push({ id: 'col', database_id: 'catalog', name: 'Field', type: 'text', options_json: '[]', sort_order: 0, created_at: born })
    db.tables.database_entities.push({ id: 'entity', database_id: 'catalog', title: 'Independent entity title', document_id: D, created_at: born })
    db.tables.document_database_values.push({ document_id: D, column_id: 'col', value_text: null, entity_id: null })
    db.tables.database_entity_values.push({ entity_id: 'entity', column_id: 'col', value_text: '  exact JSON-looking {"id":"ordinary"}  ' })
    return snapshot(records, snapshotValue.manifest.workspaceId)
  }
  value.local = rewrite(value.local); value.remote = rewrite(value.remote); value.selectedOriginal = value.remote; value.retainedLocal = value.local; value.retainedRemote = value.remote; value.sourceLinks = sources(value.local)
  value.allocation.entities.push({ sourceEntityId: 'entity', entityId: id(60), createdAt: accepted })
  const result = planned(value), db = result.nextRemote.records.find(row => row.record.kind === 'databases')!.record
  if (db.kind !== 'databases') throw new Error('Expected catalog')
  assert.deepEqual(db.tables.document_database_values.find(row => row.document_id === COPY), { document_id: COPY, column_id: 'col', value_text: null, entity_id: null })
  assert.deepEqual(db.tables.database_entities.find(row => row.id === id(60)), { id: id(60), database_id: 'catalog', title: 'Independent entity title', document_id: COPY, created_at: accepted })
  assert.equal(db.tables.database_entity_values.find(row => row.entity_id === id(60))?.value_text, '  exact JSON-looking {"id":"ordinary"}  ')
})

test('both pure unstable destination title is blocked without trimming the actual local body', () => {
  const value = input({ copied: true }); value.allocation.documents[0].title = '  bad title  '
  const result = planSyncedBothFork(value); assert.equal(result.status, 'blocked'); if (result.status === 'blocked') assert.equal(result.reason, 'path')
  assert.equal(getDoc(value.local, D).content.blocks[0].content, '  local ordinary body  ')
})

test('both pure does not turn a remote-only ordinary document change into a required local copy', () => {
  const value = input({ copied: true }); value.conflictedKeys = ['group:' + G]
  const described = describeSyncedBothComponent(value); assert.equal(described.status, 'eligible')
  if (described.status !== 'eligible') throw new Error('Expected eligible')
  assert.equal(described.copyDocuments.find(row => row.sourceDocumentId === D)?.required, false)
})

function withCanonicalLinks(value: SyncedBothForkInput, text: string, targets: SyncedLinkTarget[]): void {
  function change(source: SyncedProtocol5Snapshot, suffix: string) {
    const records = source.records.map(row => structuredClone(row.record)), record = records.find(row => row.kind === 'synced-group')!
    if (record.kind !== 'synced-group') throw new Error('Expected source group')
    record.blocks[0].content = text + suffix
    const parsed = collectSyncedBindingOccurrences(record.origin, record.blocks)
    assert.equal(parsed.length, targets.length)
    record.bindings = parsed.map(({ url: _url, ...key }, index) => ({ ...key, target: targets[index] }))
    return snapshot(records, source.manifest.workspaceId)
  }
  value.local = change(value.local, ' local'); value.remote = change(value.remote, ' remote'); value.selectedOriginal = value.remote; value.retainedLocal = value.local; value.retainedRemote = value.remote
  const sourceGroup = getGroup(value.local, G), sourceTargets = new Map(sourceGroup.bindings.map(binding => [publicationJson(['group:' + G, binding.blockId, binding.from]), binding.target]))
  value.sourceLinks = sources(value.local, sourceTargets)
}

test('both pure two equal URL destinations keep their different authoritative targets through reversed source ordering', () => {
  const value = input({ copied: true })
  withCanonicalLinks(value, '[first](Target.md) [second](Target.md)', [
    { kind: 'block', id: B, documentId: D, state: 'live' },
    { kind: 'block', id: ' canonical:opaque ', documentId: null, state: 'live' }])
  value.sourceLinks.find(row => row.ownerKey === 'group:' + G)!.links.reverse()
  const result = planned(value), fork = getGroup(result.nextRemote, F), bindings = [...fork.bindings].sort((a, b) => a.from - b.from)
  assert.equal(bindings.length, 2)
  assert.deepEqual(bindings.map(binding => binding.target.kind === 'block' ? binding.target.id : null), [COPYB, CHILD])
  assert.ok(bindings[0].to < bindings[1].from, 'The second destination has its own exact shifted physical range')
  for (const binding of bindings) assert.equal(fork.blocks[0].content.slice(binding.from, binding.to), binding.raw)
})

test('both pure document heading targets map by the expanded physical occurrence instead of title or URL ordinal', () => {
  const value = input({ copied: true }), H = ' heading:opaque ', FH = id(40)
  function addHeading(source: SyncedProtocol5Snapshot) {
    const records = source.records.map(row => structuredClone(row.record)), doc = records.find(row => row.kind === 'document')!
    if (doc.kind !== 'document') throw new Error('Expected host')
    doc.content.blocks.unshift({ id: H, type: 'heading-1', content: 'Topic', checked: false, depth: 0, parentBlockId: null })
    return snapshot(records, source.manifest.workspaceId)
  }
  value.local = addHeading(value.local); value.remote = addHeading(value.remote)
  withCanonicalLinks(value, '[section](Host.md#topic)', [{ kind: 'heading', documentId: D, slug: 'topic', state: 'live' }])
  value.allocation.blocks.push({ sourceOwnerKey: 'doc:' + D, sourceBlockId: H, ownerKey: 'doc:' + COPY, blockId: FH, createdAt: accepted })
  const result = planned(value), fork = getGroup(result.nextRemote, F), target = fork.bindings[0].target
  assert.deepEqual(target, { kind: 'heading', documentId: COPY, slug: 'topic', state: 'live' })
  assert.equal(getDoc(result.nextRemote, COPY).content.blocks[0].id, FH)
  assert.equal(fork.blocks[0].content.slice(fork.bindings[0].from, fork.bindings[0].to), fork.bindings[0].raw)
})

test('both pure rejects an original unresolved URL that the advertised fresh copy would silently activate', () => {
  const value = input({ copied: true })
  withCanonicalLinks(value, '[not yet](Host%EF%BC%88%E6%9C%AC%E6%9C%BA%E5%88%86%E5%8F%89%EF%BC%89.md)', [{ kind: 'unresolved-url', path: 'Host（本机分叉）', fragment: null }])
  const result = planSyncedBothFork(value)
  assert.equal(result.status, 'blocked'); if (result.status === 'blocked') assert.equal(result.reason, 'semantic-binding')
  assert.equal(value.local.records.some(row => row.key === 'doc:' + COPY), false)
})

test('both pure summary and ordinary block sources stay in separate namespaces while both map to the new document', () => {
  const value = input({ copied: true })
  function summary(source: SyncedProtocol5Snapshot) {
    const records = source.records.map(row => structuredClone(row.record)), doc = records.find(row => row.kind === 'document')!
    if (doc.kind !== 'document') throw new Error('Expected ordinary host')
    doc.content.summary = '  [self](Host.md)  '
    return snapshot(records, source.manifest.workspaceId)
  }
  value.local = summary(value.local); value.remote = summary(value.remote); value.selectedOriginal = value.remote; value.retainedLocal = value.local; value.retainedRemote = value.remote; value.sourceLinks = sources(value.local)
  const result = planned(value), projection = result.projections.find(row => row.source.field === 'summary')
  assert.ok(projection, 'The actual summary destination has a distinct typed source projection')
  assert.equal(projection.source.blockId, null); assert.equal(projection.destination.blockId, null)
  assert.deepEqual(projection.target, { kind: 'document', id: COPY, state: 'live' })
  assert.ok(getDoc(result.nextRemote, COPY).content.summary.startsWith('  '), 'Authored summary prefix whitespace is retained')
  assert.ok(getDoc(result.nextRemote, COPY).content.summary.endsWith('  '), 'Authored summary suffix whitespace is retained')
})
