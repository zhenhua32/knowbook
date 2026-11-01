import assert from 'node:assert/strict'
import test from 'node:test'
import { open, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readManagedAssetSource } from '../src/main/managed-asset-source'
import { materializeSyncedExchangeLocal } from '../src/main/sync/synced-publication'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { withSettledPortable3, array, object } from './helpers/settled-portable-owner-fixture'
import { request, applySyncedHostFinal } from './helpers/synced-exchange-conflict-fixture'
import { windowsShortPath } from './helpers/windows-short-path'

test('actual NTFS lower-case and short-tail logical names plus a genuine short root preserve the original complete Main W hash',
  { skip: process.platform !== 'win32' }, t => withSettledPortable3(async saved => {
    if (saved.names.length !== 2) { t.skip('This actual native volume offers no distinct 8.3 file-tail alias'); return }
    const root = await realpath(join(saved.f.B.root, 'storage', 'assets')), shortRoot = windowsShortPath(root)
    if (root.toLowerCase() === shortRoot.toLowerCase()) { t.skip('This actual native volume offers no distinct 8.3 managed-root spelling'); return }
    const originalRootUri = pathToFileURL(root).href, shortRootUri = pathToFileURL(shortRoot).href
    const physical = await open(saved.logicalPath, 'r')
    try {
      const expected = await physical.stat({ bigint: true })
      for (const name of saved.names) {
        const file = join(root, 'attachments', saved.digest.slice(0, 2), saved.digest, name), fd = await open(file, 'r')
        try { const actual = await fd.stat({ bigint: true }); assert.equal(actual.dev, expected.dev); assert.equal(actual.ino, expected.ino) }
        finally { await fd.close() }
        assert.deepEqual(await readFile(file), saved.bytes)
      }
    } finally { await physical.close() }
    const before = await saved.capture()
    const firstJob = before.value.jobs.find(job => job.jobSettingKey === saved.documentJob.row.key); assert.ok(firstJob)
    const originalRecord = firstJob.merged.find(value => value.recordKey === 'doc:' + saved.documentId)!; assert.ok(originalRecord)
    assert.equal(publicationJson(originalRecord.record), publicationJson(saved.oracleRecords.get(originalRecord.recordKey)))
    const firstProjection = object(array(object(firstJob.binding).sources).map(object).find(value => value.recordKey === originalRecord.recordKey)!.portableProjection)
    const firstMappings = array(firstProjection.mappings).map(object).filter(value => value.hash === saved.digest)
    for (const name of saved.names) {
      const mapping = firstMappings.find(value => value.logicalName === name); assert.ok(mapping)
      assert.equal(mapping.physicalName, saved.physical.name)
      assert.notEqual(mapping.logicalName, mapping.physicalName)
    }
    // Preserve the whole-record oracle captured BEFORE this real native-only
    // edit. Main's canonical-profile export is not falsely reported as accepting
    // a short-root URI; its underlying actual managed reader is checked below.
    const edit = request(saved.f.B.db, [saved.documentId], sides => {
      sides[0].summary = sides[0].summary.replaceAll(originalRootUri, shortRootUri)
      for (const block of sides[0].blocks) if (block.type === 'paragraph') block.content = block.content.replaceAll(originalRootUri, shortRootUri)
    })
    assert.equal(applySyncedHostFinal(saved.f.B.db, edit).status, 'applied')
    for (const name of saved.names) {
      const uri = pathToFileURL(join(shortRoot, 'attachments', saved.digest.slice(0, 2), saved.digest, name)).href
      const actual = await readManagedAssetSource(shortRoot, uri)
      assert.equal(actual.hash, saved.digest); assert.equal(actual.name, name); assert.deepEqual(actual.bytes, saved.bytes)
    }
    await assert.rejects(materializeSyncedExchangeLocal(saved.f.B.db, { userDataRoot: saved.f.B.root, target: saved.f.targetConfig }),
      'The unchanged upstream canonical-root lexical limitation is observed, not relaxed')
    const after = await saved.capture(), proof = after.value.jobs.find(job => job.jobSettingKey === saved.documentJob.row.key); assert.ok(proof)
    const record = proof.merged.find(value => value.recordKey === originalRecord.recordKey)!; assert.ok(record)
    assert.deepEqual(Buffer.from(publicationJson(record.record)), Buffer.from(publicationJson(originalRecord.record)))
    assert.equal(publicationHash(publicationJson(record.record)), originalRecord.provenance.resultHash)
    const projection = object(array(object(proof.binding).sources).map(object).find(value => value.recordKey === originalRecord.recordKey)!.portableProjection)
    for (const mapping of array(projection.mappings).map(object)) {
      assert.equal(String(mapping.logicalRootUri).toLowerCase(), shortRootUri.toLowerCase())
      if (mapping.hash === saved.digest) assert.ok(saved.names.includes(String(mapping.logicalName)))
    }
    t.diagnostic(JSON.stringify({ canonicalRoot: root, actualShortRoot: shortRoot, actualShortTail: saved.names[1], wholeRecordHash: originalRecord.provenance.resultHash }))
  }, { nativeAliases: true }))
