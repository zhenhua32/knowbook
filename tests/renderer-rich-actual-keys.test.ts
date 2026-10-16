import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState, type Transaction } from 'prosemirror-state'
import type { SyncedBindingKey, SyncedCanonicalEdit, SyncedOriginV1 } from '../src/shared/synced-blocks'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '../src/shared/markdownLinks'
import { markdownEngine } from '../src/shared/markdownEngine'
import { draftBlocksToRichDoc, richBlockEntries, richDocToDraftBlocks } from '../src/renderer/src/rich-text/model'
import { richTextSchema as schema } from '../src/renderer/src/rich-text/schema'
import { createRichActualKeyCache, prepareRichActualKeys, type RichActualKeyCache, type RichActualKeysResult } from '../src/renderer/src/rich-text/richActualKeys'

const origin: SyncedOriginV1 = { version: 1, documentId: ' 真实源 ', pathAtCreation: 'Docs/Origin', firstInstanceId: '11111111-1111-4111-8111-111111111111' }
const block = (id: string, content: string, type = 'paragraph', depth = 0, parentBlockId: string | null = null): SyncedCanonicalEdit =>
  ({ id, content, type, depth, parentBlockId, checked: false })
function oracle(blocks: readonly SyncedCanonicalEdit[], path = origin.pathAtCreation): SyncedBindingKey[] {
  return collectDocumentMarkdownLinks([...blocks]).flatMap(link => {
    if (link.kind === 'image' || link.kind !== 'wiki' && !resolveMarkdownDocumentPath(path, link.url)) return []
    return [{ blockId: blocks[link.blockIndex].id, from: link.start, to: link.end,
      raw: blocks[link.blockIndex].content.slice(link.start, link.end), syntax: link.kind === 'wiki' ? 'wiki' as const : 'markdown' as const }]
  })
}
function open(blocks: SyncedCanonicalEdit[] = [block('a', '[AB](One.md)'), block('b', 'plain'), block('c', '[CD](One.md)')]) {
  const doc = draftBlocksToRichDoc(blocks), editor = EditorState.create({ doc })
  const syntax = createRichActualKeyCache({ doc, blocks, origin })
  assert.deepEqual(syntax.keys, oracle(blocks))
  return { editor, syntax, blocks }
}
function advance(initial: ReturnType<typeof open>, tr: Transaction, blocks?: SyncedCanonicalEdit[], nextOrigin = origin) {
  const editor = initial.editor.apply(tr), candidate = blocks ?? richDocToDraftBlocks(editor.doc) as SyncedCanonicalEdit[]
  const syntax = prepareRichActualKeys(initial.syntax.cache, { before: initial.editor.doc, transactions: [tr], after: editor.doc,
    blocks: candidate, origin: nextOrigin })
  assert.deepEqual(syntax.keys, oracle(candidate, nextOrigin.pathAtCreation), 'The independent whole-forest collector remains the semantic oracle')
  return { editor, syntax, blocks: candidate }
}
function rootPosition(initial: ReturnType<typeof open>, id: string): number {
  return richBlockEntries(initial.editor.doc).find(entry => entry.node.attrs.block.id === id)!.pos
}
function assertFull(result: RichActualKeysResult): void { assert.equal(result.evidence.mode, 'full'); assert.ok(result.evidence.parsedBlockIds.length) }

test('actual inline typing revalidates only the dirty isolated paragraph and keeps the complete exact inventory', () => {
  const initial = open(), before = JSON.stringify(initial.editor.doc.toJSON())
  const changed = advance(initial, initial.editor.tr.insertText('x', 2))
  assert.equal(changed.syntax.evidence.mode, 'incremental')
  assert.deepEqual(changed.syntax.evidence.dirtyBlockIds, ['a'])
  assert.deepEqual(changed.syntax.evidence.parsedBlockIds, ['a'])
  assert.equal(changed.syntax.keys.length, 2)
  assert.equal(changed.syntax.keys.find(key => key.blockId === 'c'), initial.syntax.keys.find(key => key.blockId === 'c'))
  assert.equal(JSON.stringify(initial.editor.doc.toJSON()), before)
  assert.ok(Object.isFrozen(changed.syntax.keys)); assert.ok(Object.isFrozen(changed.syntax.keys[0]))
  const second = advance(changed, changed.editor.tr.insertText('y', 3))
  assert.equal(second.syntax.evidence.mode, 'incremental')
  assert.deepEqual(second.syntax.evidence.parsedBlockIds, ['a'])
  assert.notEqual(second.syntax.cache, changed.syntax.cache)
})

