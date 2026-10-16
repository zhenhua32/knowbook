import type Database from 'better-sqlite3'
import type { SyncedGroupSnapshot } from '../../shared/synced-blocks'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { assertSyncedBlockSchema } from './synced-schema'
import { getSyncedGroupSnapshots } from './synced-blocks-read'
import { assertSyncedLifecycleCoverage, readSyncedGroupLifecycles, syncedLifecycleSemanticHash } from './synced-lifecycle-state'

const tables = `
CREATE TABLE synced_group_lifecycle (
  group_id TEXT PRIMARY KEY NOT NULL REFERENCES synced_groups(id) ON DELETE RESTRICT,
  creation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','retired-create')),
  state_version INTEGER NOT NULL CHECK (typeof(state_version)='integer' AND state_version>0),
  exposure_state TEXT NOT NULL CHECK (exposure_state IN ('never','unknown','possible','confirmed')),
  create_history_id TEXT REFERENCES synced_host_history(id) ON DELETE RESTRICT,
  activation_revision TEXT NOT NULL,
  activation_topology_revision TEXT NOT NULL,
  activation_hash TEXT NOT NULL CHECK (length(activation_hash)=64 AND activation_hash NOT GLOB '*[^0-9a-f]*'),
  activation_instances_json TEXT NOT NULL CHECK (json_valid(activation_instances_json) AND json_type(activation_instances_json)='array'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (exposure_state<>'never' OR create_history_id IS NOT NULL),
  CHECK (state<>'retired-create' OR (exposure_state='never' AND create_history_id IS NOT NULL))
);
CREATE TABLE synced_group_retirements (
  group_id TEXT PRIMARY KEY NOT NULL REFERENCES synced_group_lifecycle(group_id) ON DELETE RESTRICT,
  creation_id TEXT NOT NULL,
  create_history_id TEXT NOT NULL REFERENCES synced_host_history(id) ON DELETE RESTRICT,
  wire_json TEXT NOT NULL CHECK (json_valid(wire_json) AND json_type(wire_json)='object'),
  semantic_hash TEXT NOT NULL CHECK (length(semantic_hash)=64 AND semantic_hash NOT GLOB '*[^0-9a-f]*'),
  retired_at TEXT NOT NULL
);
CREATE TABLE synced_exposure_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  channel TEXT NOT NULL CHECK (length(CAST(channel AS BLOB))>0),
  target_fingerprint TEXT NOT NULL CHECK (length(target_fingerprint)=64 AND target_fingerprint NOT GLOB '*[^0-9a-f]*'),
  publication_hash TEXT NOT NULL CHECK (length(publication_hash)=64 AND publication_hash NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('possible','confirmed')),
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  CHECK ((state='possible' AND confirmed_at IS NULL) OR (state='confirmed' AND confirmed_at IS NOT NULL))
);
CREATE TABLE synced_group_exposure_members (
  attempt_id TEXT NOT NULL REFERENCES synced_exposure_attempts(id) ON DELETE RESTRICT,
  group_id TEXT NOT NULL REFERENCES synced_group_lifecycle(group_id) ON DELETE RESTRICT,
  creation_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  semantic_hash TEXT NOT NULL CHECK (length(semantic_hash)=64 AND semantic_hash NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(attempt_id,group_id)
);
CREATE INDEX idx_synced_group_exposure_members_group ON synced_group_exposure_members(group_id,attempt_id);
`

