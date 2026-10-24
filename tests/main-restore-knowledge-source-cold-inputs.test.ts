import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile,writeFile} from 'node:fs/promises'
import {basename,join} from 'node:path'
import {withV3Fixture,addV3Assets,allTables} from './helpers/synced-backup-v3-fixture'
import {captureAssetOriginal} from './helpers/capsule2-assets-fixture'
import {writeMixedOrdinary501} from './helpers/capsule2-raw-fixture'
import {prepareCapsule2AssetArchive} from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import {extractCapsule2SourceMaterial} from '../src/main/database/restore-knowledge-capsule2-source-material'
import {sealCapsule2Source} from '../src/main/database/restore-knowledge-capsule2-source-seal'
import {certifyCapsule2Source,captureReopenedCertifiedCapsule2Source,readCertifiedCapsule2Source,readCertifiedCapsule2SourceMaterial} from '../src/main/database/restore-knowledge-capsule2-source-certificate'

test('cold source inputs retain the complete actual packet and both cold and later reads reject changed originals without caller snapshots',()=>withV3Fixture(async f=>{
  await addV3Assets(f);writeMixedOrdinary501(f)
  const tables=allTables(f.db),original=await captureAssetOriginal(f)
  const archive=await prepareCapsule2AssetArchive(original.original),sealed=await sealCapsule2Source(await extractCapsule2SourceMaterial(archive))
  const result=await certifyCapsule2Source(sealed);assert.equal(result.status,'certified-without-prior-coverage')
  const info=await readCertifiedCapsule2Source(result.source),expected=await readCertifiedCapsule2SourceMaterial(result.source)
  const input={profileRoot:original.info.profileRoot,operationId:basename(original.info.recoveryDirectory),capsuleId:basename(original.info.capsuleDirectory),expectedCertificateHash:info.certificateHash}
  const captured=await captureReopenedCertifiedCapsule2Source(input)
  assert.deepEqual(captured.value,expected);assert.deepEqual(captured.info,info)
  assert.deepEqual(await readCertifiedCapsule2SourceMaterial(captured.source),expected)
  await assert.rejects(captureReopenedCertifiedCapsule2Source({...input,source:captured.source} as typeof input),/字段|闭形|闭合|未知/)
  let getters=0
  const fake=Object.defineProperty({...input},'profileRoot',{get(){getters++;return input.profileRoot}})
  await assert.rejects(captureReopenedCertifiedCapsule2Source(fake));assert.equal(getters,0)
  const path=join(original.info.originalDirectory,'knowbook.db'),bytes=await readFile(path),bad=Buffer.from(bytes);bad[bad.length-1]^=1
  try{
    await writeFile(path,bad)
    await assert.rejects(captureReopenedCertifiedCapsule2Source(input))
    await assert.rejects(readCertifiedCapsule2SourceMaterial(captured.source))
  }finally{await writeFile(path,bytes)}
  assert.deepEqual(await readCertifiedCapsule2SourceMaterial(captured.source),expected)
  assert.deepEqual(allTables(f.db),tables)
}))
