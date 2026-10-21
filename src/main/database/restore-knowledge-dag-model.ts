import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'

export const DURABLE_SQL_DAG_MAX_NODES = 256
export const DURABLE_SQL_DAG_MAX_DEPTH = 64
export const DURABLE_SQL_DAG_MAX_PARENTS = 128
export const DURABLE_SQL_DAG_MAX_CAPSULES = 1024
export const DURABLE_SQL_DAG_MAX_NODE_BYTES = 256 * 1024
export const DURABLE_SQL_DAG_MAX_TOTAL_NODE_BYTES = 64 * 1024 * 1024
export const DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES = 8 * 1024 ** 4

export interface DurableSqlCapsuleReference {
  readonly kind: 'durable-sql-capsule-ref'; readonly version: 1
  readonly operationId: string; readonly capsuleId: string; readonly manifestHash: string
}
export interface DurableSqlDagReference {
  readonly kind: 'durable-sql-dag-ref'; readonly version: 1
  readonly operationId: string; readonly dagId: string; readonly rootHash: string
}
/** Prepared original evidence ancestry only. No accepted SQL coverage, semantic
 * union, source/publication authority or installer permission is encoded here. */
export interface DurableSqlDagNode {
  readonly kind: 'restore-durable-sql-dag-node'; readonly version: 1
  readonly readerVersion: 'knowbook-durable-sql-dag-v1'; readonly material: 'durable-sql-only'
  readonly source: DurableSqlCapsuleReference; readonly current: DurableSqlCapsuleReference
  readonly parents: readonly DurableSqlDagReference[]
}
export function durableSqlDagInvalid(message: string): never {
  throw new Error('持久SQL原件DAG无效：' + message + '；不授K覆盖、内容、publication或安装权。')
}
export function durableSqlDagUuid(value: unknown): string {
  return isSyncedUuid(value) && value === value.toLowerCase() ? value : durableSqlDagInvalid('UUID不是准确canonical小写值')
}
export function durableSqlDagHash(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : durableSqlDagInvalid('hash无效')
}
/** Descriptor-safe finite collection; accessor values are never evaluated. */
export function durableSqlDagList(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) return durableSqlDagInvalid('集合超预算、含空洞或额外字段')
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : durableSqlDagInvalid('集合含访问器或空洞')
  })
}
export function validateDurableSqlCapsuleReference(value: unknown): DurableSqlCapsuleReference {
  const row = capsuleRecord(value, ['kind', 'version', 'operationId', 'capsuleId', 'manifestHash'])
  if (row.kind !== 'durable-sql-capsule-ref' || row.version !== 1) return durableSqlDagInvalid('未知capsule引用格式')
  const result: DurableSqlCapsuleReference = { kind: row.kind, version: 1, operationId: durableSqlDagUuid(row.operationId),
    capsuleId: durableSqlDagUuid(row.capsuleId), manifestHash: durableSqlDagHash(row.manifestHash) }
  return freezeCapsuleValue(result)
}
export function validateDurableSqlDagReference(value: unknown): DurableSqlDagReference {
  const row = capsuleRecord(value, ['kind', 'version', 'operationId', 'dagId', 'rootHash'])
  if (row.kind !== 'durable-sql-dag-ref' || row.version !== 1) return durableSqlDagInvalid('未知DAG引用格式')
  const result: DurableSqlDagReference = { kind: row.kind, version: 1, operationId: durableSqlDagUuid(row.operationId),
    dagId: durableSqlDagUuid(row.dagId), rootHash: durableSqlDagHash(row.rootHash) }
  return freezeCapsuleValue(result)
}
export const durableSqlCapsuleLocator = (ref: DurableSqlCapsuleReference): string => capsuleJson([ref.operationId, ref.capsuleId])
export const durableSqlDagLocator = (ref: DurableSqlDagReference): string => capsuleJson([ref.operationId, ref.dagId])
export function validateDurableSqlDagNode(value: unknown): DurableSqlDagNode {
  const row = capsuleRecord(value, ['kind', 'version', 'readerVersion', 'material', 'source', 'current', 'parents'])
  if (row.kind !== 'restore-durable-sql-dag-node' || row.version !== 1
    || row.readerVersion !== 'knowbook-durable-sql-dag-v1' || row.material !== 'durable-sql-only')
    return durableSqlDagInvalid('未知node版本或material范围')
  const source = validateDurableSqlCapsuleReference(row.source), current = validateDurableSqlCapsuleReference(row.current)
  if (durableSqlCapsuleLocator(source) === durableSqlCapsuleLocator(current))
    return durableSqlDagInvalid('source/current必须有各自独立原件；同一capsule不能冒充两侧')
  const parents = durableSqlDagList(row.parents, DURABLE_SQL_DAG_MAX_PARENTS).map(validateDurableSqlDagReference)
  for (let index = 1; index < parents.length; index++)
    if (durableSqlDagLocator(parents[index - 1]) >= durableSqlDagLocator(parents[index]))
      return durableSqlDagInvalid('parent引用未按准确locator排序或重复矛盾')
  const result: DurableSqlDagNode = { kind: row.kind, version: 1, readerVersion: row.readerVersion,
    material: row.material, source, current, parents }
  if (Buffer.byteLength(capsuleJson(result)) > DURABLE_SQL_DAG_MAX_NODE_BYTES) return durableSqlDagInvalid('node超预算')
  return freezeCapsuleValue(result)
}
/** The preimage is exactly the node. It excludes its own rootHash, future
 * coverage, final stage, receipt, boundary, intent and any caller proof. */
export const durableSqlDagRootHash = (node: DurableSqlDagNode): string =>
  capsuleBytesHash('knowbook.durable-sql.original-dag.v1\0' + capsuleJson(validateDurableSqlDagNode(node)))
export function parseDurableSqlDagNode(text: string): DurableSqlDagNode {
  const node = validateDurableSqlDagNode(parseStrictJson(text, { maxBytes: DURABLE_SQL_DAG_MAX_NODE_BYTES, maxDepth: 12 }))
  if (capsuleJson(node) !== text) return durableSqlDagInvalid('node不是准确canonical JSON')
  return node
}
