import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts.ts'
import { buildDocumentSections, findDocumentSection, getVisibleDocumentEntries, readDocumentFoldView, revealDocumentBlock, saveDocumentFoldView } from '../src/renderer/src/utils/documentSections.ts'

const block = (id: string, type: DocumentBlockDraft['type'] = 'paragraph', depth = 0, parentBlockId: string | null = null): DocumentBlockDraft => ({ id, type, content: id, checked: false, depth, parentBlockId })
const blocks = [block('intro'), block('a', 'heading-1'), block('a-body'), block('a1', 'heading-2'),
  block('list', 'bulleted-list'), block('child', 'bulleted-list', 1, 'list'), block('a2', 'heading-2'), block('a2-body'),
  block('b', 'heading-1'), block('b-body')]

test('sections stop at the next same/higher heading and retain stable IDs', () => {
  assert.deepEqual(buildDocumentSections(blocks), [
    { id: 'a', index: 1, end: 8, level: 1, parentId: null },
    { id: 'a1', index: 3, end: 6, level: 2, parentId: 'a' },
    { id: 'a2', index: 6, end: 8, level: 2, parentId: 'a' },
    { id: 'b', index: 8, end: 10, level: 1, parentId: null }
  ])
  assert.equal(findDocumentSection(buildDocumentSections(blocks), 0), null)
  assert.equal(findDocumentSection(buildDocumentSections(blocks), 5)?.id, 'a1')
  assert.equal(findDocumentSection(buildDocumentSections(blocks), 9)?.id, 'b')
  assert.equal(buildDocumentSections([block('orphan', 'heading-2'), block('next', 'heading-1')])[0].end, 1)
  assert.deepEqual(buildDocumentSections([block('plain')]), [])
})

test('heading folds and nested list folds compose without removing data', () => {
  const visible = (ids: string[], focus: string | null = null) => getVisibleDocumentEntries(blocks, { collapsedIds: new Set(ids), focusedHeadingId: focus }).map(({ block }) => block.id)
  assert.deepEqual(visible(['a']), ['intro', 'a', 'b', 'b-body'])
  assert.deepEqual(visible(['a1']), ['intro', 'a', 'a-body', 'a1', 'a2', 'a2-body', 'b', 'b-body'])
  assert.deepEqual(visible(['list'], 'a1'), ['a1', 'list'])
  assert.deepEqual(visible([], 'a1'), ['a1', 'list', 'child'])
  assert.deepEqual(visible(['a', 'b']), ['intro', 'a', 'b'])
  assert.equal(blocks.length, 10)
  assert.equal(visible(['missing'], 'deleted-heading').length, 10)
})

test('navigation reveals chapter and list ancestors and changes focus only when necessary', () => {
  const view = { collapsedIds: new Set(['a', 'a1', 'list', 'b']), focusedHeadingId: 'b' }
  const next = revealDocumentBlock(blocks, view, 'child')
  assert.equal(next.focusedHeadingId, 'a1')
  assert.deepEqual([...next.collapsedIds], ['b'])
  assert.deepEqual([...view.collapsedIds], ['a', 'a1', 'list', 'b'])
  assert.equal(revealDocumentBlock(blocks, view, 'missing'), view)
  assert.equal(revealDocumentBlock(blocks, next, 'intro').focusedHeadingId, null)
  assert.ok(revealDocumentBlock(blocks, { ...view, focusedHeadingId: null }, 'a').collapsedIds.has('a'), 'restoring a folded heading keeps it folded')
})

test('fold preferences isolate documents, retain recent entries and recover from corrupt/unavailable storage', () => {
  let value = '{broken'
  const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next } }
  assert.equal(readDocumentFoldView('a', storage).collapsedIds.size, 0)
  for (let index = 0; index < 105; index++) saveDocumentFoldView(`doc-${index}`, { collapsedIds: new Set(['a1']), focusedHeadingId: 'a' }, storage)
  assert.equal(JSON.parse(value).length, 100)
  assert.equal(readDocumentFoldView('doc-0', storage).collapsedIds.size, 0)
  assert.equal(readDocumentFoldView('doc-104', storage).focusedHeadingId, 'a')
  assert.ok(readDocumentFoldView('doc-104', storage).collapsedIds.has('a1'))
  const denied = { getItem: (): string => { throw new Error('denied') }, setItem: () => { throw new Error('full') } }
  assert.doesNotThrow(() => saveDocumentFoldView('doc', { collapsedIds: new Set(), focusedHeadingId: null }, denied))
  assert.equal(readDocumentFoldView('doc', denied).focusedHeadingId, null)
})
