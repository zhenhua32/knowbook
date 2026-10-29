// Genuine source/context producer integration with the default 120s file budget.
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { graph3Rows, graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { readSealedCapsule2SourceMaterial } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { withCapturedContext3, nativeContextOriginal3 } from './helpers/capsule2-context3-producer-fixture'

test('genuine archive3 captures complete selected W summary and cross-block body plus empty scope while preserving every original SQL cell',
  { concurrency: false }, () => withCapturedContext3(async saved => {
    const value = await readSealedCapsule2SourceMaterial(saved.saved.source), raw = value.source.sourceContent
    const expected = await nativeContextOriginal3(saved.original, join(saved.f.folder, 'context3-native-oracle'))
    assert.equal(raw.encoding, expected.encoding)
    assert.deepEqual(raw.tables.map(value => value.name), expected.tables.map(value => value.name))
    for (const table of raw.tables) {
      const native = expected.tables.find(value => value.name === table.name)!
      assert.deepEqual(table.columns, native.columns)
      assert.deepEqual(table.rows, native.rows, 'All original rowids/storage classes/raw bytes: ' + table.name)
    }
    const rawUriCells = expected.tables.flatMap(table => table.rows.flatMap(row => row.cells.flatMap((cell, index) => cell[0] === 'text' && graph3Text(cell, expected.encoding).includes(saved.customUri)
      ? [{ table: table.name, sourceRowId: row.sourceRowId, column: table.columns[index] }] : [])))
    assert.deepEqual(rawUriCells, [{ table: 'app_settings', sourceRowId: saved.originalJob.rowid, column: 'value' }])
    const originalJob = graph3Rows(raw, 'app_settings').find(row => row.value.key === saved.originalJob.key)!
    assert.equal(originalJob.value.value, saved.originalJob.value)
    assert.equal(value.source.assets.scopes.some(scope => scope.destinations.some(item => item.uri === saved.customUri)), false)
    const supplement = saved.supplemental
    assert.equal(supplement.sourceContentHash, value.source.assets.sourceContentHash)
    assert.equal(supplement.baseAssetReferencesObservationHash, value.source.assets.observationHash)
    assert.equal(supplement.unsupportedHolders.length, 0)
    assert.equal(supplement.contextBindings.length, 1)
    assert.equal(supplement.settledBindings.length, 0, 'Original pending job is not forged into a settled proof')
    assert.equal(supplement.scopes.length, 2)
    const scope = supplement.scopes.find(scope => scope.source.includes('doc:' + saved.documentId))!
    const empty = supplement.scopes.find(scope => scope.source.includes('doc:' + saved.emptyId))!
    assert.ok(scope); assert.ok(empty); assert.deepEqual(empty.destinations, [])
    assert.equal(scope.destinations.filter(item => item.uri === saved.customUri && item.section === 'body').length, 1)
    assert.equal(scope.destinations.filter(item => item.uri === saved.summaryUri && item.section === 'summary').length, 1,
      'W summary is included even though it was not a custom-summary decision')
    assert.ok(scope.destinations.filter(item => item.uri === saved.summaryUri && item.section === 'body').length >= 2,
      'Whole W body resolves reference definitions and footnotes from another real skeleton block')
    assert.equal(supplement.scopes.some(scope => scope.destinations.some(item => item.uri === saved.opaqueUri)), false,
      'Code and YAML/frontmatter strings never become typed asset occurrences')
    const archive = value.assetArchive
    assert.equal(archive.version, 3)
    if (archive.version !== 3) throw new Error('Explicit archive3 required')
    assert.equal(archive.referenceProvenance.version, 2)
    assert.equal(archive.contextOriginals.version, 2)
    assert.equal(archive.contextOriginals.captures.length, 1)
    assert.equal(archive.contextOriginals.captures[0].state, 'captured')
    if (archive.contextOriginals.captures[0].state !== 'captured') throw new Error('Actual complete context originals required')
    assert.deepEqual(archive.contextOriginals.captures[0].fileHashes, saved.expectedContextFiles.map(file => file.sha256), 'Every fixed inputs/job/ready/manifest/object/asset role binds its actual original bytes')
    const expectedUnique = [...new Map(saved.expectedContextFiles.map(file => [file.sha256, { sha256: file.sha256, bytes: file.bytes }])).values()].sort((a, b) => a.sha256 < b.sha256 ? -1 : 1)
    assert.deepEqual(archive.contextOriginals.files, expectedUnique)
    assert.equal(archive.assetScopeSupplement.observationHash, supplement.observationHash)
    assert.equal(archive.assetScopeSupplement.scopeCount, 2)
    assert.equal(archive.assetScopeSupplement.referenceCount, supplement.scopes.reduce((count, scope) => count + scope.destinations.length, 0))
    assert.equal(archive.referenceUris.includes(saved.customUri), false, 'Existing referenceUris/referenceCount retain the original base observation meaning')
    assert.ok(archive.assetScopeSupplement.referenceUris.includes(saved.customUri))
    assert.equal(archive.referenceUris.includes(saved.opaqueUri), false); assert.equal(archive.assetScopeSupplement.referenceUris.includes(saved.opaqueUri), false)
    const combinedUris = [...new Set([...archive.referenceUris, ...archive.assetScopeSupplement.referenceUris])].sort()
    assert.equal(archive.referenceProvenance.entries.length, combinedUris.length)
    assert.deepEqual(archive.referenceProvenance.entries.map(entry => entry[0]), combinedUris.map((_uri, index) => index))
    assert.equal(archive.coverage.supplementalCustomMergeScopesCaptured, true)
    assert.equal(archive.coverage.allAssetScopesCaptured, false)
    assert.equal(archive.coverage.finalAssetClosureComplete, false)
    assert.equal(archive.coverage.semanticSelectionPermission, false)
    assert.equal(archive.coverage.installPermit, false); assert.equal(archive.permit, false)
    for (const file of archive.contextOriginals.files) assert.equal((await readFile(join(saved.archiveDirectory, 'contexts', file.sha256))).length, file.bytes)
    assert.equal(value.materialHash, saved.saved.info.manifest.sourceMaterialHash)
    assert.equal(value.assetArchiveHash, saved.saved.info.manifest.assetArchiveHash)
  }))

test('genuine archive3 retains a descriptor-bound pending asset only in sealed context originals without inventing a managed alias proof',
  { concurrency: false }, () => withCapturedContext3(async saved => {
    const archive = saved.saved.value.assetArchive
    assert.equal(archive.version, 3)
    if (archive.version !== 3) throw new Error('Explicit archive3 required')
    assert.equal(archive.tree.files.some(file => file.hash === saved.customHash), false)
    assert.equal(archive.tree.aliases.some(alias => alias.hash === saved.customHash), false)
    assert.equal(archive.contextOriginals.files.some(file => file.sha256 === saved.customHash && file.bytes === saved.customBytes.length), true)
    assert.deepEqual(await readFile(join(saved.archiveDirectory, 'contexts', saved.customHash)), saved.customBytes)
    const pending = saved.supplemental.pendingPortableBindings.filter(binding => binding.sourceUri === saved.customUri)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].operationId, saved.operationId); assert.equal(pending[0].attemptId, saved.job.attemptId)
    assert.equal(pending[0].hash, saved.customHash); assert.equal(pending[0].bytes, saved.customBytes.length)
    assert.equal(archive.referenceUris.includes(saved.customUri), false)
    assert.ok(archive.assetScopeSupplement.referenceUris.includes(saved.customUri))
    const combinedUris = [...new Set([...archive.referenceUris, ...archive.assetScopeSupplement.referenceUris])].sort()
    assert.equal(archive.referenceProvenance.entries.length, combinedUris.length)
    const uriIndex = combinedUris.indexOf(saved.customUri)
    assert.ok(uriIndex >= 0)
    assert.deepEqual(archive.referenceProvenance.entries.find(entry => entry[0] === uriIndex), [uriIndex, 'unresolved', 'missing-managed-alias'])
    assert.equal(archive.coverage.supplementalCustomMergeScopesCaptured, true)
    assert.equal(archive.coverage.finalAssetClosureComplete, false)
    assert.equal(archive.coverage.installPermit, false)
    assert.equal((await readSealedCapsule2SourceMaterial(saved.saved.source)).materialHash, saved.saved.value.materialHash)
  }, { withoutManagedCustomAliases: true }))
