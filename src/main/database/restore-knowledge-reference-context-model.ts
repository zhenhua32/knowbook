import { posix } from 'node:path'
import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { durableSqlDagHash, durableSqlDagList, durableSqlDagUuid, DURABLE_SQL_DAG_MAX_DEPTH, DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES, DURABLE_SQL_DAG_MAX_PARENTS } from './restore-knowledge-dag-model'
import { rawPriorCoverageRequirementsHash, validateCoverageRootReference, validateRawPriorCoverageRequirements,
  type CoverageRootReference, type RawPriorCoverageRequirements } from './restore-knowledge-coverage-model'
import { requiredDagRootLocator } from './restore-knowledge-required-dag-model'

/** This descriptor is transport data. Only the private IO owner can prove that
 * all listed inputs were independently rebuilt from their actual originals.
 * Raw references stay in their original domain; mountedRoot is a new explicit
 * binding, never a native-profile fallback or an accepted-coverage assertion. */
export interface ReferenceContextFile {
  readonly frame: readonly string[]; readonly path: string; readonly bytes: number; readonly sha256: string
}
export interface ReferenceContextDirectory { readonly frame: readonly string[]; readonly path: string }
export interface ReferenceContextParent {
  readonly reference: CoverageRootReference
  readonly mountId: string
  readonly reader: 'prepared-mixed-v2' | 'qualified-originals-v1'
  readonly descriptorHash: string
  readonly originalRoot: CoverageRootReference
  readonly materialHash: string
  readonly originalSqlBytes: number; readonly managedOriginalBytes: number
  readonly files: readonly ReferenceContextFile[]; readonly directories: readonly ReferenceContextDirectory[]
}
export interface Capsule2ReferenceContextDescriptor {
  readonly kind: 'capsule2-original-reference-context'; readonly version: 1
  readonly scope: 'complete-referenced-original-inputs'
  readonly contextId: string
  readonly source: { readonly operationId: string; readonly capsuleId: string; readonly sourceManifestHash: string
    readonly sourceMaterialHash: string; readonly rawRequirementsHash: string }
  readonly requirements: RawPriorCoverageRequirements
  readonly parents: readonly ReferenceContextParent[]
  readonly acceptedCoverage: false; readonly effective: false; readonly permit: false
}
export const REFERENCE_CONTEXT_MAX_BYTES = CAPSULE2_RAW_MAX_JSON_BYTES
const MAX_ENTRIES = 1_000_000
export function referenceContextInvalid(message: string): never {
  throw new Error('完整原件引用上下文无效：' + message + '；不授accepted、empty、策略重放或安装权。')
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
function bytes(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : referenceContextInvalid('原字节计数无效')
}
function relativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 32760 || /[\\\x00-\x1f\x7f]/.test(value)
    || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..') || posix.normalize(value) !== value)
    return referenceContextInvalid('原件相对路径不准确或越界')
  return value
}
function frame(value: unknown, max = 2 * DURABLE_SQL_DAG_MAX_DEPTH): readonly string[] {
  return durableSqlDagList(value, max).map(durableSqlDagUuid)
}
export const referenceContextFileKey = (value: Pick<ReferenceContextFile, 'frame' | 'path'>): string => capsuleJson([value.frame, value.path])
/** Flat physical storage preserves the full logical domain path without
 * turning a 64-generation DAG into an overlong native filesystem path. */
