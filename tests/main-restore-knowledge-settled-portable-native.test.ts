import assert from 'node:assert/strict'
import test from 'node:test'
import { open, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readManagedAssetSource } from '../src/main/managed-asset-source'
import { materializeSyncedExchangeLocal, readSyncedExchangeLocalMaterial } from '../src/main/sync/synced-publication'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { withSettledPortable3, array, object } from './helpers/settled-portable-owner-fixture'
import { request, applySyncedHostFinal } from './helpers/synced-exchange-conflict-fixture'
import { windowsShortPath } from './helpers/windows-short-path'

type NativeMapping = { sourceUri: string; targetUri: string; hash: string; logicalName: string }
type NativeBody = { summary: string; blocks: readonly { type: string; content: string }[] }

function exactNativeMappings(values: readonly Record<string, unknown>[], targetRoot: string): NativeMapping[] {
  const mappings = values.map(value => {
    const sourceUri = value.sourceUri, hash = value.hash, logicalName = value.logicalName
    assert.ok(typeof sourceUri === 'string' && new URL(sourceUri).protocol === 'file:')
    assert.ok(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
    assert.ok(typeof logicalName === 'string' && logicalName.length > 0)
    const targetUri = pathToFileURL(join(targetRoot, 'attachments', hash.slice(0, 2), hash, logicalName)).href
    assert.notEqual(targetUri, sourceUri, 'The real root-spelling edit must change every exact captured native URI')
    return { sourceUri, targetUri, hash, logicalName }
  })
  assert.ok(mappings.length > 0)
  assert.equal(new Set(mappings.map(mapping => mapping.sourceUri)).size, mappings.length)
  return mappings
}

function rewriteExactNativeBody(side: NativeBody, mappings: readonly NativeMapping[]): number {
  const counts = new Map(mappings.map(mapping => [mapping.sourceUri, 0]))
  const before = publicationJson({ summary: side.summary, paragraphs: side.blocks.filter(block => block.type === 'paragraph').map(block => block.content) })
  const rewrite = (text: string): string => {
    for (const mapping of mappings) {
      counts.set(mapping.sourceUri, counts.get(mapping.sourceUri)! + text.split(mapping.sourceUri).length - 1)
      text = text.replaceAll(mapping.sourceUri, mapping.targetUri)
    }
    return text
  }
  side.summary = rewrite(side.summary)
  for (const block of side.blocks) if (block.type === 'paragraph') block.content = rewrite(block.content)
  for (const [uri, count] of counts) assert.ok(count > 0, 'Every genuine selected URI occurs in the real editable summary/paragraph scope: ' + uri)
  assert.notEqual(publicationJson({ summary: side.summary, paragraphs: side.blocks.filter(block => block.type === 'paragraph').map(block => block.content) }), before)
  return [...counts.values()].reduce((total, count) => total + count, 0)
}

async function assertSameNativeFiles(mappings: readonly NativeMapping[], targetRoot: string): Promise<void> {
  for (const mapping of mappings) {
    const source = await open(new URL(mapping.sourceUri), 'r')
    try {
      const target = await open(new URL(mapping.targetUri), 'r')
      try {
        const expected = await source.stat({ bigint: true }), actual = await target.stat({ bigint: true })
        assert.equal(actual.dev, expected.dev); assert.equal(actual.ino, expected.ino)
      } finally { await target.close() }
    } finally { await source.close() }
    const actual = await readManagedAssetSource(targetRoot, mapping.targetUri)
    assert.equal(actual.hash, mapping.hash); assert.equal(actual.name, mapping.logicalName)
    assert.deepEqual(actual.bytes, await readFile(new URL(mapping.sourceUri)))
  }
}

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
    // Force a real same-file root spelling that differs from canonical realpath.
    // The immutable Main whole-record oracle predates every native-only edit.
    // Keep the actual publication profile's root spelling. On a CI runner
    // tmpdir can already contain a genuine RUNNER~1 alias; changing that to
    // realpath's long name also crosses the unchanged upstream lexical root
    // boundary, before this test can check the intended case-only edit.
    const profileAssetRoot = join(saved.f.B.root, 'storage', 'assets')
    const caseRoot = profileAssetRoot.replace(/[a-z]/g, letter => letter.toUpperCase()), caseRootUri = pathToFileURL(caseRoot).href
    assert.notEqual(caseRootUri, originalRootUri)
    assert.equal((await realpath(caseRoot)).toLowerCase(), root.toLowerCase())
    const caseMappings = exactNativeMappings(array(firstProjection.mappings).map(object), caseRoot)
    await assertSameNativeFiles(caseMappings, caseRoot)
    let caseChanges = 0
    const caseEdit = request(saved.f.B.db, [saved.documentId], sides => { caseChanges = rewriteExactNativeBody(sides[0], caseMappings) })
    assert.ok(caseChanges > 0)
    assert.equal(applySyncedHostFinal(saved.f.B.db, caseEdit).status, 'applied')
    const caseMaterial = readSyncedExchangeLocalMaterial(await materializeSyncedExchangeLocal(saved.f.B.db,
      { userDataRoot: saved.f.B.root, target: saved.f.targetConfig })); assert.ok(caseMaterial)
    const caseMainRecord = caseMaterial.records.find(value => value.kind === 'document' && value.id === saved.documentId); assert.ok(caseMainRecord)
    assert.equal(publicationJson(caseMainRecord), publicationJson(originalRecord.record))
    const caseCaptured = await saved.capture(), caseJob = caseCaptured.value.jobs.find(job => job.jobSettingKey === saved.documentJob.row.key); assert.ok(caseJob)
    const caseRecord = caseJob.merged.find(value => value.recordKey === originalRecord.recordKey); assert.ok(caseRecord)
    assert.equal(publicationJson(caseRecord.record), publicationJson(originalRecord.record))
    assert.equal(publicationHash(publicationJson(caseRecord.record)), originalRecord.provenance.resultHash)
    const caseProjection = object(array(object(caseJob.binding).sources).map(object).find(value => value.recordKey === originalRecord.recordKey)!.portableProjection)
    const capturedCaseMappings = array(caseProjection.mappings).map(object)
    for (const mapping of capturedCaseMappings) assert.equal(mapping.logicalRootUri, caseRootUri)
    // Reproduce the old canonical-prefix bug against this real edited Main
    // document. Its noop is the red control, never the expected short-root edit.
    const oldPrefixEdit = request(saved.f.B.db, [saved.documentId], sides => {
      sides[0].summary = sides[0].summary.replaceAll(originalRootUri, shortRootUri)
      for (const block of sides[0].blocks) if (block.type === 'paragraph') block.content = block.content.replaceAll(originalRootUri, shortRootUri)
    })
    assert.equal(applySyncedHostFinal(saved.f.B.db, oldPrefixEdit).status, 'noop', 'Canonical prefix replacement misses the actual same-file case spelling')
    // Use each genuine captured source URI, hash and ORIGINAL logical name;
    // neither a canonical prefix nor the physical tree name determines it.
    const shortMappings = exactNativeMappings(capturedCaseMappings, shortRoot)
    await assertSameNativeFiles(shortMappings, shortRoot)
    let shortChanges = 0
    const edit = request(saved.f.B.db, [saved.documentId], sides => { shortChanges = rewriteExactNativeBody(sides[0], shortMappings) })
    assert.ok(shortChanges > 0)
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
    t.diagnostic(JSON.stringify({ canonicalRoot: root, actualCaseRoot: caseRoot, oldCanonicalPrefixStatus: 'noop', caseChanges, shortChanges,
      actualShortRoot: shortRoot, actualShortTail: saved.names[1], wholeRecordHash: originalRecord.provenance.resultHash }))
  }, { nativeAliases: true }))
