import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface SyncedSchemaOptions {
  workspaceScope?: string
  recoveryEpoch?: string
  now?: string
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const tables = `
CREATE TABLE IF NOT EXISTS block_identities (
  id TEXT PRIMARY KEY NOT NULL,
  last_owner_kind TEXT NOT NULL CHECK (last_owner_kind IN ('document', 'group', 'reserved')),
  last_owner_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live', 'retained')),
  created_at TEXT,
  CHECK (length(CAST(id AS BLOB)) > 0 AND length(CAST(last_owner_id AS BLOB)) > 0),
  CHECK (state <> 'live' OR (last_owner_kind <> 'reserved' AND created_at IS NOT NULL)),
  CHECK (last_owner_kind <> 'reserved' OR state = 'retained')
);
CREATE INDEX IF NOT EXISTS idx_block_identities_owner ON block_identities(last_owner_kind, last_owner_id, state);

CREATE TABLE IF NOT EXISTS synced_workspace_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  workspace_scope TEXT NOT NULL,
  recovery_epoch TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS synced_groups (
  id TEXT PRIMARY KEY NOT NULL,
  creation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  origin_json TEXT NOT NULL CHECK (json_valid(origin_json) AND json_type(origin_json) = 'object'),
  bindings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(bindings_json) AND json_type(bindings_json) = 'array'),
  revision TEXT NOT NULL,
  topology_revision TEXT NOT NULL,
  history_cursor TEXT NOT NULL,
  history_position INTEGER NOT NULL DEFAULT 0 CHECK (typeof(history_position) = 'integer' AND history_position >= 0)
);
CREATE TABLE IF NOT EXISTS synced_group_blocks (
  id TEXT PRIMARY KEY NOT NULL REFERENCES block_identities(id),
  group_id TEXT NOT NULL REFERENCES synced_groups(id) ON DELETE CASCADE,
  parent_block_id TEXT,
  sort_order INTEGER NOT NULL CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
  type TEXT NOT NULL CHECK (type <> 'synced-block'),
  content TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
  depth INTEGER NOT NULL DEFAULT 0 CHECK (typeof(depth) = 'integer' AND depth BETWEEN 0 AND 6),
  tags_json TEXT CHECK (tags_json IS NULL OR (json_valid(tags_json) AND json_type(tags_json) = 'array')),
  language TEXT,
  list_start INTEGER,
  markdown_format_json TEXT,
  highlight TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(id, group_id),
  FOREIGN KEY(parent_block_id, group_id) REFERENCES synced_group_blocks(id, group_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_synced_group_blocks_order ON synced_group_blocks(group_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_synced_group_blocks_parent ON synced_group_blocks(parent_block_id);
CREATE TABLE IF NOT EXISTS synced_instances (
  instance_id TEXT PRIMARY KEY NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES synced_groups(id) ON DELETE RESTRICT,
  host_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  binding_version TEXT NOT NULL,
  parent_block_id TEXT,
  depth INTEGER NOT NULL CHECK (typeof(depth) = 'integer' AND depth BETWEEN 0 AND 6)
);
CREATE INDEX IF NOT EXISTS idx_synced_instances_group ON synced_instances(group_id);
CREATE INDEX IF NOT EXISTS idx_synced_instances_host ON synced_instances(host_document_id);

CREATE TABLE IF NOT EXISTS synced_operations (
  client_operation_id TEXT PRIMARY KEY NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS synced_group_history (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES synced_groups(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position > 0),
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(group_id, position)
);
CREATE TABLE IF NOT EXISTS synced_host_history (
  id TEXT PRIMARY KEY NOT NULL,
  action_json TEXT NOT NULL CHECK (json_valid(action_json)),
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS synced_host_history_documents (
  history_id TEXT NOT NULL REFERENCES synced_host_history(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position > 0),
  PRIMARY KEY(history_id, document_id),
  UNIQUE(document_id, position)
);
CREATE TABLE IF NOT EXISTS synced_host_history_state (
  document_id TEXT PRIMARY KEY NOT NULL,
  cursor TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0 CHECK (typeof(position) = 'integer' AND position >= 0)
);
CREATE TABLE IF NOT EXISTS synced_group_pins (
  group_id TEXT NOT NULL REFERENCES synced_groups(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  pin_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(group_id, kind, pin_id)
);
CREATE INDEX IF NOT EXISTS idx_synced_group_pins_owner ON synced_group_pins(kind, pin_id);
`

type Candidate = { owners: Set<string>; times: Map<string, Set<string>>; sources: Set<string> }
type MoveOwner = { owner: string; time: number; rowid: number; createdAt: string | null }
type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const timestamp = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null

function parseJson(json: string, source: string): unknown {
  try { return JSON.parse(json) as unknown }
  catch (cause) { throw new Error(`同步块身份迁移无法读取 ${source}；原数据尚未迁移。`, { cause }) }
}

/** Snapshots reserve identity, but their checkpoint time is not a block birth time. */
function backfillIdentities(db: Database.Database): void {
  db.exec(`INSERT OR IGNORE INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at)
    SELECT id,'document',document_id,'live',created_at FROM blocks`)
  if (db.prepare(`SELECT 1 FROM blocks b LEFT JOIN block_identities i ON i.id=b.id
    WHERE i.id IS NULL OR i.state<>'live' OR i.last_owner_kind<>'document'
      OR i.last_owner_id<>b.document_id OR i.created_at IS NOT b.created_at LIMIT 1`).get()) {
    throw new Error('普通块与全局身份不一致，已拒绝同步块迁移。')
  }
  const candidates = new Map<string, Candidate>(), moves = new Map<string, MoveOwner>()
  const reserve = (id: string, source: string, owner: string | null = null, createdAt: string | null = null) => {
    if (!validId(id)) throw new Error(`同步块身份迁移发现无效块身份：${source}`)
    let candidate = candidates.get(id)
    if (!candidate) { candidate = { owners: new Set(), times: new Map(), sources: new Set() }; candidates.set(id, candidate) }
    candidate.sources.add(source)
    if (owner !== null) {
      candidate.owners.add(owner)
      if (createdAt !== null) {
        let times = candidate.times.get(owner)
        if (!times) { times = new Set(); candidate.times.set(owner, times) }
        times.add(createdAt)
      }
    }
  }
  const blocks = (value: unknown, source: string, owner: string | null): JsonObject[] => {
    const list = object(value)?.blocks
    if (!Array.isArray(list)) throw new Error(`同步块身份迁移发现无效正文快照：${source}`)
    return Array.from(list, item => {
      const block = object(item)
      if (!block) throw new Error(`同步块身份迁移发现无效块快照：${source}`)
      if (block.id !== undefined) {
        if (!validId(block.id)) throw new Error(`同步块身份迁移发现无效块身份：${source}`)
        reserve(block.id, source, owner, timestamp(block.createdAt) ?? timestamp(block.created_at))
      }
      return block
    })
  }
  for (const row of db.prepare('SELECT id,document_id,content_json FROM document_history').all() as Array<{ id: string; document_id: string; content_json: string }>) {
    blocks(parseJson(row.content_json, `history:${row.id}`), `history:${row.id}`, row.document_id)
  }
  for (const row of db.prepare('SELECT id,snapshot_json FROM document_trash').all() as Array<{ id: string; snapshot_json: string }>) {
    const source = `trash:${row.id}`, snapshot = object(parseJson(row.snapshot_json, source))
    if (!snapshot || object(snapshot.document)?.id !== row.id) throw new Error(`同步块身份迁移发现无效回收站归属：${source}`)
    blocks(snapshot.content, source, row.id)
  }
  for (const row of db.prepare('SELECT rowid,id,state,moved_ids_json,before_json,after_json,updated_at FROM document_block_moves').all() as Array<{
    rowid: number; id: string; state: string; moved_ids_json: string; before_json: string; after_json: string; updated_at: string
  }>) {
    const source = `move:${row.id}`
    const readSide = (json: string): Array<{ owner: string; blocks: JsonObject[] }> => {
      const side = parseJson(json, source)
      if (!Array.isArray(side)) throw new Error(`同步块身份迁移发现无效移动快照：${source}`)
      return Array.from(side, value => {
        const snapshot = object(value)
        if (!snapshot || !validId(snapshot.documentId)) throw new Error(`同步块身份迁移发现无效移动归属：${source}`)
        return { owner: snapshot.documentId, blocks: blocks(snapshot.content, source, snapshot.documentId) }
      })
    }
    const before = readSide(row.before_json), after = readSide(row.after_json)
    if (row.state !== 'applied' && row.state !== 'undone') throw new Error(`同步块身份迁移发现无效移动状态：${source}`)
    const ids = parseJson(row.moved_ids_json, source)
    if (!Array.isArray(ids) || !Array.from(ids).every(validId)) throw new Error(`同步块身份迁移发现无效移动身份：${source}`)
    const side = row.state === 'applied' ? after : before
    for (const id of ids as string[]) {
      const owners = side.flatMap(snapshot => snapshot.blocks.flatMap(block => block.id === id ? [{ owner: snapshot.owner, block }] : []))
      if (owners.length !== 1) throw new Error(`同步块身份迁移无法确认移动后的唯一归属：${source}`)
      const time = Date.parse(row.updated_at)
      if (!Number.isFinite(time)) throw new Error(`同步块身份迁移发现无效移动时间：${source}`)
      const previous = moves.get(id)
      if (!previous || time > previous.time || time === previous.time && row.rowid > previous.rowid) {
        moves.set(id, { owner: owners[0].owner, time, rowid: row.rowid,
          createdAt: timestamp(owners[0].block.createdAt) ?? timestamp(owners[0].block.created_at) })
      }
    }
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_templates'").get()) {
    for (const row of db.prepare('SELECT id,blocks_json FROM document_templates').all() as Array<{ id: string; blocks_json: string }>) {
      blocks({ blocks: parseJson(row.blocks_json, `template:${row.id}`) }, `template:${row.id}`, null)
    }
  }
  for (const row of db.prepare("SELECT lineage,target_id FROM backup_restore_identities WHERE kind='block'").all() as Array<{ lineage: string; target_id: string }>) {
    reserve(row.target_id, `backup:${row.lineage}`, null)
  }
  for (const row of db.prepare('SELECT document_path,block_id FROM document_block_routes').all() as Array<{ document_path: string; block_id: string }>) {
    reserve(row.block_id, `route:${row.document_path}`, null)
  }
  const insert = db.prepare(`INSERT OR IGNORE INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,?,?,'retained',?)`)
  const existing = db.prepare('SELECT 1 FROM block_identities WHERE id=?')
  for (const [id, candidate] of candidates) {
    // A repeated installer must not run a retained candidate through the live
    // identity guards, or replace an already authoritative canonical owner.
    if (existing.get(id)) continue
    const move = moves.get(id)
    const owner = move?.owner ?? (candidate.owners.size === 1 ? [...candidate.owners][0] : null)
    const knownTimes = owner === null ? undefined : candidate.times.get(owner)
    const createdAt = move?.createdAt ?? (knownTimes?.size === 1 ? [...knownTimes][0] : null)
    insert.run(id, owner === null ? 'reserved' : 'document', owner ?? [...candidate.sources].sort()[0], createdAt)
  }
}

function migrateRoutes(db: Database.Database): void {
  const keys = db.pragma('foreign_key_list(document_block_routes)') as Array<{ table: string; from: string }>
  if (keys.length === 1 && keys[0].table === 'block_identities' && keys[0].from === 'block_id') return
  if (keys.length !== 1 || keys[0].table !== 'blocks' || keys[0].from !== 'block_id') {
    throw new Error('块链接路由表的外键与预期不符，已拒绝迁移。')
  }
  // Do not rename/drop blocks: its original FK would cascade away old routes.
  db.exec(`CREATE TABLE document_block_routes_schema26 (
    document_path TEXT NOT NULL,
    block_id TEXT NOT NULL REFERENCES block_identities(id) ON DELETE RESTRICT,
    PRIMARY KEY(document_path,block_id)
  );
  INSERT INTO document_block_routes_schema26(document_path,block_id) SELECT document_path,block_id FROM document_block_routes;
  DROP TABLE document_block_routes;
  ALTER TABLE document_block_routes_schema26 RENAME TO document_block_routes;`)
}

function physicalIdentityTriggers(table: 'blocks' | 'synced_group_blocks', kind: 'document' | 'group', owner: 'document_id' | 'group_id'): string {
  const other = table === 'blocks' ? 'synced_group_blocks' : 'blocks'
  return `
CREATE TRIGGER IF NOT EXISTS trg_synced_${table}_identity_insert_guard BEFORE INSERT ON ${table} BEGIN
  SELECT CASE WHEN typeof(NEW.id)<>'text' OR length(CAST(NEW.id AS BLOB))=0 THEN RAISE(ABORT,'Invalid block identity') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ${other} WHERE id=NEW.id) THEN RAISE(ABORT,'Block identity has another physical owner') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM block_identities WHERE id=NEW.id AND
    (last_owner_kind<>'${kind}' OR last_owner_id<>NEW.${owner})) THEN RAISE(ABORT,'Block identity is retained by another owner') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM block_identities WHERE id=NEW.id AND created_at IS NOT NULL AND created_at IS NOT NEW.created_at)
    THEN RAISE(ABORT,'Block creation time must be preserved') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_synced_${table}_identity_insert AFTER INSERT ON ${table} BEGIN
  INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at)
    VALUES(NEW.id,'${kind}',NEW.${owner},'live',NEW.created_at)
    ON CONFLICT(id) DO UPDATE SET last_owner_kind=excluded.last_owner_kind,last_owner_id=excluded.last_owner_id,
      state='live',created_at=coalesce(block_identities.created_at,excluded.created_at);
END;
CREATE TRIGGER IF NOT EXISTS trg_synced_${table}_identity_update_guard BEFORE UPDATE OF id,created_at ON ${table} BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id THEN RAISE(ABORT,'Block identity cannot be changed in place') END;
  SELECT CASE WHEN NEW.created_at IS NOT OLD.created_at THEN RAISE(ABORT,'Block creation time cannot be changed in place') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_synced_${table}_identity_delete AFTER DELETE ON ${table} BEGIN
  UPDATE block_identities SET state='retained' WHERE id=OLD.id AND last_owner_kind='${kind}' AND last_owner_id=OLD.${owner};
END;`
}

const identityTriggers = `
CREATE TRIGGER IF NOT EXISTS trg_synced_identity_delete BEFORE DELETE ON block_identities BEGIN
  SELECT RAISE(ABORT,'Stable block identities cannot be deleted');
END;
CREATE TRIGGER IF NOT EXISTS trg_synced_identity_id_update BEFORE UPDATE OF id ON block_identities WHEN NEW.id IS NOT OLD.id BEGIN
  SELECT RAISE(ABORT,'Stable block identities cannot be renamed');
END;
CREATE TRIGGER IF NOT EXISTS trg_synced_blocks_owner_update AFTER UPDATE OF document_id ON blocks BEGIN
  UPDATE block_identities SET last_owner_kind='document',last_owner_id=NEW.document_id WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_synced_group_blocks_owner_update BEFORE UPDATE OF group_id ON synced_group_blocks WHEN NEW.group_id IS NOT OLD.group_id BEGIN
  SELECT RAISE(ABORT,'Canonical ownership requires an explicit retained identity transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_synced_blocks_instance_update BEFORE UPDATE OF document_id,parent_block_id,depth,type,content ON blocks
WHEN EXISTS(SELECT 1 FROM synced_instances WHERE instance_id=OLD.id) AND
  (NEW.document_id IS NOT OLD.document_id OR NEW.parent_block_id IS NOT OLD.parent_block_id OR NEW.depth IS NOT OLD.depth
    OR NEW.type IS NOT OLD.type OR NEW.content IS NOT OLD.content) BEGIN
  SELECT RAISE(ABORT,'Registered reference changes require an atomic instance transition');
END;
CREATE TRIGGER IF NOT EXISTS trg_synced_blocks_leaf_insert BEFORE INSERT ON blocks
WHEN NEW.parent_block_id IS NOT NULL AND EXISTS(SELECT 1 FROM blocks WHERE id=NEW.parent_block_id AND type='synced-block') BEGIN
  SELECT RAISE(ABORT,'A synced reference cannot own physical children');
END;
CREATE TRIGGER IF NOT EXISTS trg_synced_blocks_leaf_update BEFORE UPDATE OF parent_block_id ON blocks
WHEN NEW.parent_block_id IS NOT NULL AND EXISTS(SELECT 1 FROM blocks WHERE id=NEW.parent_block_id AND type='synced-block') BEGIN
  SELECT RAISE(ABORT,'A synced reference cannot own physical children');
END;
`

function consistencyTriggers(): string {
  const physical = (row: 'NEW') => `
    EXISTS(SELECT 1 FROM blocks b WHERE b.id=${row}.id AND (${row}.state<>'live' OR ${row}.last_owner_kind<>'document'
      OR ${row}.last_owner_id<>b.document_id OR ${row}.created_at IS NOT b.created_at))
    OR EXISTS(SELECT 1 FROM synced_group_blocks b WHERE b.id=${row}.id AND (${row}.state<>'live' OR ${row}.last_owner_kind<>'group'
      OR ${row}.last_owner_id<>b.group_id OR ${row}.created_at IS NOT b.created_at))
    OR (${row}.state='live' AND NOT EXISTS(SELECT 1 FROM blocks WHERE id=${row}.id)
      AND NOT EXISTS(SELECT 1 FROM synced_group_blocks WHERE id=${row}.id))`
  return ['INSERT', 'UPDATE'].map(operation => `
CREATE TRIGGER IF NOT EXISTS trg_synced_identity_${operation.toLowerCase()}_consistency BEFORE ${operation} ON block_identities
WHEN ${physical('NEW')} BEGIN
  SELECT RAISE(ABORT,'Block identity must agree with its current physical owner and creation time');
END;`).join('\n')
}

function instanceTriggers(): string {
  return ['INSERT', 'UPDATE'].map(operation => `
CREATE TRIGGER IF NOT EXISTS trg_synced_instance_${operation.toLowerCase()}_guard BEFORE ${operation} ON synced_instances BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM blocks b WHERE b.id=NEW.instance_id AND b.document_id=NEW.host_document_id
    AND b.parent_block_id IS NEW.parent_block_id AND b.depth=NEW.depth AND b.type='synced-block'
    AND json_valid(b.content) AND json_extract(b.content,'$.version')=1 AND json_type(b.content,'$.version')='integer'
    AND json_extract(b.content,'$.groupId')=NEW.group_id AND json_type(b.content,'$.groupId')='text'
    AND (SELECT count(*) FROM json_each(b.content))=2
    AND NOT EXISTS(SELECT 1 FROM blocks child WHERE child.parent_block_id=b.id))
    THEN RAISE(ABORT,'Synced instance must match its real host leaf and payload') END;
END;`).join('\n')
}

const guards = physicalIdentityTriggers('blocks', 'document', 'document_id')
  + physicalIdentityTriggers('synced_group_blocks', 'group', 'group_id')
  + identityTriggers + consistencyTriggers() + instanceTriggers()
const requiredTables = Array.from(tables.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \([\s\S]*?\n\);/g),
  match => ({ name: match[1], sql: match[0] }))
