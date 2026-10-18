import { hasSyncedRemoteObservationForCreate } from './synced-remote-observation-read'
import { readSyncedExchangeHostCut } from './synced-exchange-host-cut'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedFailure, SyncedGroupSnapshot, SyncedGroupWire, SyncedRestoreHostInput,
  SyncedStableBlockDraft, SyncedStructureApplied, SyncedStructureInput, SyncedStructureResult } from '../../shared/synced-blocks'
import { validateSyncedRestoreHostInput, validateSyncedStructureInput } from '../../shared/syncedBlockInputs'
import { assertSyncedShape, isSyncedUuid, parseSyncedBlockPayload, SYNCED_MAX_BLOCKS, SyncedValidationError, validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { validateSyncedWorkspaceGraph } from '../../shared/syncedBlockGraph'
import { projectSyncedGroupBudget, projectSyncedHostBudget } from '../../shared/syncedBlockPortable'
import { getMarkdownHeadingRewrites, getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { BlockIdentityRepository } from './block-identities'
import { getSyncedGroupSnapshots, getSyncedHostHistory } from './synced-blocks-read'
import { readSyncedGroupOperationRow } from './synced-group-operation-receipt'
import { decodeMainHostOperationAck, validateHostOperationAck, validateHostCreateOperationAck, type SyncedMainHostSuccess } from './synced-host-operation-receipt'
import { hostJson, readStrictHostDocument, type StrictHostDocument, type HostContent } from './synced-host-document-read'
import { decodeHostJournal, encodeHostJournal, hostEncode, hostEqual, hostHash, hostReferencedGroups,
  sameHostContent, hostJournalKind, type HostBirth, type HostFinalInput, type HostJournal, type HostSide } from './synced-host-journal'
import { pruneSyncedHostRedoBranches, type SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { MarkdownLinkIndex } from './markdown-link-index'
import { hasSyncedInsertWorkingStructure, isHostInsertInput, planSyncedHostInsert, type HostInsertInput } from './synced-host-insert-plan'

import { isHostMoveInput, planSyncedHostMove, assertSyncedHostMoveContext, UnsupportedSyncedHostMove, type HostMoveInput } from './synced-host-move-plan'
import { captureSyncedCreateSourceFacts, createPhysicalKey, createRawHash, isHostCreateInput, planSyncedHostCreate, projectSyncedCreateLinks, UnsupportedSyncedHostCreate, type HostCreateInput } from './synced-host-create-plan'
import { decodeHostCreateJournal, encodeHostCreateJournal, validateCreatedLifecycleSide, type HostCreateJournal, type CreatedLifecycleSide, type SyncedHostCreateApplied } from './synced-host-create-codec'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { isSyncedGroupLogicallyDeleted, assertSyncedDocumentNotLogicallyDeleted } from './synced-logical-deletion-read'
import { assertSyncedStoredBindings, captureSyncedCreateBindings } from './synced-block-links'
export type { SyncedHostCreateApplied } from './synced-host-create-codec'

export { getSyncedHostHistory }
export type SyncedHostFinalResult = SyncedStructureResult | SyncedHostCreateApplied | { status: 'unsupported'; reason: 'command' | 'title-change' | 'owner-transfer' | 'journal-kind' | 'heading-rewrite' | 'working-structure' | 'move-selection' | 'semantic-binding' | 'create-selection' | 'lifecycle' }
type Groups = Map<string, SyncedGroupSnapshot>
type Hosts = Map<string, StrictHostDocument>
type Guards = Pick<SyncedRestoreHostInput, 'groups' | 'expectedInstances'>
class Refused extends Error { constructor(readonly result: SyncedHostFinalResult) { super('Host final transaction refused') } }
function invalid(code: 'identity' | 'binding' | 'forest', message: string): never { throw new SyncedValidationError(code, message) }
function unsupported(reason: Extract<SyncedHostFinalResult, { status: 'unsupported' }>['reason']): never { throw new Refused({ status: 'unsupported', reason }) }
function missing(kind: 'group' | 'document' | 'instance', id: string): never { throw new Refused({ status: 'missing', kind, id }) }
function conflict(kind: 'host' | 'group' | 'topology' | 'history', groups: Groups, hosts: Hosts): never {
  throw new Refused({ status: 'conflict', kind, groups: [...groups.values()], hosts: [...hosts.values()].map(value => value.detail) })
}
function mutation(db: Database.Database, run: () => SyncedMainHostSuccess): SyncedHostFinalResult {
  if (db.inTransaction) throw new Error('宿主结构仓库必须拥有真实外层 IMMEDIATE 事务。')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('宿主结构写入必须启用 SQLite 外键。')
  try { return db.transaction(run).immediate() }
  catch (error) {
    if (error instanceof Refused) return error.result
    if (error instanceof UnsupportedSyncedHostMove) return { status: 'unsupported', reason: error.reason }
    if (error instanceof UnsupportedSyncedHostCreate) return { status: 'unsupported', reason: error.reason }
    if (error instanceof SyncedValidationError) return { status: 'invalid', code: error.code, blockingInstances: error.blockingInstances }
    throw error
  }
}
function validated<T>(read: () => T): T | SyncedFailure {
  try { return read() } catch (error) {
    if (error instanceof SyncedValidationError) return { status: 'invalid', code: error.code, blockingInstances: error.blockingInstances }
    throw error
  }
}
function replay(db: Database.Database, operationId: string, requestHash: string): SyncedMainHostSuccess | null {
  const row = readSyncedGroupOperationRow(db, operationId)
  if (!row) return null
  if (!/^[a-f0-9]{64}$/.test(row.request_hash)) throw new Error('宿主操作请求哈希损坏。')
  if (row.request_hash !== requestHash) throw new Refused({ status: 'idempotency-mismatch' })
  return { ...decodeMainHostOperationAck(row), replayed: true }
}
function receipt(db: Database.Database, result: SyncedStructureApplied, requestHash: string, now: string): SyncedStructureApplied {
  const exact = validateHostOperationAck(result, result.operationId)
  db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
    .run(result.operationId, requestHash, hostEncode({ kind: 'synced-host-operation', version: 1, result: exact }), now)
  return exact
}
function host(db: Database.Database, id: string): StrictHostDocument {
  assertSyncedDocumentNotLogicallyDeleted(db, id)
  return readStrictHostDocument(db, id) ?? missing('document', id)
}
function readAllHosts(db: Database.Database): Hosts {
  const result: Hosts = new Map()
  for (const row of db.prepare('SELECT id FROM documents ORDER BY id').all() as Array<{ id: string }>) result.set(row.id, host(db, row.id))
  if (db.prepare(`SELECT 1 FROM blocks b LEFT JOIN documents d ON d.id=b.document_id WHERE d.id IS NULL LIMIT 1`).get()) invalid('identity', '实际块的宿主缺失。')
  return result
}
function allGroups(db: Database.Database): Groups {
  const ids = (db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{ id: string }>).map(row => row.id)
  const result: Groups = new Map()
  // The reader limit is per request, not a workspace-wide group-count cap.
  // Preserve the empty read's namespace validation within the same outer transaction.
  for (let start = 0; start < ids.length || start === 0; start += SYNCED_MAX_BLOCKS) {
    for (const item of getSyncedGroupSnapshots(db, { groupIds: ids.slice(start, start + SYNCED_MAX_BLOCKS) }).items) {
      if (item.status === 'ready') result.set(item.snapshot.groupId, item.snapshot)
    }
  }
  return result
}
const wire = (group: SyncedGroupSnapshot): SyncedGroupWire => ({ kind: 'synced-group', id: group.groupId, creationId: group.creationId,
  createdAt: group.createdAt, origin: group.origin, bindings: group.bindings, blocks: group.blocks })
function participating(all: Hosts, ids: readonly string[]): Hosts {
  return new Map(ids.map(id => [id, all.get(id) ?? missing('document', id)]))
}
function referenceRows(side: HostSide[]): Map<string, { documentId: string; groupId: string; block: SyncedStableBlockDraft }> {
  const result = new Map<string, { documentId: string; groupId: string; block: SyncedStableBlockDraft }>()
  for (const host of side) for (const block of host.content.blocks) if (block.type === 'synced-block') {
    if (result.has(block.id)) invalid('identity', '引用身份具有多个宿主。')
    result.set(block.id, { documentId: host.documentId, groupId: parseSyncedBlockPayload(block.content).groupId, block })
  }
  return result
}
const persistedSides = (hosts: Hosts): HostSide[] => [...hosts].map(([documentId, value]) => ({ documentId, content: value.content }))
function exactSet(left: readonly string[], right: readonly string[]): boolean {
  const expected = new Set(right)
  return left.length === right.length && new Set(left).size === left.length && left.every(id => expected.has(id))
}
function guards(input: Guards, persisted: HostSide[], sides: HostSide[], groups: Groups, hosts: Hosts,
  extraGroups: readonly string[] = []): Set<string> {
  const required = new Set([...hostReferencedGroups([...persisted, ...sides]), ...extraGroups])
  if (!exactSet(input.groups.map(item => item.groupId), [...required])) invalid('binding', '组守卫必须覆盖真实 P/W/A 引用闭集，不能缺失或多报。')
  for (const guard of input.groups) {
    const group = groups.get(guard.groupId) ?? missing('group', guard.groupId)
    if (guard.expectedRevision !== group.revision) conflict('group', groups, hosts)
    if (guard.expectedTopologyRevision !== group.topologyRevision) conflict('topology', groups, hosts)
  }
  const refs = referenceRows(persisted)
  if (!exactSet(input.expectedInstances.map(item => item.instanceId), [...refs.keys()])) invalid('binding', '实例守卫必须是参与宿主实际 P 引用的完整闭集。')
  for (const guard of input.expectedInstances) {
    const ref = refs.get(guard.instanceId)!, group = groups.get(ref.groupId) ?? missing('group', ref.groupId)
    const actual = group.instances.find(item => item.instanceId === guard.instanceId)
    if (!actual) missing('instance', guard.instanceId)
    if (guard.hostDocumentId !== ref.documentId || actual.hostDocumentId !== guard.hostDocumentId || actual.bindingVersion !== guard.bindingVersion) conflict('topology', groups, hosts)
  }
  return required
}
function checkTitlesAndHeadings(persisted: Hosts, before: HostSide[], after: HostSide[]): void {
  const afterById = new Map(after.map(side => [side.documentId, side]))
  for (const original of before) {
    const p = persisted.get(original.documentId)!, a = afterById.get(original.documentId)!
    if (p.detail.title !== original.content.title || p.detail.title !== a.content.title) unsupported('title-change')
    const oldTargets = getMarkdownHeadingTargets(p.content.blocks, p.content.title)
    for (const side of [original, a]) if (getMarkdownHeadingRewrites(oldTargets,
      getMarkdownHeadingTargets(side.content.blocks, side.content.title)).size) unsupported('heading-rewrite')
  }
}
function nonempty(side: HostSide[]): void {
  if (side.some(host => !host.content.blocks.length)) invalid('forest', '实际宿主结果不能为空；须显式提供真实新段落，不会自动补占位。')
}
function births(db: Database.Database, sides: HostSide[], hosts: Hosts, now: string, historical?: readonly HostBirth[]): HostBirth[] {
  const owners = new Map<string, string>()
  for (const side of sides) for (const block of side.content.blocks) {
    const old = owners.get(block.id)
    if (old !== undefined && old !== side.documentId) unsupported('owner-transfer')
    owners.set(block.id, side.documentId)
  }
  const repository = new BlockIdentityRepository(db), result: HostBirth[] = []
  const historicalById = new Map(historical?.map(item => [item.blockId, item]) ?? [])
  for (const [blockId, documentId] of owners) {
    const identity = repository.get(blockId), actual = repository.resolveLiveOwner(blockId)
    if (identity && (identity.owner.kind !== 'document' || identity.owner.id !== documentId)) {
      if (identity.owner.kind === 'document' && hosts.has(identity.owner.id)) unsupported('owner-transfer')
      invalid('identity', '其它宿主、canonical 或 reserved 身份不能认领为新普通块。')
    }
    if (actual && (actual.kind !== 'document' || actual.id !== documentId)) invalid('identity', '实际块归属已变化。')
    if (identity && (identity.createdAt === null || !Number.isFinite(Date.parse(identity.createdAt)))) invalid('identity', '保留身份没有准确创建时间，不能重新赋予 birth。')
    const historic = historicalById.get(blockId)
    if (historical && (!historic || historic.documentId !== documentId || !identity || identity.createdAt !== historic.createdAt)) invalid('identity', '逆操作的 journal birth/retained owner 已变化。')
    result.push({ documentId, blockId, createdAt: historic?.createdAt ?? identity?.createdAt ?? now })
  }
  return result
}
function checkReferenceAuthority(db: Database.Database, input: HostFinalInput, persisted: HostSide[], before: HostSide[], after: HostSide[], groups: Groups, scope: string): void {
  const p = referenceRows(persisted), w = referenceRows(before), a = referenceRows(after)
  const ordinary = new Set(persisted.flatMap(side => side.content.blocks.filter(block => block.type !== 'synced-block').map(block => block.id)))
  const known = new Map(p), fresh = new Map<string, { documentId: string; groupId: string; block: SyncedStableBlockDraft }>()
  for (const [id, ref] of [...w, ...a]) {
    const old = known.get(id)
    if (ordinary.has(id)) unsupported('command')
    if (old && (old.documentId !== ref.documentId || old.groupId !== ref.groupId)) invalid('binding', '既有实例不能手工改组或转宿主。')
    if (!old) {
      const same = fresh.get(id)
      if (same && (same.documentId !== ref.documentId || same.groupId !== ref.groupId)) invalid('binding', '新实例的两侧身份不一致。')
      fresh.set(id, ref)
    }
    known.set(id, ref)
  }
  for (const side of [...before, ...after]) for (const block of side.content.blocks) if (block.type !== 'synced-block' && (p.has(block.id) || w.has(block.id) || a.has(block.id))) unsupported('command')
  if (!exactSet(input.newRefSources.map(item => item.instanceId), [...fresh.keys()])) invalid('binding', '每个真实 fresh 引用都须且只能有一项来源证明。')
  for (const source of input.newRefSources) {
    const destination = fresh.get(source.instanceId)!, group = groups.get(destination.groupId) ?? missing('group', destination.groupId)
    if (new BlockIdentityRepository(db).get(source.instanceId)) invalid('identity', '新实例必须是真实未占用的 fresh UUID，不能重生 retained 身份。')
    if (source.kind === 'internal') {
      if (source.identity.workspaceScope !== scope || source.identity.groupId !== group.groupId || source.identity.creationId !== group.creationId) invalid('binding', '内部引用来源 scope/incarnation 不匹配。')
    } else {
      const actual = p.get(source.sourceInstanceId), working = w.get(source.sourceInstanceId)
      if (!actual || !working || actual.documentId !== source.sourceDocumentId || working.documentId !== actual.documentId
        || actual.groupId !== working.groupId || actual.groupId !== destination.groupId) invalid('binding', 'working 来源必须有真实 P registry 与 W 身份，不能循环虚构。')
    }
  }
}
function checkInsertAuthority(db: Database.Database, input: HostInsertInput, groups: Groups): void {
  // This typed action grants exactly its one fresh reference. W grants no other
  // reference membership, owner, placement, or parent-role binding change.
  if (!groups.has(input.action.groupId)) missing('group', input.action.groupId)
  const identities = new BlockIdentityRepository(db)
  if (identities.get(input.action.instanceId) || identities.resolveLiveOwner(input.action.instanceId)) {
    invalid('identity', 'insert 的 fresh UUID 已被普通、canonical、retained 或实例身份占用。')
  }
}
function finalGraph(allHosts: Hosts, groups: Groups, after: HostSide[], create?: { wire: SyncedGroupWire; retire: boolean }) {
  const overlays = new Map(after.map(side => [side.documentId, side.content]))
  const documents = [...allHosts].map(([documentId, value]) => ({ documentId, blocks: (overlays.get(documentId) ?? value.content).blocks }))
  const wires = [...groups.values()].filter(group => group.groupId !== create?.wire.id).map(wire)
  if (create && !create.retire) wires.push(create.wire)
  const graph = validateSyncedWorkspaceGraph(documents, wires), byGroup = new Map(wires.map(item => [item.id, item]))
  for (const group of wires) projectSyncedGroupBudget(group)
  for (const [id, document] of allHosts) projectSyncedHostBudget({ kind: 'document', id, parentId: document.parentId, sortOrder: document.sortOrder,
    createdAt: document.createdAt, content: overlays.get(id) ?? document.content }, byGroup)
  return graph
}
function time(hosts: Hosts): string {
  return new Date(Math.max(Date.now(), ...[...hosts.values()].map(host => Date.parse(host.detail.updatedAt) + 1))).toISOString()
}
function ensureStates(db: Database.Database, ids: readonly string[]): void {
  const insert = db.prepare('INSERT OR IGNORE INTO synced_host_history_state(document_id,cursor,position) VALUES(?,?,0)')
  for (const id of ids) { insert.run(id, randomUUID()); getSyncedHostHistory(db, { documentId: id }) }
}
function assertHostChain(db: Database.Database, documentId: string): void {
  const state = db.prepare('SELECT cursor,position FROM synced_host_history_state WHERE document_id=?').get(documentId) as { cursor: string; position: number } | undefined
  const rows = db.prepare(`SELECT m.history_id,m.position,j.id AS actual_id FROM synced_host_history_documents m
    LEFT JOIN synced_host_history j ON j.id=m.history_id WHERE m.document_id=? ORDER BY m.position`).all(documentId) as Array<{ history_id: string; position: number; actual_id: string | null }>
  if (!state || !isSyncedUuid(state.cursor) || !Number.isSafeInteger(state.position) || state.position < 0 || state.position > rows.length
    || rows.some((row, index) => !isSyncedUuid(row.history_id) || row.actual_id !== row.history_id || row.position !== index + 1)) {
    throw new Error('宿主历史完整位置链缺失、不连续或越界，未恢复或补造映射。')
  }
  getSyncedHostHistory(db, { documentId })
}
function prune(db: Database.Database, ids: string[]): void {
  ensureStates(db, ids)
  pruneSyncedHostRedoBranches(db, ids, row => decodeHostJournal(row).before.map(side => side.documentId))
}
function syncLinks(db: Database.Database, documentIds: string[], now: string): void {
  const index = new MarkdownLinkIndex(db)
  for (const id of documentIds) index.syncDocument(id)
  db.prepare('DELETE FROM links WHERE source_document_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(documentIds))
  const rows = db.prepare(`SELECT DISTINCT source.source_document_id,target.id AS target_id,source.url
    FROM markdown_link_sources source JOIN documents target ON target.path=source.target_path
    WHERE (source.kind IN ('wiki','wiki-heading') OR target.id<>source.source_document_id)
      AND source.source_document_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(documentIds)) as Array<{ source_document_id: string; target_id: string; url: string }>
  const insert = db.prepare('INSERT INTO links(id,source_document_id,target_document_id,label,created_at) VALUES(?,?,?,?,?)')
  for (const row of rows) insert.run(randomUUID(), row.source_document_id, row.target_id, row.url, now)
}
interface CreateWritePermit { journal: HostCreateJournal; direction: 'create' | 'undo' | 'redo'; bindingVersion: string }
const createWritePermits = new WeakSet<CreateWritePermit>()
function createWritePermit(journal: HostCreateJournal, direction: CreateWritePermit['direction'], bindingVersion: string): CreateWritePermit {
  const permit = Object.freeze({ journal, direction, bindingVersion }); createWritePermits.add(permit); return permit
}
function writeHosts(db: Database.Database, before: Hosts, after: HostSide[], acceptedBirths: HostBirth[], groups: Groups,
  graph: ReturnType<typeof finalGraph>, now: string, touchAll = false, create?: CreateWritePermit): string[] {
  if (create && !createWritePermits.has(create)) throw new Error('create 物理迁域缺少真实私有预检。')
  const birthMap = new Map(acceptedBirths.map(item => [item.blockId, item]))
  const retain = db.prepare(`INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'document',?,'retained',?)`)
  // W-only fresh identities remain exactly owned even if A never has a row.
  const identity = new BlockIdentityRepository(db)
  for (const item of acceptedBirths) if (!identity.get(item.blockId)) retain.run(item.blockId, item.documentId, item.createdAt)
  const oldInstances = new Map([...groups.values()].flatMap(group => group.instances.map(instance => [instance.instanceId, { ...instance, groupId: group.groupId }] as const)))
  const nextPositions = new Map([...graph.occurrences.values()].flatMap(positions => positions.map(position => [position.instanceId, position] as const)))
  const insertBlock = db.prepare(`INSERT INTO blocks(id,document_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,language,
    list_start,markdown_format_json,highlight,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertInstance = db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,?,?)')
  const changedIds: string[] = [], affected = new Set<string>()
  for (const side of after) {
    const p = before.get(side.documentId)!
    if (!touchAll && sameHostContent(p.content, side.content)) continue
    changedIds.push(side.documentId)
    const nextById = new Map(side.content.blocks.map(block => [block.id, block]))
    for (const block of p.content.blocks) if (block.type === 'synced-block') {
      const next = nextById.get(block.id), old = oldInstances.get(block.id)!
      const parentType = next?.parentBlockId === null ? null : next?.parentBlockId ? nextById.get(next.parentBlockId)?.type ?? null : null
      if (!next || next.type !== 'synced-block' || old.parentBlockId !== next.parentBlockId || old.depth !== next.depth || old.parentType !== parentType) affected.add(block.id)
    }
    // Detach the registry before self-FK SET NULL can transiently rewrite a
    // still-registered child. oldInstances retains the actual original bindings.
    db.prepare('DELETE FROM synced_instances WHERE host_document_id=?').run(side.documentId)
    db.prepare('DELETE FROM blocks WHERE document_id=?').run(side.documentId)
    if (create) writeCreateOwnership(db, create)
    side.content.blocks.forEach((block, index) => {
      const birth = birthMap.get(block.id)
      if (!birth || birth.documentId !== side.documentId) invalid('identity', '实际写入没有其准确接受 birth。')
      insertBlock.run(block.id, side.documentId, block.parentBlockId, index, block.type, block.content, block.checked ? 1 : 0, block.depth,
        hostEncode(block.tags ?? []), block.language ?? null, block.listStart ?? null, block.markdownFormat === undefined ? null : hostEncode(block.markdownFormat), block.highlight ?? null, birth.createdAt, now)
    })
    for (const block of side.content.blocks) if (block.type === 'synced-block') {
      const groupId = parseSyncedBlockPayload(block.content).groupId, old = oldInstances.get(block.id)
      const position = nextPositions.get(block.id)!
      const unchanged = old && old.groupId === groupId && old.hostDocumentId === side.documentId
        && old.parentBlockId === position.parentBlockId && old.depth === position.depth && old.parentType === position.parentType
      const binding = create && block.id === create.journal.input.action.instanceId ? create.bindingVersion : unchanged ? old.bindingVersion : randomUUID()
      if (!unchanged) affected.add(block.id)
      insertInstance.run(block.id, groupId, side.documentId, binding, block.parentBlockId, block.depth)
    }
    if (db.prepare('UPDATE documents SET summary=?,updated_at=? WHERE id=? AND updated_at=?')
      .run(side.content.summary, now, side.documentId, p.detail.updatedAt).changes !== 1) conflict('host', groups, before)
  }
  for (const group of groups.values()) if (group.groupId !== create?.journal.create.wire.id && (group.instances.some(item => affected.has(item.instanceId))
    || (graph.occurrences.get(group.groupId) ?? []).some(item => affected.has(item.instanceId)))) {
    if (db.prepare('UPDATE synced_groups SET topology_revision=? WHERE id=? AND revision=? AND topology_revision=?')
      .run(randomUUID(), group.groupId, group.revision, group.topologyRevision).changes !== 1) conflict('topology', groups, before)
  }
  // Ordinary writes preserve historical routes. The private create transition
  // separately records selected identities at their real original host path.
  syncLinks(db, changedIds, now)
  if (create) createWritePermits.delete(create)
  return [...affected]
}
function result(db: Database.Database, operationId: string, status: 'applied' | 'noop', token: string | null,
  logicalBefore: HostSide[], groupIds: Set<string>, affectedInstanceIds: string[]): SyncedStructureApplied {
  const groups = getSyncedGroupSnapshots(db, { groupIds: [...groupIds] }).items.map(item => item.status === 'ready' ? item.snapshot : missing('group', item.groupId))
  return { status, operationId, historyToken: token, replayed: false, hosts: logicalBefore.map(side => ({ documentId: side.documentId,
    logicalBefore: side.content, logicalBeforeHash: hostHash(side.content), after: host(db, side.documentId).detail })), groups, affectedInstanceIds, blockIdMap: [] }
}
function checkUpdatedAt(expected: Array<{ documentId: string; expectedUpdatedAt: string }>, hosts: Hosts, groups: Groups): void {
  for (const item of expected) if (hosts.get(item.documentId)!.detail.updatedAt !== item.expectedUpdatedAt) conflict('host', groups, hosts)
}

type HostApplyMethod = 'applySyncedHostFinal' | 'applySyncedHostCommand'
function acceptedInput(input: SyncedStructureInput, method: HostApplyMethod): HostFinalInput | HostInsertInput | HostMoveInput {
  if (method === 'applySyncedHostFinal') {
    if (input.mode !== 'host-final') unsupported('command')
    return input
  }
  if ((!isHostInsertInput(input) && !isHostMoveInput(input)) || input.hostsWorkingBefore.length !== 1
    || input.hostsWorkingBefore[0].documentId !== input.action.target.documentId
    || isHostMoveInput(input) && input.action.selection.documentId !== input.action.target.documentId) unsupported('command')
  return input
}
function plannedSides(input: HostFinalInput | HostInsertInput | HostMoveInput): HostSide[] {
  return input.mode === 'host-final' ? input.finalAfter.map(({ documentId, ...content }) => ({ documentId, content }))
    : [{ documentId: input.action.target.documentId, content: isHostInsertInput(input) ? planSyncedHostInsert(input) : planSyncedHostMove(input) }]
}
/** Both public methods keep their original validated request namespace. The
 * only persistence path is this private, owned transaction, never a DTO rewrite. */
function applyHostMutation(db: Database.Database, value: unknown, method: HostApplyMethod): SyncedHostFinalResult {
  const parsed = validated(() => validateSyncedStructureInput(value))
  if ('status' in parsed) return parsed
  const request: SyncedStructureInput = parsed
  return mutation(db, () => {
    const requestHash = hostHash({ method, input: request }), previous = replay(db, request.clientOperationId, requestHash)
    if (method === 'applySyncedHostCommand' && isHostCreateInput(request)) return applyCreate(db, request, requestHash, previous)
    if (previous && 'createdLifecycle' in previous) throw new Error('原create回执不能当其它结构请求重放。')
    const input = acceptedInput(request, method), after = plannedSides(input)
    if (previous) {
      if (!exactSet(previous.hosts.map(host => host.documentId), input.hostsWorkingBefore.map(host => host.documentId))
        || !exactSet(previous.groups.map(group => group.groupId), input.groups.map(group => group.groupId))) throw new Error('原结构回执与同一请求的参与者不一致。')
      const previousBefore = new Map(input.hostsWorkingBefore.map(host => [host.documentId, host])), previousAfter = new Map(after.map(side => [side.documentId, side.content]))
      for (const saved of previous.hosts) {
        const before = previousBefore.get(saved.documentId)!, after = previousAfter.get(saved.documentId)!
        if (!hostEqual(saved.logicalBefore, before.workingBefore) || !sameHostContent({ title: saved.after.title, summary: saved.after.summary,
          blocks: saved.after.blocks.map(({ sortOrder: _sortOrder, ...block }) => block) }, after)) throw new Error('原结构回执与同一请求完整 W/A 不一致。')
      }
      const logicalChange = input.hostsWorkingBefore.some(host => !sameHostContent(host.workingBefore, previousAfter.get(host.documentId)!))
      if (logicalChange !== (previous.historyToken !== null)) throw new Error('原结构回执的本次可逆 token 与原 W/A 不一致。')
      return previous
    }
    const all = readAllHosts(db), groups = allGroups(db), ids = input.hostsWorkingBefore.map(item => item.documentId), hosts = participating(all, ids)
    checkUpdatedAt(input.hostsWorkingBefore.map(item => ({ documentId: item.documentId, expectedUpdatedAt: item.expectedPersistedUpdatedAt })), hosts, groups)
    const persisted = persistedSides(hosts), before = input.hostsWorkingBefore.map(item => ({ documentId: item.documentId, content: item.workingBefore }))
    if (input.mode === 'command' && !hasSyncedInsertWorkingStructure(persisted[0].content, before[0].content)) unsupported('working-structure')
    checkTitlesAndHeadings(hosts, before, after); nonempty(after)
    const required = guards(input, persisted, [...before, ...after], groups, hosts)
    const workspace = new BlockIdentityRepository(db).getWorkspaceIdentity()
    if (!isSyncedUuid(workspace.workspaceScope) || !isSyncedUuid(workspace.recoveryEpoch)) invalid('identity', '真实工作区身份无效。')
    if (input.mode === 'host-final') checkReferenceAuthority(db, input, persisted, before, after, groups, workspace.workspaceScope)
    else if (isHostInsertInput(input)) checkInsertAuthority(db, input, groups)
    else assertSyncedHostMoveContext(before[0].content, after[0].content)
    const now = time(hosts), acceptedBirths = births(db, [...before, ...after], hosts, now), graph = finalGraph(all, groups, after)
    const physicalChange = after.some(side => !sameHostContent(hosts.get(side.documentId)!.content, side.content))
    const afterById = new Map(after.map(side => [side.documentId, side]))
    const logicalChange = before.some(side => !sameHostContent(side.content, afterById.get(side.documentId)!.content))
    if (!physicalChange && !logicalChange && (input.mode === 'command' || !input.newRefSources.length)) return receipt(db,
      result(db, input.clientOperationId, 'noop', null, before, required, []), requestHash, now)
    prune(db, ids)
    const affected = writeHosts(db, hosts, after, acceptedBirths, groups, graph, now, logicalChange)
    let token: string | null = null
    if (logicalChange) {
      token = randomUUID()
      const dependencies = hostReferencedGroups([...before, ...after])
      const journal: HostJournal = { input, persisted: persisted.map(side => ({ ...side, updatedAt: hosts.get(side.documentId)!.detail.updatedAt })),
        births: acceptedBirths, groups: [...dependencies].map(id => { const group = groups.get(id) ?? missing('group', id)
          return { groupId: id, creationId: group.creationId, createdAt: group.createdAt, origin: group.origin } }), before, after }
      const encoded = encodeHostJournal(journal)
      const row: SyncedHostHistoryBranchRow = { id: token, action_json: encoded.action, before_json: encoded.before, after_json: encoded.after,
        before_hash: encoded.beforeHash, after_hash: encoded.afterHash, created_at: now }
      decodeHostJournal(row)
      insertHostJournal(db, row)
      appendHostHistory(db, ids, token, journal.groups, now)
    }
    for (const id of ids) assertHostChain(db, id)
    return receipt(db, result(db, input.clientOperationId, 'applied', token, before, required, affected), requestHash, now)
  })
}

export function applySyncedHostFinal(db: Database.Database, value: unknown): SyncedHostFinalResult {
  return applyHostMutation(db, value, 'applySyncedHostFinal')
}
export function applySyncedHostCommand(db: Database.Database, value: unknown): SyncedHostFinalResult {
  return applyHostMutation(db, value, 'applySyncedHostCommand')
}
export function restoreSyncedHostOperation(db: Database.Database, value: unknown): SyncedHostFinalResult {
  const parsed = validated(() => validateSyncedRestoreHostInput(value))
  if ('status' in parsed) return parsed
  const input: SyncedRestoreHostInput = parsed
  return mutation(db, () => {
    const requestHash = hostHash({ method: 'restoreSyncedHostOperation', input }), previous = replay(db, input.clientOperationId, requestHash)
    if (previous) {
      if ('createdLifecycle' in previous) return replayCreateRestore(db, input, previous)
      if (!exactSet(previous.hosts.map(host => host.documentId), input.expectedHosts.map(host => host.documentId))
        || !exactSet(previous.groups.map(group => group.groupId), input.groups.map(group => group.groupId))
        || previous.historyToken !== null && previous.historyToken !== input.historyToken) throw new Error('原逆操作回执与同一请求身份不一致。')
      return previous
    }
    const row = db.prepare('SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at FROM synced_host_history WHERE id=?')
      .get(input.historyToken) as SyncedHostHistoryBranchRow | undefined
    if (!row) conflict('history', new Map(), new Map())
    if (hostJournalKind(row) === 'bare-create') unsupported('journal-kind')
    const journal = decodeHostJournal(row)
    if ('create' in journal) return restoreCreate(db, input, requestHash, journal)
    const undo = input.direction === 'undo', from = undo ? journal.after : journal.before, to = undo ? journal.before : journal.after
    const ids = from.map(side => side.documentId)
    if (!exactSet(input.expectedHosts.map(item => item.documentId), ids)) invalid('binding', '恢复宿主必须与真实 journal 参与者双向闭合。')
    const all = readAllHosts(db), groups = allGroups(db), hosts = participating(all, ids), persisted = persistedSides(hosts)
    checkUpdatedAt(input.expectedHosts, hosts, groups)
    const mappings = db.prepare('SELECT document_id,position FROM synced_host_history_documents WHERE history_id=?').all(input.historyToken) as Array<{ document_id: string; position: number }>
    const externalCut = readSyncedExchangeHostCut(db, input.historyToken)
    if (mappings.length === 0 && externalCut) {
      // A complete external boundary may retire the entire executable branch while preserving its immutable journal/ACK/pins.
      for (const id of ids) {
        assertHostChain(db, id)
        const history = getSyncedHostHistory(db, { documentId: id })
        if (history.undoToken === input.historyToken || history.redoToken === input.historyToken)
          throw new Error('已撤执行映射的宿主 journal 仍被实际 Undo/Redo tail 引用。')
      }
      conflict('history', groups, hosts)
    }
    if (!exactSet(mappings.map(item => item.document_id), ids)) throw new Error('宿主 journal 与实际 mappings 参与者不一致。')
    for (const side of from) {
      assertHostChain(db, side.documentId)
      const state = getSyncedHostHistory(db, { documentId: side.documentId })
      if ((undo ? state.undoToken : state.redoToken) !== input.historyToken || !sameHostContent(hosts.get(side.documentId)!.content, side.content)) conflict('history', groups, hosts)
    }
    for (const dependency of journal.groups) {
      const current = groups.get(dependency.groupId) ?? missing('group', dependency.groupId)
      if (current.creationId !== dependency.creationId || current.createdAt !== dependency.createdAt || !hostEqual(current.origin, dependency.origin)) conflict('group', groups, hosts)
      if (!db.prepare("SELECT 1 FROM synced_group_pins WHERE group_id=? AND kind='host-history' AND pin_id=?").get(dependency.groupId, input.historyToken)) throw new Error('逆操作所需的原 incarnation pin 缺失。')
    }
    nonempty(to); checkTitlesAndHeadings(hosts, persisted, to)
    if (isHostMoveInput(journal.input)) assertSyncedHostMoveContext(persisted[0].content, to[0].content)
    const required = guards(input, persisted, to, groups, hosts, journal.groups.map(item => item.groupId))
    const now = time(hosts), acceptedBirths = births(db, [...from, ...to], hosts, now, journal.births), graph = finalGraph(all, groups, to)
    if (to.every(side => sameHostContent(hosts.get(side.documentId)!.content, side.content))) return receipt(db,
      result(db, input.clientOperationId, 'noop', null, persisted, required, []), requestHash, now)
    const affected = writeHosts(db, hosts, to, acceptedBirths, groups, graph, now, true)
    const mappingsById = new Map(mappings.map(item => [item.document_id, item]))
    for (const id of ids) {
      const current = db.prepare('SELECT cursor,position FROM synced_host_history_state WHERE document_id=?').get(id) as { cursor: string; position: number }
      const mapping = mappingsById.get(id)!
      if (!Number.isSafeInteger(mapping.position) || mapping.position !== current.position + (undo ? 0 : 1)) conflict('history', groups, hosts)
      if (db.prepare('UPDATE synced_host_history_state SET cursor=?,position=? WHERE document_id=? AND cursor=? AND position=?')
        .run(randomUUID(), current.position + (undo ? -1 : 1), id, current.cursor, current.position).changes !== 1) conflict('history', groups, hosts)
      assertHostChain(db, id)
    }
    return receipt(db, result(db, input.clientOperationId, 'applied', input.historyToken, persisted, required, affected), requestHash, now)
  })
}

function insertHostJournal(db: Database.Database, row: SyncedHostHistoryBranchRow): void {
  db.prepare('INSERT INTO synced_host_history(id,action_json,before_json,after_json,before_hash,after_hash,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(row.id, row.action_json, row.before_json, row.after_json, row.before_hash, row.after_hash, row.created_at)
}
function appendHostHistory(db: Database.Database, ids: string[], token: string, dependencies: HostJournal['groups'], now: string): void {
  for (const id of ids) {
    const state = db.prepare('SELECT position FROM synced_host_history_state WHERE document_id=?').get(id) as { position: number }
    if (!Number.isSafeInteger(state.position + 1)) invalid('forest', '宿主历史位置超过安全整数。')
    db.prepare('INSERT INTO synced_host_history_documents(history_id,document_id,position) VALUES(?,?,?)').run(token, id, state.position + 1)
    db.prepare('UPDATE synced_host_history_state SET cursor=?,position=? WHERE document_id=?').run(randomUUID(), state.position + 1, id)
  }
  for (const dependency of dependencies) db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)').run(dependency.groupId, 'host-history', token, now)
}
function storedCreateJournal(db: Database.Database, token: string): HostCreateJournal {
  const row = db.prepare('SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at FROM synced_host_history WHERE id=?').get(token) as SyncedHostHistoryBranchRow | undefined
  if (!row) throw new Error('create 原完整日志缺失，不能重建来源。')
  return decodeHostCreateJournal(row)
}
function createReceipt(db: Database.Database, value: SyncedHostCreateApplied, requestHash: string, now: string): SyncedHostCreateApplied {
  const exact = validateHostCreateOperationAck(value, value.operationId)
  db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)').run(exact.operationId, requestHash,
    hostEncode({ kind: 'synced-host-create-operation', version: 1, result: exact }), now)
  return exact
}
function createLifeSide(db: Database.Database, journal: HostCreateJournal, token: string): CreatedLifecycleSide {
  if (isSyncedGroupLogicallyDeleted(db, journal.create.wire.id)) unsupported('lifecycle')
  const groupId = journal.create.wire.id, state = readSyncedGroupLifecycles(db, [groupId]).get(groupId)
  const row = db.prepare('SELECT revision,topology_revision,bindings_json,history_cursor,history_position FROM synced_groups WHERE id=?').get(groupId) as { revision: string; topology_revision: string; bindings_json: string; history_cursor: string; history_position: number } | undefined
  if (!state || !row || state.exposure !== 'never' || state.createHistoryId !== token || state.creationId !== journal.create.wire.creationId
    || row.revision !== state.activationRevision || row.topology_revision !== state.activationTopologyRevision) unsupported('lifecycle')
  if (!hostEqual(hostJson(row.bindings_json), journal.create.wire.bindings) || !isSyncedUuid(row.history_cursor) || row.history_position !== 0
    || db.prepare('SELECT 1 FROM synced_group_history WHERE group_id=? LIMIT 1').get(groupId)) unsupported('lifecycle')
  const wire = journal.create.wire, base = { groupId, creationId: wire.creationId, createdAt: wire.createdAt, origin: wire.origin,
    createHistoryId: token, stateVersion: state.stateVersion, exposure: 'never' as const, revision: row.revision, topologyRevision: row.topology_revision,
    activationRevision: state.activationRevision, activationTopologyRevision: state.activationTopologyRevision, activationHash: state.activationHash, activationInstances: state.activationInstances }
  if (state.activationHash !== journal.create.wireHash) unsupported('lifecycle')
  if (state.state === 'active') return validateCreatedLifecycleSide({ ...base, state: 'active' })
  const retirement = db.prepare('SELECT wire_json,retired_at FROM synced_group_retirements WHERE group_id=?').get(groupId) as { wire_json: string; retired_at: string } | undefined
  if (!retirement) throw new Error('create 退役原wire缺失。')
  return validateCreatedLifecycleSide({ ...base, state: 'retired-create', wire: hostJson(retirement.wire_json), retiredAt: retirement.retired_at })
}
function createResult(db: Database.Database, operationId: string, token: string, before: HostSide[], required: Set<string>, affected: string[], journal: HostCreateJournal): SyncedHostCreateApplied {
  const createdLifecycle = createLifeSide(db, journal, token), visible = new Set(required)
  if (createdLifecycle.state === 'retired-create') visible.delete(createdLifecycle.groupId)
  return { ...result(db, operationId, 'applied', token, before, visible, affected), status: 'applied', historyToken: token, blockIdMap: [], createdLifecycle }
}
function applyCreate(db: Database.Database, input: HostCreateInput, requestHash: string, previous: SyncedMainHostSuccess | null): SyncedHostCreateApplied {
  if (input.hostsWorkingBefore.length !== 1 || input.hostsWorkingBefore[0].documentId !== input.action.documentId) unsupported('command')
  if (previous) {
    if (!('createdLifecycle' in previous) || previous.createdLifecycle.state !== 'active' || previous.createdLifecycle.groupId !== input.action.groupId) throw new Error('原create回执namespace或创建组不匹配。')
    const journal = storedCreateJournal(db, previous.historyToken)
    if (!hostEqual(journal.input, input) || !hostEqual(previous.hosts.map(host => ({ documentId: host.documentId, content: host.logicalBefore })), journal.before)
      || !sameHostContent({ title: previous.hosts[0].after.title, summary: previous.hosts[0].after.summary, blocks: previous.hosts[0].after.blocks.map(({ sortOrder: _order, ...block }) => block) }, journal.after[0].content)) throw new Error('原create回执与同一请求完整 W/A 不一致。')
    return previous
  }
  const all = readAllHosts(db), groups = allGroups(db), ids = [input.action.documentId], hosts = participating(all, ids), persisted = persistedSides(hosts)
  const before: HostSide[] = input.hostsWorkingBefore.map(item => ({ documentId: item.documentId, content: item.workingBefore }))
  checkUpdatedAt(input.hostsWorkingBefore.map(item => ({ documentId: item.documentId, expectedUpdatedAt: item.expectedPersistedUpdatedAt })), hosts, groups)
  if (!hasSyncedInsertWorkingStructure(persisted[0].content, before[0].content)) unsupported('working-structure')
  const required = guards(input, persisted, before, groups, hosts), repository = new BlockIdentityRepository(db), workspace = repository.getWorkspaceIdentity()
  if (!isSyncedUuid(workspace.workspaceScope) || !isSyncedUuid(workspace.recoveryEpoch)) invalid('identity', '真实工作区身份无效。')
  if (db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(input.action.groupId)) invalid('identity', 'create 组身份已被active或retired incarnation占用。')
  if (repository.get(input.action.instanceId) || repository.resolveLiveOwner(input.action.instanceId)) invalid('identity', 'create 新实例不是未占用的fresh UUID。')
  const now = time(hosts), originalBirths = births(db, before, hosts, now), oldBirths = new Map(originalBirths.map(item => [item.blockId, item.createdAt])), allocated = new Set(before[0].content.blocks.map(block => block.id))
  allocated.add(input.action.instanceId)
  const shape = planSyncedHostCreate(input, () => {
    let id: string; do { id = randomUUID() } while (allocated.has(id) || repository.get(id) || repository.resolveLiveOwner(id))
    allocated.add(id); return { id, createdAt: now }
  })
  const after: HostSide[] = [{ documentId: input.action.documentId, content: shape.after }]
  nonempty(after); checkTitlesAndHeadings(hosts, before, after)
  const acceptedBirths = births(db, [...before, ...after], hosts, now), birthMap = new Map(acceptedBirths.map(item => [item.blockId, item.createdAt]))
  const origin = { version: 1 as const, documentId: input.action.documentId, pathAtCreation: hosts.get(input.action.documentId)!.detail.path, firstInstanceId: input.action.instanceId }
  const sourceBindings = captureSyncedCreateBindings(db, origin, before[0].content.blocks), sourceMap = new Map(sourceBindings.map(item => [createPhysicalKey(item.key), item]))
  const auxMap = new Map(shape.auxiliary.map(item => [item.id, item]))
  const candidate = validateSyncedGroupWire({ kind: 'synced-group', id: input.action.groupId, creationId: randomUUID(), createdAt: now, origin,
    blocks: shape.canonical.map(block => ({ ...block, createdAt: auxMap.get(block.id)?.createdAt ?? oldBirths.get(block.id) ?? invalid('identity', 'canonical 选区缺少其Main准确birth。') })),
    bindings: projectSyncedCreateLinks(shape, captureSyncedCreateSourceFacts(before[0].content.blocks).links).filter(item => sourceMap.has(createPhysicalKey(item.source))).map(item => ({ ...item.destination, target: sourceMap.get(createPhysicalKey(item.source))!.target })) })
  const graph = finalGraph(all, groups, after, { wire: candidate, retire: false }), token = randomUUID(), revision = randomUUID(), topology = randomUUID(), binding = randomUUID()
  const dependencies = [...required].map(id => { const group = groups.get(id)!; return { groupId: id, creationId: group.creationId, createdAt: group.createdAt, origin: group.origin } })
  dependencies.push({ groupId: candidate.id, creationId: candidate.creationId, createdAt: candidate.createdAt, origin: candidate.origin }); required.add(candidate.id)
  const journal: HostCreateJournal = { input, persisted: persisted.map(side => ({ ...side, updatedAt: hosts.get(side.documentId)!.detail.updatedAt })), births: acceptedBirths,
    groups: dependencies, before, after, create: { wire: candidate, wireHash: createRawHash(candidate), selectedIds: shape.selectedIds, auxiliary: shape.auxiliary, instanceCreatedAt: birthMap.get(input.action.instanceId)!, sourceBindings } }
  const encoded = encodeHostCreateJournal(journal), row = { id: token, action_json: encoded.action, before_json: encoded.before, after_json: encoded.after, before_hash: encoded.beforeHash, after_hash: encoded.afterHash, created_at: now }
  decodeHostCreateJournal(row); prune(db, ids); insertHostJournal(db, row)
  db.prepare('INSERT INTO synced_groups(id,creation_id,created_at,origin_json,bindings_json,revision,topology_revision,history_cursor,history_position) VALUES(?,?,?,?,?,?,?,?,0)')
    .run(candidate.id, candidate.creationId, candidate.createdAt, hostEncode(candidate.origin), hostEncode(candidate.bindings), revision, topology, randomUUID())
  db.prepare("INSERT INTO synced_group_lifecycle(group_id,creation_id,state,state_version,exposure_state,create_history_id,activation_revision,activation_topology_revision,activation_hash,activation_instances_json,created_at,updated_at) VALUES(?,?,'active',1,'never',?,?,?,?,?,?,?)")
    .run(candidate.id, candidate.creationId, token, revision, topology, journal.create.wireHash, hostEncode([{ instanceId: input.action.instanceId, hostDocumentId: input.action.documentId, bindingVersion: binding }]), now, now)
  const affected = writeHosts(db, hosts, after, acceptedBirths, groups, graph, now, true, createWritePermit(journal, 'create', binding))
  for (const id of journal.create.selectedIds) db.prepare('INSERT OR IGNORE INTO document_block_routes(document_path,block_id) VALUES(?,?)').run(origin.pathAtCreation, id)
  assertSyncedStoredBindings(db, candidate.origin, candidate.blocks, candidate.bindings, candidate.id)
  appendHostHistory(db, ids, token, journal.groups, now); assertHostChain(db, ids[0])
  return createReceipt(db, createResult(db, input.clientOperationId, token, before, required, affected, journal), requestHash, now)
}
function writeCreateOwnership(db: Database.Database, permit: CreateWritePermit): void {
  const { journal, direction } = permit, group = journal.create.wire, documentId = journal.input.action.documentId, undo = direction === 'undo'
  if (undo) db.prepare('DELETE FROM synced_group_blocks WHERE group_id=?').run(group.id)
  const birthMap = new Map(journal.births.map(item => [item.blockId, item.createdAt]))
  for (const id of journal.create.selectedIds) {
    const from = undo ? 'group' : 'document', to = undo ? 'document' : 'group', sourceId = undo ? group.id : documentId, targetId = undo ? documentId : group.id
    if (db.prepare("UPDATE block_identities SET last_owner_kind=?,last_owner_id=? WHERE id=? AND last_owner_kind=? AND last_owner_id=? AND state='retained' AND created_at=?")
      .run(to, targetId, id, from, sourceId, birthMap.get(id)).changes !== 1) invalid('identity', 'create 原selected owner/birth迁域不完整。')
  }
  if (undo) return
  const repository = new BlockIdentityRepository(db)
  for (const item of journal.create.auxiliary) if (item.role === 'group-definition' && !repository.get(item.id)) db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'group',?,'retained',?)").run(item.id, group.id, item.createdAt)
  const insert = db.prepare('INSERT INTO synced_group_blocks(id,group_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,language,list_start,markdown_format_json,highlight,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  group.blocks.forEach((block, index) => insert.run(block.id, group.id, block.parentBlockId, index, block.type, block.content, block.checked ? 1 : 0, block.depth, block.tags === undefined ? null : hostEncode(block.tags), block.language ?? null, block.listStart ?? null, block.markdownFormat === undefined ? null : hostEncode(block.markdownFormat), block.highlight ?? null, block.createdAt))
}

function replayCreateRestore(db: Database.Database, input: SyncedRestoreHostInput, previous: SyncedHostCreateApplied): SyncedHostCreateApplied {
  const journal = storedCreateJournal(db, input.historyToken), undo = input.direction === 'undo', from = undo ? journal.after : journal.before, to = undo ? journal.before : journal.after
  if (previous.historyToken !== input.historyToken || previous.createdLifecycle.state !== (undo ? 'retired-create' : 'active')
    || !exactSet(input.expectedHosts.map(item => item.documentId), from.map(side => side.documentId))
    || !exactSet(input.groups.map(item => item.groupId), journal.groups.map(item => item.groupId))
    || !hostEqual(previous.hosts.map(item => ({ documentId: item.documentId, content: item.logicalBefore })), from)
    || previous.hosts.some(item => !sameHostContent({ title: item.after.title, summary: item.after.summary, blocks: item.after.blocks.map(({ sortOrder: _order, ...block }) => block) }, to.find(side => side.documentId === item.documentId)!.content))) throw new Error('原create逆回执与同一请求完整原side不一致。')
  return previous
}
function stableTarget(value: HostCreateJournal['create']['sourceBindings'][number]['target']): unknown {
  if (value.kind === 'document' || value.kind === 'block') return { kind: value.kind, id: value.id }
  if (value.kind === 'heading') return { kind: value.kind, documentId: value.documentId, slug: value.slug }
  return value
}
function checkCreateInverseSources(db: Database.Database, journal: HostCreateJournal, hosts: Hosts): void {
  const original = journal.create.wire.origin, current = hosts.get(original.documentId)!
  // Relative image/asset bases are not covered by the local-document ledger.
  // This first create slice conservatively keeps the original host path.
  if (current.detail.path !== original.pathAtCreation) unsupported('semantic-binding')
  const source = captureSyncedCreateBindings(db, { ...original, pathAtCreation: current.detail.path }, journal.before[0].content.blocks)
  const expected = new Map(journal.create.sourceBindings.map(item => [createPhysicalKey(item.key), item]))
  if (source.length !== expected.size || source.some(item => { const old = expected.get(createPhysicalKey(item.key)); return !old || old.url !== item.url || !hostEqual(stableTarget(old.target), stableTarget(item.target)) })) unsupported('semantic-binding')
}
function checkCreateOriginalIdentities(db: Database.Database, journal: HostCreateJournal, undo: boolean): void {
  const repository = new BlockIdentityRepository(db), selected = new Set(journal.create.selectedIds), from = undo ? journal.after[0].content : journal.before[0].content
  const currentIds = new Set(from.blocks.map(block => block.id)), groupId = journal.create.wire.id, documentId = journal.input.action.documentId
  for (const birth of journal.births) {
    const identity = repository.get(birth.blockId), owner = repository.resolveLiveOwner(birth.blockId), canonical = undo && selected.has(birth.blockId)
    const kind = canonical ? 'group' : 'document', id = canonical ? groupId : documentId, live = canonical || currentIds.has(birth.blockId)
    if (!identity || identity.owner.kind !== kind || identity.owner.id !== id || identity.createdAt !== birth.createdAt
      || (live ? identity.state !== 'live' || owner?.kind !== kind || owner.id !== id : identity.state !== 'retained' || owner !== null)) invalid('identity', 'create 原W/实例/辅助身份、准确birth或retained资格已变化。')
  }
  for (const item of journal.create.auxiliary) if (item.role === 'group-definition') {
    const identity = repository.get(item.id), owner = repository.resolveLiveOwner(item.id)
    if (!identity || identity.owner.kind !== 'group' || identity.owner.id !== groupId || identity.createdAt !== item.createdAt
      || (undo ? identity.state !== 'live' || owner?.kind !== 'group' || owner.id !== groupId : identity.state !== 'retained' || owner !== null)) invalid('identity', 'create 原group辅助definition身份不再准确。')
  }
}
function assertCreateObservationAllowsInverse(db: Database.Database, journal: HostCreateJournal): void {
  if (isSyncedGroupLogicallyDeleted(db, journal.create.wire.id)) unsupported('lifecycle')
  const observed = journal.create.wire
  if (hasSyncedRemoteObservationForCreate(db, { groupId: observed.id, creationId: observed.creationId,
    createdAt: observed.createdAt, origin: observed.origin })) unsupported('lifecycle')
}
function createInversePreflight(db: Database.Database, input: SyncedRestoreHostInput, journal: HostCreateJournal) {
  assertCreateObservationAllowsInverse(db, journal)
  const undo = input.direction === 'undo', from = undo ? journal.after : journal.before, to = undo ? journal.before : journal.after, ids = from.map(side => side.documentId)
  if (!exactSet(input.expectedHosts.map(item => item.documentId), ids)) invalid('binding', 'create 恢复宿主必须与原journal完整闭合。')
  const all = readAllHosts(db), groups = allGroups(db), hosts = participating(all, ids), persisted = persistedSides(hosts), groupId = journal.create.wire.id
  checkUpdatedAt(input.expectedHosts, hosts, groups)
  for (const side of from) {
    assertHostChain(db, side.documentId); const history = getSyncedHostHistory(db, { documentId: side.documentId })
    if ((undo ? history.undoToken : history.redoToken) !== input.historyToken || !sameHostContent(hosts.get(side.documentId)!.content, side.content)) conflict('history', groups, hosts)
  }
  const mappings = db.prepare('SELECT document_id,position FROM synced_host_history_documents WHERE history_id=?').all(input.historyToken) as Array<{ document_id: string; position: number }>
  if (!exactSet(mappings.map(item => item.document_id), ids)) throw new Error('create 原journal与mappings参与者不一致。')
  const lifecycle = createLifeSide(db, journal, input.historyToken)
  if (lifecycle.state !== (undo ? 'active' : 'retired-create')) unsupported('lifecycle')
  const ownGuard = input.groups.find(item => item.groupId === groupId)
  if (!ownGuard || ownGuard.expectedRevision !== lifecycle.revision || ownGuard.expectedTopologyRevision !== lifecycle.topologyRevision) conflict('group', groups, hosts)
  const ownInstances = input.expectedInstances.filter(item => item.instanceId === journal.input.action.instanceId)
  if (undo) {
    const current = groups.get(groupId)
    if (!current || !hostEqual(wire(current), journal.create.wire) || !hostEqual(current.instances.map(({ instanceId, hostDocumentId, bindingVersion }) => ({ instanceId, hostDocumentId, bindingVersion })), lifecycle.activationInstances)) unsupported('lifecycle')
    if (ownInstances.length !== 1 || !hostEqual(ownInstances, lifecycle.activationInstances)) conflict('topology', groups, hosts)
    const pins = db.prepare('SELECT kind,pin_id FROM synced_group_pins WHERE group_id=?').all(groupId) as Array<{ kind: string; pin_id: string }>
    if (pins.length !== 1 || pins[0].kind !== 'host-history' || pins[0].pin_id !== input.historyToken) unsupported('lifecycle')
  } else if (ownInstances.length) invalid('binding', 'retired的新实例没有实际registry，不能伪造expectedInstance。')
  for (const dependency of journal.groups) if (dependency.groupId !== groupId) {
    const current = groups.get(dependency.groupId) ?? missing('group', dependency.groupId)
    if (current.creationId !== dependency.creationId || current.createdAt !== dependency.createdAt || !hostEqual(current.origin, dependency.origin)) conflict('group', groups, hosts)
    if (!db.prepare("SELECT 1 FROM synced_group_pins WHERE group_id=? AND kind='host-history' AND pin_id=?").get(dependency.groupId, input.historyToken)) throw new Error('create 原其它组依赖pin缺失。')
  }
  const withoutOwn = (values: HostSide[]) => values.map(side => ({ ...side, content: { ...side.content, blocks: side.content.blocks.filter(block => block.id !== journal.input.action.instanceId) } }))
  const otherInput = { groups: input.groups.filter(item => item.groupId !== groupId), expectedInstances: input.expectedInstances.filter(item => item.instanceId !== journal.input.action.instanceId) }
  const other = guards(otherInput, withoutOwn(persisted), withoutOwn(to), groups, hosts, journal.groups.filter(item => item.groupId !== groupId).map(item => item.groupId))
  if (input.groups.length !== other.size + 1) invalid('binding', 'create 原组与retired组guard未双向闭合。')
  other.add(groupId)
  nonempty(to); checkTitlesAndHeadings(hosts, persisted, to); checkCreateOriginalIdentities(db, journal, undo); checkCreateInverseSources(db, journal, hosts)
  const graph = finalGraph(all, groups, to, { wire: journal.create.wire, retire: undo })
  return { undo, from, to, ids, all, groups, hosts, persisted, lifecycle, mappings, required: other, graph }
}
function restoreCreate(db: Database.Database, input: SyncedRestoreHostInput, requestHash: string, journal: HostCreateJournal): SyncedHostCreateApplied {
  const checked = createInversePreflight(db, input, journal), group = journal.create.wire, now = time(checked.hosts)
  const binding = checked.undo ? checked.lifecycle.activationInstances[0].bindingVersion : randomUUID()
  if (checked.undo) {
    db.prepare('INSERT INTO synced_group_retirements(group_id,creation_id,create_history_id,wire_json,semantic_hash,retired_at) VALUES(?,?,?,?,?,?)')
      .run(group.id, group.creationId, input.historyToken, hostEncode(group), journal.create.wireHash, now)
    if (db.prepare("DELETE FROM synced_group_pins WHERE group_id=? AND kind='host-history' AND pin_id=?").run(group.id, input.historyToken).changes !== 1) throw new Error('create 自身精确pin无法撤回。')
  } else {
    const revision = randomUUID(), topology = randomUUID()
    if (db.prepare('UPDATE synced_groups SET revision=?,topology_revision=?,history_cursor=? WHERE id=? AND revision=? AND topology_revision=?').run(revision, topology, randomUUID(), group.id, checked.lifecycle.revision, checked.lifecycle.topologyRevision).changes !== 1) conflict('group', checked.groups, checked.hosts)
    if (db.prepare("UPDATE synced_group_lifecycle SET state='active',state_version=state_version+1,activation_revision=?,activation_topology_revision=?,activation_hash=?,activation_instances_json=?,updated_at=? WHERE group_id=? AND state='retired-create' AND exposure_state='never' AND state_version=?")
      .run(revision, topology, journal.create.wireHash, hostEncode([{ instanceId: journal.input.action.instanceId, hostDocumentId: journal.input.action.documentId, bindingVersion: binding }]), now, group.id, checked.lifecycle.stateVersion).changes !== 1) unsupported('lifecycle')
    if (db.prepare('DELETE FROM synced_group_retirements WHERE group_id=?').run(group.id).changes !== 1) throw new Error('create 原冻结retirement无法消费。')
  }
  const affected = writeHosts(db, checked.hosts, checked.to, journal.births, checked.groups, checked.graph, now, true,
    createWritePermit(journal, checked.undo ? 'undo' : 'redo', binding))
  if (checked.undo) {
    if (db.prepare("UPDATE synced_group_lifecycle SET state='retired-create',state_version=state_version+1,updated_at=? WHERE group_id=? AND state='active' AND exposure_state='never' AND state_version=?")
      .run(now, group.id, checked.lifecycle.stateVersion).changes !== 1) unsupported('lifecycle')
  } else {
    db.prepare("INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,'host-history',?,?)").run(group.id, input.historyToken, now)
    assertSyncedStoredBindings(db, group.origin, group.blocks, group.bindings, group.id)
  }
  const map = new Map(checked.mappings.map(item => [item.document_id, item]))
  for (const id of checked.ids) {
    const current = db.prepare('SELECT cursor,position FROM synced_host_history_state WHERE document_id=?').get(id) as { cursor: string; position: number }, mapping = map.get(id)!
    if (mapping.position !== current.position + (checked.undo ? 0 : 1)) conflict('history', checked.groups, checked.hosts)
    if (db.prepare('UPDATE synced_host_history_state SET cursor=?,position=? WHERE document_id=? AND cursor=? AND position=?').run(randomUUID(), current.position + (checked.undo ? -1 : 1), id, current.cursor, current.position).changes !== 1) conflict('history', checked.groups, checked.hosts)
    assertHostChain(db, id)
  }
  return createReceipt(db, createResult(db, input.clientOperationId, input.historyToken, checked.from, checked.required, affected, journal), requestHash, now)
}

export type SyncedCreateRestoreContext = { status: 'ready'; workspaceScope: string; restore: Omit<SyncedRestoreHostInput, 'clientOperationId'>; createdLifecycle: CreatedLifecycleSide }
  | { status: 'unavailable'; reason: 'journal-kind' | 'history' | 'lifecycle' }
export function getSyncedCreateRestoreContext(db: Database.Database, value: unknown): SyncedCreateRestoreContext {
  assertSyncedShape(value, ['historyToken', 'direction'])
  if (!isSyncedUuid(value.historyToken) || value.direction !== 'undo' && value.direction !== 'redo') invalid('identity', 'create restore-context 输入无效。')
  const historyToken = value.historyToken, direction = value.direction
  if (db.inTransaction) throw new Error('create restore-context 必须拥有自己的只读事务。')
  return db.transaction((): SyncedCreateRestoreContext => {
    const row = db.prepare('SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at FROM synced_host_history WHERE id=?').get(historyToken) as SyncedHostHistoryBranchRow | undefined
    if (!row) return { status: 'unavailable', reason: 'history' }
    if (hostJournalKind(row) === 'bare-create') return { status: 'unavailable', reason: 'journal-kind' }
    const journal = decodeHostJournal(row)
    if (!('create' in journal)) return { status: 'unavailable', reason: 'journal-kind' }
    try {
      assertCreateObservationAllowsInverse(db, journal)
      for (const side of journal.before) {
        assertHostChain(db, side.documentId)
        const history = getSyncedHostHistory(db, { documentId: side.documentId })
        if ((direction === 'undo' ? history.undoToken : history.redoToken) !== historyToken) return { status: 'unavailable', reason: 'history' }
      }
      const all = readAllHosts(db), groups = allGroups(db), document = all.get(journal.input.action.documentId) ?? missing('document', journal.input.action.documentId)
      const side = createLifeSide(db, journal, historyToken), guards = journal.groups.map(dependency => {
        const group = dependency.groupId === side.groupId ? side : groups.get(dependency.groupId) ?? missing('group', dependency.groupId)
        return { groupId: dependency.groupId, expectedRevision: group.revision, expectedTopologyRevision: group.topologyRevision }
      })
      const expectedInstances = document.content.blocks.filter(block => block.type === 'synced-block').map(block => {
        const group = groups.get(parseSyncedBlockPayload(block.content).groupId), instance = group?.instances.find(item => item.instanceId === block.id)
        if (!instance) return missing('instance', block.id)
        return { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion }
      })
      const restore: Omit<SyncedRestoreHostInput, 'clientOperationId'> = { historyToken, direction, expectedHosts: [{ documentId: document.detail.id, expectedUpdatedAt: document.detail.updatedAt }], groups: guards, expectedInstances }
      const checked = createInversePreflight(db, { clientOperationId: historyToken, ...restore }, journal), workspace = new BlockIdentityRepository(db).getWorkspaceIdentity()
      if (!isSyncedUuid(workspace.workspaceScope) || !isSyncedUuid(workspace.recoveryEpoch)) invalid('identity', '真实工作区身份无效。')
      return { status: 'ready', workspaceScope: workspace.workspaceScope, restore, createdLifecycle: checked.lifecycle }
    } catch (error) {
      if (error instanceof Refused) return { status: 'unavailable', reason: 'kind' in error.result && error.result.kind === 'history' ? 'history' : 'lifecycle' }
      if (error instanceof UnsupportedSyncedHostCreate) return { status: 'unavailable', reason: 'lifecycle' }
      throw error
    }
  })()
}
