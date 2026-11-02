import assert from 'node:assert/strict'
import { lstat, readFile, realpath, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AttachmentStore } from '../../src/main/attachments'
import { buildSyncedPortableAssetUri } from '../../src/shared/syncedBlockPortable'
import { publicationHash, publicationJson, publicationRecordKey } from '../../src/main/sync/synced-publication-model'
import { materializeSyncedExchangeLocal, readSyncedExchangeLocalMaterial } from '../../src/main/sync/synced-publication'
import { exchangeJobPrefix, parseExchangeStored, validateExchangeJob, validateExchangeJobPhase } from '../../src/main/sync/synced-exchange-model'
import { prepareCapsule2AssetArchiveWithWorkingProvenance5 } from '../../src/main/database/restore-knowledge-capsule2-asset-archive'
import { captureSealedCapsule2SourceFromArchive, readSealedCapsule2SourceWorkingOriginals5 } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { graph3Rows } from '../../src/main/database/restore-knowledge-graph3-data'
import { rawRestoreSqlCell } from '../../src/main/database/restore-knowledge-sql-cell'
import { deriveRoot5SettledWorkingEvidence5 } from '../../src/main/database/restore-knowledge-assets5-working-context'
import { withConflicts, request, applySyncedHostFinal, completed, randomUUID, allTables } from './synced-exchange-conflict-fixture'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import { assertRestorePath } from '../../src/main/database/restore-safety-files'
import { proveContext4NativeSpoolRoots } from './settled-context4-native-spool-evidence'
import { withoutSettledSpoolProbes4 } from './settled-context4-fixture'
type Base = Parameters<Parameters<typeof withConflicts>[0]>[0]
type SetupFixture = Pick<Base, 'A' | 'B' | 'exchange'>
type OracleRecord5 = NonNullable<ReturnType<typeof readSyncedExchangeLocalMaterial>>['records'][number]

/** A separate real doc uses a stable two-block skeleton. Its L edits the use,
 * R edits the definition; neither edit supplies a custom conflict selector. */
export async function seedIndependentWorking5(f: SetupFixture, documentId: string) {
  const definitionId = randomUUID(), assets = new AttachmentStore(join(f.A.root, 'storage', 'assets'))
  const bytes = Buffer.from('Actual all-family automatic destination ' + randomUUID())
  const [asset] = await assets.import([{ name: 'all-family working destination.png', bytes }])
  const digest = publicationHash(await readFile(fileURLToPath(asset.url))), portable = buildSyncedPortableAssetUri({ hash: digest, name: asset.name })
  const common = request(f.A.db, [documentId], sides => {
    const use = sides[0].blocks.find(block => block.type === 'paragraph'); assert.ok(use)
    use.content = 'Independent common use'; sides[0].summary = 'Unselected whole-W summary ![summary](<' + asset.url + '>)'
    sides[0].blocks.push({ id: definitionId, type: 'paragraph', content: 'Independent common definition', checked: false, depth: 0, parentBlockId: null })
  })
  assert.equal(applySyncedHostFinal(f.A.db, common).status, 'applied')
  completed(await f.exchange(f.A), 'applied'); completed(await f.exchange(f.B), 'applied')
  return { documentId, definitionId, bytes, digest, portable, asset }
}
export async function divergeIndependentWorking5(f: SetupFixture, setup: Awaited<ReturnType<typeof seedIndependentWorking5>>) {
  const remote = request(f.A.db, [setup.documentId], sides => {
    const definition = sides[0].blocks.find(block => block.id === setup.definitionId); assert.ok(definition)
    definition.content = '[independent]: <' + setup.asset.url + '>\n\n[^independent]: ![inside](<' + setup.asset.url + '>)'
  })
  assert.equal(applySyncedHostFinal(f.A.db, remote).status, 'applied'); completed(await f.exchange(f.A), 'applied')
  const local = request(f.B.db, [setup.documentId], sides => {
    const use = sides[0].blocks.find(block => block.type === 'paragraph' && block.id !== setup.definitionId); assert.ok(use)
    use.content = 'Actual independent automatic ![use][independent] and footnote[^independent]'
  })
  assert.equal(applySyncedHostFinal(f.B.db, local).status, 'applied')
}
/** The Main resolver authors the job, descriptor, phase, inputs and publication
 * bytes. Only the immutable archive copy is performed inside its real gate. */
