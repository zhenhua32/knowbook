import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { publicationJson } from '../src/main/sync/synced-publication-model'
import { graph3Rows } from '../src/main/database/restore-knowledge-graph3-data'
import { parseWorkingOriginals5 } from '../src/main/database/restore-knowledge-capsule5-working-model'
import { readSealedCapsule2SourceWorkingOriginals5 } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { withPendingWorkingSource5 } from './helpers/working5-automatic-source-fixture'

test('archive5 seals genuine pending automatic whole W and remote-only definition bytes before Main installs them',
  { concurrency: false }, () => withPendingWorkingSource5(async f => {
    const archive = f.value.assetArchive; assert.equal(archive.version, 5)
    if (archive.version !== 5) throw new Error('Explicit archive5 required')
    const captured = f.working.manifest.captures.find(item => item.jobSettingKey === f.row.key); assert.ok(captured)
    assert.equal(captured.state, 'captured')
    assert.equal(f.working.manifest.settledBindings.some(item => item.jobSettingKey === f.row.key), false)
    const record = f.working.records.find(item => item.jobSettingKey === f.row.key && item.recordKey === 'doc:' + f.documentId); assert.ok(record)
    assert.equal(publicationJson(record.record), publicationJson(f.oracle.record))
    assert.deepEqual(record.provenance, f.oracle.merge)
    if (!('replayedLocalFinal' in record)) throw new Error('A captured pending record must have its replayed local plan')
    const local = record.replayedLocalFinal
    assert.equal(local.planHash, f.job.descriptor.planHash)
    assert.deepEqual(local.component, f.job.components.find(component => component.keys.includes(record.recordKey)))
    assert.deepEqual(local.entry, { key: record.recordKey, hash: record.provenance.resultHash, record: f.oracle.record })
    assert.equal(local.localApply, true)
    assert.equal(local.remoteOnly, false)
    assert.ok(f.applied.appliedKeys.includes(record.recordKey))

    const remoteOnly = f.working.records.find(item => item.jobSettingKey === f.row.key && item.recordKey === 'doc:' + f.remoteOnlyDocumentId)
    if (!remoteOnly || !('replayedLocalFinal' in remoteOnly)) throw new Error('A real publication-only merge must retain its local plan observation')
    assert.equal(remoteOnly.provenance.resultHash, remoteOnly.provenance.localHash)
    assert.deepEqual(remoteOnly.replayedLocalFinal.entry,
      { key: remoteOnly.recordKey, hash: remoteOnly.provenance.localHash, record: remoteOnly.record })
    assert.equal(remoteOnly.replayedLocalFinal.localApply, false)
    assert.equal(remoteOnly.replayedLocalFinal.remoteOnly, true)
    assert.equal(f.applied.appliedKeys.includes(remoteOnly.recordKey), false)
    assert.ok(f.applied.publishedKeys.includes(remoteOnly.recordKey))
    assert.equal(graph3Rows(f.value.source.sourceContent, 'synced_operations').some(row => row.value.client_operation_id === f.operationId), false,
      'A later genuine live receipt cannot substitute for the original pending SQL')
    const jobScopes = f.working.observation.scopes.filter(scope => scope.jobSettingKey === f.row.key)
    assert.equal(jobScopes.length, 2)
    const scopes = jobScopes.filter(scope => scope.recordKey === record.recordKey)
    assert.equal(scopes.length, 1); assert.equal(scopes[0].family, 4)
    assert.equal(scopes[0].evidenceKind, 'replayed-original-working-inputs')
    assert.ok(scopes[0].source.includes('app_settings')); assert.equal(scopes[0].source.includes('synced_operations'), false)
    assert.ok(scopes[0].destinations.some(item => item.section === 'summary' && item.uri === f.summaryUri))
    assert.ok(scopes[0].destinations.some(item => item.section === 'body' && item.kind === 'definition' && item.uri === f.portable))
    assert.ok(scopes[0].destinations.some(item => item.section === 'body' && item.kind === 'image' && item.uri === f.portable))
    assert.equal(scopes[0].destinations.some(item => item.uri === f.opaque), false)
    assert.ok(f.working.observation.pendingPortableBindings.some(item => item.hash === f.digest && item.bytes === f.bytes.length))
    const bytes = await readFile(join(f.working.directory, 'files', f.digest)); assert.deepEqual(bytes, f.bytes)
    const text = await readFile(join(f.working.directory, 'manifest.json'), 'utf8')
    assert.deepEqual(parseWorkingOriginals5(text, archive.workingOriginals), f.working.manifest)
    assert.equal(archive.workingOriginals.originalFileBytes, f.working.files.reduce((sum, file) => sum + file.bytes, 0))
    assert.equal(archive.workingOriginals.fileCount, f.working.files.length)
    assert.equal('files' in archive.workingOriginals, false, 'The top manifest carries a compact commitment')
    await assert.rejects(readSealedCapsule2SourceWorkingOriginals5({ ...f.source }))
    const accesses: string[] = [], proxy = new Proxy(f.source, { get(_target, name) { accesses.push(String(name)); throw new Error('Caller source properties must not be read') } })
    await assert.rejects(readSealedCapsule2SourceWorkingOriginals5(proxy)); assert.deepEqual(accesses, [])
    for (const gate of [f.working.manifest.allAssetScopesCaptured, f.working.manifest.otherHeldPayloadScopesComplete,
      f.working.manifest.acceptedCoverage, f.working.manifest.effective, f.working.manifest.installPermit,
      f.working.observation.allAssetScopesCaptured, archive.coverage.installPermit]) assert.equal(gate, false)
  }, { includeRemoteOnlyMerge: true }))
