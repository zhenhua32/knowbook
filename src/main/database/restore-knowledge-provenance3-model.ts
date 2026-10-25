import { validateSyncedOrigin } from '../../shared/syncedBlockValidation'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Text, type Graph3Inputs } from './restore-knowledge-graph3-data'
import { knowledgeGroupComparisonKey, knowledgeHash, type KnowledgeGroup, type KnowledgeHistoricalMaterial, type KnowledgeHostJournal,
  type KnowledgeOriginalRow, type KnowledgeOriginalTable, type KnowledgeRowRef } from './restore-knowledge-payload-model'
import { decodeHostCreateJournal, type HostCreateJournal } from './synced-host-create-codec'
import { createRawHash } from './synced-host-create-plan'
import { hostHash, sameHostContent } from './synced-host-journal'
import { hostJson } from './synced-host-document-read'
import { decodeSyncedOperationAck } from './synced-host-operation-receipt'
import { historicalOperationLocator, type HistoricalOperationRow } from './synced-history-evidence-support'

interface OriginReferenceSource3 {
  readonly sourceId: string
  readonly status: 'proved-birth' | 'unresolved'
  readonly knownBirth: string | null
  readonly supports: readonly KnowledgeRowRef[]
  readonly reason: string | null
}
type Original = { readonly table: KnowledgeOriginalTable; readonly row: KnowledgeOriginalRow; readonly reference: KnowledgeRowRef }
const same = (left: unknown, right: unknown): boolean => capsuleJson(left) === capsuleJson(right)
const rowReference = (row: KnowledgeOriginalRow): KnowledgeRowRef => ({ table: row.table, key: row.key,
  occurrence: row.occurrence, rowHash: row.rowHash })
const unresolved = (sourceId: string, supports: readonly KnowledgeRowRef[], reason: string): OriginReferenceSource3 =>
  ({ sourceId, status: 'unresolved', knownBirth: null, supports, reason })

/** 只消费真实 Main owner 取得的同次完整输入。这里构造字段来源数据，
 * 不根据同 UUID、唯一已知出生或 captured state 补造历史身份，也不签发句柄。 */
