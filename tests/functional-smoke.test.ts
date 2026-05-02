import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBoardColumns, getBoardDropFieldValue, isBoardGroupableColumn } from '../src/shared/board.ts'
import { detectCodeLanguage, normalizeCodeLanguage } from '../src/shared/code.ts'
import type { DocumentCatalogEntry, DocumentDatabaseColumn } from '../src/shared/contracts.ts'
import { serializeBlocksToMarkdown } from '../src/shared/markdown.ts'

function createDocument(overrides: Partial<DocumentCatalogEntry> = {}): DocumentCatalogEntry {
  return {
    id: overrides.id ?? 'doc-id',
    title: overrides.title ?? 'Untitled',
    path: overrides.path ?? 'Untitled',
    summary: overrides.summary ?? '',
    parentId: overrides.parentId ?? null,
    parentTitle: overrides.parentTitle ?? null,
    updatedAt: overrides.updatedAt ?? '2026-05-01T00:00:00.000Z',
    blockCount: overrides.blockCount ?? 0,
    linkCount: overrides.linkCount ?? 0,
    childCount: overrides.childCount ?? 0,
    fieldValues: overrides.fieldValues ?? {}
  }
}

function createColumn(overrides: Partial<DocumentDatabaseColumn> = {}): DocumentDatabaseColumn {
  return {
    id: overrides.id ?? 'column-id',
    name: overrides.name ?? 'Status',
    type: overrides.type ?? 'select',
    options: overrides.options ?? [],
    sortOrder: overrides.sortOrder ?? 0
  }
}

test('serializeBlocksToMarkdown prefers parentBlockId over inconsistent raw depth', () => {
  const markdown = serializeBlocksToMarkdown([
    { id: 'root', type: 'bulleted-list', content: 'Parent', depth: 0 },
    { id: 'child', type: 'bulleted-list', content: 'Child', depth: 0, parentBlockId: 'root' },
    { id: 'note', type: 'paragraph', content: 'Loose paragraph', depth: 4 }
  ])

  assert.equal(markdown, '- Parent\n\n  - Child\n\nLoose paragraph')
})

test('isBoardGroupableColumn only allows parent-compatible field types', () => {
  assert.equal(isBoardGroupableColumn(createColumn({ type: 'select' })), true)
  assert.equal(isBoardGroupableColumn(createColumn({ type: 'multi-select' })), true)
  assert.equal(isBoardGroupableColumn(createColumn({ type: 'checkbox' })), true)
  assert.equal(isBoardGroupableColumn(createColumn({ type: 'date' })), true)
  assert.equal(isBoardGroupableColumn(createColumn({ type: 'text' })), true)
})

test('buildBoardColumns groups by parent bucket and keeps root first', () => {
  const columns = buildBoardColumns([
    createDocument({ id: 'child-a', title: 'Child A', path: 'Root/Child A', parentId: 'parent', parentTitle: 'Root' }),
    createDocument({ id: 'root-b', title: 'Root B', path: 'Root B' }),
    createDocument({ id: 'child-b', title: 'Child B', path: 'Root/Child B', parentId: 'parent', parentTitle: 'Root' })
  ], null)

  assert.equal(columns[0]?.title, 'Root')
  assert.deepEqual(columns[0]?.items.map((item) => item.id), ['root-b'])
  assert.equal(columns[1]?.title, 'Root')
  assert.deepEqual(columns[1]?.items.map((item) => item.id), ['child-a', 'child-b'])
})

test('buildBoardColumns groups select fields and sends missing values to empty column', () => {
  const statusColumn = createColumn({
    id: 'status',
    name: 'Status',
    type: 'select',
    options: ['Todo', 'Doing', 'Done']
  })

  const columns = buildBoardColumns([
    createDocument({ id: 'doc-1', path: 'A', fieldValues: { status: 'Doing' } }),
    createDocument({ id: 'doc-2', path: 'B', fieldValues: { status: 'Done' } }),
    createDocument({ id: 'doc-3', path: 'C', fieldValues: {} }),
    createDocument({ id: 'doc-4', path: 'D', fieldValues: { status: 'Invalid' } })
  ], statusColumn)

  assert.deepEqual(columns.map((column) => column.title), ['No Status', 'Todo', 'Doing', 'Done'])
  assert.deepEqual(columns[0]?.items.map((item) => item.id), ['doc-3', 'doc-4'])
  assert.deepEqual(columns[2]?.items.map((item) => item.id), ['doc-1'])
  assert.deepEqual(columns[3]?.items.map((item) => item.id), ['doc-2'])
})