const requiredTriggers = Array.from(guards.matchAll(/CREATE TRIGGER IF NOT EXISTS ([a-z_]+) [\s\S]*?\nEND;/g),
  match => ({ name: match[1], sql: match[0] }))
function comparableSql(sql: string): string {
  return sql.replace(/\bIF NOT EXISTS\s+/gi, '').replace(/\s+/g, ' ').trim().replace(/;$/, '')
}

/** A version-26 database must already contain its authority and guards. This is
 * metadata-only: do not repair a missing namespace or scan user content here. */
export function assertSyncedBlockSchema(db: Database.Database): void {
  const required = [...requiredTables.map(table => ({ ...table, type: 'table' })),
    ...requiredTriggers.map(trigger => ({ ...trigger, type: 'trigger' }))]
  const rows = db.prepare(`SELECT name,type,sql FROM sqlite_master
    WHERE name IN (SELECT value FROM json_each(?))`).all(JSON.stringify(required.map(item => item.name))) as
    Array<{ name: string; type: string; sql: string | null }>
  const actual = new Map(rows.map(row => [row.name, row]))
  for (const item of required) {
    const row = actual.get(item.name)
    if (!row || row.type !== item.type || row.sql === null || comparableSql(row.sql) !== comparableSql(item.sql)) {
      throw new Error(`同步块 schema26 缺少或损坏关键结构：${item.name}；不会自动重建身份。`)
    }
  }
  const keys = db.pragma('foreign_key_list(document_block_routes)') as Array<{ table: string; from: string; to: string; on_delete: string }>
  if (keys.length !== 1 || keys[0].table !== 'block_identities' || keys[0].from !== 'block_id'
    || keys[0].to !== 'id' || keys[0].on_delete !== 'RESTRICT') {
    throw new Error('同步块 schema26 的稳定身份路由外键缺失或损坏。')
  }
  const workspace = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
    { workspace_scope: string; recovery_epoch: string } | undefined
  if (!workspace || !uuid.test(workspace.workspace_scope) || !uuid.test(workspace.recovery_epoch)) {
    throw new Error('持久同步块工作区身份缺失或无效；不会创建替代命名空间。')
  }
}

