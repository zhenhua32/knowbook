import { join, relative, sep } from 'node:path'
import { capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { captureCertifiedCapsulePriorCoverage, readCertifiedCapsulePriorCoverage, readCertifiedDurableSqlCapsule,
  extractCertifiedDurableSqlCapsuleKnowledge, readCertifiedCapsuleKnowledge, reopenCertifiedDurableSqlCapsule,
  type CertifiedDurableSqlCapsule } from './restore-knowledge-capsule-read'
import { tryReadCertifiedCapsule2SourceInputs, reopenCertifiedCapsule2Source,
  type CertifiedCapsule2NoPriorSource } from './restore-knowledge-capsule2-source-certificate'
import { rawPriorCoverageRequirementsHash, validateCoverageCapsuleReference, validateCoverageRootReference,
  type CoverageInputBinding } from './restore-knowledge-coverage-model'
import { canonicalRequiredSqlDagRoot, readRequiredSqlDagNodeFile, writeRequiredSqlDagNodeFile,
  type RequiredSqlDagNodeFile } from './restore-knowledge-required-dag-files'
import { requiredDagCapsuleLocator, requiredDagDatabaseFilesHash, requiredDagInterpretationHash, requiredDagInvalid as bad,
  validateRequiredSqlDagNode, type RequiredDagNoPriorOrigin } from './restore-knowledge-required-dag-model'
import { DURABLE_SQL_DAG_MAX_CAPSULES, DURABLE_SQL_DAG_MAX_NODES, DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES,
  DURABLE_SQL_DAG_MAX_TOTAL_NODE_BYTES } from './restore-knowledge-dag-model'
import { knowledgeHash, knowledgePayloadHash } from './restore-knowledge-payload-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_READER } from './restore-knowledge-capsule2-raw-model'

type Source = CertifiedDurableSqlCapsule | CertifiedCapsule2NoPriorSource
export interface ActualFirstRequiredSqlDag { readonly kind: 'actual-first-mixed-required-sql-dag' }
type Input = Awaited<ReturnType<typeof readInput>>
type Saved = { profileRoot: string; file: RequiredSqlDagNodeFile; inputs: readonly [Input,Input] }
const dags = new WeakMap<ActualFirstRequiredSqlDag,Saved>()
function fixedPath(profile: string, path: string, collection: string, leaf: string, operationId: string, capsuleId: string) {
  const parts = relative(profile,path).split(sep)
  if (parts.length !== 6 || parts[0] !== 'backups' || parts[1] !== 'database-restore' || parts[2] !== operationId
    || parts[3] !== collection || parts[4] !== capsuleId || parts[5] !== leaf) return bad('原件不在该Main固定目录；不借foreign同UUID路径')
}
async function readInput(profile: string, source: Source) {
  const second = await tryReadCertifiedCapsule2SourceInputs(source)
  if (second) {
    const { info, value } = second, c = info.certificate
    fixedPath(profile,join(info.directory,'certificate.json'),'knowledge-source-certificates-v2','certificate.json',c.operationId,c.capsuleId)
    if (value.priorCoverageRequirements.entries.length || c.requiredRoots !== 0) return bad('真实capsule2 prior-C未解决，不能降empty')
    const rawRequirementsHash = rawPriorCoverageRequirementsHash(value.priorCoverageRequirements)
    const origin: RequiredDagNoPriorOrigin = { kind:'no-prior-coverage-references',version:1,
      databaseFilesHash:requiredDagDatabaseFilesHash(value.sourceInventory),rawRequirementsHash }
    const capsule = validateCoverageCapsuleReference({kind:'restore-knowledge-origin-capsule-ref',version:1,namespace:{kind:'native'},
      operationId:c.operationId,capsuleId:c.capsuleId,manifestHash:info.certificateHash,readerVersion:c.readerVersion})
    const binding: CoverageInputBinding = {capsule,interpretationHash:requiredDagInterpretationHash(origin),rawRequirementsHash,requiredRoots:[]}
    return { source,binding,origin,originalSqlBytes:value.sourceInventory.reduce((n,f)=>n+f.bytes,0),
      managedOriginalBytes:value.assetArchive.tree.files.reduce((n,f)=>n+f.bytes,0),knowledge:{readerVersion:c.readerVersion,
        projection:value.knowledge,projectionHash:value.knowledge.observationHash,sourceMaterialHash:value.materialHash,assetArchiveHash:value.assetArchiveHash} }
  }
  // Unknown/fake handles reach the original v1 private registry and fail there.
  const legacy = source as CertifiedDurableSqlCapsule, seal = await readCertifiedDurableSqlCapsule(legacy)
  const captured = await captureCertifiedCapsulePriorCoverage(legacy), value = await readCertifiedCapsulePriorCoverage(captured)
  fixedPath(profile,seal.manifestPath,'knowledge-capsules','manifest.json',value.capsule.operationId,value.capsule.capsuleId)
  if (value.requirements.entries.length) return bad('真实v1 prior-C未解决，不能降empty')
  const projection = await readCertifiedCapsuleKnowledge(await extractCertifiedDurableSqlCapsuleKnowledge(legacy))
  const origin: RequiredDagNoPriorOrigin = {kind:'no-prior-coverage-references',version:1,
    databaseFilesHash:requiredDagDatabaseFilesHash(value.originalFiles),rawRequirementsHash:value.rawRequirementsHash}
  const capsule = validateCoverageCapsuleReference({kind:'restore-knowledge-origin-capsule-ref',version:1,namespace:{kind:'native'},...value.capsule})
  const binding: CoverageInputBinding = {capsule,interpretationHash:requiredDagInterpretationHash(origin),rawRequirementsHash:value.rawRequirementsHash,requiredRoots:[]}
  return {source,binding,origin,originalSqlBytes:value.originalFiles.reduce((n,f)=>n+f.bytes,0),managedOriginalBytes:0,
    knowledge:{readerVersion:value.capsule.readerVersion,projection,projectionHash:knowledgePayloadHash(projection),sourceMaterialHash:null,assetArchiveHash:null}}
}
function nodeFor(inputs: readonly [Input,Input]) {
  return validateRequiredSqlDagNode({kind:'restore-required-sql-knowledge-dag-node',version:2,readerVersion:'knowbook-required-sql-knowledge-dag-v2',
    material:'durable-sql-only',source:inputs[0].binding,current:inputs[1].binding,origins:{source:inputs[0].origin,current:inputs[1].origin},parents:[]})
}
function totals(inputs: readonly [Input,Input]) {
  if (DURABLE_SQL_DAG_MAX_CAPSULES < 2 || requiredDagCapsuleLocator(inputs[0].binding) === requiredDagCapsuleLocator(inputs[1].binding))
    return bad('两侧实际原件locator重复或超预算，不能复用一侧冒充另一侧')
  const originalSqlBytes=inputs.reduce((n,i)=>n+i.originalSqlBytes,0),managedOriginalBytes=inputs.reduce((n,i)=>n+i.managedOriginalBytes,0)
  const totalOriginalBytes=originalSqlBytes+managedOriginalBytes
  if (!Number.isSafeInteger(totalOriginalBytes) || totalOriginalBytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES) return bad('完整SQL和附件原件超原DAG预算，不截断')
  return {originalSqlBytes,managedOriginalBytes,totalOriginalBytes}
}
async function pair(profile: string, source: Source, current: Source): Promise<readonly [Input,Input]> {
  const results=await Promise.allSettled([readInput(profile,source),readInput(profile,current)])
  if(results[0].status==='rejected')throw results[0].reason
  if(results[1].status==='rejected')throw results[1].reason
  return [results[0].value,results[1].value]
}
function commitment(input: Input) {
  return {binding:input.binding,origin:input.origin,originalSqlBytes:input.originalSqlBytes,managedOriginalBytes:input.managedOriginalBytes,
    readerVersion:input.knowledge.readerVersion,projectionHash:input.knowledge.projectionHash,
    sourceMaterialHash:input.knowledge.sourceMaterialHash,assetArchiveHash:input.knowledge.assetArchiveHash}
}
async function fresh(entry: Saved) {
  const first=await readRequiredSqlDagNodeFile(entry.profileRoot,entry.file.ref)
  if(capsuleJson(first.node)!==capsuleJson(entry.file.node))return bad('实际node被替换')
  const inputs=await pair(entry.profileRoot,entry.inputs[0].source,entry.inputs[1].source)
  if(capsuleJson(inputs.map(commitment))!==capsuleJson(entry.inputs.map(commitment))
    || capsuleJson(nodeFor(inputs))!==capsuleJson(entry.file.node))return bad('完整实际两侧原件/要求/K/附件变化')
  totals(inputs)
  const last=await readRequiredSqlDagNodeFile(entry.profileRoot,entry.file.ref)
  if(capsuleJson(last.node)!==capsuleJson(first.node))return bad('重读原件期间node变化')
  return inputs
}
function mint(entry: Saved): ActualFirstRequiredSqlDag {
  if(DURABLE_SQL_DAG_MAX_NODES<1||entry.file.bytes>DURABLE_SQL_DAG_MAX_TOTAL_NODE_BYTES)return bad('实际首代node超原预算')
  const handle:ActualFirstRequiredSqlDag=Object.freeze({kind:'actual-first-mixed-required-sql-dag'})
  dags.set(handle,entry);return handle
}
/** A fixed genuine source/current pair. Native refs name this newly written
 * physical catalog; zero prior refs never infer the SQL's original domain. */
export async function captureActualFirstRequiredSqlDag(input: {profileRoot:string;operationId:string;dagId:string;source:Source;current:Source}): Promise<ActualFirstRequiredSqlDag> {
  const row=capsuleRecord(input,['profileRoot','operationId','dagId','source','current']),profileRoot=await canonicalRequiredSqlDagRoot(row.profileRoot)
  const inputs=await pair(profileRoot,row.source as Source,row.current as Source);totals(inputs)
  const file=await writeRequiredSqlDagNodeFile(profileRoot,row.operationId as string,row.dagId as string,nodeFor(inputs))
  const entry:Saved={profileRoot,file,inputs};await fresh(entry);return mint(entry)
}
export async function reopenActualFirstRequiredSqlDag(input: {profileRoot:string;operationId:string;dagId:string;expectedRootHash:string}): Promise<ActualFirstRequiredSqlDag> {
  const row=capsuleRecord(input,['profileRoot','operationId','dagId','expectedRootHash']),profileRoot=await canonicalRequiredSqlDagRoot(row.profileRoot)
  const ref=validateCoverageRootReference({kind:'restore-knowledge-origin-root-ref',version:1,namespace:{kind:'native'},operationId:row.operationId,
    dagId:row.dagId,rootHash:row.expectedRootHash,readerVersion:'knowbook-required-sql-knowledge-dag-v2'})
  const file=await readRequiredSqlDagNodeFile(profileRoot,ref),node=file.node
  if(node.parents.length||node.origins.source.kind!=='no-prior-coverage-references'||node.origins.current.kind!=='no-prior-coverage-references')
    return bad('完整非首代prior根仍须实际origin/catalog owner，不降empty')
  const reopen=async(binding:CoverageInputBinding):Promise<Source>=>{
    const c=binding.capsule
    if(c.namespace.kind!=='native')return bad('不将imported域当成本机同UUID原件')
    if(c.readerVersion==='knowbook-durable-sql-v1')
      return reopenCertifiedDurableSqlCapsule({profileRoot,operationId:c.operationId,capsuleId:c.capsuleId,expectedManifestHash:c.manifestHash})
    if(c.readerVersion===CAPSULE2_READER)
      return reopenCertifiedCapsule2Source({profileRoot,operationId:c.operationId,capsuleId:c.capsuleId,expectedCertificateHash:c.manifestHash})
    return bad('未知实际capsule reader，不降级或猜格式')
  }
  const results=await Promise.allSettled([reopen(node.source),reopen(node.current)])
  if(results[0].status==='rejected')throw results[0].reason
  if(results[1].status==='rejected')throw results[1].reason
  const inputs=await pair(profileRoot,results[0].value,results[1].value)
  if(capsuleJson(nodeFor(inputs))!==capsuleJson(node))return bad('真实两侧重建不等于完整持久node')
  totals(inputs);const entry:Saved={profileRoot,file,inputs};await fresh(entry);return mint(entry)
}
/** Complete Main-private K3 input material. Each row reference remains inside
 * its reader-qualified original envelope; no v2 source is relabeled as K1. */
export async function readActualFirstRequiredSqlDagMaterial(handle: ActualFirstRequiredSqlDag) {
  const entry=dags.get(handle);if(!entry)return bad('不是Main真实混合DAG私有句柄')
  const actual=await fresh(entry),inputs=actual.map(input=>({capsule:input.binding.capsule,binding:input.binding,origin:input.origin,knowledge:input.knowledge}))
    .sort((a,b)=>requiredDagCapsuleLocator(a.binding)<requiredDagCapsuleLocator(b.binding)?-1:1)
  const body={kind:'actual-required-root-source-material' as const,version:3 as const,scope:'exact-first-generation-original-input-pair' as const,
    root:entry.file.ref,node:entry.file.node,inputs,...totals(actual),preparedEvidence:true as const,fullRootInputSetProven:true as const,
    emptyKnowledgeProven:false as const,acceptedCoverage:false as const,effective:false as const,permit:false as const}
  const encoded=capsuleJson(body)
  if(Buffer.byteLength(encoded)>CAPSULE2_RAW_MAX_JSON_BYTES)return bad('完整混合K3材料超有限预算，不截断')
  return freezeCapsuleValue({...body,materialHash:knowledgeHash('knowbook.knowledge.actual-required-root-material.v3',body)})
}
export async function diagnoseActualFirstRequiredSqlDag(handle: ActualFirstRequiredSqlDag) {
  const value=await readActualFirstRequiredSqlDagMaterial(handle)
  return freezeCapsuleValue({kind:'actual-first-required-sql-dag-summary' as const,root:value.root,materialHash:value.materialHash,
    readers:value.inputs.map(i=>i.knowledge.readerVersion),inputs:value.inputs.length,groups:value.inputs.map(i=>i.knowledge.projection.groups.length),
    originalSqlBytes:value.originalSqlBytes,managedOriginalBytes:value.managedOriginalBytes,fullRootInputSetProven:true as const,
    scope:value.scope,emptyKnowledgeProven:false as const,acceptedCoverage:false as const,effective:false as const,permit:false as const})
}
