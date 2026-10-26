// Data-only SQL leaf for the private physical stage's independent readback.
// Its fixed Main caller must own/verify the connection's exact path/FD and
// derive expected from genuine copy+reference handles and its durable intent.
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { capsuleJson } from './restore-knowledge-capsule-model'
import { graph3Encode, graph3Text } from './restore-knowledge-graph3-data'
import { CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, type Capsule2Encoding } from './restore-knowledge-capsule2-raw-model'
import { STAGE3_MARKER_FAMILY, STAGE3_MARKER_MAX_JSON_BYTES, stage3MarkerInvalid, stage3MarkerKey, stage3MarkerHash,
  parseStage3MarkerJson, validateRootRestoreStage3Marker, type RootRestoreStage3Marker, type Stage3OriginalRecoveryFamily } from './restore-knowledge-stage3-marker-model'

const familyStart = 'synced.recovery.history.', familyEnd = 'synced.recovery.history/'
type Row = { rowid: bigint; keyType: unknown; keyBytes: unknown; valueType: unknown; valueBytes: unknown; timeType: unknown; timeBytes: unknown }
const selection = `_rowid_ AS rowid,typeof(key) AS keyType,CAST(key AS BLOB) AS keyBytes,
  typeof(value) AS valueType,CAST(value AS BLOB) AS valueBytes,
  typeof(updated_at) AS timeType,CAST(updated_at AS BLOB) AS timeBytes`
function ownedMainRead(db: Database.Database): Capsule2Encoding {
  if (!db.open || !db.readonly || !db.inTransaction || db.memory
    || db.pragma('query_only', { simple: true }) !== 1 || db.pragma('foreign_keys', { simple: true }) !== 1)
    return stage3MarkerInvalid('要求独立只读main的query-only/FKON自有事务')
  const databases = db.pragma('database_list') as Array<{ seq: number; name: string; file: string }>
  if (databases.length !== 1 || databases[0].name !== 'main' || databases[0].seq !== 0 || !databases[0].file)
    return stage3MarkerInvalid('拒绝ATTACH/temp或无文件main；marker不能保护附加库')
  const version = db.pragma('main.user_version', { simple: true }), encoding = db.pragma('main.encoding', { simple: true })
  if (version !== 27 || encoding !== 'UTF-8' && encoding !== 'UTF-16le' && encoding !== 'UTF-16be')
    return stage3MarkerInvalid('只接受实际schema27和准确原编码，不迁移版本')
  return encoding
}
function text(type: unknown, bytes: unknown, encoding: Capsule2Encoding): { text: string; bytes: Buffer } {
  if (type !== 'text' || !(bytes instanceof Uint8Array)) return stage3MarkerInvalid('SQL marker/family列不是原TEXT')
  const buffer = Buffer.from(bytes), decoded = graph3Text(['text', buffer.toString('base64')], encoding)
  const encoded = graph3Encode(decoded, encoding)
  if (encoded[0] !== 'text' || !Buffer.from(encoded[1], 'base64').equals(buffer)) return stage3MarkerInvalid('原TEXT不能无损按native编码读取')
  return { text: decoded, bytes: buffer }
}
function exactRow(row: Row, encoding: Capsule2Encoding) {
  if (typeof row.rowid !== 'bigint') return stage3MarkerInvalid('原rowid不是int64')
  return { rowid: row.rowid, key: text(row.keyType, row.keyBytes, encoding),
    value: text(row.valueType, row.valueBytes, encoding), updatedAt: text(row.timeType, row.timeBytes, encoding) }
}
/** The expected new key is excluded only by the final-marker reader after its
 * complete key/body/time match. Every old family row, including original rowid,
 * key spelling and native TEXT bytes, remains in this incremental fingerprint.
 * This is retention evidence, NOT independent semantic authentication of K,
 * old recovery boundaries or their operation/journal/pin support tables. */
