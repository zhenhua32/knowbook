import { createHash } from 'node:crypto'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { RAW_SYNCED_HISTORICAL_FORMATS, RAW_SYNCED_HISTORICAL_TABLES,
  type RawHistoricalEvidenceFact, type RawHistoricalEvidenceLocator } from './synced-history-evidence-model'

export const DURABLE_SQL_CAPSULE_FILES = Object.freeze(['knowbook.db', 'knowbook.db-wal', 'knowbook.db-shm'] as const)
export const CAPSULE_MAX_FACTS = 100_000
export const CAPSULE_MAX_SHARDS = 64
export const CAPSULE_MAX_SHARD_BYTES = 8 * 1024 * 1024
export const CAPSULE_MAX_INDEX_BYTES = 64 * 1024 * 1024
export const CAPSULE_MAX_MANIFEST_BYTES = 256 * 1024
export const CAPSULE_MAX_ORIGINAL_BYTES = 1024 ** 4
const MAX_KEY_BYTES = 16 * 1024

export interface DurableSqlCapsuleFile {
  readonly name: typeof DURABLE_SQL_CAPSULE_FILES[number]
  readonly present: boolean
  readonly bytes: number
  readonly sha256: string | null
}
export interface DurableSqlCapsuleShardReference {
  readonly name: string; readonly index: number; readonly entries: number; readonly bytes: number; readonly sha256: string
}
export interface DurableSqlCapsuleManifest {
  readonly kind: 'restore-durable-sql-capsule'; readonly version: 1
  readonly material: 'durable-sql-only'; readonly readerVersion: 'knowbook-durable-sql-v1'
  readonly schemaVersion: number; readonly workspaceScope: string | null; readonly recoveryEpoch: string | null
  readonly files: readonly DurableSqlCapsuleFile[]
  readonly schemaHash: string; readonly workspaceHash: string; readonly historyIdentityHash: string
  readonly evidenceIndex: { readonly entries: number; readonly rootHash: string; readonly shards: readonly DurableSqlCapsuleShardReference[] }
}
export interface DurableSqlCapsuleDraft {
  readonly schemaVersion: number; readonly workspaceScope: string | null; readonly recoveryEpoch: string | null
  readonly schemaHash: string; readonly workspaceHash: string; readonly historyIdentityHash: string
  readonly facts: readonly RawHistoricalEvidenceFact[]
}
export interface DurableSqlCapsuleShard {
  readonly kind: 'restore-durable-sql-facts'; readonly version: 1; readonly index: number
  readonly facts: readonly RawHistoricalEvidenceFact[]
}
export interface DurableSqlCapsuleArtifacts {
  readonly manifest: DurableSqlCapsuleManifest; readonly manifestText: string; readonly manifestHash: string
  readonly shards: readonly { readonly reference: DurableSqlCapsuleShardReference; readonly text: string }[]
}
export function capsuleInvalid(message: string): never { throw new Error('持久SQL capsule无效：' + message + '；不授认证或安装权。') }
export const capsuleJson = canonicalSyncedPortableJson
export const capsuleBytesHash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const domainHash = (domain: string, value: unknown): string => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

