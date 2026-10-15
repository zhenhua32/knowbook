import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { serializeMarkdownWithBlockRanges, type MarkdownSourceSyntaxBlock } from '../src/shared/markdown'
import { parseMarkdownSourceStrict, serializeMarkdownHostSource } from '../src/shared/markdownSource'
import type { SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import { SYNCED_BLOCK_FENCE_INFO, serializeSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'

const groupId = '11111111-1111-4111-8111-111111111111'
const payload = serializeSyncedBlockPayload({ version: 1, groupId })
const block = (id: string, type: string, content: string, depth = 0, parentBlockId: string | null = null,
  extra: Partial<SyncedStableBlockDraft> = {}): SyncedStableBlockDraft => ({ id, type, content, depth, parentBlockId, checked: false, ...extra })
const ref = (depth = 0, parentBlockId: string | null = null) => block(randomUUID(), 'synced-block', payload, depth, parentBlockId)
const column = (id: string, owner: string, weight: number, depth: number) =>
  block(id, 'column', '', depth, owner, { markdownFormat: { columnWeight: weight } })
const semantic = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

/** For fixtures with one syntax node per authored block, reconstruct identities
 * from emitted ranges only. Content, types, depth and parents come from parsing,
 * so a wrong parent or swallowed atom cannot be hidden by the expected forest. */
function roundTrip(blocks: SyncedStableBlockDraft[]) {
  const before = structuredClone(blocks), source = serializeMarkdownHostSource(blocks)
  const parsed = parseMarkdownSourceStrict(source.markdown, { mode: 'internal-host', references: source.references.map(entry => ({
    key: String(entry.index), from: entry.from, to: entry.to, payload: blocks[entry.index].content
  })) })
  const owners = parsed.sourceRanges.map(range => {
    const matches = source.ranges.filter(candidate => candidate.startLine <= range.startLine && candidate.endLine >= range.endLine)
    assert.equal(matches.length, 1, 'each parsed range belongs to exactly one emitted block')
    return matches[0].index
  })
  const restored = blocks.map((original, index) => {
    const positions = owners.flatMap((owner, position) => owner === index ? [position] : [])
    assert.equal(positions.length, 1)
    const syntax: MarkdownSourceSyntaxBlock = parsed.blocks[positions[0]]
    const { parentIndex, refKey: _key, ...content } = syntax
    return { ...content, checked: syntax.checked ?? false, id: original.id,
      parentBlockId: parentIndex === null ? null : blocks[owners[parentIndex]].id,
      ...(original.tags === undefined ? {} : { tags: original.tags }),
      ...(original.highlight === undefined ? {} : { highlight: original.highlight }) }
  })
  assert.deepEqual(semantic(restored), semantic(blocks))
  assert.deepEqual(blocks, before)
  assert.deepEqual(source.ranges.map(range => range.index), blocks.map((_value, index) => index))
  return { source, parsed }
}

test('host source emits repeated root references independently and keeps literal fences and database JSON opaque', () => {
  const config = createDefaultDatabaseViewConfig()
  config.query = '```' + SYNCED_BLOCK_FENCE_INFO + '\n' + payload + '\n```'
  const database = serializeDatabaseViewPayload({ version: 1, databaseId: 'source-db', viewId: null, config })
  const values = [block('literal', 'code', '```' + SYNCED_BLOCK_FENCE_INFO + '\n' + payload + '\n```', 0, null,
    { language: 'markdown', markdownFormat: { codeInfo: 'markdown' } }), ref(),
    block('db', 'database-view', database), ref(),
    block('unknown', 'code', payload, 0, null, { language: 'knowbook-synced-block-v99', markdownFormat: { codeInfo: 'knowbook-synced-block-v99' } }),
    block('tail', 'paragraph', 'Tail')]
  const { source, parsed } = roundTrip(values)
  assert.deepEqual(source.references.map(entry => entry.index), [1, 3])
  assert.deepEqual(parsed.blocks.filter(entry => entry.refKey !== null).map(entry => entry.content), [payload, payload])
  for (const entry of source.references) assert.equal(source.markdown.slice(entry.from, entry.to), '```' + SYNCED_BLOCK_FENCE_INFO + '\n' + payload + '\n```')
  assert.notEqual(source.references[0].from, source.references[1].from)
  assert.equal(parsed.blocks[2].content, database)
})

test('host source preserves mixed callout, toggle and weighted columns with real structural closing ranges', () => {
  const values = [block('callout', 'callout', 'Notice', 0, null, { markdownFormat: { calloutKind: 'info', calloutIcon: 'book', calloutTone: 'blue' } }),
    ref(1, 'callout'), block('toggle', 'toggle', 'Fold', 1, 'callout', { markdownFormat: { toggleDefaultOpen: false } }),
    block('layout', 'columns', '', 2, 'toggle'), column('left', 'layout', 3700, 3),
    block('literal', 'paragraph', 'Before\n</div>\n</section>\nAfter', 4, 'left'), ref(4, 'left'),
    column('right', 'layout', 6300, 3), ref(4, 'right'), block('tail', 'paragraph', 'Tail')]
  const { source } = roundTrip(values)
  assert.deepEqual(source.closingRanges.map(entry => entry.index), [4, 7, 3, 2, 0])
  assert.deepEqual(source.references.map(entry => entry.index), [1, 6, 8])
  for (const close of source.closingRanges) for (const range of source.ranges)
    assert.ok(close.endLine <= range.startLine || close.startLine >= range.endLine)
  assert.ok(source.markdown.includes('data-knowbook-weight="3700"'))
  assert.ok(source.markdown.includes('data-knowbook-weight="6300"'))
})

test('synthetic reference list items use actual ordered and task continuation widths without resetting parent numbering', () => {
  const values = [block('ordered', 'numbered-todo', 'Parent', 0, null,
    { checked: true, listStart: 12, markdownFormat: { listMarker: ')', listLoose: false } }), ref(1, 'ordered'),
    block('next', 'numbered-todo', 'Next', 0, null, { markdownFormat: { listMarker: ')', listLoose: false } }),
    block('task', 'todo', 'Task', 0, null, { checked: true, markdownFormat: { listMarker: '+', listLoose: true } }), ref(1, 'task')]
  const { source } = roundTrip(values)
  assert.ok(source.markdown.startsWith('12) [x] Parent\n    - ```' + SYNCED_BLOCK_FENCE_INFO))
  assert.ok(source.markdown.includes('\n13) [ ] Next'))
  assert.ok(source.markdown.includes('+ [x] Task\n\n  - ```' + SYNCED_BLOCK_FENCE_INFO))
  for (const entry of source.references) {
    assert.equal(source.markdown.slice(entry.from, entry.from + 3), '```')
    assert.equal(source.markdown.slice(entry.to - 3, entry.to), '```')
    assert.equal(source.markdown[entry.from - 1], ' ')
  }
})

test('complex ordinary and code list prefixes cannot swallow a following reference into parent content', () => {
  for (const [content, loose] of [['First\n\nSecond', true], ['```text\nliteral\n```', false]] as const) {
    const values = [block('parent', 'bulleted-list', content, 0, null, { markdownFormat: { listMarker: '-', listLoose: loose } }),
      ref(1, 'parent'), block('tail', 'paragraph', 'Tail')]
    const { source, parsed } = roundTrip(values)
    assert.equal(parsed.blocks[0].content, content)
    assert.equal(parsed.blocks[1].type, 'synced-block')
    assert.equal(parsed.blocks[1].parentIndex, 0)
    assert.equal(source.references[0].index, 1)
  }
})

test('source emission preserves opaque IDs and calculates independent UTF-16 core offsets without payload searching', () => {
  const owner = ' 旧:😀 ', values = [block(owner, 'toggle', '😀 Header', 0, null,
    { tags: ['原字节'], highlight: 'yellow', markdownFormat: { toggleDefaultOpen: false } }),
    block('__proto__', 'paragraph', '😀 ' + payload, 1, owner), ref(1, owner), ref(1, owner), block('tail', 'paragraph', 'Tail')]
  const { source } = roundTrip(values)
  assert.deepEqual(source.references.map(entry => entry.index), [2, 3])
  assert.equal(source.markdown.includes(owner), false, 'source carries no inline persistent metadata identity')
  for (const entry of source.references) {
    assert.ok(entry.from > source.markdown.indexOf(payload), 'a matching ordinary payload is not mistaken for an atom')
    assert.notEqual(entry.from, [...source.markdown.slice(0, entry.from)].length)
  }
})

test('empty columns and ordinary empty blocks keep one input range each without generating filler content', () => {
  const values = [block('layout', 'columns', ''), column('only', 'layout', 10000, 1)]
  const { source, parsed } = roundTrip(values)
  assert.deepEqual(parsed.blocks.map(value => value.type), ['columns', 'column'])
  assert.deepEqual(source.references, [])
  const empty = [block('first', 'paragraph', ''), ref(), block('last', 'paragraph', '')]
  const emitted = serializeMarkdownHostSource(empty)
  assert.equal(emitted.ranges.length, 3)
  assert.equal(emitted.ranges[0].startLine, emitted.ranges[0].endLine)
  assert.equal(emitted.ranges[2].startLine, emitted.ranges[2].endLine)
  assert.deepEqual(emitted.references.map(value => value.index), [1])
  const noReferences = [block('parent', 'todo', 'Parent', 0, null, { markdownFormat: { listMarker: '-', listLoose: false } }),
    block('child', 'bulleted-list', 'Child', 1, 'parent', { markdownFormat: { listMarker: '-', listLoose: false } })]
  roundTrip(noReferences)
})

test('raw invalid host forests reject before emission without depth clamping, reparenting or mutating caller data', () => {
  const invalid = [[block('deep', 'paragraph', 'Body', 7)], [block('child', 'paragraph', 'Body', 1, 'missing')],
    [block('parent', 'todo', 'Parent'), block('not-list', 'paragraph', 'Child', 1, 'parent')],
    [block('layout', 'columns', ''), column('bad', 'layout', 9999, 1)], [block('same', 'paragraph', 'One'), block('same', 'paragraph', 'Two')],
    [block(randomUUID(), 'synced-block', '{"version":99,"groupId":"' + groupId + '"}')]]
  for (const values of invalid) {
    const before = structuredClone(values)
    assert.throws(() => serializeMarkdownHostSource(values))
    assert.deepEqual(values, before)
  }
})

test('public serializer output and result shape retain their default compatibility policy', () => {
  const values = [block('parent', 'bulleted-list', 'Parent', 0, null, { markdownFormat: { listMarker: '-', listLoose: false } }),
    block('child', 'bulleted-list', 'Child', 1, 'parent', { markdownFormat: { listMarker: '-', listLoose: false } }), block('tail', 'paragraph', 'Tail')]
  const before = serializeMarkdownWithBlockRanges(values)
  assert.equal(before.markdown, '- Parent\n  - Child\n\nTail')
  assert.equal(Object.hasOwn(before, 'references'), false)
  serializeMarkdownHostSource(values)
  assert.deepEqual(serializeMarkdownWithBlockRanges(values), before)
})
