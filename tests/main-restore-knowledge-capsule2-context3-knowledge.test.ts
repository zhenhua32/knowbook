import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AttachmentStore } from '../src/main/attachments'
import { graph3Rows } from '../src/main/database/restore-knowledge-graph3-data'
import { readSealedCapsule2SourceMaterial } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { bindCapsule2MergeContextInventoryToSource3 } from '../src/main/database/restore-knowledge-capsule2-merge-contexts'
import { replayRoot3MergeContext3, type Root3MergeContextBytes3 } from '../src/main/database/restore-knowledge-assets3-context'
import { parseExchangeStored, validateExchangeJob } from '../src/main/sync/synced-exchange-model'
import { knowledgeSourceHash, validateKnowledgeSource } from '../src/main/sync/synced-exchange-knowledge-model'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { validateSyncedProtocol5Snapshot } from '../src/main/sync/synced-protocol5-model'
import { withKnowledge, storedReceipt, unchangedDenial } from './helpers/synced-exchange-knowledge-fixture'
import { preparePendingContext3, nativeContextOriginal3 } from './helpers/capsule2-context3-producer-fixture'

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function snapshot(value: unknown) {
  const stored = object(value)
  assert.ok(Array.isArray(stored.records))
  const rows = stored.records.map(value => {
    const row = object(value)
    assert.equal(typeof row.key, 'string'); assert.equal(typeof row.hash, 'string')
    assert.equal(publicationHash(publicationJson(row.record)), row.hash)
    return { key: row.key as string, record: row.record }
  })
  return validateSyncedProtocol5Snapshot(stored.manifest, rows)
}