const guards = `
CREATE TRIGGER trg_synced_lifecycle_insert_guard BEFORE INSERT ON synced_group_lifecycle BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM synced_groups g WHERE g.id=NEW.group_id AND g.creation_id=NEW.creation_id)
    OR NEW.state<>'active' OR NEW.state_version<>1 OR NEW.exposure_state NOT IN ('unknown','never')
    THEN RAISE(ABORT,'Lifecycle must begin as an active real incarnation') END;
END;
CREATE TRIGGER trg_synced_lifecycle_update_guard BEFORE UPDATE ON synced_group_lifecycle BEGIN
  SELECT CASE WHEN NEW.group_id IS NOT OLD.group_id OR NEW.creation_id IS NOT OLD.creation_id
    OR NEW.create_history_id IS NOT OLD.create_history_id OR NEW.created_at IS NOT OLD.created_at
    OR NEW.state_version<>OLD.state_version+1 THEN RAISE(ABORT,'Lifecycle identity and monotonic version must be preserved') END;
  SELECT CASE WHEN NEW.exposure_state IS NOT OLD.exposure_state AND NOT (
    (OLD.exposure_state IN ('never','unknown') AND NEW.exposure_state IN ('possible','confirmed'))
    OR (OLD.exposure_state='possible' AND NEW.exposure_state='confirmed'))
    THEN RAISE(ABORT,'Exposure evidence cannot regress or become never') END;
  SELECT CASE WHEN (NEW.activation_revision IS NOT OLD.activation_revision
    OR NEW.activation_topology_revision IS NOT OLD.activation_topology_revision OR NEW.activation_hash IS NOT OLD.activation_hash
    OR NEW.activation_instances_json IS NOT OLD.activation_instances_json)
    AND NOT (OLD.state='retired-create' AND NEW.state='active')
    THEN RAISE(ABORT,'Only a successful reactivation may replace activation guards') END;
  SELECT CASE WHEN NEW.state='retired-create' AND OLD.state='active' AND (
    NEW.exposure_state<>'never' OR EXISTS(SELECT 1 FROM synced_group_exposure_members WHERE group_id=OLD.group_id)
    OR NOT EXISTS(SELECT 1 FROM synced_groups WHERE id=OLD.group_id AND creation_id=OLD.creation_id
      AND revision=OLD.activation_revision AND topology_revision=OLD.activation_topology_revision)
    OR EXISTS(SELECT 1 FROM synced_group_blocks WHERE group_id=OLD.group_id)
    OR EXISTS(SELECT 1 FROM synced_instances WHERE group_id=OLD.group_id)
    OR EXISTS(SELECT 1 FROM block_identities WHERE last_owner_kind='group' AND last_owner_id=OLD.group_id AND state='live')
    OR EXISTS(SELECT 1 FROM synced_group_pins WHERE group_id=OLD.group_id)
    OR NOT EXISTS(SELECT 1 FROM synced_group_retirements r WHERE r.group_id=OLD.group_id
      AND r.creation_id=OLD.creation_id AND r.create_history_id=OLD.create_history_id AND r.semantic_hash=OLD.activation_hash))
    THEN RAISE(ABORT,'Retirement requires the exact frozen unpublished incarnation without live dependents') END;
  SELECT CASE WHEN OLD.state='retired-create' AND NEW.state='active'
    AND NOT EXISTS(SELECT 1 FROM synced_group_retirements WHERE group_id=OLD.group_id)
    THEN RAISE(ABORT,'Reactivation requires the original frozen retirement') END;
END;
CREATE TRIGGER trg_synced_lifecycle_delete_guard BEFORE DELETE ON synced_group_lifecycle BEGIN
  SELECT RAISE(ABORT,'Persistent group lifecycle cannot be deleted');
END;
CREATE TRIGGER trg_synced_lifecycle_group_identity BEFORE UPDATE OF id,creation_id,created_at,origin_json ON synced_groups
WHEN NEW.id IS NOT OLD.id OR NEW.creation_id IS NOT OLD.creation_id OR NEW.created_at IS NOT OLD.created_at OR NEW.origin_json IS NOT OLD.origin_json BEGIN
  SELECT RAISE(ABORT,'Lifecycle incarnation and origin are immutable');
END;
CREATE TRIGGER trg_synced_lifecycle_journal_update BEFORE UPDATE ON synced_host_history
WHEN EXISTS(SELECT 1 FROM synced_group_lifecycle WHERE create_history_id=OLD.id) BEGIN
  SELECT RAISE(ABORT,'A lifecycle create journal cannot be rewritten');
END;
CREATE TRIGGER trg_synced_retirement_insert_guard BEFORE INSERT ON synced_group_retirements BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM synced_group_lifecycle l WHERE l.group_id=NEW.group_id
    AND l.creation_id=NEW.creation_id AND l.state='active' AND l.exposure_state='never'
    AND l.create_history_id=NEW.create_history_id AND l.activation_hash=NEW.semantic_hash)
    THEN RAISE(ABORT,'Frozen retirement must belong to its unpublished create journal') END;
END;
CREATE TRIGGER trg_synced_retirement_update_guard BEFORE UPDATE ON synced_group_retirements BEGIN
  SELECT RAISE(ABORT,'Frozen retirement cannot be rewritten');
END;
CREATE TRIGGER trg_synced_retirement_delete_guard BEFORE DELETE ON synced_group_retirements
WHEN NOT EXISTS(SELECT 1 FROM synced_group_lifecycle WHERE group_id=OLD.group_id AND state='active') BEGIN
  SELECT RAISE(ABORT,'Retirement remains frozen until reactivation');
END;
CREATE TRIGGER trg_synced_lifecycle_canonical_insert BEFORE INSERT ON synced_group_blocks
WHEN NOT EXISTS(SELECT 1 FROM synced_group_lifecycle WHERE group_id=NEW.group_id AND state='active') BEGIN
  SELECT RAISE(ABORT,'Canonical bodies require an active lifecycle');
END;
CREATE TRIGGER trg_synced_lifecycle_canonical_update BEFORE UPDATE OF group_id ON synced_group_blocks
WHEN NOT EXISTS(SELECT 1 FROM synced_group_lifecycle WHERE group_id=NEW.group_id AND state='active') BEGIN
  SELECT RAISE(ABORT,'Canonical bodies require an active lifecycle');
END;
CREATE TRIGGER trg_synced_lifecycle_instance_insert BEFORE INSERT ON synced_instances
WHEN NOT EXISTS(SELECT 1 FROM synced_group_lifecycle WHERE group_id=NEW.group_id AND state='active') BEGIN
  SELECT RAISE(ABORT,'Instances require an active lifecycle');
END;
CREATE TRIGGER trg_synced_lifecycle_instance_update BEFORE UPDATE OF group_id ON synced_instances
WHEN NOT EXISTS(SELECT 1 FROM synced_group_lifecycle WHERE group_id=NEW.group_id AND state='active') BEGIN
  SELECT RAISE(ABORT,'Instances require an active lifecycle');
END;
CREATE TRIGGER trg_synced_exposure_attempt_insert BEFORE INSERT ON synced_exposure_attempts
WHEN NEW.state<>'possible' OR NEW.confirmed_at IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'Publication must begin with durable possible evidence');
END;
CREATE TRIGGER trg_synced_exposure_attempt_update BEFORE UPDATE ON synced_exposure_attempts BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.channel IS NOT OLD.channel
    OR NEW.target_fingerprint IS NOT OLD.target_fingerprint OR NEW.publication_hash IS NOT OLD.publication_hash
    OR NEW.created_at IS NOT OLD.created_at OR OLD.state<>'possible' OR NEW.state<>'confirmed'
    OR NOT EXISTS(SELECT 1 FROM synced_group_exposure_members WHERE attempt_id=OLD.id)
    THEN RAISE(ABORT,'Publication evidence is immutable except for confirmation') END;
END;
CREATE TRIGGER trg_synced_exposure_attempt_delete BEFORE DELETE ON synced_exposure_attempts BEGIN
  SELECT RAISE(ABORT,'Possible publication evidence cannot be deleted');
END;
CREATE TRIGGER trg_synced_exposure_member_insert BEFORE INSERT ON synced_group_exposure_members BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM synced_exposure_attempts WHERE id=NEW.attempt_id AND state='possible')
    OR NOT EXISTS(SELECT 1 FROM synced_groups g JOIN synced_group_lifecycle l ON l.group_id=g.id
      WHERE g.id=NEW.group_id AND g.creation_id=NEW.creation_id AND l.creation_id=NEW.creation_id
      AND l.state='active' AND g.revision=NEW.revision AND g.topology_revision=NEW.topology_revision)
    THEN RAISE(ABORT,'Publication members require an exact active incarnation and CAS') END;
END;
CREATE TRIGGER trg_synced_exposure_member_update BEFORE UPDATE ON synced_group_exposure_members BEGIN
  SELECT RAISE(ABORT,'Publication members cannot be changed');
END;
CREATE TRIGGER trg_synced_exposure_member_delete BEFORE DELETE ON synced_group_exposure_members BEGIN
  SELECT RAISE(ABORT,'Publication members cannot be deleted');
END;
CREATE TRIGGER trg_synced_exposure_member_mark_possible AFTER INSERT ON synced_group_exposure_members BEGIN
  UPDATE synced_group_lifecycle SET exposure_state='possible',state_version=state_version+1,
    updated_at=(SELECT created_at FROM synced_exposure_attempts WHERE id=NEW.attempt_id)
    WHERE group_id=NEW.group_id AND exposure_state IN ('never','unknown');
END;
CREATE TRIGGER trg_synced_exposure_attempt_mark_confirmed AFTER UPDATE OF state ON synced_exposure_attempts BEGIN
  UPDATE synced_group_lifecycle SET exposure_state='confirmed',state_version=state_version+1,updated_at=NEW.confirmed_at
    WHERE group_id IN (SELECT group_id FROM synced_group_exposure_members WHERE attempt_id=NEW.id) AND exposure_state<>'confirmed';
END;
`
const required = [
  ...Array.from(tables.matchAll(/CREATE TABLE ([a-z_]+) \([\s\S]*?\n\);/g), match => ({ name: match[1], sql: match[0], type: 'table' })),
  ...Array.from(tables.matchAll(/CREATE INDEX ([a-z_]+) [^;]+;/g), match => ({ name: match[1], sql: match[0], type: 'index' })),
  ...Array.from(guards.matchAll(/CREATE TRIGGER ([a-z_]+) [\s\S]*?\nEND;/g), match => ({ name: match[1], sql: match[0], type: 'trigger' }))
]
const comparable = (sql: string): string => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '')

