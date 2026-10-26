import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, lstat, mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { captureActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { importMixedOriginBundleOriginal } from '../src/main/database/restore-knowledge-mixed-origin-bundle-files'
import { captureMixedRootKnowledgeConservationPlan3, readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreNavigationRewriteInputs3, readRootRestoreNavigationRewriteInputs3 } from '../src/main/database/restore-knowledge-navigation3-read'
import { captureMixedSource } from './helpers/mixed-required-source-fixture'
import { command, insertAck } from './helpers/synced-host-command-insert-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { withV3Fixture, allTables, applySyncedHostCommand, oldChildId, randomUUID, snapshot } from './helpers/synced-backup-v3-fixture'

test('independent cold navigation readers preserve complete body summary and repeated-instance heading inputs from copied originals alone', () =>
  withV3Fixture(source => withV3Fixture(async receiver => {
    const initial = snapshot(source.db, source.groupId)
    editCreatedGroup(source.db, source.groupId, initial.blocks.map(({ createdAt: _birth, ...block }) => ({ ...block, type: 'heading-1' })))
    const secondInstance = randomUUID()
    insertAck(applySyncedHostCommand(source.db, command(source.db, {
      documentId: source.hostId, groupId: source.groupId, instanceId: secondInstance
    })))
    const left = await captureMixedSource(source, 2), right = await captureMixedSource(source, 2)
    const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.userDataRoot,
      operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
    const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
    const saved = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: receiver.userDataRoot,
      operationId: randomUUID(), sourceDirectory: exported.directory })
    const identity = await prepareRootRestoreIdentityPlan3(saved.knowledgePlan)
    const { source: navigation, value } = await prepareRootRestoreNavigationRewriteInputs3(identity.plan)
    assert.equal(value.scope, 'root-source-document-body-and-summary')
    for (const documentId of source.sourceDocumentIds) assert.deepEqual(value.scopes
      .filter(scope => scope.document.id === documentId).map(scope => scope.field).sort(), ['body', 'summary'])
    assert.equal(value.scopes.length, source.sourceDocumentIds.length * 2)
    const body = value.scopes.find(scope => scope.document.id === source.hostId && scope.field === 'body')!
    const projected = body.blocks.filter(block => block.location.groupId === source.groupId && block.location.blockId === oldChildId)
    assert.deepEqual(projected.map(block => block.location.instanceId).sort(), [source.instanceId, secondInstance].sort())
    assert.equal(new Set(projected.map(block => block.occurrenceKey)).size, 2)
    const headings = value.headingNamespaces.find(namespace => namespace.document.id === source.hostId)!.headings
      .filter(heading => heading.location?.blockId === oldChildId && heading.location.groupId === source.groupId)
    assert.deepEqual(headings.map(heading => heading.location!.instanceId).sort(), [source.instanceId, secondInstance].sort())
    assert.equal(new Set(headings.map(heading => heading.key)).size, 2)
    assert.equal(new Set(headings.map(heading => heading.slug)).size, 2)
    const oldLocation = await readRootKnowledgePlanLocation3(saved.knowledgePlan), operationId = randomUUID()
    const imported = await importMixedOriginBundleOriginal(receiver.userDataRoot, operationId, saved.originalPackage.directory)
    const copiedIdentity = join(receiver.userDataRoot, 'backups', 'database-restore', operationId, 'restore-identity-plans-v3', identity.planId)
    await mkdir(copiedIdentity, { recursive: true })
    await copyFile(join(identity.directory, 'manifest.json'), join(copiedIdentity, 'manifest.json'))
    for (const [root, path] of [[source.userDataRoot, join(source.userDataRoot, 'backups')],
      [receiver.userDataRoot, join(receiver.userDataRoot, 'backups', 'database-restore', oldLocation.operationId)],
      [receiver.userDataRoot, join(receiver.userDataRoot, 'original-input-verification')]] as const) {
      const local = relative(root, path), info = await lstat(path)
      assert.ok(local && !local.startsWith('..') && !isAbsolute(local))
      assert.equal(info.isSymbolicLink(), false); assert.equal(info.isDirectory(), true)
      await rename(path, path + '-retired-' + randomUUID())
    }
    await assert.rejects(readRootRestoreNavigationRewriteInputs3(navigation))
    const beforeSource = allTables(source.db), beforeReceiver = allTables(receiver.db)
    const expectedPath = join(receiver.userDataRoot, 'expected-navigation-' + randomUUID() + '.json')
    await writeFile(expectedPath, JSON.stringify(value), { flag: 'wx' })
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', resolve('tests/helpers/navigation3-process.cjs'), JSON.stringify({
        locator: { profileRoot: imported.profileRoot, operationId, mountId: imported.mountId, expectedDescriptorHash: imported.original.descriptorHash },
        identityLocator: { planId: identity.planId, expectedManifestHash: identity.manifestHash }, expectedPath
      })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
    const actual = JSON.parse(stdout)
    assert.notEqual(actual.pid, process.pid)
    assert.equal(actual.navigationInputHash, value.navigationInputHash)
    assert.deepEqual(allTables(source.db), beforeSource); assert.deepEqual(allTables(receiver.db), beforeReceiver)
  })))
