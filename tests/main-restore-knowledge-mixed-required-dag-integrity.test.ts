import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile,writeFile,readdir,link,unlink } from 'node:fs/promises'
import { join,basename } from 'node:path'
import { withV3Fixture,mixedPair,captureMixedSource,allTables,randomUUID,readActualFirstRequiredSqlDagMaterial,diagnoseActualFirstRequiredSqlDag } from './helpers/mixed-required-source-fixture'
import { captureActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { readCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'

const rootPath=(input:{profileRoot:string;operationId:string;dagId:string})=>join(input.profileRoot,'backups','database-restore',input.operationId,'knowledge-required-dags',input.dagId,'root.json')

test('actual mixed DAG rejects forged copied diagnostic and accessor values without invoking caller getters',()=>withV3Fixture(async f=>{
  const pair=await mixedPair(f,[2,2]);let accessed=false
  const fake=Object.defineProperty({},'kind',{enumerable:true,get(){accessed=true;throw Error('caller getter')}})
  await assert.rejects(captureActualFirstRequiredSqlDag({...pair.input,source:fake as never}))
  const input=Object.defineProperty({...pair.input},'source',{enumerable:true,get(){accessed=true;throw Error('source getter')}})
  await assert.rejects(captureActualFirstRequiredSqlDag(input))
  await assert.rejects(readActualFirstRequiredSqlDagMaterial(fake as never),/不是Main/)
  const saved=await pair.capture()
  await assert.rejects(readActualFirstRequiredSqlDagMaterial(saved.material as never),/不是Main/)
  assert.equal(accessed,false)
}))

test('actual mixed DAG refuses a duplicated side and caller parent subset before writing a root',()=>withV3Fixture(async f=>{
  const pair=await mixedPair(f,[2,2])
  await assert.rejects(captureActualFirstRequiredSqlDag({...pair.input,current:pair.input.source}),/locator重复/)
  await assert.rejects(captureActualFirstRequiredSqlDag({...pair.input,parents:[]} as never))
  assert.equal((await readdir(pair.sides[0].original.info.recoveryDirectory)).includes('knowledge-required-dags'),false)
}))

test('actual mixed DAG cannot borrow a genuine foreign profile source as this Main native catalog',()=>withV3Fixture(async f=>withV3Fixture(async g=>{
  const source=await captureMixedSource(f,2),current=await captureMixedSource(g,2),before=allTables(g.db)
  await assert.rejects(captureActualFirstRequiredSqlDag({profileRoot:source.original.info.profileRoot,
    operationId:basename(source.original.info.recoveryDirectory),dagId:randomUUID(),source:source.handle,current:current.handle}),/不在该Main固定目录/)
  assert.deepEqual(allTables(g.db),before)
  assert.equal((await readdir(source.original.info.recoveryDirectory)).includes('knowledge-required-dags'),false)
})))

test('actual mixed DAG rereads root closure hardlink identity archived blobs and original SQL on every material consume',()=>withV3Fixture(async f=>{
  const pair=await mixedPair(f,[2,2]),saved=await pair.capture(),path=rootPath(saved.reopen),extra=join(path,'..','extra'),alias=join(f.root,'root-alias')
  await writeFile(extra,'unexpected');await assert.rejects(readActualFirstRequiredSqlDagMaterial(saved.handle));await unlink(extra)
  await link(path,alias);await assert.rejects(diagnoseActualFirstRequiredSqlDag(saved.handle));await unlink(alias)
  const archive=await readCapsule2AssetArchive(pair.sides[0].archive!),blob=join(archive.directory,'files',archive.manifest.tree.files[0].hash),bytes=await readFile(blob)
  await writeFile(blob,'late archived blob change');await assert.rejects(readActualFirstRequiredSqlDagMaterial(saved.handle));await writeFile(blob,bytes)
  assert.deepEqual(await readActualFirstRequiredSqlDagMaterial(saved.handle),saved.material)
  await writeFile(join(pair.sides[1].original.info.originalDirectory,'knowbook.db'),'late original SQL change')
  await assert.rejects(diagnoseActualFirstRequiredSqlDag(saved.handle))
}))
