import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { certifyDurableSqlCapsuleOriginal } from '../../src/main/database/restore-knowledge-capsule-read'
import { prepareCapsule2AssetArchive, readCapsule2AssetArchive } from '../../src/main/database/restore-knowledge-capsule2-asset-archive'
import { extractCapsule2SourceMaterial } from '../../src/main/database/restore-knowledge-capsule2-source-material'
import { sealCapsule2Source } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { certifyCapsule2Source } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureActualFirstRequiredSqlDag, readActualFirstRequiredSqlDagMaterial, diagnoseActualFirstRequiredSqlDag } from '../../src/main/database/restore-knowledge-mixed-required-dag-read'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import { writeMixedOrdinary501 } from './capsule2-raw-fixture'
import { withV3Fixture, addV3Assets, allTables, type V3Fixture } from './synced-backup-v3-fixture'

export { withV3Fixture, addV3Assets, allTables, randomUUID, readActualFirstRequiredSqlDagMaterial, diagnoseActualFirstRequiredSqlDag }
export async function captureMixedSource(f: V3Fixture, reader: 1 | 2) {
  const original = await captureAssetOriginal(f)
  if (reader === 1) return {reader,original,handle:await certifyDurableSqlCapsuleOriginal(original.original),archive:undefined,managedBytes:0}
  const archive = await prepareCapsule2AssetArchive(original.original),source = await sealCapsule2Source(await extractCapsule2SourceMaterial(archive))
  const result = await certifyCapsule2Source(source);assert.equal(result.status,'certified-without-prior-coverage')
  const data = await readCapsule2AssetArchive(archive)
  return {reader,original,handle:result.source,archive,managedBytes:data.manifest.tree.files.reduce((n,f)=>n+f.bytes,0)}
}
export async function mixedPair(f: V3Fixture, readers: readonly [1|2,1|2]) {
  await addV3Assets(f)
  const sides = [] as Array<Awaited<ReturnType<typeof captureMixedSource>>>
  // Real legacy sources must precede the actual ordinary501 Store edit.
  for(const index of [0,1])if(readers[index]===1)sides[index]=await captureMixedSource(f,1)
  if(readers.includes(2))writeMixedOrdinary501(f)
  for(const index of [0,1])if(readers[index]===2)sides[index]=await captureMixedSource(f,2)
  const input={profileRoot:sides[0].original.info.profileRoot,operationId:basename(sides[0].original.info.recoveryDirectory),
    dagId:randomUUID(),source:sides[0].handle,current:sides[1].handle}
  return {sides,input,async capture(){const handle=await captureActualFirstRequiredSqlDag(input),material=await readActualFirstRequiredSqlDagMaterial(handle)
    return {handle,material,reopen:{profileRoot:input.profileRoot,operationId:material.root.operationId,dagId:material.root.dagId,expectedRootHash:material.root.rootHash}}}}
}
