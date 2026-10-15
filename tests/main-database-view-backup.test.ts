import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownBackupService, writeBackupSnapshot, type BackupExportJob } from '../src/main/backup/exporter'
import { MarkdownRestoreService, type ParsedBackupDocument } from '../src/main/backup/importer'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { parseDatabaseViewPayload, serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { parseMarkdownBackupDocument } from '../src/shared/markdown'
import { databaseFile, parseArchiveV2, readV2Header } from '../src/main/backup/v2-format'
import { KNOWBOOK_BACKUP_MARKER } from '../src/shared/markdownFrontmatter'

async function stores(run: (source: KnowbookStore, target: KnowbookStore, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-backup-v2-'))
  const source = new KnowbookStore(join(root, 'source.sqlite')), target = new KnowbookStore(join(root, 'target.sqlite'))
  for (const store of [source, target]) for (const document of store.getAllDocumentSnapshots().reverse()) store.deleteDocument(document.id)
  try { await run(source, target, root) } finally { source.destroy(); target.destroy(); rmSync(root, { recursive: true, force: true }) }
}
const catalog = (store: KnowbookStore) => store.getDatabases().find(source => source.kind === 'document-catalog')!
function config(field: string, query = '') {
  const value = createDefaultDatabaseViewConfig('table')
  return { ...value, query, filters: { operator: 'and' as const, rules: [{ operator: 'or' as const, rules: [{ id: 'filter-one', fieldId: field, operator: 'contains' as const, value: field }] }] },
    sorts: [{ fieldId: field, direction: 'asc' as const }], groupBy: { fieldId: field }, visibleFieldIds: ['__title__', field], fieldOrder: [field, '__title__'], columnWidths: { [field]: 317 }, cardFieldIds: [field] }
}
function document(store: KnowbookStore, title: string, databaseId: string, fieldId: string, viewId: string | null, query = '') {
  const id = store.createDocument(null)
  store.updateDocument(id, { title, summary: '', blocks: [{ id: `host-${id}`, type: 'database-view', checked: false, depth: 0,
    content: serializeDatabaseViewPayload({ version: 1, databaseId, viewId, config: config(fieldId, query) }) }] })
  return id
}
function worker<T>(file: string, workerData: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = new Worker(new URL(`./helpers/${file}`, import.meta.url), { workerData, execArgv: [] })
    child.once('error', reject)
    child.once('message', (message: { ok: boolean; message?: string; exported?: number; parsedDocuments?: ParsedBackupDocument[] }) => {
      if (!message.ok) reject(new Error(message.message))
      else resolve((message.parsedDocuments ?? message.exported) as T)
    })
    child.once('exit', code => { if (code) reject(new Error(`Backup fixture worker exited with ${code}`)) })
  })
}

