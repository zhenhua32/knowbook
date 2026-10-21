import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue, parseDurableSqlCapsuleManifest, durableSqlCapsuleManifestHash,
  CAPSULE_MAX_MANIFEST_BYTES, CAPSULE_MAX_INDEX_BYTES, type DurableSqlCapsuleManifest } from './restore-knowledge-capsule-model'
import { DURABLE_SQL_DAG_MAX_NODE_BYTES, DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES } from './restore-knowledge-dag-model'
import { validateCoverageRootReference, type CoverageRootReference } from './restore-knowledge-coverage-model'
import { parseRequiredSqlDagNode, requiredDagDatabaseFilesHash, requiredSqlDagRootHash,
  type RequiredSqlDagNode } from './restore-knowledge-required-dag-model'

export const ORIGIN_BUNDLE_MAX_DESCRIPTOR_BYTES = 1024 * 1024
export const ORIGIN_BUNDLE_MAX_FILES = 140
export const ORIGIN_BUNDLE_MAX_BYTES = DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES + 2 * CAPSULE_MAX_INDEX_BYTES
export interface FirstOriginBundleDescriptor {
  readonly kind: 'restore-prepared-first-origin-bundle'; readonly version: 1
  readonly readerVersion: 'knowbook-prepared-origin-bundle-v1'; readonly material: 'durable-sql-only'
  /** These are original relative refs, interpreted inside this descriptor's
   * origin domain. Physical import placement never reinterprets them locally. */
  readonly root: CoverageRootReference; readonly nodeText: string
  readonly sourceManifestText: string; readonly currentManifestText: string
}
export interface OriginBundleFile { readonly path: string; readonly bytes: number; readonly sha256: string }
export function originBundleInvalid(message: string): never { throw new Error('预备origin bundle无效：' + message + '；不授accepted/live/内容安装权。') }
export function originBundleNodePath(ref: CoverageRootReference): string {
  return `catalog/backups/database-restore/${ref.operationId}/knowledge-required-dags/${ref.dagId}/root.json`
}
export function originBundleCapsulePath(operationId: string, capsuleId: string): string {
  return `catalog/backups/database-restore/${operationId}/knowledge-capsules/${capsuleId}`
}
function originalText(value: unknown, max: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max || Buffer.from(value, 'utf8').toString('utf8') !== value)
    return originBundleInvalid('原canonical TEXT无效或超预算')
  return value
}
function components(value: FirstOriginBundleDescriptor): { node: RequiredSqlDagNode; manifests: readonly DurableSqlCapsuleManifest[] } {
  return { node: parseRequiredSqlDagNode(value.nodeText), manifests: [parseDurableSqlCapsuleManifest(value.sourceManifestText), parseDurableSqlCapsuleManifest(value.currentManifestText)] }
}
/** Pure structure only. No DTO can create an owned bundle/SQL certificate. */
export function validateFirstOriginBundleDescriptor(value: unknown): FirstOriginBundleDescriptor {
  const row = capsuleRecord(value, ['kind', 'version', 'readerVersion', 'material', 'root', 'nodeText', 'sourceManifestText', 'currentManifestText'])
  if (row.kind !== 'restore-prepared-first-origin-bundle' || row.version !== 1
    || row.readerVersion !== 'knowbook-prepared-origin-bundle-v1' || row.material !== 'durable-sql-only') return originBundleInvalid('未知descriptor格式')
  const root = validateCoverageRootReference(row.root), nodeText = originalText(row.nodeText, DURABLE_SQL_DAG_MAX_NODE_BYTES)
  const sourceManifestText = originalText(row.sourceManifestText, CAPSULE_MAX_MANIFEST_BYTES), currentManifestText = originalText(row.currentManifestText, CAPSULE_MAX_MANIFEST_BYTES)
  const descriptor: FirstOriginBundleDescriptor = { kind: row.kind, version: 1, readerVersion: row.readerVersion, material: row.material,
    root, nodeText, sourceManifestText, currentManifestText }
  const { node, manifests } = components(descriptor)
  if (root.namespace.kind !== 'native' || root.rootHash !== requiredSqlDagRootHash(node) || node.parents.length
    || node.origins.source.kind !== 'no-prior-coverage-references' || node.origins.current.kind !== 'no-prior-coverage-references')
    return originBundleInvalid('首代只封存完整无prior-C refs图；非空父域需新finite cert2/catalog owner')
  for (const [index, binding] of [node.source, node.current].entries()) {
    const manifest = manifests[index], origin = index === 0 ? node.origins.source : node.origins.current
    if (binding.capsule.namespace.kind !== 'native' || binding.capsule.readerVersion !== 'knowbook-durable-sql-v1'
      || manifest.version !== 1 || manifest.readerVersion !== 'knowbook-durable-sql-v1' || manifest.material !== 'durable-sql-only'
      || binding.capsule.manifestHash !== durableSqlCapsuleManifestHash(manifest))
      return originBundleInvalid('原capsule格式/namespace/manifest hash不闭合')
    if (requiredDagDatabaseFilesHash(manifest.files) !== origin.databaseFilesHash) return originBundleInvalid('原解释域没有绑定准确DB/WAL/SHM清单')
  }
  if (Buffer.byteLength(capsuleJson(descriptor)) > ORIGIN_BUNDLE_MAX_DESCRIPTOR_BYTES) return originBundleInvalid('descriptor超完整预算')
  originBundleExpectedFilesUnchecked(descriptor)
  return freezeCapsuleValue(descriptor)
}
function originBundleExpectedFilesUnchecked(descriptor: FirstOriginBundleDescriptor): readonly OriginBundleFile[] {
  const { node, manifests } = components(descriptor), files: OriginBundleFile[] = []
  const add = (path: string, bytes: number, sha256: string) => files.push({ path, bytes, sha256 })
  add(originBundleNodePath(descriptor.root), Buffer.byteLength(descriptor.nodeText), capsuleBytesHash(descriptor.nodeText))
  for (const [index, binding] of [node.source, node.current].entries()) {
    const base = originBundleCapsulePath(binding.capsule.operationId, binding.capsule.capsuleId), manifest = manifests[index]
    const text = index === 0 ? descriptor.sourceManifestText : descriptor.currentManifestText
    add(base + '/manifest.json', Buffer.byteLength(text), capsuleBytesHash(text))
    for (const file of manifest.files) if (file.present) add(base + '/original/' + file.name, file.bytes, file.sha256!)
    for (const shard of manifest.evidenceIndex.shards) add(base + '/index/' + shard.name, shard.bytes, shard.sha256)
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (files.length > ORIGIN_BUNDLE_MAX_FILES || files.some((file, index) => index > 0 && files[index - 1].path === file.path)
    || !Number.isSafeInteger(files.reduce((sum, file) => sum + file.bytes, 0)) || files.reduce((sum, file) => sum + file.bytes, 0) > ORIGIN_BUNDLE_MAX_BYTES)
    return originBundleInvalid('完整catalog文件重复或超预算，不能截断')
  return freezeCapsuleValue(files)
}
export const originBundleExpectedFiles = (value: FirstOriginBundleDescriptor): readonly OriginBundleFile[] => originBundleExpectedFilesUnchecked(validateFirstOriginBundleDescriptor(value))
export function originBundleExpectedDirectories(value: FirstOriginBundleDescriptor): readonly string[] {
  const descriptor = validateFirstOriginBundleDescriptor(value), files = originBundleExpectedFilesUnchecked(descriptor), dirs = new Set<string>(['catalog'])
  for (const file of files) { const parts = file.path.split('/'); for (let count = 1; count < parts.length; count++) dirs.add(parts.slice(0, count).join('/')) }
  const node = parseRequiredSqlDagNode(descriptor.nodeText)
  for (const binding of [node.source, node.current]) dirs.add(originBundleCapsulePath(binding.capsule.operationId, binding.capsule.capsuleId) + '/index')
  return freezeCapsuleValue([...dirs].sort())
}
export const originBundleDescriptorHash = (value: FirstOriginBundleDescriptor): string => capsuleBytesHash('knowbook.prepared-origin-bundle.v1\0' + capsuleJson(validateFirstOriginBundleDescriptor(value)))
export function parseFirstOriginBundleDescriptor(text: string): FirstOriginBundleDescriptor {
  const descriptor = validateFirstOriginBundleDescriptor(parseStrictJson(text, { maxBytes: ORIGIN_BUNDLE_MAX_DESCRIPTOR_BYTES, maxDepth: 24 }))
  if (capsuleJson(descriptor) !== text) return originBundleInvalid('descriptor不是准确canonical UTF8原文')
  return descriptor
}
