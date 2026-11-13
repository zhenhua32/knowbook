import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { readRawCapsule2ContentOwned } from './restore-knowledge-capsule2-content-raw-read'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2DerivedFtsDefinitions,
  capsule2DerivedFtsTables, capsule2RawSqlValueBytesExpression, type Capsule2Encoding } from './restore-knowledge-capsule2-raw-model'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { coverageOperationId, coverageReceiptKey, coverageSettingKey } from './restore-knowledge-coverage-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { graph3Encode } from './restore-knowledge-graph3-data'
import { assertOriginCatalogDirectory, syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { rawRestoreSqlCell } from './restore-knowledge-sql-cell'
import { assertRootRestoreStage3FilesHeld3, assertRootRestoreStage3WritableMain3, assertRootRestoreStage3WrittenMainClosed3,
  closeRootRestoreStage3FilesHeld3, holdRootRestoreStage3DatabaseFiles3, verifyRootRestoreStage3FilesHeld3 } from './restore-knowledge-stage3-files'
import { prepareRootRestoreHistoryBoundaryCandidate3, reopenRootRestoreHistoryBoundaryCandidate3 } from './restore-knowledge-stage3-history-boundary'
import { readRootRestoreStage3MarkerOwned } from './restore-knowledge-stage3-marker-read'
import { assertRootRestoreStage3DatabaseReadonly3,
  copyRootRestoreStage3Database3, discardRootRestoreStage3Probe3,
  holdRootRestorePhysicalStageOriginalBytes3, readRootRestoreStage3DatabaseInventory3, readRootRestoreStage3HistorySqlSource3,
  type RootRestorePhysicalStage3 } from './restore-knowledge-stage3-physical'
import { restoreDirectory, syncRestoreDirectory, syncRestoreFile } from './restore-safety-files'
import { restoreReceiptKey } from './restore-safety-model'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { hasAnySyncedObservationPending } from './synced-remote-observation-pending'
import { RECOVERY_BOUNDARY_CHANNEL, recoveryBoundaryHash, recoveryBoundaryJson, recoveryBoundaryKey, recoveryEpochMarkerId,
  recoveryEpochRequestHash, recoveryEpochTargetFingerprint } from './synced-recovery-boundary-model'

type Evidence = Awaited<ReturnType<typeof prepareRootRestoreHistoryBoundaryCandidate3>>
type Source = ReturnType<typeof readRootRestoreStage3HistorySqlSource3>
type Raw = ReturnType<typeof readRawCapsule2ContentOwned>
type HistoryLocator = Parameters<typeof reopenRootRestoreHistoryBoundaryCandidate3>[1]
type Locator = { readonly stageId: string; readonly expectedManifestHash: string; readonly evidence: HistoryLocator }
type SqlSource = Pick<Source, 'root' | 'databaseDirectory' | 'inventory'>
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

async function readProbe(source: SqlSource, checks: string, marker?: Source['marker']) {
  const path = join(checks, randomUUID())
  await copyRootRestoreStage3Database3(source.databaseDirectory, path, source.root, source.inventory)
  const identity = await assertOriginCatalogDirectory(path, source.root)
  const db = new Database(restoreSqliteFilename(join(path, 'knowbook.db')), { readonly: true, fileMustExist: true })
  let observed: { raw: Raw; fts: string }
  try {
    db.pragma('query_only=ON')
    db.pragma('foreign_keys=ON')
    observed = db.transaction(() => {
      if (marker) readRootRestoreStage3MarkerOwned(db, marker)
      const raw = readRawCapsule2ContentOwned(db)
      return { raw, fts: shadowHash(db, raw.encoding) }
    })()
  } finally { db.close() }
  await assertRootRestoreStage3DatabaseReadonly3(path, source.root, source.inventory)
  await discardRootRestoreStage3Probe3(path, source.root, identity)
  return observed
}

function records(evidence: Evidence, original: Raw) {
  const { proposedBoundary: boundary, proposedReceipt: receipt, proposedEpochRequestHash: requestHash } = evidence.value
  if (!boundary || !receipt || !requestHash || requestHash !== recoveryEpochRequestHash(receipt)
    || receipt.boundaryHash !== recoveryBoundaryHash(boundary)) return fail('原 current 的 B/R 未由现有格式完整表达')
  if (original.encoding !== 'UTF-8') return fail('首代历史 SQL 后继沿用原 B/R 读取的 UTF-8 范围')
  if (original.workspaceScope !== boundary.workspaceScope || original.recoveryEpoch !== boundary.afterEpoch)
    return fail('落库切点 scope/epoch 不闭合')
  const id = recoveryEpochMarkerId(boundary.operationId)
  const coverageId = coverageOperationId(boundary.operationId)
  const occupied = new Map<string, readonly string[]>([
    ['app_settings', [coverageSettingKey(boundary.operationId), coverageReceiptKey(boundary.operationId), restoreReceiptKey(boundary.operationId)]],
    ['synced_operations', [coverageId]], ['synced_exposure_attempts', [coverageId]]
  ])
  const entries: Array<{ table: string; key: string; data: Record<string, string | null> }> = [
    { table: 'app_settings', key: 'key', data: { key: recoveryBoundaryKey(boundary.operationId), value: recoveryBoundaryJson(boundary), updated_at: boundary.acceptedAt } },
    { table: 'synced_operations', key: 'client_operation_id', data: { client_operation_id: id, request_hash: requestHash,
      result_json: recoveryBoundaryJson(receipt), created_at: receipt.acceptedAt } },
    { table: 'synced_exposure_attempts', key: 'id', data: { id, request_hash: requestHash, channel: RECOVERY_BOUNDARY_CHANNEL,
      target_fingerprint: recoveryEpochTargetFingerprint(boundary.workspaceScope), publication_hash: receipt.boundaryHash,
      state: 'possible', created_at: receipt.acceptedAt, confirmed_at: null } }
  ]
  const rows = entries.map(({ table, key, data }) => {
    const originalTable = original.tables.find(item => item.name === table) ?? fail('缺原表 ' + table)
    const old = originalTable.rows, used = new Set(old.map(row => row.sourceRowId))
    let rowid = 1n
    while (used.has(rowid.toString())) rowid++
    if (originalTable.primaryKey.length !== 1 || originalTable.primaryKey[0] !== key || originalTable.columns.length !== Object.keys(data).length)
      return fail('恢复记录原列不闭合 ' + table)
    const native = (value: string | null) => value === null ? ['null'] as const : graph3Encode(value, original.encoding)
    const unavailable = new Set([data[key], ...(occupied.get(table) ?? [])].map(value => capsuleJson(native(value))))
    const keyIndex = originalTable.columns.indexOf(key)
    if (old.some(row => unavailable.has(capsuleJson(row.cells[keyIndex])))) return fail('本次恢复 operation 已占用原保留记录 ' + table)
    const cells = originalTable.columns.map(column => Object.hasOwn(data, column) ? native(data[column]) : fail('原列缺值 ' + column))
    return { table, data, rowid, row: { sourceRowId: rowid.toString(), cells } }
  })
  return { rows, boundaryHash: receipt.boundaryHash, requestHash }
}

type Records = ReturnType<typeof records>['rows']

function assertDelta(before: Awaited<ReturnType<typeof readProbe>>, after: Awaited<ReturnType<typeof readProbe>>, rows: Records) {
  const source = before.raw, target = after.raw
  if (source.schemaVersion !== target.schemaVersion || source.schemaHash !== target.schemaHash || source.encoding !== target.encoding
    || source.workspaceScope !== target.workspaceScope || source.recoveryEpoch !== target.recoveryEpoch || before.fts !== after.fts
    || !same(source.tables.map(table => table.name), target.tables.map(table => table.name))) return fail('后继 schema、世代或 FTS 改变')
  for (const [index, old] of source.tables.entries()) {
    const fresh = target.tables[index], added = rows.find(row => row.table === old.name)
    const retained = added ? fresh.rows.filter(row => row.sourceRowId !== added.row.sourceRowId) : fresh.rows
    if (!same({ ...fresh, rows: retained }, old) || added && !same(fresh.rows.find(row => row.sourceRowId === added.row.sourceRowId), added.row))
      return fail('后继 SQL 差分越出固定 B/R 三行 ' + old.name)
  }
}

async function writeSuccessor(source: Source, directory: string, rows: Records) {
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
      for (const { table, data, rowid } of rows) {
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

async function successor(stage: RootRestorePhysicalStage3, stageId: string, locator?: Locator) {
  const source = readRootRestoreStage3HistorySqlSource3(stage), physical = await holdRootRestorePhysicalStageOriginalBytes3(stage)
  try {
    const evidence = locator ? await reopenRootRestoreHistoryBoundaryCandidate3(stage, locator.evidence) : await prepareRootRestoreHistoryBoundaryCandidate3(stage)
    const base = join(source.root, 'backups', 'database-restore', evidence.value.operationId, 'restore-history-sql-v1')
    const directory = join(base, stageId), databaseDirectory = join(directory, 'database'), checks = join(directory, 'checks'), file = join(directory, 'manifest.json')
    const stored = locator ? await readCapsule2AssetManifest(file, source.root, CAPSULE2_RAW_MAX_JSON_BYTES) : null
    if (stored !== null && capsuleBytesHash(stored) !== locator?.expectedManifestHash) return fail('冷清单哈希变化')
    if (!locator) {
      await restoreDirectory(base, source.root)
      await restoreDirectory(directory, source.root, true)
      await restoreDirectory(checks, source.root, true)
    }
    const original = await readProbe(source, checks, source.marker)
    const { rows, boundaryHash, requestHash } = records(evidence, original.raw)
    if (!locator) await writeSuccessor(source, databaseDirectory, rows)
    const inventory = await readRootRestoreStage3DatabaseInventory3(databaseDirectory, source.root)
    const held = await holdRootRestoreStage3DatabaseFiles3({ profileRoot: source.root, databaseDirectory, inventory })
    try {
      assertDelta(original, await readProbe({ ...source, databaseDirectory, inventory }, checks), rows)
      const value = freezeCapsuleValue({ kind: 'root-restore-private-current-history-sql-v1' as const, version: 1 as const, stageId,
        operationId: evidence.value.operationId, stageManifestHash: evidence.value.stageManifestHash,
        evidence: { evidenceId: evidence.evidenceId, expectedManifestHash: evidence.manifestHash },
        retainedCutHash: evidence.value.retainedCutHash, originalInventory: source.inventory, inventory,
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
      await source.assertOriginalInputsFresh()
      const evidenceTail = await readCapsule2AssetManifest(join(evidence.directory, 'manifest.json'), source.root, CAPSULE2_RAW_MAX_JSON_BYTES)
      if (capsuleBytesHash(evidenceTail) !== evidence.manifestHash) return fail('原历史证据清单尾变化')
      await verifyRootRestoreStage3FilesHeld3(held)
      await verifyRootRestoreStage3FilesHeld3(physical)
      assertRootRestoreStage3FilesHeld3(held)
      assertRootRestoreStage3FilesHeld3(physical)
      return Object.freeze({ directory, stageId, manifestHash, value })
    } finally { closeRootRestoreStage3FilesHeld3(held) }
  } finally { closeRootRestoreStage3FilesHeld3(physical) }
}

export function prepareRootRestoreHistorySql3(stage: RootRestorePhysicalStage3) {
  return successor(stage, randomUUID())
}

export function reopenRootRestoreHistorySql3(stage: RootRestorePhysicalStage3, input: Locator) {
  const address = capsuleRecord(input, ['stageId', 'expectedManifestHash', 'evidence'])
  const stageId = durableSqlDagUuid(address.stageId)
  const evidence = capsuleRecord(address.evidence, ['evidenceId', 'expectedManifestHash'])
  return successor(stage, stageId, { stageId, expectedManifestHash: durableSqlDagHash(address.expectedManifestHash),
    evidence: { evidenceId: durableSqlDagUuid(evidence.evidenceId), expectedManifestHash: durableSqlDagHash(evidence.expectedManifestHash) } })
}