test('actual formatting steps with empty maps and multiple dirty blocks get parser facts without href or token-order pairing', () => {
  const initial = open(), last = rootPosition(initial, 'c')
  const changed = advance(initial, initial.editor.tr.addMark(1, 3, schema.marks.strong.create()).addMark(last + 1, last + 3, schema.marks.em.create()))
  assert.equal(changed.syntax.evidence.mode, 'incremental')
  assert.deepEqual(changed.syntax.evidence.parsedBlockIds, ['a', 'c'])
  assert.deepEqual(changed.syntax.keys.map(key => key.raw), ['One.md', 'One.md'])
  assert.notEqual(changed.syntax.keys[0].from, initial.syntax.keys[0].from)
  const restored = advance(changed, changed.editor.tr.removeMark(1, 3, schema.marks.strong))
  assert.equal(restored.syntax.evidence.mode, 'incremental')
  assert.equal(restored.blocks[0].content, initial.blocks[0].content)
})

test('same emitted source can reuse syntax facts while leaving explicit link intent to the independent lineage validator', () => {
  const initial = open(), mark = initial.editor.doc.nodeAt(1)!.marks.find(mark => mark.type.name === 'link')!
  const changed = advance(initial, initial.editor.tr.addMark(1, 3, schema.marks.link.create({ ...mark.attrs, knowbookLinkOccurrence: 'different-runtime-token' })))
  assert.equal(changed.syntax.evidence.mode, 'incremental')
  assert.deepEqual(changed.syntax.keys, initial.syntax.keys)
  assert.deepEqual(changed.syntax.evidence.parsedBlockIds, [])
})

test('local validation captures all actual new destinations and rejects writer-shaped but unaccepted Markdown as syntax evidence', () => {
  for (const source of ['[x](New.md) [x](New.md)', '[x]() [y](#head)', '[x](New.md "title")', '[broken](New.md']) {
    const initial = open([block('actual', 'plain')])
    const changed = advance(initial, initial.editor.tr.insertText('x', 2), [block('actual', source)])
    if (source.includes('broken')) assertFull(changed.syntax)
    else assert.equal(changed.syntax.evidence.mode, 'incremental')
    assert.deepEqual(changed.syntax.keys.map(key => key.raw), source.includes('broken') ? [] : source.includes('#head') ? ['', '#head'] : source.includes('title') ? ['New.md'] : ['New.md', 'New.md'])
    for (const key of changed.syntax.keys) assert.equal(source.slice(key.from, key.to), key.raw)
  }
})

test('actual href and title newlines and emitted HTML force full validation even for single-line PM labels', () => {
  for (const attrs of [{ href: 'One.md', title: 'first\nsecond' }, { href: 'One.md', title: 'first\r\nsecond' }, { href: 'One\n.md', title: null }]) {
    const initial = open([block('multiline', '[AB](One.md)')])
    const changed = advance(initial, initial.editor.tr.addMark(1, 3, schema.marks.link.create(attrs)))
    assertFull(changed.syntax)
  }
  const initial = open([block('html', '[AB](One.md)')])
  const changed = advance(initial, initial.editor.tr.addMark(1, 3, schema.marks.underline.create()))
  assert.ok(changed.blocks[0].content.includes('<'))
  assertFull(changed.syntax)
})

test('new block grammar, unterminated inline syntax, native markers and unknown destinations never rely on writer bytes', () => {
  for (const source of ['[r]: Target.md', '# heading [x](Target.md)', '```', '**open [x](Target.md)', '`open [x](Target.md)', '[x](Target.md',
    '<a href="Target.md">x</a>', '<details>', '<!-- knowbook:literal-close:v1 -->', '[[Target]]', '^[note [x](Target.md)]', '$x$ [x](Target.md)', '[TOC]',
    '[x](Target.md)\nnext', '[x](Target.md)\rnext', '\uFEFF[x](Target.md)', '\0[x](Target.md)', '']) {
    const initial = open([block('grammar', 'plain')])
    const changed = advance(initial, initial.editor.tr.insertText('x', 2), [block('grammar', source)])
    assertFull(changed.syntax)
  }
})

test('actual reference contexts including inactive duplicate definitions always use the complete collector', () => {
  const initial = open([block('defs', '[r]: One.md\n[r]: Two.md'), block('use', '[AB][r]')])
  const pos = rootPosition(initial, 'use'), changed = advance(initial, initial.editor.tr.insertText('x', pos + 2))
  assertFull(changed.syntax)
  assert.deepEqual(changed.syntax.keys.map(key => key.blockId), ['defs', 'defs', 'use'])
})

