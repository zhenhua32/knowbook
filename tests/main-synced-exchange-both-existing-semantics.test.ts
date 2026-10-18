import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedGroupWire } from '../src/shared/synced-blocks'
import type { SyncedPortableHostRecord } from '../src/shared/syncedBlockPortable'
import { validateSyncedWorkspaceGraph, expandSyncedGraphDocument } from '../src/shared/syncedBlockGraph'
import { getMarkdownHeadingTargets } from '../src/shared/markdownLinkMaintenance'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { validateSyncedProtocol5Snapshot, type SyncedProtocol5Record, type SyncedProtocol5Snapshot } from '../src/main/sync/synced-protocol5-model'
import { planSyncedBothFork } from '../src/main/sync/synced-exchange-fork'
import type { SyncedBothForkInput } from '../src/main/sync/synced-exchange-both-types'
import type { SyncDatabases } from '../src/main/sync/model'

const id = (n: number) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const born = '2020-01-01T00:00:00.000Z', minted = '2026-10-18T01:02:03.000Z'
const D = ' host:opaque ', P = ' R/ordinary:opaque ', G = id(2), CREATION = id(3), I = id(4), H1 = ' canonical/topic:opaque ', H2 = ' canonical/other:opaque '
const F = id(20), FC = id(21), FI = id(24), FH1 = id(25), FH2 = id(23)
const digest = (value: unknown) => publicationHash(publicationJson(value))
const catalog: SyncDatabases = { kind: 'databases', id: 'databases', tables: { databases: [{ id: 'catalog', name: 'Default', description: 'Default', created_at: born }],
  document_database_columns: [], database_saved_views: [], database_entities: [], database_entity_values: [], document_database_values: [] } }
function snapshot(records: SyncedProtocol5Record[], workspaceId: string): SyncedProtocol5Snapshot {
  const rows = records.map(record => ({ key: record.kind === 'databases' ? 'databases' : (record.kind === 'synced-group' ? 'group:' : 'doc:') + record.id, record }))
  const group = records.find(record => record.kind === 'synced-group')!
  return validateSyncedProtocol5Snapshot({ version: 5, workspaceId, entries: Object.fromEntries(rows.map(row => [row.key, digest(row.record)])),
    syncedInstances: [{ documentId: D, instanceId: I, groupId: G, groupHash: digest(group) }] }, rows)
}
function fixture(mode: 'retarget' | 'stable' | 'activate'): SyncedBothForkInput {
  const localDoc: SyncedPortableHostRecord = { kind: 'document', id: D, parentId: null, sortOrder: 0, createdAt: born, content: { title: 'Host', summary: '', blocks: [
    { id: P, type: 'paragraph', content: 'Local unchanged ordinary base', checked: false, depth: 0, parentBlockId: null },
    { id: I, type: 'synced-block', content: publicationJson({ version: 1, groupId: G }), checked: false, depth: 0, parentBlockId: null }] } }
  const localGroup: SyncedGroupWire = { kind: 'synced-group', id: G, creationId: CREATION, createdAt: born,
    origin: { version: 1, documentId: D, pathAtCreation: 'Host', firstInstanceId: I }, bindings: [], blocks: [
      { id: H2, type: 'heading-1', content: mode === 'stable' ? 'Other' : mode === 'activate' ? 'Previously missing' : 'Topic', checked: false, depth: 0, parentBlockId: null, createdAt: born },
      { id: H1, type: 'heading-1', content: mode === 'retarget' ? 'Other' : 'Topic', checked: false, depth: 0, parentBlockId: null, createdAt: born }] }
  const remoteDoc = structuredClone(localDoc), remoteGroup = structuredClone(localGroup)
  remoteDoc.content.blocks[0].content = mode === 'activate' ? 'R-only ordinary [jump](#previously-missing)' : 'R-only ordinary [jump](#topic)'
  remoteGroup.blocks[0].content = 'Remote other'; remoteGroup.blocks[1].content = 'Topic'
  const local = snapshot([localDoc, localGroup, catalog], id(100)), remote = snapshot([remoteDoc, remoteGroup, catalog], id(101))
  const keys = ['databases', 'doc:' + D, 'group:' + G], component = { componentId: digest('real-both-component'), keys,
    localSignature: digest(keys.map(key => [key, local.manifest.entries[key]])), remoteSignature: digest(keys.map(key => [key, remote.manifest.entries[key]])), dependencySignature: digest('exact-original-dependencies') }
  return { local, remote, selectedOriginal: remote, conflictedKeys: ['group:' + G], component, retainedLocal: local, retainedRemote: remote,
    sourceLinks: [
      { ownerKey: 'doc:' + D, recordHash: local.manifest.entries['doc:' + D], path: 'Host', complete: true, links: [], images: [] },
      { ownerKey: 'group:' + G, recordHash: local.manifest.entries['group:' + G], path: null, complete: true, links: [], images: [] }],
    decision: { componentId: component.componentId, copyDocumentIds: [], groups: [{ groupId: G, hosts: [{ sourceDocumentId: D, sourceInstanceId: I, destination: 'existing' }] }] },
    allocation: { kind: 'synced-exchange-both-allocation', version: 1, previewId: id(80), allocatedAt: minted,
      documents: [], groups: [{ sourceGroupId: G, groupId: F, creationId: FC, createdAt: minted, firstInstanceId: FI }],
      blocks: [{ sourceOwnerKey: 'group:' + G, sourceBlockId: H1, ownerKey: 'group:' + F, blockId: FH1, createdAt: minted },
        { sourceOwnerKey: 'group:' + G, sourceBlockId: H2, ownerKey: 'group:' + F, blockId: FH2, createdAt: minted }],
      instances: [{ sourceDocumentId: D, sourceInstanceId: I, destination: 'existing', documentId: D, instanceId: FI, groupId: F, createdAt: minted }], entities: [], missing: [] } }
}
function heading(value: SyncedProtocol5Snapshot, slug: string): string | null {
  const documents = value.records.flatMap(row => row.record.kind === 'document' ? [{ documentId: row.record.id, blocks: row.record.content.blocks }] : [])
  const groups = value.records.flatMap(row => row.record.kind === 'synced-group' ? [row.record] : [])
  const graph = validateSyncedWorkspaceGraph(documents, groups)
  const virtual = [...expandSyncedGraphDocument(graph, D)].map(item => ({ ...item.block, id: publicationJson([item.instanceId, item.block.id]), depth: item.depth,
    parentBlockId: item.parent === null ? null : publicationJson([item.parent.instanceId, item.parent.blockId]) }))
  return getMarkdownHeadingTargets(virtual, 'Host').find(item => item.slug === slug)?.blockId ?? null
}

