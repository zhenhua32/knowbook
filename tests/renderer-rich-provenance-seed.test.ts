import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedCanonicalEdit, SyncedOriginV1 } from '../src/shared/synced-blocks'
import { seedRichProvenance } from '../src/renderer/src/rich-text/richProvenanceSeed'
import { draftBlocksToRichDoc, richBlockEntries, richDocToDraftBlocks, richTextInlineFingerprint } from '../src/renderer/src/rich-text/model'
import { richLinkOccurrence } from '../src/renderer/src/rich-text/linkProvenance'

const origin = (): SyncedOriginV1 => ({ version: 1, documentId: ' origin:甲 ', pathAtCreation: 'Docs/Origin', firstInstanceId: '11111111-1111-4111-8111-111111111111' })
const block = (id: string, content: string, type = 'paragraph', depth = 0, parentBlockId: string | null = null): SyncedCanonicalEdit =>
  ({ id, content, type, checked: false, depth, parentBlockId })
const factory = () => { let index = 0; return () => ` occurrence:${++index} ` }

test('cold seed gives equal adjacent URLs distinct actual occurrences while untouched raw bytes and ordinary fingerprints stay unchanged', () => {
  const blocks = [{ ...block(' 旧块:甲 ', '😀\r\n[one](Same.md)[two](Same.md "title")\r\n尾部'), tags: [], highlight: 'yellow' }]
  const original = structuredClone(blocks), ordinary = draftBlocksToRichDoc(blocks)
  const seed = seedRichProvenance({ blocks, origin: origin(), createToken: factory() })
  assert.deepEqual(blocks, original)
  assert.deepEqual(richDocToDraftBlocks(seed.doc), original)
  assert.equal(seed.links.length, 2)
  assert.notEqual(seed.links[0].token, seed.links[1].token)
  assert.ok(seed.links.every(link => link.token.startsWith(' occurrence:') && link.token.endsWith(' ')))
  assert.ok(seed.links.every(link => link.ownerBlockId === ' 旧块:甲 ' && link.via === 'direct' && link.role === 'current-direct'))
  assert.deepEqual(seed.links.map(link => link.sourceKey.from), [blocks[0].content.indexOf('Same.md'), blocks[0].content.lastIndexOf('Same.md')])
  assert.deepEqual(seed.links.map(link => seed.doc.textBetween(link.pmSpans[0].from, link.pmSpans[0].to)), ['one', 'two'])
  assert.equal(richTextInlineFingerprint(seed.doc.firstChild!), richTextInlineFingerprint(ordinary.firstChild!))
  for (const child of ordinary.firstChild!.content.content) for (const mark of child.marks) if (mark.type.name === 'link') assert.equal(richLinkOccurrence(mark), null)
})

test('actual emitted PM pieces count UTF16 text, formatted children and break node sizes rather than raw Markdown markup', () => {
  const content = '😀 [**甲**\n`码`](Guide.md) + [乙](Guide.md)'
  const seed = seedRichProvenance({ blocks: [block('pieces', content)], origin: origin() })
  assert.equal(seed.links.length, 2)
  const first = seed.links[0].pmSpans[0], second = seed.links[1].pmSpans[0]
  assert.deepEqual(first, { from: 4, to: 7 })
  assert.equal(seed.doc.textBetween(first.from, first.to, '', '⏎'), '甲⏎码')
  assert.equal(seed.doc.textBetween(second.from, second.to), '乙')
  assert.equal(first.to - first.from, 3)
  assert.deepEqual(richDocToDraftBlocks(seed.doc)[0].content, content)
})

