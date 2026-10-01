import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import type { DocumentBlockDraft, WorkspaceSearchInput, SaveWorkspaceSearchInput } from '../src/shared/contracts.ts'

function withStore(run: (store: KnowbookStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-workspace-search-'))
  const store = new KnowbookStore(join(root, 'store.db'))
  try { run(store) } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
}

function create(store: KnowbookStore, title: string, content: string, parent: string | null = null,
  options: { summary?: string; blocks?: DocumentBlockDraft[] } = {}): string {
  const id = store.createDocument(parent)
  store.updateDocument(id, {
    title, summary: options.summary ?? '',
    blocks: options.blocks ?? [{ type: 'paragraph', content, checked: false, depth: 0 }]
  })
  return id
}

function ids(store: KnowbookStore, input: WorkspaceSearchInput): string[] {
  return store.searchWorkspace({ pageSize: 100, ...input }).items.map((item) => item.documentId)
}

test('workspace search counts and pages every metadata and block match beyond the legacy limits', () => {
  withStore((store) => {
    const expected = Array.from({ length: 47 }, (_, index) => create(store, `PagingNeedle ${index}`, `PagingNeedle body ${index}`))
    for (const scope of ['documents', 'blocks'] as const) {
      const collected: string[] = []
      for (let page = 1; page <= 5; page++) {
        const result = store.searchWorkspace({ query: 'PagingNeedle', scope, page, pageSize: 10 })
        assert.equal(result.total, 47)
        assert.equal(result.page, page)
        assert.equal(result.pageSize, 10)
        assert.equal(result.items.length, page === 5 ? 7 : 10)
        collected.push(...result.items.map((item) => item.documentId))
      }
      assert.equal(new Set(collected).size, 47)
      assert.deepEqual(collected.slice().sort(), expected.slice().sort())
    }
    assert.equal(store.searchWorkspace({ query: 'PagingNeedle' }).total, 94)
    const pastEnd = store.searchWorkspace({ query: 'PagingNeedle', scope: 'documents', page: 6, pageSize: 10 })
    assert.equal(pastEnd.page, 5)
    assert.equal(pastEnd.items.length, 7)
    assert.equal(store.searchWorkspace({ query: 'PagingNeedle', pageSize: 1000 }).pageSize, 100)
    assert.equal(store.searchWorkspace({ query: 'PagingNeedle', page: 0 }).page, 1)
    for (const id of expected.slice(0, 7)) store.deleteDocument(id)
    const afterDelete = store.searchWorkspace({ query: 'PagingNeedle', scope: 'documents', page: 5, pageSize: 10 })
    assert.equal(afterDelete.total, 40)
    assert.equal(afterDelete.page, 4)
    assert.equal(afterDelete.items.length, 10)
    assert.equal(store.searchWorkspace({ query: 'NonexistentNeedle', page: 8 }).page, 1)
  })
})

test('workspace matching supports all, any and literal phrase across indexed and short terms', () => {
  withStore((store) => {
    const separated = create(store, 'Quasar metadata', 'quasar intervening nebula 数', null, { summary: 'Nebula summary 数' })
    const phrase = create(store, 'Unrelated title', 'QUASAR nebula 数据库 🌟🌟')
    const shortOnly = create(store, 'Another 数 title', '数 in unrelated material')
    assert.deepEqual(ids(store, { query: 'quasar nebula', scope: 'documents' }), [separated])
    assert.deepEqual(ids(store, { query: 'quasar nebula', scope: 'blocks' }).sort(), [separated, phrase].sort())
    assert.deepEqual(ids(store, { query: 'quasar nebula', scope: 'blocks', matchMode: 'phrase' }), [phrase])
    assert.deepEqual(ids(store, { query: 'quasar 数', scope: 'blocks' }).sort(), [separated, phrase].sort())
    assert.deepEqual(ids(store, { query: 'quasar 数', scope: 'blocks', matchMode: 'any' }).sort(), [separated, phrase, shortOnly].sort())
    assert.deepEqual(ids(store, { query: 'quasar 数', scope: 'documents' }), [separated])
    assert.deepEqual(ids(store, { query: 'quasar 数', scope: 'documents', matchMode: 'any' }).sort(), [separated, shortOnly].sort())
    assert.deepEqual(ids(store, { query: '据', scope: 'blocks' }), [phrase])
    assert.deepEqual(ids(store, { query: '🌟🌟', scope: 'blocks' }), [phrase])
    assert.deepEqual(store.searchWorkspace({ query: ' Quasar quasar  nebula ' }).queryTerms.map((term) => term.toLowerCase()), ['quasar', 'nebula'])
    assert.deepEqual(store.searchWorkspace({ query: 'quasar nebula', matchMode: 'phrase' }).queryTerms, ['quasar nebula'])
  })
})

test('FTS operators, quotes and LIKE wildcard characters remain literal input', () => {
  withStore((store) => {
    const folder = create(store, 'LiteralFixtureRoot', 'Fixture')
    const literal = create(store, 'Literal search', '100% wildcards_here path\\to literal %_\\ "quoted" NEAR(foo) OR * *** 🌟🌟🌟 """', folder)
    create(store, 'Noise', '1000 wildcardsXhere path/to quoted unquoted', folder)
    for (const query of ['100%', 'wildcards_here', 'path\\to', '%_\\', '"quoted"', 'NEAR(foo)', '%', '_', '\\', '*', 'OR', '***', '🌟🌟🌟', '"""']) {
      assert.deepEqual(ids(store, { query, scope: 'blocks', folderId: folder, matchMode: 'phrase' }), [literal], query)
    }
    assert.deepEqual(ids(store, { query: 'wildcardsXhere', scope: 'blocks' }).length, 1)
    assert.equal(store.searchWorkspace({ query: 'missing" OR *', matchMode: 'phrase' }).total, 0)
  })
})

test('directory, exact tag, type and local inclusive dates combine without crossing unrelated blocks', () => {
  withStore((store) => {
    const folder = create(store, 'FilterFolder', 'Folder marker')
    const child = create(store, 'FilterNeedle child', '', folder, {
      blocks: [
        { type: 'paragraph', content: 'FilterNeedle paragraph', tags: ['research'], checked: false, depth: 0 },
        { type: 'task', content: 'FilterNeedle task', tags: ['research-long'], checked: false, depth: 0 }
      ]
    })
    const grandchild = create(store, 'FilterNeedle descendant', '', child, {
      blocks: [{ type: 'task', content: 'FilterNeedle task descendant', tags: ['research'], checked: false, depth: 0 }]
    })
    const outside = create(store, 'FilterNeedle outside', 'FilterNeedle unrelated')
    const day = '2026-05-15'
    const start = new Date(`${day}T00:00:00`)
    const end = new Date(`${day}T23:59:59.999`)
    const setTime = store.getUnsafeDatabaseHandle().prepare('UPDATE documents SET updated_at = ? WHERE id = ?')
    setTime.run(start.toISOString(), child)
    setTime.run(end.toISOString(), grandchild)
    setTime.run(new Date('2026-05-16T00:00:00').toISOString(), outside)
    assert.deepEqual(ids(store, { query: 'FilterNeedle', scope: 'documents', folderId: folder }).sort(), [child, grandchild].sort())
    assert.deepEqual(ids(store, { query: 'Folder marker', scope: 'blocks', folderId: folder }), [folder], 'folder itself is included')
    assert.deepEqual(ids(store, { query: 'FilterNeedle', scope: 'documents', folderId: folder, tag: 'research', blockType: 'task' }), [grandchild])
    assert.deepEqual(ids(store, { query: '', scope: 'blocks', folderId: folder, tag: 'research', blockType: 'task' }), [grandchild])
    assert.deepEqual(ids(store, { query: 'FilterNeedle', scope: 'documents', updatedFrom: day, updatedTo: day }).sort(), [child, grandchild].sort())
    assert.deepEqual(ids(store, { query: '', scope: 'documents', folderId: 'nonexistent-folder' }), [])
    const all = store.searchWorkspace({ query: 'FilterNeedle', folderId: folder, tag: 'research', blockType: 'task' })
    assert.equal(all.total, 2)
    assert.equal(all.items[0]?.matchType, 'block', 'block filters prioritize matching blocks')
    assert.deepEqual(all.items.map((item) => item.tags), [['research'], ['research']])
    assert.equal(all.items[0]?.updatedAt, end.toISOString())
  })
})

test('relevance and update sorting are stable, including ties and all pages', () => {
  withStore((store) => {
    const exact = create(store, 'RankingNeedle', 'no match')
    const prefix = create(store, 'RankingNeedle suffix', 'no match')
    const other = create(store, 'Other RankingNeedle title', 'no match')
    const setTime = store.getUnsafeDatabaseHandle().prepare('UPDATE documents SET updated_at = ? WHERE id = ?')
    setTime.run('2026-01-01T01:00:00.000Z', exact)
    setTime.run('2026-01-03T01:00:00.000Z', prefix)
    setTime.run('2026-01-02T01:00:00.000Z', other)
    const input = { query: 'RankingNeedle', scope: 'documents' as const }
    assert.deepEqual(ids(store, input), [exact, prefix, other])
    assert.deepEqual(ids(store, { ...input, sort: 'updated-asc' }), [exact, other, prefix])
    assert.deepEqual(ids(store, { ...input, sort: 'updated-desc' }), [prefix, other, exact])
    for (const id of [exact, prefix, other]) setTime.run('2026-01-01T01:00:00.000Z', id)
    const expected = ids(store, { ...input, sort: 'updated-desc' })
    const paged = [1, 2, 3].flatMap((page) => ids(store, { ...input, sort: 'updated-desc', page, pageSize: 1 }))
    assert.deepEqual(paged, expected)
    assert.deepEqual(ids(store, { ...input, sort: 'updated-desc' }), expected)
  })
})

test('search, tags and type facets reflect edits, moves and trash immediately', () => {
  withStore((store) => {
    const folder = create(store, 'ChangedFolder', 'Folder')
    const id = create(store, 'BeforeNeedle title', 'BeforeNeedle block')
    const detail = store.getDocumentDetail(id)!
    store.updateDocument(id, {
      title: 'AfterNeedle title', summary: '',
      blocks: detail.blocks.map((block) => ({ ...block, type: 'code', content: 'AfterNeedle block', tags: ['fresh-facet'] }))
    })
    assert.equal(store.searchWorkspace({ query: 'BeforeNeedle' }).total, 0)
    assert.equal(store.searchWorkspace({ query: 'AfterNeedle' }).total, 2)
    assert.ok(store.getSearchFacets().tags.includes('fresh-facet'))
    assert.ok(store.getSearchFacets().blockTypes.includes('code'))
    store.moveDocument(id, folder)
    assert.equal(store.searchWorkspace({ query: 'AfterNeedle', folderId: folder }).total, 2)
    store.updateDocumentBlockTags(id, [{ blockId: detail.blocks[0]!.id, tags: ['replacement-facet'] }])
    assert.equal(store.getSearchFacets().tags.includes('fresh-facet'), false)
    assert.deepEqual(ids(store, { query: 'AfterNeedle', scope: 'blocks', tag: 'replacement-facet' }), [id])
    store.deleteDocument(id)
    assert.equal(store.searchWorkspace({ query: 'AfterNeedle' }).total, 0)
    assert.equal(store.getSearchFacets().tags.includes('replacement-facet'), false)
  })
})

test('saved searches persist, update, delete and reopen on the first page', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-saved-search-'))
  const path = join(root, 'store.db')
  let store = new KnowbookStore(path)
  try {
    const saved = store.saveSearch({ name: '  Research  ', input: { query: '  alpha beta  ', tag: 'research', page: 9, pageSize: 200 } })
    assert.equal(saved.name, 'Research')
    assert.equal(saved.input.query, 'alpha beta')
    assert.equal(saved.input.page, 1)
    assert.equal(saved.input.pageSize, 100)
    store.destroy()
    store = new KnowbookStore(path)
    assert.deepEqual(store.listSavedSearches(), [saved])
    const updated = store.saveSearch({ id: saved.id, name: 'Renamed', input: { query: '', folderId: 'folder', sort: 'updated-asc' } })
    assert.equal(updated.id, saved.id)
    assert.deepEqual(store.listSavedSearches(), [updated])
    store.deleteSavedSearch(saved.id)
    assert.deepEqual(store.listSavedSearches(), [])
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('main-process validation rejects malformed search and saved-search payloads', () => {
  withStore((store) => {
    for (const value of [null, [], { query: 1 }, { query: 'a'.repeat(2001) }, { query: 'quasar\0missing' }, { query: '', scope: 'bogus' },
      { query: '', sort: 'bogus' }, { query: '', matchMode: 'bogus' }, { query: '', tag: {} },
      { query: '', page: Infinity }, { query: '', pageSize: 1.5 }, { query: '', updatedFrom: '2026-02-30' },
      { query: '', updatedFrom: '2026-05-16', updatedTo: '2026-05-15' },
      { query: Array.from({ length: 33 }, (_, index) => `word${index}`).join(' ') }]) {
      assert.throws(() => store.searchWorkspace(value as WorkspaceSearchInput))
    }
    for (const value of [null, [], { name: '', input: { query: '' } }, { name: 'a'.repeat(81), input: { query: '' } },
      { name: 'Valid', input: null }, { id: 'missing', name: 'Name', input: { query: '' } }]) {
      assert.throws(() => store.saveSearch(value as SaveWorkspaceSearchInput))
    }
    const valid = store.saveSearch({ name: 'Valid', input: { query: 'something' } })
    store.saveSetting('search.saved.v1', JSON.stringify([null, { id: 'bad', name: 'Bad', input: { query: 1 } }, valid, valid]))
    assert.deepEqual(store.listSavedSearches(), [valid])
    store.saveSetting('search.saved.v1', 'not json')
    assert.deepEqual(store.listSavedSearches(), [])
    for (let index = 0; index < 100; index++) store.saveSearch({ name: `Saved ${index}`, input: { query: '' } })
    assert.throws(() => store.saveSearch({ name: 'Overflow', input: { query: '' } }), /100/)
    assert.equal(store.listSavedSearches().length, 100)
    assert.throws(() => store.deleteSavedSearch(''))
  })
})
