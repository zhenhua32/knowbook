import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { coverageAnchorExpectation, coverageOperationId, coverageReceiptKey, coverageSettingKey, knowledgeRestoreReceiptHash, rawPriorCoverageRequirementsHash,
  serializeKnowledgeRestoreReceipt, serializeSyncedKnowledgeCoverage, serializeSyncedKnowledgeCoverageLink, syncedKnowledgeCoverageCutHash,
  syncedKnowledgeCoverageHash, validateCoverageStructureTuple, validateSyncedKnowledgeCoverageV1,
  type CoverageCutReference, type RawCoverageRequirement } from './restore-knowledge-coverage-model'
import { readRawPriorKnowledgeCoverageOwned } from './restore-knowledge-coverage-raw-read'
import { readVerifiedRestoreKnowledgePriorInstall, type RestoreKnowledgePriorInstall } from './restore-knowledge-install-proof'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { observeRawCapsule2TablesOwned } from './restore-knowledge-capsule2-content-raw-read'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2DerivedFtsDefinitions,
  capsule2DerivedFtsTables, capsule2RawSqlValueBytesExpression, hashValidatedCapsule2RawSqlTable, hashValidatedCapsule2RawSqlTablePair,
  type Capsule2Encoding, type Capsule2RawSqlRow, type Capsule2RawStreamTable } from './restore-knowledge-capsule2-raw-model'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { readRootRestoreFinalHistorySqlSource5, type RootRestoreDerivedAfterAliasStage4 } from './restore-knowledge-derived-stage4'
