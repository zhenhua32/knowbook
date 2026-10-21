import { assertSyncedLifecycleSchemaMetadata, syncedLifecycleTables as tables, syncedLifecycleGuards as guards } from './synced-lifecycle-schema-metadata'
import { assertSyncedRemoteObservationRecords } from './synced-remote-observation-read'
import type Database from 'better-sqlite3'
import type { SyncedGroupSnapshot } from '../../shared/synced-blocks'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { assertSyncedBlockSchema } from './synced-schema'
import { getSyncedGroupSnapshots } from './synced-blocks-read'
import { assertSyncedLifecycleCoverage, readSyncedGroupLifecycles, syncedLifecycleSemanticHash } from './synced-lifecycle-state'

/** No DDL or data repairs. Schema-26 authority is verified separately and stays
 * byte-for-byte unchanged; these checks only add the schema-27 namespace. */
export function assertSyncedLifecycleSchema(db: Database.Database): void {
  assertSyncedLifecycleSchemaMetadata(db)
  assertSyncedLifecycleCoverage(db)
  assertSyncedRemoteObservationRecords(db)
}

function wire(snapshot: SyncedGroupSnapshot) {
  return { kind: 'synced-group' as const, id: snapshot.groupId, creationId: snapshot.creationId, createdAt: snapshot.createdAt,
    origin: snapshot.origin, bindings: snapshot.bindings, blocks: snapshot.blocks }
}

/** Called only by the migration owner after its safety copy succeeds. It must
 * see original version 26, adds all state in the caller's one transaction and
 * never changes user_version. No API for registering never is exposed here. */
export function installSyncedLifecycleSchema(db: Database.Database, now = new Date().toISOString()): void {
  if (!db.inTransaction) throw new Error('同步块生命周期迁移必须由外层安全副本事务调用。')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('同步块生命周期迁移要求启用 SQLite 外键。')
  if (db.pragma('user_version', { simple: true }) !== 26) throw new Error('同步块生命周期迁移仅接受已验证的 schema26；不会修补 schema27。')
  if (!Number.isFinite(Date.parse(now))) throw new Error('同步块生命周期迁移时间无效。')
  assertSyncedBlockSchema(db)
  // The original version remains 26 throughout this transaction, so the legacy
  // snapshot reader still validates old content without requiring new state.
  // Process bounded batches rather than retaining every canonical body at once.
  const ids = (db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{ id: string }>).map(row => row.id)
  db.exec(tables)
  const insert = db.prepare(`INSERT INTO synced_group_lifecycle(group_id,creation_id,state,state_version,exposure_state,
    create_history_id,activation_revision,activation_topology_revision,activation_hash,activation_instances_json,created_at,updated_at)
    VALUES(?,?,'active',1,'unknown',NULL,?,?,?,?,?,?)`)
  for (let offset = 0; offset < ids.length; offset += 10_000) {
    for (const item of getSyncedGroupSnapshots(db, { groupIds: ids.slice(offset, offset + 10_000) }).items) {
      if (item.status !== 'ready') throw new Error('同一迁移事务中的真实旧组缺失，已拒绝迁移。')
      const snapshot = item.snapshot
      const instances = snapshot.instances.map(({ instanceId, hostDocumentId, bindingVersion }) => ({ instanceId, hostDocumentId, bindingVersion }))
      insert.run(snapshot.groupId, snapshot.creationId, snapshot.revision, snapshot.topologyRevision,
        syncedLifecycleSemanticHash(wire(snapshot)), canonicalSyncedPortableJson(instances), now, now)
    }
  }
  db.exec(guards)
  assertSyncedLifecycleSchema(db)
  readSyncedGroupLifecycles(db, ids)
}
