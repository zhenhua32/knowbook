import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import { MarkdownBackupService } from '../src/main/backup/exporter.ts'
import { MarkdownRestoreService } from '../src/main/backup/importer.ts'
import { parsePastedMarkdown } from '../src/renderer/src/utils/markdownInput.ts'
import { serializeBlocksToMarkdown } from '../src/shared/markdown.ts'

test('paste, SQLite, backup and restore preserve headings, list starts, identities and content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-markdown-roundtrip-'))
  const path = join(root, 'source.sqlite')
  let source = new KnowbookStore(path)
  const target = new KnowbookStore(join(root, 'target.sqlite'))
  try {
    const doc = source.getAllDocumentSnapshots()[0]
    const content = '###### Deep\n\n7. First\n   - Nested\n8. Second\n\n> Outer\n> > Inner\n\n~~~js\nconst a = `value`\n~~~\n\n[Link][ref]\n\n[ref]: https://example.com'
    source.updateDocument(doc.id, { title: doc.title, summary: '', blocks: parsePastedMarkdown(content) })
    const first = source.getDocumentDetail(doc.id)!.blocks
    assert.equal(first[0].type, 'heading-6')
    assert.equal(first[1].listStart, 7)
    assert.equal(first[2].parentBlockId, first[1].id)
    source.destroy()
    source = new KnowbookStore(path)
    assert.deepEqual(source.getDocumentDetail(doc.id)!.blocks, first)
    await new MarkdownBackupService(source, join(root, 'backup')).exportAll()
    await new MarkdownRestoreService(target).restoreFromDirectory(join(root, 'backup'))
    const restoredDoc = target.getAllDocumentSnapshots().find((entry) => entry.path === doc.path)!
    const restored = target.getDocumentDetail(restoredDoc.id)!.blocks
    assert.deepEqual(restored, first)
    assert.equal(serializeBlocksToMarkdown(restored), serializeBlocksToMarkdown(first))
    const updated = first.map((block, index) => index === 1 ? { ...block, listStart: 12 } : block)
    source.updateDocument(doc.id, { title: doc.title, summary: '', blocks: updated })
    assert.equal(source.getDocumentDetail(doc.id)!.blocks[1].listStart, 12)
  } finally {
    source.destroy()
    target.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

test('schema 13 migrates existing notes and keeps a migration safety copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-markdown-migrate-'))
  const path = join(root, 'old.sqlite')
  let store = new KnowbookStore(path)
  try {
    const doc = store.getAllDocumentSnapshots()[0]
    const before = store.getDocumentDetail(doc.id)!.blocks
    const db = store.getUnsafeDatabaseHandle()
    db.exec('ALTER TABLE blocks DROP COLUMN list_start')
    db.pragma('user_version = 12')
    store.destroy()
    store = new KnowbookStore(path)
    assert.deepEqual(store.getDocumentDetail(doc.id)!.blocks, before)
    assert.equal(store.getUnsafeDatabaseHandle().pragma('user_version', { simple: true }), 13)
    assert.ok(readdirSync(root).some((name) => name.includes('pre-migration-v12-to-v13-')))
  } finally {
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})
