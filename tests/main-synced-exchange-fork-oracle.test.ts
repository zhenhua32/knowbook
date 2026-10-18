import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedGroupWire } from '../src/shared/synced-blocks'
import type { SyncedPortableHostRecord } from '../src/shared/syncedBlockPortable'
import type { SyncDatabases } from '../src/main/sync/model'
import { describeSyncedBothComponent, planSyncedBothFork } from '../src/main/sync/synced-exchange-fork'
import type { SyncedBothForkInput, SyncedBothAllocation, SyncedBothOwnerSourceLinks } from '../src/main/sync/synced-exchange-both-types'
import { validateSyncedProtocol5Snapshot, type SyncedProtocol5Record } from '../src/main/sync/synced-protocol5-model'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { collectMarkdownSourceLinks } from '../src/shared/markdownLinks'

const uuid = (n: number) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const born = '2020-01-01T00:00:00.000Z', freshBirth = '2026-10-18T00:00:00.000Z'
const G = uuid(1), creation = uuid(2), G1 = uuid(3), creation1 = uuid(4), i0 = uuid(5), i1 = uuid(6), j0 = uuid(7), j1 = uuid(8)
const hostId = ' pure:host original ', oldChild = ' pure:canonical original ', newChild = uuid(9)
const hash = (value: unknown) => publicationHash(publicationJson(value))
const catalog: SyncDatabases = { kind: 'databases', id: 'databases', tables: { databases: [{ id: 'catalog', name: 'Default', description: 'Default database', created_at: born }],
  document_database_columns: [], database_saved_views: [], database_entities: [], database_entity_values: [], document_database_values: [] } }
function plain(id: string, title: string): SyncedPortableHostRecord {
  return { kind: 'document', id, createdAt: born, parentId: null, sortOrder: 0,
    content: { title, summary: '', blocks: [{ id: id + ':body', type: 'paragraph', content: 'ordinary target', checked: false, depth: 0, parentBlockId: null }] } }
}
function fixture(linked = false): SyncedBothForkInput {
  const H = plain(hostId, 'Host')
  H.content.blocks = [i0, i1].map(id => ({ id, type: 'synced-block', content: publicationJson({ version: 1, groupId: G }), checked: false, depth: 0, parentBlockId: null }))
  const group = (prefix: string): SyncedGroupWire => {
    const text = prefix + (linked ? ' [one](Target.md) between [two](Target.md)' : ' local plain canonical')
    const positions = linked ? [text.indexOf('Target.md'), text.lastIndexOf('Target.md')] : []
    return { kind: 'synced-group', id: G, creationId: creation, createdAt: born,
      origin: { version: 1, documentId: hostId, pathAtCreation: 'Host', firstInstanceId: i0 },
      blocks: [{ id: oldChild, type: 'paragraph', content: text, checked: false, depth: 0, parentBlockId: null, createdAt: born }],
      bindings: positions.map((from, index) => ({ blockId: oldChild, from, to: from + 'Target.md'.length, raw: 'Target.md', syntax: 'markdown' as const,
        target: { kind: 'document' as const, id: index ? 'target:second' : 'target:first', state: 'live' as const } })).reverse() }
  }
  const L = group('LOCAL'), R = group('REMOTE'), extra = linked ? [plain('target:first', 'Renamed'), plain('target:second', 'Target')] : []
  const wire = (g: SyncedGroupWire, workspace: string) => {
    const records: SyncedProtocol5Record[] = [H, g, ...extra, catalog], values = records.map(record => ({ key: record.kind === 'databases' ? 'databases' : record.kind === 'synced-group' ? 'group:' + record.id : 'doc:' + record.id, record }))
    return validateSyncedProtocol5Snapshot({ version: 5, workspaceId: workspace,
      entries: Object.fromEntries(values.map(({ key, record }) => [key, hash(record)])),
      syncedInstances: [i0, i1].map(instanceId => ({ documentId: hostId, instanceId, groupId: G, groupHash: hash(g) })) }, values)
  }
  const local = wire(L, uuid(20)), remote = wire(R, uuid(21)), retainedLocal = wire(R, uuid(20))
  const sourceLinks = local.records.flatMap<SyncedBothOwnerSourceLinks>(({ key, hash, record }) => record.kind === 'document'
    ? [{ ownerKey: key, recordHash: hash, path: record.content.title, complete: true, links: [], images: [] }]
    : record.kind === 'synced-group' ? [{ ownerKey: key, recordHash: hash, path: null, complete: true, images: [], links: record.bindings.map(binding => ({
      key: { field: 'block' as const, blockId: binding.blockId, from: binding.from, to: binding.to, raw: binding.raw, syntax: binding.syntax },
      url: binding.raw, target: binding.target })) }] : [])
  const component = { componentId: hash('pure component'), keys: ['doc:' + hostId, 'group:' + G].sort(), localSignature: hash(local.manifest.entries), remoteSignature: hash(remote.manifest.entries), dependencySignature: hash('known dependency edges') }
  const allocation: SyncedBothAllocation = { kind: 'synced-exchange-both-allocation', version: 1, previewId: uuid(30), allocatedAt: freshBirth, documents: [],
    groups: [{ sourceGroupId: G, groupId: G1, creationId: creation1, createdAt: freshBirth, firstInstanceId: j0 }],
    blocks: [{ sourceOwnerKey: 'group:' + G, sourceBlockId: oldChild, ownerKey: 'group:' + G1, blockId: newChild, createdAt: freshBirth }],
    instances: [i0, i1].map((sourceInstanceId, index) => ({ sourceDocumentId: hostId, sourceInstanceId, destination: 'existing' as const, documentId: hostId,
      instanceId: index ? j1 : j0, groupId: G1, createdAt: freshBirth })), entities: [], missing: [] }
  return { local, remote, selectedOriginal: remote, conflictedKeys: ['group:' + G], component, sourceLinks, retainedLocal, retainedRemote: remote,
    decision: { componentId: component.componentId, copyDocumentIds: [], groups: [{ groupId: G, hosts: [i0, i1].map(sourceInstanceId => ({ sourceDocumentId: hostId, sourceInstanceId, destination: 'existing' as const })) }] }, allocation }
}

