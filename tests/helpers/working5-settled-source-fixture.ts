import assert from 'node:assert/strict'
import { captureSealedCapsule2SourceWithWorkingOriginals5 } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import { withSettledPortable3 } from './settled-portable-owner-fixture'
import { withoutSettledSpoolProbes4 } from './settled-context4-fixture'
import { proveContext4NativeSpoolRoots } from './settled-context4-native-spool-evidence'

type Settled = Parameters<Parameters<typeof withSettledPortable3>[0]>[0]
export async function captureSettledWorkingSource5(saved: Settled) {
  const original=await captureAssetOriginal({userDataRoot:saved.f.B.root,db:saved.f.B.db})
  const roots=await proveContext4NativeSpoolRoots(saved.f.B.root,original.info.profileRoot)
  const spools=saved.jobs.flatMap(value=>roots.spools(value.job.request.operationId,value.job.attemptId).aliases)
  const captured=await withoutSettledSpoolProbes4(spools,async()=>{
    const sealed=await captureSealedCapsule2SourceWithWorkingOriginals5(original.original)
    const working=sealed.working;assert.ok(working)
    return{sealed,working}
  })
  const {sealed,working}=captured.value,value=sealed.value
  assert.equal(value.assetArchive.version,5)
  if(value.assetArchive.version!==5)throw Error('Actual archive5 source required')
  assert.deepEqual(working.manifest.files,[]);assert.deepEqual(working.manifest.captures,[])
  assert.ok(working.manifest.settledBindings.length>0)
  return{saved,original,sealed,source:sealed.source,value,info:sealed.info,working,
    sourceInput:{profileRoot:original.info.profileRoot,operationId:sealed.info.manifest.operationId,capsuleId:sealed.info.manifest.capsuleId,expectedManifestHash:sealed.info.manifestHash},
    spools,spoolProbeAttempts:captured.attempts}
}
export function withSettledWorkingSource5(run:(value:Awaited<ReturnType<typeof captureSettledWorkingSource5>>)=>Promise<void>){
  return withSettledPortable3(async saved=>run(await captureSettledWorkingSource5(saved)))
}