test('V2 restores exact catalog/custom bindings, all config ID positions and provenance without same-name binding or repeated copies', () => stores(async (source, target, root) => {
  const sourceCatalog = catalog(source), targetCatalog = catalog(target)
  const column = source.createDocumentDatabaseColumn({ databaseId: sourceCatalog.id, name: 'Status', type: 'text' })
  const view = source.createDatabaseSavedView({ databaseId: sourceCatalog.id, name: 'Saved', config: config(column.id), filterScope: column.id })
  const custom = source.createDatabase({ name: 'Projects' })
  const customColumn = source.createDocumentDatabaseColumn({ databaseId: custom.id, name: 'Status', type: 'text' })
  const customView = source.createDatabaseSavedView({ databaseId: custom.id, name: 'Saved', config: config(customColumn.id) })
  const first = document(source, 'First', sourceCatalog.id, column.id, view.id)
  const second = document(source, 'Second', sourceCatalog.id, column.id, view.id, 'independent')
  const third = document(source, 'Custom', custom.id, customColumn.id, customView.id)
  source.updateDocumentDatabaseValue({ documentId: first, columnId: column.id, value: 'catalog value' })
  source.createDatabaseEntity({ databaseId: sourceCatalog.id, title: 'Detached', fieldValues: { [column.id]: 'detached value' } })
  source.createDatabaseEntity({ databaseId: custom.id, documentId: third, title: 'Linked', fieldValues: { [customColumn.id]: 'custom value' } })
  const unrelated = target.createDatabase({ name: 'Projects' })
  const collision = target.createDocumentDatabaseColumn({ databaseId: unrelated.id, name: 'Status', type: 'text' })
  target.getUnsafeDatabaseHandle().prepare('UPDATE document_database_columns SET id=? WHERE id=?').run(column.id, collision.id)
  const targetView = target.createDatabaseSavedView({ databaseId: targetCatalog.id, name: 'Saved' })
  const backup = join(root, 'backup')
  await new MarkdownBackupService(source, backup).exportAll()
  assert.equal(readV2Header(readFileSync(join(backup, '__knowbook/databases/index.md'), 'utf8'))!.backupFormatVersion, '2')
  const restore = new MarkdownRestoreService(target)
  await restore.previewFromDirectory(backup); await restore.restoreFromDirectory(backup)
  const payload = parseDatabaseViewPayload(target.getDocumentDetail(first)!.blocks[0].content)
  assert.equal(payload.databaseId, targetCatalog.id)
  assert.notEqual(payload.config.sorts[0].fieldId, column.id, 'A cross-source collision must allocate and map a fresh field')
  assert.notEqual(payload.viewId, targetView.id, 'A same-name view is never source identity')
  const field = payload.config.sorts[0].fieldId
  assert.equal(payload.config.columnWidths[field], 317)
  assert.equal(payload.config.groupBy.fieldId, field)
  assert.deepEqual(payload.config.visibleFieldIds, ['__title__', field])
  assert.deepEqual(payload.config.fieldOrder, [field, '__title__'])
  assert.deepEqual(payload.config.cardFieldIds, [field])
  const rule = payload.config.filters.rules[0]
  assert.ok('rules' in rule)
  assert.equal('fieldId' in rule.rules[0] && rule.rules[0].fieldId, field)
  assert.equal('value' in rule.rules[0] && rule.rules[0].value, column.id, 'Filter data is not an identity')
  assert.equal(target.getDatabaseSavedViews(targetCatalog.id).find(item => item.id === payload.viewId)!.filterScope, field)
  assert.equal(target.getExportDocuments().find(item => item.id === first)!.documentDatabaseFieldValues[field], 'catalog value')
  assert.equal(target.getDatabaseEntities(targetCatalog.id)[0].fieldValues[field], 'detached value')
  assert.equal(parseDatabaseViewPayload(target.getDocumentDetail(second)!.blocks[0].content).config.query, 'independent')
  const customPayload = parseDatabaseViewPayload(target.getDocumentDetail(third)!.blocks[0].content)
  assert.equal(customPayload.databaseId, custom.id)
  assert.notEqual(customPayload.databaseId, unrelated.id)
  const before = target.getExportWorkspaceSnapshot()
  await restore.restoreFromDirectory(backup)
  const after = target.getExportWorkspaceSnapshot()
  assert.deepEqual(after.catalog.columns.map(item => item.id), before.catalog.columns.map(item => item.id))
  assert.deepEqual(after.catalog.savedViews.map(item => [item.id, item.name]), before.catalog.savedViews.map(item => [item.id, item.name]))
  assert.deepEqual(after.catalog.entities.map(item => item.id), before.catalog.entities.map(item => item.id))
  assert.deepEqual(after.documents.map(item => item.id), before.documents.map(item => item.id))
}))

test('V2 zero-document catalog retains views/detached entities and never deletes existing target documents', () => stores(async (source, target, root) => {
  const sourceId = catalog(source).id, targetId = catalog(target).id
  const column = source.createDocumentDatabaseColumn({ databaseId: sourceId, name: 'Owner', type: 'text' })
  source.createDatabaseSavedView({ databaseId: sourceId, name: 'Empty document catalog', config: config(column.id) })
  source.createDatabaseEntity({ databaseId: sourceId, title: 'No linked document', fieldValues: { [column.id]: 'retained' } })
  const keep = target.createDocument(null)
  const backup = join(root, 'empty')
  await new MarkdownBackupService(source, backup).exportAll()
  assert.ok(existsSync(join(backup, '__knowbook/databases/catalog.md')))
  const restore = new MarkdownRestoreService(target), preview = await restore.previewFromDirectory(backup)
  assert.equal(preview.restored, 0); assert.equal(preview.deleted, 0)
  await restore.restoreFromDirectory(backup)
  assert.ok(target.getDocumentDetail(keep))
  assert.equal(target.getDatabaseSavedViews(targetId).length, 1)
  assert.equal(target.getDatabaseEntities(targetId)[0].fieldValues[column.id], 'retained')
}))

