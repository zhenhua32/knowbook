// Separate default-budget file with an independent hidden child.
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, lstat, mkdir, realpath, rename } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { assertRestorePath } from '../src/main/database/restore-safety-files'
import { readSealedCapsule2SourceMaterial, reopenSealedCapsule2Source } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { capsule2AssetReferenceProvenance2Hash } from '../src/main/database/restore-knowledge-capsule2-asset-provenance'
import { withCapturedContext3 } from './helpers/capsule2-context3-producer-fixture'

test('genuine archive3 hot and independent cold readers use only sealed SQL and context bytes after original spool and source profile retirement',
  { concurrency: false }, () => withCapturedContext3(async saved => {
    const fixtureRoot = await realpath(saved.f.folder), sourceRoot = await realpath(saved.original.info.profileRoot)
    assert.equal(dirname(sourceRoot), fixtureRoot); assert.notEqual(sourceRoot, fixtureRoot)
    const spool = join(sourceRoot, 'storage', 'synced-exchanges-v1', saved.operationId, saved.job.attemptId)
    // An actual settled service may already prune the spool. If it still
    // exists, move only that known fixture directory after checking both ends.
    const exists = await lstat(spool).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error })
    if (exists) {
      const original = await realpath(spool), rel = relative(fixtureRoot, original), retiredSpool = join(fixtureRoot, 'retired-actual-context-spool')
      assert.ok(rel && rel !== '..' && !rel.startsWith('..' + sep)); assert.notEqual(original, fixtureRoot)
      await assertRestorePath(original, fixtureRoot); assert.equal(dirname(retiredSpool), fixtureRoot)
      await assert.rejects(lstat(retiredSpool), { code: 'ENOENT' }); await rename(original, retiredSpool)
    }
    await assert.rejects(lstat(spool), { code: 'ENOENT' })
    const hot = await readSealedCapsule2SourceMaterial(await reopenSealedCapsule2Source(saved.sealInput)), archive = hot.assetArchive
    assert.equal(archive.version, 3)
    if (archive.version !== 3) throw new Error('Explicit archive3 required')
    assert.equal(hot.materialHash, saved.saved.value.materialHash)
    const coldRoot = join(fixtureRoot, 'cold-independent-context3'), coldRecovery = join(coldRoot, 'backups', 'database-restore')
    assert.equal(dirname(coldRoot), fixtureRoot); await mkdir(coldRecovery, { recursive: true })
    await cp(saved.original.info.recoveryDirectory, join(coldRecovery, saved.sealInput.operationId), { recursive: true, force: false, errorOnExist: true })
    const canonicalCold = await realpath(coldRoot), retiredRoot = join(fixtureRoot, 'retired-source-context3')
    assert.equal(dirname(canonicalCold), fixtureRoot); assert.equal(dirname(retiredRoot), fixtureRoot)
    assert.notEqual(retiredRoot, fixtureRoot); await assert.rejects(lstat(retiredRoot), { code: 'ENOENT' })
    await assertRestorePath(sourceRoot, fixtureRoot)
    saved.f.B.db.close(); await rename(sourceRoot, retiredRoot)
    await assert.rejects(lstat(sourceRoot), { code: 'ENOENT' })
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('tests/helpers/capsule2-context3-process.cjs'), JSON.stringify({ ...saved.sealInput, profileRoot: canonicalCold })],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
    const actual = JSON.parse(stdout)
    assert.notEqual(actual.pid, process.pid)
    assert.equal(actual.materialHash, hot.materialHash); assert.equal(actual.sourceManifestHash, saved.saved.info.manifestHash)
    assert.equal(actual.assetArchiveHash, hot.assetArchiveHash)
    assert.equal(actual.provenanceHash, capsule2AssetReferenceProvenance2Hash(archive.referenceProvenance))
    assert.equal(actual.contextInventoryHash, archive.contextOriginals.inventoryHash)
    assert.equal(actual.supplementalObservationHash, archive.assetScopeSupplement.observationHash)
    assert.deepEqual(actual.contextFiles, archive.contextOriginals.files); assert.deepEqual(actual.coverage, archive.coverage)
    assert.equal(actual.coverage.installPermit, false)
  }, { withoutManagedCustomAliases: true }))
