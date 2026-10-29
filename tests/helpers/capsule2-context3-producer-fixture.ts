// Genuine HTTP/Main/SQL/native-file preparation for context producer tests.
// No context/job/source packet DTO is used to mint any owner.
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { AttachmentStore } from '../../src/main/attachments'
import { buildSyncedPortableAssetUri } from '../../src/shared/syncedBlockPortable'
import { capsuleBytesHash } from '../../src/main/database/restore-knowledge-capsule-model'
import { graph3Rows } from '../../src/main/database/restore-knowledge-graph3-data'
import { capsule2DerivedFtsTables, type Capsule2Encoding } from '../../src/main/database/restore-knowledge-capsule2-raw-model'
import { rawRestoreSqlCell, type RawRestoreSqlCell } from '../../src/main/database/restore-knowledge-sql-cell'
import { restoreSqliteFilename } from '../../src/main/database/restore-safety-sqlite-path'
import { restoreInventory } from '../../src/main/database/restore-safety-files'
import { prepareCapsule2AssetArchiveWithContextProvenance3, readCapsule2ArchiveSourceInputs } from '../../src/main/database/restore-knowledge-capsule2-asset-archive'
import { captureSealedCapsule2SourceFromArchive } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { exchangeJobPrefix, parseExchangeStored, validateExchangeJob } from '../../src/main/sync/synced-exchange-model'
import { withConflicts, hostEdit, completed, ready, component, mergeDecision, randomUUID,
  request, applySyncedHostFinal, readStrictHostDocument } from './synced-exchange-conflict-fixture'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import { allTables } from './synced-backup-v3-fixture'

