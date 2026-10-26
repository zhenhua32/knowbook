import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { importMixedOriginBundleOriginal } from '../src/main/database/restore-knowledge-mixed-origin-bundle-files'
import { readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreNavigationRewritePlan3, readRootRestoreNavigationRewritePlan3 }
  from '../src/main/database/restore-knowledge-navigation3-rewrite-read'
import { allTables, randomUUID } from './helpers/synced-backup-v3-fixture'
import { withNavigation3RewriteFixture } from './helpers/navigation3-rewrite-fixture'

test('independent cold navigation rewrite reconstructs both sides exact candidate cells and hashes from copied originals and one durable kernel', () =>
  withNavigation3RewriteFixture(async f => {
    const identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const choices = { anonymousValues: 'source' } as const
    const captured = await prepareRootRestoreNavigationRewritePlan3(identity.plan, choices), expected = captured.value
    assert.equal(expected.tables.length, 12)
    assert.ok(expected.edits.some(edit => edit.side === 'source'))
    assert.ok(expected.edits.some(edit => edit.side === 'current'))
    assert.ok(expected.unresolved.length >= 3)
    assert.equal(expected.referenceRewriteComplete, false)
    assert.equal(expected.permit, false)
    const oldLocation = await readRootKnowledgePlanLocation3(f.saved.knowledgePlan), operationId = randomUUID()
    const imported = await importMixedOriginBundleOriginal(f.receiver.userDataRoot, operationId, f.saved.originalPackage.directory)
    const copiedIdentity = join(f.receiver.userDataRoot, 'backups', 'database-restore', operationId, 'restore-identity-plans-v3', identity.planId)
    await mkdir(copiedIdentity, { recursive: true })
    await copyFile(join(identity.directory, 'manifest.json'), join(copiedIdentity, 'manifest.json'))
    // Retire the early source backups and the parent's active operation and
    // verification tree. The child must open only its imported immutable mount.
    for (const [root, path] of [[f.source.userDataRoot, join(f.source.userDataRoot, 'backups')],
      [f.receiver.userDataRoot, join(f.receiver.userDataRoot, 'backups', 'database-restore', oldLocation.operationId)],
      [f.receiver.userDataRoot, join(f.receiver.userDataRoot, 'original-input-verification')]] as const) {
      const rootPath = await realpath(root), from = await realpath(path), local = relative(rootPath, from), info = await lstat(path)
      assert.ok(local && !local.startsWith('..') && !isAbsolute(local))
      assert.equal(info.isSymbolicLink(), false)
      assert.equal(info.isDirectory(), true)
      const to = from + '-retired-' + randomUUID()
      assert.equal(dirname(to), dirname(from))
      assert.ok(!relative(rootPath, to).startsWith('..'))
      await rename(from, to)
    }
    await assert.rejects(readRootRestoreNavigationRewritePlan3(captured.plan))
    const expectedPath = join(f.receiver.userDataRoot, 'expected-navigation-rewrite-' + randomUUID() + '.json')
    await writeFile(expectedPath, JSON.stringify(expected), { flag: 'wx' })
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', resolve('tests/helpers/navigation3-rewrite-process.cjs'), JSON.stringify({
        locator: { profileRoot: imported.profileRoot, operationId, mountId: imported.mountId, expectedDescriptorHash: imported.original.descriptorHash },
        identityLocator: { planId: identity.planId, expectedManifestHash: identity.manifestHash }, expectedPath, choices
      })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
    const actual = JSON.parse(stdout)
    assert.notEqual(actual.pid, process.pid)
    assert.equal(actual.tables, 12)
    assert.equal(actual.edits, expected.edits.length)
    assert.equal(actual.unresolved, expected.unresolved.length)
    assert.equal(actual.checkedNavigationRewriteHash, expected.checkedNavigationRewriteHash)
    assert.equal(actual.navigationRewriteHash, expected.navigationRewriteHash)
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }))
