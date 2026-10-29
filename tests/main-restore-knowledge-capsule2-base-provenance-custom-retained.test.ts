// Separate file so the original seven producer tests keep their
// unchanged file budget. No job/capability DTO is fabricated. The real HTTP
// publication gate freezes an actual durable custom decision before W install.
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { constants } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { AttachmentStore } from '../src/main/attachments'
import { buildSyncedPortableAssetUri } from '../src/shared/syncedBlockPortable'
import { capsuleBytesHash } from '../src/main/database/restore-knowledge-capsule-model'
import { capsule2DerivedFtsTables, type Capsule2Encoding } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { rawRestoreSqlCell, type RawRestoreSqlCell } from '../src/main/database/restore-knowledge-sql-cell'
import { graph3Rows, graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { restoreSqliteFilename } from '../src/main/database/restore-safety-sqlite-path'
import { restoreInventory } from '../src/main/database/restore-safety-files'
import { validateExchangeJob, parseExchangeStored, exchangeJobPrefix } from '../src/main/sync/synced-exchange-model'
import { captureSealedCapsule2SourceWithAssetProvenance3,
  readSealedCapsule2SourceMaterial } from '../src/main/database/restore-knowledge-capsule2-source-seal'
import { withConflicts, hostEdit, completed, ready, component, mergeDecision, randomUUID,
  readStrictHostDocument } from './helpers/synced-exchange-conflict-fixture'
import { captureAssetOriginal } from './helpers/capsule2-assets-fixture'
import { allTables } from './helpers/synced-backup-v3-fixture'

const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"'
type NativeTable = { name: string; columns: string[]; rows: Array<{ sourceRowId: string; cells: RawRestoreSqlCell[] }> }
/** Independent SELECT of original native rowids/storage classes/text BLOBs.
 * It neither calls a production source projector nor derives expected rows
 * from the new material/result. The existing cell wire codec is shared only
 * to compare the specified raw-cell representation. */
async function nativeOriginal(original: Awaited<ReturnType<typeof captureAssetOriginal>>, oracleDirectory: string) {
  // SQLite never opens sealed original files (readonly may still create SHM).
  // Copy the complete physical DB/WAL/SHM set into an independent wx oracle.
  const before = await restoreInventory(original.info.originalDirectory)
  assert.deepEqual(before, original.inventory)
  await mkdir(oracleDirectory)
  for (const file of before) if (file.present)
    await copyFile(join(original.info.originalDirectory, file.name), join(oracleDirectory, file.name), constants.COPYFILE_EXCL)
  assert.deepEqual(await restoreInventory(oracleDirectory), before)
  const db = new Database(restoreSqliteFilename(join(oracleDirectory, 'knowbook.db')), { readonly: true, fileMustExist: true })
  try {
    db.pragma('foreign_keys=ON'); db.pragma('query_only=ON')
    return db.transaction(() => {
      const encoding = db.pragma('encoding', { simple: true }) as Capsule2Encoding
      const derived = new Set(capsule2DerivedFtsTables())
      const names = (db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND substr(name,1,7)<>'sqlite_' ORDER BY name").all() as Array<{ name: string }>)
        .map(value => value.name).filter(name => !derived.has(name))
      const tables: NativeTable[] = names.map(name => {
        const columns = db.prepare('SELECT * FROM main.' + quote(name) + ' LIMIT 0').columns().map(column => column.name)
        const projection = columns.flatMap(column => ['typeof(' + quote(column) + ')', 'CASE WHEN typeof(' + quote(column) + ")='text' THEN CAST("
          + quote(column) + ' AS BLOB) ELSE ' + quote(column) + ' END']).join(',')
        const raw = db.prepare('SELECT _rowid_,' + projection + ' FROM main.' + quote(name) + ' ORDER BY _rowid_').safeIntegers(true).raw(true).all() as unknown[][]
        return { name, columns, rows: raw.map(row => ({ sourceRowId: String(row[0]),
          cells: columns.map((_column, index) => rawRestoreSqlCell(row[index * 2 + 1], row[index * 2 + 2], encoding)) })) }
      })
      return { encoding, tables }
    })()
  } finally {
    db.close()
    assert.deepEqual(await restoreInventory(original.info.originalDirectory), before, 'Independent SQL oracle leaves every sealed original byte unchanged')
  }
}

test('genuine base producer retains an actual pending custom merge and every original SQL cell without claiming supplemental asset capture',
  { concurrency: false }, () => withConflicts(async f => {
    const documentId = f.islands[0]
    hostEdit(f.A.db, documentId, 'REMOTE actual overlap before custom asset')
    completed(await f.exchange(f.A), 'applied')
    hostEdit(f.B.db, documentId, 'LOCAL actual overlap before custom asset')
    const bytes = Buffer.from('actual independently imported supplemental-only asset bytes')
    const assets = new AttachmentStore(join(f.B.root, 'storage', 'assets'))
    const [supplier, asset] = await assets.import([
      { name: 'snapshot-byte-supplier.png', bytes }, { name: 'custom-scope-only.png', bytes }
    ])
    const assetHash = capsuleBytesHash(bytes), uri = buildSyncedPortableAssetUri({ hash: assetHash, name: asset.name })
    // Exchange material captures only real typed snapshot references, keyed
    // by hash. An unreferenced import is not a source capability. A different
    // genuine alias supplies those same bytes through an unrelated real host;
    // the custom URI/name remains absent from every base SQL content holder.
    assert.notEqual(supplier.name, asset.name); assert.notEqual(supplier.url, uri)
    hostEdit(f.B.db, f.islands[1], `![actual snapshot byte supplier](<${supplier.url}>)`)
    assert.ok(readStrictHostDocument(f.B.db, f.islands[1]).content.blocks.some(block => block.content.includes(supplier.url)))
    const wanted = `  真正 custom 😀 ![supplement-only](<${uri}>)\r\n原文尾部空格  `
    const preview = ready(await f.preview()), actualComponent = component(preview, 'doc:' + documentId)
    const decision = mergeDecision(actualComponent, part => {
      assert.equal(part.field, 'block-content'); assert.equal(part.canEditText, true)
      return { choice: 'custom', text: wanted }
    })
    const operationId = randomUUID()
    const gate = f.gate(request => request.method === 'PUT' && request.path.endsWith('/manifest.json') && Boolean(request.ifMatch))
    const resolving = f.resolve(preview, [decision], operationId)
    try {
      await gate.wait(resolving)
      assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId), undefined,
        'Publication is still pending: no settled receipt or installed W is fabricated')
      assert.equal(readStrictHostDocument(f.B.db, documentId).content.blocks.some(block => block.content.includes(uri)), false)
      const jobs = (f.B.db.prepare('SELECT CAST(_rowid_ AS TEXT) AS rowid,key,value FROM app_settings WHERE substr(key,1,?)=? ORDER BY key')
        .all(exchangeJobPrefix(operationId).length, exchangeJobPrefix(operationId)) as Array<{ rowid: string; key: string; value: string }>).map(row => ({ row, job: validateExchangeJob(parseExchangeStored(row.value)) }))
      assert.equal(jobs.length, 1, 'The actual resolve writer persisted its original immutable attempt')
      const actual = jobs[0], job = actual.job
      assert.equal(job.request.method, 'resolveSyncedExchangeConflicts')
      if (job.request.method !== 'resolveSyncedExchangeConflicts') throw new Error('Expected genuine typed conflict request')
      assert.deepEqual(job.request.decisions, [decision])
      const custom = job.request.decisions.flatMap(item => item.choice === 'merge' ? item.records.flatMap(record => record.parts
        .filter(part => part.value.choice === 'custom').map(part => ({ key: record.key, part }))) : [])
      assert.equal(custom.length, 1)
      assert.equal(custom[0].key, 'doc:' + documentId)
      assert.equal(custom[0].part.value.choice, 'custom')
      if (custom[0].part.value.choice !== 'custom') throw new Error('Expected actual persisted custom text')
      assert.equal(custom[0].part.value.text, wanted)
      const liveBeforeCapture = allTables(f.B.db)
      const original = await captureAssetOriginal({ userDataRoot: f.B.root, db: f.B.db })
      assert.deepEqual(allTables(f.B.db), liveBeforeCapture, 'Online backup never installs the actual pending decision')
      // Keep the genuine WebDav 45s request limit. Once immutable SQL exists,
      // release publication before the producer's repeated source validations;
      // every later source read must still use that original pending snapshot.
      gate.release()
      completed(await resolving, 'applied')
      assert.equal(readStrictHostDocument(f.B.db, documentId).content.blocks.some(block => block.content.includes('supplement-only')), true,
        'Only the genuine exchange writer installs its W after publication resumes')
      const liveBeforeProducer = allTables(f.B.db)
      const expected = await nativeOriginal(original, join(f.folder, 'custom-retained-native-oracle-' + randomUUID()))
      const captured = await captureSealedCapsule2SourceWithAssetProvenance3(original.original)
      const value = await readSealedCapsule2SourceMaterial(captured.source), raw = value.source.sourceContent
      assert.equal(raw.encoding, expected.encoding)
      assert.deepEqual(raw.tables.map(table => table.name), expected.tables.map(table => table.name), 'No original policy/history/content table disappears')
      for (const table of raw.tables) {
        const native = expected.tables.find(candidate => candidate.name === table.name)!
        assert.deepEqual(table.columns, native.columns)
        assert.deepEqual(table.rows, native.rows, 'Every source rowid, SQL storage class and original cell byte survives: ' + table.name)
      }
      const uriCells = expected.tables.flatMap(table => table.rows.flatMap(row => row.cells.flatMap((cell, index) =>
        cell[0] === 'text' && graph3Text(cell, expected.encoding).includes(uri)
          ? [{ table: table.name, sourceRowId: row.sourceRowId, column: table.columns[index] }] : [])))
      assert.deepEqual(uriCells, [{ table: 'app_settings', sourceRowId: actual.row.rowid, column: 'value' }],
        'Independent original SQL proves the URI exists only in the durable custom-request holder, not a hidden base/history/ACK field')
      const retained = graph3Rows(raw, 'app_settings').filter(row => row.value.key === actual.row.key)
      assert.equal(retained.length, 1)
      assert.equal(retained[0].original.sourceRowId, actual.row.rowid)
      assert.equal(retained[0].value.value, actual.row.value, 'Exact stored JSON spelling, custom UTF16 text and whitespace remain original')
      const retainedJob = validateExchangeJob(parseExchangeStored(String(retained[0].value.value)))
      assert.deepEqual(retainedJob.request, job.request)
      assert.equal(value.source.assets.scopes.some(scope => scope.destinations.some(destination => destination.uri === uri)), false,
        'This URI exists only in the actual supplemental custom request while W is not installed')
      assert.equal(value.source.assets.scopes.some(scope => scope.destinations.some(destination => destination.uri === supplier.url)), true,
        'The distinct real supplier alias is independently observed in the original typed base snapshot')
      assert.equal(value.assetArchive.version, 2)
      if (value.assetArchive.version !== 2) throw new Error('Expected explicit base archive2 producer')
      assert.equal(value.assetArchive.referenceUris.includes(uri), false)
      assert.equal(value.assetArchive.referenceUris.includes(supplier.url), true)
      assert.equal(value.assetArchive.tree.files.some(file => file.hash === assetHash && file.bytes === bytes.length), true,
        'Real file availability must not be mistaken for semantic base scope capture')
      assert.equal(value.assetArchive.referenceProvenance.entries.length, value.assetArchive.referenceUris.length)
      assert.equal(value.assetArchive.coverage.baseTypedScopesCaptured, true)
      assert.equal(value.assetArchive.coverage.supplementalCustomMergeScopesCaptured, false)
      assert.equal(value.assetArchive.coverage.allAssetScopesCaptured, false)
      assert.equal(value.assetArchive.coverage.finalAssetClosureComplete, false)
      assert.equal(value.assetArchive.coverage.installPermit, false)
      assert.equal(value.assetArchive.coverage.acceptedCoverage, false)
      assert.equal(value.assetArchive.permit, false)
      assert.deepEqual(allTables(f.B.db), liveBeforeProducer, 'Producer never installs/replays the pending decision retained in its original')
      assert.equal(captured.info.manifest.sourceMaterialHash, value.materialHash)
      assert.equal(captured.info.manifest.assetArchiveHash, value.assetArchiveHash)
      const afterLiveCommit = await readSealedCapsule2SourceMaterial(captured.source)
      assert.deepEqual(afterLiveCommit.source.sourceContent, raw, 'The source keeps the original pending SQL after the live writer later settles')
      assert.equal(afterLiveCommit.materialHash, value.materialHash)
    } finally { gate.release(); await Promise.allSettled([resolving]) }
  }))