export function referenceContextObjectPath(domain: readonly string[], logicalPath: string): string {
  const checked = frame(domain, 2 * DURABLE_SQL_DAG_MAX_DEPTH + 1), path = relativePath(logicalPath)
  return 'objects/' + capsuleBytesHash('knowbook.original-input-frame.v1\0' + capsuleJson(checked))
    + '/' + capsuleBytesHash('knowbook.original-input-path.v1\0' + path)
}
function ordered<T>(values: T[], key: (item: T) => string): T[] {
  for (let i = 1; i < values.length; i++) if (compare(key(values[i - 1]), key(values[i])) >= 0)
    return referenceContextInvalid('原件集合未准确排序或有重复')
  return values
}
export function requiredReferenceRoots(value: RawPriorCoverageRequirements): readonly CoverageRootReference[] {
  const requirements = validateRawPriorCoverageRequirements(value), found = new Map<string, CoverageRootReference>()
  for (const entry of requirements.entries) {
    const key = requiredDagRootLocator(entry.root), prior = found.get(key)
    if (prior && capsuleJson(prior) !== capsuleJson(entry.root)) return referenceContextInvalid('原SQL同域root locator有不同pin')
    found.set(key, entry.root)
  }
  if (found.size > DURABLE_SQL_DAG_MAX_PARENTS) return referenceContextInvalid('完整原SQL父集超原DAG预算；不能截断')
  return [...found.entries()].sort(([a], [b]) => compare(a, b)).map(([, root]) => root)
}
function sameOriginalRoot(reference: CoverageRootReference, original: CoverageRootReference): boolean {
  return original.namespace.kind === 'native' && reference.operationId === original.operationId && reference.dagId === original.dagId
    && reference.rootHash === original.rootHash && reference.readerVersion === original.readerVersion
}
function parent(value: unknown): ReferenceContextParent {
  const row = capsuleRecord(value, ['reference','mountId','reader','descriptorHash','originalRoot','materialHash',
    'originalSqlBytes','managedOriginalBytes','files','directories'])
  const reference = validateCoverageRootReference(row.reference), originalRoot = validateCoverageRootReference(row.originalRoot)
  if (!sameOriginalRoot(reference, originalRoot)) return referenceContextInvalid('原SQL引用与完整父原件root不相等')
  if (row.reader !== 'prepared-mixed-v2' && row.reader !== 'qualified-originals-v1') return referenceContextInvalid('未知实际父原件reader')
  const descriptorHash = durableSqlDagHash(row.descriptorHash)
  if (reference.namespace.kind === 'imported-bundle' && reference.namespace.bundleDescriptorHash !== descriptorHash)
    return referenceContextInvalid('原imported域的descriptor pin不属于该实际原件包')
  const files = ordered(durableSqlDagList(row.files, MAX_ENTRIES).map(value => {
    const file = capsuleRecord(value, ['frame','path','bytes','sha256'])
    return { frame: frame(file.frame), path: relativePath(file.path), bytes: bytes(file.bytes), sha256: durableSqlDagHash(file.sha256) }
  }), referenceContextFileKey)
  const directories = ordered(durableSqlDagList(row.directories, MAX_ENTRIES).map(value => {
    const directory = capsuleRecord(value, ['frame','path'])
    return { frame: frame(directory.frame), path: relativePath(directory.path) }
  }), referenceContextFileKey)
  if (!files.some(file => !file.frame.length && file.path === 'descriptor.json' && file.bytes > 0)) return referenceContextInvalid('缺完整父原件descriptor')
  const paths = new Set(files.map(referenceContextFileKey)), dirs = new Set(directories.map(referenceContextFileKey))
  if (directories.some(directory => paths.has(referenceContextFileKey(directory)))) return referenceContextInvalid('同一域的路径不能同时是目录和文件')
  const frames = new Set([...files, ...directories].map(file => capsuleJson(file.frame)))
  const headers = new Set(files.filter(file => file.path === 'descriptor.json' && file.bytes > 0).map(file => capsuleJson(file.frame)))
  for (const domain of frames) if (!headers.has(domain))
    return referenceContextInvalid('复制的原件域缺根descriptor')
  for (const item of [...files, ...directories]) {
    const slash = item.path.lastIndexOf('/')
    if (slash >= 0 && !dirs.has(referenceContextFileKey({ frame: item.frame, path: item.path.slice(0, slash) })))
      return referenceContextInvalid('该原件域闭集缺少父目录')
  }
  return { reference, originalRoot, mountId: durableSqlDagUuid(row.mountId), reader: row.reader, descriptorHash,
    materialHash: durableSqlDagHash(row.materialHash), originalSqlBytes: bytes(row.originalSqlBytes),
    managedOriginalBytes: bytes(row.managedOriginalBytes), files, directories }
}
export function validateCapsule2ReferenceContext(value: unknown): Capsule2ReferenceContextDescriptor {
  const row = capsuleRecord(value, ['kind','version','scope','contextId','source','requirements','parents','acceptedCoverage','effective','permit'])
  if (row.kind !== 'capsule2-original-reference-context' || row.version !== 1 || row.scope !== 'complete-referenced-original-inputs'
    || row.acceptedCoverage !== false || row.effective !== false || row.permit !== false) return referenceContextInvalid('未知上下文格式或越权标记')
  const input = capsuleRecord(row.source, ['operationId','capsuleId','sourceManifestHash','sourceMaterialHash','rawRequirementsHash'])
  const source = { operationId: durableSqlDagUuid(input.operationId), capsuleId: durableSqlDagUuid(input.capsuleId),
    sourceManifestHash: durableSqlDagHash(input.sourceManifestHash), sourceMaterialHash: durableSqlDagHash(input.sourceMaterialHash),
    rawRequirementsHash: durableSqlDagHash(input.rawRequirementsHash) }
  const requirements = validateRawPriorCoverageRequirements(row.requirements), roots = requiredReferenceRoots(requirements)
  if (rawPriorCoverageRequirementsHash(requirements) !== source.rawRequirementsHash) return referenceContextInvalid('原SQL完整requirements hash不相等')
  const parents = ordered(durableSqlDagList(row.parents, DURABLE_SQL_DAG_MAX_PARENTS).map(parent), p => requiredDagRootLocator(p.reference))
  if (capsuleJson(parents.map(p => p.reference)) !== capsuleJson(roots)) return referenceContextInvalid('父原件集合不是完整原SQL引用全集')
  if (new Set(parents.map(p => p.mountId)).size !== parents.length) return referenceContextInvalid('不同原引用不能借用同一物理mount')
  const originalBytes = parents.reduce((n, p) => n + p.originalSqlBytes + p.managedOriginalBytes, 0)
  if (!Number.isSafeInteger(originalBytes) || originalBytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES) return referenceContextInvalid('全部父原件超原DAG预算')
  if (parents.reduce((n, p) => n + p.files.length + p.directories.length, 0) > MAX_ENTRIES) return referenceContextInvalid('完整元数据闭集超预算')
  const result: Capsule2ReferenceContextDescriptor = { kind: row.kind, version: 1, scope: row.scope,
    contextId: durableSqlDagUuid(row.contextId), source, requirements, parents, acceptedCoverage: false, effective: false, permit: false }
  if (Buffer.byteLength(capsuleJson(result)) + 1 > REFERENCE_CONTEXT_MAX_BYTES) return referenceContextInvalid('完整上下文元数据超预算；不能截断')
  return freezeCapsuleValue(result)
}
export function referenceContextMountedRoots(value: Capsule2ReferenceContextDescriptor): readonly CoverageRootReference[] {
  const checked = validateCapsule2ReferenceContext(value)
  return checked.parents.map(parent => validateCoverageRootReference({ ...parent.originalRoot,
    namespace: { kind: 'imported-bundle', mountId: parent.mountId, bundleDescriptorHash: parent.descriptorHash } }))
    .sort((a, b) => compare(requiredDagRootLocator(a), requiredDagRootLocator(b)))
}
export const capsule2ReferenceContextHash = (value: Capsule2ReferenceContextDescriptor): string =>
  capsuleBytesHash('knowbook.capsule2.original-reference-context.v1\0' + capsuleJson(validateCapsule2ReferenceContext(value)))
export function parseCapsule2ReferenceContext(text: string, expectedHash: string): Capsule2ReferenceContextDescriptor {
  const value = validateCapsule2ReferenceContext(parseStrictJson(text, { maxBytes: REFERENCE_CONTEXT_MAX_BYTES, maxDepth: 24 }))
  if (text !== capsuleJson(value) + '\n' || capsule2ReferenceContextHash(value) !== durableSqlDagHash(expectedHash))
    return referenceContextInvalid('上下文不是准确规范原字节或预期hash不等')
  return value
}