test('actual parent scopes, multiline blocks and unclosed adjacent source atoms cannot acquire a root isolation certificate', () => {
  const fixtures: SyncedCanonicalEdit[][] = [
    [block('target', '[AB](One.md)', 'quote')],
    [block('target', '[AB](One.md)', 'bulleted-list')],
    [block('target', '[AB](One.md)\nnext')],
    [block('owner', 'title', 'callout'), block('target', '[AB](One.md)', 'paragraph', 1, 'owner')],
    [block('target', '[AB](One.md)', 'toggle')],
    [block('unclosed', '```\n[hidden](Hidden.md)', 'table'), block('target', '[AB](One.md)')],
    [block('unclosed', '<details>', 'table'), block('target', '[AB](One.md)')]
  ]
  for (const blocks of fixtures) {
    const initial = open(blocks), pos = rootPosition(initial, 'target')
    assert.equal(initial.editor.doc.nodeAt(pos)!.type.name, 'text_block')
    assertFull(advance(initial, initial.editor.tr.insertText('x', pos + 2)).syntax)
  }
})

test('real split and wrapper steps and changed immutable Origin use full fallback rather than reusing cached Keys', () => {
  const initial = open(), split = advance(initial, initial.editor.tr.split(2))
  assertFull(split.syntax)
  const first = initial.editor.doc.firstChild!
  const wrapped = advance(initial, initial.editor.tr.setNodeMarkup(0, undefined, { ...first.attrs, block: { ...first.attrs.block, type: 'quote' } }))
  assertFull(wrapped.syntax)
  const changed = advance(initial, initial.editor.tr.insertText('x', 2), undefined, { ...origin, pathAtCreation: 'Elsewhere/Origin' })
  assertFull(changed.syntax); assert.equal(changed.syntax.evidence.reason, 'origin')
})

test('unproved atom edits, reference activation changes and out-of-batch source changes invalidate all reused context', () => {
  const initial = open([block('a', '[AB](One.md)'), block('atom', '![x](image.png)')])
  const tr = initial.editor.tr.insertText('x', 2)
  const changed = advance(initial, tr, [block('a', '[AxB](One.md)'), block('atom', '[r]: Two.md')])
  assertFull(changed.syntax)
  const separate = open(), middle = rootPosition(separate, 'b')
  const outOfBatch = advance(separate, separate.editor.tr.insertText('x', middle + 2), [block('a', '[AB](Changed.md)'), block('b', 'pxlain'), block('c', '[CD](One.md)')])
  assertFull(outOfBatch.syntax)
})

test('stale or forged cache and changed installed parser options get full semantic validation', () => {
  const initial = open(), tr = initial.editor.tr.insertText('x', 2), after = initial.editor.apply(tr)
  const blocks = richDocToDraftBlocks(after.doc) as SyncedCanonicalEdit[]
  const forged = prepareRichActualKeys(Object.freeze({ revision: initial.syntax.cache.revision }) as RichActualKeyCache,
    { before: initial.editor.doc, transactions: [tr], after: after.doc, blocks, origin })
  assertFull(forged); assert.deepEqual(forged.keys, oracle(blocks))
  const changed = advance(initial, tr)
  const stale = prepareRichActualKeys(initial.syntax.cache, { before: changed.editor.doc, transactions: [], after: changed.editor.doc, blocks: changed.blocks, origin })
  assertFull(stale); assert.equal(stale.evidence.reason, 'stale-cache')
  const previous = markdownEngine.options.breaks
  try {
    markdownEngine.options.breaks = !previous
    const grammar = advance(initial, tr)
    assertFull(grammar.syntax); assert.equal(grammar.syntax.evidence.reason, 'grammar')
  } finally { markdownEngine.options.breaks = previous }
})

test('the private cache keeps independent immutable byte snapshots and multi-accept context proofs', () => {
  const blocks = [{ ...block('snapshot', '[AB](One.md)'), tags: ['tag'] }], initial = open(blocks)
  blocks[0].content = '[AB](Hijack.md)'; blocks[0].tags.push('mutated')
  const changed = advance(initial, initial.editor.tr.insertText('x', 2))
  assert.equal(changed.syntax.evidence.mode, 'incremental')
  assert.deepEqual(changed.syntax.keys.map(key => key.raw), ['One.md'])
  assert.ok(Object.isFrozen(changed.syntax)); assert.ok(Object.isFrozen(changed.syntax.cache)); assert.ok(Object.isFrozen(changed.syntax.evidence.parsedBlockIds))
  assert.equal(Object.hasOwn(changed.syntax.cache, 'byBlock'), false)
})