/** No DDL or data repairs. Schema-26 authority is verified separately and stays
 * byte-for-byte unchanged; these checks only add the schema-27 namespace. */
export function assertSyncedLifecycleSchema(db: Database.Database): void {
  const rows = db.prepare(`SELECT name,type,sql FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(required.map(item => item.name))) as Array<{ name: string; type: string; sql: string | null }>
  const actual = new Map(rows.map(row => [row.name, row]))
  for (const item of required) {
    const row = actual.get(item.name)
    if (!row || row.type !== item.type || row.sql === null || comparable(row.sql) !== comparable(item.sql)) {
      throw new Error(`同步块 schema27 缺少或损坏关键结构：${item.name}；不会自动重建生命周期。`)
    }
  }
  // The read-only startup assertion must cover orphan rows even in a database
  // with zero real groups. Coverage/selected-group reads cannot discover those,
  // and foreign_keys=ON does not retroactively validate pre-existing rows.
  for (const item of required) if (item.type === 'table') {
    if ((db.pragma(`foreign_key_check(${item.name})`) as unknown[]).length) {
      throw new Error(`同步块 schema27 生命周期外键校验失败：${item.name}；不会自动修复状态。`)
    }
  }
  assertSyncedLifecycleCoverage(db)
  if (db.prepare(`SELECT 1 FROM synced_exposure_attempts a WHERE NOT EXISTS(
    SELECT 1 FROM synced_group_exposure_members m WHERE m.attempt_id=a.id) LIMIT 1`).get()) {
    throw new Error('同步块 schema27 存在没有准确参与组的发布记录；不会丢弃可能曝光证据。')
  }
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
