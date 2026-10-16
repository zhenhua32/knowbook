import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedFailure, SyncedGroupSnapshot, SyncedGroupWire, SyncedRestoreHostInput,
  SyncedStableBlockDraft, SyncedStructureApplied, SyncedStructureInput, SyncedStructureResult } from '../../shared/synced-blocks'
import { validateSyncedRestoreHostInput, validateSyncedStructureInput } from '../../shared/syncedBlockInputs'
import { isSyncedUuid, parseSyncedBlockPayload, SYNCED_MAX_BLOCKS, SyncedValidationError } from '../../shared/syncedBlockValidation'
import { validateSyncedWorkspaceGraph } from '../../shared/syncedBlockGraph'
import { projectSyncedGroupBudget, projectSyncedHostBudget } from '../../shared/syncedBlockPortable'
import { getMarkdownHeadingRewrites, getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { BlockIdentityRepository } from './block-identities'
import { getSyncedGroupSnapshots, getSyncedHostHistory } from './synced-blocks-read'
import { readSyncedGroupOperationRow } from './synced-group-operation-receipt'
import { decodeHostOperationAck, validateHostOperationAck } from './synced-host-operation-receipt'
import { readStrictHostDocument, type StrictHostDocument, type HostContent } from './synced-host-document-read'
import { decodeHostJournal, encodeHostJournal, hostEncode, hostEqual, hostHash, hostReferencedGroups,
  sameHostContent, hostJournalKind, type HostBirth, type HostFinalInput, type HostJournal, type HostSide } from './synced-host-journal'
import { pruneSyncedHostRedoBranches, type SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { MarkdownLinkIndex } from './markdown-link-index'
import { hasSyncedInsertWorkingStructure, isHostInsertInput, planSyncedHostInsert, type HostInsertInput } from './synced-host-insert-plan'

export { getSyncedHostHistory }
export type SyncedHostFinalResult = SyncedStructureResult | { status: 'unsupported'; reason: 'command' | 'title-change' | 'owner-transfer' | 'journal-kind' | 'heading-rewrite' | 'working-structure' }
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
function mutation(db: Database.Database, run: () => SyncedStructureApplied): SyncedHostFinalResult {
  if (db.inTransaction) throw new Error('宿主结构仓库必须拥有真实外层 IMMEDIATE 事务。')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('宿主结构写入必须启用 SQLite 外键。')
  try { return db.transaction(run).immediate() }
  catch (error) {
    if (error instanceof Refused) return error.result
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
function replay(db: Database.Database, operationId: string, requestHash: string): SyncedStructureApplied | null {
  const row = readSyncedGroupOperationRow(db, operationId)
  if (!row) return null
  if (!/^[a-f0-9]{64}$/.test(row.request_hash)) throw new Error('宿主操作请求哈希损坏。')
  if (row.request_hash !== requestHash) throw new Refused({ status: 'idempotency-mismatch' })
  return { ...decodeHostOperationAck(row), replayed: true }
}
function receipt(db: Database.Database, result: SyncedStructureApplied, requestHash: string, now: string): SyncedStructureApplied {
  const exact = validateHostOperationAck(result, result.operationId)
  db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
    .run(result.operationId, requestHash, hostEncode({ kind: 'synced-host-operation', version: 1, result: exact }), now)
  return exact
}
function host(db: Database.Database, id: string): StrictHostDocument { return readStrictHostDocument(db, id) ?? missing('document', id) }
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
function finalGraph(allHosts: Hosts, groups: Groups, after: HostSide[]) {
  const overlays = new Map(after.map(side => [side.documentId, side.content]))
  const documents = [...allHosts].map(([documentId, value]) => ({ documentId, blocks: (overlays.get(documentId) ?? value.content).blocks }))
  const wires = [...groups.values()].map(wire), graph = validateSyncedWorkspaceGraph(documents, wires), byGroup = new Map(wires.map(item => [item.id, item]))
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
function writeHosts(db: Database.Database, before: Hosts, after: HostSide[], acceptedBirths: HostBirth[], groups: Groups,
  graph: ReturnType<typeof finalGraph>, now: string, touchAll = false): string[] {
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
      const binding = unchanged ? old.bindingVersion : randomUUID()
      if (!unchanged) affected.add(block.id)
      insertInstance.run(block.id, groupId, side.documentId, binding, block.parentBlockId, block.depth)
    }
    if (db.prepare('UPDATE documents SET summary=?,updated_at=? WHERE id=? AND updated_at=?')
      .run(side.content.summary, now, side.documentId, p.detail.updatedAt).changes !== 1) conflict('host', groups, before)
  }
  for (const group of groups.values()) if (group.instances.some(item => affected.has(item.instanceId))
    || (graph.occurrences.get(group.groupId) ?? []).some(item => affected.has(item.instanceId))) {
    if (db.prepare('UPDATE synced_groups SET topology_revision=? WHERE id=? AND revision=? AND topology_revision=?')
      .run(randomUUID(), group.groupId, group.revision, group.topologyRevision).changes !== 1) conflict('topology', groups, before)
  }
  // This slice changes neither owner nor path. Existing historical routes stay
  // bound to retained identities; no fictitious former route is manufactured.
  syncLinks(db, changedIds, now)
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
function acceptedInput(input: SyncedStructureInput, method: HostApplyMethod): HostFinalInput | HostInsertInput {
  if (method === 'applySyncedHostFinal') {
    if (input.mode !== 'host-final') unsupported('command')
    return input
  }
  if (!isHostInsertInput(input) || input.hostsWorkingBefore.length !== 1
    || input.hostsWorkingBefore[0].documentId !== input.action.target.documentId) unsupported('command')
  return input
}
function plannedSides(input: HostFinalInput | HostInsertInput): HostSide[] {
  return input.mode === 'host-final' ? input.finalAfter.map(({ documentId, ...content }) => ({ documentId, content }))
    : [{ documentId: input.action.target.documentId, content: planSyncedHostInsert(input) }]
}
/** Both public methods keep their original validated request namespace. The
 * only persistence path is this private, owned transaction, never a DTO rewrite. */
function applyHostMutation(db: Database.Database, value: unknown, method: HostApplyMethod): SyncedHostFinalResult {
  const parsed = validated(() => validateSyncedStructureInput(value))
  if ('status' in parsed) return parsed
  const request: SyncedStructureInput = parsed
  return mutation(db, () => {
    const requestHash = hostHash({ method, input: request }), previous = replay(db, request.clientOperationId, requestHash)
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
    else checkInsertAuthority(db, input, groups)
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
      db.prepare('INSERT INTO synced_host_history(id,action_json,before_json,after_json,before_hash,after_hash,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(token, row.action_json, row.before_json, row.after_json, row.before_hash, row.after_hash, now)
      for (const id of ids) {
        const state = db.prepare('SELECT position FROM synced_host_history_state WHERE document_id=?').get(id) as { position: number }
        if (!Number.isSafeInteger(state.position + 1)) invalid('forest', '宿主历史位置超过安全整数。')
        db.prepare('INSERT INTO synced_host_history_documents(history_id,document_id,position) VALUES(?,?,?)').run(token, id, state.position + 1)
        db.prepare('UPDATE synced_host_history_state SET cursor=?,position=? WHERE document_id=?').run(randomUUID(), state.position + 1, id)
      }
      for (const dependency of journal.groups) db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)')
        .run(dependency.groupId, 'host-history', token, now)
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
      if (!exactSet(previous.hosts.map(host => host.documentId), input.expectedHosts.map(host => host.documentId))
        || !exactSet(previous.groups.map(group => group.groupId), input.groups.map(group => group.groupId))
        || previous.historyToken !== null && previous.historyToken !== input.historyToken) throw new Error('原逆操作回执与同一请求身份不一致。')
      return previous
    }
    const row = db.prepare('SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at FROM synced_host_history WHERE id=?')
      .get(input.historyToken) as SyncedHostHistoryBranchRow | undefined
    if (!row) conflict('history', new Map(), new Map())
    if (hostJournalKind(row) === 'bare-create') unsupported('journal-kind')
    const journal = decodeHostJournal(row), undo = input.direction === 'undo', from = undo ? journal.after : journal.before, to = undo ? journal.before : journal.after
    const ids = from.map(side => side.documentId)
    if (!exactSet(input.expectedHosts.map(item => item.documentId), ids)) invalid('binding', '恢复宿主必须与真实 journal 参与者双向闭合。')
    const all = readAllHosts(db), groups = allGroups(db), hosts = participating(all, ids), persisted = persistedSides(hosts)
    checkUpdatedAt(input.expectedHosts, hosts, groups)
    const mappings = db.prepare('SELECT document_id,position FROM synced_host_history_documents WHERE history_id=?').all(input.historyToken) as Array<{ document_id: string; position: number }>
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
