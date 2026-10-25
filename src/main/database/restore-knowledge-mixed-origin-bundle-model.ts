import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue, parseDurableSqlCapsuleManifest,
  durableSqlCapsuleManifestHash, CAPSULE_MAX_MANIFEST_BYTES, CAPSULE_MAX_INDEX_BYTES } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_READER } from './restore-knowledge-capsule2-raw-model'
import { parseCapsule2NoPriorSourceCertificate, CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES } from './restore-knowledge-capsule2-source-certificate-model'
import { parseCapsule2SourceManifest } from './restore-knowledge-capsule2-source-seal-model'
import { parseCapsule2CompleteAssetArchiveManifest } from './restore-knowledge-capsule2-asset-archive'
import { validateCoverageRootReference, type CoverageInputBinding, type CoverageRootReference } from './restore-knowledge-coverage-model'
import { parseRequiredSqlDagNode, requiredSqlDagRootHash, requiredDagDatabaseFilesHash } from './restore-knowledge-required-dag-model'
import { DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES, DURABLE_SQL_DAG_MAX_NODE_BYTES } from './restore-knowledge-dag-model'
import { originBundleInvalid as bad, originBundleNodePath, ORIGIN_BUNDLE_MAX_FILES, type OriginBundleFile } from './restore-knowledge-origin-bundle-model'

