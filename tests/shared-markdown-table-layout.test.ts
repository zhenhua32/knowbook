import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdownBlocks, serializeMarkdownWithBlockRanges, type MarkdownRenderableBlock } from '../src/shared/markdown'
import { markdownEngine } from '../src/shared/markdownEngine'
import { collectMarkdownSourceLinks } from '../src/shared/markdownLinks'
import { parseMarkdownTable, parseMarkdownTableNode, renderMarkdownTableHtml } from '../src/shared/markdownTable'
import { parseTableColumnWidthsDirective, tableColumnWidths, validateTableColumnWidths } from '../src/shared/markdownTableLayout'

const directive = '<!-- knowbook:table-widths:v1 [160,null,240] -->'
const body = '| A | B | C |\n| :--- | :---: | ---: |\n| x | y | z |'
const source = directive + '\n' + body

test('the finite layout directive binds to one adjacent real GFM table without changing table or cell source maps', () => {
  const node = parseMarkdownTableNode(source)!
  assert.deepEqual(node.token.map, [1, 4])
  assert.deepEqual(node.token.meta?.tableLayoutMap, [0, 1])
  assert.deepEqual(tableColumnWidths(node.token, 3), [160, null, 240])
  assert.deepEqual(node.children[0].token.map, [1, 2])
  assert.deepEqual(node.children[0].children[0].token.map, [1, 2])
  assert.deepEqual(node.children[1].children[0].token.map, [3, 4])
  assert.deepEqual(parseMarkdownTable(source), { headers: ['A', 'B', 'C'], alignments: ['left', 'center', 'right'], rows: [['x', 'y', 'z']], widths: [160, null, 240] })
  const html = renderMarkdownTableHtml(source)!
  assert.match(html, /<table class="block-markdown-table" data-knowbook-table-layout="true" style="table-layout:fixed;width:520px">/)
  assert.match(html, /<colgroup><col style="width:160px"><col style="width:120px"><col style="width:240px"><\/colgroup>/)
  assert.doesNotMatch(html, /knowbook:table-widths/)
})

test('invalid, duplicate, nonadjacent or unsupported layout comments remain literal and never supply styles', () => {
  for (const comment of [
    '<!-- knowbook:table-widths:v2 [160,null,240] -->',
    '<!-- knowbook:table-widths:v1 [119,null,240] -->',
    '<!-- knowbook:table-widths:v1 [1201,null,240] -->',
    '<!-- knowbook:table-widths:v1 [160.5,null,240] -->',
    '<!-- knowbook:table-widths:v1 ["160",null,240] -->',
    '<!-- knowbook:table-widths:v1 [160,null] -->',
    '<!-- knowbook:table-widths:v1 {"width":160} -->',
    directive + '\n' + directive,
    directive + '\n'
  ]) {
    const value = comment + '\n' + body
    const tokens = markdownEngine.parse(value, {})
    assert.equal(tokens.some(token => token.meta?.boundTableLayout), false, value)
    assert.equal(tokens.find(token => token.type === 'table_open')?.meta?.tableColumnWidths, undefined)
    assert.match(markdownEngine.render(value), /knowbook:table-widths/)
    assert.doesNotMatch(markdownEngine.render(value), /<colgroup>|data-knowbook-table-layout/)
    assert.equal(parseMarkdownTableNode(value), null)
  }
  assert.match(markdownEngine.render(directive + '\nOrdinary paragraph'), /knowbook:table-widths/)
  assert.equal(parseTableColumnWidthsDirective('<!-- knowbook:table-widths:v1 [null,120,1200] -->')?.length, 3)
  assert.equal(validateTableColumnWidths([160, null], 3), undefined)
})

test('layout tables retain source destinations, escaped pipes, reference definitions and global inline context', () => {
  const linked = '<!-- knowbook:table-widths:v1 [160,200] -->\n| A\\|B | [Target](Some%20Page.md#^block) |\n| --- | --- |\n| [Reference][ref] | ![Alt](https://example.com/p.png) |\n\n[ref]: Other.md#heading'
  const links = collectMarkdownSourceLinks(linked)
  assert.equal(links.length, 3)
  assert.deepEqual(links.map(link => [linked.slice(link.start, link.end), link.url]), [
    ['Some%20Page.md#^block', 'Some%20Page.md#%5Eblock'],
    ['https://example.com/p.png', 'https://example.com/p.png'],
    ['Other.md#heading', 'Other.md#heading']
  ])
  const tokens = markdownEngine.parse(linked, {})
  assert.deepEqual(tokens.find(token => token.type === 'table_open')?.map, [1, 4])
  assert.deepEqual(tokens.find(token => token.type === 'table_open')?.meta?.tableColumnWidths, [160, 200])
  assert.match(markdownEngine.render(linked), /href="Other.md#heading"/)
})

test('plain and backup table exports retain one bound layout through three rounds and use a single owned source range', () => {
  const ranges: Array<{ index: number; startLine: number; endLine: number }> = []
  const parsed = parseMarkdownBlocks(source, ranges)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].type, 'table')
  assert.equal(parsed[0].content, source)
  assert.deepEqual(ranges, [{ index: 0, startLine: 0, endLine: 4 }])
  for (const backup of [false, true]) {
    let blocks: MarkdownRenderableBlock[] = [{ ...parsed[0], id: 'table', parentBlockId: null, tags: ['layout'] }]
    for (let round = 0; round < 3; round++) {
      const written = serializeMarkdownWithBlockRanges(blocks, { includeBlockMetadata: backup })
      assert.equal(written.markdown.split(directive).length - 1, 1)
      blocks = parseMarkdownBlocks(written.markdown)
      assert.equal(blocks[0].content, source)
      if (backup) { assert.equal(blocks[0].id, 'table'); assert.deepEqual(blocks[0].tags, ['layout']) }
    }
  }
})
