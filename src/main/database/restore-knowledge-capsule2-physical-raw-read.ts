import type Database from 'better-sqlite3'
import type { SyncedGroupSnapshot, SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { isSyncedBlockId, isSyncedUuid, SYNCED_MAX_BLOCKS } from '../../shared/syncedBlockValidation'
import { validateSyncedWorkspaceGraph } from '../../shared/syncedBlockGraph'
import { assertSyncedBlockSchema } from './synced-schema'
import { assertSyncedLifecycleSchemaMetadata } from './synced-lifecycle-schema-metadata'
import { assertSyncedLifecycleCoverage, readSyncedGroupLifecycles, type SyncedGroupLifecycle } from './synced-lifecycle-state'
import { readRawSyncedGroupSnapshotsOwned } from './synced-blocks-raw-read'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { readRawCapsule2HostDocumentOwned } from './synced-host-document-read'
import { assertSyncedStoredBindings } from './synced-stored-binding-read'

type IdentityRow = { id: string; last_owner_kind: 'document' | 'group' | 'reserved'; last_owner_id: string;
  state: 'live' | 'retained'; created_at: string | null }
type InstanceRow = { instance_id: string; group_id: string; host_document_id: string; binding_version: string;
  parent_block_id: string | null; depth: number }
type DocumentFact = { documentId: string; title: string; path: string; summary: string; createdAt: string; updatedAt: string;
  parentId: string | null; sortOrder: number; blocks: SyncedStableBlockDraft[]; births: Array<[string, string]> }
type GroupFact = { groupId: string; lifecycle: SyncedGroupLifecycle | null; snapshot: SyncedGroupSnapshot | null;
  absence: 'retired-create' | 'logical-deleted' | null }

/** Main-internal semantic observation. Original typed cells and bytes belong to
 * the separate content raw reader/original owner. This is not a capsule2 seal,
 * certificate, historical-completeness claim or admission capability. */
export interface RawCapsule2PhysicalGraph {
  kind: 'capsule2-raw-synced-physical-graph'; version: 2; state: 'raw-physical-observation-only'; certified: false
  semanticValidationComplete: false; schemaVersion: 26 | 27; workspaceScope: string; recoveryEpoch: string
  documents: DocumentFact[]; groups: GroupFact[]; identities: IdentityRow[]; instances: InstanceRow[]
  deletions: Array<ReturnType<typeof assertSyncedLogicalDeletionRecords> extends Map<string, infer T> ? T : never>
  unresolved: ['ordinary-content-semantics2', 'observer2', 'total-historical2', 'source-assets', 'complete-private-capsule2-certifier']
}
const invalid = (message: string): never => { throw new Error('capsule2 physical raw无效：' + message + '；不授认证或安装权。') }
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}

/** Actual document parents form a separate forest from the depth-bounded
 * block graph. Keep the ordinary writer's unbounded title length and exact
 * sibling spelling: deletion promotion can produce Case/case siblings.
 * Historical paths may be empty, duplicated or drifted by the former astral
 * prefix SQL. They remain literal source data, never tree identity or a value
 * to normalize while observing an immutable source. */
function assertDocumentTree(documents: readonly DocumentFact[]): void {
  const byId = new Map(documents.map(document => [document.documentId, document]))
  if (byId.size !== documents.length) return invalid('文档身份重复')
  const siblings = new Map<string | null, Set<string>>()
  for (const document of documents) {
    const title = document.title
    if (!title || title !== title.trim() || title === '.' || title === '..' || /[/\\\x00-\x1f]/.test(title))
      return invalid('文档标题不属于原普通writer接受域')
    if (document.parentId !== null && !byId.has(document.parentId)) return invalid('文档父身份不在完整来源闭集')
    const names = siblings.get(document.parentId) ?? new Set<string>()
    if (names.has(title)) return invalid('文档同级标题完全重复')
    names.add(title); siblings.set(document.parentId, names)
  }
  // Each parent edge is followed once across all chains. No recursive call,
  // path-prefix inference or new document-depth limit is involved. Starting at
  // every document also rejects a detached cycle with no reachable root.
  const complete = new Set<string>()
  for (const document of documents) {
    const chain = new Set<string>()
    let next: DocumentFact | undefined = document
    while (next && !complete.has(next.documentId)) {
      if (chain.has(next.documentId)) return invalid('文档父身份形成环')
      chain.add(next.documentId)
      next = next.parentId === null ? undefined : byId.get(next.parentId)
    }
    for (const id of chain) complete.add(id)
  }
}