export async function nativeContextOriginal3(original: Awaited<ReturnType<typeof captureAssetOriginal>>, directory: string) {
  const before = await restoreInventory(original.info.originalDirectory)
  assert.deepEqual(before, original.inventory)
  await mkdir(directory)
  for (const file of before) if (file.present) await copyFile(join(original.info.originalDirectory, file.name), join(directory, file.name), constants.COPYFILE_EXCL)
  assert.deepEqual(await restoreInventory(directory), before)
  const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"'
  const db = new Database(restoreSqliteFilename(join(directory, 'knowbook.db')), { readonly: true, fileMustExist: true })
  try {
    db.pragma('foreign_keys=ON'); db.pragma('query_only=ON')
    return db.transaction(() => {
      const encoding = db.pragma('encoding', { simple: true }) as Capsule2Encoding, derived = new Set(capsule2DerivedFtsTables())
      const names = (db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND substr(name,1,7)<>'sqlite_' ORDER BY name").all() as Array<{ name: string }>).map(value => value.name).filter(name => !derived.has(name))
      const tables = names.map(name => {
        const columns = db.prepare('SELECT * FROM main.' + quote(name) + ' LIMIT 0').columns().map(column => column.name)
        const projection = columns.flatMap(column => ['typeof(' + quote(column) + ')', 'CASE WHEN typeof(' + quote(column) + ")='text' THEN CAST(" + quote(column) + ' AS BLOB) ELSE ' + quote(column) + ' END']).join(',')
        const rows = db.prepare('SELECT _rowid_,' + projection + ' FROM main.' + quote(name) + ' ORDER BY _rowid_').safeIntegers(true).raw(true).all() as unknown[][]
        return { name, columns, rows: rows.map(row => ({ sourceRowId: String(row[0]), cells: columns.map((_column, index) => rawRestoreSqlCell(row[index * 2 + 1], row[index * 2 + 2], encoding)) as RawRestoreSqlCell[] })) }
      })
      return { encoding, tables }
    })()
  } finally { db.close(); assert.deepEqual(await restoreInventory(original.info.originalDirectory), before) }
}

type Captured = Awaited<ReturnType<typeof preparePendingContext3>>
/** A real same-skeleton conflict creates both the durable SQL job and spool.
 * W's summary is shared unchanged; only the two actual body decisions are
 * custom. The second selected record intentionally has zero asset references. */
export async function preparePendingContext3(f: Parameters<Parameters<typeof withConflicts>[0]>[0], withoutManagedCustomAliases: boolean) {
  const documentId = f.islands[0], emptyId = f.islands[2]
  const [summaryAsset] = await f.assets.import([{ name: 'whole-W-summary.png', bytes: Buffer.from('real independent whole W summary bytes') }])
  const summaryHash = capsuleBytesHash(await readFile(fileURLToPath(summaryAsset.url)))
  const summaryUri = buildSyncedPortableAssetUri({ hash: summaryHash, name: summaryAsset.name })
  const customBytes = Buffer.from('real pending-only spool asset bytes'), customHash = capsuleBytesHash(customBytes)
  const receiverAssets = new AttachmentStore(join(f.B.root, 'storage', 'assets'))
  const [supplier, customAlias] = await receiverAssets.import([{ name: 'real-byte-supplier.png', bytes: customBytes }, { name: 'pending-only-custom.png', bytes: customBytes }])
  const customUri = buildSyncedPortableAssetUri({ hash: customHash, name: customAlias.name })
  const opaqueUri = buildSyncedPortableAssetUri({ hash: customHash, name: 'opaque-code-YAML-must-never-authorize.png' })
  const block = (type: 'paragraph' | 'code' | 'frontmatter', content: string) => ({ id: randomUUID(), type, content, checked: false, depth: 0, parentBlockId: null, tags: [] })
  const common = request(f.A.db, [documentId], sides => {
    const first = sides[0].blocks.find(value => value.type !== 'synced-block'); assert.ok(first)
    first.content = 'common exact overlap seed'
    sides[0].summary = `Whole W unchanged summary ![summary](<${summaryAsset.url}>)`
    sides[0].blocks.push(block('paragraph', `[W-ref]: <${summaryAsset.url}>\n\n[^W-note]: ![footnote](<${summaryAsset.url}>)`),
      block('code', `![opaque-code](<${opaqueUri}>)`), block('frontmatter', `opaque: "${opaqueUri}"`))
  })
  assert.equal(applySyncedHostFinal(f.A.db, common).status, 'applied')
  completed(await f.exchange(f.A), 'applied'); completed(await f.exchange(f.B), 'applied')
  hostEdit(f.A.db, documentId, 'REMOTE exact body overlap'); hostEdit(f.A.db, emptyId, 'REMOTE empty record overlap')
  completed(await f.exchange(f.A), 'applied')
  hostEdit(f.B.db, documentId, 'LOCAL exact body overlap'); hostEdit(f.B.db, emptyId, 'LOCAL empty record overlap')
  hostEdit(f.B.db, f.islands[1], `![real snapshot supplier](<${supplier.url}>)`)
  const customText = `  实际 W 😀 ![pending](<${customUri}>)\r\n![cross-block][W-ref] [^W-note]  `
  const emptyText = 'real selected custom W without any destination'
  const preview = ready(await f.preview())
  const decisions = [[documentId, customText], [emptyId, emptyText]].map(([id, text]) => mergeDecision(component(preview, 'doc:' + id), part => {
    assert.equal(part.field, 'block-content'); assert.equal(part.canEditText, true)
    return { choice: 'custom', text }
  })).sort((a, b) => a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0)
  const operationId = randomUUID(), gate = f.gate(value => value.method === 'PUT' && value.path.endsWith('/manifest.json') && Boolean(value.ifMatch))
  const resolving = f.resolve(preview, decisions, operationId)
  try {
    await gate.wait(resolving)
    assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId), undefined)
    assert.equal(readStrictHostDocument(f.B.db, documentId).content.blocks.some(value => value.content.includes(customUri)), false)
    const jobs = f.B.db.prepare('SELECT CAST(_rowid_ AS TEXT) AS rowid,key,value FROM app_settings WHERE substr(key,1,?)=? ORDER BY key')
      .all(exchangeJobPrefix(operationId).length, exchangeJobPrefix(operationId)) as Array<{ rowid: string; key: string; value: string }>
    assert.equal(jobs.length, 1)
    const originalJob = jobs[0], job = validateExchangeJob(parseExchangeStored(originalJob.value))
    assert.equal(job.request.method, 'resolveSyncedExchangeConflicts')
    if (job.request.method !== 'resolveSyncedExchangeConflicts') throw new Error('Actual conflict job required')
    assert.deepEqual(job.request.decisions, decisions)
    const spool = join(f.B.root, 'storage', 'synced-exchanges-v1', operationId, job.attemptId)
    const assetDescriptor = job.descriptor.next.assets.find(value => value.hash === customHash)
    assert.ok(assetDescriptor); assert.ok(assetDescriptor.names.includes(customAlias.name))
    assert.deepEqual(await readFile(join(spool, ...assetDescriptor.path.split('/'))), customBytes)
    const expectedContextFiles: Array<{ name: string; sha256: string; bytes: number }> = []
    for (const name of ['inputs.json', 'job.json', 'ready.json', 'manifest.json', ...new Set(job.descriptor.next.objects.map(value => value.path)), ...job.descriptor.next.assets.map(value => value.path)]) {
      const originalBytes = await readFile(join(spool, ...name.split('/')))
      expectedContextFiles.push({ name, sha256: capsuleBytesHash(originalBytes), bytes: originalBytes.length })
    }
    if (withoutManagedCustomAliases) {
      // The real snapshot already read these bytes and the real job already
      // spooled them. Removing live aliases must not remove sealed spool proof.
      await unlink(fileURLToPath(supplier.url)); await unlink(fileURLToPath(customAlias.url))
    }
    const pendingSql = allTables(f.B.db), original = await captureAssetOriginal({ userDataRoot: f.B.root, db: f.B.db })
    const archive = await prepareCapsule2AssetArchiveWithContextProvenance3(original.original)
    assert.deepEqual(allTables(f.B.db), pendingSql, 'The genuine producer does not install W or mutate original pending SQL')
    assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId), undefined,
      'The archive completed while the genuine publication and receipt were still pending')
    assert.equal(readStrictHostDocument(f.B.db, documentId).content.blocks.some(value => value.content.includes(customUri)), false)
    // No new request deadline, file timeout, concurrency setting or fake gate.
    // The archive has already sealed and fully checked the original context
    // while held. Later seal/material reads must use those immutable originals,
    // after releasing the real request rather than extending its 45s deadline.
    gate.release(); completed(await resolving, 'applied')
    const postResolveSql = allTables(f.B.db)
    assert.ok(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId),
      'Only the real resumed writer settles the operation before source sealing')
    assert.ok(readStrictHostDocument(f.B.db, documentId).content.blocks.some(value => value.content.includes('实际 W 😀')),
      'The live workspace now contains the genuinely installed W, distinct from the pending original')
    const saved = await captureSealedCapsule2SourceFromArchive(archive)
    assert.equal(saved.value.assetArchive.version, 3)
    const inputs = await readCapsule2ArchiveSourceInputs(archive)
    assert.ok(inputs.supplemental)
    if (!inputs.supplemental) throw new Error('Real v3 source getter must reconstruct its supplemental observation')
    assert.deepEqual(allTables(f.B.db), postResolveSql, 'Seal/material rereads do not change the post-resolve live workspace')
    assert.deepEqual(await restoreInventory(original.info.originalDirectory), original.inventory)
    const originalRaw = saved.value.source.sourceContent
    const originalJobs = graph3Rows(originalRaw, 'app_settings').filter(row => row.value.key === originalJob.key)
    assert.equal(originalJobs.length, 1); assert.equal(originalJobs[0].original.sourceRowId, originalJob.rowid)
    assert.equal(originalJobs[0].value.value, originalJob.value, 'The seal keeps the original pending job spelling and custom text')
    assert.equal(graph3Rows(originalRaw, 'synced_operations').some(row => row.value.client_operation_id === operationId), false,
      'The new live receipt must never be borrowed to upgrade the sealed pending source')
    assert.equal(saved.value.source.assets.scopes.some(scope => scope.destinations.some(destination => destination.uri === customUri)), false,
      'The new live W must never replace the original base observation')
    if (withoutManagedCustomAliases) {
      assert.deepEqual(await readFile(fileURLToPath(customAlias.url)), customBytes, 'The actual resumed writer restored the live alias; it is observed only as a fixture assertion')
      assert.equal(saved.value.assetArchive.tree.files.some(file => file.hash === customHash), false,
        'Later sealing must retain the captured missing-managed state rather than borrow today\'s restored alias')
    }
    return { f, documentId, emptyId, operationId, originalJob, job, spool, expectedContextFiles, customHash, customBytes, customUri, customText, emptyText,
      summaryUri, opaqueUri, original, archive, saved, supplemental: inputs.supplemental, archiveDirectory: inputs.value.directory,
      sealInput: { profileRoot: original.info.profileRoot, operationId: saved.info.manifest.operationId, capsuleId: saved.info.manifest.capsuleId, expectedManifestHash: saved.info.manifestHash } }
  } finally { gate.release(); await Promise.allSettled([resolving]) }
}

export function withCapturedContext3(run: (captured: Captured) => Promise<void>, options: { withoutManagedCustomAliases?: boolean } = {}) {
  return withConflicts(async f => run(await preparePendingContext3(f, options.withoutManagedCustomAliases ?? false)))
}
