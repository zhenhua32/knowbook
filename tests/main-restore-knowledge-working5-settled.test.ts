import assert from 'node:assert/strict'
import test from 'node:test'
import { publicationJson } from '../src/main/sync/synced-publication-model'
import { readSealedCapsule2SourceWorkingOriginals5 } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { withoutSettledSpoolProbes4 } from './helpers/settled-context4-fixture'
import { withSettledWorkingSource5 } from './helpers/working5-automatic-source-fixture'

test('archive5 settled job4 preserves both original holders and exact whole W without probing either native spool spelling',
  { concurrency: false }, () => withSettledWorkingSource5(async f => {
    assert.deepEqual(f.spoolProbeAttempts, [])
    const bound = f.working.manifest.settledBindings.find(item => item.jobSettingKey === f.row.key); assert.ok(bound)
    assert.equal(f.working.manifest.captures.some(item => item.jobSettingKey === f.row.key), false)
    const record = f.working.records.find(item => item.jobSettingKey === f.row.key && item.recordKey === 'doc:' + f.documentId); assert.ok(record)
    assert.equal(publicationJson(record.record), publicationJson(f.oracle.record)); assert.deepEqual(record.provenance, f.oracle.merge)
    const scopes = f.working.observation.scopes.filter(scope => scope.jobSettingKey === f.row.key)
    assert.equal(scopes.length, 2); assert.ok(scopes.every(scope => scope.family === 4 && scope.evidenceKind === 'settled-original-working-record'))
    assert.ok(scopes.some(scope => scope.source.includes('app_settings')))
    assert.ok(scopes.some(scope => scope.source.includes('synced_operations')))
    for (const scope of scopes) {
      assert.ok(scope.destinations.some(item => item.section === 'summary' && item.uri === f.summaryUri),'The complete settled W retains its original summary destination')
      assert.ok(scope.destinations.some(item => item.section === 'body' && item.kind === 'definition' && item.uri === f.portable),'The complete settled W retains its projected definition destination')
      assert.ok(scope.destinations.some(item => item.section === 'body' && item.kind === 'image' && item.uri === f.portable),
        'The complete settled W retains its projected image destination')
      assert.equal(scope.destinations.some(item => item.uri === f.opaque), false,'Opaque configuration never supplies a semantic destination')
    }
    const mappings=f.working.observation.settledPortableBindings.filter(item=>item.portableUri===f.portable)
    assert.ok(mappings.length>=2,'Both original holders retain the genuine native-to-portable binding')
    assert.ok(mappings.some(item=>item.scopeSource.includes('app_settings')),'The original job owns its own binding')
    assert.ok(mappings.some(item=>item.scopeSource.includes('synced_operations')),'The original receipt owns its own binding')
    for(const mapping of mappings){
      assert.equal(new URL(mapping.sourceUri).protocol,'file:','The source literal remains the real native URI')
      assert.equal(f.working.baseCommitment.referenceUris[mapping.baseReferenceIndex],mapping.sourceUri)
      const proof=f.working.baseCommitment.referenceProvenance.entries[mapping.baseReferenceIndex]
      assert.ok(proof);assert.equal(proof[0],mapping.baseReferenceIndex);assert.notEqual(proof[1],'unresolved')
      if(proof[1]==='unresolved')throw new Error('The actual settled source must have a captured native file proof')
      assert.equal(proof[2],mapping.aliasIndex)
      const alias=f.working.baseCommitment.tree.aliases[mapping.aliasIndex]
      assert.equal(alias.hash,mapping.hash);assert.equal(alias.bytes,mapping.bytes);assert.equal(alias.name,mapping.physicalName)
      assert.equal(mapping.hash,f.digest);assert.equal(mapping.bytes,f.bytes.length)
      assert.equal(mapping.logicalName,f.remoteAsset.name)
    }
    const checked = await withoutSettledSpoolProbes4(f.spools, () => readSealedCapsule2SourceWorkingOriginals5(f.source))
    assert.deepEqual(checked.attempts, []); assert.ok(checked.value)
    assert.deepEqual(checked.value.records, f.working.records)
    assert.equal(f.working.observation.unsupportedHolders.some(item => item.jobSettingKey === f.row.key), false)
    assert.equal(f.working.manifest.allAssetScopesCaptured, false); assert.equal(f.working.manifest.installPermit, false)
  }))
