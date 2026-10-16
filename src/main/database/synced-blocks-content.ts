import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedCanonicalEdit, SyncedCanonicalWire, SyncedFailure, SyncedGroupMutationResult, SyncedGroupSaved,
  SyncedGroupSnapshot, SyncedGroupWire, SyncedOperationResult, SyncedRestoreGroupInput,
  SyncedUpdateGroupInput } from '../../shared/synced-blocks'
import { validateSyncedRestoreGroupInput, validateSyncedUpdateGroupInput } from '../../shared/syncedBlockInputs'
import { parseSyncedBlockPayload, SyncedValidationError, validateSyncedCanonicalProjection,
  validateSyncedGroupWire, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import { canonicalSyncedPortableJson, projectSyncedGroupBudget, projectSyncedHostBudget,
  type SyncedPortableHostRecord } from '../../shared/syncedBlockPortable'
import { parseStrictJson } from '../../shared/strictJson'
import { BlockIdentityRepository } from './block-identities'
import { getSyncedGroupSnapshots } from './synced-blocks-read'
import { assertSyncedStoredBindings, maintainSyncedGroupBindings } from './synced-block-links'
import { resolveSyncedBindingSource } from './synced-binding-sources'
import { decodeSyncedGroupOperationAck, readSyncedGroupOperationRow, validateSyncedOperationLookupInput } from './synced-group-operation-receipt'

type Input = SyncedUpdateGroupInput | SyncedRestoreGroupInput
type HistoryRow = { before_json: string; after_json: string; before_hash: string; after_hash: string }
type PhysicalRow = { id: string; kind: 'document' | 'group'; owner_id: string; created_at: string }
const hashPattern = /^[a-f0-9]{64}$/
const encode = canonicalSyncedPortableJson
const hash = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex')
const json = (value: string): unknown => parseStrictJson(value, { maxBytes: Math.max(1, Buffer.byteLength(value)), maxDepth: 32 })
class Refused extends Error { constructor(readonly result: SyncedFailure) { super('Synced content transaction refused') } }
function invalid(code: 'identity' | 'binding' | 'forest', message: string): never { throw new SyncedValidationError(code, message) }
function conflict(before: SyncedGroupSnapshot, kind: 'group' | 'topology' | 'history'): never {
  throw new Refused({ status: 'conflict', kind, groups: [before], hosts: [] })
}
function ownedTransaction<T>(db: Database.Database, run: () => T, write: boolean): T {
  // A released savepoint is not a durable commit. The future Store wrapper must
  // call this outside its own transaction and publish events only after return.
  if (db.inTransaction) throw new Error('同步块内容仓库必须独占事务，不能在外层事务中提交。')
  if (write && db.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('同步块内容写入必须启用 SQLite 外键。')
  const transaction = db.transaction(run)
  return write ? transaction.immediate() : transaction()
}
function mutation(db: Database.Database, run: () => SyncedGroupSaved): SyncedGroupMutationResult {
  try { return ownedTransaction(db, run, true) }
  catch (error) {
    if (error instanceof Refused) return error.result
    if (error instanceof SyncedValidationError) return { status: 'invalid', code: error.code, blockingInstances: error.blockingInstances }
    throw error
  }
}
function wire(snapshot: SyncedGroupSnapshot): SyncedGroupWire {
  return { kind: 'synced-group', id: snapshot.groupId, creationId: snapshot.creationId, createdAt: snapshot.createdAt,
    origin: snapshot.origin, bindings: snapshot.bindings, blocks: snapshot.blocks }
}
function ready(db: Database.Database, groupId: string): SyncedGroupSnapshot {
  const item = getSyncedGroupSnapshots(db, { groupIds: [groupId] }).items[0]
  if (item.status === 'missing') throw new Refused({ status: 'missing', kind: 'group', id: groupId })
  return item.snapshot
}
function guarded(db: Database.Database, input: Input): SyncedGroupSnapshot {
  const before = ready(db, input.groupId)
  if (before.revision !== input.expectedRevision) conflict(before, 'group')
  if (before.topologyRevision !== input.expectedTopologyRevision) conflict(before, 'topology')
  const instance = before.instances.find(value => value.instanceId === input.expectedInstanceBinding.instanceId)
  if (!instance) throw new Refused({ status: 'missing', kind: 'instance', id: input.expectedInstanceBinding.instanceId })
  if (instance.hostDocumentId !== input.expectedInstanceBinding.hostDocumentId
    || instance.bindingVersion !== input.expectedInstanceBinding.bindingVersion) conflict(before, 'topology')
  return before
}
function replay(db: Database.Database, input: Input, requestHash: string): SyncedGroupSaved | null {
  const row = readSyncedGroupOperationRow(db, input.clientOperationId)
  if (!row) return null
  if (!hashPattern.test(row.request_hash)) throw new Error('同步块操作收据损坏，不能猜测提交结果或重新执行。')
  if (row.request_hash !== requestHash) throw new Refused({ status: 'idempotency-mismatch' })
  // Do not hydrate the old ACK from today's blocks, instances, cursor or CAS.
  const result = decodeSyncedGroupOperationAck(row)
  if (result.snapshot.groupId !== input.groupId || 'blocks' in input
    && encode(result.snapshot.blocks.map(({ createdAt: _createdAt, ...block }) => block)) !== encode(input.blocks)) {
    throw new Error('同步块操作收据损坏：结果与原请求不一致，不能重新执行。')
  }
  return { ...result, replayed: true }
}
function receipt(db: Database.Database, input: Input, requestHash: string, result: SyncedGroupSaved, now: string): SyncedGroupSaved {
  db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
    .run(input.clientOperationId, requestHash, encode(result), now)
  return result
}

/** Resolve creation metadata from the global ledger, never from authored JSON.
 * A content write can restore this group's retired IDs, but cannot transfer an
 * ordinary/reserved/other-group identity. Wire/V3 transfers use another planner. */
function births(db: Database.Database, groupId: string, blocks: readonly SyncedCanonicalEdit[], now: string,
  historical?: ReadonlyMap<string, string>): SyncedCanonicalWire[] {
  const ids = blocks.map(block => block.id), identities = new BlockIdentityRepository(db).getMany(ids), encoded = JSON.stringify(ids)
  const physical = new Map<string, PhysicalRow>()
  const rows = db.prepare(`SELECT id,'document' AS kind,document_id AS owner_id,created_at FROM blocks WHERE id IN (SELECT value FROM json_each(?))
    UNION ALL SELECT id,'group' AS kind,group_id AS owner_id,created_at FROM synced_group_blocks WHERE id IN (SELECT value FROM json_each(?))`)
    .all(encoded, encoded) as PhysicalRow[]
  for (const row of rows) {
    if (physical.has(row.id)) invalid('identity', '块身份具有多个实际归属。')
    physical.set(row.id, row)
  }
  return blocks.map(block => {
    const identity = identities.get(block.id), actual = physical.get(block.id), historic = historical?.get(block.id)
    if (actual && (!identity || identity.state !== 'live' || identity.owner.kind !== actual.kind
      || identity.owner.id !== actual.owner_id || identity.createdAt !== actual.created_at)
      || identity?.state === 'live' && !actual) invalid('identity', '块身份与实际归属不一致。')
    if (identity && (identity.owner.kind !== 'group' || identity.owner.id !== groupId)) invalid('identity', '共享正文不能取用其它归属保留的块身份。')
    if (historical && (!identity || !historic || identity.createdAt !== null && identity.createdAt !== historic)) {
      invalid('identity', '历史块身份或创建时间已变化，不能覆盖。')
    }
    return { ...block, createdAt: historic ?? identity?.createdAt ?? now }
  })
}

type HostRow = { id: string; parent_id: string | null; sort_order: number; created_at: string; title: string; summary: string }
type HostBlockRow = { id: string; document_id: string; parent_block_id: string | null; sort_order: number; type: string;
  content: string; checked: number; depth: number; tags_json: string; language: string | null; list_start: number | null;
  markdown_format_json: string | null; highlight: string | null; created_at: string; identity_kind: string | null;
  identity_owner: string | null; identity_state: string | null; identity_created_at: string | null; collision: number }
function hosts(db: Database.Database, ids: readonly string[]): SyncedPortableHostRecord[] {
  if (!ids.length) return []
  const encoded = JSON.stringify(ids)
  const documents = db.prepare('SELECT id,parent_id,sort_order,created_at,title,summary FROM documents WHERE id IN (SELECT value FROM json_each(?))')
    .all(encoded) as HostRow[]
  if (documents.length !== ids.length) invalid('binding', '共享正文的真实宿主缺失。')
  const rows = db.prepare(`SELECT b.*,i.last_owner_kind AS identity_kind,i.last_owner_id AS identity_owner,
    i.state AS identity_state,i.created_at AS identity_created_at,
    EXISTS(SELECT 1 FROM synced_group_blocks c WHERE c.id=b.id) AS collision
    FROM blocks b LEFT JOIN block_identities i ON i.id=b.id
    WHERE b.document_id IN (SELECT value FROM json_each(?)) ORDER BY b.document_id,b.sort_order,b.id`).all(encoded) as HostBlockRow[]
  const byDocument = new Map<string, unknown[]>(), orders = new Map<string, number>()
  for (const row of rows) {
    if (row.identity_kind !== 'document' || row.identity_owner !== row.document_id || row.identity_state !== 'live'
      || row.identity_created_at !== row.created_at || row.collision) invalid('identity', '宿主正文与全局块身份不一致。')
    if (!Number.isSafeInteger(row.sort_order) || row.sort_order < 0 || (orders.get(row.document_id) ?? -1) >= row.sort_order
      || row.checked !== 0 && row.checked !== 1) invalid('forest', '宿主正文原始顺序或状态无效。')
    orders.set(row.document_id, row.sort_order)
    const raw = { id: row.id, parentBlockId: row.parent_block_id, type: row.type, content: row.content,
      checked: row.checked === 1, depth: row.depth, tags: json(row.tags_json),
      ...(row.language === null ? {} : { language: row.language }), ...(row.list_start === null ? {} : { listStart: row.list_start }),
      ...(row.markdown_format_json === null ? {} : { markdownFormat: json(row.markdown_format_json) }),
      ...(row.highlight === null ? {} : { highlight: row.highlight }) }
    // The complete forest below is the authority for parent/role validation.
    const blocks = byDocument.get(row.document_id) ?? []
    blocks.push(raw); byDocument.set(row.document_id, blocks)
  }
  return documents.map(row => ({ kind: 'document', id: row.id, parentId: row.parent_id, sortOrder: row.sort_order,
    createdAt: row.created_at, content: { title: row.title, summary: row.summary, blocks: validateSyncedHostForest(byDocument.get(row.id) ?? []) } }))
}
function finalBudget(db: Database.Database, before: SyncedGroupSnapshot, candidate: SyncedGroupWire): void {
  validateSyncedCanonicalProjection(candidate.blocks, before.instances)
  projectSyncedGroupBudget(candidate)
  const affected = hosts(db, [...new Set(before.instances.map(instance => instance.hostDocumentId))])
  const required = new Set<string>()
  for (const host of affected) for (const block of host.content.blocks) {
    if (block.type === 'synced-block') {
      const id = parseSyncedBlockPayload(block.content).groupId
      if (id !== before.groupId) required.add(id)
    }
  }
  const groups = new Map<string, SyncedGroupWire>([[candidate.id, candidate]])
  for (const item of getSyncedGroupSnapshots(db, { groupIds: [...required] }).items) {
    if (item.status === 'missing') invalid('binding', '宿主的其它同步引用缺少真实组正文。')
    groups.set(item.snapshot.groupId, wire(item.snapshot))
  }
  for (const host of affected) {
    try { projectSyncedHostBudget(host, groups) }
    catch (error) {
      if (error instanceof SyncedValidationError) throw new SyncedValidationError(error.code, error.message,
        before.instances.filter(instance => instance.hostDocumentId === host.id).map(({ instanceId, hostDocumentId, bindingVersion }) =>
          ({ instanceId, hostDocumentId, bindingVersion })))
      throw error
    }
  }
}
function replaceBlocks(db: Database.Database, candidate: SyncedGroupWire): void {
  db.prepare('DELETE FROM synced_group_blocks WHERE group_id=?').run(candidate.id)
  const insert = db.prepare(`INSERT INTO synced_group_blocks(id,group_id,parent_block_id,sort_order,type,content,checked,depth,
    tags_json,language,list_start,markdown_format_json,highlight,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  candidate.blocks.forEach((block, index) => insert.run(block.id, candidate.id, block.parentBlockId, index, block.type, block.content,
    block.checked ? 1 : 0, block.depth, block.tags === undefined ? null : encode(block.tags), block.language ?? null, block.listStart ?? null,
    block.markdownFormat === undefined ? null : encode(block.markdownFormat), block.highlight ?? null, block.createdAt))
}
function position(db: Database.Database, groupId: string): number {
  const row = db.prepare('SELECT history_position FROM synced_groups WHERE id=?').get(groupId) as { history_position: number } | undefined
  if (!row || !Number.isSafeInteger(row.history_position) || row.history_position < 0) throw new Error('同步块历史位置损坏。')
  return row.history_position
}
function advance(db: Database.Database, before: SyncedGroupSnapshot, input: Input, candidate: SyncedGroupWire, nextPosition: number): void {
  const instance = input.expectedInstanceBinding
  const changed = db.prepare(`UPDATE synced_groups SET bindings_json=?,revision=?,history_cursor=?,history_position=?
    WHERE id=? AND revision=? AND topology_revision=? AND history_cursor=?
      AND EXISTS(SELECT 1 FROM synced_instances i WHERE i.instance_id=? AND i.group_id=synced_groups.id
        AND i.host_document_id=? AND i.binding_version=?)`).run(encode(candidate.bindings), randomUUID(), randomUUID(), nextPosition,
      before.groupId, before.revision, before.topologyRevision, before.history.cursor,
      instance.instanceId, instance.hostDocumentId, instance.bindingVersion).changes
  if (changed !== 1) conflict(before, 'topology')
}
function assertHistoryTailSide(db: Database.Database, before: SyncedGroupSnapshot): void {
  // A fresh local edit cannot accidentally attach to a journal branch left
  // executable by an external replacement. Both adjacent sides must be exact.
  for (const [token, side] of [[before.history.undoToken, 'after'], [before.history.redoToken, 'before']] as const) {
    if (token === null) continue
    const row = db.prepare('SELECT before_json,after_json,before_hash,after_hash FROM synced_group_history WHERE id=? AND group_id=?')
      .get(token, before.groupId) as HistoryRow | undefined
    if (!row) throw new Error('同步块历史尾记录缺失。')
    const recorded = side === 'after' ? historySide(row.after_json, row.after_hash, before) : historySide(row.before_json, row.before_hash, before)
    if (encode(recorded) !== encode(wire(before))) conflict(before, 'history')
  }
}

export function updateSyncedBlockGroup(db: Database.Database, value: unknown): SyncedGroupMutationResult {
  let input: SyncedUpdateGroupInput
  try { input = validateSyncedUpdateGroupInput(value) }
  catch (error) { if (error instanceof SyncedValidationError) return { status: 'invalid', code: error.code, blockingInstances: error.blockingInstances }; throw error }
  return mutation(db, () => {
    const requestHash = hash({ method: 'updateSyncedBlockGroup', input }), previous = replay(db, input, requestHash)
    if (previous) return previous
    const before = guarded(db, input), now = new Date().toISOString()
    assertHistoryTailSide(db, before)
    const blocks = births(db, before.groupId, input.blocks, now)
    const candidate = validateSyncedGroupWire({ ...wire(before), blocks,
      bindings: maintainSyncedGroupBindings(db, before, blocks, input.bindingClaims,
        (ticketId, entryId) => resolveSyncedBindingSource(db, ticketId, entryId)) })
    finalBudget(db, before, candidate)
    if (encode(candidate) === encode(wire(before))) return receipt(db, input, requestHash,
      { status: 'noop', operationId: input.clientOperationId, snapshot: before, replayed: false }, now)
    const current = position(db, before.groupId)
    if (!Number.isSafeInteger(current + 1)) invalid('forest', '同步块历史位置超过安全整数范围。')
    db.prepare('DELETE FROM synced_group_history WHERE group_id=? AND position>?').run(before.groupId, current)
    replaceBlocks(db, candidate)
    db.prepare(`INSERT INTO synced_group_history(id,group_id,position,before_json,after_json,before_hash,after_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), before.groupId, current + 1, encode(wire(before)), encode(candidate), hash(wire(before)), hash(candidate), now)
    advance(db, before, input, candidate, current + 1)
    return receipt(db, input, requestHash, { status: 'saved', operationId: input.clientOperationId,
      snapshot: ready(db, before.groupId), replayed: false }, now)
  })
}