export function deriveRootRestoreProvenanceSources3(data: Graph3Inputs) {
  const knowledge = data.inputs.source.knowledge
  const tables = new Map<string, KnowledgeOriginalTable>(), originals = new Map<string, Original>()
  const checked = new Set<KnowledgeOriginalRow>()
  for (const table of knowledge.originals) {
    if (tables.has(table.table)) return graph3Conflict('provenance-duplicate-original-table', table.table)
    tables.set(table.table, table)
    for (const row of table.rows) {
      if (row.table !== table.table) return graph3Conflict('provenance-original-table-mismatch', table.table)
      const reference = rowReference(row), key = capsuleJson(reference)
      // 相同哈希不表示同一来源；完整 key/occurrence 仍各自保留。
      if (originals.has(key)) return graph3Conflict('provenance-duplicate-original-occurrence', reference)
      originals.set(key, { table, row, reference })
    }
  }
  const text = (original: Original, column: string): string => {
    const position = original.table.columns.indexOf(column), cell = original.row.cells[position]
    if (position < 0 || !cell || cell[0] !== 'text') return graph3Conflict('provenance-original-text-column',
      { source: original.reference, column })
    return graph3Text(cell, knowledge.encoding)
  }
  const read = (reference: KnowledgeRowRef, tableName?: string): Original => {
    const original = originals.get(capsuleJson(reference))
    if (!original || tableName !== undefined && reference.table !== tableName)
      return graph3Conflict('provenance-original-row-reference', reference)
    if (!checked.has(original.row)) {
      const { table, row } = original
      if (row.cells.length !== table.columns.length) return graph3Conflict('provenance-original-row-width', reference)
      const fullColumns = capsuleBytesHash(capsuleJson(table.columns)) === table.fullColumnsHash
      if (table.disclosure === 'complete-evidence-rows' && !fullColumns)
        return graph3Conflict('provenance-incomplete-evidence-row', reference)
      if (fullColumns && row.rowHash !== knowledgeHash('knowbook.knowledge.sql-row.v1', {
        encoding: knowledge.encoding, table: table.table, columns: table.columns, cells: row.cells
      })) return graph3Conflict('provenance-original-row-hash', reference)
      if (table.primaryKey.length) {
        const key = table.primaryKey.map(column => {
          const index = table.columns.indexOf(column)
          if (index < 0) return graph3Conflict('provenance-original-primary-key-column', reference)
          return row.cells[index]
        })
        if (!same(key, row.key)) return graph3Conflict('provenance-original-primary-key', reference)
      }
      checked.add(row)
    }
    return original
  }
  const operationTable = tables.get('synced_operations')
  if (!operationTable) return graph3Conflict('provenance-missing-operation-table', null)
  const operationRows = new Map<string, Original[]>()
  for (const row of operationTable.rows) {
    const original = originals.get(capsuleJson(rowReference(row)))!, id = text(original, 'client_operation_id')
    const occurrences = operationRows.get(id) ?? []
    occurrences.push(original); operationRows.set(id, occurrences)
  }
  const materialByPrimary = new Map<string, KnowledgeHistoricalMaterial[]>()
  for (const material of knowledge.historicalMaterial) {
    const key = capsuleJson(material.primary), occurrences = materialByPrimary.get(key) ?? []
    occurrences.push(material); materialByPrimary.set(key, occurrences)
  }
  // 仅在本次完整重建内索引；重复来源保留为多项并由消费处拒绝。
  const journalsBySource = new Map<string, KnowledgeHostJournal[]>()
  for (const journal of knowledge.hostJournals) {
    const key = capsuleJson(journal.source), occurrences = journalsBySource.get(key) ?? []
    occurrences.push(journal); journalsBySource.set(key, occurrences)
  }
  const matchingJournal = (group: KnowledgeGroup, supports: KnowledgeRowRef[]): HostCreateJournal | null => {
    if (!group.createJournalSource) return null
    const bad = (reason: string): never => graph3Conflict('provenance-declared-create-journal-mismatch',
      { comparisonKey: group.comparisonKey, reason })
    if (!group.lifecycle || !group.lifecycleSource) return bad('missing-lifecycle')
    const lifecycle = read(group.lifecycleSource, 'synced_group_lifecycle')
    supports.push(group.lifecycleSource)
    if (text(lifecycle, 'group_id') !== group.tuple.groupId || text(lifecycle, 'creation_id') !== group.tuple.creationId
      || text(lifecycle, 'create_history_id') !== group.lifecycle.createHistoryId
      || group.lifecycle.groupId !== group.tuple.groupId || group.lifecycle.creationId !== group.tuple.creationId)
      return bad('lifecycle-stable-identity')
    const original = read(group.createJournalSource, 'synced_host_history')
    supports.push(group.createJournalSource)
    const token = text(original, 'id')
    if (!group.lifecycle.createHistoryId || token !== group.lifecycle.createHistoryId) return bad('create-history-id')
    const captured = journalsBySource.get(capsuleJson(group.createJournalSource)) ?? []
    if (captured.length !== 1 || captured[0].historyToken !== token || captured[0].kind !== 'host-command'
      || captured[0].decoded.kind !== 'finite' || !('create' in captured[0].decoded.value)) return bad('finite-create-source')
    let journal: HostCreateJournal
    try {
      journal = decodeHostCreateJournal({ id: token, action_json: text(original, 'action_json'),
        before_json: text(original, 'before_json'), after_json: text(original, 'after_json'),
        before_hash: text(original, 'before_hash'), after_hash: text(original, 'after_hash'), created_at: text(original, 'created_at') })
    } catch { return bad('invalid-original-create-journal') }
    if (!same(journal, captured[0].decoded.value)) return bad('decoded-source-mismatch')
    const wire = journal.create.wire
    if (!same({ groupId: wire.id, creationId: wire.creationId, createdAt: wire.createdAt, origin: wire.origin }, group.tuple)
      || journal.input.action.documentId !== group.tuple.origin.documentId
      || journal.input.action.instanceId !== group.tuple.origin.firstInstanceId
      || journal.create.wireHash !== createRawHash(wire)) return bad('original-group-tuple')
    return journal
  }
  const firstInstance = (group: KnowledgeGroup): OriginReferenceSource3 => {
    const sourceId = group.tuple.origin.firstInstanceId, supports: KnowledgeRowRef[] = [group.source]
    const journal = matchingJournal(group, supports)
    if (!journal) return unresolved(sourceId, supports, 'original-create-chain-unavailable')
    const candidates = operationRows.get(journal.input.clientOperationId) ?? []
    if (!candidates.length) return unresolved(sourceId, supports, 'initial-create-operation-missing')
    if (candidates.length !== 1) return graph3Conflict('contradictory-original-create-pair',
      { comparisonKey: group.comparisonKey, reason: 'duplicate-original-operation' })
    const original = read(candidates[0].reference, 'synced_operations')
    const materials = materialByPrimary.get(capsuleJson(original.reference)) ?? []
    if (!materials.length) return unresolved(sourceId, supports, 'initial-create-ack-fact-missing')
    const bad = (reason: string): never => graph3Conflict('contradictory-original-create-pair',
      { comparisonKey: group.comparisonKey, operationId: journal.input.clientOperationId, reason })
    const operation: HistoricalOperationRow = { client_operation_id: text(original, 'client_operation_id'),
      request_hash: text(original, 'request_hash'), result_json: text(original, 'result_json'), created_at: text(original, 'created_at') }
    const locator = historicalOperationLocator(operation)
    for (const material of materials) {
      if (material.fact.family !== 'host-create-ack' || material.fact.version !== 1
        || !same(material.fact.locator, locator) || !same(material.primary, original.reference)
        // 此已知 family/version 的真实 producer 不声明其它支持边。
        || material.supports.length !== 0 || material.fact.supports.length !== 0) return bad('original-ack-fact')
      supports.push(material.primary)
    }
    if (operation.request_hash !== hostHash({ method: 'applySyncedHostCommand', input: journal.input })) return bad('original-request-hash')
    let ack: ReturnType<typeof decodeSyncedOperationAck>
    try { ack = decodeSyncedOperationAck(operation) } catch { return bad('invalid-original-ack') }
    if (!('createdLifecycle' in ack)) return bad('original-ack-namespace')
    const life = ack.createdLifecycle
    if (life.state !== 'active' || ack.operationId !== journal.input.clientOperationId
      || ack.historyToken !== group.lifecycle!.createHistoryId || life.createHistoryId !== ack.historyToken
      || !same({ groupId: life.groupId, creationId: life.creationId, createdAt: life.createdAt, origin: life.origin }, group.tuple)
      || life.activationHash !== journal.create.wireHash) return bad('original-ack-stable-create-tuple')
    const own = ack.groups.find(item => item.groupId === group.tuple.groupId)
    if (!own || createRawHash({ kind: 'synced-group', id: own.groupId, creationId: own.creationId, createdAt: own.createdAt,
      origin: own.origin, blocks: own.blocks, bindings: own.bindings }) !== journal.create.wireHash) return bad('original-ack-wire')
    const host = ack.hosts[0]
    if (ack.hosts.length !== 1 || host.documentId !== group.tuple.origin.documentId || journal.before.length !== 1
      || journal.after.length !== 1 || journal.before[0].documentId !== host.documentId || journal.after[0].documentId !== host.documentId
      || !sameHostContent(host.logicalBefore, journal.before[0].content)
      || !sameHostContent({ title: host.after.title, summary: host.after.summary,
        blocks: host.after.blocks.map(({ sortOrder: _sortOrder, ...block }) => block) }, journal.after[0].content)) return bad('original-ack-working-and-after')
    const births = journal.births.filter(item => item.documentId === group.tuple.origin.documentId && item.blockId === sourceId)
    if (births.length !== 1 || births[0].createdAt !== journal.create.instanceCreatedAt) return bad('original-instance-birth')
    return { sourceId, status: 'proved-birth', knownBirth: births[0].createdAt, supports, reason: null }
  }
  const origins = knowledge.groups.map((group, occurrence) => {
    const original = read(group.source, 'synced_groups')
    if (group.lifecycleSource) read(group.lifecycleSource, 'synced_group_lifecycle')
    let origin: ReturnType<typeof validateSyncedOrigin>
    try { origin = validateSyncedOrigin(hostJson(text(original, 'origin_json'))) }
    catch { return graph3Conflict('provenance-invalid-original-origin', group.source) }
    if (text(original, 'id') !== group.tuple.groupId || text(original, 'creation_id') !== group.tuple.creationId
      || text(original, 'created_at') !== group.tuple.createdAt || text(original, 'origin_json') !== group.originalOriginJson
      || !same(origin, group.tuple.origin) || knowledgeGroupComparisonKey(group.tuple) !== group.comparisonKey)
      return graph3Conflict('provenance-original-group-tuple', group.source)
    return { occurrence, sourceWitness: data.value.sourceWitness, sourcePayload: data.value.sourcePayload,
      tuple: group.tuple, comparisonKey: group.comparisonKey, groupSource: group.source,
      originalOriginJson: group.originalOriginJson, origin: group.tuple.origin,
      lifecycleSource: group.lifecycleSource, createJournalSource: group.createJournalSource,
      // 现有 DocumentDetail/ACK 没有文档 createdAt，updatedAt 不是出生。
      document: unresolved(group.tuple.origin.documentId, [group.source], 'unresolved-historical-birth'), firstInstance: firstInstance(group) }
  })
  const capturedBindings = knowledge.bindings.map(capture => { read(capture.source); return capture })
  const body = { kind: 'complete-root-restore-provenance-sources' as const, version: 3 as const,
    scope: 'root-source-origin-and-captured-bindings' as const, root: data.inputs.knowledge.constraints.root,
    sourceWitness: data.value.sourceWitness, sourcePayload: data.value.sourcePayload,
    conservationHash: data.inputs.knowledge.conservationHash, identityAllocationHash: data.value.allocationHash,
    sourceMaterialHash: data.inputs.source.materialHash, currentMaterialHash: data.inputs.current.materialHash,
    origins, capturedBindings, hintsOnly: true as const, ordinaryNavigationCaptured: false as const,
    sourceRewriting: false as const, provenanceReferencesRewritten: false as const, linkBindingsRewritten: false as const,
    templateStructureReferencesRewritten: false as const, referenceRewriteComplete: false as const, semanticValidationComplete: false as const,
    sourcePolicyReplayed: false as const, sourceHistoryReplayed: false as const,
    acceptedCoverage: false as const, effective: false as const, permit: false as const }
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('complete-provenance-source-budget', null)
  return freezeCapsuleValue({ ...body, provenanceSourceHash: capsuleBytesHash('knowbook.restore.provenance3.sources.v1\0' + encoded) })
}