test('buildBoardColumns groups multi-select fields across multiple columns', () => {
  const tagsColumn = createColumn({
    id: 'tags',
    name: 'Tags',
    type: 'multi-select',
    options: ['AI', 'UX', 'Infra']
  })

  const columns = buildBoardColumns([
    createDocument({ id: 'doc-1', path: 'A', fieldValues: { tags: ['AI', 'UX'] } }),
    createDocument({ id: 'doc-2', path: 'B', fieldValues: { tags: ['Infra', 'Unknown'] } }),
    createDocument({ id: 'doc-3', path: 'C', fieldValues: {} })
  ], tagsColumn)

  assert.deepEqual(columns.map((column) => column.title), ['No Tags', 'AI', 'UX', 'Infra'])
  assert.deepEqual(columns[0]?.items.map((item) => item.id), ['doc-3'])
  assert.deepEqual(columns[1]?.items.map((item) => item.id), ['doc-1'])
  assert.deepEqual(columns[2]?.items.map((item) => item.id), ['doc-1'])
  assert.deepEqual(columns[3]?.items.map((item) => item.id), ['doc-2'])
})

test('buildBoardColumns groups checkbox fields into yes and no buckets', () => {
  const doneColumn = createColumn({
    id: 'done',
    name: 'Done',
    type: 'checkbox'
  })

  const columns = buildBoardColumns([
    createDocument({ id: 'doc-1', path: 'A', fieldValues: { done: true } }),
    createDocument({ id: 'doc-2', path: 'B', fieldValues: { done: false } }),
    createDocument({ id: 'doc-3', path: 'C', fieldValues: {} })
  ], doneColumn)

  assert.deepEqual(columns.map((column) => column.title), ['No', 'Yes'])
  assert.deepEqual(columns[0]?.items.map((item) => item.id), ['doc-2', 'doc-3'])
  assert.deepEqual(columns[1]?.items.map((item) => item.id), ['doc-1'])
})

test('getBoardDropFieldValue respects select, multi-select, and checkbox semantics', () => {
  const selectColumn = createColumn({ id: 'status', type: 'select', options: ['Todo', 'Done'] })
  const multiSelectColumn = createColumn({ id: 'tags', type: 'multi-select', options: ['AI', 'UX'] })
  const checkboxColumn = createColumn({ id: 'done', type: 'checkbox' })
  const dateColumn = createColumn({ id: 'date', type: 'date' })
  const textColumn = createColumn({ id: 'notes', type: 'text' })

  assert.equal(getBoardDropFieldValue(selectColumn, 'Todo', 'Todo'), undefined)
  assert.equal(getBoardDropFieldValue(selectColumn, 'Todo', 'Done'), 'Done')
  assert.equal(getBoardDropFieldValue(selectColumn, 'Todo', null), null)

  assert.equal(getBoardDropFieldValue(multiSelectColumn, ['AI'], 'AI'), undefined)
  assert.deepEqual(getBoardDropFieldValue(multiSelectColumn, ['AI'], 'UX'), ['AI', 'UX'])
  assert.deepEqual(getBoardDropFieldValue(multiSelectColumn, ['AI'], null), [])

  assert.equal(getBoardDropFieldValue(checkboxColumn, false, false), undefined)
  assert.equal(getBoardDropFieldValue(checkboxColumn, false, true), true)

  // Date field: accepts valid date strings
  assert.equal(getBoardDropFieldValue(dateColumn, '2024-01-01', '2024-01-01'), undefined)
  assert.equal(getBoardDropFieldValue(dateColumn, '2024-01-01', '2024-02-01'), '2024-02-01')
  assert.equal(getBoardDropFieldValue(dateColumn, '2024-01-01', null), null)

  // Text field: accepts any string
  assert.equal(getBoardDropFieldValue(textColumn, 'hello', 'hello'), undefined)
  assert.equal(getBoardDropFieldValue(textColumn, 'hello', 'world'), 'world')
  assert.equal(getBoardDropFieldValue(textColumn, 'hello', ''), '')
})

test('normalizeCodeLanguage maps common aliases to canonical names', () => {
  assert.equal(normalizeCodeLanguage('ts'), 'typescript')
  assert.equal(normalizeCodeLanguage('JS'), 'javascript')
  assert.equal(normalizeCodeLanguage('c#'), 'csharp')
  assert.equal(normalizeCodeLanguage('html'), 'html')
  assert.equal(normalizeCodeLanguage(''), null)
})

test('detectCodeLanguage respects explicit language preference first', () => {
  const detected = detectCodeLanguage('const answer = 42', 'ts')
  assert.equal(detected, 'typescript')
})

test('detectCodeLanguage identifies common language snippets', () => {
  assert.equal(detectCodeLanguage('const answer: number = 42\nexport default answer'), 'typescript')
  assert.equal(detectCodeLanguage('const answer = 42\nconsole.log(answer)'), 'javascript')
  assert.equal(detectCodeLanguage('def greet(name):\n    print(name)'), 'python')
  assert.equal(detectCodeLanguage('SELECT id, name FROM users WHERE active = true'), 'sql')
  assert.equal(detectCodeLanguage('<div class="hero">Hello</div>'), 'html')
  assert.equal(detectCodeLanguage('.hero { color: red; margin: 4px; }'), 'css')
  assert.equal(detectCodeLanguage('{"name":"knowbook","enabled":true}'), 'json')
  assert.equal(detectCodeLanguage('---\nname: knowbook\nenabled: true'), 'yaml')
})