export type MixedOriginBundleSide = { readonly kind: 'durable-sql-v1'; readonly manifestText: string } | {
  readonly kind: 'complete-capsule2'; readonly certificateText: string; readonly sourceManifestText: string; readonly assetManifestText: string
}
export interface MixedOriginBundleDescriptor {
  readonly kind: 'restore-prepared-mixed-origin-bundle'; readonly version: 2
  readonly readerVersion: 'knowbook-prepared-mixed-origin-bundle-v2'; readonly material: 'mixed-original-readers'
  readonly root: CoverageRootReference; readonly nodeText: string
  readonly source: MixedOriginBundleSide; readonly current: MixedOriginBundleSide
}
export const MIXED_ORIGIN_BUNDLE_MAX_DESCRIPTOR_BYTES = CAPSULE2_RAW_MAX_JSON_BYTES
export const MIXED_ORIGIN_BUNDLE_MAX_FILES = ORIGIN_BUNDLE_MAX_FILES + 10_000
const metadataBudget = 6 * CAPSULE2_RAW_MAX_JSON_BYTES + 2 * CAPSULE_MAX_INDEX_BYTES + DURABLE_SQL_DAG_MAX_NODE_BYTES
function text(value: unknown, max = CAPSULE2_RAW_MAX_JSON_BYTES): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || Buffer.from(value).toString('utf8') !== value) return bad('mixed原TEXT无效或超完整预算')
  return value
}
export function mixedOriginCapsulePath(binding: CoverageInputBinding, collection: string) {
  return `catalog/backups/database-restore/${binding.capsule.operationId}/${collection}/${binding.capsule.capsuleId}`
}
function side(value: unknown, binding: CoverageInputBinding) {
  if (!value || typeof value !== 'object') return bad('mixed缺原side')
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')
  if (!kind || !('value' in kind)) return bad('mixed side kind含accessor')
  const ref = binding.capsule, files: OriginBundleFile[] = []
  const add = (path: string, source: string) => files.push({ path, bytes: Buffer.byteLength(source), sha256: capsuleBytesHash(source) })
  const base = mixedOriginCapsulePath(binding, 'knowledge-capsules')
  if (kind.value === 'durable-sql-v1') {
    const row = capsuleRecord(value, ['kind','manifestText']), manifestText = text(row.manifestText, CAPSULE_MAX_MANIFEST_BYTES)
    const manifest = parseDurableSqlCapsuleManifest(manifestText)
    if (ref.readerVersion !== 'knowbook-durable-sql-v1'
      || durableSqlCapsuleManifestHash(manifest) !== ref.manifestHash) return bad('mixed v1原reader/hash不闭合')
    add(base + '/manifest.json', manifestText)
    for (const file of manifest.files) if (file.present) files.push({ path: base+'/original/'+file.name, bytes:file.bytes, sha256:file.sha256! })
    for (const shard of manifest.evidenceIndex.shards) files.push({ path:base+'/index/'+shard.name, bytes:shard.bytes, sha256:shard.sha256 })
    return { value:{kind:'durable-sql-v1',manifestText} as const, files, inventory:manifest.files, emptyDirectory:base+'/index' }
  }
  if (kind.value !== 'complete-capsule2' || ref.readerVersion !== CAPSULE2_READER) return bad('mixed未知side/reader，不降级')
  const row = capsuleRecord(value, ['kind','certificateText','sourceManifestText','assetManifestText'])
  const certificateText=text(row.certificateText,CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES), sourceManifestText=text(row.sourceManifestText), assetManifestText=text(row.assetManifestText)
  const certificate=parseCapsule2NoPriorSourceCertificate(certificateText,ref.operationId,ref.capsuleId,ref.manifestHash)
  const manifest=parseCapsule2SourceManifest(sourceManifestText,ref.operationId,ref.capsuleId,certificate.sourceManifestHash)
  const archive=parseCapsule2CompleteAssetArchiveManifest(assetManifestText,ref.capsuleId,manifest.assetArchiveHash)
  if (manifest.requiredRoots!==0 || certificate.schemaVersion!==manifest.schemaVersion || archive.schemaVersion!==manifest.schemaVersion
    || certificate.sourceMaterialHash!==manifest.sourceMaterialHash || certificate.sourceKnowledgeHash!==manifest.sourceKnowledgeHash
    || capsuleJson(manifest.files)!==capsuleJson(archive.sourceInventory)
    || archive.sourceContentHash!==manifest.sourceContentHash || archive.workspaceHistoryObservationHash!==manifest.workspaceHistoryObservationHash
    || archive.assetReferencesObservationHash!==manifest.assetReferencesObservationHash) return bad('mixed capsule2完整原清单绑定不闭合')
  add(mixedOriginCapsulePath(binding,'knowledge-source-certificates-v2')+'/certificate.json',certificateText)
  add(mixedOriginCapsulePath(binding,'knowledge-source-capsules-v2')+'/manifest.json',sourceManifestText)
  const assets=mixedOriginCapsulePath(binding,'knowledge-complete-assets-v2');add(assets+'/manifest.json',assetManifestText)
  for (const file of manifest.files) if(file.present) files.push({path:base+'/original/'+file.name,bytes:file.bytes,sha256:file.sha256!})
  for (const file of archive.tree.files) files.push({path:assets+'/files/'+file.hash,bytes:file.bytes,sha256:file.hash})
  return { value:{kind:'complete-capsule2',certificateText,sourceManifestText,assetManifestText} as const, files, inventory:manifest.files, emptyDirectory:assets+'/files' }
}
function components(value: MixedOriginBundleDescriptor) {
  const node=parseRequiredSqlDagNode(value.nodeText),source=side(value.source,node.source),current=side(value.current,node.current)
  return {node,source,current}
}
export function validateMixedOriginBundleDescriptor(value: unknown): MixedOriginBundleDescriptor {
  const row=capsuleRecord(value,['kind','version','readerVersion','material','root','nodeText','source','current'])
  if(row.kind!=='restore-prepared-mixed-origin-bundle'||row.version!==2||row.readerVersion!=='knowbook-prepared-mixed-origin-bundle-v2'
    ||row.material!=='mixed-original-readers')return bad('未知mixed catalog格式')
  const root=validateCoverageRootReference(row.root),nodeText=text(row.nodeText,DURABLE_SQL_DAG_MAX_NODE_BYTES),node=parseRequiredSqlDagNode(nodeText)
  if(root.namespace.kind!=='native'||root.rootHash!==requiredSqlDagRootHash(node)||node.parents.length
    ||node.origins.source.kind!=='no-prior-coverage-references'||node.origins.current.kind!=='no-prior-coverage-references'
    ||node.source.capsule.namespace.kind!=='native'||node.current.capsule.namespace.kind!=='native')return bad('mixed首代完整原域/无prior-C图不闭合')
  const source=side(row.source,node.source),current=side(row.current,node.current)
  if(requiredDagDatabaseFilesHash(source.inventory)!==node.origins.source.databaseFilesHash
    ||requiredDagDatabaseFilesHash(current.inventory)!==node.origins.current.databaseFilesHash)return bad('mixed原SQL清单与node不一致')
  const descriptor:MixedOriginBundleDescriptor={kind:row.kind,version:2,readerVersion:row.readerVersion,material:row.material,root,nodeText,source:source.value,current:current.value}
  if(Buffer.byteLength(capsuleJson(descriptor))+1>MIXED_ORIGIN_BUNDLE_MAX_DESCRIPTOR_BYTES)return bad('mixed完整descriptor超预算，不截断')
  expectedFiles(descriptor);return freezeCapsuleValue(descriptor)
}
function expectedFiles(descriptor: MixedOriginBundleDescriptor) {
  const {source,current}=components(descriptor),files=[{path:originBundleNodePath(descriptor.root),bytes:Buffer.byteLength(descriptor.nodeText),sha256:capsuleBytesHash(descriptor.nodeText)},...source.files,...current.files]
    .sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
  const data=files.filter(f=>/\/(?:original|files)\//.test(f.path)).reduce((n,f)=>n+f.bytes,0),total=files.reduce((n,f)=>n+f.bytes,0)
  if(files.length>MIXED_ORIGIN_BUNDLE_MAX_FILES||files.some((f,i)=>i>0&&files[i-1].path===f.path)
    ||!Number.isSafeInteger(total)||data>DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES||total-data>metadataBudget)return bad('mixed完整文件重复或超原件/metadata预算')
  return freezeCapsuleValue(files)
}
export const mixedOriginBundleFiles=(value:MixedOriginBundleDescriptor)=>expectedFiles(validateMixedOriginBundleDescriptor(value))
export function mixedOriginBundleDirectories(value:MixedOriginBundleDescriptor) {
  const descriptor=validateMixedOriginBundleDescriptor(value),dirs=new Set<string>(['catalog'])
  for(const file of expectedFiles(descriptor)){const parts=file.path.split('/');for(let n=1;n<parts.length;n++)dirs.add(parts.slice(0,n).join('/'))}
  const {source,current}=components(descriptor);dirs.add(source.emptyDirectory);dirs.add(current.emptyDirectory)
  return freezeCapsuleValue([...dirs].sort())
}
export const mixedOriginBundleHash=(value:MixedOriginBundleDescriptor)=>capsuleBytesHash('knowbook.prepared-mixed-origin-bundle.v2\0'+capsuleJson(validateMixedOriginBundleDescriptor(value)))
export function parseMixedOriginBundleDescriptor(text:string) {
  const value=validateMixedOriginBundleDescriptor(parseStrictJson(text,{maxBytes:MIXED_ORIGIN_BUNDLE_MAX_DESCRIPTOR_BYTES,maxDepth:24}))
  if(text!==capsuleJson(value)+'\n')return bad('mixed descriptor不是准确canonical原字节')
  return value
}

/** Fixed legacy side codec shared by the complete qualified-input transport.
 * This is data validation only; private SQL owners still authenticate sources. */
export function mixedOriginBundleSideFiles(value: MixedOriginBundleSide, binding: CoverageInputBinding) {
  return freezeCapsuleValue(side(value, binding))
}