/** Copy only data descriptors. A caller getter is never evaluated as a fact. */
export function capsuleRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) return capsuleInvalid('记录不是普通闭形对象')
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(descriptors)
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) return capsuleInvalid('记录字段不是准确闭集')
  return Object.fromEntries(keys.map(key => {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !('value' in descriptor)) return capsuleInvalid('记录含访问器或缺字段')
    return [key, descriptor.value]
  }))
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) return capsuleInvalid('集合超预算、含空洞或额外字段')
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : capsuleInvalid('集合含访问器或空洞')
  })
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : capsuleInvalid('整数或预算无效')
}
export function capsuleText(value: unknown, max = MAX_KEY_BYTES): string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max
    && Buffer.from(value, 'utf8').toString('utf8') === value ? value : capsuleInvalid('原字符串无效或超预算')
}
function digest(value: unknown): string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : capsuleInvalid('SHA256无效') }
function scope(value: unknown): string | null { return value === null ? null : isSyncedUuid(value) ? value : capsuleInvalid('原scope/epoch无效') }
function origin(row: Record<string, unknown>) {
  const schemaVersion = integer(row.schemaVersion, 27), workspaceScope = scope(row.workspaceScope), recoveryEpoch = scope(row.recoveryEpoch)
  if (schemaVersion < 1 || (schemaVersion >= 26) !== (workspaceScope !== null) || (workspaceScope === null) !== (recoveryEpoch === null))
    return capsuleInvalid('schema版本与原scope/epoch不闭合')
  return { schemaVersion, workspaceScope, recoveryEpoch }
}
export function freezeCapsuleValue<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeCapsuleValue(child)
    Object.freeze(value)
  }
  return value
}
export function validateDurableSqlCapsuleInventory(value: unknown): readonly DurableSqlCapsuleFile[] {
  const rows = list(value, DURABLE_SQL_CAPSULE_FILES.length)
  if (rows.length !== DURABLE_SQL_CAPSULE_FILES.length) return capsuleInvalid('缺准确DB/WAL/SHM清单')
  const files = rows.map((raw, index): DurableSqlCapsuleFile => {
    const row = capsuleRecord(raw, ['name', 'present', 'bytes', 'sha256']), bytes = integer(row.bytes, CAPSULE_MAX_ORIGINAL_BYTES)
    if (row.name !== DURABLE_SQL_CAPSULE_FILES[index] || typeof row.present !== 'boolean') return capsuleInvalid('原件名称或状态无效')
    const sha256 = row.sha256 === null ? null : digest(row.sha256)
    if (row.present ? sha256 === null : bytes !== 0 || sha256 !== null) return capsuleInvalid('原件缺省状态不闭合')
    return { name: DURABLE_SQL_CAPSULE_FILES[index], present: row.present, bytes, sha256 }
  })
  if (!files[0].present || files.reduce((sum, row) => sum + row.bytes, 0) > CAPSULE_MAX_ORIGINAL_BYTES) return capsuleInvalid('原DB缺失或三文件总预算超限')
  return freezeCapsuleValue(files)
}
function locator(value: unknown): RawHistoricalEvidenceLocator {
  const row = capsuleRecord(value, ['table', 'key', 'rowHash'])
  if (!(RAW_SYNCED_HISTORICAL_TABLES as readonly unknown[]).includes(row.table)) return capsuleInvalid('未知原SQL证据表')
  const key = list(row.key, 8).map(value => typeof value === 'string' ? capsuleText(value) : integer(value))
  if (!key.length || Buffer.byteLength(capsuleJson(key)) > MAX_KEY_BYTES) return capsuleInvalid('原SQL主键无效')
  return { table: row.table as RawHistoricalEvidenceLocator['table'], key, rowHash: digest(row.rowHash) }
}
const locatorKey = (row: RawHistoricalEvidenceLocator): string => capsuleJson([row.table, row.key])
export const durableSqlCapsuleFactKey = (row: RawHistoricalEvidenceFact): string => capsuleJson([row.family, row.version, row.locator.table, row.locator.key])
function fact(value: unknown): RawHistoricalEvidenceFact {
  const row = capsuleRecord(value, ['family', 'version', 'evidenceClass', 'locator', 'supports'])
  if (typeof row.family !== 'string' || !Object.hasOwn(RAW_SYNCED_HISTORICAL_FORMATS, row.family)) return capsuleInvalid('未知原SQL证据族')
  const family = row.family as RawHistoricalEvidenceFact['family']
  if (!(RAW_SYNCED_HISTORICAL_FORMATS[family] as readonly unknown[]).includes(row.version)) return capsuleInvalid('未知原SQL证据版本')
  if (row.evidenceClass !== 'durable-only' && row.evidenceClass !== 'index-attempt-only') return capsuleInvalid('证据强度不能冒充完整material')
  let supportBytes = 0
  const supports = list(row.supports, CAPSULE_MAX_FACTS).map(value => {
    const checked = locator(value)
    supportBytes += Buffer.byteLength(capsuleJson(checked))
    if (supportBytes > CAPSULE_MAX_SHARD_BYTES) return capsuleInvalid('完整支持集超单片字节预算，不能丢弃支持')
    return checked
  }).sort((a, b) => compare(locatorKey(a), locatorKey(b)))
  for (let index = 1; index < supports.length; index++) if (locatorKey(supports[index - 1]) === locatorKey(supports[index])) return capsuleInvalid('重复原SQL支持定位')
  return { family, version: row.version as number | null, evidenceClass: row.evidenceClass, locator: locator(row.locator), supports }
}
function orderedFacts(value: unknown): RawHistoricalEvidenceFact[] {
  let totalBytes = 0
  const rows = list(value, CAPSULE_MAX_FACTS).map(value => {
    const checked = fact(value)
    totalBytes += Buffer.byteLength(capsuleJson(checked))
    if (totalBytes > CAPSULE_MAX_INDEX_BYTES) return capsuleInvalid('完整事实索引超总字节预算')
    return checked
  }).sort((a, b) => compare(durableSqlCapsuleFactKey(a), durableSqlCapsuleFactKey(b)))
  for (let index = 1; index < rows.length; index++) if (durableSqlCapsuleFactKey(rows[index - 1]) === durableSqlCapsuleFactKey(rows[index]))
    return capsuleInvalid('重复或矛盾的原SQL事实')
  return rows
}
export const durableSqlCapsuleShardName = (index: number): string => 'facts-' + String(integer(index, CAPSULE_MAX_SHARDS - 1)).padStart(6, '0') + '.json'
const indexHash = (entries: number, shards: readonly DurableSqlCapsuleShardReference[]): string => domainHash('knowbook.durable-sql.fact-index.v1', { entries, shards })
function shardReference(value: unknown, index: number): DurableSqlCapsuleShardReference {
  const row = capsuleRecord(value, ['name', 'index', 'entries', 'bytes', 'sha256'])
  if (row.index !== index || row.name !== durableSqlCapsuleShardName(index)) return capsuleInvalid('分片名称/顺序无效')
  const entries = integer(row.entries, CAPSULE_MAX_FACTS), bytes = integer(row.bytes, CAPSULE_MAX_SHARD_BYTES)
  if (!entries || !bytes) return capsuleInvalid('不得有空分片')
  return { name: durableSqlCapsuleShardName(index), index, entries, bytes, sha256: digest(row.sha256) }
}
export function validateDurableSqlCapsuleManifest(value: unknown): DurableSqlCapsuleManifest {
  const row = capsuleRecord(value, ['kind', 'version', 'material', 'readerVersion', 'schemaVersion', 'workspaceScope', 'recoveryEpoch',
    'files', 'schemaHash', 'workspaceHash', 'historyIdentityHash', 'evidenceIndex'])
  if (row.kind !== 'restore-durable-sql-capsule' || row.version !== 1 || row.material !== 'durable-sql-only' || row.readerVersion !== 'knowbook-durable-sql-v1')
    return capsuleInvalid('未知capsule格式或material范围')
  const rawIndex = capsuleRecord(row.evidenceIndex, ['entries', 'rootHash', 'shards']), entries = integer(rawIndex.entries, CAPSULE_MAX_FACTS)
  const shards = list(rawIndex.shards, CAPSULE_MAX_SHARDS).map(shardReference)
  if (entries !== shards.reduce((sum, shard) => sum + shard.entries, 0) || shards.reduce((sum, shard) => sum + shard.bytes, 0) > CAPSULE_MAX_INDEX_BYTES
    || digest(rawIndex.rootHash) !== indexHash(entries, shards)) return capsuleInvalid('完整事实索引/root或总预算不闭合')
  return freezeCapsuleValue({ kind: row.kind, version: 1, material: row.material, readerVersion: row.readerVersion,
    ...origin(row), files: validateDurableSqlCapsuleInventory(row.files), schemaHash: digest(row.schemaHash), workspaceHash: digest(row.workspaceHash),
    historyIdentityHash: digest(row.historyIdentityHash), evidenceIndex: { entries, rootHash: rawIndex.rootHash, shards } } as DurableSqlCapsuleManifest)
}
export function parseDurableSqlCapsuleManifest(source: string): DurableSqlCapsuleManifest {
  const value = validateDurableSqlCapsuleManifest(parseStrictJson(source, { maxBytes: CAPSULE_MAX_MANIFEST_BYTES, maxDepth: 24 }))
  if (capsuleJson(value) !== source) return capsuleInvalid('manifest不是原canonical JSON')
  return value
}
export function parseDurableSqlCapsuleShard(source: string, expectedIndex: number): DurableSqlCapsuleShard {
  const row = capsuleRecord(parseStrictJson(source, { maxBytes: CAPSULE_MAX_SHARD_BYTES, maxDepth: 24 }), ['kind', 'version', 'index', 'facts'])
  if (row.kind !== 'restore-durable-sql-facts' || row.version !== 1 || row.index !== integer(expectedIndex, CAPSULE_MAX_SHARDS - 1)) return capsuleInvalid('未知事实分片格式/顺序')
  const value: DurableSqlCapsuleShard = { kind: row.kind, version: 1, index: expectedIndex, facts: orderedFacts(row.facts) }
  if (!value.facts.length || capsuleJson(value) !== source) return capsuleInvalid('分片不是准确非空canonical事实集')
  return freezeCapsuleValue(value)
}
export const durableSqlCapsuleManifestHash = (manifest: DurableSqlCapsuleManifest): string => domainHash('knowbook.durable-sql.capsule.v1', validateDurableSqlCapsuleManifest(manifest))

