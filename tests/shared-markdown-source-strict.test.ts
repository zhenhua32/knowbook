import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdownBlocks, parseMarkdownSourceStrict, type MarkdownSourceStrictOptions } from '../src/shared/markdown'
import { SYNCED_BLOCK_FENCE_INFO, serializeSyncedBlockPayload } from '../src/shared/syncedBlockValidation'

const groupId = '11111111-1111-4111-8111-111111111111'
const payload = serializeSyncedBlockPayload({ version: 1, groupId })
const fence = ['```' + SYNCED_BLOCK_FENCE_INFO, payload, '```'].join('\n')
type Ref = Extract<MarkdownSourceStrictOptions, { mode: 'internal-host' }>['references'][number]
const host = (references: readonly Ref[]): MarkdownSourceStrictOptions => ({ mode: 'internal-host', references })
function reference(source: string, key = 'first', start = 0): Ref {
  const from = source.indexOf('```', start), to = source.indexOf('```', from + 3) + 3
  assert.ok(from >= 0 && to > from)
  return { key, from, to, payload }
}

test('strict source records metadata without applying its identity, type, depth or recursive grouping; public compatibility stays intact', () => {
  const metadata = '<!-- knowbook:block {"type":"heading-2","id":" foreign ","parentBlockId":"other","depth":7,"tags":["injected"],"highlight":"red"} -->'
  const source = metadata + '\nBody\n\nSecond'
  const parsed = parseMarkdownSourceStrict(source, { mode: 'canonical' })
  assert.deepEqual(parsed.blocks.map(block => [block.type, block.content, block.depth, block.parentIndex, block.refKey]),
    [['paragraph', 'Body', 0, null, null], ['paragraph', 'Second', 0, null, null]])
  assert.deepEqual(parsed.metadata, [{ startLine: 0, endLine: 1, raw: metadata }])
  for (const block of parsed.blocks) for (const key of ['id', 'parentBlockId', 'tags', 'highlight']) assert.equal(Object.hasOwn(block, key), false)
  const compatible = parseMarkdownBlocks(source)
  assert.equal(compatible[0].type, 'heading-2')
  assert.equal(compatible[0].id, 'foreign')
  assert.equal(compatible[0].depth, 0)
  const forged = '<!-- knowbook:block {"type":"synced-block","id":"foreign","depth":6} -->\n' + fence
  assert.deepEqual(parseMarkdownSourceStrict(forged, host([])).blocks.map(block => block.type), ['code'])
})

test('only exact unique protected fence expectations become references, including repeated payloads and source reorder', () => {
  const source = fence + '\n\n' + fence + '\n\nTail'
  const first = reference(source, 'first'), second = reference(source, 'second', first.to)
  const before = structuredClone([first, second])
  const parsed = parseMarkdownSourceStrict(source, host([first, second]))
  assert.deepEqual(parsed.blocks.map(block => [block.type, block.refKey]), [['synced-block', 'first'], ['synced-block', 'second'], ['paragraph', null]])
  assert.deepEqual(parsed.references, [first, second].map(({ key, from, to }) => ({ key, from, to })))
  const reordered = parseMarkdownSourceStrict(source, host([{ ...first, key: 'second' }, { ...second, key: 'first' }]))
  assert.deepEqual(reordered.blocks.slice(0, 2).map(block => block.refKey), ['second', 'first'])
  assert.deepEqual([first, second], before, 'consumption never mutates the caller expectations')
  assert.throws(() => parseMarkdownSourceStrict(source, host([first, { ...second, key: first.key }])), /duplicate/i)
  assert.throws(() => parseMarkdownSourceStrict(source, host([first, { ...second, from: first.from + 1 }])), /overlap/i)
  assert.throws(() => parseMarkdownSourceStrict(source, host([{ ...first, from: first.from + 1 }])), /unmatched/i)
})