test('V2 missing source/view/field references stay missing despite occupied target IDs and repeated restore', () => stores(async (source, target, root) => {
  const occupied = target.createDatabase({ name: 'Unrelated target' })
  const field = target.createDocumentDatabaseColumn({ databaseId: catalog(target).id, name: 'Unrelated field', type: 'text' })
  const view = target.createDatabaseSavedView({ databaseId: catalog(target).id, name: 'Unrelated view' })
  const host = document(source, 'Missing source', occupied.id, field.id, view.id)
  const backup = join(root, 'missing')
  await new MarkdownBackupService(source, backup).exportAll()
  const restore = new MarkdownRestoreService(target)
  await restore.restoreFromDirectory(backup)
  const first = target.getDocumentDetail(host)!.blocks[0].content, payload = parseDatabaseViewPayload(first)
  assert.notEqual(payload.databaseId, occupied.id)
  assert.notEqual(payload.viewId, view.id)
  assert.notEqual(payload.config.sorts[0].fieldId, field.id)
  assert.ok(!target.getDatabases().some(item => item.id === payload.databaseId))
  await restore.restoreFromDirectory(backup)
  assert.equal(target.getDocumentDetail(host)!.blocks[0].content, first)
}))

test('V2 export refuses malformed nonempty/unknown saved configs and only upgrades the exact legacy sentinel', () => stores(async (source, _target, root) => {
  const id = catalog(source).id, view = source.createDatabaseSavedView({ databaseId: id, name: 'Saved' })
  const sql = source.getUnsafeDatabaseHandle().prepare('UPDATE database_saved_views SET config_json=?,config_version=? WHERE id=?')
  for (const [raw, version] of [['{"version":9}', 1], ['{"version":1,"filters":{}}', 1], ['{broken', 1], ['{}', 9]] as const) {
    sql.run(raw, version, view.id)
    await assert.rejects(new MarkdownBackupService(source, join(root, 'bad')).exportAll())
    assert.equal(existsSync(join(root, 'bad')), false)
  }
  sql.run('{}', 1, view.id)
  await new MarkdownBackupService(source, join(root, 'legacy')).exportAll()
  assert.equal(source.getStrictDatabaseSavedViews(id)[0].config.version, 1)
}))

test('V2 configs are opaque to asset and Markdown link rewriting in saved views and hosts', () => stores(async (source, target, root) => {
  const sourceId = catalog(source).id, column = source.createDocumentDatabaseColumn({ name: 'Value', type: 'text' })
  const text = 'file:///missing/private.png [fake](../absent.md) ' + column.id
  const view = source.createDatabaseSavedView({ databaseId: sourceId, name: 'Opaque', config: config(column.id, text) })
  const host = document(source, 'Opaque host', sourceId, column.id, view.id, text)
  const backup = join(root, 'opaque')
  await new MarkdownBackupService(source, backup, join(root, 'managed-assets')).exportAll()
  assert.equal(existsSync(join(backup, '__knowbook/assets')), false)
  await new MarkdownRestoreService(target, join(root, 'target-assets')).restoreFromDirectory(backup)
  assert.equal(parseDatabaseViewPayload(target.getDocumentDetail(host)!.blocks[0].content).config.query, text)
  assert.equal(target.getStrictDatabaseSavedViews(catalog(target).id)[0].config.query, text)
}))

test('V2 archive corruption, duplicate raw headers and missing definitions reject before mutation and provenance publication', () => stores(async (source, target, root) => {
  const database = source.createDatabase({ name: 'Source' }), backup = join(root, 'corrupt')
  await new MarkdownBackupService(source, backup).exportAll()
  const manifest = join(backup, '__knowbook/databases/index.md'), original = readFileSync(manifest, 'utf8')
  const before = target.getExportWorkspaceSnapshot()
  writeFileSync(manifest, original.replace('backupFormatVersion: "2"', 'backupFormatVersion: "2"\nbackupFormatVersion: "2"'))
  await assert.rejects(new MarkdownRestoreService(target).previewFromDirectory(backup), /duplicate/)
  writeFileSync(manifest, original)
  rmSync(join(backup, databaseFile(database.id)))
  await assert.rejects(new MarkdownRestoreService(target).restoreFromDirectory(backup), /incomplete/)
  assert.deepEqual(target.getExportWorkspaceSnapshot(), before)
  assert.equal((target.getUnsafeDatabaseHandle().prepare('SELECT COUNT(*) AS count FROM backup_restore_identities').get() as { count: number }).count, 0)
}))

