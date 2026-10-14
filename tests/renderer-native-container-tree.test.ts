import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { normalizeDraftBlocks, validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization'
import { isDraftTreeContiguous, planDraftBlockDepthChange, planDraftSubtreePlacement } from '../src/renderer/src/utils/draftTreeDepthChange'
import { planBlockAction } from '../src/renderer/src/utils/documentBlockActions'
import { materializeDraftFragment } from '../src/renderer/src/utils/draftTreeFragment'
import { materializePastedDraftFragment, planDraftContainerTitlePaste } from '../src/renderer/src/utils/draftTreePaste'
import { resolveDraftInsertionPlacement } from '../src/renderer/src/utils/draftTreePlacement'
import { areDocumentDraftBlocksEqual } from '../src/renderer/src/utils/documentDraftComparison'
import { draftBlocksToRichDoc, richDocToDraftBlocks } from '../src/renderer/src/rich-text/model'

const block = (id: string, type: string, depth = 0, parentBlockId: string | null = null, content = id): DocumentBlockDraft =>
  ({ id, type, depth, parentBlockId, content, checked: false, tags: [id], highlight: 'blue' })
const tree = () => normalizeDraftBlocks([
  { ...block('outer', 'toggle'), markdownFormat: { toggleDefaultOpen: false } },
  { ...block('owner', 'callout', 1, 'outer'), markdownFormat: { calloutKind: 'tip', calloutIcon: 'pin', calloutTone: 'green' } },
  block('paragraph', 'paragraph', 2, 'owner'), block('list', 'todo', 2, 'owner'),
  block('list-child', 'numbered-list', 3, 'list'),
  { ...block('code', 'code', 2, 'owner', 'const x = 1'), language: 'javascript', markdownFormat: { codeInfo: 'js extra' } },
  block('table', 'table', 2, 'owner', '| H |\n| --- |\n| B |'), block('after', 'paragraph', 1, 'outer')
])
const relationships = (blocks: DocumentBlockDraft[]) => blocks.map(({ id, depth, parentBlockId }) => [id, depth, parentBlockId ?? null])
const valid = (blocks: DocumentBlockDraft[]) => {
  assert.deepEqual(validateBlockTreeStructure(blocks), { valid: true, errors: [] })
  assert.equal(isDraftTreeContiguous(blocks), true)
}

test('mixed container children retain typed ownership and atomic source metadata through three rich round trips', () => {
  const original = tree()
  valid(original)
  let value = original
  for (let round = 0; round < 3; round++) {
    const doc = draftBlocksToRichDoc(value)
    assert.equal(doc.child(0).type.name, 'text_block')
    assert.equal(doc.child(1).type.name, 'text_block')
    assert.equal(doc.child(5).type.name, 'source_block')
    value = richDocToDraftBlocks(doc)
    assert.deepEqual(value, original)
    valid(value)
  }
})

test('active typed ancestors reject closed owners, prose owners, list mixed children, and nested frontmatter', () => {
  const mixed = normalizeDraftBlocks([block('a', 'toggle'), block('body', 'paragraph', 1, 'a'),
    block('closed', 'paragraph'), block('old-child', 'code', 1, 'a')])
  assert.deepEqual(relationships(mixed), [['a', 0, null], ['body', 1, 'a'], ['closed', 0, null], ['old-child', 0, null]])
  valid(mixed)
  const list = normalizeDraftBlocks([block('list', 'todo'), block('text', 'paragraph', 1, 'list')])
  assert.equal(list[1].depth, 0)
  const frontmatter = normalizeDraftBlocks([block('owner', 'callout'), block('fm', 'frontmatter', 1, 'owner', '---\na: b\n---')])
  assert.equal(frontmatter[1].parentBlockId, null)
  assert.equal(frontmatter[1].depth, 0)
  const broken = [block('owner', 'toggle'), block('new-root', 'paragraph'), block('late', 'todo', 1, 'owner')]
  assert.equal(planBlockAction(broken, ['owner'], 'delete'), null)
  assert.equal(resolveDraftInsertionPlacement([block('owner', 'callout'), block('body', 'paragraph', 1, 'owner')], 2, 'code', 2).parentBlockId, 'owner')
})

test('losing a mixed owner promotes complete children to its outer container without changing IDs or metadata', () => {
  const before = tree()
  const after = planBlockAction(before, ['owner'], 'convert', 'paragraph')!
  valid(after)
  assert.equal(after[1].type, 'paragraph')
  assert.equal(after[1].markdownFormat, undefined)
  for (const index of [2, 3, 5, 6]) assert.deepEqual(after[index], { ...before[index], depth: 1, parentBlockId: 'outer' })
  assert.deepEqual(after[4], { ...before[4], depth: 2 })
  assert.deepEqual(after.at(-1), before.at(-1))
  assert.deepEqual(after.map(item => item.id), before.map(item => item.id))
  const list = planBlockAction(before, ['owner'], 'convert', 'todo')!
  valid(list)
  assert.equal(list[3].parentBlockId, 'outer', 'a partially compatible owner cannot leave mixed children across a closed subtree')
})

test('converting selected list owners and children together retains a compatible new container tree', () => {
  const before = normalizeDraftBlocks([block('a', 'todo'), block('b', 'todo', 1, 'a'), block('c', 'todo', 2, 'b')])
  const after = planBlockAction(before, ['a', 'b'], 'convert', 'toggle')!
  valid(after)
  assert.deepEqual(relationships(after), relationships(before))
  assert.deepEqual(after.map(item => item.type), ['toggle', 'toggle', 'todo'])
  const converted = planBlockAction(before, ['b'], 'convert', 'paragraph')!
  valid(converted)
  assert.deepEqual(relationships(converted), [['a', 0, null], ['b', 0, null], ['c', 0, null]])
})

test('mixed subtree indent/outdent and drag obey target owner types without flattening descendants', () => {
  const before = normalizeDraftBlocks([block('parent', 'callout'), block('text', 'paragraph'),
    block('toggle', 'toggle'), block('body', 'code', 1, 'toggle', 'x')])
  const indented = planDraftBlockDepthChange(before, { start: 1, end: 3 }, 1)!
  valid(indented.blocks)
  assert.deepEqual(relationships(indented.blocks), [['parent', 0, null], ['text', 1, 'parent'], ['toggle', 1, 'parent'], ['body', 2, 'toggle']])
  const outdented = planDraftBlockDepthChange(indented.blocks, { start: 2, end: 3 }, -1)!
  valid(outdented.blocks)
  assert.deepEqual(relationships(outdented.blocks), [['parent', 0, null], ['text', 1, 'parent'], ['toggle', 0, null], ['body', 1, 'toggle']])
  const invalid = [block('parent', 'todo'), ...before.slice(1)]
  assert.equal(planDraftBlockDepthChange(invalid, { start: 1, end: 3 }, 1), null)
  assert.equal(planDraftSubtreePlacement(before, { start: 2, end: 3 }, 1, 1)?.blocks[1].parentBlockId, 'parent')
})

test('duplicate and materialize clone complete mixed forests and finite metadata while remapping all child IDs', () => {
  const before = tree()
  const copy = materializeDraftFragment(before.slice(1, 7), 'outer')
  assert.equal(copy[1].parentBlockId, copy[0].id)
  assert.equal(copy[3].parentBlockId, copy[2].id)
  assert.notEqual(copy[0].markdownFormat, before[1].markdownFormat)
  assert.notEqual(copy[1].tags, before[2].tags)
  const after = planBlockAction(before, ['owner'], 'duplicate')!
  valid(after)
  assert.equal(after.length, before.length + 6)
  assert.equal(new Set(after.map(item => item.id)).size, after.length)
  assert.deepEqual(after.slice(0, 7), before.slice(0, 7))
})

test('title structural paste retains the original forest and appends a paragraph tail inside the same owner', () => {
  const before = tree()
  const pasted = [block('incoming', 'toggle'), block('incoming-body', 'paragraph', 1, 'incoming')]
  const plan = planDraftContainerTitlePaste(before, 1, pasted, 'Prefix', 'Suffix')!
  valid(plan.blocks)
  assert.deepEqual(plan.blocks.slice(2, 7), before.slice(2, 7))
  assert.deepEqual(plan.blocks[1], { ...before[1], content: 'Prefix' })
  const added = plan.blocks.slice(7, 10)
  assert.equal(added[0].parentBlockId, 'owner')
  assert.equal(added[1].parentBlockId, added[0].id)
  assert.equal(added[2].type, 'paragraph')
  assert.equal(added[2].parentBlockId, 'owner')
  assert.equal(plan.cursorPosition, 0)
  assert.equal(plan.focusIndex, 9)
  assert.deepEqual(plan.blocks.at(-1), before.at(-1))
})

test('paste keeps ordinary mixed roots in containers and preserves overflowing depth or frontmatter as complete text', () => {
  const before = tree()
  const fragment = materializePastedDraftFragment([block('heading', 'heading-2'), block('quote', 'quote')], before[2], before)!
  assert.deepEqual(fragment.map(item => [item.depth, item.parentBlockId]), [[2, 'owner'], [2, 'owner']])
  const protectedText = planDraftContainerTitlePaste(before, 1, [block('fm', 'frontmatter', 0, null, '---\na: b\n---')], 'Prefix', '')!
  valid(protectedText.blocks)
  assert.equal(protectedText.blocks[7].type, 'paragraph')
  assert.match(protectedText.blocks[7].content, /a: b/)
  const deep = normalizeDraftBlocks(Array.from({ length: 7 }, (_, depth) => block(`d${depth}`, 'toggle', depth, depth ? `d${depth - 1}` : null)))
  const overflow = planDraftContainerTitlePaste(deep, 6, [block('nested', 'todo'), block('nested-child', 'todo', 1, 'nested')], 'Title', 'Tail')!
  valid(overflow.blocks)
  assert.equal(overflow.blocks[7].depth, 6)
  assert.equal(overflow.blocks[7].parentBlockId, 'd5')
  assert.match(overflow.blocks[7].content, /nested-child/)
  assert.equal(overflow.blocks[8].type, 'paragraph')
})

test('finite container metadata changes are visible to dirty comparison independently of content', () => {
  const before = tree()
  for (const patch of [{ calloutKind: 'warning' as const }, { calloutIcon: 'book' as const }, { calloutTone: 'red' as const }]) {
    const after = before.map((item, index) => index === 1 ? { ...item, markdownFormat: { ...item.markdownFormat, ...patch } } : item)
    assert.equal(areDocumentDraftBlocksEqual(before, after), false)
  }
  const toggled = before.map((item, index) => index === 0 ? { ...item, markdownFormat: { toggleDefaultOpen: true } } : item)
  assert.equal(areDocumentDraftBlocksEqual(before, toggled), false)
  assert.equal(areDocumentDraftBlocksEqual(before, before.map(item => ({ ...item }))), true)
})
