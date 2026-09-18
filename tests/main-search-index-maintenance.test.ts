import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import { CURRENT_DATABASE_SCHEMA_VERSION } from '../src/main/database/schema-version.ts'

function create(store: KnowbookStore, title: string, content: string, parent: string | null = null) {
  const id = store.createDocument(parent)
  store.updateDocument(id, { title, summary: '', blocks: [{ type: 'paragraph', content, checked: false, depth: 0 }] })
  return id
}

function assertSearchConsistent(store: KnowbookStore) {
  const db = store.getUnsafeDatabaseHandle()
  for (const [table, index, lookup, key] of [['documents', 'document_search', 'document_search_ids', 'document_id'],
    ['blocks', 'block_search', 'block_search_ids', 'block_id']]) {
    const count = db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }
    assert.deepEqual(db.prepare(`SELECT count(*) AS count FROM ${index}`).get(), count)
    assert.deepEqual(db.prepare(`SELECT count(*) AS count FROM ${lookup}`).get(), count)
    assert.deepEqual(db.prepare(`SELECT count(*) AS count FROM ${table} AS original
      JOIN ${lookup} AS ids ON ids.${key} = original.id
      JOIN ${index} AS search ON search.rowid = ids.search_rowid AND search.${key} = original.id`).get(), count)
    db.prepare(`INSERT INTO ${index}(${index}) VALUES ('integrity-check')`).run()
  }
}

test('indexed search updates survive deletion, row reuse, vacuum, rollback and document moves', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-search-index-')), store = new KnowbookStore(join(root, 'store.db'))
  try {
    const removed = create(store, 'Disposable', 'Obsolete search content')
    const id = create(store, 'Original name', 'Original needle')
    store.deleteDocument(removed)
    create(store, 'Replacement', 'Replacement text')
    store.getUnsafeDatabaseHandle().exec('VACUUM')
    const original = store.getDocumentDetail(id)!
    store.updateDocument(id, { ...original, title: 'Revised name', blocks: original.blocks.map((block) => ({ ...block, content: 'Revised needle' })) })
    assert.deepEqual(store.searchDocuments('Original'), [])
    assert.ok(store.searchDocuments('Revised needle').some((result) => result.documentId === id))
    assert.throws(() => store.runInTransaction(() => {
      store.updateDocument(id, { ...original, title: 'Aborted name', blocks: original.blocks.map((block) => ({ ...block, content: 'Aborted needle' })) })
      throw new Error('abort')
    }), /abort/)
    assert.deepEqual(store.searchDocuments('Aborted'), [])
    assert.ok(store.searchDocuments('Revised needle').some((result) => result.documentId === id))
    const folder = create(store, 'Destination', 'Folder')
    store.moveDocument(id, folder)
    assert.ok(store.searchDocuments('Destination/Revised').some((result) => result.documentId === id))
    assertSearchConsistent(store)
    store.deleteDocument(id)
    assert.deepEqual(store.searchDocuments('Revised'), [])
    assertSearchConsistent(store)
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('version 16 search triggers and displaced FTS rows migrate with a safety copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-search-migration-')), path = join(root, 'store.db')
  let store = new KnowbookStore(path)
  try {
    const id = create(store, 'Migration title', 'Migration original')
    const db = store.getUnsafeDatabaseHandle()
    for (const table of ['document', 'block']) for (const operation of ['insert', 'update', 'delete']) {
      db.exec(`DROP TRIGGER trg_${table}_search_${operation}`)
    }
    db.exec(`DROP TABLE document_search_ids; DROP TABLE block_search_ids;
      UPDATE document_search SET rowid = rowid + 10000;
      UPDATE block_search SET rowid = rowid + 10000;
      CREATE TRIGGER trg_block_search_update AFTER UPDATE OF document_id, content ON blocks BEGIN
        DELETE FROM block_search WHERE block_id = old.id;
        INSERT INTO block_search(block_id, document_id, content) VALUES (new.id, new.document_id, new.content);
      END;
      PRAGMA user_version = 16;`)
    store.destroy(); store = new KnowbookStore(path)
    assert.ok(readdirSync(root).some((name) => name.includes(`pre-migration-v16-to-v${CURRENT_DATABASE_SCHEMA_VERSION}-`)))
    assertSearchConsistent(store)
    const original = store.getDocumentDetail(id)!
    store.updateDocument(id, { ...original, title: 'Updated title', blocks: original.blocks.map((block) => ({ ...block, content: 'Updated needle' })) })
    assert.deepEqual(store.searchDocuments('Migration'), [])
    assert.ok(store.searchDocuments('Updated needle').some((result) => result.documentId === id))
    store.destroy(); store = new KnowbookStore(path)
    assertSearchConsistent(store)
    store.deleteDocument(id)
    assert.deepEqual(store.searchDocuments('Updated'), [])
    assertSearchConsistent(store)
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})