test('unknown, damaged, hidden or payload-modified protected references reject without returning a repaired candidate', () => {
  const cases = [fence.replace('-v1', '-v99'), fence.replace('```' + SYNCED_BLOCK_FENCE_INFO, '```' + SYNCED_BLOCK_FENCE_INFO + ' extra'),
    fence.replace(groupId, '22222222-2222-4222-8222-222222222222'),
    fence.replace(payload, '{"version":1,"version":1,"groupId":"' + groupId + '"}')]
  for (const source of cases) {
    const expectation = reference(source), before = structuredClone(expectation)
    assert.throws(() => parseMarkdownSourceStrict(source, host([expectation])))
    assert.deepEqual(expectation, before)
  }
  const unclosed = fence.slice(0, fence.lastIndexOf('```'))
  assert.throws(() => parseMarkdownSourceStrict(unclosed, host([{ key: 'first', from: 0, to: unclosed.length, payload }])), /unmatched/i)
  assert.equal(parseMarkdownBlocks(unclosed)[0].type, 'code', 'public Markdown keeps its unclosed code compatibility')
  const quoted = fence.split('\n').map(line => '> ' + line).join('\n')
  assert.throws(() => parseMarkdownSourceStrict(quoted, host([reference(quoted)])), /unmatched/i)
})

test('canonical and unproven public-looking fences remain literal in code, quote, list and legacy HTML contexts', () => {
  const cases = [fence, fence.replace('-v1', '-v99'), '````markdown\n' + fence + '\n````',
    fence.split('\n').map(line => '> ' + line).join('\n'), '- ' + fence.replace(/\n/g, '\n  '),
    '<details>\n<summary>Legacy</summary>\n\n' + fence + '\n\n</details>']
  for (const source of cases) for (const options of [{ mode: 'canonical' } as const, host([])]) {
    const parsed = parseMarkdownSourceStrict(source, options)
    assert.equal(parsed.blocks.some(block => block.type === 'synced-block'), false)
    assert.deepEqual(parsed.references, [])
    assert.equal(parsed.blocks.length, parseMarkdownBlocks(source).length)
  }
  const invalidCanonicalOptions = { mode: 'canonical' as const, references: [] }
  assert.throws(() => parseMarkdownSourceStrict(fence, invalidCanonicalOptions), /cannot bind/i)
})