test('V2 document-only remnants without their marker cannot downgrade to legacy restore after the internal catalog is lost', () => stores(async (source, target, root) => {
  const column = source.createDocumentDatabaseColumn({ name: 'Referenced field', type: 'text' })
  document(source, 'Remaining document', catalog(source).id, column.id, null)
  const backup = join(root, 'document-remnant'), assets = join(root, 'target-assets')
  await new MarkdownBackupService(source, backup).exportAll()
  const file = join(backup, 'Remaining document.md'), original = readFileSync(file, 'utf8')
  rmSync(join(backup, '__knowbook'), { recursive: true, force: true })
  writeFileSync(file, original.replace(KNOWBOOK_BACKUP_MARKER + '\n', ''))
  const parsed = parseMarkdownBackupDocument(readFileSync(file, 'utf8'))
  assert.equal(parsed.isKnowbookBackup, true)
  assert.equal(parsed.frontmatter.backupFormatVersion, '2')
  assert.equal(readV2Header(readFileSync(file, 'utf8')), null)
  const keep = target.createDocument(null), before = target.getExportWorkspaceSnapshot()
  mkdirSync(assets); writeFileSync(join(assets, 'keep.txt'), 'unchanged')
  const restore = new MarkdownRestoreService(target, assets)
  await assert.rejects(restore.previewFromDirectory(backup), /V2 envelope or version is missing/)
  await assert.rejects(restore.restoreFromDirectory(backup), /V2 envelope or version is missing/)
  assert.deepEqual(target.getExportWorkspaceSnapshot(), before)
  assert.ok(target.getDocumentDetail(keep))
  assert.equal((target.getUnsafeDatabaseHandle().prepare('SELECT COUNT(*) AS count FROM backup_restore_identities').get() as { count: number }).count, 0)
  assert.deepEqual(readdirSync(assets), ['keep.txt'])
  assert.equal(readFileSync(join(assets, 'keep.txt'), 'utf8'), 'unchanged')
}))

test('V2 custom-only remnants without their marker cannot downgrade to legacy restore after manifest and catalog loss', () => stores(async (source, target, root) => {
  const database = source.createDatabase({ name: 'Source custom' })
  const column = source.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Field', type: 'text' })
  source.createDatabaseEntity({ databaseId: database.id, title: 'Source record', fieldValues: { [column.id]: 'source' } })
  const backup = join(root, 'custom-remnant')
  await new MarkdownBackupService(source, backup).exportAll()
  const file = join(backup, databaseFile(database.id)), original = readFileSync(file, 'utf8')
  rmSync(join(backup, '__knowbook/databases/index.md'))
  rmSync(join(backup, '__knowbook/databases/catalog.md'))
  writeFileSync(file, original.replace(KNOWBOOK_BACKUP_MARKER + '\n', ''))
  const parsed = parseMarkdownBackupDocument(readFileSync(file, 'utf8'))
  assert.equal(parsed.isKnowbookBackup, true)
  assert.equal(parsed.frontmatter.backupFormatVersion, '2')
  assert.equal(readV2Header(readFileSync(file, 'utf8')), null)
  target.createDatabase({ name: 'Source custom', description: 'Unrelated same-name target' })
  const before = target.getExportWorkspaceSnapshot(), restore = new MarkdownRestoreService(target)
  await assert.rejects(restore.previewFromDirectory(backup), /V2 envelope or version is missing/)
  await assert.rejects(restore.restoreFromDirectory(backup), /V2 envelope or version is missing/)
  assert.deepEqual(target.getExportWorkspaceSnapshot(), before)
  assert.equal((target.getUnsafeDatabaseHandle().prepare('SELECT COUNT(*) AS count FROM backup_restore_identities').get() as { count: number }).count, 0)
}))

