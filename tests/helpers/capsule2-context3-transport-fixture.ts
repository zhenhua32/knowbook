// Each caller owns a fresh HTTP/Main/SQL fixture. Only genuine handles from
// this invocation reach factories; assertions below never mint a capability.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { lstat, mkdir, readFile, readdir, realpath, rename } from 'node:fs/promises'
import { capsuleBytesHash } from '../../src/main/database/restore-knowledge-capsule-model'
import { certifyCapsule2Source } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'
import { captureSealedCapsule2SourceWithAssetProvenance3 } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import type { readCompleteOriginalContentPair3 } from '../../src/main/database/restore-knowledge-qualified-originals'
import type { CompleteOriginalPackage } from '../../src/main/database/restore-knowledge-original-input-types'
import { assertRestorePath } from '../../src/main/database/restore-safety-files'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import { allTables } from './synced-backup-v3-fixture'
import { withCapturedContext3 } from './capsule2-context3-producer-fixture'

type Saved = Parameters<Parameters<typeof withCapturedContext3>[0]>[0]
async function prepareTransport(saved: Saved) {
  const fixtureRoot = await realpath(saved.f.folder), sourceRoot = await realpath(saved.original.info.profileRoot)
  assert.equal(dirname(sourceRoot), fixtureRoot); assert.notEqual(sourceRoot, fixtureRoot)
  const originalAssets = join(sourceRoot, 'storage', 'assets'), retiredAssets = join(fixtureRoot, 'retired-live-assets-before-base-current')
  await assertRestorePath(originalAssets, fixtureRoot); assert.equal(dirname(retiredAssets), fixtureRoot)
  await assert.rejects(lstat(retiredAssets), { code: 'ENOENT' })
  await rename(originalAssets, retiredAssets); await mkdir(originalAssets)
  // Capture the actual same-profile current through the unchanged base-v2
  // factory. Its missing literal targets remain unresolved and its tree empty.
  const sourceSql = allTables(saved.f.B.db), currentOriginal = await captureAssetOriginal({ userDataRoot: sourceRoot, db: saved.f.B.db })
  const current = await captureSealedCapsule2SourceWithAssetProvenance3(currentOriginal.original)
  assert.equal(current.value.assetArchive.version, 2)
  if (current.value.assetArchive.version !== 2) throw new Error('Actual base-v2 current required')
  assert.deepEqual(current.value.assetArchive.tree.files, [])
  assert.equal('contextOriginals' in current.value.assetArchive, false)
  const sourceCertificate = await certifyCapsule2Source(saved.saved.source), currentCertificate = await certifyCapsule2Source(current.source)
  assert.equal(sourceCertificate.status, 'certified-without-prior-coverage'); assert.equal(currentCertificate.status, 'certified-without-prior-coverage')
  if (sourceCertificate.status !== 'certified-without-prior-coverage' || currentCertificate.status !== 'certified-without-prior-coverage') throw new Error('Genuine no-prior sources required')
  // Both native producers require a real existing operation. Their new DAG
  // and bundle IDs are allocated separately inside each test invocation.
  const sourceOperationId = saved.sealInput.operationId, sourceOperation = join(sourceRoot, 'backups', 'database-restore', sourceOperationId)
  await assertRestorePath(sourceOperation, sourceRoot)
  assert.equal(await realpath(sourceOperation), await realpath(saved.original.info.recoveryDirectory))
  assert.equal((await lstat(sourceOperation)).isDirectory(), true)
  const sourceArchive = saved.saved.value.assetArchive
  assert.equal(sourceArchive.version, 3)
  if (sourceArchive.version !== 3) throw new Error('Actual source archive3 required')
  const managedBytes = sourceArchive.tree.files.reduce((count, file) => count + file.bytes, 0) + sourceArchive.contextOriginals.files.reduce((count, file) => count + file.bytes, 0)
  const originalSqlBytes = [...saved.saved.value.sourceInventory, ...current.value.sourceInventory].reduce((count, file) => count + file.bytes, 0)
  const transportRoot = join(fixtureRoot, 'genuine-imported-context3-profile'); assert.equal(dirname(transportRoot), fixtureRoot)
  await mkdir(transportRoot)
  const canonicalTransport = await realpath(transportRoot)
  const sourceAssetsPath = `catalog/backups/database-restore/${saved.sealInput.operationId}/knowledge-complete-assets-v2/${saved.sealInput.capsuleId}`
  const currentAssetsPath = `catalog/backups/database-restore/${current.info.manifest.operationId}/knowledge-complete-assets-v2/${current.info.manifest.capsuleId}`
  return { saved, fixtureRoot, sourceRoot, sourceSql, current, sourceCertificate, currentCertificate, sourceOperationId,
    sourceArchive, managedBytes, originalSqlBytes, canonicalTransport, sourceAssetsPath, currentAssetsPath }
}
export type ContextTransport3 = Awaited<ReturnType<typeof prepareTransport>>
/** Fresh filesystem, HTTP exchange, pending job, original SQL, context archive,
 * certificates and receiver for EVERY test; no cross-test cache or shared DTO. */
export function withContextTransport3(run: (value: ContextTransport3) => Promise<void>) {
  return withCapturedContext3(async saved => run(await prepareTransport(saved)))
}