test('both existing host cannot silently retarget an R-only ordinary heading link by borrowing L source facts', () => {
  const value = fixture('retarget'), before = publicationJson({ local: value.local.records, remote: value.remote.records, allocation: value.allocation })
  assert.equal(heading(value.selectedOriginal, 'topic'), publicationJson([I, H1]))
  assert.equal(value.sourceLinks[0].links.length, 0, 'The actual L ordinary scope has no R-only destination to authorize')
  const result = planSyncedBothFork(value), observed = result.status === 'planned' ? heading(result.nextRemote, 'topic') : null
  assert.equal(result.status, 'blocked', 'R-only #topic must retain its authorized physical heading, rather than exposing ' + observed)
  if (result.status === 'blocked') assert.equal(result.reason, 'semantic-binding')
  assert.equal(publicationJson({ local: value.local.records, remote: value.remote.records, allocation: value.allocation }), before)
})

test('both existing host does not activate a previously unresolved R-only ordinary heading link', () => {
  const value = fixture('activate')
  assert.equal(heading(value.selectedOriginal, 'previously-missing'), null)
  const result = planSyncedBothFork(value), observed = result.status === 'planned' ? heading(result.nextRemote, 'previously-missing') : null
  assert.equal(result.status, 'blocked', 'A newly displayed local canonical heading must not activate the untouched R-only URL: ' + observed)
  if (result.status === 'blocked') assert.equal(result.reason, 'semantic-binding')
})

test('both existing host permits an ordinary heading link whose exact source heading survives through its fixed fork map', () => {
  const value = fixture('stable')
  assert.equal(heading(value.selectedOriginal, 'topic'), publicationJson([I, H1]))
  const result = planSyncedBothFork(value)
  assert.equal(result.status, 'planned')
  if (result.status !== 'planned') throw new Error('Expected a provable existing-host heading mapping')
  assert.equal(heading(result.nextRemote, 'topic'), publicationJson([FI, FH1]))
  const record = result.nextRemote.records.find(row => row.key === 'doc:' + D)?.record
  assert.ok(record?.kind === 'document', 'The real original-ID remote host survives the both transform')
  assert.equal(record.content.blocks[0].content, 'R-only ordinary [jump](#topic)')
})