test('ordinary user YAML may mention backup versions without becoming a complete backup or changing its document identity', () => stores(async (_source, target, root) => {
  const input = join(root, 'ordinary-yaml'), yaml = '---\nbackupFormatVersion: "9"\nbackupSnapshotId: "third-party-value"\nid: "third-party-id"\npath: "Unrelated/third-party-path"\nkind: "user-note"\n---'
  mkdirSync(input)
  writeFileSync(join(input, 'User YAML.md'), yaml + '\n\n# User YAML\n\nOrdinary content')
  assert.equal(parseMarkdownBackupDocument(readFileSync(join(input, 'User YAML.md'), 'utf8')).isKnowbookBackup, false)
  const keep = target.createDocument(null), restore = new MarkdownRestoreService(target)
  assert.equal((await restore.previewFromDirectory(input)).deleted, 0)
  await restore.restoreFromDirectory(input)
  assert.ok(target.getDocumentDetail(keep))
  const imported = target.getAllDocumentSnapshots().find(item => item.path === 'User YAML')!
  assert.ok(imported)
  assert.notEqual(imported.id, 'third-party-id')
  assert.equal(target.getDocumentDetail(imported.id)!.blocks[0].type, 'frontmatter')
  assert.equal(target.getDocumentDetail(imported.id)!.blocks[0].content, yaml)
}))

test('V2 real export/parse worker entries and in-memory jobs preserve the same complete sources', () => stores(async (source, target, root) => {
  const column = source.createDocumentDatabaseColumn({ name: 'Worker field', type: 'text' })
  source.createDatabaseSavedView({ databaseId: catalog(source).id, name: 'Worker catalog', config: config(column.id) })
  source.createDatabaseEntity({ databaseId: catalog(source).id, title: 'Worker detached', fieldValues: { [column.id]: 'same' } })
  const inlineRoot = join(root, 'inline'), workerRoot = join(root, 'worker'), snapshot = source.getExportWorkspaceSnapshot()
  writeBackupSnapshot({ ...snapshot, backupRoot: inlineRoot })
  const job: BackupExportJob = { databasePath: source.getDatabasePath(), backupRoot: workerRoot }
  await worker<number>('backup-export-worker.mjs', job)
  const input = (base: string) => ['__knowbook/databases/index.md', '__knowbook/databases/catalog.md'].map(path => ({ filePath: join(base, path), relativePath: path.slice(0, -3), markdown: readFileSync(join(base, path), 'utf8') }))
  const inline = input(inlineRoot), threaded = input(workerRoot)
  const parsed = await worker<ParsedBackupDocument[]>('backup-parse-worker.mjs', threaded.map(item => item.markdown))
  const first = parseArchiveV2(inline, inline.map(item => parseMarkdownBackupDocument(item.markdown)))!
  const second = parseArchiveV2(threaded, parsed)!
  assert.deepEqual(second.catalog, first.catalog)
  assert.equal(second.documents.length, 0)
  await new MarkdownRestoreService(target, undefined, {}, sources => worker('backup-parse-worker.mjs', sources)).restoreFromDirectory(workerRoot)
  assert.equal(target.getDatabaseEntities(catalog(target).id)[0].fieldValues[column.id], 'same')
  assert.equal(readdirSync(join(workerRoot, '__knowbook/databases')).length, 2)
}))

