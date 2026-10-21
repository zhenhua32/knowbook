import type Database from 'better-sqlite3'
import type { SyncedGroupSnapshot, SyncedGroupWire } from '../../shared/synced-blocks'
import { isSyncedBlockId, isSyncedUuid, SYNCED_MAX_BLOCKS } from '../../shared/syncedBlockValidation'
import { validateSyncedWorkspaceGraph } from '../../shared/syncedBlockGraph'
import { readSyncedGroupLifecycles, syncedLifecycleSemanticHash } from './synced-lifecycle-state'
import { readRawSyncedGroupSnapshotsOwned, readRawSyncedWorkspaceScopeOwned } from './synced-blocks-raw-read'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import type { SyncedLogicalDeletionProof } from '../sync/synced-logical-deletion-model'
import type { SyncedLogicalDeletionChoiceProof } from '../sync/synced-logical-deletion-choice-model'
import { readStrictHostDocument } from './synced-host-document-read'
import { assertSyncedStoredBindings } from './synced-block-links'
import { SYNC_TABLE_COLUMNS, SYNC_TABLES, type SyncDatabases } from '../sync/model'
import { publicationHash, publicationInvalid, publicationJson, publicationCompare, validateInitialRecord,
  mapPublicationCatalog, validatePublicationCatalog, type InitialPublicationRecord } from '../sync/synced-publication-model'

export interface SyncedPublicationLocalSnapshot {
  workspaceScope: string; recoveryEpoch: string; localFingerprint: string; catalogId: string
  records: InitialPublicationRecord[]
  groups: Array<{ wire: SyncedGroupWire; revision: string; topologyRevision: string; semanticHash: string }>
  deletions?: Array<SyncedLogicalDeletionProof | SyncedLogicalDeletionChoiceProof>
}
type Identity = { workspaceScope: string; recoveryEpoch: string }

function identity(db: Database.Database): Identity {
  const row = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
    { workspace_scope: unknown; recovery_epoch: unknown } | undefined
  if (!row || !isSyncedUuid(row.workspace_scope) || !isSyncedUuid(row.recovery_epoch)) return publicationInvalid('真实 workspace/recovery 身份无效。')
  return { workspaceScope: row.workspace_scope, recoveryEpoch: row.recovery_epoch }
}
function wire(snapshot: SyncedGroupSnapshot): SyncedGroupWire {
  return { kind: 'synced-group', id: snapshot.groupId, creationId: snapshot.creationId, createdAt: snapshot.createdAt,
    origin: snapshot.origin, bindings: snapshot.bindings, blocks: snapshot.blocks }
}
/** Original physical/semantic facts in the caller's real SQL snapshot. This is
 * not schema/boundary admission, a publication capture, a claim or an install
 * permit. Capsule owners authenticate metadata and historical coverage apart;
 * public capability readers retain their own admission before calling here. */
