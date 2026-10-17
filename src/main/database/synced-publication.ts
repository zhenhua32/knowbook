import type Database from 'better-sqlite3'
import type { SyncedGroupSnapshot, SyncedGroupWire } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, SYNCED_MAX_BLOCKS } from '../../shared/syncedBlockValidation'
import { validateSyncedWorkspaceGraph } from '../../shared/syncedBlockGraph'
import { assertSyncedBlockSchema } from './synced-schema'
import { assertSyncedLifecycleCoverage, readSyncedGroupLifecycles, syncedLifecycleSemanticHash } from './synced-lifecycle-state'
import { getSyncedGroupSnapshots } from './synced-blocks-read'
import { readStrictHostDocument } from './synced-host-document-read'
import { assertSyncedStoredBindings } from './synced-block-links'
import { SYNC_TABLE_COLUMNS, SYNC_TABLES, type SyncDatabases } from '../sync/model'
import { SyncedPublicationError, publicationHash, publicationInvalid, publicationJson, publicationCompare,
  frozenPublicationFacts, validateInitialRecord, validatePublicationDescriptor, mapPublicationCatalog, validatePublicationCatalog,
  type InitialPublicationRecord, type PublicationDescriptor, type PublicationMember } from '../sync/synced-publication-model'

export interface SyncedPublicationCapture { readonly kind: 'synced-publication-capture' }
export interface SyncedPublicationClaim { readonly kind: 'synced-publication-claim' }
export interface SyncedPublicationLocalSnapshot {
  workspaceScope: string; recoveryEpoch: string; localFingerprint: string; catalogId: string
  records: InitialPublicationRecord[]
  groups: Array<{ wire: SyncedGroupWire; revision: string; topologyRevision: string; semanticHash: string }>
}
type Identity = { workspaceScope: string; recoveryEpoch: string }
type Capture = { db: Database.Database; snapshot: SyncedPublicationLocalSnapshot }
type Claim = { db: Database.Database; attemptId: string; descriptor: PublicationDescriptor; publicationHash: string; requestHash: string }
type AttemptRow = { id: string; request_hash: string; channel: string; target_fingerprint: string; publication_hash: string;
  state: string; created_at: string; confirmed_at: string | null }