/** This foundation cannot export canonical bodies yet. A later same-schema
 * build may enable them; this reader must refuse that data before any write.
 * Remove this gate only when the complete group persistence/export is wired. */
export function assertNoUnsupportedSyncedContent(db: Database.Database): void {
  if (db.prepare('SELECT 1 FROM synced_groups LIMIT 1').get() || (db.pragma('user_version', { simple: true }) as number) >= 27
    && db.prepare("SELECT 1 FROM synced_exposure_attempts WHERE channel='logical-deletion-denial-v1' LIMIT 1").get()) {
    throw new Error('此构建尚不支持数据库中已启用的同步块正文，请使用支持同步块的完整版本；原数据未修改。')
  }
}

/** Called only inside the safety-copy owner's migration transaction, after the
 * legacy appSchema/column migrations. It neither opens a transaction nor changes
 * user_version. All identity/route work precedes installation of write guards. */
export function installSyncedBlockSchema(db: Database.Database, options: SyncedSchemaOptions = {}): void {
  if (!db.inTransaction) throw new Error('同步块迁移必须由外层安全副本事务调用。')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('同步块迁移要求启用 SQLite 外键。')
  const workspaceScope = options.workspaceScope ?? randomUUID(), recoveryEpoch = options.recoveryEpoch ?? randomUUID()
  const now = options.now ?? new Date().toISOString()
  if (!uuid.test(workspaceScope) || !uuid.test(recoveryEpoch) || timestamp(now) === null) throw new Error('同步块工作区身份或时间无效。')
  db.exec(tables)
  backfillIdentities(db)
  migrateRoutes(db)
  db.prepare('INSERT OR IGNORE INTO synced_workspace_state(singleton,workspace_scope,recovery_epoch,created_at) VALUES(1,?,?,?)')
    .run(workspaceScope, recoveryEpoch, now)
  db.exec(guards)
  assertSyncedBlockSchema(db)
  if ((db.pragma('foreign_key_check(document_block_routes)') as unknown[]).length) throw new Error('同步块路由迁移的外键校验失败。')
}
