import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { parseSyncedPortableAssetUri } from '../src/shared/syncedBlockPortable'
import { capsuleBytesHash } from '../src/main/database/restore-knowledge-capsule-model'
import { referenceContextObjectPath } from '../src/main/database/restore-knowledge-reference-context-model'
import { prepareRootRestoreSqlAssetStage5, readRootRestoreSqlAssetStage5,
  reopenRootRestoreSqlAssetStage5 } from '../src/main/database/restore-knowledge-sql-asset-stage5'
import { allTables, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { withSettledWorkingSource5 } from './helpers/working5-automatic-source-fixture'
import { prepareWorking5AssetReferenceFixture } from './helpers/working5-asset-authority-fixture'

test('selected settled W summary and native body use exact candidate ranges and durable qualified copies',
  { concurrency: false }, () => withSettledWorkingSource5(f => withV3Fixture(async receiver => {
    const beforeSource = allTables(f.f.B.db), beforeReceiver = allTables(receiver.db)
    const { reference, qualified } = await prepareWorking5AssetReferenceFixture(f, receiver.db)
    const stage = await prepareRootRestoreSqlAssetStage5(reference.plan), { value } = stage.assets
    assert.equal(stage.value.selectedAssetsMatchPhysicalSql, true)
    assert.equal(stage.value.installPermit, false)
    const { hash, name } = parseSyncedPortableAssetUri(f.summaryUri)
    assert.ok(f.summaryAliasUri)
    const second = parseSyncedPortableAssetUri(f.summaryAliasUri)
    assert.equal(second.hash, hash)
    assert.notEqual(second.name, name)
    const selected = value.selected.filter(item => item.hash === hash)
    assert.equal(selected.length, 2)
    for (const selection of selected) {
      assert.equal(selection.sourceRef.side, 'source')
      assert.equal(selection.sourceRef.table, 'documents')
      assert.equal(selection.occurrenceIds.length, 2, 'Each selected summary destination has separate genuine job and receipt witnesses')
    }
    assert.deepEqual(value.aliases.filter(item => item.hash === hash).map(item => item.logicalName).sort(), [name, second.name].sort())
    assert.ok(value.aliases.filter(item => item.hash === hash).every(alias => alias.bytes === selected[0].bytes))
    const body = value.selected.filter(item => item.column === 'content' && item.hash === f.digest)
    assert.equal(body.length, 2, 'The physical definition and nested note keep distinct selected occurrences')
    for (const occurrence of body) {
      assert.equal(occurrence.sourceRef.table, 'blocks')
      assert.equal(occurrence.sourceRef.side, 'source')
      assert.equal(occurrence.finalFrom, occurrence.from - 2, 'The real navigation edit removes ./ ahead of the asset')
      assert.equal(occurrence.finalTo, occurrence.to - 2)
      assert.equal(occurrence.occurrenceIds.length, 2)
    }
    assert.equal(value.finalAssetClosureComplete, false)
    assert.equal(value.installPermit, false)
    assert.equal(new Set(value.files.map(item => item.sha256)).size, value.files.length, 'Every selected domain uses one blob per hash')
    const file = value.files.find(item => item.sha256 === hash), bodyFile = value.files.find(item => item.sha256 === f.digest)
    assert.ok(file); assert.ok(bodyFile)
    assert.deepEqual(await readFile(join(stage.assets.directory, referenceContextObjectPath(bodyFile.frame, bodyFile.path))), f.bytes)
    const original = qualified.originalPackage.files.find(item => item.sha256 === hash && item.path.endsWith('/' + f.sourceInput.capsuleId + '/files/' + hash))
    assert.ok(original)
    const path = join(stage.assets.directory, referenceContextObjectPath(file.frame, file.path)), bytes = await readFile(path)
    assert.deepEqual(bytes, await readFile(original.sourcePath))
    assert.equal(capsuleBytesHash(bytes), hash)
    assert.notEqual(path, original.sourcePath)
    await assert.rejects(readRootRestoreSqlAssetStage5({ kind: stage.stage.kind }), /实际合并阶段句柄/)
    const locator = { stageId: stage.stageId, expectedManifestHash: stage.manifestHash }
    const reopened = await reopenRootRestoreSqlAssetStage5(reference.plan, locator)
    assert.deepEqual(reopened.value, stage.value)
    assert.deepEqual(reopened.assets.value, value)
    assert.deepEqual(reopened.sql.value, stage.sql.value)
    const changed = Buffer.from(bytes); changed[0] ^= 1
    await writeFile(path, changed)
    try { await assert.rejects(readRootRestoreSqlAssetStage5(reopened.stage)) }
    finally { await writeFile(path, bytes) }
    assert.deepEqual(allTables(f.f.B.db), beforeSource)
    assert.deepEqual(allTables(receiver.db), beforeReceiver)
  }), { duplicateSummaryAlias: true, prefixBodyNavigation: true }))