export function readRawSyncedPersistentPublicationSnapshotOwned(db: Database.Database): SyncedPublicationLocalSnapshot {
  if (!db.open || !db.inTransaction) return publicationInvalid('完整持久图读取须位于调用方自有一致事务。')
  const context = identity(db)
  const deleted = assertSyncedLogicalDeletionRecords(db)
  const ids = (db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{ id: unknown }>).map(row => {
    if (!isSyncedUuid(row.id)) return publicationInvalid('真实同步组身份无效。'); return row.id
  })
  const life = new Map<string, ReturnType<typeof readSyncedGroupLifecycles> extends Map<string, infer T> ? T : never>()
  const groups: SyncedPublicationLocalSnapshot['groups'] = [], snapshots: SyncedGroupSnapshot[] = []
  for (let from = 0; from < ids.length; from += SYNCED_MAX_BLOCKS) {
    const batch = ids.slice(from, from + SYNCED_MAX_BLOCKS)
    for (const [id, item] of readSyncedGroupLifecycles(db, batch)) life.set(id, item)
    const scope = readRawSyncedWorkspaceScopeOwned(db), rawGroups = readRawSyncedGroupSnapshotsOwned(db, batch)
    const read = { workspaceScope: scope, items: batch.map(groupId => {
      const snapshot = rawGroups.get(groupId)
      return snapshot ? { status: 'ready' as const, snapshot } : { status: 'missing' as const, groupId }
    }) }
    if (read.workspaceScope !== context.workspaceScope) return publicationInvalid('组列表不属于原 workspace。')
    for (const item of read.items) {
      if (item.status === 'ready') {
        if (life.get(item.snapshot.groupId)?.state !== 'active') return publicationInvalid('活动组与 lifecycle 不一致。')
        assertSyncedStoredBindings(db, item.snapshot.origin, item.snapshot.blocks, item.snapshot.bindings)
        const body = wire(item.snapshot)
        groups.push({ wire: body, revision: item.snapshot.revision, topologyRevision: item.snapshot.topologyRevision, semanticHash: syncedLifecycleSemanticHash(body) })
        snapshots.push(item.snapshot)
      } else if (life.get(item.groupId)?.state !== 'retired-create' && !deleted.has('group:' + item.groupId)) return publicationInvalid('真实活动组不能被丢成 missing。')
    }
  }
  const rows = db.prepare('SELECT id FROM documents ORDER BY id').all() as Array<{ id: unknown }>
  const records: InitialPublicationRecord[] = [], documentFacts: unknown[] = []
  const documents = rows.map(row => {
    if (!isSyncedBlockId(row.id)) return publicationInvalid('宿主身份无效。')
    const host = readStrictHostDocument(db, row.id)
    if (!host) return publicationInvalid('真实宿主缺失。')
    const record = validateInitialRecord({ kind: 'document', id: row.id, parentId: host.parentId, sortOrder: host.sortOrder,
      createdAt: host.createdAt, content: host.content }, 'doc:' + row.id)
    if (record.kind !== 'document') return publicationInvalid('宿主类型无效。')
    records.push(record)
    documentFacts.push({ id: row.id, path: host.detail.path, updatedAt: host.detail.updatedAt,
      births: [...host.births].sort(([a], [b]) => publicationCompare(a, b)) })
    return { documentId: row.id, blocks: record.content.blocks }
  })
  const graph = validateSyncedWorkspaceGraph(documents, groups.map(item => item.wire))
  const actualOwners = db.prepare("SELECT id,last_owner_kind,last_owner_id,created_at FROM block_identities WHERE state='live' ORDER BY id").all() as
    Array<{ id: string; last_owner_kind: string; last_owner_id: string; created_at: string | null }>
  if (actualOwners.length !== graph.owners.size) return publicationInvalid('完整存活 owner 不是实际物理图闭集。')
  for (const owner of actualOwners) {
    const expected = graph.owners.get(owner.id)
    if (!expected || owner.last_owner_kind !== expected.kind || owner.last_owner_id !== expected.id || owner.created_at === null) return publicationInvalid('完整 owner 与原图不一致。')
  }
  const actualInstances = db.prepare('SELECT instance_id,group_id,host_document_id,binding_version,parent_block_id,depth FROM synced_instances ORDER BY instance_id').all() as
    Array<{ instance_id: string; group_id: string; host_document_id: string; binding_version: string; parent_block_id: string | null; depth: number }>
  const positions = new Map(snapshots.flatMap(snapshot => snapshot.instances.map(item => [item.instanceId, { groupId: snapshot.groupId, ...item }] as const)))
  if (positions.size !== actualInstances.length) return publicationInvalid('实例登记不是全部实际叶闭集。')
  for (const row of actualInstances) {
    const item = positions.get(row.instance_id)
    if (!item || row.group_id !== item.groupId || row.host_document_id !== item.hostDocumentId || row.binding_version !== item.bindingVersion
      || row.parent_block_id !== item.parentBlockId || row.depth !== item.depth) return publicationInvalid('实例位置/绑定不属于原完整快照。')
  }
  const setting = db.prepare("SELECT value FROM app_settings WHERE key='database.defaultId'").get() as { value: unknown } | undefined
  if (!setting || !isSyncedBlockId(setting.value)) return publicationInvalid('默认 catalog 配置缺失。')
  const tables = {} as SyncDatabases['tables']
  for (const table of SYNC_TABLES) tables[table] = db.prepare('SELECT ' + SYNC_TABLE_COLUMNS[table].join(',') + ' FROM ' + table).all() as SyncDatabases['tables'][typeof table]
  const catalog = validateInitialRecord({ kind: 'databases', id: 'databases', tables }, 'databases')
  if (catalog.kind !== 'databases' || !catalog.tables.databases.some(row => row.id === setting.value)) return publicationInvalid('默认 catalog 不是真实数据库。')
  for (const table of SYNC_TABLES) catalog.tables[table].sort((a, b) => publicationCompare(publicationJson(a), publicationJson(b)))
  records.push(catalog, ...groups.map(item => item.wire))
  const orderedRecords = records.sort((a, b) => publicationCompare(a.kind === 'databases' ? 'databases' : a.kind === 'document' ? 'doc:' + a.id : 'group:' + a.id,
    b.kind === 'databases' ? 'databases' : b.kind === 'document' ? 'doc:' + b.id : 'group:' + b.id))
  groups.sort((a, b) => publicationCompare(a.wire.id, b.wire.id))
  validatePublicationCatalog(mapPublicationCatalog(orderedRecords, setting.value))
  const lifecycleContent = ids.map(id => { const item = life.get(id)!; return { groupId: id, creationId: item.creationId, state: item.state } })
  const localFingerprint = publicationHash(publicationJson({ ...context, catalogId: setting.value, records: orderedRecords, groups,
    documentFacts, actualOwners, actualInstances, lifecycleContent, ...(deleted.size ? { deleted: [...deleted].map(([key, proof]) => [key, publicationHash(publicationJson(proof))]) } : {}) }))
  return { ...context, localFingerprint, catalogId: setting.value, records: orderedRecords, groups, ...(deleted.size ? { deletions: [...deleted.values()] } : {}) }
}