export async function capturePendingWorkingFamily5(f: Pick<Base, 'B' | 'folder' | 'targetConfig' | 'gate'>,
  operationId: string, family: 2 | 3 | 5 | 6 | 7, resolve: () => Promise<unknown>, mode: 'pending' | 'settled' = 'pending') {
  const gate = f.gate(value => value.method === 'PUT' && value.path.endsWith('/manifest.json') && Boolean(value.ifMatch)), resolving = resolve()
  try {
    await gate.wait(resolving)
    const prefix = exchangeJobPrefix(operationId), rows = f.B.db.prepare('SELECT key,value FROM app_settings WHERE substr(key,1,?)=?').all(prefix.length, prefix) as Array<{key:string;value:string}>
    assert.equal(rows.length, 1); const row = rows[0], job = validateExchangeJob(parseExchangeStored(row.value))
    assert.equal(job.version, family)
    const merges = job.merges; assert.ok(merges && merges.length > 0)
    assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId), undefined)
    const before = allTables(f.B.db)
    const pending = mode === 'pending' ? await (async () => {
      const original = await captureAssetOriginal({ userDataRoot: f.B.root, db: f.B.db })
      return { original, archive: await prepareCapsule2AssetArchiveWithWorkingProvenance5(original.original) }
    })() : undefined
    assert.deepEqual(allTables(f.B.db), before)
    gate.release(); const result = await resolving
    assert.ok(result && typeof result === 'object' && 'status' in result && result.status === 'applied', 'The real resolver must install the publication')
    const finish = async (original: Awaited<ReturnType<typeof captureAssetOriginal>>, archive: Awaited<ReturnType<typeof prepareCapsule2AssetArchiveWithWorkingProvenance5>>) => {
      const sealed = await captureSealedCapsule2SourceFromArchive(archive), working = await readSealedCapsule2SourceWorkingOriginals5(sealed.source); assert.ok(working)
      return { original, sealed, working }
    }
    const captured = pending ? await finish(pending.original, pending.archive) : await (async () => {
      const original = await captureAssetOriginal({ userDataRoot: f.B.root, db: f.B.db })
      const roots = await proveContext4NativeSpoolRoots(f.B.root, original.info.profileRoot), names = roots.spools(operationId, job.attemptId)
      const root = await realpath(f.folder), source = await realpath(names.canonical), retired = join(root, 'retired-family-' + family + '-' + job.attemptId)
      await assertRestorePath(source, root); assert.equal(dirname(retired), root); await assert.rejects(lstat(retired), { code: 'ENOENT' })
      await rename(source, retired); for (const path of names.aliases) await assert.rejects(lstat(path), { code: 'ENOENT' })
      const guarded = await withoutSettledSpoolProbes4(names.aliases, async () => finish(original,
        await prepareCapsule2AssetArchiveWithWorkingProvenance5(original.original)))
      assert.deepEqual(guarded.attempts, []); return guarded.value
    })()
    const { original, sealed, working } = captured
    assert.equal(sealed.value.assetArchive.version, 5)
    assert.equal(graph3Rows(sealed.value.source.sourceContent, 'synced_operations').some(row => row.value.client_operation_id === operationId), mode === 'settled')
    const actualOwner = await materializeSyncedExchangeLocal(f.B.db, { userDataRoot: f.B.root, target: f.targetConfig })
    const actual = readSyncedExchangeLocalMaterial(actualOwner); assert.ok(actual)
    const records = working.records.filter(item => item.jobSettingKey === row.key)
    assert.equal(records.length, merges.length)
    for (const item of records) {
      const expected: OracleRecord5 | undefined = actual.records.find(record => publicationRecordKey(record) === item.recordKey); assert.ok(expected)
      assert.equal(publicationJson(item.record), publicationJson(expected), 'Each complete W must equal the actual production installation')
      assert.equal(publicationHash(publicationJson(expected)), item.provenance.resultHash)
    }
    assert.equal(working.manifest.settledBindings.some(item => item.jobSettingKey === row.key), mode === 'settled')
    assert.equal(working.manifest.captures.some(item => item.jobSettingKey === row.key && item.state === 'captured'), mode === 'pending')
    return { original, sealed, source: sealed.source, value: sealed.value, working, row, job, records, actual, result, mode,
      sourceInput: { profileRoot: original.info.profileRoot, operationId: sealed.info.manifest.operationId,
        capsuleId: sealed.info.manifest.capsuleId, expectedManifestHash: sealed.info.manifestHash } }
  } finally { gate.release(); await Promise.allSettled([resolving]) }
}
export function assertIndependentWorking5(saved: Awaited<ReturnType<typeof capturePendingWorkingFamily5>>,
  setup: Awaited<ReturnType<typeof seedIndependentWorking5>>, family: 2 | 3 | 5 | 6 | 7) {
  const key = 'doc:' + setup.documentId, record = saved.records.find(item => item.recordKey === key); assert.ok(record)
  assert.equal(record.record.kind, 'document')
  const scopes = saved.working.observation.scopes.filter(item => item.jobSettingKey === saved.row.key && item.recordKey === key)
  assert.equal(scopes.length, saved.mode === 'pending' ? 1 : 2)
  for (const scope of scopes) {
    assert.equal(scope.family, family); assert.equal(scope.evidenceKind, saved.mode === 'pending' ? 'replayed-original-working-inputs' : 'settled-original-working-record')
    assert.ok(scope.destinations.some(item => item.section === 'summary' && item.uri === setup.portable))
    assert.ok(scope.destinations.some(item => item.section === 'body' && item.kind === 'definition' && item.uri === setup.portable))
    assert.ok(scope.destinations.some(item => item.section === 'body' && item.kind === 'image' && item.uri === setup.portable))
  }
  assert.equal(saved.working.observation.unsupportedHolders.some(item => item.jobSettingKey === saved.row.key), false)
  assert.equal(saved.working.manifest.allAssetScopesCaptured, false); assert.equal(saved.working.manifest.otherHeldPayloadScopesComplete, false)
}
/** A pure negative starts with real original rows, converts every v2 fact to a
 * separately valid v1 fact and reconnects the complete chain. No outer hash or
 * malformed JSON rejection can stand in for the Main family-version rule. */
