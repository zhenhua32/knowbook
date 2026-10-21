import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { readInitialIncomingWorkspace } from '../src/main/database/synced-initial-incoming-read'
import { readRawInitialIncomingWorkspaceOwned } from '../src/main/database/synced-initial-incoming-raw-read'
import { prepareDurableSqlCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { certifyDurableSqlCapsuleOriginal, diagnoseCertifiedDurableSqlCapsule,
  readCertifiedDurableSqlCapsule } from '../src/main/database/restore-knowledge-capsule-read'
import { copyRestoreInventory, restoreInventory } from '../src/main/database/restore-safety-files'
import { withControlledRestore, KnowbookStore, restoreKnowbookDatabase, noProcesses, assertOriginals,
  inspect } from './helpers/controlled-restore-fixture'

function saveUnregisteredOrdinaryTemplate(store: KnowbookStore) {
  // A real supported draft need not have block IDs. Saving the template assigns
  // its own IDs without creating physical blocks or reserving ledger identities.
  const template = store.saveDocumentTemplate({ name: 'Independent ordinary draft', title: 'Ordinary template title',
    summary: 'Template-only ordinary facts', blocks: [
      { type: 'paragraph', content: 'New ordinary template block without a caller ID', checked: false, depth: 0, parentBlockId: null }
    ] })
  const db = store.getUnsafeDatabaseHandle()
  const row = db.prepare('SELECT blocks_json FROM document_templates WHERE id=?').get(template.id) as { blocks_json: string }
  assert.ok(row)
  const ids = (JSON.parse(row.blocks_json) as Array<{ id: unknown }>).map(block => {
    assert.equal(typeof block.id, 'string')
    return block.id as string
  })
  assert.equal(ids.length, 1)
  for (const id of ids) {
    assert.equal(db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(id), undefined,
      'A genuine newly saved template ID has no original ledger entry')
    assert.equal(db.prepare('SELECT 1 FROM blocks WHERE id=?').get(id), undefined,
      'Saving a template does not insert a physical document block')
  }
  return { id: template.id, ids, blocksJson: row.blocks_json }
}
function assertTemplateFacts(db: Database.Database, expected: ReturnType<typeof saveUnregisteredOrdinaryTemplate>) {
  const row = db.prepare('SELECT blocks_json FROM document_templates WHERE id=?').get(expected.id) as { blocks_json: string } | undefined
  assert.equal(row?.blocks_json, expected.blocksJson, 'The original ordinary template JSON is preserved exactly')
  for (const id of expected.ids) assert.equal(db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(id), undefined,
    'Certification and ordinary restoration must not invent template ledger facts')
}
function assertCaptured(directory: string, label: 'source' | 'current') {
  const diagnostic = JSON.parse(readFileSync(join(directory, label + '-durable-sql.json'), 'utf8')) as {
    status: string; material: string; certifiedForInstallation: boolean
  }
  assert.equal(diagnostic.status, 'certified')
  assert.equal(diagnostic.material, 'durable-sql-only')
  assert.equal(diagnostic.certifiedForInstallation, false)
}

test('ordinary controlled restore accepts a real source template whose generated block IDs have no ledger and preserves its original JSON', () => withControlledRestore(async f => {
  const sourceStore = new KnowbookStore(f.backup)
  let template: ReturnType<typeof saveUnregisteredOrdinaryTemplate>
  try { template = saveUnregisteredOrdinaryTemplate(sourceStore) } finally { sourceStore.destroy() }
  const originalSource = Buffer.from(readFileSync(f.backup)), originalCurrent = f.sealCurrent()
  const result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  assert.equal(result.continuity, 'ordinary-verified')
  assertCaptured(result.recoveryDirectory, 'source')
  inspect(f.database, db => assertTemplateFacts(db, template))
  assert.deepEqual(readFileSync(f.backup), originalSource)
  assert.deepEqual(readFileSync(join(result.recoveryDirectory, 'source-original', 'knowbook.db')), originalSource)
  assertOriginals(join(result.recoveryDirectory, 'original', 'knowbook.db'), originalCurrent)
}))

test('ordinary controlled restore accepts a real current template without ledger IDs and preserves its stopped original facts without copying them into the source', () => withControlledRestore(async f => {
  const template = saveUnregisteredOrdinaryTemplate(f.current), originalCurrent = f.sealCurrent()
  const result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  assert.equal(result.continuity, 'ordinary-verified')
  assertCaptured(result.recoveryDirectory, 'current')
  const archived = join(result.recoveryDirectory, 'original', 'knowbook.db')
  assertOriginals(archived, originalCurrent)
  // SQLite reads an independent oracle; the sealed three-file current archive
  // is never opened by this assertion or allowed to rebuild its own SHM.
  const oracle = join(f.root, 'current-template-read-oracle')
  mkdirSync(oracle)
  for (const file of originalCurrent) writeFileSync(join(oracle, file.name), file.bytes, { flag: 'wx' })
  inspect(join(oracle, 'knowbook.db'), db => assertTemplateFacts(db, template))
  assertOriginals(archived, originalCurrent)
  inspect(f.database, db => assert.equal(db.prepare('SELECT 1 FROM document_templates WHERE id=?').get(template.id), undefined,
    'The ordinary source remains the installed content; capturing current is not a template merge'))
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))

test('a real unregistered ordinary template remains raw SQL evidence while the public incoming reader retains its original ledger rejection', () => withControlledRestore(async f => {
  const template = saveUnregisteredOrdinaryTemplate(f.current)
  const before = {
    schema: f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
    identities: f.db.prepare('SELECT * FROM block_identities ORDER BY id').all(),
    changes: f.db.prepare('SELECT total_changes() AS count').get()
  }
  const raw = f.db.transaction(() => readRawInitialIncomingWorkspaceOwned(f.db))()
  assert.deepEqual([...raw.unregisteredTemplateBlocks].sort(), [...template.ids].sort())
  for (const id of template.ids) {
    assert.ok(raw.historyBlocks.has(id), 'Raw evidence retains the actual template name in its complete historical inventory')
    assert.equal(raw.identities.has(id), false, 'Raw evidence does not turn a template name into a retained identity')
  }
  assert.throws(() => f.db.transaction(() => readInitialIncomingWorkspace(f.db))(), /本机历史块缺少原保留 ledger/)
  assertTemplateFacts(f.db, template)
  assert.deepEqual(f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(), before.schema)
  assert.deepEqual(f.db.prepare('SELECT * FROM block_identities ORDER BY id').all(), before.identities)
  assert.deepEqual(f.db.prepare('SELECT total_changes() AS count').get(), before.changes)

  const originalCurrent = f.sealCurrent(), inventory = await restoreInventory(dirname(f.database))
  const recoveryDirectory = join(f.profile, 'backups', 'database-restore', randomUUID())
  mkdirSync(recoveryDirectory, { recursive: true })
  const sealedDirectory = join(recoveryDirectory, 'sealed-template-original')
  await copyRestoreInventory(dirname(f.database), sealedDirectory, inventory, f.profile)
  const original = await prepareDurableSqlCapsuleOriginal({ profileRoot: f.profile, recoveryDirectory,
    sealedDirectory, capsuleId: randomUUID(), label: 'ordinary template raw evidence' })
  const capsule = await certifyDurableSqlCapsuleOriginal(original), seal = await readCertifiedDurableSqlCapsule(capsule)
  assert.equal(seal.manifest.material, 'durable-sql-only')
  assert.equal((await diagnoseCertifiedDurableSqlCapsule(capsule)).certifiedForInstallation, false)
  assert.deepEqual(await restoreInventory(sealedDirectory), inventory)
  assertOriginals(f.database, originalCurrent)
}))

test('ordinary controlled restore preserves a real Store source title beyond the publication limit while the public reader still refuses it', () => withControlledRestore(async f => {
  const sourceStore = new KnowbookStore(f.backup), title = '长'.repeat(501)
  try {
    const detail = sourceStore.getDocumentDetail(f.id)
    assert.ok(detail)
    sourceStore.updateDocument(f.id, { title, summary: detail.summary, blocks: detail.blocks })
    assert.equal(sourceStore.getDocumentDetail(f.id)?.title, title, 'The ordinary writer really accepts and persists this title')
  } finally { sourceStore.destroy() }
  const raw = new Database(f.backup, { readonly: true, fileMustExist: true })
  try {
    raw.pragma('foreign_keys=ON')
    const before = raw.prepare('SELECT total_changes() AS count').get()
    assert.throws(() => raw.transaction(() => readInitialIncomingWorkspace(raw))(), /文档标题无效/)
    assert.equal((raw.prepare('SELECT title FROM documents WHERE id=?').get(f.id) as { title: string }).title, title)
    assert.deepEqual(raw.prepare('SELECT total_changes() AS count').get(), before)
  } finally { raw.close() }
  const originalSource = Buffer.from(readFileSync(f.backup)), originalCurrent = f.sealCurrent()
  const result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  assert.equal(result.continuity, 'ordinary-verified')
  assertCaptured(result.recoveryDirectory, 'source')
  inspect(f.database, db => assert.equal((db.prepare('SELECT title FROM documents WHERE id=?').get(f.id) as { title: string }).title, title))
  assert.deepEqual(readFileSync(f.backup), originalSource)
  assert.deepEqual(readFileSync(join(result.recoveryDirectory, 'source-original', 'knowbook.db')), originalSource)
  assertOriginals(join(result.recoveryDirectory, 'original', 'knowbook.db'), originalCurrent)
}))
