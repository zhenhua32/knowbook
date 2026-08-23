import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'

function withStore(run: (store: KnowbookStore) => void): void {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-search-parity-'))
  const store = new KnowbookStore(join(tempRoot, 'knowbook.sqlite'))

  try {
    run(store)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function createNote(store: KnowbookStore, parentPath: string, title: string, content: string): string {
  const catalog = store.getHomeData('').documentCatalog
  const parent = catalog.find((entry) => entry.path === parentPath)
  assert.ok(parent, `missing parent document at ${parentPath}`)

  const documentId = store.createDocument(parent.id)
  store.updateDocument(documentId, {
    title,
    summary: '',
    blocks: [{ type: 'paragraph', content, checked: false, depth: 0 }]
  })
  return documentId
}

test('search results stay identical across wildcard, quote, CJK, and short-query edge cases', () => {
  withStore((store) => {
    const quotedId = createNote(store, 'Home', 'The "Quoted" Title', 'content with "double quotes" inside')
    const percentId = createNote(store, 'Home', 'Progress 100%', 'literal % and wildcards_here tokens')
    const cjkId = createNote(store, 'Home', '数据库索引笔记', '中文内容包含三字词组匹配')
    const plainId = createNote(store, 'Home', 'Plain Database Note', 'ordinary corpus text about indexes')

    // Long query (indexed path).
    assert.equal(store.searchDocuments('Quoted').some((r) => r.documentId === quotedId), true)
    assert.equal(store.searchDocuments('"Quoted"').some((r) => r.documentId === quotedId), true)
    assert.equal(store.searchDocuments('100%').some((r) => r.documentId === percentId), true)
    assert.equal(store.searchDocuments('100%').some((r) => r.documentId === quotedId), false)
    assert.equal(store.searchDocuments('wildcards_here').some((r) => r.documentId === percentId), true)
    assert.equal(store.searchDocuments('wildcardsXhere').length, 0, 'underscore stays literal on the indexed path')
    assert.equal(store.searchDocuments('数据库索引').some((r) => r.documentId === cjkId), true)

    // Case-insensitivity matches previous LIKE semantics.
    assert.equal(store.searchDocuments('the "quoted" title').some((r) => r.documentId === quotedId), true)

    // Short query (fallback path).
    assert.equal(store.searchDocuments('Pl').some((r) => r.documentId === plainId), true)

    // Suggestions behave identically on both paths.
    assert.equal(store.getDocumentSuggestions('Progress 100%').some((s) => s.id === percentId), true)
    assert.equal(store.getDocumentSuggestions('数据库').some((s) => s.id === cjkId), true)
    assert.equal(store.getDocumentSuggestions('Pl').some((s) => s.id === plainId), true)

    // Semantic candidates on both paths.
    assert.equal(
      store.getSemanticSearchCandidates({ query: '"double quotes"' }).some((c) => c.documentId === quotedId),
      true
    )
    assert.equal(
      store.getSemanticSearchCandidates({ query: '中文内容' }).some((c) => c.documentId === cjkId),
      true
    )
    assert.equal(
      store.getSemanticSearchCandidates({ query: 'or', excludeDocumentId: plainId }).every((c) => c.documentId !== plainId),
      true
    )
  })
})

test('document suggestion ranking order is preserved', () => {
  withStore((store) => {
    createNote(store, 'Home', 'Alpha Report', 'x')
    createNote(store, 'Home/Product', 'Alpha Report', 'y')

    const suggestions = store.getDocumentSuggestions('Alpha Report')
    assert.ok(suggestions.length >= 2)
    assert.deepEqual(suggestions.map((suggestion) => suggestion.path).slice().sort(), [
      'Home/Alpha Report',
      'Home/Product/Alpha Report'
    ])
    assert.equal(suggestions[0]?.title, 'Alpha Report')
  })
})