test('V2 older catalog snapshots prune only source-owned objects and reject cascading preserved document values', () => stores(async (source, target, root) => {
  const older = join(root, 'older'), newer = join(root, 'newer'), sourceId = catalog(source).id, targetId = catalog(target).id
  await new MarkdownBackupService(source, older).exportAll()
  const column = source.createDocumentDatabaseColumn({ name: 'Source owned', type: 'text' })
  source.createDatabaseSavedView({ databaseId: sourceId, name: 'Source view', config: config(column.id) })
  source.createDatabaseEntity({ databaseId: sourceId, title: 'Source record', fieldValues: { [column.id]: 'source' } })
  await new MarkdownBackupService(source, newer).exportAll()
  const localColumn = target.createDocumentDatabaseColumn({ name: 'Local', type: 'text' })
  const localView = target.createDatabaseSavedView({ databaseId: targetId, name: 'Local view' })
  const localEntity = target.createDatabaseEntity({ databaseId: targetId, title: 'Local record', fieldValues: { [localColumn.id]: 'local' } })
  const keep = target.createDocument(null), restore = new MarkdownRestoreService(target)
  await restore.restoreFromDirectory(newer)
  target.updateDocumentDatabaseValue({ documentId: keep, columnId: column.id, value: 'preserved dependency' })
  const before = target.getExportWorkspaceSnapshot()
  await assert.rejects(restore.previewFromDirectory(older), /prune.*preserved document values/)
  await assert.rejects(restore.restoreFromDirectory(older), /prune.*preserved document values/)
  assert.deepEqual(target.getExportWorkspaceSnapshot(), before)
  target.updateDocumentDatabaseValue({ documentId: keep, columnId: column.id, value: null })
  // A cleared cell has no dependency; remove its null serialization explicitly
  // to model a document which never used the source-owned field.
  target.getUnsafeDatabaseHandle().prepare('DELETE FROM document_database_values WHERE document_id=? AND column_id=?').run(keep, column.id)
  await restore.restoreFromDirectory(older)
  assert.ok(target.getDocumentDetail(keep))
  assert.deepEqual(target.getDocumentDatabaseColumns().map(item => item.id), [localColumn.id])
  assert.deepEqual(target.getDatabaseSavedViews(targetId).map(item => item.id), [localView.id])
  assert.deepEqual(target.getDatabaseEntities(targetId).map(item => item.id), [localEntity.id])
}))

test('V2 database failure rolls back complete sources, host identities, provenance and overwritten/new assets together', () => stores(async (source, target, root) => {
  const sourceAssets = join(root, 'source-assets'), targetAssets = join(root, 'target-assets'), backup = join(root, 'rollback')
  mkdirSync(sourceAssets); mkdirSync(targetAssets)
  writeFileSync(join(sourceAssets, 'image.png'), 'replacement'); writeFileSync(join(sourceAssets, 'new.png'), 'new')
  writeFileSync(join(targetAssets, 'image.png'), 'original')
  const column = source.createDocumentDatabaseColumn({ name: 'Attachment', type: 'text' })
  const sourceId = catalog(source).id, view = source.createDatabaseSavedView({ databaseId: sourceId, name: 'Rollback view', config: config(column.id) })
  const host = document(source, 'Rollback host', sourceId, column.id, view.id)
  const block = source.getDocumentDetail(host)!.blocks[0]
  source.updateDocument(host, { title: 'Rollback host', summary: '', blocks: [block,
    { id: 'actual-asset', type: 'paragraph', checked: false, depth: 0, content: `![asset](${pathToFileURL(join(sourceAssets, 'image.png'))}) ![new](${pathToFileURL(join(sourceAssets, 'new.png'))})` }] })
  source.createDatabaseEntity({ databaseId: sourceId, title: 'Asset record', fieldValues: { [column.id]: pathToFileURL(join(sourceAssets, 'image.png')).toString() } })
  await new MarkdownBackupService(source, backup, sourceAssets).exportAll()
  const keep = target.createDocument(null), before = target.getExportWorkspaceSnapshot()
  const update = target.updateDocument.bind(target)
  target.updateDocument = ((...args: Parameters<KnowbookStore['updateDocument']>) => { update(...args); throw new Error('Injected V2 write failure') }) as KnowbookStore['updateDocument']
  await assert.rejects(new MarkdownRestoreService(target, targetAssets).restoreFromDirectory(backup), /Injected V2 write failure/)
  assert.deepEqual(target.getExportWorkspaceSnapshot(), before)
  assert.ok(target.getDocumentDetail(keep))
  assert.equal(readFileSync(join(targetAssets, 'image.png'), 'utf8'), 'original')
  assert.equal(existsSync(join(targetAssets, 'new.png')), false)
  assert.equal((target.getUnsafeDatabaseHandle().prepare('SELECT COUNT(*) AS count FROM backup_restore_identities').get() as { count: number }).count, 0)
  assert.equal(readdirSync(root).some(name => name.startsWith('.target-assets-restore-')), false)
}))

