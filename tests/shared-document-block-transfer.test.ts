import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { planDocumentBlockTransfer, type DocumentBlockTransferInput } from '../src/shared/documentBlockTransfer'

function block(id: string, type = 'bulleted-list', depth = 0, parentBlockId: string | null = null): DocumentBlockDraft {
  return { id, type, content: id, checked: false, depth, parentBlockId }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function rejectWithoutChanging(input: DocumentBlockTransferInput, context: string): void {
  const before = structuredClone(input)
  freeze(input)
  assert.equal(planDocumentBlockTransfer(input), null, context)
  assert.deepEqual(input, before, `${context}: neither document may change before an atomic commit`)
}

test('moving adjacent nested task subtrees keeps identity, metadata and both documents ownership, then moves back losslessly', () => {
  const from: DocumentBlockDraft[] = [
    block('source-intro', 'paragraph'),
    block('source-owner'),
    block('source-branch', 'numbered-list', 1, 'source-owner'),
    block('source-before', 'todo', 2, 'source-branch'),
    { ...block('move-a', 'numbered-todo', 2, 'source-branch'), content: '完成 **中文任务** [引用](block:retained)', checked: true,
      tags: ['项目', ' Needs review '], listStart: 7, highlight: 'blue', markdownFormat: { listMarker: ')', listLoose: true } },
    { ...block('move-a-child', 'bulleted-list', 3, 'move-a'), content: '<figure data-knowbook-align="right"><img src="file:///原图.png" alt="原图"><figcaption>独立图注</figcaption></figure>',
      tags: ['图片'], markdownFormat: { listMarker: '+' } },
    { ...block('move-a-grandchild', 'todo', 4, 'move-a-child'), checked: true, content: '孙任务', highlight: 'yellow' },
    { ...block('move-b', 'bulleted-list', 2, 'source-branch'), content: '另一个同级条目', markdownFormat: { listMarker: '*', listLoose: false } },
    block('source-after', 'todo', 2, 'source-branch'),
    block('source-after-child', 'todo', 3, 'source-after'),
    block('source-owner-other-child', 'todo', 1, 'source-owner'),
    { ...block('source-code', 'code'), content: 'const value = "中文"', language: 'typescript',
      tags: ['code'], markdownFormat: { codeInfo: 'ts title=sample', emptyCode: false }, highlight: 'purple' }
  ]
  const to = [
    block('target-heading', 'heading-2'),
    block('target-owner'),
    block('target-first', 'todo', 1, 'target-owner'),
    block('target-first-child', 'todo', 2, 'target-first'),
    block('target-before', 'numbered-todo', 1, 'target-owner'),
    block('target-before-child', 'todo', 2, 'target-before'),
    block('target-tail', 'paragraph')
  ]
  const initialFrom = structuredClone(from), initialTo = structuredClone(to)
  freeze(from); freeze(to)
  const plan = planDocumentBlockTransfer({ from, to, selectedIds: ['move-b', 'move-a-child', 'move-a', 'move-a'],
    parentBlockId: 'target-owner', beforeBlockId: 'target-before' })
  assert.ok(plan)
  assert.deepEqual(plan.movedIds, ['move-a', 'move-a-child', 'move-a-grandchild', 'move-b'])
  assert.deepEqual(plan.sourceBlocks, [...initialFrom.slice(0, 4), ...initialFrom.slice(8)])
  const expectedMoved = [
    { ...initialFrom[4], depth: 1, parentBlockId: 'target-owner' },
    { ...initialFrom[5], depth: 2 },
    { ...initialFrom[6], depth: 3 },
    { ...initialFrom[7], depth: 1, parentBlockId: 'target-owner' }
  ]
  assert.deepEqual(plan.targetBlocks, [...initialTo.slice(0, 4), ...expectedMoved, ...initialTo.slice(4)])
  assert.deepEqual(from, initialFrom)
  assert.deepEqual(to, initialTo)
  const back = planDocumentBlockTransfer({ from: plan.targetBlocks, to: plan.sourceBlocks, selectedIds: ['move-a', 'move-b'],
    parentBlockId: 'source-branch', beforeBlockId: 'source-after' })
  assert.ok(back)
  assert.deepEqual(back.sourceBlocks, initialTo)
  assert.deepEqual(back.targetBlocks, initialFrom)
})

test('default root append exits the final target subtree and accepts opaque standalone block content', () => {
  const from = [
    { ...block('heading', 'heading-6'), content: '标题', tags: ['tag'] },
    { ...block('paragraph', 'paragraph'), content: '文字 **格式**\n换行', highlight: 'green' },
    { ...block('code', 'code'), content: '``` inner', language: 'typescript', markdownFormat: { codeInfo: 'ts title="A B"' } },
    { ...block('html', 'html'), content: '<details><summary>展开</summary>完整原文</details>' }
  ]
  const to = [block('target-owner', 'numbered-todo'), block('target-last-child', 'todo', 1, 'target-owner')]
  const plan = planDocumentBlockTransfer({ from, to, selectedIds: ['heading', 'paragraph', 'code', 'html'] })
  assert.ok(plan)
  assert.deepEqual(plan.sourceBlocks, [])
  assert.deepEqual(plan.targetBlocks, [...to, ...from])
  assert.deepEqual(plan.movedIds, ['heading', 'paragraph', 'code', 'html'])
  const empty = planDocumentBlockTransfer({ from, to: [], selectedIds: ['heading', 'paragraph', 'code', 'html'] })
  assert.ok(empty)
  assert.deepEqual(empty.targetBlocks, from)
})

test('parent append follows all existing descendants and preserves the later sibling boundary', () => {
  const from = [block('moving', 'todo'), block('moving-child', 'numbered-todo', 1, 'moving'), block('source-tail', 'paragraph')]
  const to = [
    block('owner', 'numbered-list'),
    block('branch', 'numbered-todo', 1, 'owner'),
    block('old-child', 'bulleted-list', 2, 'branch'),
    block('old-grandchild', 'todo', 3, 'old-child'),
    block('later-sibling', 'todo', 1, 'owner'),
    block('later-sibling-child', 'todo', 2, 'later-sibling'),
    block('tail', 'paragraph')
  ]
  const plan = planDocumentBlockTransfer({ from, to, selectedIds: ['moving'], parentBlockId: 'branch' })
  assert.ok(plan)
  assert.deepEqual(plan.sourceBlocks, [from[2]])
  assert.deepEqual(plan.targetBlocks, [...to.slice(0, 4),
    { ...from[0], depth: 2, parentBlockId: 'branch' }, { ...from[1], depth: 3 }, ...to.slice(4)])
  assert.deepEqual(plan.targetBlocks.find(item => item.id === 'later-sibling'), to[4])
  assert.deepEqual(plan.targetBlocks.find(item => item.id === 'later-sibling-child'), to[5])
})

test('root before placement keeps the anchored subtree intact and plan metadata has no mutable input aliases', () => {
  const from: DocumentBlockDraft[] = [{ ...block('moving', 'todo'), checked: true, tags: [' Task '], markdownFormat: { listMarker: '-', listLoose: true } }]
  const to = [block('first'), block('first-child', 'todo', 1, 'first'),
    { ...block('anchor', 'code'), content: '', tags: ['Code'], markdownFormat: { codeInfo: 'ts title=x', emptyCode: true } }, block('tail')]
  const plan = planDocumentBlockTransfer({ from, to, selectedIds: ['moving'], beforeBlockId: 'anchor' })
  assert.ok(plan)
  assert.deepEqual(plan.targetBlocks, [...to.slice(0, 2), ...from, ...to.slice(2)])
  plan.targetBlocks[2].tags!.push('output-only')
  plan.targetBlocks[2].markdownFormat!.listLoose = false
  plan.targetBlocks[3].tags!.push('output-only')
  plan.targetBlocks[3].markdownFormat!.codeInfo = 'changed'
  assert.deepEqual(from[0].tags, [' Task '])
  assert.deepEqual(from[0].markdownFormat, { listMarker: '-', listLoose: true })
  assert.deepEqual(to[2].tags, ['Code'])
  assert.deepEqual(to[2].markdownFormat, { codeInfo: 'ts title=x', emptyCode: true })
})

test('rebasing permits depth six exactly but rejects overflow instead of flattening a descendant', () => {
  const to: DocumentBlockDraft[] = [block('level-0')]
  for (let depth = 1; depth <= 6; depth++) to.push(block(`level-${depth}`, 'todo', depth, `level-${depth - 1}`))
  const from = [block('moving'), block('moving-child', 'todo', 1, 'moving'), block('tail', 'paragraph')]
  const plan = planDocumentBlockTransfer({ from, to, selectedIds: ['moving'], parentBlockId: 'level-4' })
  assert.ok(plan)
  assert.deepEqual(plan.targetBlocks.slice(-2), [
    { ...from[0], depth: 5, parentBlockId: 'level-4' }, { ...from[1], depth: 6 }
  ])
  assert.deepEqual(plan.targetBlocks.slice(0, 7), to)
  rejectWithoutChanging({ from, to, selectedIds: ['moving'], parentBlockId: 'level-5' }, 'descendant would reach depth seven')
  rejectWithoutChanging({ from, to, selectedIds: ['moving-child'], parentBlockId: 'level-6' }, 'root would reach depth seven')
})

test('selection must expand to adjacent complete sibling subtrees with no omitted sibling or mixed roots', () => {
  const from = [block('a'), block('a-child', 'todo', 1, 'a'), block('b'), block('b-child', 'todo', 1, 'b'), block('c')]
  const to = [block('target')]
  for (const [selectedIds, context] of [
    [[], 'empty selection'], [['missing'], 'selection references a deleted block'], [['a', 'c'], 'unselected sibling between chosen roots'],
    [['a-child', 'b'], 'adjacent fragments at different source depths'], [['a-child', 'b-child'], 'children owned by different parents']
  ] as Array<[string[], string]>) rejectWithoutChanging({ from, to, selectedIds }, context)
  const complete = planDocumentBlockTransfer({ from, to, selectedIds: ['b', 'a-child', 'a'] })
  assert.ok(complete)
  assert.deepEqual(complete.movedIds, ['a', 'a-child', 'b', 'b-child'])
  assert.deepEqual(complete.sourceBlocks, [from[4]])
})

test('placement rejects missing anchors, non-list parents and locations that would split or steal a target subtree', () => {
  const from = [block('moving'), block('moving-child', 'todo', 1, 'moving')]
  const to = [block('owner'), block('child', 'todo', 1, 'owner'), block('grandchild', 'todo', 2, 'child'),
    block('other-owner'), block('other-child', 'todo', 1, 'other-owner'), block('paragraph', 'paragraph')]
  for (const [placement, context] of [
    [{ beforeBlockId: 'missing' }, 'missing before anchor'], [{ parentBlockId: 'missing' }, 'missing parent'],
    [{ parentBlockId: 'moving' }, 'source root cannot become its own target parent'],
    [{ parentBlockId: 'paragraph' }, 'non-list target parent'], [{ beforeBlockId: 'child' }, 'root insertion inside another owner'],
    [{ parentBlockId: 'owner', beforeBlockId: 'grandchild' }, 'grandchild is not a direct target sibling'],
    [{ parentBlockId: 'owner', beforeBlockId: 'other-child' }, 'before anchor belongs to another parent'],
    [{ parentBlockId: 'owner', beforeBlockId: 'owner' }, 'before anchor is the parent itself'],
    [{ beforeBlockId: '' }, 'blank before anchor'], [{ parentBlockId: ' ' }, 'blank parent']
  ] as Array<[Pick<DocumentBlockTransferInput, 'beforeBlockId' | 'parentBlockId'>, string]>) {
    rejectWithoutChanging({ from, to, selectedIds: ['moving'], ...placement }, context)
  }
  const standalone = [block('code', 'code')]
  rejectWithoutChanging({ from: standalone, to, selectedIds: ['code'], parentBlockId: 'owner' }, 'standalone block cannot be nested')
})

test('full document validation rejects broken ownership, cycles and ambiguous identity before creating a transaction plan', () => {
  const validFrom = [block('moving')], validTo = [block('target')]
  const invalidTrees: Array<[DocumentBlockDraft[], string]> = [
    [[{ ...block('no-id'), id: undefined }], 'missing ID'],
    [[block('duplicate'), block('duplicate')], 'duplicate ID'],
    [[block('a', 'todo', 1, 'a')], 'self cycle'],
    [[block('a', 'todo', 1, 'b'), block('b', 'todo', 2, 'a')], 'forward parent cycle'],
    [[block('owner'), block('closed-owner'), block('child', 'todo', 1, 'owner')], 'parent outside current ancestor stack'],
    [[block('owner', 'paragraph'), block('child', 'todo', 1, 'owner')], 'non-list owner'],
    [[block('owner'), block('child', 'paragraph', 1, 'owner')], 'standalone child'],
    [[block('orphan', 'todo', 1, 'missing')], 'orphan parent'],
    [[block('root', 'todo', 0, 'missing')], 'root with parent'],
    [[block('negative', 'todo', -1)], 'negative depth'],
    [[block('too-deep', 'todo', 7)], 'depth beyond maximum'],
    [[block('fraction', 'todo', 0.5)], 'fractional depth'],
    [[block('nan', 'todo', Number.NaN)], 'non-finite depth']
  ]
  for (const [invalid, context] of invalidTrees) {
    rejectWithoutChanging({ from: validFrom, to: invalid, selectedIds: ['moving'] }, `target: ${context}`)
    rejectWithoutChanging({ from: invalid, to: validTo, selectedIds: [invalid[0].id ?? 'moving'] }, `source: ${context}`)
  }
  rejectWithoutChanging({ from: validFrom, to: [block('moving')], selectedIds: ['moving'] }, 'moved ID collides with target')
  rejectWithoutChanging({ from: [block('moving'), block('target')], to: validTo, selectedIds: ['moving'] }, 'unmoved source ID collides with target')
  rejectWithoutChanging({ from: validFrom, to: validFrom, selectedIds: ['moving'] }, 'both arrays represent the same document')
})
