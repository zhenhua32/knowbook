import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import { CURRENT_DATABASE_SCHEMA_VERSION } from '../src/main/database/schema-version.ts'
import { MarkdownBackupService } from '../src/main/backup/exporter.ts'
import { MarkdownRestoreService } from '../src/main/backup/importer.ts'
import { markdownEngine } from '../src/shared/markdownEngine.ts'
import { serializeBlocksToMarkdown } from '../src/shared/markdown.ts'
import { parsePastedMarkdown } from '../src/renderer/src/utils/markdownInput.ts'
import { normalizeDraftBlocks } from '../src/renderer/src/utils/draftTreeNormalization.ts'
import { buildDraftMarkdownExport } from '../src/renderer/src/utils/documentMarkdown.ts'
import { canonicalMarkdownHtml, loadMarkdownSpec, markdownSpecNames } from './helpers/markdownSpec.ts'

const semantic = (markdown: string) => canonicalMarkdownHtml(markdownEngine.render(markdown))

test('all official examples retain meaning through editor normalization and SQLite persistence', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-spec-store-'))
  const store = new KnowbookStore(join(root, 'store.sqlite'))
  try {
    const doc = store.getAllDocumentSnapshots()[0]
    for (const spec of markdownSpecNames) for (const example of loadMarkdownSpec(spec)) {
      const draft = normalizeDraftBlocks(parsePastedMarkdown(example.markdown))
      store.updateDocument(doc.id, { title: doc.title, summary: '', blocks: draft })
      const stored = store.getDocumentDetail(doc.id)!.blocks
      assert.equal(semantic(serializeBlocksToMarkdown(stored)), semantic(example.markdown), `${spec} #${example.example}`)
    }
    store.updateDocument(doc.id, { title: doc.title, summary: '', blocks: [] })
    assert.equal(serializeBlocksToMarkdown(store.getDocumentDetail(doc.id)!.blocks), '')
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('file import, reopen, portable export and backup restore preserve difficult syntax and deeply nested tasks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-spec-files-'))
  const input = join(root, 'input')
  const output = join(root, 'output')
  mkdirSync(input); mkdirSync(output)
  const fixtures = loadMarkdownSpec('commonmark-0.31.2').filter((e) => [6, 7, 9, 81, 93, 126, 130, 273, 276, 278, 301, 302, 307, 312, 326].includes(e.example))
    .map((e) => ({ title: `Example ${e.example}`, markdown: e.markdown }))
  fixtures.push({ title: 'Tasks', markdown: '- [x] A\n  - [x] B\n    - [x] C\n      - [x] D\n        - [x] E\n          - [x] F\n            - [x] G' })
  fixtures.push({ title: 'Info', markdown: '```JS title="A&B"\nconsole.log(1)\n```\n\n~~~\n\n~~~' })
  for (const f of fixtures) writeFileSync(join(input, `${f.title}.md`), f.markdown)
  let store = new KnowbookStore(join(root, 'store.sqlite'))
  const target = new KnowbookStore(join(root, 'target.sqlite'))
  try {
    await new MarkdownRestoreService(store).restoreFromDirectory(input)
    const before = fixtures.map((f) => {
      const doc = store.getAllDocumentSnapshots().find((d) => d.path === f.title)!
      const detail = store.getDocumentDetail(doc.id)!
      assert.equal(semantic(serializeBlocksToMarkdown(detail.blocks)), semantic(f.markdown), f.title)
      writeFileSync(join(output, `${f.title}.md`), buildDraftMarkdownExport(detail).markdown)
      return detail
    })
    store.destroy()
    store = new KnowbookStore(join(root, 'store.sqlite'))
    for (const doc of before) assert.deepEqual(store.getDocumentDetail(doc.id)!.blocks, doc.blocks)
    await new MarkdownRestoreService(target).restoreFromDirectory(output)
    for (const f of fixtures) {
      const doc = target.getAllDocumentSnapshots().find((d) => d.path === f.title)!
      assert.equal(semantic(serializeBlocksToMarkdown(target.getDocumentDetail(doc.id)!.blocks)), semantic(f.markdown), `${f.title} portable export`)
    }
    const backup = join(root, 'backup')
    await new MarkdownBackupService(store, backup).exportAll()
    await new MarkdownRestoreService(target).restoreFromDirectory(backup)
    for (const doc of before) {
      const restored = target.getAllDocumentSnapshots().find((d) => d.path === doc.path)!
      assert.deepEqual(target.getDocumentDetail(restored.id)!.blocks, doc.blocks, `${doc.title} backup`)
    }
  } finally { store.destroy(); target.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('schema 14 adds format storage without rewriting existing notes and creates a migration copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-format-migration-'))
  const path = join(root, 'v13.sqlite')
  let store = new KnowbookStore(path)
  try {
    const doc = store.getAllDocumentSnapshots()[0]
    const before = store.getDocumentDetail(doc.id)!.blocks
    store.getUnsafeDatabaseHandle().exec('ALTER TABLE blocks DROP COLUMN markdown_format_json')
    store.getUnsafeDatabaseHandle().pragma('user_version = 13')
    store.destroy()
    store = new KnowbookStore(path)
    assert.deepEqual(store.getDocumentDetail(doc.id)!.blocks, before)
    assert.equal(store.getUnsafeDatabaseHandle().pragma('user_version', { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION)
    assert.ok(readdirSync(root).some((name) => name.includes(`pre-migration-v13-to-v${CURRENT_DATABASE_SCHEMA_VERSION}-`)))
    store.updateDocument(doc.id, { title: doc.title, summary: '', blocks: parsePastedMarkdown('* a\n* b') })
    assert.equal(store.getDocumentDetail(doc.id)!.blocks[0].markdownFormat?.listLoose, false)
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})
