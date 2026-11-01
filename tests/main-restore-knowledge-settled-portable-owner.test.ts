import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { readCapsule2SettledPortableSource3, assertCapsule2SettledPortableSourceOwner3 } from '../src/main/database/restore-knowledge-assets3-settled-portable-owner'
import { restoreInventory } from '../src/main/database/restore-safety-files'
import { withSettledPortable3, object, array } from './helpers/settled-portable-owner-fixture'
import { nativeContextOriginal3 } from './helpers/capsule2-context3-producer-fixture'

test('genuine settled asset W matches the complete Main portable oracle with summary catalog and group binding facts after real spool retirement',
  () => withSettledPortable3(async saved => {
    for (const version of [2, 3] as const) {
      const captured = await saved.capture(version), evidence = await readCapsule2SettledPortableSource3(captured.owner)
      const native = await nativeContextOriginal3(captured.original, join(saved.f.folder, 'settled-native-oracle-' + version))
      const raw = captured.sealed.value.source.sourceContent
      assert.equal(raw.encoding, native.encoding)
      assert.deepEqual(raw.tables.map(table => table.name), native.tables.map(table => table.name))
      for (const table of raw.tables) {
        const actual = native.tables.find(value => value.name === table.name)!; assert.deepEqual(table.columns, actual.columns)
        assert.deepEqual(table.rows, actual.rows, 'Every original rowid/storage class/raw cell remains exact')
      }
      const sourceAsset = join(captured.original.info.recoveryDirectory, 'knowledge-complete-assets-v2', captured.sealed.value.capsuleId, 'files', saved.digest)
      assert.deepEqual(await readFile(sourceAsset), saved.bytes)
      assert.deepEqual(evidence, captured.value)
      assert.deepEqual(await restoreInventory(captured.original.info.originalDirectory), captured.original.inventory)
      assertCapsule2SettledPortableSourceOwner3(captured.owner, captured.sealed.source)
      assert.equal(evidence.binding.sourceManifestHash, captured.sealed.info.manifestHash)
      assert.equal(evidence.binding.sourceMaterialHash, captured.sealed.value.materialHash)
      assert.equal(evidence.binding.assetArchiveHash, captured.sealed.value.assetArchiveHash)
      for (const original of saved.jobs) {
        const proof = evidence.jobs.find(value => value.jobSettingKey === original.row.key); assert.ok(proof)
        for (const item of proof.merged) {
          const expected = saved.oracleRecords.get(item.recordKey); assert.ok(expected)
          const bytes = Buffer.from(publicationJson(item.record)), oracle = Buffer.from(publicationJson(expected))
          assert.deepEqual(bytes, oracle, 'Every field and canonical byte must match actual Main materialize output')
          assert.equal(publicationHash(bytes), item.provenance.resultHash)
        }
      }
      const docJob = evidence.jobs.find(value => value.jobSettingKey === saved.documentJob.row.key)!, binding = object(docJob.binding)
      const source = array(binding.sources).map(object).find(value => value.recordKey === 'doc:' + saved.documentId)!
      assert.deepEqual(source.source, ['documents', saved.documentId, 'complete-original-protocol-record'])
      const projection = object(source.portableProjection)
      assert.equal(projection.catalogId, saved.f.B.defaultId)
      assert.equal(projection.portableRecordHash, docJob.merged.find(value => value.recordKey === 'doc:' + saved.documentId)!.provenance.resultHash)
      assert.notEqual(projection.originalRecordHash, projection.portableRecordHash,
        'This positive must exercise native-to-portable projection, not another preexisting portable W')
      const mappings = array(projection.mappings).map(object)
      assert.ok(mappings.some(value => value.hash === saved.digest && value.logicalName === saved.logicalName))
      assert.equal(mappings.some(value => value.sourceUri === saved.opaqueUri || value.portableUri === saved.opaqueUri), false)
      const doc = docJob.merged.find(value => value.recordKey === 'doc:' + saved.documentId)!.record
      assert.equal(doc.kind, 'document'); if (doc.kind !== 'document') throw new Error('Actual document W required')
      assert.ok(doc.content.summary.startsWith('Unchanged W summary'))
      assert.ok(doc.content.blocks.some(block => block.content.includes(saved.customText)))
      const view = doc.content.blocks.find(block => block.type === 'database-view'); assert.ok(view)
      const payload = parseDatabaseViewPayload(view.content)
      assert.equal(payload.databaseId, 'catalog'); assert.equal(payload.config.query, saved.opaque)
      assert.ok(doc.content.blocks.some(block => block.type === 'code' && block.content === saved.opaque))
      const group = evidence.jobs.flatMap(job => job.merged).find(value => value.recordKey === 'group:' + saved.groupId)!.record
      assert.equal(group.kind, 'synced-group'); if (group.kind !== 'synced-group') throw new Error('Actual group W required')
      assert.ok(group.bindings.length > 0)
      for (const link of group.bindings) {
        const block: (typeof group.blocks)[number] | undefined = group.blocks.find(candidate => candidate.id === link.blockId); assert.ok(block)
        assert.equal(block.content.slice(link.from, link.to), link.raw)
      }
      const archive = captured.sealed.value.assetArchive
      assert.equal(archive.version, version)
      if (archive.version === 3) assert.equal(archive.coverage.supplementalCustomMergeScopesCaptured, false,
        'The old archive3 locator/observer is not silently upgraded by the new separate owner')
      if (!('coverage' in archive)) throw new Error('Base provenance required')
      assert.equal(archive.coverage.allAssetScopesCaptured, false); assert.equal(archive.coverage.installPermit, false)
      for (const gate of [evidence.rawOriginalRewritten, evidence.sourceArchiveCoverageChanged, evidence.spoolSkipPermission,
        evidence.semanticSelectionPermission, evidence.assetByteClosureComplete, evidence.acceptedCoverage, evidence.effective, evidence.permit, evidence.installPermit]) assert.equal(gate, false)
    }
  }, { group: true }))