function historySide(source: string, expectedHash: string, before: SyncedGroupSnapshot): SyncedGroupWire {
  try {
    const side = validateSyncedGroupWire(json(source))
    if (!hashPattern.test(expectedHash) || hash(side) !== expectedHash || side.id !== before.groupId || side.creationId !== before.creationId
      || side.createdAt !== before.createdAt || encode(side.origin) !== encode(before.origin)) throw new Error('History semantic identity/hash mismatch')
    return side
  } catch (cause) { throw new Error('同步块历史内容或校验值损坏，未恢复。', { cause }) }
}
export function restoreSyncedGroupOperation(db: Database.Database, value: unknown): SyncedGroupMutationResult {
  let input: SyncedRestoreGroupInput
  try { input = validateSyncedRestoreGroupInput(value) }
  catch (error) { if (error instanceof SyncedValidationError) return { status: 'invalid', code: error.code, blockingInstances: error.blockingInstances }; throw error }
  return mutation(db, () => {
    const requestHash = hash({ method: 'restoreSyncedGroupOperation', input }), previous = replay(db, input, requestHash)
    if (previous) return previous
    const before = guarded(db, input), undo = input.direction === 'undo', current = position(db, before.groupId)
    if (input.expectedHistoryCursor !== before.history.cursor || input.historyToken !== (undo ? before.history.undoToken : before.history.redoToken)) {
      conflict(before, 'history')
    }
    const row = db.prepare(`SELECT before_json,after_json,before_hash,after_hash FROM synced_group_history WHERE id=? AND group_id=? AND position=?`)
      .get(input.historyToken, before.groupId, undo ? current : current + 1) as HistoryRow | undefined
    if (!row) throw new Error('同步块历史尾记录缺失，未恢复。')
    const left = historySide(row.before_json, row.before_hash, before), right = historySide(row.after_json, row.after_hash, before)
    if (encode(wire(before)) !== encode(undo ? right : left)) conflict(before, 'history')
    const candidate = undo ? left : right, now = new Date().toISOString()
    births(db, before.groupId, candidate.blocks, now, new Map(candidate.blocks.map(block => [block.id, block.createdAt])))
    // Historical targets remain exact. A rename/deletion never substitutes a
    // new ID or changes the saved side before its equality/hash checks.
    assertSyncedStoredBindings(db, candidate.origin, candidate.blocks, candidate.bindings)
    finalBudget(db, before, candidate)
    if (encode(candidate) === encode(wire(before))) return receipt(db, input, requestHash,
      { status: 'noop', operationId: input.clientOperationId, snapshot: before, replayed: false }, now)
    replaceBlocks(db, candidate)
    advance(db, before, input, candidate, undo ? current - 1 : current + 1)
    return receipt(db, input, requestHash, { status: 'saved', operationId: input.clientOperationId,
      snapshot: ready(db, before.groupId), replayed: false }, now)
  })
}

/** Only implemented group ACKs are accepted. A future structure writer must
 * supply its strict stored-result codec before installing structure receipts. */
export function getSyncedOperation(db: Database.Database, input: unknown): SyncedOperationResult {
  const id = validateSyncedOperationLookupInput(input)
  return ownedTransaction<SyncedOperationResult>(db, () => {
    const row = readSyncedGroupOperationRow(db, id)
    return row ? { status: 'committed', result: { ...decodeSyncedGroupOperationAck(row), replayed: true } } : { status: 'unknown' }
  }, false)
}
