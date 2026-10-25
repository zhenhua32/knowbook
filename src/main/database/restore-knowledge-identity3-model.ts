import { createHmac } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES, type Capsule2RawSqlTable } from './restore-knowledge-capsule2-raw-model'
import { selectRootRestoreContent3 } from './restore-knowledge-content3-model'
import type { readRootKnowledgeConservationContent3 } from './restore-knowledge-root3-read'
import type { KnowledgeOccupancy } from './restore-knowledge-payload-model'

export type Identity3Inputs = Awaited<ReturnType<typeof readRootKnowledgeConservationContent3>>
export interface Identity3Kernel { readonly seed: string; readonly preparedAt: string }
type Kind = Exclude<KnowledgeOccupancy['namespace'], 'instance'>
type Demand = { key: string; kind: Kind; sourceId: string; birth: string | null; incarnation: string | null;
  roles: KnowledgeOccupancy['namespace'][]; facts: number[]; physical: boolean; ambiguous: boolean;
  ownerKind: KnowledgeOccupancy['ownerKind']; ownerId: string | null }
export interface Identity3Assignment extends Demand {
  targetId: string; targetCreationId: string | null
  reason: 'catalog' | 'same-physical-incarnation' | 'lineage' | 'preserved-free' | 'forked-collision'
  state: 'physical' | 'missing-reservation'; requiresExplicitForkDecision: boolean
}
export const identity3Invalid = (message: string): never => { throw new Error('完整恢复身份规划无效：' + message + '；尚不授引用重写、历史执行、coverage接受或安装权。') }
const canonicalKind = (kind: KnowledgeOccupancy['namespace']): Kind => kind === 'instance' ? 'block' : kind
const physicalTables: Record<KnowledgeOccupancy['namespace'], readonly string[]> = {
  document: ['documents'], block: ['blocks','synced_group_blocks'], instance: ['synced_instances'], group: ['synced_groups'],
  database: ['databases'], column: ['document_database_columns'], view: ['database_saved_views'], entity: ['database_entities']
}
const actualPhysical = (item: KnowledgeOccupancy) => item.kind === 'physical' && physicalTables[item.namespace].includes(item.source.table)
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const key = (...parts: unknown[]) => capsuleJson(parts)
function textCell(table: Capsule2RawSqlTable, row: Capsule2RawSqlTable['rows'][number], column: string, encoding: string) {
  const cell = row.cells[table.columns.indexOf(column)]
  if (!cell || cell[0] !== 'text') return identity3Invalid('固定身份列不是原TEXT：' + table.name + '.' + column)
  return new TextDecoder(encoding.toLowerCase(), { fatal: true, ignoreBOM: true }).decode(Buffer.from(cell[1], 'base64'))
}
function catalog(packet: Identity3Inputs['source']) {
  const content = packet.source.sourceContent, settings = content.tables.find(table => table.name === 'app_settings')!
  const catalogs = settings.rows.filter(row => textCell(settings, row, 'key', content.encoding) === 'database.defaultId')
  if (catalogs.length !== 1) return identity3Invalid('完整来源没有唯一实际catalog设置')
  const id = textCell(settings, catalogs[0], 'value', content.encoding), databases = content.tables.find(table => table.name === 'databases')!
  if (!databases.rows.some(row => textCell(databases, row, 'id', content.encoding) === id)) return identity3Invalid('实际catalog设置没有对应数据库')
  return id
}
function demands(input: Identity3Inputs): Demand[] {
  const occupancy = input.source.knowledge.occupancy, byId = new Map<string, number[]>()
  for (let index = 0; index < occupancy.length; index++) {
    const item = occupancy[index], idKey = key(canonicalKind(item.namespace), item.id)
    const list = byId.get(idKey) ?? []; list.push(index); byId.set(idKey, list)
  }
  const result: Demand[] = []
  for (const indexes of byId.values()) {
    const known = [...new Set(indexes.map(index => occupancy[index].knownBirth).filter((value): value is string => value !== null))]
    const incarnations = [...new Set(indexes.map(index => occupancy[index].incarnationKey).filter((value): value is string => value !== null))]
    const variants = new Map<string, Demand>()
    for (const index of indexes) {
      const item = occupancy[index], kind = canonicalKind(item.namespace)
      const birth = item.knownBirth ?? (known.length === 1 ? known[0] : null)
      const incarnation = kind === 'group' ? item.incarnationKey ?? (incarnations.length === 1 ? incarnations[0] : null) : null
      const variantKey = key(kind, item.id, birth, incarnation), previous = variants.get(variantKey)
      const value: Demand = previous ?? { key: variantKey, kind, sourceId: item.id, birth, incarnation, roles: [], facts: [], physical: false,
        ambiguous: birth === null && known.length > 1 || kind === 'group' && incarnation === null && incarnations.length > 1, ownerKind: null, ownerId: null }
      if (!value.roles.includes(item.namespace)) value.roles.push(item.namespace)
      value.facts.push(index)
      if (actualPhysical(item) && item.knownBirth === birth) {
        if (value.physical && (value.ownerId !== item.ownerId || value.ownerKind !== item.ownerKind)) return identity3Invalid('同一物理身份角色的owner不一致')
        value.physical = true; value.ownerKind = item.ownerKind; value.ownerId = item.ownerId
      }
      variants.set(variantKey, value)
    }
    for (const value of variants.values()) {
      if (!value.physical) {
        const owners = new Map(value.facts.flatMap(index => { const item = occupancy[index]
          return item.ownerKind === null ? [] : [[key(item.ownerKind, item.ownerId), item] as const] }))
        if (owners.size === 1) { const item = [...owners.values()][0]; value.ownerKind = item.ownerKind; value.ownerId = item.ownerId }
        else if (owners.size > 1) value.ambiguous = true
      }
      result.push(value)
    }
  }
  const order: Kind[] = ['database', 'document', 'group', 'column', 'view', 'entity', 'block']
  return result.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || Number(b.physical) - Number(a.physical) || compare(a.key, b.key))
}