test('V2 asset publication failure leaves the complete source plan and provenance unapplied', () => stores(async (source, target, root) => {
  const sourceAssets = join(root, 'source-assets'), targetAssets = join(root, 'target-assets'), backup = join(root, 'publish-failure')
  mkdirSync(sourceAssets); mkdirSync(targetAssets); mkdirSync(join(targetAssets, 'blocked.png'))
  writeFileSync(join(sourceAssets, 'blocked.png'), 'source'); writeFileSync(join(targetAssets, 'blocked.png', 'keep.txt'), 'keep')
  const id = source.createDocument(null)
  source.updateDocument(id, { title: 'Asset', summary: '', blocks: [{ id: 'blocked-asset', type: 'paragraph', checked: false, depth: 0,
    content: `![asset](${pathToFileURL(join(sourceAssets, 'blocked.png'))})` }] })
  await new MarkdownBackupService(source, backup, sourceAssets).exportAll()
  const before = target.getExportWorkspaceSnapshot()
  await assert.rejects(new MarkdownRestoreService(target, targetAssets).restoreFromDirectory(backup))
  assert.deepEqual(target.getExportWorkspaceSnapshot(), before)
  assert.equal(readFileSync(join(targetAssets, 'blocked.png', 'keep.txt'), 'utf8'), 'keep')
  assert.equal((target.getUnsafeDatabaseHandle().prepare('SELECT COUNT(*) AS count FROM backup_restore_identities').get() as { count: number }).count, 0)
}))

test('V2 preserves nested columns, atomic host metadata and one exact linked entity through an ID-preserving restore', () => stores(async (source, target, root) => {
  const sourceId = catalog(source).id, column = source.createDocumentDatabaseColumn({ name: 'Nested', type: 'text' })
  const view = source.createDatabaseSavedView({ databaseId: sourceId, name: 'Nested source', config: config(column.id) })
  const id = source.createDocument(null)
  source.updateDocument(id, { title: 'Columns', summary: 'Nested host', blocks: [
    { id: 'columns-root', type: 'columns', content: '', checked: false, depth: 0 },
    { id: 'left-column', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'columns-root', markdownFormat: { columnWeight: 3500 } },
    { id: 'nested-host', type: 'database-view', content: serializeDatabaseViewPayload({ version: 1, databaseId: sourceId, viewId: view.id, config: config(column.id) }), checked: false, depth: 2, parentBlockId: 'left-column' },
    { id: 'right-column', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'columns-root', markdownFormat: { columnWeight: 6500 } },
    { id: 'nested-code', type: 'code', content: 'literal [text](other.md#nested-host)', language: 'txt', checked: false, depth: 2, parentBlockId: 'right-column' }
  ] })
  const entity = source.createDatabaseEntity({ databaseId: sourceId, documentId: id, title: 'Linked catalog', fieldValues: { [column.id]: 'linked' } })
  const backup = join(root, 'columns')
  await new MarkdownBackupService(source, backup).exportAll()
  const service = new MarkdownRestoreService(target), preview = await service.previewFromDirectory(backup), result = await service.restoreFromDirectory(backup)
  assert.equal(result.created, preview.created)
  assert.equal(result.deleted, preview.deleted)
  const blocks = target.getDocumentDetail(id)!.blocks
  assert.deepEqual(blocks.map(block => [block.id, block.type, block.depth, block.parentBlockId, block.markdownFormat]), source.getDocumentDetail(id)!.blocks.map(block => [block.id, block.type, block.depth, block.parentBlockId, block.markdownFormat]))
  assert.equal(blocks[4].content, 'literal [text](other.md#nested-host)')
  assert.equal(parseDatabaseViewPayload(blocks[2].content).databaseId, catalog(target).id)
  assert.equal(target.getDatabaseEntities(catalog(target).id).find(item => item.id === entity.id)!.documentId, id)
}))

test('V2 releases restored children before deleting stale parents and same-title stale siblings', () => stores(async (source, target, root) => {
  const id = source.createDocument(null)
  source.updateDocument(id, { title: 'Child', summary: '', blocks: [{ id: 'source-child-text', type: 'paragraph', checked: false, depth: 0, content: 'Source state' }] })
  const parent = target.createDocument(null)
  target.updateDocument(parent, { title: 'Stale parent', summary: '', blocks: [] })
  const staleSibling = target.createDocument(null)
  target.updateDocument(staleSibling, { title: 'Child', summary: '', blocks: [] })
  target.applySyncRecords([{ kind: 'document', id, parentId: parent, sortOrder: 0, createdAt: new Date().toISOString(), content: {
    title: 'Child', summary: '', blocks: [{ id: 'target-child-text', type: 'paragraph', checked: false, depth: 0, content: 'Previous child state' }] } }])
  assert.equal(target.getDocumentSnapshot(id)!.path, 'Stale parent/Child')
  const backup = join(root, 'stale-parent'), service = new MarkdownRestoreService(target)
  await new MarkdownBackupService(source, backup).exportAll()
  const preview = await service.previewFromDirectory(backup), result = await service.restoreFromDirectory(backup)
  assert.equal(preview.updated, 1); assert.equal(preview.deleted, 2)
  assert.equal(result.updated, preview.updated); assert.equal(result.deleted, preview.deleted)
  assert.deepEqual(target.getAllDocumentSnapshots().map(item => [item.id, item.path]), [[id, 'Child']])
  assert.equal(target.getDocumentDetail(id)!.blocks[0].content, 'Source state')
}))

