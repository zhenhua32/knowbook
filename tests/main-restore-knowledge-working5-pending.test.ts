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
    assert.equal(graph3Rows(f.value.source.sourceContent, 'synced_operations').some(row => row.value.client_operation_id === f.operationId), false,
      'A later genuine live receipt cannot substitute for the original pending SQL')
    const scopes = f.working.observation.scopes.filter(scope => scope.jobSettingKey === f.row.key)
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
  }))
