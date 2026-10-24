import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { prepareCapsule2AssetArchive, readCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { extractCapsule2SourceMaterial, readCapsule2SourceMaterial, diagnoseCapsule2SourceMaterial } from '../src/main/database/restore-knowledge-capsule2-source-material'
import { readCertifiedDurableSqlCapsule, type CertifiedDurableSqlCapsule } from '../src/main/database/restore-knowledge-capsule-read'
import { restoreInventory } from '../src/main/database/restore-safety-files'
import { addV3Assets, allTables, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { actualHistorySyntax, insertCoverageSyntax } from './helpers/coverage-raw-sql-fixture'
import { writeMixedOrdinary501, decodedCapsule2Table } from './helpers/capsule2-raw-fixture'

async function captured(f: Parameters<Parameters<typeof withV3Fixture>[0]>[0]) {
  const source = await captureAssetOriginal(f), archive = await prepareCapsule2AssetArchive(source.original)
  return { source, archive }
}

test('capsule2 source material binds complete real ordinary policy historical and file sources without a caller projection', () => withV3Fixture(async f => {
  await addV3Assets(f); const long = writeMixedOrdinary501(f)
  f.store.saveSetting('source.fixture.secret', 'private source credential fixture')
  const before = allTables(f.db), { source, archive } = await captured(f)
  const handle = await extractCapsule2SourceMaterial(archive), value = await readCapsule2SourceMaterial(handle)
  const documents = decodedCapsule2Table(value.source.sourceContent, 'documents')
  assert.ok(documents.some(row => row.title === long.title))
  assert.equal(value.source.policy.tables.length, 20); assert.ok(value.source.physical.groups.length > 0)
  assert.equal(value.source.assets.sourceContentHash, value.assetArchive.sourceContentHash)
  assert.equal(value.source.history.observationHash, value.assetArchive.workspaceHistoryObservationHash)
  assert.equal(value.source.assets.observationHash, value.assetArchive.assetReferencesObservationHash)
  assert.ok(value.assetArchive.tree.files.length > 0)
  assert.equal(value.certified, false); assert.equal(value.semanticValidationComplete, false)
  assert.equal(value.acceptedCoverage, false); assert.equal(value.effective, false); assert.equal(value.permit, false)
  assert.equal(Reflect.set(value.source.sourceContent.tables, 'length', 0), false)
  assert.equal(Reflect.set(value.assetArchive.tree.files[0], 'hash', '0'.repeat(64)), false)
  await assert.rejects(readCapsule2SourceMaterial({ ...handle }), /私有句柄/)
  await assert.rejects(readCertifiedDurableSqlCapsule(handle as unknown as CertifiedDurableSqlCapsule), /不是Main认证/)
  const diagnostic = await diagnoseCapsule2SourceMaterial(handle), text = JSON.stringify(diagnostic)
  assert.equal(diagnostic.materialHash, value.materialHash); assert.ok(diagnostic.rows > 0)
  for (const secret of ['private source credential fixture', 'source.fixture.secret', 'originalTableHash', 'referenceUris', 'sourceInventory']) assert.equal(text.includes(secret), false)
  assert.deepEqual(allTables(f.db), before); assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

test('capsule2 source material keeps actual untrusted prior-C SQL requirements unresolved rather than claiming empty or accepted coverage', () => withV3Fixture(async f => {
  const syntax = actualHistorySyntax(f.db, '2054-03-02T01:02:03.004Z')
  insertCoverageSyntax(f.db, syntax)
  const { source, archive } = await captured(f)
  const value = await readCapsule2SourceMaterial(await extractCapsule2SourceMaterial(archive))
  assert.equal(value.priorCoverageRequirements.entries.length, 1)
  assert.equal(value.source.total.observer.coverage.supports.length, 6)
  assert.deepEqual(value.priorCoverageRequirements, value.source.total.observer.coverage.requirements)
  assert.ok(value.unresolved.includes('qualified-prior-root-resolution')); assert.equal(value.acceptedCoverage, false)
  assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

test('capsule2 source material always reopens fresh readonly SQL after original scratch and live managed names disappear', () => withV3Fixture(async f => {
  await addV3Assets(f); const { source, archive } = await captured(f), saved = await readCapsule2AssetArchive(archive)
  await writeFile(source.info.databasePath, 'poisoned previous scratch')
  for (const alias of saved.manifest.tree.aliases) await unlink(join(f.assets.root, alias.relativePath))
  const reads = join(source.info.recoveryDirectory, 'knowledge-capsule-reads')
  const handle = await extractCapsule2SourceMaterial(archive), before = (await readdir(reads)).length
  const first = await readCapsule2SourceMaterial(handle), afterFirst = (await readdir(reads)).length
  const second = await readCapsule2SourceMaterial(handle), afterSecond = (await readdir(reads)).length
  assert.equal(afterFirst - before, 1); assert.equal(afterSecond - afterFirst, 1)
  assert.deepEqual(second, first); assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))

test('capsule2 source material cannot outlive late immutable SQL or archived file tampering', () => withV3Fixture(async f => {
  await addV3Assets(f); const { source, archive } = await captured(f), saved = await readCapsule2AssetArchive(archive)
  const handle = await extractCapsule2SourceMaterial(archive), path = join(saved.directory, 'files', saved.manifest.tree.files[0].hash), bytes = await readFile(path)
  await writeFile(path, 'late archive tampering')
  await assert.rejects(readCapsule2SourceMaterial(handle), /文件|hash|字节/)
  await writeFile(path, bytes); await writeFile(join(source.info.originalDirectory, 'knowbook.db'), 'late original tampering')
  await assert.rejects(readCapsule2SourceMaterial(handle), /原件|bytes|清单|改变/)
}))

test('capsule2 source material accepts only the actual complete archive registry identity', async () => {
  let accessed = false
  const forged = Object.defineProperty({}, 'kind', { enumerable: true, get: () => { accessed = true; throw new Error('caller getter') } })
  await assert.rejects(extractCapsule2SourceMaterial(forged as never), /私有句柄/)
  assert.equal(accessed, false)
})

test('capsule2 complete source material rebuilds equal complete data and hashes in a real independent process', () => withV3Fixture(async f => {
  await addV3Assets(f); const { source, archive } = await captured(f), saved = await readCapsule2AssetArchive(archive)
  const expected = await readCapsule2SourceMaterial(await extractCapsule2SourceMaterial(archive))
  for (const alias of saved.manifest.tree.aliases) await unlink(join(f.assets.root, alias.relativePath))
  await writeFile(source.info.databasePath, 'old scratch must not supply source material')
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('tests/helpers/capsule2-complete-source-process.cjs'),
    JSON.stringify({ original: { profileRoot: source.info.profileRoot, operationId: basename(source.info.recoveryDirectory),
      capsuleId: basename(source.info.capsuleDirectory), expectedInventory: source.inventory }, manifestHash: saved.manifestHash })],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 })
  const actual = JSON.parse(stdout)
  assert.notEqual(actual.pid, process.pid); assert.deepEqual(actual.value, expected)
  assert.deepEqual(await restoreInventory(source.info.originalDirectory), source.inventory)
}))
