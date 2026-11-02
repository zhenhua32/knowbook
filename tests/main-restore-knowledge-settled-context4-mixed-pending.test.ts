import assert from 'node:assert/strict'
import test from 'node:test'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareCapsule2AssetArchiveWithSettledContextProvenance4, readCapsule2ArchiveSourceInputs } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { captureSealedCapsule2SourceFromArchive } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { graph3Rows } from '../src/main/database/restore-knowledge-graph3-data'
import { capsuleBytesHash } from '../src/main/database/restore-knowledge-capsule-model'
import { exchangeJobPrefix, parseExchangeStored, validateExchangeJob } from '../src/main/sync/synced-exchange-model'
import { materializeSyncedExchangeLocal, readSyncedExchangeLocalMaterial } from '../src/main/sync/synced-publication'
import { publicationHash, publicationJson, publicationRecordKey } from '../src/main/sync/synced-publication-model'
import { withSettledPortable3 } from './helpers/settled-portable-owner-fixture'
import { withoutSettledSpoolProbes4 } from './helpers/settled-context4-fixture'
import { proveContext4NativeSpoolRoots, proveContext4ObservedSpoolFile } from './helpers/settled-context4-native-spool-evidence'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { completed, hostEdit, ready, component, mergeDecision, randomUUID } from './helpers/synced-exchange-conflict-fixture'

test('archive4 partitions one real settled no-spool W and a separately captured pending original job without borrowing its later live receipt',
  context => withSettledPortable3(async saved => {
    const f = saved.f, documentId = f.islands[2], recordKey = 'doc:' + documentId
    // Bring the real sender to the already resolved publication, then create
    // an independent conflict. The first completed job/receipt remains intact.
    completed(await f.exchange(f.A), 'applied')
    hostEdit(f.A.db, documentId, 'REMOTE independent pending overlap'); completed(await f.exchange(f.A), 'applied')
    hostEdit(f.B.db, documentId, 'LOCAL independent pending overlap')
    const preview = ready(await f.preview()), text = 'Actual separate pending W ![asset](<' + saved.uris[0] + '>)'
    const decision = mergeDecision(component(preview, recordKey), part => {
      assert.equal(part.field, 'block-content'); assert.equal(part.canEditText, true); return { choice: 'custom', text }
    })
    const operationId = randomUUID(), gate = f.gate(value => value.method === 'PUT' && value.path.endsWith('/manifest.json') && Boolean(value.ifMatch))
    const resolving = f.resolve(preview, [decision], operationId)
    try {
      await gate.wait(resolving)
      assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId), undefined)
      const prefix = exchangeJobPrefix(operationId)
      const rows = f.B.db.prepare('SELECT key,value FROM app_settings WHERE substr(key,1,?)=?').all(prefix.length, prefix) as Array<{key: string; value: string}>
      assert.equal(rows.length, 1)
      const jobRow = rows[0], job = validateExchangeJob(parseExchangeStored(jobRow.value))
      const spool = join(f.B.root, 'storage', 'synced-exchanges-v1', operationId, job.attemptId)
      const expected = await Promise.all(['inputs.json','job.json','ready.json','manifest.json', ...new Set(job.descriptor.next.objects.map(value => value.path)),
        ...job.descriptor.next.assets.map(value => value.path)].map(async name => {
        const bytes = await readFile(join(spool, ...name.split('/'))); return { name, sha256: capsuleBytesHash(bytes), bytes: bytes.length }
      }))
      const original = await captureAssetOriginal({ userDataRoot: f.B.root, db: f.B.db })
      // Release promptly after freezing the real pending SQL. No extra request
      // deadline is introduced; later capture must use that frozen SQL and the
      // still genuine immutable spool, despite today's completed live receipt.
      gate.release(); completed(await resolving, 'applied')
      assert.ok(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId))
      assert.ok((await lstat(spool)).isDirectory())
      const roots = await proveContext4NativeSpoolRoots(f.B.root, original.info.profileRoot)
      const forbidden = saved.jobs.flatMap(value => roots.spools(value.job.request.operationId, value.job.attemptId).aliases)
      const captured = await withoutSettledSpoolProbes4(forbidden,
        () => prepareCapsule2AssetArchiveWithSettledContextProvenance4(original.original), roots.spools(operationId, job.attemptId).aliases)
      assert.deepEqual(captured.attempts, [])
      assert.ok(captured.observations.some(value => value.method === 'open' && value.path.endsWith('inputs.json')),
        'The pending original is read from its exact real spool rather than skipped or replaced by the later receipt')
      const expectedInput = expected.find(value => value.name === 'inputs.json'); assert.ok(expectedInput)
      const nativeSpool = await proveContext4ObservedSpoolFile(roots, operationId, job.attemptId, captured.observations, expectedInput)
      context.diagnostic(JSON.stringify({ nativeSpoolRootIdentity: roots.anchor, literalProfileRoot: roots.literalProfileRoot,
        canonicalProfileRoot: roots.canonicalProfileRoot, pendingOriginal: nativeSpool }))
      const inputs = await readCapsule2ArchiveSourceInputs(captured.value), archive = inputs.value.manifest
      assert.equal(archive.version, 4)
      if (archive.version !== 4 || !inputs.supplemental || inputs.supplemental.version !== 2) throw new Error('Actual archive4 observer2 required')
      assert.equal(archive.coverage.supplementalCustomMergeScopesCaptured, true)
      assert.ok(archive.contextOriginals.settledBindings.some(value => value.jobSettingKey === saved.documentJob.row.key))
      assert.equal(archive.contextOriginals.settledBindings.some(value => value.jobSettingKey === jobRow.key), false)
      const pending = archive.contextOriginals.captures.find(value => value.jobSettingKey === jobRow.key); assert.ok(pending)
      assert.equal(pending.state, 'captured')
      assert.deepEqual(pending.fileHashes, expected.map(value => value.sha256))
      const files = new Map(archive.contextOriginals.files.map(file => [file.sha256, file.bytes]))
      for (const file of expected) assert.equal(files.get(file.sha256), file.bytes)
      const sealed = await captureSealedCapsule2SourceFromArchive(captured.value)
      assert.equal(graph3Rows(sealed.value.source.sourceContent, 'synced_operations').some(row => row.value.client_operation_id === operationId), false)
      assert.equal(graph3Rows(sealed.value.source.sourceContent, 'app_settings').find(row => row.value.key === jobRow.key)!.value.value, jobRow.value)
      const oracleHandle = await materializeSyncedExchangeLocal(f.B.db, { userDataRoot: f.B.root, target: f.targetConfig })
      const oracle = readSyncedExchangeLocalMaterial(oracleHandle); assert.ok(oracle)
      const whole = oracle.records.find(value => publicationRecordKey(value) === recordKey); assert.ok(whole)
      const holders = inputs.supplemental.holders.filter(value => value.recordKey === recordKey && value.source[0] === 'app_settings' && value.source[1] === jobRow.key)
      assert.equal(holders.length, 1); assert.equal(holders[0].evidenceKind, 'replayed-original-inputs')
      assert.equal(holders[0].resultHash, publicationHash(publicationJson(whole)))
      assert.ok(inputs.supplemental.scopes.some(scope => scope.destinations.some(value => value.uri === saved.uris[0])))
      assert.equal(archive.coverage.installPermit, false)
    } finally { gate.release(); await Promise.allSettled([resolving]) }
  }))
