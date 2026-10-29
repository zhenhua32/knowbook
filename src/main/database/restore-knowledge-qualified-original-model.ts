import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_READER } from './restore-knowledge-capsule2-raw-model'
import { parseCapsule2SourceManifest } from './restore-knowledge-capsule2-source-seal-model'
import { parseCapsule2CompleteAssetArchiveManifest } from './restore-knowledge-capsule2-asset-archive'
import { parseCapsule2BoundSourceManifest } from './restore-knowledge-bound-source-model'
import { mixedOriginBundleSideFiles, mixedOriginCapsulePath, type MixedOriginBundleSide } from './restore-knowledge-mixed-origin-bundle-model'
import { originBundleNodePath, type OriginBundleFile } from './restore-knowledge-origin-bundle-model'
import { parseRequiredSqlDagNode, requiredDagDatabaseFilesHash, requiredSqlDagRootHash, type RequiredDagOrigin } from './restore-knowledge-required-dag-model'
import { validateCoverageRootReference, type CoverageInputBinding, type CoverageRootReference } from './restore-knowledge-coverage-model'
import { DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES } from './restore-knowledge-dag-model'
import { parseCapsule2ReferenceContext, referenceContextMountedRoots, referenceContextFileKey,
  REFERENCE_CONTEXT_MAX_BYTES, referenceContextInvalid as bad,
  type Capsule2ReferenceContextDescriptor, type ReferenceContextFile, type ReferenceContextDirectory } from './restore-knowledge-reference-context-model'

export type QualifiedOriginalSide = MixedOriginBundleSide | { readonly kind: 'bound-capsule2'; readonly bindingText: string
  readonly sourceManifestText: string; readonly assetManifestText: string; readonly contextText: string }