export function assertBothWorkingPhaseFamily5(saved: Awaited<ReturnType<typeof capturePendingWorkingFamily5>>) {
  assert.ok(saved.job.version === 3 || saved.job.version === 6); assert.equal(saved.mode, 'settled')
  const raw = saved.value.source.sourceContent, rows = graph3Rows(raw, 'app_settings').filter(row => {
    if (typeof row.value.key !== 'string' || !row.value.key.startsWith('sync.webdav.protocol5.exchange-job-phase.v1.')) return false
    const fact = validateExchangeJobPhase(parseExchangeStored(String(row.value.value)))
    return fact.operationId === saved.job.request.operationId && fact.attemptId === saved.job.attemptId
  }).sort((a, b) => validateExchangeJobPhase(parseExchangeStored(String(a.value.value))).sequence - validateExchangeJobPhase(parseExchangeStored(String(b.value.value))).sequence)
  assert.ok(rows.length > 0)
  const replacement = new Map<string, ReturnType<typeof rawRestoreSqlCell>>()
  let previous: string | null = null
  for (const row of rows) {
    const fact = validateExchangeJobPhase(parseExchangeStored(String(row.value.value)))
    assert.equal(fact.version, 2); if (fact.version !== 2) throw new Error('The actual Main both phase must be v2')
    const { blocked: _blocked, version: _version, ...body } = fact
    const downgraded = validateExchangeJobPhase({ ...body, version: 1, previousFactHash: previous }), text = publicationJson(downgraded)
    const bytes = Buffer.from(text, raw.encoding === 'UTF-8' ? 'utf8' : 'utf16le'); if (raw.encoding === 'UTF-16be') bytes.swap16()
    replacement.set(row.original.sourceRowId, rawRestoreSqlCell('text', bytes, raw.encoding)); previous = publicationHash(text)
  }
  const rewritten = { ...raw, tables: raw.tables.map(table => {
    if (table.name !== 'app_settings') return table
    const valueColumn = table.columns.indexOf('value'); assert.ok(valueColumn >= 0)
    return { ...table, rows: table.rows.map(row => ({ ...row, cells: row.cells.map((cell, index) => index === valueColumn ? replacement.get(row.sourceRowId) ?? cell : cell) })) }
  }) }
  assert.throws(() => deriveRoot5SettledWorkingEvidence5(rewritten), /settled phase original mismatch/)
}