import { graph3Encode } from './restore-knowledge-graph3-data'
import { assertOriginCatalogDirectory, syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import type { CompleteOriginalRootData } from './restore-knowledge-original-input-types'
import { rawRestoreSqlCell } from './restore-knowledge-sql-cell'
import { assertRootRestoreStage3FilesHeld3, assertRootRestoreStage3WritableMain3, assertRootRestoreStage3WrittenMainClosed3,
  closeRootRestoreStage3FilesHeld3, holdRootRestoreStage3DatabaseFiles3, verifyRootRestoreStage3FilesHeld3 } from './restore-knowledge-stage3-files'
import { prepareRootRestoreHistoryBoundaryCandidate3, readRootRestoreCoverageCutEvidence3,
  reopenRootRestoreHistoryBoundaryCandidate3 } from './restore-knowledge-stage3-history-boundary'
import { stage3MarkerJson, stage3MarkerKey, type RootRestoreStage3Marker } from './restore-knowledge-stage3-marker-model'
import { readRootRestoreStage3MarkerOwned } from './restore-knowledge-stage3-marker-read'
import type { RootRestoreReferencePlan3 } from './restore-knowledge-reference3-read'
import { assertRootRestoreStage3DatabaseReadonly3,
  copyRootRestoreStage3Database3, discardRootRestoreStage3Probe3,
  holdRootRestorePhysicalStageOriginalBytes3, readRootRestorePhysicalStageCopySource3, readRootRestoreStage3DatabaseInventory3, readRootRestoreStage3HistorySqlSource3,
  type RootRestorePhysicalStage3, type PreparedRestoreHistoryScope3 } from './restore-knowledge-stage3-physical'
import { restoreDirectory, syncRestoreDirectory, syncRestoreFile } from './restore-safety-files'
import { restoreReceiptKey } from './restore-safety-model'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { hasAnySyncedObservationPending } from './synced-remote-observation-pending'
import { RECOVERY_BOUNDARY_CHANNEL, recoveryBoundaryHash, recoveryBoundaryJson, recoveryBoundaryKey, recoveryEpochMarkerId,
  recoveryEpochRequestHash, recoveryEpochTargetFingerprint } from './synced-recovery-boundary-model'
import { validateV3SourceGroupRetirement, type V3SourceGroupRetirement } from './v3-source-group-retirement'
import { applyV3RetirementSql, assertV3RetirementBeforeSql, assertV3SourceGroupRetirementPhysicalOwned,
  normalizeV3RetirementSqlTable, v3SourceGroupRetirementKey } from './v3-source-group-retirement-sql'

type Evidence = Awaited<ReturnType<typeof prepareRootRestoreHistoryBoundaryCandidate3>>
type Source = ReturnType<typeof readRootRestoreStage3HistorySqlSource3>
type FinalSource = ReturnType<typeof readRootRestoreFinalHistorySqlSource5>
type HistoryLocator = Parameters<typeof reopenRootRestoreHistoryBoundaryCandidate3>[1]
type Locator = { readonly stageId: string; readonly expectedManifestHash: string; readonly evidence: HistoryLocator }
type SqlSource = Pick<FinalSource, 'root' | 'databaseDirectory' | 'inventory'>
const fail = (reason: string): never => { throw new Error('Root3 私有历史归档 SQL 拒绝：' + reason) }
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'

function shadowHash(db: Database.Database, encoding: Capsule2Encoding) {
  const hash = createHash('sha256').update('knowbook.restore.stage3.history-sql.fts-shadow.v1\0')
  const virtual = capsule2DerivedFtsDefinitions()
  for (const table of capsule2DerivedFtsTables().filter(name => !virtual.has(name))) {
    const columns = db.pragma('main.table_info(' + quote(table) + ')') as Array<{ name: string; pk: number }>
    const names = columns.map(column => column.name)
    const key = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => quote(column.name))
    if (!key.length) return fail('FTS 内表缺固定主键')
    const declared = (db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?").get(table) as { sql: string } | undefined)?.sql
    if (!declared) return fail('FTS 内表缺实际 DDL')
    const withRowid = !/\bWITHOUT\s+ROWID\b/i.test(declared)
    const cells = names.flatMap(name => { const id = quote(name); return [`typeof(${id})`, `CASE WHEN typeof(${id})='text' THEN CAST(${id} AS BLOB) ELSE ${id} END`] })
    const source = ' FROM main.' + quote(table)
    const measured = db.prepare('SELECT count(*),coalesce(sum(' + capsule2RawSqlValueBytesExpression(names) + '),0)' + source)
      .safeIntegers(true).raw(true).get() as [bigint, bigint]
    if (typeof measured[0] !== 'bigint' || typeof measured[1] !== 'bigint' || measured[0] < 0n || measured[1] < 0n
      || measured[0] > BigInt(CAPSULE2_RAW_MAX_ROWS) || measured[1] > BigInt(CAPSULE2_RAW_MAX_VALUE_BYTES)) return fail('FTS 内表超原格式预算')
    hash.update(capsuleJson([table, names, withRowid, measured.map(String)]) + '\0')
    for (const row of db.prepare('SELECT ' + (withRowid ? '_rowid_,' : '') + cells.join(',') + source + ' ORDER BY ' + key.join(','))
      .safeIntegers(true).raw(true).iterate() as IterableIterator<unknown[]>) {
      const offset = Number(withRowid)
      if (withRowid && typeof row[0] !== 'bigint') return fail('FTS 内表 rowid 不是 int64')
      hash.update(capsuleJson([withRowid ? String(row[0]) : null,
        names.map((_, index) => rawRestoreSqlCell(row[offset + index * 2], row[offset + index * 2 + 1], encoding))]) + '\0')
    }
  }
  return hash.digest('hex')
}

type HistoryEntry = { table: string; key: string; data: Record<string, string | null>; unavailable: readonly string[] }
type HistoryRow = { table: string; data: HistoryEntry['data']; rowid: bigint; row: Capsule2RawSqlRow }
type Records = HistoryRow[]
type CoverageProbe = { operationId: string; marker: Source['marker']; write?: CoverageWrite; retirements?: readonly V3SourceGroupRetirement[] }
type ProbeOptions = { marker?: Source['marker']; historyPlan?: ReturnType<typeof planRecords>; historyRows?: Records; coverage?: CoverageProbe }
type RowCheck = { keep(row: Capsule2RawSqlRow): boolean; finish(): void }
type TableDigest = { name: string; hash: string; coverageHash: string }
const tableDomain = 'knowbook.restore.stage3.history-sql.exact-table.v1'

async function readProbe(source: SqlSource, checks: string, options: ProbeOptions) {
  const path = join(checks, randomUUID())
  await copyRootRestoreStage3Database3(source.databaseDirectory, path, source.root, source.inventory)
  const identity = await assertOriginCatalogDirectory(path, source.root)
  const db = new Database(restoreSqliteFilename(join(path, 'knowbook.db')), { readonly: true, fileMustExist: true })
  let observed: ReturnType<typeof observeProbe>
  try {
    db.pragma('query_only=ON')
    db.pragma('foreign_keys=ON')
    observed = db.transaction(() => observeProbe(db, options))()
  } finally { db.close() }
  await assertRootRestoreStage3DatabaseReadonly3(path, source.root, source.inventory)
  await discardRootRestoreStage3Probe3(path, source.root, identity)
  return observed
}

function observeProbe(db: Database.Database, options: ProbeOptions) {
  if (options.marker) readRootRestoreStage3MarkerOwned(db, options.marker)
  const retirements = options.coverage?.retirements
  for (const retirement of retirements ?? []) {
    if (options.coverage?.write) assertV3SourceGroupRetirementPhysicalOwned(db, retirement)
    else assertV3RetirementBeforeSql(db, retirement)
  }
  const tables: TableDigest[] = [], allocated = new Map<string, HistoryRow>()
  const header = observeRawCapsule2TablesOwned(db, (table, encoding) => {
    const proposed = options.historyPlan?.entries.find(entry => entry.table === table.name)
    const expected = options.historyRows?.find(entry => entry.table === table.name)
    const history = proposed ? observeHistoryPredecessor(table, encoding, proposed, allocated)
      : expected ? observeHistoryAdded(expected) : undefined
    const coverage = options.coverage && observeCoverageRows(table, encoding, options.coverage)
    const retire = retirements?.length && normalizeV3RetirementSqlTable(table, encoding, retirements, Boolean(options.coverage?.write))
    let hash: string, coverageHash: string
    if (history && coverage || retire) {
      // The actual B/R successor is also the C predecessor. Both comparisons
      // consume this exact native cursor and keep separate normalization rules.
      const pair = hashValidatedCapsule2RawSqlTablePair(tableDomain, table, row => [history?.keep(row) ?? true, coverage?.keep(row) ?? true], retire || undefined)
      hash = pair[0]
      coverageHash = pair[1]
    } else {
      const check = history ?? coverage
      const rows = check ? function* () { for (const row of table.rows) if (check.keep(row)) yield row }() : table.rows
      hash = coverageHash = hashValidatedCapsule2RawSqlTable(tableDomain, { ...table, rows })
    }
    history?.finish()
    coverage?.finish()
    tables.push({ name: table.name, hash, coverageHash })
  })
  const plan = options.historyPlan
  if (plan) {
    if (header.encoding !== 'UTF-8') return fail('首代历史 SQL 后继沿用原 B/R 读取的 UTF-8 范围')
    if (header.workspaceScope !== plan.boundary.workspaceScope || header.recoveryEpoch !== plan.boundary.afterEpoch)
      return fail('落库切点 scope/epoch 不闭合')
    assertHistoryInstanceChanges(db, plan)
  }
  const historyRows = plan?.entries.map(({ table }) => allocated.get(table) ?? fail('缺原表 ' + table))
  const write = options.coverage?.write
  return { header, tables, historyRows, fts: shadowHash(db, header.encoding), ...(write ? { coverage: assertSqlCoverage(db, write) } : {}) }
}

function planRecords(evidence: Evidence) {
  const { proposedBoundary: boundary, proposedReceipt: receipt, proposedEpochRequestHash: requestHash } = evidence.value
  if (!boundary || !receipt || !requestHash || requestHash !== recoveryEpochRequestHash(receipt)
    || receipt.boundaryHash !== recoveryBoundaryHash(boundary)) return fail('原 current 的 B/R 未由现有格式完整表达')
  const id = recoveryEpochMarkerId(boundary.operationId)
  const coverageId = coverageOperationId(boundary.operationId)
  const entries: HistoryEntry[] = [
    { table: 'app_settings', key: 'key', unavailable: [coverageSettingKey(boundary.operationId), coverageReceiptKey(boundary.operationId),
      restoreReceiptKey(boundary.operationId)], data: { key: recoveryBoundaryKey(boundary.operationId), value: recoveryBoundaryJson(boundary), updated_at: boundary.acceptedAt } },
    { table: 'synced_operations', key: 'client_operation_id', unavailable: [coverageId], data: { client_operation_id: id, request_hash: requestHash,
      result_json: recoveryBoundaryJson(receipt), created_at: receipt.acceptedAt } },
    { table: 'synced_exposure_attempts', key: 'id', unavailable: [coverageId], data: { id, request_hash: requestHash, channel: RECOVERY_BOUNDARY_CHANNEL,
      target_fingerprint: recoveryEpochTargetFingerprint(boundary.workspaceScope), publication_hash: receipt.boundaryHash,
      state: 'possible', created_at: receipt.acceptedAt, confirmed_at: null } }
  ]
  return { entries, boundary, boundaryHash: receipt.boundaryHash, requestHash }
}

function assertHistoryInstanceChanges(db: Database.Database, { boundary }: ReturnType<typeof planRecords>) {
  if (boundary.version !== 2) return
  const instance = db.prepare('SELECT 1 FROM main.synced_instances WHERE instance_id = ? COLLATE BINARY')
  const block = db.prepare('SELECT type,created_at,document_id FROM main.blocks WHERE id = ? COLLATE BINARY')
  const identity = db.prepare('SELECT created_at,last_owner_kind,last_owner_id,state FROM main.block_identities WHERE id = ? COLLATE BINARY')
  for (const change of boundary.instanceChanges) {
    const host = block.get(change.instanceId) as Record<string, unknown> | undefined
    const stable = identity.get(change.instanceId) as Record<string, unknown> | undefined
    if (instance.get(change.instanceId) || !stable || stable.created_at !== change.createdAt
      || stable.last_owner_kind !== 'document' || stable.last_owner_id !== change.before.hostDocumentId
      || stable.state !== (host ? 'live' : 'retained')
      || host && (host.type === 'synced-block' || host.created_at !== change.createdAt || host.document_id !== change.before.hostDocumentId))
      return fail('目标 SQL 未准确移除同步实例或保留其原稳定身份')
  }
}

function observeHistoryPredecessor(table: Capsule2RawStreamTable, encoding: Capsule2Encoding, entry: HistoryEntry,
  allocated: Map<string, HistoryRow>): RowCheck {
  const { name, columns, primaryKey } = table, { key, data } = entry
  const keyIndex = columns.indexOf(key)
  if (keyIndex < 0 || primaryKey.length !== 1 || primaryKey[0] !== key || columns.length !== Object.keys(data).length)
    return fail('恢复记录原列不闭合 ' + name)
  const native = (value: string | null) => value === null ? ['null'] as const : graph3Encode(value, encoding)
  const unavailable = new Set([data[key], ...entry.unavailable].map(value => capsuleJson(native(value))))
  const cells = columns.map(column => Object.hasOwn(data, column) ? native(data[column]) : fail('原列缺值 ' + column))
  let rowid = 1n
  return {
    keep(row) {
      if (unavailable.has(capsuleJson(row.cells[keyIndex]))) return fail('本次恢复 operation 已占用原保留记录 ' + name)
      if (row.sourceRowId === rowid.toString()) rowid++
      return true
    },
    finish() { allocated.set(name, { table: name, data, rowid, row: { sourceRowId: rowid.toString(), cells } }) }
  }
}

function observeHistoryAdded(added: HistoryRow): RowCheck {
  const changed = () => fail('后继 SQL 差分越出固定 B/R 三行 ' + added.table)
  let found = false
  return {
    keep(row) {
      if (row.sourceRowId !== added.row.sourceRowId) return true
      if (found || !same(row, added.row)) return changed()
      found = true
      return false
    },
    finish() { if (!found) changed() }
  }
}

type Probe = Awaited<ReturnType<typeof readProbe>>
function assertDelta(before: Probe, after: Probe) {
  const source = before.header, target = after.header
  if (source.schemaVersion !== target.schemaVersion || source.schemaHash !== target.schemaHash || source.encoding !== target.encoding
    || source.workspaceScope !== target.workspaceScope || source.recoveryEpoch !== target.recoveryEpoch || before.fts !== after.fts
    || !same(before.tables.map(table => table.name), after.tables.map(table => table.name))) return fail('后继 schema、世代或 FTS 改变')
  for (const [index, old] of before.tables.entries()) {
    if (old.hash !== after.tables[index].hash)
      return fail('后继 SQL 差分越出固定 B/R 三行 ' + old.name)
  }
}

async function writeSuccessor(source: SqlSource, directory: string, operation: { rows: Records } |
  { marker: Source['marker']; coverage: CoverageWrite }) {
  const created = await copyRootRestoreStage3Database3(source.databaseDirectory, directory, source.root, source.inventory)
  const held = await holdRootRestoreStage3DatabaseFiles3({ profileRoot: source.root, databaseDirectory: directory,
    inventory: source.inventory, purpose: 'writable-open', expectedCreatedIdentities: created })
  let db: Database.Database | undefined, authorized = false
  try {
    await verifyRootRestoreStage3FilesHeld3(held)
    assertRootRestoreStage3FilesHeld3(held)
    const sql = db = new Database(restoreSqliteFilename(join(directory, 'knowbook.db')), { fileMustExist: true })
    assertRootRestoreStage3WritableMain3(held, sql)
    authorized = true
    sql.pragma('foreign_keys=ON')
    sql.pragma('synchronous=FULL')
    sql.transaction(() => {
      if (hasAnySyncedObservationPending()) return fail('存在未持久化远端观察')
      if ('coverage' in operation) {
        appendCoverage(sql, operation.marker, operation.coverage)
        return
      }
      for (const { table, data, rowid } of operation.rows) {
        const columns = Object.keys(data)
        const inserted = sql.prepare(`INSERT INTO main.${quote(table)} (_rowid_,${columns.map(quote).join(',')}) VALUES (${['?', ...columns.map(() => '?')].join(',')})`)
          .run(rowid, ...Object.values(data))
        if (inserted.changes !== 1) return fail('B/R 没有精确追加原行 ' + table)
      }
    }).immediate()
  } finally {
    try { if (db?.open) db.close(); if (db && authorized) assertRootRestoreStage3WrittenMainClosed3(held, db) }
    finally { closeRootRestoreStage3FilesHeld3(held) }
  }
}

async function successor(stage: RootRestorePhysicalStage3, stageId: string, locator?: Locator, final?: FinalSource,
  coverageInput?: CoverageInput, historyScope?: PreparedRestoreHistoryScope3) {
  const source = final ?? readRootRestoreStage3HistorySqlSource3(stage)
  const { marker } = readRootRestorePhysicalStageCopySource3(stage)
  const physical = await holdRootRestorePhysicalStageOriginalBytes3(stage)
  let finalOriginal: Awaited<ReturnType<FinalSource['holdOriginalBytes']>> | undefined
  let aliasOriginal: Awaited<ReturnType<FinalSource['holdAliasOriginalBytes']>> | undefined
  try {
    finalOriginal = await final?.holdOriginalBytes()
    aliasOriginal = await final?.holdAliasOriginalBytes()
    const evidence = coverageInput ? await readRootRestoreCoverageCutEvidence3(stage, coverageInput.locator?.evidence, historyScope)
      : locator ? await reopenRootRestoreHistoryBoundaryCandidate3(stage, locator.evidence) : await prepareRootRestoreHistoryBoundaryCandidate3(stage)
    if (coverageInput && final && evidence.value.ordinaryCut) {
      const before = await readProbe(source, join(source.databaseDirectory, '..', 'checks'), {
        marker, coverage: { marker, operationId: evidence.value.operationId, retirements: coverageInput.retirements }
      })
      const coverage = await composeCoverage(final, coverageInput, evidence, marker, before,
        { input: source, cut: evidence.value.ordinaryCut, history: null, async verifyInputs() {
          await source.assertOriginalInputsFresh()
          for (const guard of [physical, finalOriginal, aliasOriginal]) if (guard) await verifyRootRestoreStage3FilesHeld3(guard)
        } })
      for (const guard of [physical, finalOriginal, aliasOriginal]) if (guard) assertRootRestoreStage3FilesHeld3(guard)
      return Object.freeze({ coverage })
    }
    const base = join(source.root, 'backups', 'database-restore', evidence.value.operationId, final ? 'restore-final-history-sql-v1' : 'restore-history-sql-v1')
    const directory = join(base, stageId), databaseDirectory = join(directory, 'database'), checks = join(directory, 'checks'), file = join(directory, 'manifest.json')
    const stored = locator ? await readCapsule2AssetManifest(file, source.root, CAPSULE2_RAW_MAX_JSON_BYTES) : null
    if (stored !== null && capsuleBytesHash(stored) !== locator?.expectedManifestHash) return fail('冷清单哈希变化')
    if (!locator) {
      await restoreDirectory(base, source.root)
      await restoreDirectory(directory, source.root, true)
      await restoreDirectory(checks, source.root, true)
    }
    const historyPlan = planRecords(evidence)
    const original = await readProbe(source, checks, { marker, historyPlan })
    const rows = original.historyRows ?? fail('缺真实原 SQL 恢复记录')
    const { boundaryHash, requestHash } = historyPlan
    if (!locator) await writeSuccessor(source, databaseDirectory, { rows })
    const inventory = await readRootRestoreStage3DatabaseInventory3(databaseDirectory, source.root)
    const held = await holdRootRestoreStage3DatabaseFiles3({ profileRoot: source.root, databaseDirectory, inventory })
    try {
      // The Stage3 guard still intentionally rejects this private SQL in the
      // production reader. The independent native row delta checks B, R and
      // their anchor without suppressing or removing that guard.
      const observed = await readProbe({ ...source, databaseDirectory, inventory }, checks, { historyRows: rows,
        ...(coverageInput && final ? { coverage: { marker, operationId: evidence.value.operationId, retirements: coverageInput.retirements } } : {}) })
      assertDelta(original, observed)
      const finalSql = final ? { finalSql: { stageId: final.stageId, manifestHash: final.manifestHash } } : {}
      const kind = final ? 'root-restore-private-final-history-sql-v1' : 'root-restore-private-current-history-sql-v1'
      const value = freezeCapsuleValue({ kind, version: 1 as const, stageId,
        operationId: evidence.value.operationId, stageManifestHash: evidence.value.stageManifestHash,
        evidence: { evidenceId: evidence.evidenceId, expectedManifestHash: evidence.manifestHash },
        retainedCutHash: evidence.value.retainedCutHash, originalInventory: source.inventory, inventory, ...finalSql,
        boundaryHash, epochRequestHash: requestHash,
        currentHistoryRowsWritten: true as const, uncovered: evidence.value.uncovered,
        historyCutComplete: false as const, acceptedCoverage: false as const, effective: false as const, installPermit: false as const })
      const json = capsuleJson(value) + '\n', manifestHash = capsuleBytesHash(json)
      if (Buffer.byteLength(json) > CAPSULE2_RAW_MAX_JSON_BYTES) return fail('私有清单超原格式预算')
      if (stored === null) {
        for (const entry of inventory) if (entry.present) await syncRestoreFile(join(databaseDirectory, entry.name))
        await syncRestoreDirectory(databaseDirectory)
        await writeCapsule2AssetCopy(file, Buffer.from(json), source.root)
        await syncRestoreDirectory(directory)
        await syncOriginCatalogAncestors(base, source.root)
      } else if (stored !== json) return fail('持久清单与独立 SQL 读回不同')
      if (!same((await readdir(directory)).sort(), ['checks', 'database', 'manifest.json']) || (await readdir(checks)).length
        || await readCapsule2AssetManifest(file, source.root, CAPSULE2_RAW_MAX_JSON_BYTES) !== json) return fail('私有目录或清单尾变化')
      const history = Object.freeze({ directory, stageId, manifestHash, value })
      const verifyTail = async () => {
        await source.assertOriginalInputsFresh()
        if (await readCapsule2AssetManifest(file, source.root, CAPSULE2_RAW_MAX_JSON_BYTES) !== json
          || capsuleBytesHash(await readCapsule2AssetManifest(join(evidence.directory, 'manifest.json'), source.root, CAPSULE2_RAW_MAX_JSON_BYTES)) !== evidence.manifestHash)
          return fail('历史及原证据清单尾变化')
        for (const guard of [held, physical, finalOriginal, aliasOriginal]) if (guard) await verifyRootRestoreStage3FilesHeld3(guard)
      }
      const coverage = coverageInput && final ? await composeCoverage(final, coverageInput, evidence, marker, observed,
        { input: { root: source.root, databaseDirectory, inventory }, cut: historyCut(evidence, history.value),
          history: { stageId, expectedManifestHash: manifestHash, evidence: value.evidence }, verifyInputs: verifyTail }) : undefined
      if (!coverage) await verifyTail()
      for (const guard of [held, physical, finalOriginal, aliasOriginal]) if (guard) assertRootRestoreStage3FilesHeld3(guard)
      return coverage ? Object.freeze({ coverage }) : history
    } finally { closeRootRestoreStage3FilesHeld3(held) }
  } finally {
    if (aliasOriginal) closeRootRestoreStage3FilesHeld3(aliasOriginal)
    if (finalOriginal) closeRootRestoreStage3FilesHeld3(finalOriginal)
    closeRootRestoreStage3FilesHeld3(physical)
  }
}

async function historySuccessor(stage: RootRestorePhysicalStage3, stageId: string, locator?: Locator, final?: FinalSource) {
  const result = await successor(stage, stageId, locator, final)
  if ('coverage' in result) return fail('独立历史 SQL 调用返回了覆盖候选')
  return result
}

export function prepareRootRestoreHistorySql3(stage: RootRestorePhysicalStage3) {
  return historySuccessor(stage, randomUUID())
}

function historyLocator(input: Locator): Locator {
  const address = capsuleRecord(input, ['stageId', 'expectedManifestHash', 'evidence'])
  const evidence = capsuleRecord(address.evidence, ['evidenceId', 'expectedManifestHash'])
  return { stageId: durableSqlDagUuid(address.stageId), expectedManifestHash: durableSqlDagHash(address.expectedManifestHash),
    evidence: { evidenceId: durableSqlDagUuid(evidence.evidenceId), expectedManifestHash: durableSqlDagHash(evidence.expectedManifestHash) } }
}

export function reopenRootRestoreHistorySql3(stage: RootRestorePhysicalStage3, input: Locator) {
  const locator = historyLocator(input)
  return historySuccessor(stage, locator.stageId, locator)
}

export function prepareRootRestoreFinalHistorySql5(stage: RootRestoreDerivedAfterAliasStage4) {
  const source = readRootRestoreFinalHistorySqlSource5(stage)
  return historySuccessor(source.physical, randomUUID(), undefined, source)
}

export function reopenRootRestoreFinalHistorySql5(stage: RootRestoreDerivedAfterAliasStage4, input: Locator) {
  const locator = historyLocator(input), source = readRootRestoreFinalHistorySqlSource5(stage)
  return historySuccessor(source.physical, locator.stageId, locator, source)
}

type CoverageLocator = { stageId: string; expectedManifestHash: string; history: Locator | null; evidence: HistoryLocator;
  retirements?: readonly V3SourceGroupRetirement[] }
type CoverageInput = { original: CompleteOriginalRootData; policyHash: string; stageId: string; locator?: CoverageLocator;
  prior: ReturnType<typeof authenticatedPrior>; retirements?: readonly V3SourceGroupRetirement[] }

function historyCut(evidence: Evidence, value: { stageManifestHash: string; retainedCutHash: string; boundaryHash: string }): CoverageCutReference {
  const { proposedBoundary: boundary, proposedReceipt: receipt } = evidence.value
  if (!boundary || !receipt || evidence.value.stageManifestHash !== value.stageManifestHash
    || evidence.value.retainedCutHash !== value.retainedCutHash || recoveryBoundaryHash(boundary) !== value.boundaryHash)
    return fail('覆盖候选缺实际最终 B/R 与切点')
  const boundaryHash = recoveryBoundaryHash(boundary)
  if (receipt.boundaryHash !== boundaryHash || receipt.operationId !== boundary.operationId || receipt.workspaceScope !== boundary.workspaceScope
    || receipt.beforeEpoch !== boundary.beforeEpoch || receipt.afterEpoch !== boundary.afterEpoch || receipt.acceptedAt !== boundary.acceptedAt)
    return fail('本次原 B/R 不一致')
  return { kind: 'synced-recovery-epoch-cut', version: 1, operationId: boundary.operationId, workspaceScope: boundary.workspaceScope,
    beforeEpoch: boundary.beforeEpoch, afterEpoch: boundary.afterEpoch, documentBoundary: boundary.documentBoundary, acceptedAt: boundary.acceptedAt,
    boundaryHash, epochRequestHash: recoveryEpochRequestHash(receipt) }
}

async function composeCoverage(source: FinalSource, input: CoverageInput, evidence: Evidence, marker: Source['marker'],
  before: Probe, predecessor: { input: SqlSource; cut: CoverageCutReference;
    history: Locator | null; verifyInputs: () => Promise<void> }) {
  const { root } = source, { original, stageId, locator, retirements } = input
  const { value } = evidence, { input: prior, cut, history, verifyInputs } = predecessor
  if (locator && !same(locator.history, history)) return fail('覆盖冷 locator 与实际切点不同')
  if (retirements?.some((record, index) => record.operationId !== value.operationId
    || index > 0 && retirements[index - 1].group.id >= record.group.id)) return fail('裁剪集合未准确绑定本次覆盖')
  const tuple = coverageRecords(original, cut, marker, { derivedManifestHash: source.manifestHash,
    aliasManifestHash: source.aliasManifestHash, assetClosureObservationHash: source.closure.observationHash,
    policyHash: input.policyHash, evidenceManifestHash: evidence.manifestHash, historyManifestHash: history?.expectedManifestHash ?? null,
    retainedCutHash: value.retainedCutHash, ...(input.prior.entries.length ? { priorCoverage: input.prior.entries } : {}),
    ...(retirements?.length ? { retirementHash: capsuleBytesHash(capsuleJson(retirements)) } : {}) })
  const operation = { tuple, prior: input.prior.entries, retirements }
  const base = join(root, 'backups', 'database-restore', value.operationId, 'restore-coverage-sql-v1')
  const directory = join(base, stageId), databaseDirectory = join(directory, 'database'), checks = join(directory, 'checks')
  const file = join(directory, 'manifest.json'), persisted = locator ? await readCapsule2AssetManifest(file, root, CAPSULE2_RAW_MAX_JSON_BYTES) : null
  if (persisted !== null && capsuleBytesHash(persisted) !== locator?.expectedManifestHash) return fail('覆盖 SQL 原清单变化')
  if (!locator) {
    await restoreDirectory(base, root)
    await restoreDirectory(directory, root, true)
    await restoreDirectory(checks, root, true)
  }
  if (!locator) await writeSuccessor(prior, databaseDirectory, { marker, coverage: operation })
  const inventory = await readRootRestoreStage3DatabaseInventory3(databaseDirectory, root)
  const output = await holdRootRestoreStage3DatabaseFiles3({ profileRoot: root, databaseDirectory, inventory })
  try {
    const after = await readProbe({ root, databaseDirectory, inventory }, checks,
      { coverage: { marker, operationId: tuple.coverage.operationId, write: operation, retirements } })
    assertCoverageDelta(before, after)
    if (!after.coverage) return fail('最终 SQL 缺真实覆盖读回')
    const manifest = freezeCapsuleValue({ kind: 'root-restore-private-coverage-sql-v1' as const, version: 1 as const, stageId,
      operationId: value.operationId, evidence: { evidenceId: evidence.evidenceId, expectedManifestHash: evidence.manifestHash }, history,
      originalInventory: prior.inventory, inventory, coverage: after.coverage.entry, planHash: tuple.coverage.planHash,
      ...(input.prior.entries.length ? { requirementsHash: after.coverage.requirementsHash } : {}),
      ...(retirements?.length ? { retirements } : {}), installPermit: false as const })
    const text = capsuleJson(manifest) + '\n', manifestHash = capsuleBytesHash(text)
    if (Buffer.byteLength(text) > CAPSULE2_RAW_MAX_JSON_BYTES) return fail('覆盖 SQL 清单超原预算')
    if (persisted === null) {
      for (const row of inventory) if (row.present) await syncRestoreFile(join(databaseDirectory, row.name))
      await syncRestoreDirectory(databaseDirectory)
      await writeCapsule2AssetCopy(file, Buffer.from(text), root)
      await syncOriginCatalogAncestors(directory, root)
    } else if (persisted !== text) return fail('实际读回的覆盖 SQL 与冷清单不同')
    await verifyInputs()
    await input.prior.assertOriginalProofs()
    if (capsuleBytesHash(await readCapsule2AssetManifest(join(evidence.directory, 'manifest.json'), root,
      CAPSULE2_RAW_MAX_JSON_BYTES)) !== evidence.manifestHash) return fail('覆盖 SQL 原切点证据变化')
    if (!same((await readdir(directory)).sort(), ['checks', 'database', 'manifest.json'])
      || (await readdir(checks)).length || await readCapsule2AssetManifest(file, root, CAPSULE2_RAW_MAX_JSON_BYTES) !== text)
      return fail('覆盖 SQL 清单或独立检查目录变化')
    await verifyRootRestoreStage3FilesHeld3(output)
    assertRootRestoreStage3FilesHeld3(output)
    return Object.freeze({ directory, stageId, manifestHash, value: manifest, requirementsHash: after.coverage.requirementsHash })
  } finally { closeRootRestoreStage3FilesHeld3(output) }
}

function authenticatedPrior(original: CompleteOriginalRootData, profileRoot: string, handles: readonly RestoreKnowledgePriorInstall[]) {
  const current = original.inputs.find(item => same(item.binding, original.node.current))
  const incoming = original.inputs.find(item => same(item.binding, original.node.source))
  if (!current || !incoming || incoming.binding.requiredRoots.length) return fail('本次 C 原件双侧或 incoming prior 集合不闭合')
  const projection = current.knowledge.projection
  const entries = 'priorCoverageRequirements' in projection ? projection.priorCoverageRequirements.entries : []
  const byOperation = new Map(handles.map(handle => {
    const item = readVerifiedRestoreKnowledgePriorInstall(handle)
    return [item.requirement.operationId, item] as const
  }))
  if (handles.length !== entries.length || byOperation.size !== handles.length || original.parents.length !== entries.length)
    return fail('原 current 的全部旧 C 需要真实已安装历史证明')
  for (const entry of entries) {
    const installed = byOperation.get(entry.operationId)
    const parents = original.parents.filter(parent => same(parent.original.root, entry.root))
    if (!installed || installed.profileRoot !== profileRoot || !same(installed.requirement, entry) || parents.length !== 1
      || installed.rootMaterialHash !== parents[0].original.materialHash
      || !current.binding.requiredRoots.some(root => same(root, parents[0].reference)))
      return fail('原 current 的旧 C 与真实已安装历史或解析的父原件不一致')
  }
  return { entries, async assertOriginalProofs() {
    for (const installed of byOperation.values()) await installed.assertOriginalProof()
  } }
}

async function runCoverage(reference: RootRestoreReferencePlan3, stage: RootRestoreDerivedAfterAliasStage4,
  locator?: CoverageLocator, installed: readonly RestoreKnowledgePriorInstall[] = [], historyScope?: PreparedRestoreHistoryScope3,
  retirements?: readonly V3SourceGroupRetirement[]) {
  const source = readRootRestoreFinalHistorySqlSource5(stage)
  const policy = source.readPolicy()
  if (policy.assetAuditHash !== source.closure.observationHash || policy.blockedOccurrences !== source.closure.blockedOccurrences)
    return fail('保留资产策略不属于同次最终观察')
  assertFinalAssetClosure({ ...source.closure, scopes: policy.remaining })
  const original = await source.readCoverageOriginal(reference)
  if (original.root.namespace.kind !== 'native') return fail('覆盖候选须本次 native 根')
  const prior = authenticatedPrior(original, source.root, installed)
  const result = await successor(source.physical, locator?.history?.stageId ?? randomUUID(), locator?.history ?? undefined, source,
    { original, policyHash: policy.observationHash, stageId: locator?.stageId ?? randomUUID(), locator, prior, retirements }, historyScope)
  if (!('coverage' in result) || !result.coverage) return fail('同次历史处理没有生成覆盖 SQL')
  return result.coverage
}

export function prepareRootRestoreCoverageSql(reference: RootRestoreReferencePlan3, stage: RootRestoreDerivedAfterAliasStage4,
  installed?: readonly RestoreKnowledgePriorInstall[], historyScope?: PreparedRestoreHistoryScope3, retirements?: readonly V3SourceGroupRetirement[]) {
  return runCoverage(reference, stage, undefined, installed, historyScope, retirements)
}

export function reopenRootRestoreCoverageSql(reference: RootRestoreReferencePlan3, stage: RootRestoreDerivedAfterAliasStage4, input: CoverageLocator,
  installed?: readonly RestoreKnowledgePriorInstall[]) {
  const hasRetirements = Object.hasOwn(input, 'retirements')
  const locator = capsuleRecord(input, ['stageId', 'expectedManifestHash', 'history', 'evidence', ...(hasRetirements ? ['retirements'] : [])])
  const stageId = durableSqlDagUuid(locator.stageId), expectedManifestHash = durableSqlDagHash(locator.expectedManifestHash)
  const evidence = capsuleRecord(locator.evidence, ['evidenceId', 'expectedManifestHash'])
  const retirements = hasRetirements ? Array.isArray(locator.retirements) && locator.retirements.length
    ? locator.retirements.map(validateV3SourceGroupRetirement) : fail('缺精确裁剪集合') : undefined
  return runCoverage(reference, stage, { stageId, expectedManifestHash,
    evidence: { evidenceId: durableSqlDagUuid(evidence.evidenceId), expectedManifestHash: durableSqlDagHash(evidence.expectedManifestHash) },
    history: locator.history === null ? null : historyLocator(locator.history as Locator) }, installed, undefined, retirements)
}

/** Called with values obtained from the genuine history and reference owners
 * in the same invocation. The original node and SQL cannot be supplied by IPC. */
function coverageRecords(original: CompleteOriginalRootData, cut: CoverageCutReference,
  marker: RootRestoreStage3Marker, final: { derivedManifestHash: string; aliasManifestHash: string; assetClosureObservationHash: string;
    policyHash: string; evidenceManifestHash: string; historyManifestHash: string | null; retainedCutHash: string;
    priorCoverage?: readonly RawCoverageRequirement[]; retirementHash?: string }) {
  if (original.root.namespace.kind !== 'native' || original.root.operationId !== cut.operationId)
    return fail('本次 C 需要同操作的真实 native 根')
  const target = { workspaceScope: cut.kind === 'ordinary-empty-epoch-cut' ? cut.afterWorkspaceScope : cut.workspaceScope,
    recoveryEpoch: cut.afterEpoch, documentBoundary: cut.documentBoundary }
  const planHash = capsuleBytesHash('knowbook.restore-knowledge.accepted-final-plan.v1\0' + capsuleJson({
    root: original.root, rootMaterialHash: original.materialHash, target, cut,
    originalDescriptorHash: marker.originalDescriptorHash, conservationHash: marker.conservationHash,
    sourceMaterialHash: marker.sourceMaterialHash, currentMaterialHash: marker.currentMaterialHash,
    referenceManifestHash: marker.referenceManifestHash, allocationHash: marker.derivedReferenceAllocationHash,
    candidateHash: marker.checkedCanonicalCandidateHash, final }))
  const coverage = validateSyncedKnowledgeCoverageV1({ kind: 'synced-restore-knowledge-coverage', version: 1,
    readerVersion: 'knowbook-accepted-coverage-structure-v1', material: 'durable-sql-only', stageBase: 'current',
    operationId: cut.operationId, source: original.node.source, current: original.node.current,
    root: original.root, rootMaterialHash: original.materialHash, planHash, target, cut, acceptedAt: cut.acceptedAt })
  const common = { version: 1, operationId: cut.operationId, root: original.root, rootMaterialHash: original.materialHash,
    planHash, target, acceptedAt: cut.acceptedAt, coverageHash: syncedKnowledgeCoverageHash(coverage),
    cutHash: syncedKnowledgeCoverageCutHash(cut) }
  return validateCoverageStructureTuple({ coverage, link: { ...common, kind: 'synced-restore-knowledge-coverage-link' },
    receipt: { ...common, kind: 'controlled-database-restore-receipt', version: 2, material: 'durable-sql-only', stageBase: 'current',
      source: coverage.source.capsule, current: coverage.current.capsule } })
}

function assertFinalAssetClosure(closure: { blockedOccurrences: number; scopes: readonly unknown[];
  aliasPathConflicts: readonly unknown[]; finalSqlOccurrences: number; remainingCanonicalOccurrences: number }) {
  if (closure.blockedOccurrences !== 0 || closure.scopes.length || closure.aliasPathConflicts.length
    || closure.finalSqlOccurrences !== 0 || closure.remainingCanonicalOccurrences !== 0)
    return fail('最终 SQL 或原资产域仍存在未认证位置')
}

type Coverage = ReturnType<typeof coverageRecords>
type CoverageWrite = { tuple: Coverage; prior: readonly RawCoverageRequirement[]; retirements?: readonly V3SourceGroupRetirement[] }

function assertSqlCoverage(db: Database.Database, { tuple, prior }: CoverageWrite) {
  const { coverage, receipt } = tuple, { target, operationId, cut, acceptedAt } = coverage
  const actual = db.prepare('SELECT workspace_scope,recovery_epoch FROM main.synced_workspace_state WHERE singleton=1').get() as
    { workspace_scope: string; recovery_epoch: string } | undefined
  if (!actual || actual.workspace_scope !== target.workspaceScope || actual.recovery_epoch !== target.recoveryEpoch
    || db.prepare('SELECT 1 FROM main.documents WHERE updated_at IS NOT ? LIMIT 1').get(target.documentBoundary))
    return fail('实际最终 scope/epoch/document CAS 不同')
  const requirements = readRawPriorKnowledgeCoverageOwned(db)
  const entry = requirements.entries.find(item => item.operationId === operationId)
  if (!same(requirements.entries.filter(item => item.operationId !== operationId), prior))
    return fail('旧 C 与所有实际 SQL 支持行在后继中发生变化')
  if (!entry || entry.acceptedAt !== acceptedAt
    || entry.coverageHash !== syncedKnowledgeCoverageHash(coverage) || entry.receiptHash !== knowledgeRestoreReceiptHash(receipt)
    || !same(entry.root, coverage.root) || !same(entry.cut, cut)
    || Boolean(entry.supports.boundary) !== (cut.kind === 'synced-recovery-epoch-cut')
    || Boolean(entry.supports.epoch) !== (cut.kind === 'synced-recovery-epoch-cut'))
    return fail('从真实 SQL 读回的 C、B/R、link、receipt 与 anchor 未闭合')
  return { entry, requirementsHash: rawPriorCoverageRequirementsHash(requirements) }
}

/** Run only on the newly created writable private SQLite copy. A separate
 * readonly preflight has verified all raw rows, including this marker. */
function appendCoverage(db: Database.Database, marker: RootRestoreStage3Marker, write: CoverageWrite) {
  const { tuple } = write
  const { coverage, link, receipt } = tuple, { operationId, acceptedAt } = coverage
  const markerId = stage3MarkerKey(marker.stageId)
  if (db.prepare('DELETE FROM main.app_settings WHERE key=? AND value=? AND updated_at=?')
    .run(markerId, stage3MarkerJson(marker), marker.preparedAt).changes !== 1) return fail('精确 Stage3 marker 已变化')
  if (!same(readRawPriorKnowledgeCoverageOwned(db).entries, write.prior)) return fail('原 current 的完整 C 支持行在写入前变化')
  const settings = db.prepare('INSERT INTO main.app_settings(key,value,updated_at) VALUES (?,?,?)')
  settings.run(coverageSettingKey(operationId), serializeSyncedKnowledgeCoverage(coverage), acceptedAt)
  settings.run(coverageReceiptKey(operationId), serializeKnowledgeRestoreReceipt(receipt), acceptedAt)
  const anchor = coverageAnchorExpectation(link)
  db.prepare('INSERT INTO main.synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES (?,?,?,?)')
    .run(coverageOperationId(operationId), anchor.request_hash, serializeSyncedKnowledgeCoverageLink(link), acceptedAt)
  db.prepare('INSERT INTO main.synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(anchor.id, anchor.request_hash, anchor.channel, anchor.target_fingerprint, anchor.publication_hash, anchor.state, anchor.created_at, anchor.confirmed_at)
  if (write.retirements?.length) applyV3RetirementSql(db, write.retirements)
  return assertSqlCoverage(db, write)
}

/** Only an exact old marker and the fixed four new support keys leave the
 * protected comparison. The complete C/B/R reader runs in that same probe. */
function observeCoverageRows(table: Capsule2RawStreamTable, encoding: Capsule2Encoding,
  { operationId, marker, write, retirements }: CoverageProbe): RowCheck | undefined {
  const name = table.name, operationKey = coverageOperationId(operationId)
  const change = name === 'app_settings' ? { primary: 'key', keys: [coverageSettingKey(operationId), coverageReceiptKey(operationId),
    ...(retirements ?? []).map(record => v3SourceGroupRetirementKey(record.group.id))] }
    : name === 'synced_operations' ? { primary: 'client_operation_id', keys: [operationKey] }
      : name === 'synced_exposure_attempts' ? { primary: 'id', keys: [operationKey] } : null
  if (!change) return undefined
  const keyIndex = table.columns.indexOf(change.primary)
  if (keyIndex < 0) return fail('覆盖 SQL 缺固定原键 ' + name)
  const encode = (value: string) => capsuleJson(graph3Encode(value, encoding))
  const remaining = new Set(change.keys.map(encode))
  const changed = () => fail('覆盖 SQL 原键冲突或缺支持行 ' + name)
  const badMarker = () => fail('覆盖 SQL 改变 Stage3 marker 之外的原设置')
  const beforeMarker = !write && name === 'app_settings' ? {
    key: encode(stage3MarkerKey(marker.stageId)), value: encode(stage3MarkerJson(marker)), time: encode(marker.preparedAt),
    valueIndex: table.columns.indexOf('value'), timeIndex: table.columns.indexOf('updated_at')
  } : null
  let markerFound = false
  return {
    keep(row) {
      const key = capsuleJson(row.cells[keyIndex])
      if (remaining.has(key)) {
        if (!write) return changed()
        remaining.delete(key)
        return false
      }
      if (!beforeMarker || key !== beforeMarker.key) return true
      if (markerFound || capsuleJson(row.cells[beforeMarker.valueIndex]) !== beforeMarker.value
        || capsuleJson(row.cells[beforeMarker.timeIndex]) !== beforeMarker.time) return badMarker()
      markerFound = true
      return false
    },
    finish() {
      if (write && remaining.size) changed()
      if (beforeMarker && !markerFound) badMarker()
    }
  }
}

/** Compare the complete protected rows from the independent readonly probes. */
function assertCoverageDelta(before: Probe, after: Probe) {
  const { legacyInventoryHash: _beforeInventory, ...beforeMetadata } = before.header
  const { legacyInventoryHash: _afterInventory, ...afterMetadata } = after.header
  if (!same(beforeMetadata, afterMetadata) || before.fts !== after.fts
    || !same(before.tables.map(table => table.name), after.tables.map(table => table.name))) return fail('覆盖 SQL 改变 schema、世代或原生 FTS')
  for (const [index, old] of before.tables.entries()) {
    if (old.coverageHash === after.tables[index].coverageHash) continue
    if (old.name === 'app_settings') return fail('覆盖 SQL 改变 Stage3 marker 之外的原设置')
    if (old.name === 'synced_operations' || old.name === 'synced_exposure_attempts') return fail('覆盖 SQL 改变原支持表 ' + old.name)
    return fail('覆盖 SQL 改变未授权原表 ' + old.name)
  }
}