type MemberRow = { attempt_id: string; group_id: string; creation_id: string; revision: string; topology_revision: string; semantic_hash: string }
const captures = new WeakMap<SyncedPublicationCapture, Capture>(), claims = new WeakMap<SyncedPublicationClaim, Claim>()
function unavailable(message: string): never { throw new SyncedPublicationError('unavailable', message) }
function database<T>(run: () => T): T {
  try { return run() } catch (cause) {
    if (cause instanceof SyncedPublicationError) throw cause
    const sql = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && cause.code.startsWith('SQLITE')
    throw new SyncedPublicationError(sql ? 'database' : 'invalid', sql ? '原 connection SQLite 事务失败。' : '完整持久快照或状态损坏。', cause)
  }
}
function outer(db: Database.Database): void {
  if (db.inTransaction) return publicationInvalid('不接受调用方已开启的事务。')
  if (db.readonly) return unavailable('只读 connection 不具备本片发布/确认权限。')
  if (!db.open) return unavailable('数据库 connection 已关闭。')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) return publicationInvalid('外键保护未开启。')
}
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
/** Readonly core, consumed inside the caller's owned transaction; never mints write authority. */
export function readSyncedPersistentPublicationSnapshot(db: Database.Database): SyncedPublicationLocalSnapshot {
  if (!db.inTransaction) return publicationInvalid('完整持久图读取须位于调用方自有一致事务。')
  assertSyncedBlockSchema(db); assertSyncedLifecycleCoverage(db)
  const foreignKeys = db.pragma('foreign_key_check')
  if (!Array.isArray(foreignKeys) || foreignKeys.length) return publicationInvalid('完整数据库存在外键损坏。')
  const context = identity(db)
  const ids = (db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{ id: unknown }>).map(row => {
    if (!isSyncedUuid(row.id)) return publicationInvalid('真实同步组身份无效。'); return row.id
  })
  const life = new Map<string, ReturnType<typeof readSyncedGroupLifecycles> extends Map<string, infer T> ? T : never>()
  const groups: SyncedPublicationLocalSnapshot['groups'] = [], snapshots: SyncedGroupSnapshot[] = []
  for (let from = 0; from < ids.length; from += SYNCED_MAX_BLOCKS) {
    const batch = ids.slice(from, from + SYNCED_MAX_BLOCKS)
    for (const [id, item] of readSyncedGroupLifecycles(db, batch)) life.set(id, item)
    const read = getSyncedGroupSnapshots(db, { groupIds: batch })
    if (read.workspaceScope !== context.workspaceScope) return publicationInvalid('组列表不属于原 workspace。')
    for (const item of read.items) {
      if (item.status === 'ready') {
        if (life.get(item.snapshot.groupId)?.state !== 'active') return publicationInvalid('活动组与 lifecycle 不一致。')
        assertSyncedStoredBindings(db, item.snapshot.origin, item.snapshot.blocks, item.snapshot.bindings)
        const body = wire(item.snapshot)
        groups.push({ wire: body, revision: item.snapshot.revision, topologyRevision: item.snapshot.topologyRevision, semanticHash: syncedLifecycleSemanticHash(body) })
        snapshots.push(item.snapshot)
      } else if (life.get(item.groupId)?.state !== 'retired-create') return publicationInvalid('真实活动组不能被丢成 missing。')
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
    documentFacts, actualOwners, actualInstances, lifecycleContent }))
  return { ...context, localFingerprint, catalogId: setting.value, records: orderedRecords, groups }
}
export function captureSyncedPublicationSnapshot(db: Database.Database):
  { status: 'ready'; capture: SyncedPublicationCapture } | { status: 'unsupported'; reason: 'schema-27-required' | 'no-active-groups' } {
  outer(db)
  const version = db.pragma('user_version', { simple: true })
  if (version === 26) { database(() => assertSyncedBlockSchema(db)); return { status: 'unsupported', reason: 'schema-27-required' } }
  if (version !== 27) return publicationInvalid('未知、未来或损坏的数据库版本；不会迁移或修复。')
  return database(() => db.transaction(() => {
    const snapshot = readSyncedPersistentPublicationSnapshot(db)
    if (!snapshot.groups.length) return { status: 'unsupported' as const, reason: 'no-active-groups' as const }
    const capture = Object.freeze({ kind: 'synced-publication-capture' as const })
    captures.set(capture, { db, snapshot }); return { status: 'ready' as const, capture }
  })())
}
export function readSyncedPublicationCapture(capture: SyncedPublicationCapture): SyncedPublicationLocalSnapshot | null {
  const item = captures.get(capture); return item ? frozenPublicationFacts(item.snapshot) : null
}
export function syncedPublicationRequestHash(attemptId: string, descriptor: PublicationDescriptor): string {
  return publicationHash(publicationJson({ kind: 'synced-initial-publication', version: 1, attemptId,
    workspaceScope: descriptor.workspaceScope, recoveryEpoch: descriptor.recoveryEpoch, targetFingerprint: descriptor.targetFingerprint,
    publicationHash: publicationHash(publicationJson(descriptor)), expectedRemote: { kind: 'missing' } }))
}
function assertMembers(snapshot: SyncedPublicationLocalSnapshot, descriptor: PublicationDescriptor): void {
  const expected = snapshot.groups.map(item => ({ groupId: item.wire.id, creationId: item.wire.creationId,
    revision: item.revision, topologyRevision: item.topologyRevision, semanticHash: item.semanticHash }))
  const actual = descriptor.members.map(({ portableHash: _portableHash, ...member }) => member)
  if (publicationJson(expected) !== publicationJson(actual)) return publicationInvalid('claim成员不是原全部 active 组。')
}
export function bindSyncedPublicationCapture(db: Database.Database, capture: SyncedPublicationCapture,
  input: { attemptId: string; descriptor: PublicationDescriptor }): SyncedPublicationClaim {
  outer(db); assertSyncedShape(input, ['attemptId', 'descriptor'])
  if (!isSyncedUuid(input.attemptId)) return publicationInvalid('发布 attempt UUID 无效。')
  const saved = captures.get(capture)
  if (!saved || saved.db !== db) return unavailable('不是本原 connection 的真实捕获。')
  const descriptor = validatePublicationDescriptor(input.descriptor)
  if (descriptor.workspaceScope !== saved.snapshot.workspaceScope || descriptor.recoveryEpoch !== saved.snapshot.recoveryEpoch
    || descriptor.localFingerprint !== saved.snapshot.localFingerprint) return publicationInvalid('描述符不属于原完整捕获。')
  assertMembers(saved.snapshot, descriptor)
  const result = Object.freeze({ kind: 'synced-publication-claim' as const })
  claims.set(result, { db, attemptId: input.attemptId, descriptor: frozenPublicationFacts(descriptor),
    publicationHash: publicationHash(publicationJson(descriptor)), requestHash: syncedPublicationRequestHash(input.attemptId, descriptor) })
  return result
}
function current(db: Database.Database, claim: SyncedPublicationClaim): Claim {
  const saved = claims.get(claim)
  if (!saved || saved.db !== db || !db.open) return unavailable('发布租约不属于真实原 connection。')
  if (db.pragma('user_version', { simple: true }) !== 27) return unavailable('发布原 schema 世代失效。')
  assertSyncedBlockSchema(db)
  const context = identity(db)
  if (context.workspaceScope !== saved.descriptor.workspaceScope || context.recoveryEpoch !== saved.descriptor.recoveryEpoch) return unavailable('发布 workspace/recovery 世代失效。')
  return saved
}
function attempt(db: Database.Database, saved: Claim): AttemptRow | null {
  const row = db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(saved.attemptId) as AttemptRow | undefined
  if (!row) return null
  if (row.id !== saved.attemptId || row.request_hash !== saved.requestHash || row.channel !== 'webdav-manifest5'
    || row.target_fingerprint !== saved.descriptor.targetFingerprint || row.publication_hash !== saved.publicationHash
    || !Number.isFinite(Date.parse(row.created_at)) || row.state !== 'possible' && row.state !== 'confirmed'
    || row.state === 'possible' && row.confirmed_at !== null
    || row.state === 'confirmed' && (row.confirmed_at === null || !Number.isFinite(Date.parse(row.confirmed_at)))) return publicationInvalid('原 attempt 请求/目标/原件与准确状态不一致。')
  const rows = db.prepare('SELECT * FROM synced_group_exposure_members WHERE attempt_id=? ORDER BY group_id').all(saved.attemptId) as MemberRow[]
  const expected = saved.descriptor.members.map(({ portableHash: _portableHash, ...member }) => member)
  const actual = rows.map(item => ({ groupId: item.group_id, creationId: item.creation_id, revision: item.revision,
    topologyRevision: item.topology_revision, semanticHash: item.semantic_hash }))
  if (!rows.length || rows.some(item => item.attempt_id !== saved.attemptId) || publicationJson(actual) !== publicationJson(expected)) return publicationInvalid('原 attempt 的 immutable 成员闭集损坏。')
  const lifecycle = readSyncedGroupLifecycles(db, rows.map(item => item.group_id))
  for (const member of rows) {
    const group = db.prepare('SELECT creation_id FROM synced_groups WHERE id=?').get(member.group_id) as { creation_id: string } | undefined
    const life = lifecycle.get(member.group_id)
    if (group?.creation_id !== member.creation_id || !life || life.creationId !== member.creation_id || life.state !== 'active'
      || life.exposure !== 'possible' && life.exposure !== 'confirmed' || row.state === 'confirmed' && life.exposure !== 'confirmed') return publicationInvalid('原发布成员 incarnation/exposure 已损坏。')
  }
  return row
}
export function recoverSyncedPublicationClaim(db: Database.Database, input: { attemptId: string; descriptor: PublicationDescriptor;
  publicationHash: string; requestHash: string }): SyncedPublicationClaim {
  outer(db); assertSyncedShape(input, ['attemptId', 'descriptor', 'publicationHash', 'requestHash'])
  if (!isSyncedUuid(input.attemptId)) return publicationInvalid('恢复 attempt UUID 无效。')
  const descriptor = validatePublicationDescriptor(input.descriptor), digest = publicationHash(publicationJson(descriptor))
  if (digest !== input.publicationHash || syncedPublicationRequestHash(input.attemptId, descriptor) !== input.requestHash) return publicationInvalid('恢复原 descriptor/request 哈希不符。')
  const claim = Object.freeze({ kind: 'synced-publication-claim' as const }), saved = { db, attemptId: input.attemptId,
    descriptor: frozenPublicationFacts(descriptor), publicationHash: digest, requestHash: input.requestHash }
  claims.set(claim, saved)
  database(() => db.transaction(() => { current(db, claim); assertSyncedLifecycleCoverage(db); if (!attempt(db, saved)) return unavailable('恢复没有原 durable attempt。') })())
  return claim
}
export function readSyncedPublicationAttempt(db: Database.Database, claim: SyncedPublicationClaim): 'missing' | 'possible' | 'confirmed' {
  outer(db); return database(() => db.transaction(() => { const saved = current(db, claim), row = attempt(db, saved); return row?.state === 'confirmed' ? 'confirmed' : row ? 'possible' : 'missing' })())
}
export function claimSyncedPublication(db: Database.Database, claim: SyncedPublicationClaim): 'possible' | 'confirmed' | 'stale' {
  outer(db)
  return database(() => db.transaction(() => {
    const saved = current(db, claim), existing = attempt(db, saved)
    if (existing?.state === 'confirmed') return 'confirmed' as const
    const snapshot = readSyncedPersistentPublicationSnapshot(db)
    if (snapshot.localFingerprint !== saved.descriptor.localFingerprint) return 'stale' as const
    assertMembers(snapshot, saved.descriptor)
    if (existing) return 'possible' as const
    if (!saved.descriptor.members.length) return publicationInvalid('禁止提交空成员 attempt。')
    const now = new Date().toISOString()
    db.prepare("INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at) VALUES(?,?, 'webdav-manifest5',?,?, 'possible',?,NULL)")
      .run(saved.attemptId, saved.requestHash, saved.descriptor.targetFingerprint, saved.publicationHash, now)
    const insert = db.prepare('INSERT INTO synced_group_exposure_members(attempt_id,group_id,creation_id,revision,topology_revision,semantic_hash) VALUES(?,?,?,?,?,?)')
    for (const member of saved.descriptor.members) insert.run(saved.attemptId, member.groupId, member.creationId, member.revision, member.topologyRevision, member.semanticHash)
    if (attempt(db, saved)?.state !== 'possible') return publicationInvalid('提交前原成员/attempt闭合失败。')
    return 'possible' as const
  }).immediate())
}
export function currentSyncedPublicationMatches(db: Database.Database, claim: SyncedPublicationClaim): boolean {
  outer(db); return database(() => db.transaction(() => {
    const saved = current(db, claim), snapshot = readSyncedPersistentPublicationSnapshot(db)
    return snapshot.localFingerprint === saved.descriptor.localFingerprint
  })())
}
export function confirmSyncedPublication(db: Database.Database, claim: SyncedPublicationClaim): { replayed: boolean } {
  outer(db)
  return database(() => db.transaction(() => {
    const saved = current(db, claim); assertSyncedLifecycleCoverage(db)
    const row = attempt(db, saved)
    if (!row) return unavailable('确认没有原 possible attempt。')
    if (row.state === 'confirmed') return { replayed: true }
    const changed = db.prepare("UPDATE synced_exposure_attempts SET state='confirmed',confirmed_at=? WHERE id=? AND state='possible'").run(new Date().toISOString(), saved.attemptId)
    if (changed.changes !== 1 || attempt(db, saved)?.state !== 'confirmed') return publicationInvalid('原确认事务未准确闭合。')
    return { replayed: false }
  }).immediate())
}