function familyFingerprint(db: Database.Database, encoding: Capsule2Encoding, excludeNewKey: string | null): Stage3OriginalRecoveryFamily {
  const where = 'key>=? AND key<?' + (excludeNewKey === null ? '' : ' AND key<>?')
  const params = excludeNewKey === null ? [familyStart, familyEnd] : [familyStart, familyEnd, excludeNewKey]
  const measured = db.prepare(`SELECT count(*) AS rows,coalesce(sum(length(CAST(key AS BLOB))+length(CAST(value AS BLOB))+length(CAST(updated_at AS BLOB))),0) AS bytes
    FROM main.app_settings WHERE ${where}`).safeIntegers(true).get(...params) as { rows: bigint; bytes: bigint }
  if (typeof measured.rows !== 'bigint' || typeof measured.bytes !== 'bigint'
    || measured.rows < 0n || measured.rows > BigInt(CAPSULE2_RAW_MAX_ROWS) || measured.bytes < 0n || measured.bytes > BigInt(CAPSULE2_RAW_MAX_VALUE_BYTES))
    return stage3MarkerInvalid('原recovery family超已认证来源格式预算，不截断')
  const hash = createHash('sha256').update('knowbook.restore.stage3.original-recovery-family.v1\0').update(encoding + '\0')
  let count = 0, valueBytes = 0
  for (const raw of db.prepare(`SELECT ${selection} FROM main.app_settings WHERE ${where} ORDER BY _rowid_`).safeIntegers(true).iterate(...params) as IterableIterator<Row>) {
    const row = exactRow(raw, encoding)
    if (row.key.text.startsWith(STAGE3_MARKER_FAMILY)) return stage3MarkerInvalid('存在另一stage key或原current本身是未完成stage')
    hash.update(row.rowid.toString() + '\0')
    for (const cell of [row.key, row.value, row.updatedAt]) { hash.update(cell.bytes.length.toString() + '\0').update(cell.bytes); valueBytes += cell.bytes.length }
    count++
  }
  if (count !== Number(measured.rows) || valueBytes !== Number(measured.bytes)) return stage3MarkerInvalid('同事务family计量变化')
  return Object.freeze({ rows: count, valueBytes, sha256: hash.digest('hex') })
}

/** Read only on the genuine original-current copy BEFORE adding a stage key.
 * The fixed owner must first authenticate that source and all K evidence. This
 * observation alone cannot mint a genuine original, copy or stage capability. */
export function readStage3OriginalRecoveryFamilyOwned(db: Database.Database): Stage3OriginalRecoveryFamily {
  const encoding = ownedMainRead(db)
  return familyFingerprint(db, encoding, null)
}

/** Fixed Main stage readback leaf. Matching a caller-created DTO here grants
 * nothing; only the private stage owner may choose the path and expected intent.
 * The parent readback must ALSO prove complete protected current history/K rows,
 * actual 12-table/ledger/lifecycle writeback, original bytes and manifest tails.
 * Do not remove this stage key to run a normal Store/legacy reader. */
export function readRootRestoreStage3MarkerOwned(db: Database.Database, expectedInput: RootRestoreStage3Marker) {
  const encoding = ownedMainRead(db), expected = validateRootRestoreStage3Marker(expectedInput), key = stage3MarkerKey(expected.stageId)
  const stageKeys = db.prepare('SELECT count(*) AS count FROM main.app_settings WHERE key>=? AND key<?')
    .safeIntegers(true).get(STAGE3_MARKER_FAMILY, 'synced.recovery.history.stage3/') as { count: bigint }
  if (stageKeys.count !== 1n) return stage3MarkerInvalid('不是唯一自有stage key')
  const size = db.prepare('SELECT length(CAST(value AS BLOB)) AS bytes FROM main.app_settings WHERE key=?').safeIntegers(true).get(key) as { bytes: bigint } | undefined
  if (!size || typeof size.bytes !== 'bigint' || size.bytes < 0n || size.bytes > BigInt(STAGE3_MARKER_MAX_JSON_BYTES * 2))
    return stage3MarkerInvalid('stage原SQL值超小marker编码预算')
  const raw = db.prepare(`SELECT ${selection} FROM main.app_settings WHERE key=?`).safeIntegers(true).get(key) as Row | undefined
  if (!raw) return stage3MarkerInvalid('stage marker消失')
  const row = exactRow(raw, encoding), marker = parseStage3MarkerJson(row.value.text)
  if (row.key.text !== key || row.updatedAt.text !== expected.preparedAt || capsuleJson(marker) !== capsuleJson(expected))
    return stage3MarkerInvalid('stage key/body/time不等于private intent和fresh原件绑定')
  const originalRecoveryFamily = familyFingerprint(db, encoding, key)
  if (capsuleJson(originalRecoveryFamily) !== capsuleJson(expected.originalRecoveryFamily)) return stage3MarkerInvalid('其他原recovery family行/rowid/bytes变化')
  return Object.freeze({ marker, markerHash: stage3MarkerHash(marker), originalRecoveryFamily,
    kind: 'root-restore-stage3-marker-observation' as const, markerVerified: true as const,
    originalSourceAuthenticatedByThisLeaf: false as const, historicalEvidenceValidatedByThisLeaf: false as const,
    physicalStageValidatedByThisLeaf: false as const, historyCutComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const })
}