/** Builds serializable artifacts only. No fact DTO or model result is certified. */
export function buildDurableSqlCapsuleArtifacts(input: DurableSqlCapsuleDraft, originalInventory: unknown): DurableSqlCapsuleArtifacts {
  const row = capsuleRecord(input, ['schemaVersion', 'workspaceScope', 'recoveryEpoch', 'schemaHash', 'workspaceHash', 'historyIdentityHash', 'facts'])
  const rawOrigin = origin(row), facts = orderedFacts(row.facts), shards: Array<{ reference: DurableSqlCapsuleShardReference; text: string }> = []
  let current: RawHistoricalEvidenceFact[] = [], payloadBytes = 0, totalShardBytes = 0
  const encode = (rows: readonly RawHistoricalEvidenceFact[]): string => capsuleJson({ kind: 'restore-durable-sql-facts', version: 1, index: shards.length, facts: rows })
  const finish = (): void => {
    const text = encode(current), bytes = Buffer.byteLength(text)
    totalShardBytes += bytes
    if (!current.length || bytes > CAPSULE_MAX_SHARD_BYTES || shards.length >= CAPSULE_MAX_SHARDS || totalShardBytes > CAPSULE_MAX_INDEX_BYTES)
      return capsuleInvalid('事实分片总量或单片超预算')
    shards.push({ reference: { name: durableSqlCapsuleShardName(shards.length), index: shards.length, entries: current.length, bytes, sha256: capsuleBytesHash(text) }, text })
    current = []; payloadBytes = 0
  }
  for (const item of facts) {
    const itemBytes = Buffer.byteLength(capsuleJson(item))
    if (Buffer.byteLength(encode([])) + payloadBytes + (current.length ? 1 : 0) + itemBytes > CAPSULE_MAX_SHARD_BYTES) {
      if (!current.length) return capsuleInvalid('单事实超分片预算')
      finish()
    }
    if (Buffer.byteLength(encode([])) + itemBytes > CAPSULE_MAX_SHARD_BYTES) return capsuleInvalid('单事实超分片预算')
    payloadBytes += itemBytes + (current.length ? 1 : 0)
    current.push(item)
  }
  if (current.length) finish()
  const references = shards.map(row => row.reference)
  const manifest = validateDurableSqlCapsuleManifest({ kind: 'restore-durable-sql-capsule', version: 1, material: 'durable-sql-only', readerVersion: 'knowbook-durable-sql-v1',
    ...rawOrigin, files: originalInventory, schemaHash: row.schemaHash, workspaceHash: row.workspaceHash, historyIdentityHash: row.historyIdentityHash,
    evidenceIndex: { entries: facts.length, rootHash: indexHash(facts.length, references), shards: references } })
  const manifestText = capsuleJson(manifest)
  if (Buffer.byteLength(manifestText) > CAPSULE_MAX_MANIFEST_BYTES) return capsuleInvalid('manifest超预算')
  return freezeCapsuleValue({ manifest, manifestText, manifestHash: durableSqlCapsuleManifestHash(manifest), shards })
}
