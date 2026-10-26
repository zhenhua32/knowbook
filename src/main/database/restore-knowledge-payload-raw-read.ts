import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { parseStrictJson } from '../../shared/strictJson'
import { collectDatabaseViewFieldIds, parseDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { isSyncedBlockId, parseSyncedBlockPayload, SyncedValidationError, validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { publicationCompare, publicationHash, publicationJson } from '../sync/synced-publication-model'
import { LOGICAL_DELETION_CHANNEL } from '../sync/synced-logical-deletion-model'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { readSyncedExchangeDenialEvidenceById } from './synced-exchange-receipt'
import { assertSyncedExchangeHostCutRecords } from './synced-exchange-host-cut'
import { assertSyncedRecoveryBoundaryRecords } from './synced-recovery-boundary-read'
import { RECOVERY_BOUNDARY_CHANNEL } from './synced-recovery-boundary-model'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { decodeRemoteObservationMarker, validateObservedIncarnation, SYNCED_OBSERVATION_PREFIX,
  SYNCED_OBSERVATION_CHANNEL, SYNCED_RETIRED_OBSERVATION_CHANNEL } from './synced-remote-observation-codec'
import { decodeHostJournal, hostJournalKind, validateHostSides } from './synced-host-journal'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { readRawSyncedGroupSnapshotsOwned } from './synced-blocks-raw-read'
import { assertRawSyncedHistoricalEvidenceOwned } from './synced-operation-history-read'
import { readHistoricalRowLocator } from './synced-history-evidence-support'
import { readRawRestoreSqlInventoryOwned, type RawSqlInventory } from './restore-knowledge-sql-inventory'
import { readRawCapsule2AssetReferenceSourceOwned } from './restore-knowledge-capsule2-assets-read'
import { CAPSULE2_READER, CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { COVERAGE_ANCHOR_CHANNEL } from './restore-knowledge-coverage-model'
import type { RawHistoricalEvidenceFact } from './synced-history-evidence-model'
import { rawRestoreSqlCell } from './restore-knowledge-sql-cell'
import { capsuleInvalid, capsuleJson, freezeCapsuleValue, type DurableSqlCapsuleDraft } from './restore-knowledge-capsule-model'
import { knowledgeDocumentComparisonKey, knowledgeGroupComparisonKey, knowledgeHash,
  type CapsuleKnowledgePayload, type KnowledgeCapsuleRef, type KnowledgeSqlCell, type KnowledgeOriginalTable,
  type KnowledgeOriginalRow, type KnowledgeRowRef, type KnowledgeOccupancy, type KnowledgeGroup, type KnowledgeExposure,
  type KnowledgeHistoricalMaterial } from './restore-knowledge-payload-model'

type RecordRow = { value: Record<string, unknown>; source: KnowledgeOriginalRow }
const quote = (value: string): string => '"' + value.replace(/"/g, '""') + '"'
const json = (source: string): unknown => parseStrictJson(source, { maxBytes: Math.max(1, Buffer.byteLength(source)), maxDepth: 64 })
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function text(value: unknown): string { return typeof value === 'string' ? value : capsuleInvalid('K原SQL字段不是TEXT') }
function integer(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) ? value : capsuleInvalid('K原整数无效') }
/** Same birth spelling/validity priority as the existing legacy identity backfill.
 * A checkpoint time is not a birth; unknown input remains unknown evidence. */
function ordinaryHistoricalBirth(value: unknown): string | null {
  if (!object(value)) return null
  const timestamp = (input: unknown): string | null => typeof input === 'string' && Number.isFinite(Date.parse(input)) ? input : null
  return timestamp(value.createdAt) ?? timestamp(value.created_at)
}
function cellsEqual(a: unknown, b: unknown): boolean { return capsuleJson(a) === capsuleJson(b) }
function sourceOnly(value: KnowledgeOriginalRow): KnowledgeRowRef {
  return { table: value.table, key: value.key, occurrence: value.occurrence, rowHash: value.rowHash }
}

/** Capture full original row payload, not a table hash masquerading as K.
 * This duplicates the existing inventory's exact storage-class preimage and
 * checks each complete row-set against that independently computed inventory.
 * Historical locator hashes keep their existing separate domain below. */
function originals(db: Database.Database, inventory: RawSqlInventory, metadataKeys: ReadonlySet<string>) {
  const encoding = inventory.encoding, decoder = new TextDecoder(encoding.toLowerCase(), { fatal: true, ignoreBOM: true })
  const decodeText = (bytes: Buffer): string => {
    let result: string
    try { result = decoder.decode(bytes) } catch { return capsuleInvalid('K原TEXT编码无效') }
    const encoded = Buffer.from(result, encoding === 'UTF-8' ? 'utf8' : 'utf16le')
    if (encoding === 'UTF-16be') encoded.swap16()
    if (!encoded.equals(bytes)) return capsuleInvalid('K原TEXT不能无损回编码')
    return result
  }
  const tables: KnowledgeOriginalTable[] = [], byTable = new Map<string, RecordRow[]>(), byPrimary = new Map<string, RecordRow>()
  const completeTables = new Set(['block_identities', 'document_block_routes', 'backup_restore_identities',
    'document_history', 'document_trash', 'document_block_moves', 'document_templates', 'app_settings'])
  const projectedColumns: Record<string, readonly string[]> = {
    documents: ['id', 'created_at', 'updated_at'], blocks: ['id', 'document_id', 'created_at'],
    synced_groups: ['id', 'creation_id', 'created_at', 'origin_json', 'bindings_json', 'revision', 'topology_revision', 'history_cursor', 'history_position'],
    synced_group_blocks: ['id', 'group_id', 'created_at'], databases: ['id', 'created_at', 'updated_at'],
    document_database_columns: ['id', 'database_id', 'created_at', 'updated_at'], database_saved_views: ['id', 'database_id', 'created_at', 'updated_at'],
    database_entities: ['id', 'database_id', 'document_id', 'created_at', 'updated_at']
  }
  for (const expected of inventory.tables) {
    const table = expected.name
    // Full original DB inventory remains separately bound. K does not repeat
    // AI credentials, ordinary business values, names, or current body content.
    if (!table.startsWith('synced_') && !completeTables.has(table) && !projectedColumns[table]) continue
    const columns = db.prepare('SELECT * FROM ' + quote(table) + ' LIMIT 0').columns().map(item => item.name)
    const exposedColumns = projectedColumns[table] ? projectedColumns[table].filter(column => columns.includes(column)) : columns
    const primaryKey = (db.pragma('table_info(' + quote(table) + ')') as Array<{ name: string; pk: number }>).filter(item => item.pk > 0)
      .sort((a, b) => a.pk - b.pk).map(item => item.name)
    if (publicationHash(publicationJson(columns)) !== expected.columnsHash) return capsuleInvalid('K原表列清单不一致')
    const selection = columns.flatMap(column => [`typeof(${quote(column)})`, `CASE WHEN typeof(${quote(column)})='text' THEN CAST(${quote(column)} AS BLOB) ELSE ${quote(column)} END`]).join(',')
    const statement = db.prepare('SELECT ' + selection + ' FROM ' + quote(table)).safeIntegers(true).raw(true)
    const records: Array<{ cells: KnowledgeSqlCell[]; value: Record<string, unknown>; storageHash: string }> = []
    for (const row of statement.iterate() as IterableIterator<unknown[]>) {
      const value: Record<string, unknown> = {}
      const cells = columns.map((column, index): KnowledgeSqlCell => {
        const kind = row[index * 2], actual = row[index * 2 + 1]
        const cell = rawRestoreSqlCell(kind, actual, encoding)
        if (kind === 'null' && actual === null) { value[column] = null; return cell }
        if (kind === 'integer' && typeof actual === 'bigint') {
          value[column] = actual >= BigInt(Number.MIN_SAFE_INTEGER) && actual <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(actual) : actual
          return cell
        }
        if (kind === 'real' && typeof actual === 'number') {
          value[column] = actual; return cell
        }
        if ((kind === 'text' || kind === 'blob') && actual instanceof Uint8Array) {
          const bytes = Buffer.from(actual); value[column] = kind === 'text' ? decodeText(bytes) : bytes
          return cell
        }
        return capsuleInvalid('K原SQL storage class不闭合')
      })
      records.push({ cells, value, storageHash: publicationHash(publicationJson(cells)) })
    }
    const originalSet = createHash('sha256').update('knowbook.raw-sql-row-set.v1\0')
    for (const hash of records.map(item => item.storageHash).sort(publicationCompare)) originalSet.update(hash)
    if (records.length !== expected.rows || originalSet.digest('hex') !== expected.rowSetHash) return capsuleInvalid('K完整原行与同事务SQL清单不一致')
    records.sort((a, b) => publicationCompare(publicationJson(a.cells), publicationJson(b.cells)))
    const occurrences = new Map<string, number>(), captured: KnowledgeOriginalRow[] = [], readRows: RecordRow[] = []
    for (const record of records) {
      if (table === 'app_settings' && !metadataKeys.has(text(record.value.key))) continue
      const key = primaryKey.length ? primaryKey.map(column => record.cells[columns.indexOf(column)]) : record.cells
      const rowHash = knowledgeHash('knowbook.knowledge.sql-row.v1', { encoding, table, columns, cells: record.cells })
      const occurrence = occurrences.get(rowHash) ?? 0; occurrences.set(rowHash, occurrence + 1)
      const source: KnowledgeOriginalRow = { table, key, occurrence, rowHash, cells: exposedColumns.map(column => record.cells[columns.indexOf(column)]) }
      captured.push(source); const entry = { value: record.value, source }; readRows.push(entry)
      if (primaryKey.length) {
        const locator = publicationJson([table, key])
        if (byPrimary.has(locator)) return capsuleInvalid('K原主键重复')
        byPrimary.set(locator, entry)
      }
    }
    tables.push({ table, columns: exposedColumns, primaryKey, fullColumnsHash: expected.columnsHash,
      disclosure: projectedColumns[table] ? 'identity-projection' : 'complete-evidence-rows', rows: captured }); byTable.set(table, readRows)
  }
  const parameterCell = (value: string | number): KnowledgeSqlCell => {
    if (typeof value === 'number') return Number.isSafeInteger(value) ? ['integer', String(value)] : capsuleInvalid('K定位整数非精确')
    const bytes = Buffer.from(value, encoding === 'UTF-8' ? 'utf8' : 'utf16le'); if (encoding === 'UTF-16be') bytes.swap16()
    return ['text', bytes.toString('base64')]
  }
  const lookup = (table: string, key: readonly (string | number)[]): RecordRow => byPrimary.get(publicationJson([table, key.map(parameterCell)])) ?? capsuleInvalid('K原支持完整行缺失：' + table)
  return { tables, rows: (table: string) => byTable.get(table) ?? [], lookup }
}

/** Fixed private capsule owner invokes this only after rebuilding its complete
 * SQL draft in this exact read-only transaction. The result is a frozen payload
 * DTO; this function cannot mint a certified payload/union or any permit. */
export function readRawCapsuleKnowledgePayloadOwned(db: Database.Database, capsule: KnowledgeCapsuleRef,
  draft: DurableSqlCapsuleDraft): CapsuleKnowledgePayload {
  if (!db.open || !db.inTransaction || !db.readonly || db.pragma('query_only', { simple: true }) !== 1 || db.pragma('foreign_keys', { simple: true }) !== 1)
    return capsuleInvalid('K提取要求真实只读owned/FK/query-only快照')
  const schemaVersion = db.pragma('user_version', { simple: true })
  if (schemaVersion !== 26 && schemaVersion !== 27 || draft.schemaVersion !== schemaVersion) return capsuleInvalid('K schema原件不匹配')
  const inventory = readRawRestoreSqlInventoryOwned(db), history = assertRawSyncedHistoricalEvidenceOwned(db)
  if (inventory.schemaHash !== draft.schemaHash || !cellsEqual(history.facts, draft.facts)) return capsuleInvalid('K与同事务完整认证draft不一致')
  const metadataKeys = new Set(history.facts.flatMap(fact => [fact.locator, ...fact.supports])
    .filter(locator => locator.table === 'app_settings').map(locator => text(locator.key[0])))
  const original = originals(db, inventory, metadataKeys)
  const projection = readKnowledgeProjectionOwned(db, schemaVersion, original, history.facts)
  return freezeCapsuleValue({ kind: 'durable-sql-knowledge-payload' as const, version: 1 as const, material: 'durable-sql-only' as const,
    capsule, schemaVersion, workspaceScope: draft.workspaceScope, recoveryEpoch: draft.recoveryEpoch, schemaHash: draft.schemaHash,
    inventoryHash: inventory.inventoryHash, encoding: inventory.encoding, lifecycleAvailability: schemaVersion === 27 ? 'schema27' as const : 'not-in-schema26' as const,
    ...projection })
}

/** Data from the fixed owned readers above/below only. No callback, read mode,
 * caller projection, certificate factory or effective source enters this core. */
function readKnowledgeProjectionOwned(db: Database.Database, schemaVersion: 26 | 27,
  original: ReturnType<typeof originals>, facts: readonly RawHistoricalEvidenceFact[]) {
  // The private owner already ran the exact original full draft validation in
  // this transaction. Ordinary historical strings retain that legacy JSON.parse
  // rule; synchronized formats already passed their stricter finite codecs.
  // Never call the public ordinary audit/publication reader back from this leaf.
  // Non-content literals yield no reference edges, while their complete original
  // bytes remain in originals; this is not a certified-empty inference.
  const historyJson = (source: string): unknown => JSON.parse(source) as unknown
  const reference = (table: string, key: readonly (string | number)[]): KnowledgeRowRef => sourceOnly(original.lookup(table, key).source)
  const material: KnowledgeHistoricalMaterial[] = facts.map(fact => {
    for (const locator of [fact.locator, ...fact.supports]) if (readHistoricalRowLocator(db, locator.table, locator.key).rowHash !== locator.rowHash)
      return capsuleInvalid('K历史原locator未闭合')
    return { fact, primary: reference(fact.locator.table, fact.locator.key), supports: fact.supports.map(locator => reference(locator.table, locator.key)) }
  })
  const groups: KnowledgeGroup[] = [], groupById = new Map<string, KnowledgeGroup>()
  const groupRows = original.rows('synced_groups'), life = schemaVersion === 27 ? readSyncedGroupLifecycles(db, groupRows.map(item => text(item.value.id))) : new Map()
  for (const row of groupRows) {
    const value = row.value, incarnation = validateObservedIncarnation({ groupId: value.id, creationId: value.creation_id,
      createdAt: value.created_at, origin: json(text(value.origin_json)) }), lifecycle = life.get(incarnation.groupId) ?? null
    const retiredRow = original.rows('synced_group_retirements').find(item => item.value.group_id === incarnation.groupId)
    const retirement = retiredRow ? { wire: validateSyncedGroupWire(json(text(retiredRow.value.wire_json))),
      semanticHash: text(retiredRow.value.semantic_hash), retiredAt: text(retiredRow.value.retired_at),
      createHistoryId: text(retiredRow.value.create_history_id), source: sourceOnly(retiredRow.source) } : null
    const group: KnowledgeGroup = { tuple: incarnation, comparisonKey: knowledgeGroupComparisonKey(incarnation),
      originalOriginJson: text(value.origin_json), source: sourceOnly(row.source), lifecycle, retirement,
      guards: { revision: text(value.revision), topologyRevision: text(value.topology_revision), historyCursor: text(value.history_cursor), historyPosition: integer(value.history_position) },
      lifecycleSource: lifecycle ? reference('synced_group_lifecycle', [incarnation.groupId]) : null,
      createJournalSource: lifecycle?.createHistoryId ? reference('synced_host_history', [lifecycle.createHistoryId]) : null }
    groups.push(group); groupById.set(incarnation.groupId, group)
  }
  const exposures: KnowledgeExposure[] = original.rows('synced_exposure_attempts').map(row => {
    const item = row.value, channel = text(item.channel), state = item.state
    if (state !== 'possible' && state !== 'confirmed') return capsuleInvalid('K曝光状态未知')
    const members = original.rows('synced_group_exposure_members').filter(member => member.value.attempt_id === item.id).map(member => {
      const group = groupById.get(text(member.value.group_id)) ?? capsuleInvalid('K曝光失去完整immutable tuple')
      if (group.tuple.creationId !== member.value.creation_id) return capsuleInvalid('K曝光原incarnation不匹配')
      return { tuple: group.tuple, comparisonKey: group.comparisonKey, revision: text(member.value.revision),
        topologyRevision: text(member.value.topology_revision), semanticHash: text(member.value.semantic_hash), source: sourceOnly(member.source) }
    })
    const kind: KnowledgeExposure['kind'] = channel === SYNCED_OBSERVATION_CHANNEL ? 'active-observation' : channel === SYNCED_RETIRED_OBSERVATION_CHANNEL ? 'retired-observation-anchor'
      : channel === LOGICAL_DELETION_CHANNEL ? 'permanent-denial-anchor' : channel === RECOVERY_BOUNDARY_CHANNEL ? 'history-boundary-anchor' : 'member-attempt'
    return { attempt: { id: text(item.id), requestHash: text(item.request_hash), channel, targetFingerprint: text(item.target_fingerprint),
      publicationHash: text(item.publication_hash), state, createdAt: text(item.created_at), confirmedAt: item.confirmed_at === null ? null : text(item.confirmed_at) },
      kind, members, source: sourceOnly(row.source) }
  })
  const observations = original.rows('synced_operations').filter(row => text(row.value.client_operation_id).startsWith(SYNCED_OBSERVATION_PREFIX))
    .map(row => ({ marker: decodeRemoteObservationMarker(row.value as unknown as Parameters<typeof decodeRemoteObservationMarker>[0]), source: sourceOnly(row.source) }))
  const factByPrimary = new Map(material.map(item => [publicationJson([item.fact.locator.table, item.fact.locator.key]), item]))
  const mandatory = (starts: readonly [string, readonly (string | number)[]][]): KnowledgeRowRef[] => {
    const pending = [...starts], found = new Map<string, KnowledgeRowRef>()
    for (let index = 0; index < pending.length; index++) {
      const [table, key] = pending[index], identity = publicationJson([table, key])
      if (found.has(identity)) continue
      found.set(identity, reference(table, key))
      const fact = factByPrimary.get(identity)
      for (const support of fact?.fact.supports ?? []) pending.push([support.table, support.key])
    }
    return [...found].sort(([a], [b]) => publicationCompare(a, b)).map(([, value]) => value)
  }
  const proofs = schemaVersion === 27 ? [...assertSyncedLogicalDeletionRecords(db).values()] : []
  const denials = proofs.map(proof => {
    const evidence = readSyncedExchangeDenialEvidenceById(db, proof.application.operationId)
    if (!evidence?.job || evidence.receipt.version !== 4 && evidence.receipt.version !== 7 || evidence.job.version !== evidence.receipt.version)
      return capsuleInvalid('K永久proof缺mandatory原receipt/job')
    const before = proof.before
    const comparisonKey = before.kind === 'synced-group' ? knowledgeGroupComparisonKey({ groupId: before.id, creationId: before.creationId,
      createdAt: before.createdAt, origin: before.origin }) : knowledgeDocumentComparisonKey(before.id, before.createdAt)
    const starts: Array<[string, readonly (string | number)[]]> = [['synced_operations', [proof.persistence.anchorId]], ['synced_operations', [proof.application.operationId]]]
    for (const effect of proof.identities) starts.push(['block_identities', [effect.before.id]])
    if (before.kind === 'synced-group') starts.push(['synced_groups', [before.id]], ['synced_group_lifecycle', [before.id]])
    for (const pin of original.rows('synced_group_pins')) if (pin.value.pin_id === proof.persistence.anchorId)
      starts.push(['synced_group_pins', [text(pin.value.group_id), text(pin.value.kind), text(pin.value.pin_id)]])
    return { proof, comparisonKey, source: reference('synced_operations', [proof.persistence.anchorId]),
      receipt: evidence.receipt, job: evidence.job, mandatoryMaterial: mandatory(starts) }
  })
  const occupancy: KnowledgeOccupancy[] = []
  const identities: Array<CapsuleKnowledgePayload['identities'][number]> = []
  const bindings: Array<CapsuleKnowledgePayload['bindings'][number]> = []
  const databaseViewReferences: Array<CapsuleKnowledgePayload['databaseViewReferences'][number]> = []
  const occupy = (namespace: KnowledgeOccupancy['namespace'], id: unknown, kind: KnowledgeOccupancy['kind'], source: KnowledgeRowRef,
    ownerKind: KnowledgeOccupancy['ownerKind'] = null, ownerId: string | null = null, knownBirth: string | null = null, incarnationKey: string | null = null): void => {
    if (!isSyncedBlockId(id)) return capsuleInvalid('K占用不是准确稳定ID')
    occupancy.push({ namespace, id, kind, source, ownerKind, ownerId, knownBirth, incarnationKey })
  }
  const capturedBindings = (items: readonly CapsuleKnowledgePayload['bindings'][number]['binding'][], source: KnowledgeRowRef,
    provenance: CapsuleKnowledgePayload['bindings'][number]['provenance']): void => {
    for (const binding of items) {
      bindings.push({ binding, source, provenance })
      const target = binding.target
      if (target.kind === 'document') occupy('document', target.id, 'history', source)
      else if (target.kind === 'heading') occupy('document', target.documentId, 'history', source)
      else if (target.kind === 'block') {
        occupy('block', target.id, 'history', source)
        if (target.documentId !== null) occupy('document', target.documentId, 'history', source)
      }
    }
  }
  const databaseReference = (type: unknown, content: unknown, source: KnowledgeRowRef): void => {
    if (type !== 'database-view') return
    const payload = parseDatabaseViewPayload(text(content)), fieldIds = [...collectDatabaseViewFieldIds(payload)].sort(publicationCompare)
    databaseViewReferences.push({ databaseId: payload.databaseId, viewId: payload.viewId, fieldIds, source })
    occupy('database', payload.databaseId, 'history', source)
    if (payload.viewId !== null) occupy('view', payload.viewId, 'history', source, 'database', payload.databaseId)
    for (const fieldId of fieldIds) occupy('column', fieldId, 'history', source, 'database', payload.databaseId)
  }
  for (const row of original.rows('block_identities')) {
    const value = row.value, owner = value.last_owner_kind
    if (owner !== 'document' && owner !== 'group' && owner !== 'reserved') return capsuleInvalid('K ledger owner未知')
    if (value.state !== 'live' && value.state !== 'retained') return capsuleInvalid('K ledger state未知')
    identities.push({ id: text(value.id), ownerKind: owner, ownerId: text(value.last_owner_id), state: value.state,
      createdAt: value.created_at === null ? null : text(value.created_at), source: sourceOnly(row.source) })
    occupy('block', value.id, 'ledger', sourceOnly(row.source), owner, text(value.last_owner_id), value.created_at === null ? null : text(value.created_at))
    if (owner === 'document') occupy('document', value.last_owner_id, 'ledger', sourceOnly(row.source))
  }
  for (const row of original.rows('documents')) occupy('document', row.value.id, 'physical', sourceOnly(row.source), null, null, text(row.value.created_at))
  for (const row of original.rows('blocks')) occupy('block', row.value.id, 'physical', sourceOnly(row.source), 'document', text(row.value.document_id), text(row.value.created_at))
  for (const row of original.rows('synced_group_blocks')) occupy('block', row.value.id, 'physical', sourceOnly(row.source), 'group', text(row.value.group_id), text(row.value.created_at))
  for (const row of [...original.rows('blocks'), ...original.rows('synced_group_blocks')]) databaseReference(row.value.type, row.value.content, sourceOnly(row.source))
  for (const group of groups) {
    occupy('group', group.tuple.groupId, 'physical', group.source, null, null, group.tuple.createdAt, group.comparisonKey)
    occupy('document', group.tuple.origin.documentId, 'history', group.source)
    occupy('instance', group.tuple.origin.firstInstanceId, 'history', group.source)
    if (group.retirement) for (const block of group.retirement.wire.blocks) {
      occupy('block', block.id, 'history', group.retirement.source, 'group', group.tuple.groupId, block.createdAt)
      databaseReference(block.type, block.content, group.retirement.source)
    }
    if (group.retirement) capturedBindings(group.retirement.wire.bindings, group.retirement.source, 'retirement')
  }
  const groupSnapshots = readRawSyncedGroupSnapshotsOwned(db, groups.map(group => group.tuple.groupId))
  for (const group of groups) { const snapshot = groupSnapshots.get(group.tuple.groupId); if (snapshot) capturedBindings(snapshot.bindings, group.source, 'current-stored') }
  for (const group of groups) for (const guard of group.lifecycle?.activationInstances ?? []) {
    const source = group.lifecycleSource ?? capsuleInvalid('K activation失去原life行')
    occupy('instance', guard.instanceId, 'history', source); occupy('document', guard.hostDocumentId, 'history', source)
  }
  for (const row of original.rows('synced_instances')) {
    const block = original.lookup('blocks', [text(row.value.instance_id)])
    occupy('instance', row.value.instance_id, 'physical', sourceOnly(row.source), 'document', text(row.value.host_document_id), text(block.value.created_at))
    occupy('document', row.value.host_document_id, 'physical', sourceOnly(row.source))
  }
  for (const [table, namespace] of [['databases', 'database'], ['document_database_columns', 'column'], ['database_saved_views', 'view'], ['database_entities', 'entity']] as const)
    for (const row of original.rows(table)) occupy(namespace, row.value.id, 'physical', sourceOnly(row.source), typeof row.value.database_id === 'string' ? 'database' : null,
      typeof row.value.database_id === 'string' ? row.value.database_id : null, typeof row.value.created_at === 'string' ? row.value.created_at : null)
  const content = (raw: unknown, source: KnowledgeRowRef, ownerId: string | null, kind: 'history' | 'template'): void => {
    if (!object(raw) || !Array.isArray(raw.blocks)) return
    for (const block of raw.blocks) {
      if (!object(block)) continue
      if (block.id !== undefined) occupy('block', block.id, kind, source, ownerId ? 'document' : null, ownerId, ordinaryHistoricalBirth(block))
      databaseReference(block.type, block.content, source)
      if (block.type === 'synced-block') {
        let payload: ReturnType<typeof parseSyncedBlockPayload>
        try { payload = parseSyncedBlockPayload(text(block.content)) }
        catch (error) {
          // A saved template is an uninstantiated ordinary draft. Opaque or
          // variable payloads grant no group/instance facts. Valid strict
          // payloads retain the original K projection and hash unchanged;
          // persisted history/host formats still fail closed on corruption.
          if (kind === 'template' && error instanceof SyncedValidationError) continue
          throw error
        }
        const group = groupById.get(payload.groupId)
        if (block.id !== undefined) occupy('instance', block.id, 'history', source, ownerId ? 'document' : null, ownerId, ordinaryHistoricalBirth(block))
        occupy('group', payload.groupId, 'history', source, null, null, group?.tuple.createdAt ?? null, group?.comparisonKey ?? null)
      }
    }
  }
  for (const row of original.rows('document_history')) { const owner = text(row.value.document_id), source = sourceOnly(row.source); occupy('document', owner, 'history', source); content(historyJson(text(row.value.content_json)), source, owner, 'history') }
  for (const row of original.rows('document_trash')) {
    const source = sourceOnly(row.source), snapshot = historyJson(text(row.value.snapshot_json)), owner = text(row.value.id)
    const document = object(snapshot) && object(snapshot.document) && snapshot.document.id === owner ? snapshot.document : null
    occupy('document', owner, 'history', source, null, null, ordinaryHistoricalBirth(document))
    if (!object(snapshot)) continue
    content(snapshot.content, source, owner, 'history')
    if (Array.isArray(snapshot.entities)) for (const entity of snapshot.entities) {
      // Keep recognized ordinary archive identities without adding a new
      // rejection rule for older opaque shapes; their raw rows remain intact.
      if (!object(entity) || !isSyncedBlockId(entity.id) || !isSyncedBlockId(entity.database_id)) continue
      occupy('entity', entity.id, 'history', source, 'database', entity.database_id, ordinaryHistoricalBirth(entity))
      occupy('database', entity.database_id, 'history', source)
    }
  }
  for (const row of original.rows('document_templates')) content({ blocks: historyJson(text(row.value.blocks_json)) }, sourceOnly(row.source), null, 'template')
  for (const row of original.rows('document_block_moves')) {
    const source = sourceOnly(row.source)
    for (const raw of [row.value.before_json, row.value.after_json]) {
      const sides = historyJson(text(raw)); if (!Array.isArray(sides)) return capsuleInvalid('K move原side无效')
      for (const side of sides) { if (!object(side) || typeof side.documentId !== 'string') continue; const owner = text(side.documentId); occupy('document', owner, 'history', source); content(side.content, source, owner, 'history') }
    }
  }
  for (const row of original.rows('document_block_routes')) occupy('block', row.value.block_id, 'route', sourceOnly(row.source))
  for (const row of [...original.rows('synced_host_history_documents'), ...original.rows('synced_host_history_state')])
    occupy('document', row.value.document_id, 'history', sourceOnly(row.source))
  const restoreLineage = original.rows('backup_restore_identities').map((row): CapsuleKnowledgePayload['restoreLineage'][number] => {
    const kind = row.value.kind, state = row.value.state
    if (kind !== 'block' && kind !== 'document' && kind !== 'database' && kind !== 'column' && kind !== 'view' && kind !== 'entity') return capsuleInvalid('K restore identity kind尚无adapter')
    if (state !== 'live' && state !== 'missing') return capsuleInvalid('K restore identity state未知')
    const source = sourceOnly(row.source); occupy(kind, row.value.target_id, 'restore-map', source)
    return { lineage: text(row.value.lineage), kind, sourceDatabaseId: text(row.value.source_database_id),
      sourceId: text(row.value.source_id), state, targetId: text(row.value.target_id), source }
  })
  const hostJournals = original.rows('synced_host_history').map(row => {
    const value = row.value as unknown as SyncedHostHistoryBranchRow, source = sourceOnly(row.source), kind = hostJournalKind(value)
    const decoded = kind === 'bare-create' ? { before: validateHostSides(json(value.before_json)), after: validateHostSides(json(value.after_json)) } : decodeHostJournal(value)
    for (const side of [...decoded.before, ...decoded.after]) { occupy('document', side.documentId, 'history', source); content(side.content, source, side.documentId, 'history') }
    if ('groups' in decoded) for (const group of decoded.groups) {
      occupy('group', group.groupId, 'history', source, null, null, group.createdAt, knowledgeGroupComparisonKey(group))
      occupy('document', group.origin.documentId, 'history', source); occupy('instance', group.origin.firstInstanceId, 'history', source)
    }
    if ('create' in decoded) capturedBindings(decoded.create.wire.bindings, source, 'create-journal')
    if (kind === 'bare-create') {
      const action = json(value.action_json)
      if (!object(action)) return capsuleInvalid('K bare create原action无效')
      occupy('group', action.groupId, 'history', source); occupy('instance', action.instanceId, 'history', source)
    }
    const documentIds = [...new Set(decoded.before.map(side => side.documentId))].sort(publicationCompare)
    const typedDecoded = kind === 'bare-create' ? { kind: 'bare-create' as const, before: decoded.before, after: decoded.after }
      : { kind: 'finite' as const, value: decodeHostJournal(value) }
    return { historyToken: value.id, kind, documentIds, source, decoded: typedDecoded,
      mappings: original.rows('synced_host_history_documents').filter(mapping => mapping.value.history_id === value.id).map(mapping => sourceOnly(mapping.source)) }
  })
  const groupHistories = original.rows('synced_group_history').map(row => {
    const before = validateSyncedGroupWire(json(text(row.value.before_json))), after = validateSyncedGroupWire(json(text(row.value.after_json))), source = sourceOnly(row.source)
    for (const wire of [before, after]) for (const block of wire.blocks) { occupy('block', block.id, 'history', source, 'group', wire.id, block.createdAt); databaseReference(block.type, block.content, source) }
    capturedBindings(before.bindings, source, 'group-history'); capturedBindings(after.bindings, source, 'group-history')
    return { historyId: text(row.value.id), groupId: text(row.value.group_id), position: integer(row.value.position), before, after, source }
  })
  const boundaries = schemaVersion === 27 ? [...assertSyncedRecoveryBoundaryRecords(db).boundaries.values()] : []
  const archivedGroupHistories: Array<CapsuleKnowledgePayload['archivedGroupHistories'][number]> = []
  for (const proof of denials) {
    const before = proof.proof.before
    if (before.kind === 'document') { occupy('document', before.id, 'history', proof.source, null, null, before.createdAt, proof.comparisonKey); content(before.content, proof.source, before.id, 'history') }
    else occupy('group', before.id, 'history', proof.source, null, null, before.createdAt, proof.comparisonKey)
    if (before.kind === 'synced-group') { capturedBindings(before.bindings, proof.source, 'denial-before'); for (const block of before.blocks) databaseReference(block.type, block.content, proof.source) }
    for (const effect of proof.proof.identities) occupy('block', effect.before.id, 'history', proof.source, effect.before.last_owner_kind,
      effect.before.last_owner_id, effect.before.created_at)
  }
  for (const boundary of boundaries) for (const group of boundary.groups) for (const row of group.rows) {
    const source = reference('app_settings', ['synced.recovery.history.v1.' + boundary.operationId])
    const before = validateSyncedGroupWire(json(row.before_json)), after = validateSyncedGroupWire(json(row.after_json))
    for (const wire of [before, after]) for (const block of wire.blocks) { occupy('block', block.id, 'history', source, 'group', wire.id, block.createdAt); databaseReference(block.type, block.content, source) }
    capturedBindings(before.bindings, source, 'archive-history'); capturedBindings(after.bindings, source, 'archive-history')
    archivedGroupHistories.push({ archive: 'recovery', operationId: boundary.operationId, archivedAt: boundary.acceptedAt,
      historyId: row.id, groupId: group.groupId, position: row.position, before, after, source })
  }
  for (const item of material) if (item.fact.family === 'exchange-history-row') {
    const source = original.lookup('app_settings', item.fact.locator.key), envelope = json(text(source.value.value))
    if (!object(envelope) || !object(envelope.row)) return capsuleInvalid('K已认证exchange archive原shape变化')
    const row = envelope.row, before = validateSyncedGroupWire(json(text(row.before_json))), after = validateSyncedGroupWire(json(text(row.after_json)))
    for (const wire of [before, after]) for (const block of wire.blocks) { occupy('block', block.id, 'history', item.primary, 'group', wire.id, block.createdAt); databaseReference(block.type, block.content, item.primary) }
    capturedBindings(before.bindings, item.primary, 'archive-history'); capturedBindings(after.bindings, item.primary, 'archive-history')
    archivedGroupHistories.push({ archive: 'exchange', operationId: text(envelope.operationId), archivedAt: text(envelope.archivedAt),
      historyId: text(row.id), groupId: text(row.group_id), position: integer(row.position), before, after, source: item.primary })
  }
  const exchangeCuts = schemaVersion === 27 ? [...assertSyncedExchangeHostCutRecords(db).values()].map(cut => ({ cut,
    source: reference('app_settings', ['sync.webdav.protocol5.exchange-host-cut.v1.' + cut.historyToken]), journalSource: reference('synced_host_history', [cut.historyToken]) })) : []
  const recoveryBoundaries = boundaries.map(boundary => ({ boundary, source: reference('app_settings', ['synced.recovery.history.v1.' + boundary.operationId]),
    markerSource: reference('synced_operations', ['synced:recovery-epoch:v1:' + boundary.operationId]),
    anchorSource: reference('synced_exposure_attempts', ['synced:recovery-epoch:v1:' + boundary.operationId]) }))
  const instances = original.rows('synced_instances').map(row => ({ instanceId: text(row.value.instance_id), groupId: text(row.value.group_id),
    hostDocumentId: text(row.value.host_document_id), bindingVersion: text(row.value.binding_version),
    parentBlockId: row.value.parent_block_id === null ? null : text(row.value.parent_block_id), depth: integer(row.value.depth), source: sourceOnly(row.source) }))
  const hostStates = original.rows('synced_host_history_state').map(row => ({ documentId: text(row.value.document_id),
    cursor: text(row.value.cursor), position: integer(row.value.position), source: sourceOnly(row.source) }))
  const pins = original.rows('synced_group_pins').map(row => ({ groupId: text(row.value.group_id), kind: text(row.value.kind),
    pinId: text(row.value.pin_id), createdAt: text(row.value.created_at), source: sourceOnly(row.source) }))
  return freezeCapsuleValue({ originals: original.tables, groups, exposures, observations, denials, occupancy, identities, instances, hostStates, pins, bindings, databaseViewReferences, hostJournals, groupHistories, archivedGroupHistories, exchangeCuts,
    recoveryBoundaries, restoreLineage, historicalMaterial: material })
}

/** Complete typed K inputs from the same actual capsule2 source transaction.
 * Prior-C is retained as unresolved original rows, never reclassified as an
 * ordinary member attempt, accepted coverage, empty K or a v1 capsule. */
export function readRawCapsule2SourceKnowledgeOwned(db: Database.Database) {
  const source = readRawCapsule2AssetReferenceSourceOwned(db), content = source.sourceContent
  const inventory = readRawRestoreSqlInventoryOwned(db)
  if (inventory.schemaHash !== content.schemaHash || inventory.inventoryHash !== content.legacyInventoryHash)
    return capsuleInvalid('capsule2 K与同一实际SQL完整typed清单不一致')
  const references = source.total.originalReferences
  const metadataKeys = new Set(references.filter(row => row.table === 'app_settings').map(row => text(row.key[0])))
  const original = originals(db, inventory, metadataKeys)
  const projection = readKnowledgeProjectionOwned(db, content.schemaVersion, original, source.total.legacyFacts)
  const reference = (table: string, key: readonly (string | number)[]) => sourceOnly(original.lookup(table, key).source)
  const coverageMaterial = source.total.coverageSyntaxFacts.map(fact => ({ fact,
    primary: reference(fact.locator.table, fact.locator.key), supports: fact.supports.map(row => reference(row.table, row.key)) }))
  const coverageAnchors = projection.exposures.filter(row => row.attempt.channel === COVERAGE_ANCHOR_CHANNEL)
    .map(row => ({ ...row, kind: 'unresolved-coverage-anchor' as const, acceptedCoverage: false as const, effective: false as const }))
  if (coverageAnchors.length !== source.total.observer.coverage.requirements.entries.length)
    return capsuleInvalid('capsule2 K完整prior-C与真实coverage锚不闭合')
  const body = { kind: 'capsule2-source-knowledge-projection' as const, version: 1 as const, forReader: CAPSULE2_READER,
    state: 'prepared-original-knowledge-only' as const, schemaVersion: content.schemaVersion, encoding: content.encoding,
    workspaceScope: content.workspaceScope, recoveryEpoch: content.recoveryEpoch, schemaHash: content.schemaHash,
    inventoryHash: inventory.inventoryHash, sourceContentHash: source.policy.sourceContentHash,
    workspaceHistoryObservationHash: source.history.observationHash, assetReferencesObservationHash: source.assets.observationHash,
    ...projection, exposures: projection.exposures.filter(row => row.attempt.channel !== COVERAGE_ANCHOR_CHANNEL),
    coverageAnchors, coverageMaterial, priorCoverageRequirements: source.total.observer.coverage.requirements,
    legacyRestoreReceipts: source.total.legacyRestoreReceipt1.map(locator => ({ locator, source: reference(locator.table, locator.key) })),
    certified: false as const, acceptedCoverage: false as const, semanticValidationComplete: false as const,
    effective: false as const, permit: false as const,
    unresolved: ['qualified-origin-and-prior-root-resolution','streaming-source-adapter','complete-private-capsule2-certifier-and-installer'] as const }
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return capsuleInvalid('capsule2完整K输入超有限准备预算，不截断')
  return Object.freeze({ source, knowledge: freezeCapsuleValue({ ...body,
    observationHash: knowledgeHash('knowbook.capsule2.source-knowledge-projection.v1', body) }) })
}