export async function assertContextTransportOperation3(f: ContextTransport3, operationId: string) {
  const operation = join(f.canonicalTransport, 'backups', 'database-restore', operationId)
  await assertRestorePath(operation, f.canonicalTransport)
  assert.equal((await lstat(operation)).isDirectory(), true)
}
/** Validate every actual copied blob independently against the genuine source
 * manifest, not against another transport's output or a prebuilt catalog. */
export async function assertContextTransportFiles3(f: ContextTransport3, files: CompleteOriginalPackage['files']) {
  const { sourceAssetsPath, sourceArchive } = f
  const actualContextFiles = files.filter(file => !file.frame.length && file.path.startsWith(sourceAssetsPath + '/contexts/'))
  assert.deepEqual(actualContextFiles.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    sourceArchive.contextOriginals.files.map(file => ({ path: sourceAssetsPath + '/contexts/' + file.sha256, bytes: file.bytes, sha256: file.sha256 })))
  for (const file of actualContextFiles) assert.equal(capsuleBytesHash(await readFile(file.sourcePath)), file.sha256)
}
export async function assertContextTransportInventory3(f: ContextTransport3, originalPackage: CompleteOriginalPackage) {
  const { sourceAssetsPath, currentAssetsPath, managedBytes, originalSqlBytes } = f
  await assertContextTransportFiles3(f, originalPackage.files)
  assert.ok(originalPackage.directories.some(dir => !dir.frame.length && dir.path === sourceAssetsPath + '/contexts'))
  assert.ok(originalPackage.directories.some(dir => !dir.frame.length && dir.path === currentAssetsPath + '/files'))
  assert.equal(originalPackage.directories.some(dir => !dir.frame.length && dir.path === currentAssetsPath + '/contexts'), false, 'Import does not add a v3-only directory to base-v2')
  if (originalPackage.reader === 'prepared-mixed-v2') assert.deepEqual(await readdir(join(originalPackage.directory, ...currentAssetsPath.split('/'), 'files')), [])
  // Qualified storage uses frames. Its real fresh reader recreates the empty
  // directory; the unchanged independent child observes mkdir and reads [].
  assert.equal(originalPackage.original.managedOriginalBytes, managedBytes)
  assert.equal(originalPackage.original.originalSqlBytes, originalSqlBytes)
}
export async function retireContextTransportSource3(f: ContextTransport3) {
  const { saved, sourceSql, sourceRoot, fixtureRoot, canonicalTransport } = f
  assert.deepEqual(allTables(saved.f.B.db), sourceSql)
  const retiredRoot = join(fixtureRoot, 'retired-context3-transport-source')
  assert.equal(dirname(retiredRoot), fixtureRoot); assert.equal(dirname(canonicalTransport), fixtureRoot)
  await assertRestorePath(sourceRoot, fixtureRoot); await assert.rejects(lstat(retiredRoot), { code: 'ENOENT' })
  saved.f.B.db.close(); await rename(sourceRoot, retiredRoot)
  await assert.rejects(lstat(sourceRoot), { code: 'ENOENT' })
}
export function assertContextTransportContent3(f: ContextTransport3, content: Awaited<ReturnType<typeof readCompleteOriginalContentPair3>>) {
  const { saved, current } = f
  assert.equal(content.source.materialHash, saved.saved.value.materialHash)
  assert.equal(content.source.assetArchiveHash, saved.saved.value.assetArchiveHash)
  assert.equal(content.current.materialHash, current.value.materialHash)
  assert.equal(content.current.assetArchiveHash, current.value.assetArchiveHash)
  assert.equal(content.source.assetArchive.version, 3); assert.equal(content.current.assetArchive.version, 2)
  assert.deepEqual(content.source.source.sourceContent, saved.saved.value.source.sourceContent)
}
type Locator = { profileRoot: string; operationId: string; mountId: string; expectedDescriptorHash: string }
export async function assertContextTransportChild3(f: ContextTransport3, mode: 'mixed' | 'qualified', actualLocator: Locator) {
  const { saved, sourceRoot, sourceArchive, current, managedBytes } = f
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('tests/helpers/capsule2-context3-transport-process.cjs'), JSON.stringify({ mode, locator: actualLocator, forbiddenOriginRoot: sourceRoot })],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
  const cold = JSON.parse(stdout)
  assert.equal(cold.mode, mode); assert.notEqual(cold.pid, process.pid); assert.deepEqual(cold.forbiddenOriginAccesses, [])
  assert.equal(cold.sourceManifestHash, saved.saved.info.manifestHash)
  assert.equal(cold.sourceMaterialHash, saved.saved.value.materialHash); assert.equal(cold.sourceArchiveHash, saved.saved.value.assetArchiveHash)
  assert.equal(cold.currentMaterialHash, current.value.materialHash); assert.equal(cold.currentArchiveVersion, 2)
  assert.equal(cold.contextInventoryHash, sourceArchive.contextOriginals.inventoryHash)
  assert.equal(cold.supplementalObservationHash, sourceArchive.assetScopeSupplement.observationHash)
  assert.equal(cold.managedOriginalBytes, managedBytes); assert.equal(cold.currentFilesDirectoryEmpty, true)
  assert.equal(cold.acceptedCoverage, false); assert.equal(cold.permit, false)
}