test('pure fork external graph oracle keeps one fresh G for repeated real occurrences and preserves the complete remote original', () => {
  const input = fixture(), original = structuredClone(input), description = describeSyncedBothComponent(input)
  assert.equal(description.status, 'eligible')
  const result = planSyncedBothFork(input)
  assert.ok(result.status === 'planned', 'The typed pure candidate produces a complete graph, without conferring Main source authority')
  const fresh = result.localFinal.records.find(row => row.key === 'group:' + G1)?.record, retained = result.localFinal.records.find(row => row.key === 'group:' + G)?.record,
    host = result.localFinal.records.find(row => row.key === 'doc:' + hostId)?.record
  assert.ok(fresh?.kind === 'synced-group' && retained?.kind === 'synced-group' && host?.kind === 'document', 'The independent graph oracle finds both canonical branches and the actual retained host')
  assert.equal(result.fork.summary.groups.length, 1); assert.equal(fresh.id, G1); assert.equal(fresh.creationId, creation1); assert.equal(fresh.createdAt, freshBirth)
  assert.deepEqual(fresh.blocks, [{ id: newChild, type: 'paragraph', content: 'LOCAL local plain canonical', checked: false, depth: 0, parentBlockId: null, createdAt: freshBirth }])
  assert.equal(retained.blocks[0].content, 'REMOTE local plain canonical')
  assert.deepEqual(host.content.blocks.map(block => [block.id, JSON.parse(block.content).groupId]), [[j0, G1], [j1, G1]])
  assert.deepEqual(result.nextRemote.manifest.entries, result.localFinal.manifest.entries)
  assert.deepEqual(result.localFinal.manifest.syncedInstances, [j0, j1].map(instanceId => ({ documentId: hostId, instanceId, groupId: G1, groupHash: hash(fresh) })))
  assert.deepEqual(input, original)
})

test('pure fork external complete-Key oracle preserves two equal-URL historical targets while fresh canonical text is rewritten to actual stable paths', () => {
  const input = fixture(true), result = planSyncedBothFork(input)
  assert.ok(result.status === 'planned', 'The original complete canonical binding provenance permits a typed fork')
  const fresh = result.localFinal.records.find(row => row.key === 'group:' + G1)?.record
  assert.ok(fresh?.kind === 'synced-group', 'The actual final graph contains the fresh canonical owner')
  const text = fresh.blocks[0].content, parsed = collectMarkdownSourceLinks(text)
  for (const [label, target, url] of [['one', 'target:first', '/Renamed.md'], ['two', 'target:second', '/Target.md']]) {
    const open = text.indexOf('[' + label + ']('), end = text.indexOf(')', open)
    const token = parsed.find(token => token.start > open && token.end <= end)
    assert.ok(open >= 0 && token, 'The independent source collector finds the exact named destination occurrence')
    assert.equal(token.url, url)
    const binding: (typeof fresh.bindings)[number] | undefined = fresh.bindings.find(binding => binding.blockId === newChild && binding.from === token.start && binding.to === token.end && binding.raw === text.slice(token.start, token.end) && binding.syntax === 'markdown')
    assert.ok(binding, 'The destination binding joins by its complete physical Key instead of equal URL or array position')
    assert.deepEqual(binding.target, { kind: 'document', id: target, state: 'live' })
  }
  assert.equal(fresh.bindings.length, 2)
  assert.equal(new Set(result.projections.map(row => publicationJson([row.sourceOwnerKey, row.source]))).size, 2)
})
