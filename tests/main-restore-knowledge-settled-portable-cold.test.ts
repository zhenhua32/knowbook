import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, lstat, mkdir, realpath, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertRestorePath } from '../src/main/database/restore-safety-files'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { withSettledPortable3 } from './helpers/settled-portable-owner-fixture'

test('independent cold settled owner rebuilds the same whole facts without any IO against the retired source root or removed spool',
  () => withSettledPortable3(async saved => {
    const captured = await saved.capture(), fixtureRoot = await realpath(saved.f.folder), sourceRoot = await realpath(saved.f.B.root)
    assert.equal(dirname(sourceRoot), fixtureRoot); assert.notEqual(sourceRoot, fixtureRoot)
    const coldRoot = join(fixtureRoot, 'cold-settled-portable-owner'), recovery = join(coldRoot, 'backups', 'database-restore')
    assert.equal(dirname(coldRoot), fixtureRoot); await mkdir(recovery, { recursive: true })
    await assertRestorePath(captured.original.info.recoveryDirectory, sourceRoot); await assertRestorePath(coldRoot, fixtureRoot)
    await cp(captured.original.info.recoveryDirectory, join(recovery, captured.input.operationId), { recursive: true, force: false, errorOnExist: true })
    const retired = join(fixtureRoot, 'retired-source-settled-portable')
    assert.equal(dirname(retired), fixtureRoot); await assert.rejects(lstat(retired), { code: 'ENOENT' })
    await assertRestorePath(sourceRoot, fixtureRoot); saved.f.B.db.close(); await rename(sourceRoot, retired)
    await assert.rejects(lstat(sourceRoot), { code: 'ENOENT' })
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', resolve('tests/helpers/settled-portable-owner-process.cjs'), JSON.stringify({ source: { ...captured.input, profileRoot: await realpath(coldRoot) }, oldRoot: sourceRoot })],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
    const actual = JSON.parse(stdout)
    assert.notEqual(actual.pid, process.pid)
    assert.equal(actual.evidenceHash, captured.value.evidenceHash)
    assert.equal(actual.factsHash, publicationHash(publicationJson(captured.value)))
    assert.equal(actual.sourceManifestHash, captured.sealed.info.manifestHash)
    assert.equal(actual.sourceMaterialHash, captured.sealed.value.materialHash); assert.equal(actual.assetArchiveHash, captured.sealed.value.assetArchiveHash)
    assert.deepEqual(actual.records, captured.value.jobs.flatMap(job => job.merged.map(item => ({ key: item.recordKey, bytes: publicationJson(item.record), hash: item.provenance.resultHash }))))
    assert.deepEqual(actual.oldRootAccesses, [])
    assert.equal(actual.spoolSkipPermission, false); assert.equal(actual.installPermit, false)
  }))
