import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withMixedBundleFixture,allTables } from './helpers/mixed-origin-bundle-fixture'
import { importPreparedMixedOriginBundle,readPreparedMixedOriginBundle,exportPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { readMixedOriginBundleOriginal } from '../src/main/database/restore-knowledge-mixed-origin-bundle-files'
import { mixedOriginBundleHash,validateMixedOriginBundleDescriptor,mixedOriginCapsulePath } from '../src/main/database/restore-knowledge-mixed-origin-bundle-model'
import { capsule2SourceManifestHash } from '../src/main/database/restore-knowledge-capsule2-source-seal-model'
import { capsule2NoPriorSourceCertificateHash } from '../src/main/database/restore-knowledge-capsule2-source-certificate-model'
import { requiredSqlDagRootHash } from '../src/main/database/restore-knowledge-required-dag-model'
import { capsuleJson,capsuleBytesHash } from '../src/main/database/restore-knowledge-capsule-model'
import { randomUUID } from 'node:crypto'

test('mixed origin opaque owners reject fake accessor handles and caller selectors before reading their getters',async()=>{
  let getters=0
  const fake=Object.defineProperty({},'kind',{get(){getters++;throw Error('Caller getter ran')}})
  await assert.rejects(exportPreparedMixedOriginBundle(fake as Parameters<typeof exportPreparedMixedOriginBundle>[0],{operationId:randomUUID(),bundleId:randomUUID()}),/真实mixed|私有/)
  await assert.rejects(readPreparedMixedOriginBundle(fake as Parameters<typeof readPreparedMixedOriginBundle>[0]),/真实mixed|私有/)
  await assert.rejects(importPreparedMixedOriginBundle({profileRoot:'unused',operationId:randomUUID(),sourceDirectory:'unused',capsuleMap:[]} as Parameters<typeof importPreparedMixedOriginBundle>[0]),/闭形|字段|闭集/)
  assert.equal(getters,0)
})

test('a fully rehashed mixed catalog with matching certificate and manifest claims still cannot replace actual source SQL knowledge',()=>withMixedBundleFixture([2,1],async f=>{
  const descriptor=structuredClone(f.exported.descriptor),node=JSON.parse(descriptor.nodeText)
  assert.equal(descriptor.source.kind,'complete-capsule2')
  const side=descriptor.source,manifest=JSON.parse(side.sourceManifestText),certificate=JSON.parse(side.certificateText)
  manifest.sourceKnowledgeHash=capsuleBytesHash('caller self-consistent knowledge claim')
  certificate.sourceKnowledgeHash=manifest.sourceKnowledgeHash;certificate.sourceManifestHash=capsule2SourceManifestHash(manifest)
  node.source.capsule.manifestHash=capsule2NoPriorSourceCertificateHash(certificate)
  const forged=validateMixedOriginBundleDescriptor({...descriptor,root:{...descriptor.root,rootHash:requiredSqlDagRootHash(node)},nodeText:capsuleJson(node),
    source:{...side,sourceManifestText:capsuleJson(manifest)+'\n',certificateText:capsuleJson(certificate)+'\n'}})
  const root=f.exported.directory,write=(path:string,text:string)=>writeFile(join(root,...path.split('/')),text)
  await write(`catalog/backups/database-restore/${forged.root.operationId}/knowledge-required-dags/${forged.root.dagId}/root.json`,forged.nodeText)
  await write(mixedOriginCapsulePath(node.source,'knowledge-source-certificates-v2')+'/certificate.json',capsuleJson(certificate)+'\n')
  await write(mixedOriginCapsulePath(node.source,'knowledge-source-capsules-v2')+'/manifest.json',capsuleJson(manifest)+'\n')
  await write('descriptor.json',capsuleJson(forged)+'\n')
  // All descriptor-derived file sizes and hashes really match this artifact.
  assert.equal((await readMixedOriginBundleOriginal(root,mixedOriginBundleHash(forged))).descriptorHash,mixedOriginBundleHash(forged))
  await assert.rejects(importPreparedMixedOriginBundle(f.input),/完整实际|来源清单|不一致|封存/)
  assert.deepEqual(await readPreparedMixedOriginBundle(f.handle),f.value)
  assert.deepEqual(allTables(f.source.db),f.beforeSource);assert.deepEqual(allTables(f.receiver.db),f.beforeReceiver)
}))
