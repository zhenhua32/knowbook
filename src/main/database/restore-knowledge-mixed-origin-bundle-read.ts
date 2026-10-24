import { capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagHash } from './restore-knowledge-dag-model'
import { validateCoverageCapsuleReference, validateCoverageRootReference } from './restore-knowledge-coverage-model'
import { reopenActualFirstRequiredSqlDagWithInitialMaterial, readActualFirstRequiredSqlDagMaterial, type ActualFirstRequiredSqlDag } from './restore-knowledge-mixed-required-dag-read'
import { importMixedOriginBundleOriginal, readMountedMixedOriginBundle, writeMixedOriginBundle, createMixedOriginVerificationProfile } from './restore-knowledge-mixed-origin-bundle-files'
import { originBundleInvalid as bad } from './restore-knowledge-origin-bundle-model'

export interface PreparedMixedOriginBundle { readonly kind:'prepared-mixed-origin-bundle' }
type Mounted=Awaited<ReturnType<typeof readMountedMixedOriginBundle>>
type Material=Awaited<ReturnType<typeof readActualFirstRequiredSqlDagMaterial>>
type Saved=Mounted&{dag:ActualFirstRequiredSqlDag;material:Material;verificationProfile:string}
const bundles=new WeakMap<PreparedMixedOriginBundle,Saved>()
export async function exportPreparedMixedOriginBundle(dag:ActualFirstRequiredSqlDag,input:{operationId:string;bundleId:string}) {
  const row=capsuleRecord(input,['operationId','bundleId']);return writeMixedOriginBundle(dag,row.operationId as string,row.bundleId as string)
}
async function certify(mounted:Mounted) {
  const verificationProfile=await createMixedOriginVerificationProfile(mounted),ref=mounted.original.descriptor.root
  const {dag,value:material}=await reopenActualFirstRequiredSqlDagWithInitialMaterial({profileRoot:verificationProfile,operationId:ref.operationId,dagId:ref.dagId,expectedRootHash:ref.rootHash})
  if(capsuleJson(material.root)!==capsuleJson(ref)||capsuleJson(material.node)!==mounted.original.descriptor.nodeText||material.inputs.length!==2)
    return bad('mixed实际SQL认证根/node/完整input不等于原catalog')
  const last=await readMountedMixedOriginBundle(mounted.profileRoot,mounted.operationId,mounted.mountId,mounted.original.descriptorHash)
  const handle:PreparedMixedOriginBundle=Object.freeze({kind:'prepared-mixed-origin-bundle'})
  const entry={...last,dag,material,verificationProfile};bundles.set(handle,entry)
  return Object.freeze({bundle:handle,value:qualifiedMaterial(entry,material)})
}
/** Initial data comes from this same complete import certification. Later
 * consumption still requires readPreparedMixedOriginBundle's full reread. */
export async function capturePreparedMixedOriginBundle(input:{profileRoot:string;operationId:string;sourceDirectory:string}) {
  const row=capsuleRecord(input,['profileRoot','operationId','sourceDirectory'])
  return certify(await importMixedOriginBundleOriginal(row.profileRoot as string,row.operationId as string,row.sourceDirectory as string))
}
export async function importPreparedMixedOriginBundle(input:Parameters<typeof capturePreparedMixedOriginBundle>[0]) {
  return (await capturePreparedMixedOriginBundle(input)).bundle
}
/** Restart capture returns this same completed certification's initial value.
 * It accepts no old handle; every call creates an independently verified mount
 * profile and runs both real readers before exposing the snapshot. */
export async function captureReopenedPreparedMixedOriginBundle(input:{profileRoot:string;operationId:string;mountId:string;expectedDescriptorHash:string}) {
  const row=capsuleRecord(input,['profileRoot','operationId','mountId','expectedDescriptorHash'])
  return certify(await readMountedMixedOriginBundle(row.profileRoot as string,row.operationId as string,row.mountId as string,durableSqlDagHash(row.expectedDescriptorHash)))
}
export async function reopenPreparedMixedOriginBundle(input:Parameters<typeof captureReopenedPreparedMixedOriginBundle>[0]) {
  return (await captureReopenedPreparedMixedOriginBundle(input)).bundle
}
export async function readPreparedMixedOriginBundle(handle:PreparedMixedOriginBundle) {
  const entry=bundles.get(handle);if(!entry)return bad('不是Main真实mixed bundle私有句柄')
  const before=await readMountedMixedOriginBundle(entry.profileRoot,entry.operationId,entry.mountId,entry.original.descriptorHash)
  const material=await readActualFirstRequiredSqlDagMaterial(entry.dag)
  if(capsuleJson(material)!==capsuleJson(entry.material)||capsuleJson(before.original.descriptor)!==capsuleJson(entry.original.descriptor))return bad('mixed真实material或mounted原catalog变化')
  await readMountedMixedOriginBundle(entry.profileRoot,entry.operationId,entry.mountId,entry.original.descriptorHash)
  return qualifiedMaterial(entry,material)
}
function qualifiedMaterial(entry:Saved,material:Material) {
  const namespace={kind:'imported-bundle' as const,mountId:entry.mountId,bundleDescriptorHash:entry.original.descriptorHash}
  return freezeCapsuleValue({kind:'owned-first-imported-mixed-knowledge-data' as const,version:3 as const,scope:material.scope,
    root:validateCoverageRootReference({...material.root,namespace}),originalRoot:material.root,originalNode:material.node,
    descriptorHash:entry.original.descriptorHash,sourceMaterialHash:material.materialHash,
    inputs:material.inputs.map(input=>({...input,originalCapsule:input.capsule,capsule:validateCoverageCapsuleReference({...input.capsule,namespace})})),
    originalSqlBytes:material.originalSqlBytes,managedOriginalBytes:material.managedOriginalBytes,
    interpretation:'actual-immutable-single-first-mixed-bundle-domain' as const,
    preparedEvidence:true as const,fullRootInputSetProven:true as const,emptyKnowledgeProven:false as const,
    acceptedCoverage:false as const,effective:false as const,permit:false as const})
}
