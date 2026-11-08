import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { withPendingWorkingSource5 } from './helpers/working5-automatic-source-fixture'
import { prepareWorking5AssetAuthorityFixture } from './helpers/working5-asset-authority-fixture'
import { readRootRestoreWorkingAssetBlob5 } from '../src/main/database/restore-knowledge-working-asset-authority5'

test('pending Working5 uses the original job asset slot and its own qualified frame even when current has the same bytes',
  { concurrency: false }, () => withPendingWorkingSource5(async f => {
    const prepared = await prepareWorking5AssetAuthorityFixture(f), { value } = prepared
    assert.deepEqual(value.roles.map(role => role.role), ['source'])
    const occurrence = value.roles[0].occurrences.find(item => item.destination.uri === f.portable && item.destination.kind === 'definition')
    if (occurrence?.status !== 'sealed-blob' || occurrence.evidence.kind !== 'pending-captured-working-context')
      throw new Error('Expected the genuine pending W definition occurrence')
    assert.equal(occurrence.jobSettingKey, f.row.key)
    assert.equal(occurrence.evidence.originalPath, 'assets/' + f.digest)
    assert.equal(occurrence.logicalName, f.remoteAsset.name)
    assert.deepEqual(occurrence.file.frame, [])
    assert.match(occurrence.file.path, new RegExp('/' + f.sourceInput.capsuleId + '/contexts/files/' + f.digest + '$'))
    assert.equal(value.finalAssetClosureComplete, false)
    assert.equal(value.installPermit, false)
    const duplicateInCurrent = prepared.qualified.originalPackage.files.find(file => file.sha256 === f.digest
      && file.path.endsWith('/' + prepared.current.value.capsuleId + '/files/' + f.digest))
    assert.ok(duplicateInCurrent)
    assert.notEqual(duplicateInCurrent.path, occurrence.file.path)
    const selected = await readRootRestoreWorkingAssetBlob5(prepared.authority, occurrence.id)
    assert.equal(selected.status, 'original-blob')
    if (selected.status === 'original-blob') assert.deepEqual(selected.bytes, f.bytes)
    await assert.rejects(readRootRestoreWorkingAssetBlob5({ kind: prepared.authority.kind }, occurrence.id), /实际 owner/)

    const actual = prepared.qualified.originalPackage.files.find(file => file.path === occurrence.file.path && !file.frame.length)
    assert.ok(actual)
    const original = await readFile(actual.sourcePath), changed = Buffer.from(original)
    changed[0] ^= 1
    await writeFile(actual.sourcePath, changed)
    try { await assert.rejects(readRootRestoreWorkingAssetBlob5(prepared.authority, occurrence.id)) }
    finally { await writeFile(actual.sourcePath, original) }
  }))
