import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile,writeFile,unlink} from 'node:fs/promises'
import {join} from 'node:path'
import {prepareCapsule2AssetArchive,readCapsule2AssetArchive,readCapsule2ArchiveSourceInputs} from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import {captureAssetOriginal} from './helpers/capsule2-assets-fixture'
import {withV3Fixture,addV3Assets,allTables} from './helpers/synced-backup-v3-fixture'

test('source archive paired read binds its actual original and fully rejects late SQL blob and catalog mutations',()=>withV3Fixture(async f=>{
  await addV3Assets(f)
  const beforeTables=allTables(f.db),source=await captureAssetOriginal(f),archive=await prepareCapsule2AssetArchive(source.original)
  const before=await readCapsule2AssetArchive(archive),paired=await readCapsule2ArchiveSourceInputs(archive)
  assert.equal(paired.original,source.original);assert.deepEqual(paired.value,before)
  await assert.rejects(readCapsule2ArchiveSourceInputs({...archive}),/私有句柄/)
  const sql=join(source.info.originalDirectory,'knowbook.db'),blob=join(before.directory,'files',before.manifest.tree.files[0].hash)
  for(const path of [sql,blob]){
    const bytes=await readFile(path),changed=Buffer.from(bytes);assert.ok(changed.length);changed[changed.length-1]^=1
    try{await writeFile(path,changed);await assert.rejects(readCapsule2ArchiveSourceInputs(archive))}
    finally{await writeFile(path,bytes)}
    const restored=await readCapsule2ArchiveSourceInputs(archive);assert.equal(restored.original,source.original);assert.deepEqual(restored.value,before)
  }
  const extra=join(before.directory,'files','unexpected-catalog-item')
  try{await writeFile(extra,'not in the complete archive',{flag:'wx'});await assert.rejects(readCapsule2ArchiveSourceInputs(archive),/闭集/)}
  finally{await unlink(extra)}
  assert.deepEqual((await readCapsule2ArchiveSourceInputs(archive)).value,before)
  assert.deepEqual(allTables(f.db),beforeTables)
}))

test('source archive paired read refuses fake accessor handles without evaluating caller getters',async()=>{
  let getters=0
  const fake=Object.create(null,{kind:{get(){getters++;throw Error('untrusted getter')},enumerable:true}})
  await assert.rejects(readCapsule2ArchiveSourceInputs(fake),/私有句柄/)
  assert.equal(getters,0)
})