test('genuine archive3 replays a real knowledge format5 custom W from immutable localPhysical and absence knowledge without upgrading any restore gate',
  () => withKnowledge(async f => {
    // withKnowledge has an independent A peer; its inherited assets manager
    // belongs to the original sender S. Import these real bytes into A itself.
    const saved = await preparePendingContext3({ ...f,
      assets: new AttachmentStore(join(f.A.root, 'storage', 'assets')) }, false)
    assert.equal(saved.job.version, 5, 'Only the real knowledge resolver may produce this immutable version5 job')
    if (saved.job.version !== 5) throw new Error('Actual Main knowledge job5 required')
    assert.equal(saved.job.plannerVersion, 'knowledge-conflicts-v1')
    assert.equal(knowledgeSourceHash(saved.job.knowledgeSource), saved.job.knowledgeHash)
    assert.ok(saved.job.knowledgeSource.deleted.some(value => value.key === f.denialKey))
    assert.ok(saved.job.knowledgeSource.absentBaseline.some(value => value.key === f.denialKey))

    const value = await readSealedCapsule2SourceMaterial(saved.saved.source), raw = value.source.sourceContent, archive = value.assetArchive
    assert.equal(archive.version, 3)
    if (archive.version !== 3) throw new Error('Explicit genuine archive3 required')
    const native = await nativeContextOriginal3(saved.original, join(f.folder, 'knowledge-context3-native-oracle'))
    assert.equal(raw.encoding, native.encoding)
    assert.deepEqual(raw.tables.map(table => table.name), native.tables.map(table => table.name))
    for (const table of raw.tables) {
      const original = native.tables.find(value => value.name === table.name)!
      assert.deepEqual(table.columns, original.columns)
      assert.deepEqual(table.rows, original.rows, 'Original native rowid/storage class/cells remain exact: ' + table.name)
    }
    const originalJobs = graph3Rows(raw, 'app_settings').filter(row => row.value.key === saved.originalJob.key)
    assert.equal(originalJobs.length, 1)
    assert.equal(originalJobs[0].original.sourceRowId, saved.originalJob.rowid)
    assert.equal(originalJobs[0].value.value, saved.originalJob.value)
    assert.equal(graph3Rows(raw, 'synced_operations').some(row => row.value.client_operation_id === saved.operationId), false,
      'The later live format5 receipt cannot replace the pending immutable source')

    const captures = bindCapsule2MergeContextInventoryToSource3(archive.contextOriginals, raw)
    assert.equal(captures.length, 1)
    const captured = captures[0]
    assert.equal(captured.state, 'captured')
    if (captured.state !== 'captured') throw new Error('Actual immutable knowledge context files required')
    assert.equal(captured.locator.version, 5)
    const files = new Map(captured.files.map(file => [file.name, file]))
    const read = async (name: string) => {
      const file = files.get(name); assert.ok(file)
      const bytes = await readFile(join(saved.archiveDirectory, 'contexts', file.sha256))
      assert.equal(bytes.length, file.bytes); assert.equal(publicationHash(bytes), file.sha256)
      return bytes
    }
    const inputBytes = await read('inputs.json'), jobBytes = await read('job.json')
    const input = object(parseExchangeStored(inputBytes.toString('utf8'))), originalJob = validateExchangeJob(parseExchangeStored(jobBytes.toString('utf8')))
    assert.equal(input.version, 5); assert.equal(input.plannerVersion, 'knowledge-conflicts-v1')
    assert.deepEqual(originalJob, saved.job)
    assert.equal(input.knowledgeHash, saved.job.knowledgeHash)
    assert.deepEqual(validateKnowledgeSource(input.knowledgeSource), saved.job.knowledgeSource)
    assert.equal(publicationHash(publicationJson({ inputHash: publicationHash(inputBytes), descriptor: saved.job.descriptor })), saved.job.spoolHash)
    const physical = snapshot(input.localPhysical), knowledge = snapshot(input.local), next = snapshot(object(input.plan).nextRemote)
    assert.equal(publicationHash(publicationJson(physical.manifest)), saved.job.knowledgeSource.localPhysicalManifestHash)
    assert.equal(publicationHash(publicationJson(knowledge.manifest)), saved.job.knowledgeSource.localKnowledgeManifestHash)
    assert.equal(physical.records.some(row => row.key === f.denialKey), false)
    assert.equal(knowledge.records.find(row => row.key === f.denialKey)?.hash,
      saved.job.knowledgeSource.deleted.find(row => row.key === f.denialKey)!.tombstoneHash)

    const context: Root3MergeContextBytes3 = { operationId: saved.operationId, attemptId: saved.job.attemptId,
      inputBytes, jobBytes, readyBytes: await read('ready.json'), manifestBytes: await read('manifest.json'), objects: [], assets: [] }
    const objects = [], assets = []
    for (const item of new Map(saved.job.descriptor.next.objects.map(item => [item.hash, item])).values())
      objects.push({ hash: item.hash, bytes: await read(item.path) })
    for (const item of saved.job.descriptor.next.assets) assets.push({ hash: item.hash, names: item.names, bytes: await read(item.path) })
    const replay = replayRoot3MergeContext3(raw, captured.locator, { ...context, objects, assets })
    assert.equal(replay.job.version, 5)
    if (replay.job.version !== 5) throw new Error('The genuine context must reach the version5 replay branch')
    assert.deepEqual(replay.job.knowledgeSource, saved.job.knowledgeSource)
    assert.equal(replay.job.knowledgeHash, saved.job.knowledgeHash)
    assert.equal(replay.merged.length, 2)
    for (const selected of replay.merged) {
      const expected = next.records.find(row => row.key === selected.recordKey); assert.ok(expected)
      assert.deepEqual(selected.record, expected.record, 'Complete W must equal the genuine original planner output, including unchanged fields')
      assert.equal(publicationHash(publicationJson(selected.record)), selected.provenance.resultHash)
    }
    const chosen = replay.merged.find(row => row.recordKey === 'doc:' + saved.documentId)!
    const empty = replay.merged.find(row => row.recordKey === 'doc:' + saved.emptyId)!
    assert.ok(chosen); assert.ok(empty)
    assert.equal(chosen.record.kind, 'document'); assert.equal(empty.record.kind, 'document')
    if (chosen.record.kind !== 'document' || empty.record.kind !== 'document') throw new Error('Actual selected document W required')
    assert.ok(chosen.record.content.blocks.some(block => block.content === saved.customText))
    assert.ok(chosen.record.content.summary.includes(saved.summaryUri), 'Noncustom summary remains part of complete W')
    assert.ok(chosen.record.content.blocks.some(block => block.type === 'code' && block.content.includes(saved.opaqueUri)))
    assert.ok(chosen.record.content.blocks.some(block => block.type === 'frontmatter' && block.content.includes(saved.opaqueUri)))
    assert.ok(empty.record.content.blocks.some(block => block.content === saved.emptyText))

    const supplement = saved.supplemental
    assert.equal(supplement.contextBindings.length, 1); assert.equal(supplement.contextBindings[0].contextHash, replay.contextHash)
    assert.equal(supplement.contextBindings[0].locator.version, 5)
    assert.equal(supplement.unsupportedHolders.length, 0); assert.equal(supplement.settledBindings.length, 0)
    assert.equal(supplement.scopes.length, 2)
    assert.ok(supplement.scopes.find(scope => scope.source.includes('doc:' + saved.documentId))!.destinations.some(item => item.uri === saved.customUri))
    assert.deepEqual(supplement.scopes.find(scope => scope.source.includes('doc:' + saved.emptyId))!.destinations, [])
    assert.equal(archive.assetScopeSupplement.observationHash, supplement.observationHash)
    assert.equal(value.materialHash, saved.saved.value.materialHash)
    assert.equal(archive.coverage.supplementalCustomMergeScopesCaptured, true)
    for (const gate of [archive.coverage.allAssetScopesCaptured, archive.coverage.finalAssetClosureComplete,
      archive.coverage.semanticSelectionPermission, archive.coverage.acceptedCoverage, archive.coverage.effective, archive.coverage.installPermit,
      archive.coverage.wholeContextInputsMemoryBounded, archive.coverage.completeV3AssetAdapter,
      archive.certified, archive.semanticValidationComplete, archive.permit,
      value.certified, value.semanticValidationComplete, value.acceptedCoverage, value.effective, value.permit]) assert.equal(gate, false)
    storedReceipt(f.B.db, saved.operationId, 5)
    unchangedDenial(f)
  }))
