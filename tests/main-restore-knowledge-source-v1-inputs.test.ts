import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {withV3Fixture,addV3Assets,allTables} from './helpers/synced-backup-v3-fixture'
import {captureAssetOriginal} from './helpers/capsule2-assets-fixture'
import {actualHistorySyntax,insertCoverageSyntax,readCoverage} from './helpers/coverage-raw-sql-fixture'
import {certifyDurableSqlCapsuleOriginal,captureCertifiedCapsuleNoPriorSourceInputs,
  captureCertifiedCapsulePriorCoverage,readCertifiedCapsulePriorCoverage,
  extractCertifiedDurableSqlCapsuleKnowledge,readCertifiedCapsuleKnowledge} from '../src/main/database/restore-knowledge-capsule-read'

test('paired legacy source capture equals both independent full SQL readers and rejects late originals and fake handles',()=>withV3Fixture(async f=>{
  await addV3Assets(f)
  const before=allTables(f.db),original=await captureAssetOriginal(f),source=await certifyDurableSqlCapsuleOriginal(original.original)
  const prior=await readCertifiedCapsulePriorCoverage(await captureCertifiedCapsulePriorCoverage(source))
  const projection=await readCertifiedCapsuleKnowledge(await extractCertifiedDurableSqlCapsuleKnowledge(source))
  const paired=await captureCertifiedCapsuleNoPriorSourceInputs(source)
  assert.deepEqual(paired.value,prior);assert.deepEqual(paired.projection,projection)
  let getters=0
  const fake=Object.create(null,{kind:{get(){getters++;throw Error('caller getter')},enumerable:true}})
  await assert.rejects(captureCertifiedCapsuleNoPriorSourceInputs(fake),/实际SQL认证/);assert.equal(getters,0)
  await assert.rejects(captureCertifiedCapsuleNoPriorSourceInputs({...source}),/实际SQL认证/)
  const path=join(original.info.originalDirectory,'knowbook.db'),bytes=await readFile(path),bad=Buffer.from(bytes);bad[bad.length-1]^=1
  try{await writeFile(path,bad);await assert.rejects(captureCertifiedCapsuleNoPriorSourceInputs(source))}
  finally{await writeFile(path,bytes)}
  const restored=await captureCertifiedCapsuleNoPriorSourceInputs(source)
  assert.deepEqual(restored.value,prior);assert.deepEqual(restored.projection,projection);assert.deepEqual(allTables(f.db),before)
}))

test('untrusted prior-C syntax stays visible to the raw reader and cannot enter paired legacy inputs through a raw original',()=>withV3Fixture(async f=>{
  insertCoverageSyntax(f.db,actualHistorySyntax(f.db,'2054-03-02T01:02:03.004Z'))
  const before=allTables(f.db),prior=readCoverage(f.db),original=await captureAssetOriginal(f)
  assert.equal(prior.entries.length,1)
  await assert.rejects(certifyDurableSqlCapsuleOriginal(original.original),/没有准确参与组的发布记录/)
  await assert.rejects(captureCertifiedCapsuleNoPriorSourceInputs(original.original as unknown as Parameters<typeof captureCertifiedCapsuleNoPriorSourceInputs>[0]),/实际SQL认证/)
  assert.deepEqual(readCoverage(f.db),prior);assert.deepEqual(allTables(f.db),before)
}))
