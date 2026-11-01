import assert from 'node:assert/strict'
import { lstat, readFile, readdir, realpath, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AttachmentStore } from '../../src/main/attachments'
import { buildSyncedPortableAssetUri } from '../../src/shared/syncedBlockPortable'
import { serializeDatabaseViewPayload } from '../../src/shared/databaseViewBlock'
import { createDefaultDatabaseViewConfig } from '../../src/shared/database-workspace'
import { assertRestorePath, restoreInventory } from '../../src/main/database/restore-safety-files'
import { captureSealedCapsule2SourceWithAssetProvenance3, captureSealedCapsule2SourceWithContextProvenance3 } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { prepareCapsule2SettledPortableSource3 } from '../../src/main/database/restore-knowledge-assets3-settled-portable-owner'
import { exchangeJobHash, exchangeJobPrefix, exchangeJobPhaseKey, parseExchangeStored, validateExchangeJob, validateExchangeJobPhase,
  validateExchangeReceipt } from '../../src/main/sync/synced-exchange-model'
import { materializeSyncedExchangeLocal, readSyncedExchangeLocalMaterial, readSyncedExchangeLocalAsset } from '../../src/main/sync/synced-publication'
import { publicationHash, publicationJson, publicationRecordKey } from '../../src/main/sync/synced-publication-model'
import { withConflicts, hostEdit, completed, ready, component, mergeDecision, randomUUID, request, applySyncedHostFinal,
  editKeepingKeys, localPortable } from './synced-exchange-conflict-fixture'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import { windowsShortPath } from './windows-short-path'

type Fixture = Parameters<Parameters<typeof withConflicts>[0]>[0]
export type SettledPortableFixture3 = Awaited<ReturnType<typeof prepare>>
export function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>
}
export function array(value: unknown): unknown[] { assert.ok(Array.isArray(value)); return value }
export async function capturePortableOwner3(f: Fixture, version: 2 | 3 = 2) {
  const original = await captureAssetOriginal({ userDataRoot: f.B.root, db: f.B.db })
  const sealed = version === 2 ? await captureSealedCapsule2SourceWithAssetProvenance3(original.original)
    : await captureSealedCapsule2SourceWithContextProvenance3(original.original)
  assert.equal(sealed.value.assetArchive.version, version)
  const prepared = await prepareCapsule2SettledPortableSource3(sealed.source)
  assert.deepEqual(await restoreInventory(original.info.originalDirectory), original.inventory)
  return { original, sealed, ...prepared, input: { profileRoot: original.info.profileRoot,
    operationId: sealed.info.manifest.operationId, capsuleId: sealed.info.manifest.capsuleId, expectedManifestHash: sealed.info.manifestHash } }
}
/** Remove only the actual fixed fixture lookup. Retain its bytes for diagnosis;
 * no test fabricates a descriptor or supplies that retired path to an owner. */
