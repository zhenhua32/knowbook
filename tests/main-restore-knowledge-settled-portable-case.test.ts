import assert from 'node:assert/strict'
import test from 'node:test'
import { open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { materializeSyncedExchangeLocal, readSyncedExchangeLocalMaterial } from '../src/main/sync/synced-publication'
import { publicationHash, publicationJson, publicationRecordKey } from '../src/main/sync/synced-publication-model'
import { readManagedAssetSource } from '../src/main/managed-asset-source'
import { readCapsule2SettledPortableSource3 } from '../src/main/database/restore-knowledge-assets3-settled-portable-owner'
import { withSettledPortable3, array, object } from './helpers/settled-portable-owner-fixture'
import { request, applySyncedHostFinal } from './helpers/synced-exchange-conflict-fixture'

test('actual NTFS file URI case alone changes the complete portable W despite the same captured physical asset identity',
  { skip: process.platform !== 'win32' }, () => withSettledPortable3(async saved => {
    // nativeAliases does not require a distinct 8.3 alias: names[0] is always
    // the authored lower-case long tail, backed by the actual mixed-case file.
    const before = await saved.capture(), key = 'doc:' + saved.documentId
    const job = before.value.jobs.find(value => value.jobSettingKey === saved.documentJob.row.key); assert.ok(job)
    const original = job.merged.find(value => value.recordKey === key); assert.ok(original)
    assert.equal(publicationJson(original.record), publicationJson(saved.oracleRecords.get(key)))
    const selected = array(object(job.binding).sources).map(object).find(value => value.recordKey === key)!
    assert.deepEqual(selected.source, ['documents', saved.documentId, 'complete-original-protocol-record'])
    const projection = object(selected.portableProjection)
    const oldUri = pathToFileURL(saved.logicalPath).href
    const mapping = array(projection.mappings).map(object).find(value => value.sourceUri === oldUri); assert.ok(mapping)
    assert.equal(mapping.logicalName, saved.logicalName)
    assert.equal(mapping.physicalName, saved.physical.name)
    assert.notEqual(mapping.logicalName, mapping.physicalName)

    const changedName = saved.logicalName.toUpperCase()
    assert.notEqual(changedName, saved.logicalName)
    const changedPath = join(dirname(saved.logicalPath), changedName), changedUri = pathToFileURL(changedPath).href
    const lower = await open(saved.logicalPath, 'r'), upper = await open(changedPath, 'r')
    try {
      const first = await lower.stat({ bigint: true }), second = await upper.stat({ bigint: true })
      assert.equal(second.dev, first.dev); assert.equal(second.ino, first.ino)
      assert.equal(second.size, first.size)
    } finally { await lower.close(); await upper.close() }
    assert.deepEqual(await readFile(changedPath), saved.bytes)

    let changedHolders = 0
    const edit = request(saved.f.B.db, [saved.documentId], sides => {
      for (const block of sides[0].blocks) if (block.type === 'paragraph' && block.content.includes(oldUri)) {
        const changed = block.content.replaceAll(oldUri, changedUri)
        assert.notEqual(changed, block.content); block.content = changed; changedHolders++
      }
    })
    assert.ok(changedHolders > 0)
    assert.equal(applySyncedHostFinal(saved.f.B.db, edit).status, 'applied')
    const source = await readManagedAssetSource(join(saved.f.B.root, 'storage', 'assets'), changedUri)
    assert.equal(source.hash, saved.digest); assert.equal(source.name, changedName); assert.deepEqual(source.bytes, saved.bytes)

    const actualHandle = await materializeSyncedExchangeLocal(saved.f.B.db, { userDataRoot: saved.f.B.root, target: saved.f.targetConfig })
    const actual = readSyncedExchangeLocalMaterial(actualHandle); assert.ok(actual)
    const changedRecord = actual.records.find(record => publicationRecordKey(record) === key); assert.ok(changedRecord)
    assert.notEqual(publicationJson(changedRecord), publicationJson(original.record))
    assert.notEqual(publicationHash(publicationJson(changedRecord)), original.provenance.resultHash,
      'The genuine exporter retains the authored logical filename, even when both native paths open the same FD')

    // A fresh genuine base proof still proves the file. The owner must reject
    // this current candidate on the complete immutable W hash, rather than
    // substitute the canonical physical filename to recover the former hash.
    const after = await saved.capture(), archive = after.sealed.value.assetArchive
    assert.equal(archive.version, 2)
    if (archive.version !== 2) throw new Error('This independent case scenario must capture the genuine base-v2 proof')
    const index = archive.referenceUris.indexOf(changedUri); assert.ok(index >= 0)
    assert.equal(archive.referenceProvenance.entries[index][1], 'file')
    assert.equal(after.value.jobs.some(value => value.jobSettingKey === saved.documentJob.row.key), false)
    assert.ok(after.value.notProven.some(value => value.jobSettingKey === saved.documentJob.row.key))
    assert.deepEqual(await readCapsule2SettledPortableSource3(before.owner), before.value,
      'The earlier sealed original remains independently readable after the live host edit')
    assert.equal(after.value.spoolSkipPermission, false); assert.equal(after.value.installPermit, false)
  }, { nativeAliases: true }))