export interface QualifiedOriginalDescriptor {
  readonly kind: 'restore-qualified-original-inputs'; readonly version: 1
  readonly root: CoverageRootReference; readonly nodeText: string
  readonly source: QualifiedOriginalSide; readonly current: QualifiedOriginalSide
  readonly acceptedCoverage: false; readonly effective: false; readonly permit: false
}
export function referenceContextCatalogPath(binding: CoverageInputBinding, contextId: string): string {
  return `catalog/backups/database-restore/${binding.capsule.operationId}/knowledge-original-reference-contexts/${contextId}/descriptor.json`
}
const text = (value: unknown): string => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > REFERENCE_CONTEXT_MAX_BYTES || Buffer.from(value).toString() !== value) return bad('完整原件原TEXT超预算或不能无损编码')
  return value
}
export function qualifiedOriginalSide(value: unknown, binding: CoverageInputBinding, origin: RequiredDagOrigin) {
  const kind = value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'kind') : undefined
  if (!kind || !('value' in kind)) return bad('完整side缺少数据kind')
  if (kind.value !== 'bound-capsule2') {
    if (origin.kind !== 'no-prior-coverage-references') return bad('无prior来源不能解释bound origin')
    const side = mixedOriginBundleSideFiles(value as MixedOriginBundleSide, binding)
    if (requiredDagDatabaseFilesHash(side.inventory) !== origin.databaseFilesHash) return bad('实际原SQL清单与origin不同')
    return { value: side.value as QualifiedOriginalSide, files: side.files, emptyDirectory: side.emptyDirectory,
      ...('emptyDirectories' in side && side.emptyDirectories ? { emptyDirectories: side.emptyDirectories } : {}), context: null }
  }
  if (origin.kind !== 'bound-original-bundle' || binding.capsule.readerVersion !== CAPSULE2_READER) return bad('bound来源reader/origin不准确')
  const row = capsuleRecord(value, ['kind','bindingText','sourceManifestText','assetManifestText','contextText']), ref = binding.capsule
  const bindingText = text(row.bindingText), sourceManifestText = text(row.sourceManifestText), assetManifestText = text(row.assetManifestText), contextText = text(row.contextText)
  const bound = parseCapsule2BoundSourceManifest(bindingText, ref.operationId, ref.capsuleId, ref.manifestHash)
  const source = parseCapsule2SourceManifest(sourceManifestText, ref.operationId, ref.capsuleId, bound.sourceManifestHash)
  const archive = parseCapsule2CompleteAssetArchiveManifest(assetManifestText, ref.capsuleId, source.assetArchiveHash)
  const context = parseCapsule2ReferenceContext(contextText, bound.contextHash)
  if (bound.contextId !== context.contextId || origin.mountId !== context.contextId || origin.bundleDescriptorHash !== bound.contextHash
    || bound.rawRequirementsHash !== binding.rawRequirementsHash || bound.rawRequirementsHash !== context.source.rawRequirementsHash
    || bound.sourceManifestHash !== context.source.sourceManifestHash || bound.sourceMaterialHash !== source.sourceMaterialHash
    || bound.sourceMaterialHash !== context.source.sourceMaterialHash || bound.sourceKnowledgeHash !== source.sourceKnowledgeHash
    || context.source.operationId !== ref.operationId || context.source.capsuleId !== ref.capsuleId
    || source.requiredRoots !== bound.requiredCoverageEntries || source.requiredRoots !== context.requirements.entries.length
    || context.parents.length !== bound.referencedRoots || bound.resolvedRootsHash !== capsuleBytesHash(capsuleJson(referenceContextMountedRoots(context)))
    || capsuleJson(binding.requiredRoots) !== capsuleJson(referenceContextMountedRoots(context))
    || requiredDagDatabaseFilesHash(source.files) !== origin.databaseFilesHash || capsuleJson(source.files) !== capsuleJson(archive.sourceInventory)
    || archive.schemaVersion !== source.schemaVersion || archive.sourceContentHash !== source.sourceContentHash
    || archive.workspaceHistoryObservationHash !== source.workspaceHistoryObservationHash || archive.assetReferencesObservationHash !== source.assetReferencesObservationHash)
    return bad('完整bound来源、原SQL清单、context和原始要求不闭合')
  const files: OriginBundleFile[] = [], add = (path: string, value: string) => files.push({ path, bytes: Buffer.byteLength(value), sha256: capsuleBytesHash(value) })
  add(mixedOriginCapsulePath(binding, 'knowledge-reference-inputs-v1') + '/binding.json', bindingText)
  add(mixedOriginCapsulePath(binding, 'knowledge-source-capsules-v2') + '/manifest.json', sourceManifestText)
  add(referenceContextCatalogPath(binding, context.contextId), contextText)
  const assets = mixedOriginCapsulePath(binding, 'knowledge-complete-assets-v2')
  add(assets + '/manifest.json', assetManifestText)
  for (const file of source.files) if (file.present) files.push({ path: mixedOriginCapsulePath(binding, 'knowledge-capsules') + '/original/' + file.name, bytes: file.bytes, sha256: file.sha256! })
  for (const file of archive.tree.files) files.push({ path: assets + '/files/' + file.hash, bytes: file.bytes, sha256: file.hash })
  if (archive.version === 3) for (const file of archive.contextOriginals.files) files.push({ path: assets + '/contexts/' + file.sha256, bytes: file.bytes, sha256: file.sha256 })
  return { value: { kind: 'bound-capsule2', bindingText, sourceManifestText, assetManifestText, contextText } as QualifiedOriginalSide,
    files, emptyDirectory: assets + '/files', ...(archive.version === 3 ? { emptyDirectories: [assets + '/contexts'] } : {}), context }
}
export function validateQualifiedOriginalDescriptor(value: unknown): QualifiedOriginalDescriptor {
  const row = capsuleRecord(value, ['kind','version','root','nodeText','source','current','acceptedCoverage','effective','permit'])
  if (row.kind !== 'restore-qualified-original-inputs' || row.version !== 1 || row.acceptedCoverage !== false || row.effective !== false || row.permit !== false)
    return bad('未知完整qualified原件格式或越权状态')
  const root = validateCoverageRootReference(row.root), nodeText = text(row.nodeText), node = parseRequiredSqlDagNode(nodeText)
  if (root.namespace.kind !== 'native' || root.rootHash !== requiredSqlDagRootHash(node)) return bad('qualified原件根不属于原native node')
  for (const binding of [node.source, node.current]) if (binding.capsule.namespace.kind !== 'native') return bad('本节点来源必须是其独立原始域的实际catalog')
  const source = qualifiedOriginalSide(row.source, node.source, node.origins.source), current = qualifiedOriginalSide(row.current, node.current, node.origins.current)
  const result: QualifiedOriginalDescriptor = { kind: row.kind, version: 1, root, nodeText, source: source.value, current: current.value, acceptedCoverage: false, effective: false, permit: false }
  if (Buffer.byteLength(capsuleJson(result)) + 1 > REFERENCE_CONTEXT_MAX_BYTES) return bad('完整qualified descriptor超预算，不截断')
  return freezeCapsuleValue(result)
}
export function qualifiedOriginalInventory(value: QualifiedOriginalDescriptor): { files: readonly ReferenceContextFile[]; directories: readonly ReferenceContextDirectory[] } {
  const checked = validateQualifiedOriginalDescriptor(value), node = parseRequiredSqlDagNode(checked.nodeText)
  const sides = [qualifiedOriginalSide(checked.source, node.source, node.origins.source), qualifiedOriginalSide(checked.current, node.current, node.origins.current)]
  const own: OriginBundleFile[] = [{ path: originBundleNodePath(checked.root), bytes: Buffer.byteLength(checked.nodeText), sha256: capsuleBytesHash(checked.nodeText) }, ...sides.flatMap(side => side.files)]
  const files: ReferenceContextFile[] = own.map(file => ({ ...file, frame: [] })), dirs = new Set<string>(['catalog'])
  for (const file of own) { const parts = file.path.split('/'); for (let n = 1; n < parts.length; n++) dirs.add(parts.slice(0, n).join('/')) }
  for (const side of sides) dirs.add(side.emptyDirectory)
  for (const side of sides) if ('emptyDirectories' in side) for (const directory of side.emptyDirectories ?? []) dirs.add(directory)
  const directories: ReferenceContextDirectory[] = [...dirs].map(path => ({ frame: [], path }))
  for (const context of sides.map(side => side.context).filter((c): c is Capsule2ReferenceContextDescriptor => !!c))
    for (const parent of context.parents) {
      files.push(...parent.files.map(file => ({ ...file, frame: [context.contextId, parent.mountId, ...file.frame] })))
      directories.push(...parent.directories.map(dir => ({ ...dir, frame: [context.contextId, parent.mountId, ...dir.frame] })))
    }
  for (const items of [files, directories]) {
    items.sort((a, b) => referenceContextFileKey(a) < referenceContextFileKey(b) ? -1 : 1)
    for (let n = 1; n < items.length; n++) if (referenceContextFileKey(items[n - 1]) === referenceContextFileKey(items[n])) return bad('完整qualified逻辑原件域重复')
  }
  const total = files.reduce((n, file) => n + file.bytes, 0)
  if (files.length + directories.length > 1_000_000 || !Number.isSafeInteger(total) || total > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES + 8 * REFERENCE_CONTEXT_MAX_BYTES)
    return bad('完整qualified原件全集超预算')
  return freezeCapsuleValue({ files, directories })
}
export const qualifiedOriginalDescriptorHash = (value: QualifiedOriginalDescriptor): string =>
  capsuleBytesHash('knowbook.qualified-original-inputs.v1\0' + capsuleJson(validateQualifiedOriginalDescriptor(value)))
export function parseQualifiedOriginalDescriptor(text: string, expectedHash?: string): QualifiedOriginalDescriptor {
  const value = validateQualifiedOriginalDescriptor(parseStrictJson(text, { maxBytes: REFERENCE_CONTEXT_MAX_BYTES, maxDepth: 12 }))
  if (text !== capsuleJson(value) + '\n' || expectedHash !== undefined && qualifiedOriginalDescriptorHash(value) !== expectedHash) return bad('qualified原件descriptor不是准确原字节/hash')
  qualifiedOriginalInventory(value)
  return value
}