async function retireSpool(f: Fixture, job: ReturnType<typeof validateExchangeJob>) {
  const path = join(f.B.root, 'storage', 'synced-exchanges-v1', job.request.operationId, job.attemptId)
  const exists = await lstat(path).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error })
  if (exists) {
    const root = await realpath(f.folder), current = await realpath(path), retired = join(root, 'retired-settled-spool-' + job.attemptId)
    await assertRestorePath(current, root); assert.equal(dirname(retired), root)
    await assert.rejects(lstat(retired), { code: 'ENOENT' }); await rename(current, retired)
  }
  await assert.rejects(lstat(path), { code: 'ENOENT' })
}
function exactSettledJob(f: Fixture, operationId: string) {
  const prefix = exchangeJobPrefix(operationId)
  const rows = f.B.db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(key,1,?)=? ORDER BY key').all(prefix.length, prefix) as Array<{ key: string; value: string; updated_at: string }>
  assert.equal(rows.length, 1)
  const row = rows[0], job = validateExchangeJob(parseExchangeStored(row.value))
  assert.equal(row.value, publicationJson(job)); assert.equal(row.updated_at, job.preparedAt)
  const receiptRow = f.B.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(operationId) as { result_json: string; request_hash: string; created_at: string }
  assert.ok(receiptRow)
  const receipt = validateExchangeReceipt(parseExchangeStored(receiptRow.result_json))
  assert.deepEqual(receipt.request, job.request); assert.equal(receipt.provenance.attemptId, job.attemptId)
  assert.equal(receiptRow.request_hash, job.requestHash); assert.equal(receiptRow.created_at, receipt.result.acceptedAt)
  const phasePrefix = exchangeJobPhaseKey(operationId, job.attemptId, 0).slice(0, -1)
  const phaseRows = f.B.db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(key,1,?)=?').all(phasePrefix.length, phasePrefix) as Array<{ key: string; value: string; updated_at: string }>
  const phases = phaseRows.map(row => ({ row, fact: validateExchangeJobPhase(parseExchangeStored(row.value)) })).sort((a, b) => a.fact.sequence - b.fact.sequence)
  assert.ok(phases.length >= 2)
  let previous: string | null = null
  for (const [index, { row, fact }] of phases.entries()) {
    assert.equal(fact.sequence, index); assert.equal(fact.previousFactHash, previous)
    assert.equal(fact.jobHash, exchangeJobHash(job)); assert.equal(fact.requestHash, job.requestHash)
    assert.equal(row.key, exchangeJobPhaseKey(operationId, job.attemptId, index)); assert.equal(row.value, publicationJson(fact))
    assert.equal(row.updated_at, fact.recordedAt); previous = publicationHash(publicationJson(fact))
  }
  assert.equal(phases[0].fact.phase, 'prepared'); assert.equal(phases.at(-1)!.fact.phase, 'settled')
  assert.equal(phases.at(-1)!.fact.remoteEtag, receipt.provenance.afterManifestEtag)
  return { row, job, receiptRow, receipt, phases }
}
async function prepare(f: Fixture, nativeAliases: boolean, group: boolean) {
  const bytes = Buffer.from('genuine settled portable byte supplier'), digest = publicationHash(bytes)
  const store = new AttachmentStore(join(f.B.root, 'storage', 'assets'))
  const physicalName = nativeAliases ? 'SETTLED PORTABLE Native Long Alias.PNG' : 'settled-portable-native.png'
  const [physical] = await store.import([{ name: physicalName, bytes }])
  const logicalName = nativeAliases ? physical.name.toLowerCase() : physical.name
  const logicalPath = join(dirname(fileURLToPath(physical.url)), logicalName)
  assert.deepEqual(await readFile(logicalPath), bytes)
  const names = [logicalName]
  let shortPath: string | null = null
  if (nativeAliases) {
    shortPath = windowsShortPath(fileURLToPath(physical.url))
    const shortName = basename(shortPath)
    if (shortName.toLowerCase() !== physical.name.toLowerCase()) names.push(shortName)
    for (const name of names) {
      const canonical = await lstat(fileURLToPath(physical.url), { bigint: true }), alias = await lstat(join(dirname(logicalPath), name), { bigint: true })
      assert.equal(alias.ino, canonical.ino); assert.deepEqual(await readFile(join(dirname(logicalPath), name)), bytes)
    }
  }
  const uris = names.map(name => buildSyncedPortableAssetUri({ hash: digest, name }))
  const [summary] = await f.assets.import([{ name: 'settled whole W summary.png', bytes: Buffer.from('genuine noncustom summary asset') }])
  const documentId = f.islands[0], opaqueUri = buildSyncedPortableAssetUri({ hash: 'f'.repeat(64), name: 'opaque-not-owned.png' })
  const opaque = 'opaque default id ' + f.A.defaultId + ' literal ' + opaqueUri
  const config = createDefaultDatabaseViewConfig(); config.query = opaque
  const common = request(f.A.db, [documentId], sides => {
    sides[0].summary = `Unchanged W summary ![summary](<${summary.url}>)`
    sides[0].blocks[0].content = 'settled base exact overlap'
    sides[0].blocks.push({ id: randomUUID(), type: 'paragraph', content: `[settled-ref]: <${summary.url}>\n\n[^settled-note]: ![note](<${summary.url}>)`, checked: false, depth: 0, parentBlockId: null },
      { id: randomUUID(), type: 'database-view', content: serializeDatabaseViewPayload({ version: 1, databaseId: f.A.defaultId, viewId: null, config }), checked: false, depth: 0, parentBlockId: null },
      { id: randomUUID(), type: 'code', content: opaque, checked: false, depth: 0, parentBlockId: null })
  })
  assert.equal(applySyncedHostFinal(f.A.db, common).status, 'applied')
  completed(await f.exchange(f.A), 'applied'); completed(await f.exchange(f.B), 'applied')
  hostEdit(f.A.db, documentId, 'REMOTE settled overlap'); completed(await f.exchange(f.A), 'applied')
  hostEdit(f.B.db, documentId, 'LOCAL settled overlap')
  hostEdit(f.B.db, f.islands[1], `Actual byte supplier ![managed](<${physical.url}>)`)
  const customText = '  complete settled W 😀 ' + uris.map(uri => `![native](<${uri}>)`).join(' ') + '\n[whole][settled-ref] [^settled-note]  '
  const preview = ready(await f.preview()), decision = mergeDecision(component(preview, 'doc:' + documentId), part => {
    assert.equal(part.field, 'block-content'); assert.equal(part.canEditText, true); return { choice: 'custom', text: customText }
  })
  const operationId = randomUUID(); completed(await f.resolve(preview, [decision], operationId), 'applied')
  const documentJob = exactSettledJob(f, operationId), jobs = [documentJob]
  if (group) {
    const groupId = f.ack.createdLifecycle.groupId
    const wire = localPortable(f.B).records.find(value => value.kind === 'synced-group' && value.id === groupId)
    assert.ok(wire?.kind === 'synced-group'); if (wire.kind !== 'synced-group') throw new Error('Real full group required')
    assert.ok(wire.bindings.length > 0)
    const base = wire.blocks[0].content
    editKeepingKeys(f.A, groupId, blocks => { blocks[0].content = 'REMOTE native group overlap ' + blocks[0].content })
    completed(await f.exchange(f.A), 'applied')
    editKeepingKeys(f.B, groupId, blocks => { blocks[0].content = 'LOCAL native group overlap ' + blocks[0].content })
    const p = ready(await f.preview()), text = `Actual settled group ![native](<${uris[0]}>) ` + base
    const choice = mergeDecision(component(p, 'group:' + groupId), part => {
      assert.equal(part.field, 'block-content'); assert.equal(part.canEditText, true); return { choice: 'custom', text }
    })
    const groupOperationId = randomUUID(); completed(await f.resolve(p, [choice], groupOperationId), 'applied')
    jobs.push(exactSettledJob(f, groupOperationId))
  }
  for (const actual of jobs) await retireSpool(f, actual.job)
  const oracleHandle = await materializeSyncedExchangeLocal(f.B.db, { userDataRoot: f.B.root, target: f.targetConfig })
  const oracle = readSyncedExchangeLocalMaterial(oracleHandle); assert.ok(oracle)
  const oracleRecords = new Map(oracle.records.map(record => [publicationRecordKey(record), record]))
  assert.deepEqual(Buffer.from(readSyncedExchangeLocalAsset(oracleHandle, digest)!), bytes)
  const directoryNames = await readdir(dirname(fileURLToPath(physical.url)))
  if (nativeAliases) assert.ok(directoryNames.includes(physical.name))
  return { f, jobs, documentJob, documentId, groupId: group ? f.ack.createdLifecycle.groupId : null,
    bytes, digest, physical, logicalPath, logicalName, shortPath, names, uris, customText, opaque, opaqueUri,
    oracleHandle, oracleRecords, capture: (version: 2 | 3 = 2) => capturePortableOwner3(f, version) }
}
export function withSettledPortable3(run: (saved: SettledPortableFixture3) => Promise<void>, options: { nativeAliases?: boolean; group?: boolean } = {}) {
  return withConflicts(async f => run(await prepare(f, options.nativeAliases ?? false, options.group ?? false)), { assets: true, notes: true, catalog: true })
}
