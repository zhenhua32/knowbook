import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { link, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { prepareCapsule2AssetArchive, readCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { extractCapsule2SourceMaterial } from '../src/main/database/restore-knowledge-capsule2-source-material'
import { sealCapsule2Source, readSealedCapsule2SourceInputs } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { certifyCapsule2Source, readCertifiedCapsule2Source, readCertifiedCapsule2SourceMaterial, reopenCertifiedCapsule2Source,
  type CertifiedCapsule2NoPriorSource } from '../src/main/database/restore-knowledge-capsule2-source-certificate'
import { capsule2NoPriorSourceCertificateHash, CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES } from '../src/main/database/restore-knowledge-capsule2-source-certificate-model'
import { readCertifiedDurableSqlCapsule } from '../src/main/database/restore-knowledge-capsule-read'
import { KnowbookStore } from '../src/main/database/store'
import { AttachmentStore } from '../src/main/attachments'
import { readCapsule2AssetManifest } from '../src/main/database/restore-knowledge-capsule2-assets-files'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { restoreInventory } from '../src/main/database/restore-safety-files'
import { allTables, withV3Fixture, addV3Assets, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { writeMixedOrdinary501 } from './helpers/capsule2-raw-fixture'
import { actualHistorySyntax, insertCoverageSyntax } from './helpers/coverage-raw-sql-fixture'
import { removeSchema27ForLegacyFixture } from './helpers/schema27-legacy-fixture'

async function sealed(f: Pick<V3Fixture, 'userDataRoot' | 'db'>) {
  const original = await captureAssetOriginal(f), archive = await prepareCapsule2AssetArchive(original.original)
  const source = await sealCapsule2Source(await extractCapsule2SourceMaterial(archive))
  return { original, archive, source }
}
async function capture(f: Pick<V3Fixture, 'userDataRoot' | 'db'>) {
  const saved = await sealed(f), result = await certifyCapsule2Source(saved.source)
  assert.equal(result.status, 'certified-without-prior-coverage')
  const handle = result.source, info = await readCertifiedCapsule2Source(handle)
  const input = { profileRoot: saved.original.info.profileRoot, operationId: info.certificate.operationId,
    capsuleId: info.certificate.capsuleId, expectedCertificateHash: info.certificateHash }
  return { ...saved, handle, info, input }
}

test('capsule2 no-prior certificate authenticates complete actual mixed ordinary501 K policy and managed sources without assigning an origin or installer', () => withV3Fixture(async f => {
  await addV3Assets(f); actualHistorySyntax(f.db, '2054-03-02T01:02:03.004Z'); writeMixedOrdinary501(f)
  f.store.saveSetting('certificate.private', 'private original credential')
  const before = allTables(f.db), saved = await capture(f), value = await readCertifiedCapsule2SourceMaterial(saved.handle), certificate = saved.info.certificate
  assert.equal(certificate.scope, 'complete-original-source-without-prior-coverage')
  assert.equal(certificate.certified, true); assert.equal(certificate.semanticValidationComplete, true)
  assert.equal(certificate.sourceMaterialHash, value.materialHash); assert.equal(certificate.sourceKnowledgeHash, value.knowledge.observationHash)
  assert.equal(certificate.requiredRoots, 0); assert.equal(certificate.originalReferenceDomain, 'unassigned')
  assert.equal(certificate.acceptedCoverage, false); assert.equal(certificate.effective, false); assert.equal(certificate.permit, false); assert.equal(certificate.policyReplayAllowed, false)
  assert.ok(value.knowledge.groups.length > 0); assert.ok(value.knowledge.recoveryBoundaries.length > 0)
  assert.equal(capsuleJson(certificate).includes('private original credential'), false)
  assert.deepEqual(await readdir(saved.info.directory), ['certificate.json'])
  assert.deepEqual((await readdir(saved.original.info.capsuleDirectory)).sort(), ['original','scratch'])
  await assert.rejects(readCertifiedDurableSqlCapsule(saved.handle as never), /不是Main认证/)
  await assert.rejects(certifyCapsule2Source(saved.source), /已开始/)
  assert.deepEqual(allTables(f.db), before); assert.deepEqual(await restoreInventory(saved.original.info.originalDirectory), saved.original.inventory)
}))

test('capsule2 no-prior source certification returns unresolved actual C instead of minting a certificate or discarding its complete supports', () => withV3Fixture(async f => {
  insertCoverageSyntax(f.db, actualHistorySyntax(f.db, '2054-03-02T01:02:03.004Z'))
  const saved = await sealed(f), before = allTables(f.db), input = await readSealedCapsule2SourceInputs(saved.source)
  assert.equal(input.value.knowledge.coverageMaterial.length, 4)
  assert.deepEqual(await certifyCapsule2Source(saved.source), { status: 'requires-qualified-prior-coverage', requiredRoots: 1 })
  assert.equal((await readdir(saved.original.info.recoveryDirectory)).includes('knowledge-source-certificates-v2'), false)
  assert.deepEqual((await readSealedCapsule2SourceInputs(saved.source)).value, input.value)
  assert.deepEqual(allTables(f.db), before)
}))

test('capsule2 no-prior certificate reopens in a genuine independent process after live files vanish and old scratch is poisoned', () => withV3Fixture(async f => {
  await addV3Assets(f); writeMixedOrdinary501(f)
  const saved = await capture(f), value = await readCertifiedCapsule2SourceMaterial(saved.handle), archive = await readCapsule2AssetArchive(saved.archive)
  for (const alias of archive.manifest.tree.aliases) await unlink(join(f.assets.root, alias.relativePath))
  await writeFile(saved.original.info.databasePath, 'poisoned former scratch')
  const { stdout } = await promisify(execFile)(process.execPath, ['--import','tsx',resolve('tests/helpers/capsule2-source-certificate-process.cjs'),JSON.stringify(saved.input)],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE:'1' }, windowsHide:true, timeout:30_000, maxBuffer:32*1024*1024 })
  const actual = JSON.parse(stdout); assert.notEqual(actual.pid, process.pid)
  assert.deepEqual(actual.info, saved.info); assert.deepEqual(actual.value, value)
  assert.deepEqual(await restoreInventory(saved.original.info.originalDirectory), saved.original.inventory)
}))

test('capsule2 no-prior certificate rejects each rehashed authority identity or complete-source pin against its actual originals', t => withV3Fixture(async f => {
  const saved = await capture(f), path = join(saved.info.directory,'certificate.json'), bytes = await readFile(path)
  for (const key of ['sourceManifestHash','sourceMaterialHash','sourceKnowledgeHash','schemaVersion','requiredRoots','originalReferenceDomain','permit','policyReplayAllowed','scope','extra-field'] as const)
    await t.test(`capsule2 no-prior certificate refuses rehashed ${key}`, async () => {
      const certificate = JSON.parse(bytes.toString())
      if (key.endsWith('Hash')) certificate[key] = '0'.repeat(64)
      else if (key === 'schemaVersion') certificate[key] = certificate[key] === 27 ? 26 : 27
      else if (key === 'requiredRoots') certificate[key] = 1
      else if (key === 'permit' || key === 'policyReplayAllowed') certificate[key] = true
      else certificate[key] = 'caller authority'
      try {
        await writeFile(path, capsuleJson(certificate)+'\n')
        await assert.rejects(reopenCertifiedCapsule2Source({ ...saved.input, expectedCertificateHash: capsule2NoPriorSourceCertificateHash(certificate) }))
      } finally { await writeFile(path, bytes) }
    })
  assert.deepEqual(await readCertifiedCapsule2Source(saved.handle), saved.info)
}))

test('capsule2 no-prior certificate rejects changed certificate closure hardlinks original SQL and archived bytes on each consume', () => withV3Fixture(async f => {
  await addV3Assets(f); const saved = await capture(f), path = join(saved.info.directory,'certificate.json'), bytes = await readFile(path), alias = join(f.root,'certificate-alias')
  await link(path,alias); await assert.rejects(readCertifiedCapsule2Source(saved.handle)); await unlink(alias)
  const extra = join(saved.info.directory,'extra'); await writeFile(extra,'unexpected')
  await assert.rejects(readCertifiedCapsule2SourceMaterial(saved.handle), /闭集/); await unlink(extra)
  await writeFile(path, bytes.subarray(0, bytes.length-1)); await assert.rejects(readCertifiedCapsule2Source(saved.handle)); await writeFile(path,bytes)
  const archive = await readCapsule2AssetArchive(saved.archive), blob = join(archive.directory,'files',archive.manifest.tree.files[0].hash), original = await readFile(blob)
  await writeFile(blob,'changed archive'); await assert.rejects(readCertifiedCapsule2SourceMaterial(saved.handle)); await writeFile(blob,original)
  await writeFile(join(saved.original.info.originalDirectory,'knowbook.db'),'changed original')
  await assert.rejects(readCertifiedCapsule2Source(saved.handle))
}))

test('capsule2 no-prior certificate reads at most its fixed small certificate budget and rejects invalid UTF8 or noncanonical bytes', () => withV3Fixture(async f => {
  const saved = await capture(f), path = join(saved.info.directory,'certificate.json'), bytes = await readFile(path), fd = await open(path,'w')
  try { await fd.truncate(CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES+1) } finally { await fd.close() }
  await assert.rejects(reopenCertifiedCapsule2Source(saved.input), /预算|超|大小/)
  await writeFile(path, Buffer.from([255,254,0])); await assert.rejects(reopenCertifiedCapsule2Source(saved.input))
  await writeFile(path, JSON.stringify(saved.info.certificate,null,2)+'\n'); await assert.rejects(reopenCertifiedCapsule2Source(saved.input))
  await writeFile(path,bytes); await assert.rejects(reopenCertifiedCapsule2Source({ ...saved.input, expectedCertificateHash:'0'.repeat(64) }))
}))

test('capsule2 no-prior certificate rejects copied or forged handles without invoking caller getters', async () => {
  let accessed = false
  const fake = Object.defineProperty({},'kind',{ enumerable:true,get(){ accessed=true; throw Error('getter') } })
  await assert.rejects(certifyCapsule2Source(fake as never), /私有来源句柄/)
  await assert.rejects(readCertifiedCapsule2Source(fake as CertifiedCapsule2NoPriorSource), /私有来源句柄/)
  await assert.rejects(readCertifiedCapsule2SourceMaterial(fake as CertifiedCapsule2NoPriorSource), /私有来源句柄/)
  assert.equal(accessed,false)
})

test('capsule2 no-prior certificate preserves complete schema26 column-fixture ordinary501 data and assets without migration', () => withV3Fixture(async f => {
  const userDataRoot = join(f.root,'certificate-source26'), store = new KnowbookStore(join(userDataRoot,'storage','knowbook.db'))
  try {
    const assets = new AttachmentStore(join(userDataRoot,'storage','assets'))
    const [asset] = await assets.import([{name:'source26.png',bytes:Buffer.from('actual source26 original bytes')}])
    const id = store.createDocument(null), detail = store.getDocumentDetail(id)!
    store.updateDocument(id,{title:'源'.repeat(501),summary:'[actual](<'+asset.url+'>)',blocks:detail.blocks})
    const db = store.getUnsafeDatabaseHandle()
    // Existing narrow column fixture, not a genuine historical Main oracle.
    removeSchema27ForLegacyFixture(db); db.pragma('user_version=26')
    const before = allTables(db), saved = await capture({userDataRoot,db}), value = await readCertifiedCapsule2SourceMaterial(saved.handle)
    assert.equal(saved.info.certificate.schemaVersion,26); assert.equal(value.knowledge.schemaVersion,26)
    assert.equal(value.assetArchive.referenceUris.includes(asset.url),true)
    assert.equal(db.pragma('user_version',{simple:true}),26); assert.deepEqual(allTables(db),before)
    assert.deepEqual(await restoreInventory(saved.original.info.originalDirectory),saved.original.inventory)
  } finally { store.destroy() }
}))

test('capsule2 certificate bounded manifest reader cannot increase the original budget or read a path with an invalid limit', async () => {
  for(const maximum of [0,-1,Infinity,NaN,CAPSULE2_RAW_MAX_JSON_BYTES+1])
    await assert.rejects(readCapsule2AssetManifest('unopened-certificate-path','unopened-root',maximum),/读取预算无效/)
})