test('strict source rejects the seventh nested level instead of absorbing deeper lists into a body; public compatibility is unchanged', () => {
  const lists = (count: number) => Array.from({ length: count }, (_, index) => '  '.repeat(index) + '- level ' + index).join('\n')
  const accepted = parseMarkdownSourceStrict(lists(7), { mode: 'canonical' })
  assert.deepEqual(accepted.blocks.map(block => block.depth), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(accepted.blocks.map(block => block.parentIndex), [null, 0, 1, 2, 3, 4, 5])
  assert.throws(() => parseMarkdownSourceStrict(lists(8), { mode: 'canonical' }), /six levels/i)
  const compatible = parseMarkdownBlocks(lists(8))
  assert.equal(compatible.length, 7)
  assert.ok(compatible[6].content.includes('level 7'))
  const complex = '- Parent\n\n  extra paragraph\n\n' + lists(8).split('\n').map(line => '  ' + line).join('\n')
  assert.throws(() => parseMarkdownSourceStrict(complex, { mode: 'canonical' }), /six levels/i)
})

test('representable list prefixes and complete reference items retain order and separate ranges; interleaved complex bodies reject', () => {
  const source = '- Parent\n\n  extra paragraph\n\n  ' + fence.replace(/\n/g, '\n  ')
  const parsed = parseMarkdownSourceStrict(source, host([reference(source)]))
  assert.deepEqual(parsed.blocks.map(block => [block.type, block.depth, block.parentIndex, block.refKey]),
    [['bulleted-list', 0, null, null], ['synced-block', 1, 0, 'first']])
  assert.equal(parsed.blocks[0].content, 'Parent\n\nextra paragraph')
  assert.deepEqual(parsed.sourceRanges.map(range => [range.startLine, range.endLine]), [[0, 3], [4, 7]])
  const nested = '- Parent\n  - ' + fence.replace(/\n/g, '\n    ')
  const nestedParsed = parseMarkdownSourceStrict(nested, host([reference(nested)]))
  assert.deepEqual(nestedParsed.blocks.map(block => [block.type, block.depth, block.parentIndex]), [['bulleted-list', 0, null], ['synced-block', 1, 0]])
  assert.deepEqual(nestedParsed.references, [reference(nested)].map(({ key, from, to }) => ({ key, from, to })))
  const codePrefix = '- ```text\n  literal\n  ```\n\n  ' + fence.replace(/\n/g, '\n  ')
  const codeParsed = parseMarkdownSourceStrict(codePrefix, host([reference(codePrefix, 'code-child', codePrefix.indexOf('```' + SYNCED_BLOCK_FENCE_INFO))]))
  assert.equal(codeParsed.blocks[0].content, '```text\nliteral\n```')
  assert.deepEqual(codeParsed.blocks.map(block => [block.type, block.parentIndex]), [['bulleted-list', null], ['synced-block', 0]])
  const interleaved = source + '\n\n  After child'
  assert.throws(() => parseMarkdownSourceStrict(interleaved, host([reference(interleaved)])), /preserve protected reference order/i)
  assert.equal(parseMarkdownBlocks(interleaved)[0].content.includes(payload), true)
})

test('native headers, child ranges and structural closers preserve real indices without fake paragraphs or repaired columns', () => {
  const source = ['<details data-knowbook-container="toggle-v1">', '<summary>Outer</summary>', '',
    '<section data-knowbook-container="columns-v1">', '', '<div data-knowbook-container="column-v1" data-knowbook-weight="10000">', '',
    fence, '', '</div>', '', '</section>', '', '</details>'].join('\n')
  const parsed = parseMarkdownSourceStrict(source, host([reference(source)]))
  assert.deepEqual(parsed.blocks.map(block => [block.type, block.depth, block.parentIndex]),
    [['toggle', 0, null], ['columns', 1, 0], ['column', 2, 1], ['synced-block', 3, 2]])
  assert.deepEqual(parsed.sourceRanges.map(range => [range.index, range.startLine, range.endLine]), [[0, 0, 2], [1, 3, 4], [2, 5, 6], [3, 7, 10]])
  assert.deepEqual(parsed.closingRanges.map(range => [range.index, range.startLine, range.endLine]), [[2, 11, 12], [1, 13, 14], [0, 15, 16]])
  for (const close of parsed.closingRanges) for (const range of parsed.sourceRanges)
    assert.ok(close.endLine <= range.startLine || close.startLine >= range.endLine)
  const empty = parseMarkdownSourceStrict(source.replace(fence, ''), host([]))
  assert.deepEqual(empty.blocks.map(block => block.type), ['toggle', 'columns', 'column'])
  const badWeight = source.replace('weight="10000"', 'weight="9999"')
  assert.throws(() => parseMarkdownSourceStrict(badWeight, host([reference(badWeight)])))
  assert.throws(() => parseMarkdownSourceStrict(source.slice(0, source.lastIndexOf('</details>')), host([reference(source)])))
})

test('reference core proofs use original UTF-16 offsets with CRLF, indentation, trailing whitespace and opaque metadata bytes', () => {
  const metadata = '<!-- knowbook:block {"id":"  旧:正文  ","parentBlockId":"__proto__","tags":["原字节"]} -->'
  const source = '😀 Before\r\n\r\n' + metadata + '\r\n\r\n  ```' + SYNCED_BLOCK_FENCE_INFO + '\r\n  ' + payload + '\r\n  ``` \t\r\n\r\nTail'
  const expected = reference(source, '  旧:位置  '), parsed = parseMarkdownSourceStrict(source, host([expected]))
  assert.deepEqual(parsed.references, [{ key: expected.key, from: expected.from, to: expected.to }])
  assert.equal(source.slice(expected.from, expected.to), '```' + SYNCED_BLOCK_FENCE_INFO + '\r\n  ' + payload + '\r\n  ```')
  assert.equal(expected.from, source.indexOf('```'))
  assert.notEqual(expected.from, [...source.slice(0, expected.from)].length)
  assert.equal(parsed.blocks.find(block => block.refKey === expected.key)?.content, payload)
  assert.deepEqual(parsed.metadata, [{ startLine: 2, endLine: 3, raw: metadata }])
  assert.equal(parsed.blocks.some(block => Object.hasOwn(block, 'id') || Object.hasOwn(block, 'parentBlockId')), false)
  assert.throws(() => parseMarkdownSourceStrict(source, host([{ ...expected, from: expected.from - 2 }])), /unmatched/i)
  assert.throws(() => parseMarkdownSourceStrict(source, host([{ ...expected, to: expected.to + 2 }])), /unmatched/i)
})