test('V2 keeps historical opaque block IDs and parent IDs through repeated source and target backups', () => stores(async (source, target, root) => {
  const id = source.createDocument(null), longId = 'long.' + '旧'.repeat(256)
  source.updateDocument(id, { title: 'Opaque IDs', summary: '', blocks: [
    { id: 'owner.中文:一', type: 'bulleted-list', content: 'Owner', checked: false, depth: 0 },
    { id: 'child.中文:二', type: 'bulleted-list', content: 'Child', checked: false, depth: 1, parentBlockId: 'owner.中文:一' },
    { id: longId, type: 'bulleted-list', content: 'Long historical identity', checked: false, depth: 1, parentBlockId: 'owner.中文:一' }
  ] })
  const first = join(root, 'first-opaque'), second = join(root, 'second-opaque')
  await new MarkdownBackupService(source, first).exportAll()
  const service = new MarkdownRestoreService(target)
  await service.restoreFromDirectory(first)
  await new MarkdownBackupService(target, second).exportAll()
  await new MarkdownRestoreService(source).restoreFromDirectory(second)
  await service.restoreFromDirectory(first)
  const expected = [['owner.中文:一', 0, null], ['child.中文:二', 1, 'owner.中文:一'], [longId, 1, 'owner.中文:一']]
  for (const store of [source, target]) assert.deepEqual(store.getDocumentDetail(id)!.blocks.map(block => [block.id, block.depth, block.parentBlockId]), expected)
}))

test('V2 refuses invalid authored ordinary block identities before trimming or dropping them', () => stores(async (source, target, root) => {
  const id = source.createDocument(null)
  source.updateDocument(id, { title: 'Metadata identities', summary: '', blocks: [
    { id: 'valid-owner', type: 'bulleted-list', content: 'Owner', checked: false, depth: 0 },
    { id: 'valid-child', type: 'bulleted-list', content: 'Child', checked: false, depth: 1, parentBlockId: 'valid-owner' }
  ] })
  const backup = join(root, 'invalid-identities')
  await new MarkdownBackupService(source, backup).exportAll()
  const document = join(backup, 'Metadata identities.md'), original = readFileSync(document, 'utf8')
  const before = target.getExportWorkspaceSnapshot(), service = new MarkdownRestoreService(target)
  for (const [property, originalValue, invalid] of [
    ['id', 'valid-owner', ' valid-owner'], ['id', 'valid-owner', ''], ['id', 'valid-owner', 42],
    ['parentBlockId', 'valid-owner', 'valid-owner '], ['parentBlockId', 'valid-owner', ''], ['parentBlockId', 'valid-owner', 42]
  ] as const) {
    const damaged = original.replace(`${JSON.stringify(property)}:${JSON.stringify(originalValue)}`, `${JSON.stringify(property)}:${JSON.stringify(invalid)}`)
    assert.notEqual(damaged, original)
    writeFileSync(document, damaged)
    await assert.rejects(service.previewFromDirectory(backup), /block identity/)
    await assert.rejects(service.restoreFromDirectory(backup), /block identity/)
    assert.deepEqual(target.getExportWorkspaceSnapshot(), before)
  }
  for (const invalid of [' bad', '', 42]) {
    const snapshot = source.getExportWorkspaceSnapshot()
    ;(snapshot.documents[0].blocks[0] as unknown as Record<string, unknown>).id = invalid
    assert.throws(() => writeBackupSnapshot({ ...snapshot, backupRoot: join(root, 'bad-snapshot') }), /block identity/)
    assert.equal(existsSync(join(root, 'bad-snapshot')), false)
  }
}))