/** New directed raw leaf, deliberately independent of publication records.
 * No document is passed to validateInitialRecord, no catalog is remapped, and
 * no observer/guard/effective/K/public reader is called. The legacy readers and
 * their exact fingerprint preimages remain unchanged. Caller supplies only an
 * actual readonly query-only/FKON SQL transaction, never ids/roots/a mode. */
export function readRawCapsule2PhysicalGraphOwned(db: Database.Database): RawCapsule2PhysicalGraph {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1
    || db.pragma('foreign_keys', { simple: true }) !== 1) return invalid('要求独立readonly/query-only/FKON真实owned事务')
  const version = db.pragma('user_version', { simple: true })
  if (version !== 26 && version !== 27) return invalid('仅识别准确schema26/27；不推empty')
  if ((db.pragma('foreign_key_check') as unknown[]).length) return invalid('真实物理外键闭包损坏')
  assertSyncedBlockSchema(db)
  if (version === 27) { assertSyncedLifecycleSchemaMetadata(db); assertSyncedLifecycleCoverage(db) }
  const context = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
    { workspace_scope: unknown; recovery_epoch: unknown } | undefined
  if (!context || !isSyncedUuid(context.workspace_scope) || !isSyncedUuid(context.recovery_epoch)) return invalid('原workspace/recovery身份无效')
  // This is the old finite denial reader, not the old schema observer. It must
  // keep every original proof/receipt relation; C/Receipt2 is a separate owner.
  const deleted = version === 27 ? assertSyncedLogicalDeletionRecords(db) : new Map()
  const ids = (db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{ id: unknown }>).map(row => {
    if (!isSyncedUuid(row.id)) return invalid('真实组身份无效'); return row.id
  })
  const groups: GroupFact[] = [], snapshots: SyncedGroupSnapshot[] = []
  for (let from = 0; from < ids.length; from += SYNCED_MAX_BLOCKS) {
    const batch = ids.slice(from, from + SYNCED_MAX_BLOCKS)
    const life = version === 27 ? readSyncedGroupLifecycles(db, batch) : new Map<string, SyncedGroupLifecycle>()
    const raw = readRawSyncedGroupSnapshotsOwned(db, batch)
    for (const groupId of batch) {
      const lifecycle = life.get(groupId) ?? null, snapshot = raw.get(groupId) ?? null
      if (version === 27 && lifecycle === null) return invalid('真实组缺准确lifecycle')
      if (snapshot) {
        if (deleted.has('group:' + groupId) || lifecycle && lifecycle.state !== 'active') return invalid('ready组与原删除/lifecycle矛盾')
        // The same full Key parser and retained physical target rules are used
        // by the raw publication reader, without rewriting targets from paths.
        assertSyncedStoredBindings(db, snapshot.origin, snapshot.blocks, snapshot.bindings)
        snapshots.push(snapshot); groups.push({ groupId, lifecycle, snapshot, absence: null })
      } else {
        const absence = deleted.has('group:' + groupId) ? 'logical-deleted' as const
          : lifecycle?.state === 'retired-create' ? 'retired-create' as const : null
        if (absence === null) return invalid('真实活动组不能丢成missing')
        groups.push({ groupId, lifecycle, snapshot: null, absence })
      }
    }
  }
  const documents: DocumentFact[] = (db.prepare('SELECT id FROM documents ORDER BY id').all() as Array<{ id: unknown }>).map(row => {
    if (!isSyncedBlockId(row.id)) return invalid('真实宿主身份无效')
    const host = readRawCapsule2HostDocumentOwned(db, row.id)
    if (!host) return invalid('真实宿主缺失')
    return { documentId: row.id, title: host.content.title, path: host.detail.path, summary: host.content.summary,
      createdAt: host.createdAt, updatedAt: host.detail.updatedAt, parentId: host.parentId, sortOrder: host.sortOrder,
      blocks: host.content.blocks, births: [...host.births].sort(([a], [b]) => compare(a, b)) }
  })
  assertDocumentTree(documents)
  const wires = snapshots.map(item => ({ kind: 'synced-group' as const, id: item.groupId, creationId: item.creationId,
    createdAt: item.createdAt, origin: item.origin, bindings: item.bindings, blocks: item.blocks }))
  // validateSyncedWorkspaceGraph has no document title/publication-record rule.
  // It still proves complete forests, unique owners, every physical occurrence,
  // canonical-parent role and the transparent combined depth bound.
  const graph = validateSyncedWorkspaceGraph(documents.map(({ documentId, blocks }) => ({ documentId, blocks })), wires)
  const identities = db.prepare('SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities ORDER BY id').all() as IdentityRow[]
  const seen = new Set<string>(), live = new Map<string, IdentityRow>()
  for (const row of identities) {
    if (!isSyncedBlockId(row.id) || seen.has(row.id) || !isSyncedBlockId(row.last_owner_id)
      || !['document', 'group', 'reserved'].includes(row.last_owner_kind) || row.state !== 'live' && row.state !== 'retained'
      || row.created_at !== null && !time(row.created_at) || row.last_owner_kind === 'reserved' && row.state !== 'retained'
      || row.state === 'live' && row.created_at === null) return invalid('原ledger组合损坏')
    seen.add(row.id)
    if (row.state === 'live') live.set(row.id, row)
  }
  if (live.size !== graph.owners.size) return invalid('全部存活ledger不是实际物理owner闭集')
  for (const [id, row] of live) {
    const owner = graph.owners.get(id)
    if (!owner || owner.kind !== row.last_owner_kind || owner.id !== row.last_owner_id) return invalid('ledger与实际唯一owner不一致')
    // Known birth equality is independently checked in both raw SQL physical
    // joins (readRawCapsule2HostDocumentOwned/readRawSyncedGroupSnapshotsOwned), not guessed.
  }
  const instances = db.prepare('SELECT instance_id,group_id,host_document_id,binding_version,parent_block_id,depth FROM synced_instances ORDER BY instance_id').all() as InstanceRow[]
  const expected = new Map(snapshots.flatMap(snapshot => snapshot.instances.map(item => [item.instanceId,
    { groupId: snapshot.groupId, ...item }] as const)))
  if (expected.size !== instances.length) return invalid('全部实例登记不是实际叶闭集')
  for (const row of instances) {
    const item = expected.get(row.instance_id)
    if (!item || item.groupId !== row.group_id || item.hostDocumentId !== row.host_document_id || item.bindingVersion !== row.binding_version
      || item.parentBlockId !== row.parent_block_id || item.depth !== row.depth) return invalid('原实例位置/绑定与完整组快照不一致')
  }
  // Origin is an immutable historical tuple. Neither its document nor the first
  // instance is required to be live; do not substitute the current owner/path.
  const observation: RawCapsule2PhysicalGraph = { kind: 'capsule2-raw-synced-physical-graph', version: 2, state: 'raw-physical-observation-only', certified: false,
    semanticValidationComplete: false, schemaVersion: version, workspaceScope: context.workspace_scope, recoveryEpoch: context.recovery_epoch,
    documents, groups, identities, instances, deletions: [...deleted.values()],
    unresolved: ['ordinary-content-semantics2', 'observer2', 'total-historical2', 'source-assets', 'complete-private-capsule2-certifier'] }
  return freeze(observation)
}