test('reference uses get independent tokens sharing only the actual first definition key, while every physical definition stays on its atom', () => {
  const definitions = '[ref]: Same.md "first"\r\n[ref]: Ignored.md "duplicate"'
  const blocks = [block('definition', definitions), block('use', '[one][ref] [two][ref]'), block('direct', '[three](Same.md)')]
  const seed = seedRichProvenance({ blocks, origin: origin(), externalReferences: { REF: { href: 'Hijack.md', title: 'external' } } })
  const uses = seed.links.filter(link => link.ownerBlockId === 'use')
  assert.equal(uses.length, 2)
  assert.notEqual(uses[0].token, uses[1].token)
  assert.equal(uses[0].sourceKey, uses[1].sourceKey)
  assert.equal(uses[0].sourceKey.blockId, 'definition')
  assert.equal(uses[0].sourceKey.raw, 'Same.md')
  assert.ok(uses.every(link => link.via === 'reference' && link.role === 'definition-use-copy'))
  assert.deepEqual(uses.map(link => seed.doc.textBetween(link.pmSpans[0].from, link.pmSpans[0].to)), ['one', 'two'])
  const atom = seed.blockRecords[0]
  assert.equal(atom.kind, 'atom'); assert.equal(atom.node.type.name, 'source_block')
  assert.deepEqual(atom.keys.map(key => key.raw), ['Same.md', 'Ignored.md'])
  assert.equal(seed.sourceInventory.length, 3)
  assert.deepEqual(richDocToDraftBlocks(seed.doc), blocks)
})

test('the source inventory retains physical duplicate definitions, Wiki and table destinations, excluding images, code, math and YAML', () => {
  const blocks = [block('yaml', '---\nsummary: "[meta](Meta.md)"\n---', 'frontmatter'),
    block('definitions', '[r]: Target.md\n[r]: Target.md'), block('wiki', '[[Target|same]]'),
    block('table', '| A | B |\n| - | - |\n| [x](One.md) | [x](One.md) |', 'table'),
    block('image', '![alt](Image.md)'), block('code', '[literal](Code.md)', 'code'), block('math', '[literal](Math.md)', 'math')]
  const seed = seedRichProvenance({ blocks, origin: origin() })
  assert.deepEqual(seed.sourceInventory.map(key => [key.blockId, key.raw, key.syntax]), [
    ['definitions', 'Target.md', 'markdown'], ['definitions', 'Target.md', 'markdown'],
    ['wiki', 'Target|same', 'wiki'], ['table', 'One.md', 'markdown'], ['table', 'One.md', 'markdown']
  ])
  assert.equal(seed.links.length, 0)
  assert.ok(seed.blockRecords.every(record => record.kind === 'atom'))
  assert.notEqual(seed.sourceInventory[0].from, seed.sourceInventory[1].from)
  assert.notEqual(seed.sourceInventory[3].from, seed.sourceInventory[4].from)
  assert.deepEqual(richDocToDraftBlocks(seed.doc), blocks)
})

test('local external-only references and zero-child local anchors preserve the entire source block without leaking tentative rich seeds', () => {
  const blocks = [block('outside', '[use][outside]'), block('empty', '[first](Target.md) []()')]
  const seed = seedRichProvenance({ blocks, origin: origin(), externalReferences: { OUTSIDE: { href: 'Target.md', title: '' } } })
  assert.equal(seed.links.length, 0)
  assert.ok(seed.blockRecords.every(record => record.node.type.name === 'source_block'))
  assert.deepEqual(seed.blockRecords[0].keys, [])
  assert.equal(seed.blockRecords[1].keys.length, 2)
  assert.equal(seed.blockRecords[1].keys[1].raw, '')
  assert.equal(seed.blockRecords[1].keys[1].from, seed.blockRecords[1].keys[1].to)
  assert.deepEqual(richDocToDraftBlocks(seed.doc), blocks)
})

test('local eligibility uses the immutable Origin path and never acquires typed target authority', () => {
  const inputOrigin = origin(), content = '[valid](../Target.md) [escape](../../Out.md) [asset](asset.png) [root](/Root.md) [self]() [head](#section) [web](https://example.com)'
  const seed = seedRichProvenance({ blocks: [block('local', content)], origin: inputOrigin })
  assert.deepEqual(seed.links.map(link => link.sourceKey.raw), ['../Target.md', '/Root.md', '', '#section'])
  assert.deepEqual(seed.sourceInventory.map(key => key.raw), ['../Target.md', '/Root.md', '', '#section'])
  inputOrigin.pathAtCreation = 'Different/Now'
  assert.equal(seed.origin.pathAtCreation, 'Docs/Origin')
  assert.ok(Object.isFrozen(seed.origin))
  assert.equal(Reflect.set(seed.origin, 'pathAtCreation', 'hijack'), false)
  for (const link of seed.links) assert.equal(Object.hasOwn(link, 'target'), false)
  for (const key of seed.sourceInventory) assert.deepEqual(Object.keys(key).sort(), ['blockId', 'from', 'raw', 'syntax', 'to'])
})

