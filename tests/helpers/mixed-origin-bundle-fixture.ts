import { randomUUID } from 'node:crypto'
import { mixedPair, allTables } from './mixed-required-source-fixture'
import { withV3Fixture } from './synced-backup-v3-fixture'
import { exportPreparedMixedOriginBundle, capturePreparedMixedOriginBundle, readPreparedMixedOriginBundle } from '../../src/main/database/restore-knowledge-mixed-origin-bundle-read'
export { randomUUID, allTables, readPreparedMixedOriginBundle }
export async function withMixedBundleFixture(readers:readonly [1|2,1|2],run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>) {
  await withV3Fixture(source=>withV3Fixture(async receiver=>{await run(await setup(source,receiver,readers))}))
}
async function setup(source:Parameters<typeof mixedPair>[0],receiver:Parameters<typeof mixedPair>[0],readers:readonly [1|2,1|2]) {
  const pair=await mixedPair(source,readers),captured=await pair.capture(),beforeSource=allTables(source.db),beforeReceiver=allTables(receiver.db)
  const exported=await exportPreparedMixedOriginBundle(captured.handle,{operationId:randomUUID(),bundleId:randomUUID()})
  const input={profileRoot:receiver.userDataRoot,operationId:randomUUID(),sourceDirectory:exported.directory}
  const {bundle:handle,value}=await capturePreparedMixedOriginBundle(input)
  if(value.root.namespace.kind!=='imported-bundle')throw Error('Actual mounted root is required')
  const reopen={profileRoot:receiver.userDataRoot,operationId:input.operationId,mountId:value.root.namespace.mountId,expectedDescriptorHash:value.descriptorHash}
  return {source,receiver,pair,captured,beforeSource,beforeReceiver,exported,input,handle,value,reopen}
}
