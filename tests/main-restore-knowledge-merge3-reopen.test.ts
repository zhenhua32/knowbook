import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { captureActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { importMixedOriginBundleOriginal } from '../src/main/database/restore-knowledge-mixed-origin-bundle-files'
import { captureMixedRootKnowledgeConservationPlan3, readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreMergedContentPlan3, readRootRestoreMergedContentPlan3 } from '../src/main/database/restore-knowledge-merge3-read'
import { captureMixedSource } from './helpers/mixed-required-source-fixture'
import { withV3Fixture, allTables, freshBlock, randomUUID } from './helpers/synced-backup-v3-fixture'

test('independent cold merged candidates recover retained descendants and chosen NULL occurrences from copied originals and the same kernel', () =>
  withV3Fixture(source => withV3Fixture(async receiver => {
    source.store.updateDocument(source.targetId, { title: 'Merge original parent', summary: '',
      blocks: [{ ...freshBlock(source.targetBodyId, 'Target heading'), type: 'heading-1' }] })
    source.store.saveDocumentTemplate({ name: 'Original merged draft', title: '{{title}}', summary: '',
      blocks: [freshBlock('local template block', 'Unexpanded {{title}}')] })
    const add = source.db.prepare('INSERT INTO document_database_values(document_id,column_id,value_text,updated_at,entity_id) VALUES(NULL,?,?,?,NULL)')
    add.run(source.catalogColumn.id, null, '2026-01-01T00:00:00.000Z')
    add.run(source.catalogColumn.id, 'source anonymous', '2026-01-01T00:00:00.000Z')
    const left = await captureMixedSource(source, 2)
    source.store.updateDocument(source.targetId, { title: 'Current changed parent', summary: '',
      blocks: [{ ...freshBlock(source.targetBodyId, 'Current target heading'), type: 'heading-1' }] })
    const retained = source.store.createDocument(source.targetId)
    source.store.updateDocument(retained, { title: 'Current retained child', summary: '', blocks: [freshBlock(randomUUID(), 'Retained body')] })
    source.store.saveDocumentTemplate({ name: 'Current retained draft', title: 'Retained template', summary: '',
      blocks: [freshBlock('independent local block', 'Current template body')] })
    source.db.prepare('DELETE FROM document_database_values WHERE document_id IS NULL AND entity_id IS NULL').run()
    add.run(source.catalogColumn.id, 'different current anonymous', '2026-01-02T00:00:00.000Z')
    add.run(source.catalogColumn.id, null, '2026-01-02T00:00:00.000Z')
    const right = await captureMixedSource(source, 2), beforeSource = allTables(source.db), beforeReceiver = allTables(receiver.db)
    const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.userDataRoot,
      operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
    const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
    const saved = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: receiver.userDataRoot,
      operationId: randomUUID(), sourceDirectory: exported.directory })
    const identity = await prepareRootRestoreIdentityPlan3(saved.knowledgePlan), choices = { anonymousValues: 'source' } as const
    const captured = await prepareRootRestoreMergedContentPlan3(identity.plan, choices), expected = captured.value
    assert.equal(expected.tables.length, 12); assert.equal(expected.permit, false)
    assert.equal(expected.candidateConflictFree, true)
    const documents = expected.tables.find(table => table.name === 'documents')!
    const child = documents.rows.find(row => graph3Text(row.cells[documents.columns.indexOf('id')], documents.encoding) === retained)!
    assert.equal(child.sourceRef.side, 'current')
    assert.equal(graph3Text(child.cells[documents.columns.indexOf('path')], documents.encoding), 'Merge original parent/Current retained child')
    const values = expected.tables.find(table => table.name === 'document_database_values')!
    const anonymous = values.rows.filter(row => row.cells[values.columns.indexOf('document_id')][0] === 'null'
      && row.cells[values.columns.indexOf('entity_id')][0] === 'null')
    assert.equal(anonymous.length, 2); assert.equal(anonymous.every(row => row.sourceRef.side === 'source'), true)

    const oldLocation = await readRootKnowledgePlanLocation3(saved.knowledgePlan), operationId = randomUUID()
    const imported = await importMixedOriginBundleOriginal(receiver.userDataRoot, operationId, saved.originalPackage.directory)
    const copiedIdentity = join(receiver.userDataRoot, 'backups', 'database-restore', operationId, 'restore-identity-plans-v3', identity.planId)
    await mkdir(copiedIdentity, { recursive: true })
    await copyFile(join(identity.directory, 'manifest.json'), join(copiedIdentity, 'manifest.json'))
    for (const [root, path] of [[source.userDataRoot, join(source.userDataRoot, 'backups')],
      [receiver.userDataRoot, join(receiver.userDataRoot, 'backups', 'database-restore', oldLocation.operationId)],
      [receiver.userDataRoot, join(receiver.userDataRoot, 'original-input-verification')]] as const) {
      const rootPath = await realpath(root), from = await realpath(path), local = relative(rootPath, from), info = await lstat(path)
      assert.ok(local && !local.startsWith('..') && !isAbsolute(local))
      assert.equal(info.isSymbolicLink(), false); assert.equal(info.isDirectory(), true)
      const to = from + '-retired-' + randomUUID()
      assert.equal(dirname(to), dirname(from)); assert.ok(!relative(rootPath, to).startsWith('..'))
      await rename(from, to)
    }
    await assert.rejects(readRootRestoreMergedContentPlan3(captured.plan))
    const expectedPath = join(receiver.userDataRoot, 'expected-merge-' + randomUUID() + '.json')
    await writeFile(expectedPath, JSON.stringify(expected), { flag: 'wx' })
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', resolve('tests/helpers/merge3-process.cjs'), JSON.stringify({
        locator: { profileRoot: imported.profileRoot, operationId, mountId: imported.mountId, expectedDescriptorHash: imported.original.descriptorHash },
        identityLocator: { planId: identity.planId, expectedManifestHash: identity.manifestHash }, expectedPath, choices
      })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
    const actual = JSON.parse(stdout)
    assert.notEqual(actual.pid, process.pid); assert.equal(actual.tables, 12)
    assert.equal(actual.checkedMergeHash, expected.checkedMergeHash); assert.equal(actual.mergedContentHash, expected.mergedContentHash)
    assert.deepEqual(allTables(source.db), beforeSource); assert.deepEqual(allTables(receiver.db), beforeReceiver)
  })))
