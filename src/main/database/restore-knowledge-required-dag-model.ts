import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue, validateDurableSqlCapsuleInventory } from './restore-knowledge-capsule-model'
import { durableSqlDagList, durableSqlDagUuid, DURABLE_SQL_DAG_MAX_NODE_BYTES, DURABLE_SQL_DAG_MAX_PARENTS } from './restore-knowledge-dag-model'
import { COVERAGE_MAX_REQUIRED_ROOTS, validateCoverageCapsuleReference, validateCoverageRootReference,
  type CoverageInputBinding, type CoverageRootReference } from './restore-knowledge-coverage-model'
import { parseStrictJson } from '../../shared/strictJson'

export const REQUIRED_DAG_READER = 'knowbook-required-sql-knowledge-dag-v2'
export interface RequiredDagNoPriorOrigin {
  readonly kind: 'no-prior-coverage-references'; readonly version: 1
  readonly databaseFilesHash: string; readonly rawRequirementsHash: string
}
/** Finite future branch: pure structure only. The first producer/reopener below
 * explicitly refuses this until an actual Main-owned bundle importer exists. */
export interface RequiredDagBundleOrigin {
  readonly kind: 'bound-original-bundle'; readonly version: 1
  readonly mountId: string; readonly bundleDescriptorHash: string
  readonly databaseFilesHash: string; readonly rawRequirementsHash: string
}
export type RequiredDagOrigin = RequiredDagNoPriorOrigin | RequiredDagBundleOrigin
export interface RequiredSqlDagNode {
  readonly kind: 'restore-required-sql-knowledge-dag-node'; readonly version: 2
  readonly readerVersion: typeof REQUIRED_DAG_READER; readonly material: 'durable-sql-only'
  readonly source: CoverageInputBinding; readonly current: CoverageInputBinding
  readonly origins: { readonly source: RequiredDagOrigin; readonly current: RequiredDagOrigin }
  readonly parents: readonly CoverageRootReference[]
}
export function requiredDagInvalid(message: string): never { throw new Error('SQL要求驱动DAG v2无效：' + message + '；不授accepted/live/安装权。') }
function digest(value: unknown): string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : requiredDagInvalid('原hash无效') }
export const requiredDagRootLocator = (root: CoverageRootReference): string => capsuleJson([root.namespace, root.operationId, root.dagId])
export const requiredDagCapsuleLocator = (binding: CoverageInputBinding): string => capsuleJson([binding.capsule.namespace, binding.capsule.operationId, binding.capsule.capsuleId])
function roots(value: unknown, max = COVERAGE_MAX_REQUIRED_ROOTS): readonly CoverageRootReference[] {
  const result = durableSqlDagList(value, max).map(validateCoverageRootReference)
  for (let index = 1; index < result.length; index++) if (requiredDagRootLocator(result[index - 1]) >= requiredDagRootLocator(result[index]))
    return requiredDagInvalid('完整原root未按域/locator排序或重复')
  return result
}
function binding(value: unknown): CoverageInputBinding {
  const row = capsuleRecord(value, ['capsule', 'interpretationHash', 'rawRequirementsHash', 'requiredRoots'])
  return { capsule: validateCoverageCapsuleReference(row.capsule), interpretationHash: digest(row.interpretationHash),
    rawRequirementsHash: digest(row.rawRequirementsHash), requiredRoots: roots(row.requiredRoots) }
}
function origin(value: unknown): RequiredDagOrigin {
  if (!value || typeof value !== 'object') return requiredDagInvalid('缺原解释支持')
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')
  if (!kind || !('value' in kind)) return requiredDagInvalid('origin kind含accessor')
  if (kind.value === 'no-prior-coverage-references') {
    const row = capsuleRecord(value, ['kind', 'version', 'databaseFilesHash', 'rawRequirementsHash'])
    if (row.version !== 1) return requiredDagInvalid('未知无引用解释格式')
    return { kind: row.kind as 'no-prior-coverage-references', version: 1, databaseFilesHash: digest(row.databaseFilesHash), rawRequirementsHash: digest(row.rawRequirementsHash) }
  }
  if (kind.value === 'bound-original-bundle') {
    const row = capsuleRecord(value, ['kind', 'version', 'mountId', 'bundleDescriptorHash', 'databaseFilesHash', 'rawRequirementsHash'])
    if (row.version !== 1) return requiredDagInvalid('未知bundle解释格式')
    return { kind: row.kind as 'bound-original-bundle', version: 1, mountId: durableSqlDagUuid(row.mountId), bundleDescriptorHash: digest(row.bundleDescriptorHash),
      databaseFilesHash: digest(row.databaseFilesHash), rawRequirementsHash: digest(row.rawRequirementsHash) }
  }
  return requiredDagInvalid('未知origin解释族')
}
export const requiredDagInterpretationHash = (value: RequiredDagOrigin): string => capsuleBytesHash('knowbook.required-sql.origin-interpretation.v2\0' + capsuleJson(origin(value)))
export const requiredDagDatabaseFilesHash = (value: unknown): string => capsuleBytesHash('knowbook.required-sql.database-files.v2\0' + capsuleJson(validateDurableSqlCapsuleInventory(value)))
/** The exact complete union, never a caller-selected prefix. Same hash at a
 * different namespace/locator remains a separate required physical original. */
