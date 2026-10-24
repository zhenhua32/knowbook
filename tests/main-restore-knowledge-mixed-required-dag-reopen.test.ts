import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile,writeFile,readdir } from 'node:fs/promises'
import { join,basename } from 'node:path'
import { withV3Fixture,mixedPair,captureMixedSource,allTables,randomUUID,readActualFirstRequiredSqlDagMaterial } from './helpers/mixed-required-source-fixture'
import { captureActualFirstRequiredSqlDag,reopenActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { requiredSqlDagRootHash,requiredDagInterpretationHash,validateRequiredSqlDagNode } from '../src/main/database/restore-knowledge-required-dag-model'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { prepareCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { extractCapsule2SourceMaterial } from '../src/main/database/restore-knowledge-capsule2-source-material'
import { sealCapsule2Source } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { certifyCapsule2Source } from '../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { actualHistorySyntax,insertCoverageSyntax } from './helpers/coverage-raw-sql-fixture'

const rootPath=(input:{profileRoot:string;operationId:string;dagId:string})=>join(input.profileRoot,'backups','database-restore',input.operationId,'knowledge-required-dags',input.dagId,'root.json')

test('actual mixed DAG rejects each rehashed reader pin requirements origin and ancestor forgery against the complete actual input map',t=>withV3Fixture(async f=>{
  const pair=await mixedPair(f,[2,2]),saved=await pair.capture(),path=rootPath(saved.reopen),bytes=await readFile(path)
  for(const variant of ['reader-pin','wrong-reader','raw-requirements','imported-reference','nonfirst-parent'] as const)
    await t.test(`actual mixed DAG refuses rehashed ${variant}`,async()=>{
      const node=JSON.parse(bytes.toString())
      if(variant==='reader-pin')node.source.capsule.manifestHash='0'.repeat(64)
      if(variant==='wrong-reader')node.source.capsule.readerVersion='knowbook-durable-sql-v1'
      if(variant==='raw-requirements'){
        node.source.rawRequirementsHash='0'.repeat(64);node.origins.source.rawRequirementsHash='0'.repeat(64)
        node.source.interpretationHash=requiredDagInterpretationHash(node.origins.source)
      }
      if(variant==='imported-reference')node.source.capsule.namespace={kind:'imported-bundle',mountId:randomUUID(),bundleDescriptorHash:'0'.repeat(64)}
      if(variant==='nonfirst-parent'){
        node.origins.source={...node.origins.source,kind:'bound-original-bundle',mountId:randomUUID(),bundleDescriptorHash:'0'.repeat(64)}
        node.source.interpretationHash=requiredDagInterpretationHash(node.origins.source)
        node.source.requiredRoots=[saved.material.root];node.parents=[saved.material.root]
      }
      const validated=validateRequiredSqlDagNode(node),expectedRootHash=requiredSqlDagRootHash(validated)
      try{await writeFile(path,capsuleJson(validated));await assert.rejects(reopenActualFirstRequiredSqlDag({...saved.reopen,expectedRootHash}))}
      finally{await writeFile(path,bytes)}
    })
  assert.deepEqual(await readActualFirstRequiredSqlDagMaterial(saved.handle),saved.material)
}))

test('actual mixed DAG refuses a genuine sealed prior-C source that has no qualified certificate instead of reducing its requirements',()=>withV3Fixture(async f=>{
  const current=await captureMixedSource(f,2)
  insertCoverageSyntax(f.db,actualHistorySyntax(f.db,'2054-03-02T01:02:03.004Z'))
  const original=await captureAssetOriginal(f),source=await sealCapsule2Source(await extractCapsule2SourceMaterial(await prepareCapsule2AssetArchive(original.original)))
  assert.deepEqual(await certifyCapsule2Source(source),{status:'requires-qualified-prior-coverage',requiredRoots:1})
  const before=allTables(f.db)
  await assert.rejects(captureActualFirstRequiredSqlDag({profileRoot:original.info.profileRoot,operationId:basename(original.info.recoveryDirectory),
    dagId:randomUUID(),source:source as never,current:current.handle}))
  assert.deepEqual(allTables(f.db),before)
  assert.equal((await readdir(original.info.recoveryDirectory)).includes('knowledge-required-dags'),false)
}))