test('nested HTML anchors with equal normalized hrefs keep their own actual attribute keys and PM use pieces', () => {
  const content = '😀 <u><a href="Same&#46;md">A</a><a href=Same.md>B</a></u>'
  const seed = seedRichProvenance({ blocks: [block('html', content)], origin: origin() })
  assert.equal(seed.links.length, 2)
  assert.deepEqual(seed.links.map(link => link.sourceKey.raw), ['Same&#46;md', 'Same.md'])
  assert.notEqual(seed.links[0].token, seed.links[1].token)
  assert.deepEqual(seed.links.map(link => seed.doc.textBetween(link.pmSpans[0].from, link.pmSpans[0].to)), ['A', 'B'])
  assert.deepEqual(richDocToDraftBlocks(seed.doc)[0].content, content)
})

test('columns preserve exact forest identities, raw bytes and absolute piece positions while source atoms keep their complete key set', () => {
  const blocks = [block('columns', '', 'columns'), { ...block(' 甲列 ', '', 'column', 1, 'columns'), markdownFormat: { columnWeight: 5000 } },
    block('left', '[甲](Left.md)\r\n原始', 'paragraph', 2, ' 甲列 '),
    { ...block('乙列', '', 'column', 1, 'columns'), markdownFormat: { columnWeight: 5000 } }, block('right', '[[Right]]', 'paragraph', 2, '乙列')]
  const seed = seedRichProvenance({ blocks, origin: origin() })
  assert.deepEqual(seed.blockRecords.map(record => record.blockId), blocks.map(block => block.id))
  assert.deepEqual(seed.blockRecords.map(record => record.node.type.name), ['columns_block', 'column_block', 'text_block', 'column_block', 'source_block'])
  assert.deepEqual(richDocToDraftBlocks(seed.doc), blocks)
  const link = seed.links[0], record = seed.blockRecords[2]
  assert.equal(link.ownerBlockId, 'left'); assert.equal(link.pmSpans[0].from, record.pos + 1)
  assert.equal(seed.doc.textBetween(link.pmSpans[0].from, link.pmSpans[0].to), '甲')
  assert.equal(seed.blockRecords[4].keys[0].syntax, 'wiki')
  for (const index of [0, 1, 3]) assert.deepEqual(seed.blockRecords[index].keys, [])
  for (const [index, entry] of richBlockEntries(seed.doc).entries()) assert.equal(seed.blockRecords[index].node, entry.node)
})

test('seed facts are deeply immutable and each seed generation is fresh even when a deterministic occurrence factory is supplied', () => {
  const blocks = [{ ...block('immutable', '[x](Target.md)'), tags: ['tag'] }]
  const left = seedRichProvenance({ blocks, origin: origin(), createToken: factory() }), right = seedRichProvenance({ blocks, origin: origin(), createToken: factory() })
  assert.notEqual(left.generation, right.generation)
  for (const value of [left, left.blocks, left.blocks[0], left.blocks[0].tags!, left.origin, left.links, left.links[0], left.links[0].sourceKey,
    left.links[0].pmSpans, left.links[0].pmSpans[0], left.blockRecords, left.blockRecords[0], left.blockRecords[0].keys, left.sourceInventory]) assert.ok(Object.isFrozen(value))
  assert.equal(Reflect.set(left.links[0].sourceKey, 'raw', 'Other.md'), false)
  assert.equal(Reflect.set(left.links[0].pmSpans[0], 'from', 999), false)
  assert.equal(Reflect.set(left.blocks[0], 'content', 'lost'), false)
  assert.equal(Object.isFrozen(blocks[0]), false)
  assert.equal(Object.isFrozen(blocks[0].tags), false)
})

test('duplicate, blank and nonstring occurrence tokens fail closed without changing the supplied canonical forest', () => {
  const blocks = [block('bad-tokens', '[a](A.md) [b](B.md)')], before = structuredClone(blocks)
  for (const createToken of [() => 'duplicate', () => ' ', (() => 42) as unknown as () => string]) {
    assert.throws(() => seedRichProvenance({ blocks, origin: origin(), createToken }), /来源/)
    assert.deepEqual(blocks, before)
  }
})
