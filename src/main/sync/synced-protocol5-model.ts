import type { SyncedGroupDeletedWire } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, SYNCED_MAX_BLOCKS } from '../../shared/syncedBlockValidation'
import type { SyncDeletion } from './model'
import {
  PUBLICATION_RECORD_MAX_BYTES, publicationCompare, publicationHash, publicationInvalid, publicationJson,
  validateInitialManifest5, validateInitialRecord, validateInitialSnapshot,
  type InitialPublicationRecord, type SyncedInitialManifest5
} from './synced-publication-model'

/** Protocol 5 adds group tombstones without changing the legacy document deletion wire. */
export type SyncedProtocol5Record = InitialPublicationRecord | SyncDeletion | SyncedGroupDeletedWire
export type SyncedProtocol5Manifest = SyncedInitialManifest5
export interface SyncedProtocol5Snapshot {
  manifest: SyncedProtocol5Manifest
  records: Array<{ key: string; hash: string; record: SyncedProtocol5Record }>
  assetNames: Map<string, Set<string>>
}

function opaque(value: unknown): string {
  return isSyncedBlockId(value) ? value : publicationInvalid('协议5记录身份无效。')
}
function uuid(value: unknown): string {
  return isSyncedUuid(value) ? value : publicationInvalid('协议5组创建身份无效。')
}
function digest(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : publicationInvalid('协议5删除前哈希无效。')
}
function timestamp(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : publicationInvalid('协议5删除日期无效。')
}
function withinRecordBudget(value: unknown, label: string): void {
  if (Buffer.byteLength(publicationJson(value), 'utf8') > PUBLICATION_RECORD_MAX_BYTES)
    publicationInvalid(label + '超过原16MiB门槛。')
}

/** Inspect descriptors before reading values; no accessor or toJSON is evaluated. */
function dataChildren(value: object): unknown[] {
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return publicationInvalid('协议5数据包含自定义原型。')
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
  if (keys.some(key => typeof key !== 'string')) return publicationInvalid('协议5数据包含符号字段。')
  if (array) {
    const length = descriptors.length?.value as unknown
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1)
      return publicationInvalid('协议5数组不是完整闭集。')
    for (let index = 0; index < length; index++) {
      if (!Object.hasOwn(descriptors, String(index))) return publicationInvalid('协议5数组包含空位或额外字段。')
    }
  }
  const children: unknown[] = []
  for (const key of keys as string[]) {
    if (array && key === 'length') continue
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      return publicationInvalid('协议5数据包含访问器或隐藏字段。')
    children.push(descriptor.value)
  }
  return children
}

function assertClosedData(value: unknown): void {
  const ancestors = new Set<object>()
  function visit(item: unknown, depth: number): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || ancestors.has(item)) return publicationInvalid('协议5数据不是有限JSON。')
    if (depth >= 32) return publicationInvalid('协议5数据超过原JSON深度门槛。')
    const children = dataChildren(item)
    ancestors.add(item)
    for (const child of children) visit(child, depth + 1)
    ancestors.delete(item)
  }
  visit(value, 0)
}

export function syncedProtocol5RecordKey(record: SyncedProtocol5Record): string {
  return record.kind === 'synced-group' || record.kind === 'synced-group-deleted' ? 'group:' + record.id
    : record.kind === 'databases' ? 'databases' : 'doc:' + record.id
}

/** Shape and key checks do not authorize a deletion, an owner transfer, or a baseline advance. */
export function validateSyncedProtocol5Record(value: unknown, key: string): SyncedProtocol5Record {
  assertClosedData(value)
  if (!value || typeof value !== 'object' || !('kind' in value)) return publicationInvalid('协议5对象记录无效。')
  let record: SyncedProtocol5Record
  if (value.kind === 'deleted') {
    const deletion: unknown = value
    assertSyncedShape(deletion, ['kind', 'id'])
    record = { kind: 'deleted', id: opaque(deletion.id) }
  } else if (value.kind === 'synced-group-deleted') {
    const deletion: unknown = value
    assertSyncedShape(deletion, ['kind', 'id', 'creationId', 'previousHash', 'deletedAt'])
    record = { kind: 'synced-group-deleted', id: uuid(deletion.id), creationId: uuid(deletion.creationId),
      previousHash: digest(deletion.previousHash), deletedAt: timestamp(deletion.deletedAt) }
  } else record = validateInitialRecord(value, key)
  if (typeof key !== 'string' || key !== syncedProtocol5RecordKey(record)) return publicationInvalid('协议5记录与准确键不一致。')
  withinRecordBudget(record, '协议5对象')
  return record
}

/**
 * Validate one complete protocol-5 wire closure, including its tombstones.
 * The initial-snapshot APIs stay restricted to live records. This result is pure
 * validated data; only a real client's private exchange plan can grant authority.
 */
export function validateSyncedProtocol5Snapshot(manifestValue: unknown,
  values: Array<{ key: string; record: unknown }>): SyncedProtocol5Snapshot {
  assertClosedData(manifestValue)
  const manifest = validateInitialManifest5(manifestValue)
  withinRecordBudget(manifest, '协议5清单')
  if (!Array.isArray(values) || values.length > SYNCED_MAX_BLOCKS) return publicationInvalid('协议5对象闭集超过原条目门槛。')
  dataChildren(values)
  const records: SyncedProtocol5Snapshot['records'] = [], seen = new Set<string>()
  for (const item of values) {
    if (!item || typeof item !== 'object') return publicationInvalid('协议5对象闭集条目无效。')
    dataChildren(item)
    assertSyncedShape(item, ['key', 'record'])
    if (typeof item.key !== 'string' || seen.has(item.key)) return publicationInvalid('协议5对象闭集包含重复或无效键。')
    const record = validateSyncedProtocol5Record(item.record, item.key), hash = publicationHash(publicationJson(record))
    if (!Object.hasOwn(manifest.entries, item.key) || manifest.entries[item.key] !== hash)
      return publicationInvalid('协议5对象原语义哈希与清单不一致。')
    seen.add(item.key); records.push({ key: item.key, hash, record })
  }
  if (records.length !== Object.keys(manifest.entries).length) return publicationInvalid('协议5对象不是完整清单闭集。')
  const live = records.filter((item): item is { key: string; hash: string; record: InitialPublicationRecord } =>
    item.record.kind !== 'deleted' && item.record.kind !== 'synced-group-deleted')
  // The original manifest remains intact. The temporary live view is used only
  // for strict graph/catalog/binding/instance/asset and per-occurrence budgets.
  const validated = validateInitialSnapshot({ ...manifest, entries: Object.fromEntries(live.map(item => [item.key, item.hash])) }, live.map(({ key, record }) => ({ key, record })))
  records.sort((left, right) => publicationCompare(left.key, right.key))
  return { manifest, records, assetNames: validated.assetNames }
}
