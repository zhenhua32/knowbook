import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { link, open, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { prepareCapsule2AssetArchive, readCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { extractCapsule2SourceMaterial } from '../src/main/database/restore-knowledge-capsule2-source-material'
import { sealCapsule2Source, readSealedCapsule2Source, readSealedCapsule2SourceMaterial, reopenSealedCapsule2Source,
  diagnoseSealedCapsule2Source } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { capsule2SourceManifestHash } from '../src/main/database/restore-knowledge-capsule2-source-seal-model'
import { readCertifiedDurableSqlCapsule } from '../src/main/database/restore-knowledge-capsule-read'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { restoreInventory } from '../src/main/database/restore-safety-files'
import { withV3Fixture,addV3Assets,allTables,type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { writeMixedOrdinary501 } from './helpers/capsule2-raw-fixture'
import { actualHistorySyntax,insertCoverageSyntax } from './helpers/coverage-raw-sql-fixture'

async function capture(f: V3Fixture) {
  const source = await captureAssetOriginal(f), archive = await prepareCapsule2AssetArchive(source.original), material = await extractCapsule2SourceMaterial(archive)
  const handle = await sealCapsule2Source(material), info = await readSealedCapsule2Source(handle)
  const input = { profileRoot:source.info.profileRoot,operationId:info.manifest.operationId,capsuleId:info.manifest.capsuleId,expectedManifestHash:info.manifestHash }
  return {source,archive,material,handle,info,input}
}

test('capsule2 source seal persists complete actual SQL asset K and unresolved prior-C pins without namespace or installation authority', () => withV3Fixture(async f => {
  await addV3Assets(f);insertCoverageSyntax(f.db,actualHistorySyntax(f.db,'2054-03-02T01:02:03.004Z'));writeMixedOrdinary501(f)
  f.store.saveSetting('source-seal.secret','private source seal credential')
  const before=allTables(f.db),saved=await capture(f),value=await readSealedCapsule2SourceMaterial(saved.handle),manifest=saved.info.manifest
  assert.equal(manifest.version,2);assert.equal(manifest.sourceMaterialHash,value.materialHash)
  assert.equal(manifest.sourceKnowledgeHash,value.knowledge.observationHash);assert.equal(manifest.assetArchiveHash,value.assetArchiveHash)
  assert.equal(manifest.requiredRoots,1);assert.equal(manifest.referenceAuthority,'unresolved-original-references')
  assert.deepEqual(manifest.files,saved.source.inventory)
  assert.deepEqual(await readdir(saved.info.directory),['manifest.json'])
  assert.deepEqual((await readdir(saved.source.info.capsuleDirectory)).sort(),['original','scratch'])
  for(const key of ['certified','semanticValidationComplete','acceptedCoverage','effective','permit'] as const)assert.equal(manifest[key],false)
  assert.equal(Reflect.set(manifest.files,'length',0),false)
  await assert.rejects(readCertifiedDurableSqlCapsule(saved.handle as never),/不是Main认证/)
  await assert.rejects(sealCapsule2Source(saved.material),/已开始|失败|重试/)
  const diagnostic=JSON.stringify(await diagnoseSealedCapsule2Source(saved.handle))
  for(const secret of ['private source seal credential','source-seal.secret','sourceContentHash','sourceKnowledgeHash','profileRoot'])assert.equal(diagnostic.includes(secret),false)
  assert.deepEqual(allTables(f.db),before);assert.deepEqual(await restoreInventory(saved.source.info.originalDirectory),saved.source.inventory)
}))

test('capsule2 sealed source fully rebuilds after live assets disappear and old scratch is poisoned in a real independent process', () => withV3Fixture(async f => {
  await addV3Assets(f);insertCoverageSyntax(f.db,actualHistorySyntax(f.db,'2054-03-02T01:02:03.004Z'));writeMixedOrdinary501(f)
  const detail=f.store.getDocumentDetail(f.targetId)!
  f.store.updateDocument(f.targetId,{title:detail.title,summary:'[missing](<file:///missing-original/sealed-source.png>) [future](<knowbook-asset://future-broken/reference.png>)',blocks:detail.blocks})
  const saved=await capture(f),expected=await readSealedCapsule2SourceMaterial(saved.handle)
  assert.equal(expected.priorCoverageRequirements.entries.length,1);assert.equal(expected.assetArchive.referenceUris.includes('file:///missing-original/sealed-source.png'),true)
  const archive=await readCapsule2AssetArchive(saved.archive)
  for(const alias of archive.manifest.tree.aliases)await unlink(join(f.assets.root,alias.relativePath))
  await writeFile(saved.source.info.databasePath,'old scratch cannot authenticate source')
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',resolve('tests/helpers/capsule2-source-seal-process.cjs'),JSON.stringify(saved.input)],
    {env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,timeout:30_000,maxBuffer:32*1024*1024})
  const actual=JSON.parse(stdout);assert.notEqual(actual.pid,process.pid)
  assert.deepEqual(actual.info,saved.info);assert.deepEqual(actual.value,expected)
  assert.deepEqual(await restoreInventory(saved.source.info.originalDirectory),saved.source.inventory)
}))

test('capsule2 source seal checks every rehashed pin against one immutable original',t=>withV3Fixture(async f=>{
  const saved=await capture(f),path=join(saved.info.directory,'manifest.json'),bytes=await readFile(path)
  for(const key of ['sourceContentHash','workspaceHistoryObservationHash','assetReferencesObservationHash','sourceKnowledgeHash','sourceMaterialHash','assetArchiveHash','sourcePolicyHash','priorRequirementsHash','requiredRoots'] as const)
    await t.test(`capsule2 source seal rejects rehashed ${key} against all actual original inputs`,async()=>{
      assert.deepEqual(await readFile(path),bytes)
      const manifest=JSON.parse(capsuleJson(saved.info.manifest))
      manifest[key]=key==='requiredRoots'?manifest[key]+1:'0'.repeat(64)
      try{
        await writeFile(path,capsuleJson(manifest)+'\n')
        await assert.rejects(reopenSealedCapsule2Source({...saved.input,expectedManifestHash:capsule2SourceManifestHash(manifest)}))
        assert.deepEqual(await restoreInventory(saved.source.info.originalDirectory),saved.source.inventory)
      }finally{await writeFile(path,bytes)}
    })
  assert.deepEqual(await readSealedCapsule2Source(saved.handle),saved.info)
}))

test('capsule2 source seal checks each authority forgery against one immutable original',t=>withV3Fixture(async f=>{
  const saved=await capture(f),path=join(saved.info.directory,'manifest.json'),bytes=await readFile(path)
  for(const variant of ['permission','reference-authority','extra-field','noncanonical'] as const)
    await t.test(`capsule2 source seal refuses ${variant} manifest without granting caller attestation`,async()=>{
      assert.deepEqual(await readFile(path),bytes)
      const manifest=JSON.parse(capsuleJson(saved.info.manifest))
      if(variant==='permission')manifest.permit=true
      if(variant==='reference-authority')manifest.referenceAuthority='native-current'
      if(variant==='extra-field')manifest.callerCertificate=true
      const text=variant==='noncanonical'?JSON.stringify(manifest,null,2)+'\n':capsuleJson(manifest)+'\n'
      try{
        await writeFile(path,text)
        await assert.rejects(reopenSealedCapsule2Source({...saved.input,expectedManifestHash:capsule2SourceManifestHash(manifest)}))
      }finally{await writeFile(path,bytes)}
    })
  assert.deepEqual(await readSealedCapsule2Source(saved.handle),saved.info)
}))

test('capsule2 source seal refuses changed original SQL archived blobs hardlinks and extra directory entries on every use',()=>withV3Fixture(async f=>{
  await addV3Assets(f);const saved=await capture(f),manifest=join(saved.info.directory,'manifest.json'),alias=join(f.root,'source-manifest-alias')
  await link(manifest,alias);await assert.rejects(readSealedCapsule2Source(saved.handle));await unlink(alias)
  const extra=join(saved.info.directory,'extra');await writeFile(extra,'unexpected entry')
  await assert.rejects(readSealedCapsule2SourceMaterial(saved.handle),/闭集/);await unlink(extra)
  const archive=await readCapsule2AssetArchive(saved.archive),blob=join(archive.directory,'files',archive.manifest.tree.files[0].hash),bytes=await readFile(blob)
  await writeFile(blob,'late changed archived bytes');await assert.rejects(readSealedCapsule2Source(saved.handle));await writeFile(blob,bytes)
  await writeFile(join(saved.source.info.originalDirectory,'knowbook.db'),'late original replacement')
  await assert.rejects(readSealedCapsule2SourceMaterial(saved.handle))
}))

test('capsule2 source seal refuses an oversized or invalid UTF8 saved manifest before SQL reopening',()=>withV3Fixture(async f=>{
  const saved=await capture(f),path=join(saved.info.directory,'manifest.json'),fd=await open(path,'w')
  try{await fd.truncate(CAPSULE2_RAW_MAX_JSON_BYTES+1)}finally{await fd.close()}
  await assert.rejects(reopenSealedCapsule2Source(saved.input))
  await writeFile(path,Buffer.from([0xff,0xfe,0x00]));await assert.rejects(reopenSealedCapsule2Source(saved.input))
}))

test('capsule2 source seal rejects forged source and sealed handles without invoking caller getters',async()=>{
  let accessed=false
  const forged=Object.defineProperty({},'kind',{enumerable:true,get:()=>{accessed=true;throw new Error('caller getter')}})
  await assert.rejects(sealCapsule2Source(forged as never),/私有句柄/)
  await assert.rejects(readSealedCapsule2Source(forged as never),/私有来源句柄/)
  await assert.rejects(readSealedCapsule2SourceMaterial(forged as never),/私有来源句柄/)
  assert.equal(accessed,false)
})