/** Candidate allocation only. Qualified original witnesses stay intact in K;
 * only this root's source is assigned to the actual root-current workspace.
 * Ancestor UUIDs are never interpreted as target-profile live occupants. */
export function deriveRootRestoreIdentityPlan3(input: Identity3Inputs, kernel: Identity3Kernel) {
  if (!/^[0-9a-f]{64}$/.test(kernel.seed) || !Number.isFinite(Date.parse(kernel.preparedAt)) || new Date(kernel.preparedAt).toISOString() !== kernel.preparedAt) return identity3Invalid('Main规划kernel无效')
  const selected = selectRootRestoreContent3(input), sourcePayload = input.knowledge.constraints.payloads.find(payload => !payload.witness.domain.length && payload.witness.side === 'source')!
  const current = input.current.knowledge, source = input.source.knowledge
  const sourceCatalogId = catalog(input.source), targetCatalogId = catalog(input.current)
  const columnTypes = (packet: Identity3Inputs['source']) => {
    const content = packet.source.sourceContent, table = content.tables.find(table => table.name === 'document_database_columns')!
    return new Map(table.rows.map(row => [textCell(table, row, 'id', content.encoding), textCell(table, row, 'type', content.encoding)]))
  }
  const sourceColumnTypes = columnTypes(input.source), currentColumnTypes = columnTypes(input.current)
  const sourceGroups = new Map(source.groups.map(group => [key(group.tuple.groupId, group.comparisonKey), group]))
  const currentGroups = new Map(current.groups.map(group => [group.tuple.groupId, group.comparisonKey]))
  const sourceInstances = new Map(source.instances.map(instance => [instance.instanceId, instance]))
  const currentInstances = new Map(current.instances.map(instance => [instance.instanceId, instance]))
  const lineages = new Map<string, typeof current.restoreLineage[number][]>()
  const lineageTargets = new Map<string, typeof current.restoreLineage[number][]>()
  for (const row of current.restoreLineage) {
    const targetKey = key(row.kind, row.targetId), targetRows = lineageTargets.get(targetKey) ?? []
    targetRows.push(row); lineageTargets.set(targetKey, targetRows)
    if (row.lineage !== sourceCatalogId) continue
    const idKey = key(row.kind, row.sourceDatabaseId, row.sourceId, row.state), rows = lineages.get(idKey) ?? []
    rows.push(row); lineages.set(idKey, rows)
  }
  const currentOccupancy = new Map<string, KnowledgeOccupancy[]>()
  for (const item of current.occupancy) {
    const idKey = key(canonicalKind(item.namespace), item.id), list = currentOccupancy.get(idKey) ?? []
    list.push(item); currentOccupancy.set(idKey, list)
  }
  const currentPhysical = new Map([...currentOccupancy].map(([idKey, rows]) => [idKey, rows.filter(actualPhysical)]))
  const currentOnlyRestoreMap = new Set([...currentOccupancy].filter(([, rows]) => rows.every(row => row.kind === 'restore-map')).map(([idKey]) => idKey))
  const forbiddenFresh = new Set<string>(), allGuards = new Set<string>(), retainedDocumentTimes = new Set<string>()
  let newestDocument = Date.parse(kernel.preparedAt)
  for (const payload of input.knowledge.constraints.payloads) {
    const projection = payload.input.knowledge.projection
    const decoder = new TextDecoder(projection.encoding.toLowerCase(), { fatal: true, ignoreBOM: true })
    for (const item of projection.occupancy) forbiddenFresh.add(item.id)
    if (projection.recoveryEpoch) allGuards.add(projection.recoveryEpoch)
    for (const group of projection.groups) for (const value of [group.tuple.creationId, group.guards.revision, group.guards.topologyRevision, group.guards.historyCursor]) allGuards.add(value)
    for (const instance of projection.instances) allGuards.add(instance.bindingVersion)
    for (const state of projection.hostStates) allGuards.add(state.cursor)
    for (const table of projection.originals) for (const row of table.rows) {
      for (let index = 0; index < row.cells.length; index++) {
        const cell = row.cells[index]
        if (cell[0] !== 'text') continue
        const text = decoder.decode(Buffer.from(cell[1], 'base64'))
        // Conservative exclusions only, never semantic identity discovery or
        // replay. This also blocks tokens embedded in retained journal JSON.
        for (const match of text.matchAll(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi)) allGuards.add(match[0].toLowerCase())
        for (const match of text.matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g)) retainedDocumentTimes.add(match[0])
        if (table.table === 'documents' && table.columns[index] === 'updated_at') {
          const date = Date.parse(text); if (Number.isFinite(date)) newestDocument = Math.max(newestDocument, date)
        }
      }
    }
  }
  const generated = new Set<string>()
  const fresh = (purpose: string): string => {
    for (let attempt = 0; attempt < 64; attempt++) {
      const bytes = createHmac('sha256', Buffer.from(kernel.seed, 'hex')).update(key('knowbook.restore.identity3.uuid.v1', selected.selectionHash, purpose, attempt)).digest().subarray(0, 16)
      bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
      const hex = bytes.toString('hex'), value = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
      if (forbiddenFresh.has(value) || allGuards.has(value) || generated.has(value)) continue
      generated.add(value); return value
    }
    return identity3Invalid('Main身份熵碰撞预算耗尽，不覆盖占用')
  }
  const assignments: Identity3Assignment[] = [], claimed = new Set<string>(), physicalTargets = new Map<string, string>()
  for (const demand of demands(input)) {
    const originalKey = key(demand.kind, demand.sourceId)
    const owner = demand.ownerKind === 'document' ? physicalTargets.get(key('document', demand.ownerId))
      : demand.ownerKind === 'group' ? physicalTargets.get(key('group', demand.ownerId))
        : demand.ownerKind === 'database' ? physicalTargets.get(key('database', demand.ownerId)) : null
    const group = demand.kind === 'group' ? sourceGroups.get(key(demand.sourceId, demand.incarnation)) : undefined
    const compatible = (target: string, ownLineage = false) => {
      const physical = currentPhysical.get(key(demand.kind, target)) ?? []
      if (!demand.physical || !physical.length) return false
      if (demand.kind === 'group') return !!group && currentGroups.get(target) === group.comparisonKey
      const sourceInstance = demand.kind === 'block' ? sourceInstances.get(demand.sourceId) : undefined
      if (sourceInstance && currentInstances.get(target)?.groupId !== physicalTargets.get(key('group', sourceInstance.groupId))) return false
      const knownBirths = new Set(physical.flatMap(item => item.knownBirth === null ? [] : [item.knownBirth]))
      const sameBirth = demand.birth !== null && knownBirths.size === 1 && knownBirths.has(demand.birth)
      // A projection without a birth fact cannot establish the incarnation.
      // Reuse of such column/view/entity slots also needs exact current lineage.
      const lineageWithoutBirth = ownLineage && demand.birth === null && ['column', 'view', 'entity'].includes(demand.kind)
      return (sameBirth || lineageWithoutBirth) && (demand.kind !== 'column' || sourceColumnTypes.get(demand.sourceId) === currentColumnTypes.get(target))
        && physical.every(item => demand.ownerKind === null || item.ownerKind === demand.ownerKind && item.ownerId === owner)
    }
    const lineage = lineages.get(key(demand.kind, demand.ownerKind === 'database' ? demand.ownerId : demand.kind === 'block' && demand.ownerKind === 'document' ? demand.ownerId : '',
      demand.sourceId, demand.physical ? 'live' : 'missing')) ?? []
    if (lineage.length > 1) return identity3Invalid('相同精确来源有多个恢复映射')
    const available = (target: string, ownLineage = false) => {
      if (claimed.has(key(demand.kind, target))) return false
      // Birth/owner compatibility is not authority to overwrite a slot that
      // another exact source reserved. An owned alias cannot erase that fact.
      const reservations = lineageTargets.get(key(demand.kind, target)) ?? []
      if (reservations.some(row => row !== lineage[0])) return false
      const occupied = currentOccupancy.get(key(demand.kind, target)) ?? []
      if (!occupied.length) return true
      if (!demand.physical) return ownLineage && currentOnlyRestoreMap.has(key(demand.kind, target))
        && (lineageTargets.get(key(demand.kind, target)) ?? []).every(row => row === lineage[0])
      return compatible(target, ownLineage)
    }
    // A forked canonical owner must fork every child, even where the child's
    // old ID happens to be free in current. Instance and block roles share it.
    const forkedOwner = demand.ownerKind === 'group' && owner !== demand.ownerId
    let target: string | undefined, reason: Identity3Assignment['reason'] = 'preserved-free'
    if (demand.kind === 'database' && demand.sourceId === sourceCatalogId && demand.physical) { target = targetCatalogId; reason = 'catalog' }
    else if (!demand.ambiguous && !forkedOwner && lineage[0] && available(lineage[0].targetId, true)) { target = lineage[0].targetId; reason = 'lineage' }
    else if (!demand.ambiguous && !forkedOwner && available(demand.sourceId)) {
      target = demand.sourceId; reason = currentOccupancy.has(originalKey) ? 'same-physical-incarnation' : 'preserved-free'
    }
    if (!target) { target = fresh('identity:' + demand.key); reason = 'forked-collision' }
    if (claimed.has(key(demand.kind, target))) return identity3Invalid('目标身份重复认领')
    claimed.add(key(demand.kind, target))
    const forkGroup = demand.kind === 'group' && target !== demand.sourceId
    const assignment: Identity3Assignment = { ...demand, targetId: target, reason, state: demand.physical ? 'physical' : 'missing-reservation',
      targetCreationId: group ? forkGroup ? fresh('creation:' + demand.key) : group.tuple.creationId : null,
      requiresExplicitForkDecision: forkGroup }
    assignments.push(assignment)
    if (demand.physical) physicalTargets.set(originalKey, target)
  }
  if (newestDocument >= 8_640_000_000_000_000) return identity3Invalid('无法在全部旧文档版本之后分配有限时间戳')
  let updatedAt = new Date(newestDocument + 1).toISOString()
  while (retainedDocumentTimes.has(updatedAt)) {
    newestDocument++
    if (newestDocument >= 8_640_000_000_000_000) return identity3Invalid('保留历史耗尽有限文档CAS时间域')
    updatedAt = new Date(newestDocument + 1).toISOString()
  }
  const groupTargets = new Map(assignments.filter(item => item.kind === 'group').map(item => [key(item.sourceId, item.incarnation), item]))
  const execution = { workspaceScope: input.current.source.sourceContent.workspaceScope, recoveryEpoch: fresh('workspace-epoch'), documentUpdatedAt: updatedAt,
    groups: source.groups.map(group => ({ sourceGroupId: group.tuple.groupId,
      targetGroupId: (groupTargets.get(key(group.tuple.groupId, group.comparisonKey)) ?? identity3Invalid('组元组缺完整身份slot')).targetId,
      physicalHeader: groupTargets.get(key(group.tuple.groupId, group.comparisonKey))!.physical,
      revision: fresh('revision:' + group.comparisonKey), topologyRevision: fresh('topology:' + group.comparisonKey),
      historyCursor: fresh('group-history:' + group.comparisonKey), historyPosition: 0 as const,
      sourceLifecycle: group.lifecycle, activationAuthorized: false as const })),
    instances: source.instances.map(instance => ({ sourceInstanceId: instance.instanceId, targetInstanceId: physicalTargets.get(key('block', instance.instanceId))!,
      bindingVersion: fresh('binding:' + instance.instanceId) })),
    hosts: input.source.source.physical.documents.map(document => ({ sourceDocumentId: document.documentId,
      targetDocumentId: physicalTargets.get(key('document', document.documentId))!, historyCursor: fresh('host-history:' + document.documentId), historyPosition: 0 as const })),
    sourceOperationsReplayAllowed: false as const, transactionCutStillRequired: true as const }
  const body = { kind: 'complete-root-restore-identity-allocation' as const, version: 3 as const,
    sourceWitness: sourcePayload.witness, sourcePayload: sourcePayload.key, conservationHash: input.knowledge.conservationHash,
    contentSelectionHash: selected.selectionHash, sourceMaterialHash: input.source.materialHash, currentMaterialHash: input.current.materialHash,
    sourceCatalogId, targetCatalogId, assignments, execution,
    unresolvedIncarnations: assignments.filter(item => item.ambiguous).map(item => item.key),
    qualifiedCoverageAcceptanceStillRequired: input.knowledge.constraints.coverageAcceptanceRequired,
    referenceRewriteComplete: false as const, semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return identity3Invalid('完整身份规划超过原有限预算，不能截断')
  return freezeCapsuleValue({ ...body, allocationHash: capsuleBytesHash('knowbook.restore.identity3.allocation.v1\0' + encoded) })
}