export function requiredDagParentUnion(source: readonly CoverageRootReference[], current: readonly CoverageRootReference[]): readonly CoverageRootReference[] {
  const result = new Map<string, CoverageRootReference>()
  for (const root of [...source, ...current]) {
    const key = requiredDagRootLocator(root), before = result.get(key)
    if (before && before.rootHash !== root.rootHash) return requiredDagInvalid('同域/locator原root hash冲突')
    result.set(key, root)
  }
  if (result.size > DURABLE_SQL_DAG_MAX_PARENTS) return requiredDagInvalid('完整父集超原DAG预算，不能截断')
  return [...result].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, root]) => root)
}
export function validateRequiredSqlDagNode(value: unknown): RequiredSqlDagNode {
  const row = capsuleRecord(value, ['kind', 'version', 'readerVersion', 'material', 'source', 'current', 'origins', 'parents'])
  if (row.kind !== 'restore-required-sql-knowledge-dag-node' || row.version !== 2 || row.readerVersion !== REQUIRED_DAG_READER || row.material !== 'durable-sql-only')
    return requiredDagInvalid('未知node格式')
  const source = binding(row.source), current = binding(row.current), original = capsuleRecord(row.origins, ['source', 'current'])
  const origins = { source: origin(original.source), current: origin(original.current) }, parents = roots(row.parents, DURABLE_SQL_DAG_MAX_PARENTS)
  if (requiredDagCapsuleLocator(source) === requiredDagCapsuleLocator(current)) return requiredDagInvalid('source/current必须有独立原件locator')
  for (const [input, proof] of [[source, origins.source], [current, origins.current]] as const) {
    if (input.rawRequirementsHash !== proof.rawRequirementsHash || input.interpretationHash !== requiredDagInterpretationHash(proof)
      || proof.kind === 'no-prior-coverage-references' && input.requiredRoots.length) return requiredDagInvalid('binding与原域支持不闭合')
  }
  if (capsuleJson(parents) !== capsuleJson(requiredDagParentUnion(source.requiredRoots, current.requiredRoots))) return requiredDagInvalid('node父集不是两侧完整SQL要求的解释全集')
  const node: RequiredSqlDagNode = { kind: row.kind, version: 2, readerVersion: REQUIRED_DAG_READER, material: 'durable-sql-only', source, current, origins, parents }
  if (Buffer.byteLength(capsuleJson(node)) > DURABLE_SQL_DAG_MAX_NODE_BYTES) return requiredDagInvalid('完整node超预算')
  return freezeCapsuleValue(node)
}
export const requiredSqlDagRootHash = (node: RequiredSqlDagNode): string => capsuleBytesHash('knowbook.required-sql.original-dag.v2\0' + capsuleJson(validateRequiredSqlDagNode(node)))
export function parseRequiredSqlDagNode(text: string): RequiredSqlDagNode {
  const node = validateRequiredSqlDagNode(parseStrictJson(text, { maxBytes: DURABLE_SQL_DAG_MAX_NODE_BYTES, maxDepth: 16 }))
  if (capsuleJson(node) !== text) return requiredDagInvalid('node不是准确canonical原bytes')
  return node
}
