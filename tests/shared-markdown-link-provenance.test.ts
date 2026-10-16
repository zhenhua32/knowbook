import assert from 'node:assert/strict'
import test from 'node:test'
import { createMarkdownLinkProvenanceContext, type MarkdownInlineWithLinkProvenance, type MarkdownInlineLinkProvenance } from '../src/shared/markdownLinkProvenance'
import { markdownEngine, type MarkdownEnvironment, type MarkdownNode, type MarkdownToken } from '../src/shared/markdownEngine'
import { capturedMarkdownSourceLinks, type MarkdownLinkProvenanceObserver } from '../src/shared/markdownSourceLinks'
import type { MarkdownRenderableBlock } from '../src/shared/markdown'

function block(id: string, content: string, type = 'paragraph', depth = 0): MarkdownRenderableBlock {
  return { id, content, type, depth, checked: false }
}
function links(result: MarkdownInlineWithLinkProvenance): Array<{ token: MarkdownToken; trace: MarkdownInlineLinkProvenance }> {
  const resultLinks: Array<{ token: MarkdownToken; trace: MarkdownInlineLinkProvenance }> = []
  const visit = (nodes: MarkdownNode[]) => {
    for (const { token, children } of nodes) {
      if (token.type === 'link_open') {
        const trace = result.provenance.get(token)
        assert.ok(trace, 'Every actual returned link token must have a trace or explicit missing proof')
        resultLinks.push({ token, trace })
      }
      if (token.type !== 'image') visit(children)
    }
  }
  visit(result.nodes)
  return resultLinks
}

test('direct provenance uses actual token identities and exact raw UTF16 boundaries through BOM, CRLF, CR and NUL normalization', () => {
  const content = '\uFEFF😀\r\n[first](Same.md)\r[second](Same.md)\n[zero\0](Nul.md)'
  const context = createMarkdownLinkProvenanceContext([block(' 旧块:甲 ', content)])
  const result = context.parseInline(0), found = links(result)
  assert.equal(found.length, 3)
  for (const [index, markup] of ['[first](Same.md)', '[second](Same.md)', '[zero\0](Nul.md)'].entries()) {
    const { token, trace } = found[index], start = content.indexOf(markup), raw = index === 2 ? 'Nul.md' : 'Same.md'
    assert.equal(trace.via, 'direct')
    assert.deepEqual(trace.use, { from: start, to: start + markup.length })
    assert.deepEqual(trace.destination, { blockIndex: 0, blockId: ' 旧块:甲 ', from: start + markup.indexOf(raw), to: start + markup.indexOf(raw) + raw.length, raw, syntax: 'markdown' })
    assert.equal(result.provenance.get(token), trace)
  }
  assert.notEqual(found[0].token, found[1].token)
  assert.notDeepEqual(found[0].trace.destination, found[1].trace.destination)
  assert.equal(result.provenance.get(links(context.parseInline(0))[0].token), undefined, 'Equivalent parses do not share token identity')
})

test('accepted empty inline destinations retain the parser actual insertion points and title exclusions', () => {
  const content = '[plain]() [angled](<>) [spaced](   ) [titled](<> "title") [quoted]( "title")'
  const found = links(createMarkdownLinkProvenanceContext([block('empty', content)]).parseInline(0))
  assert.equal(found.length, 5)
  const points = [content.indexOf('()') + 1, content.indexOf('<>') + 1, content.indexOf('(   )') + 1, content.lastIndexOf('<>') + 1]
  points.forEach((point, index) => assert.deepEqual(found[index].trace.destination, {
    blockIndex: 0, blockId: 'empty', from: point, to: point, raw: '', syntax: 'markdown'
  }))
  assert.equal(found[4].trace.destination?.raw, '"title"')
  assert.equal(found[4].token.attrGet('href'), '%22title%22')
})

test('all reference uses share the actual first definition key, including collapsed and shortcut forms', () => {
  const definition = '[ref]: Target.md "first"', use = '[one][ref] [ref][] [ref]'
  const context = createMarkdownLinkProvenanceContext([
    block('definition', definition), block('duplicate', '[ref]: Other.md "ignored"'), block('uses', use)
  ])
  const found = links(context.parseInline(2))
  assert.equal(found.length, 3)
  for (const [index, markup] of ['[one][ref]', '[ref][]', '[ref]'].entries()) {
    const trace = found[index].trace, from = use.indexOf(markup, index === 2 ? use.indexOf('[ref][]') + 7 : 0)
    assert.equal(trace.via, 'reference')
    assert.deepEqual(trace.use, { from, to: from + markup.length })
    assert.equal(found[index].token.attrGet('href'), 'Target.md')
    assert.equal(found[index].token.attrGet('title'), 'first')
    assert.equal(trace.destination, found[0].trace.destination)
  }
  assert.deepEqual(found[0].trace.destination, { blockIndex: 0, blockId: 'definition', from: definition.indexOf('Target.md'),
    to: definition.indexOf('Target.md') + 9, raw: 'Target.md', syntax: 'markdown' })
})

test('equal href definitions retain distinct source keys and group definitions override another parse external objects', () => {
  const blocks = [block('alpha', '[a]: Same.md'), block('beta', '[b]: Same.md'), block('use', '[a] [b] [outside]')]
  const context = createMarkdownLinkProvenanceContext(blocks)
  const found = links(context.parseInline(2, { A: { href: 'Hijack.md', title: 'wrong' }, OUTSIDE: { href: 'Same.md', title: '' } }))
  assert.equal(found.length, 3)
  assert.equal(found[0].token.attrGet('href'), 'Same.md')
  assert.equal(found[0].trace.destination?.blockId, 'alpha')
  assert.equal(found[1].trace.destination?.blockId, 'beta')
  assert.notEqual(found[0].trace.destination, found[1].trace.destination)
  assert.deepEqual(found[2].trace, { use: { from: 8, to: 17 }, via: 'reference', destination: null, reason: 'unproven-reference' })
})

test('inactive invalid and fenced definitions cannot manufacture a reference source', () => {
  const blocks = [block('code', '[ref]: Hidden.md', 'code'), block('invalid', '[ref]: Bad.md trailing text'),
    block('active', '[ref]: Good.md'), block('duplicate', '[ref]: Good.md'), block('uses', '[ref]')]
  const found = links(createMarkdownLinkProvenanceContext(blocks).parseInline(4))
  assert.equal(found.length, 1)
  assert.equal(found[0].token.attrGet('href'), 'Good.md')
  assert.equal(found[0].trace.destination?.blockIndex, 2)
  assert.equal(found[0].trace.destination?.blockId, 'active')
})

test('a real empty reference definition owns the exact zero-width point for every use', () => {
  const content = '[r]: <>\r\n', context = createMarkdownLinkProvenanceContext([block('empty-ref', content), block('uses', '[r] [r]')])
  const found = links(context.parseInline(1)), point = content.indexOf('<>') + 1
  assert.equal(found.length, 2)
  assert.equal(found[0].trace.destination, found[1].trace.destination)
  assert.deepEqual(found[0].trace.destination, { blockIndex: 0, blockId: 'empty-ref', from: point, to: point, raw: '', syntax: 'markdown' })
})

test('native finite literal projections map active child definitions back past encoded closing text', () => {
  const definition = '</aside>\r\n\r\n[r]: Target.md', title = '[title][r] </summary> 😀'
  const blocks = [block('owner', title, 'toggle'), block('definition', definition, 'paragraph', 1),
    block('use', '[body][r]', 'paragraph', 1)]
  const context = createMarkdownLinkProvenanceContext(blocks), titleLinks = links(context.parseInline(0)), bodyLinks = links(context.parseInline(2))
  assert.equal(titleLinks.length, 1)
  assert.equal(bodyLinks.length, 1)
  const from = definition.indexOf('Target.md')
  assert.deepEqual(titleLinks[0].trace.destination, { blockIndex: 1, blockId: 'definition', from, to: from + 9, raw: 'Target.md', syntax: 'markdown' })
  assert.equal(bodyLinks[0].trace.destination, titleLinks[0].trace.destination)
  assert.deepEqual(titleLinks[0].trace.use, { from: 0, to: '[title][r]'.length })
})

test('quote and list prefixes use parser projections for the active whole-forest definition', () => {
  for (const type of ['quote', 'bulleted-list']) {
    const definition = '[r]: Target.md', context = createMarkdownLinkProvenanceContext([block('definition', definition, type), block('use', '[r]')])
    const found = links(context.parseInline(1))
    assert.equal(found.length, 1)
    assert.deepEqual(found[0].trace.destination, { blockIndex: 0, blockId: 'definition', from: definition.indexOf('Target.md'),
      to: definition.length, raw: 'Target.md', syntax: 'markdown' }, type)
  }
})

test('safe HTML ties each actual anchor token to its own attribute and full nested element span', () => {
  const first = '<a href="Same&#46;md">one</a>', second = "<a href='Same.md'>two</a>"
  const content = `😀\r\n<u>${first} ${second}</u>`
  const found = links(createMarkdownLinkProvenanceContext([block('html', content)]).parseInline(0))
  assert.equal(found.length, 2)
  for (const [index, [markup, raw]] of [[first, 'Same&#46;md'], [second, 'Same.md']].entries()) {
    const from = content.indexOf(raw)
    assert.equal(found[index].token.attrGet('href'), 'Same.md')
    assert.deepEqual(found[index].trace.use, { from: content.indexOf(markup), to: content.indexOf(markup) + markup.length })
    assert.deepEqual(found[index].trace.destination, { blockIndex: 0, blockId: 'html', from, to: from + raw.length, raw, syntax: 'markdown' })
  }
  const rejected = links(createMarkdownLinkProvenanceContext([block('rejected', '<a href="">empty</a> <a href="javascript:alert(1)">unsafe</a>')]).parseInline(0))
  assert.equal(rejected.length, 0, 'HTML empty or unsafe hrefs are not successful link_open rules')
})

test('successful angle and protocol autolinks expose actual spans while missing core fuzzy proof stays explicit', () => {
  const content = '<https://example.com/a> https://example.com/b www.example.com'
  const found = links(createMarkdownLinkProvenanceContext([block('auto', content)]).parseInline(0))
  assert.equal(found.length, 3)
  for (const [index, raw] of ['https://example.com/a', 'https://example.com/b'].entries()) {
    const from = content.indexOf(raw)
    assert.deepEqual(found[index].trace.destination, { blockIndex: 0, blockId: 'auto', from, to: from + raw.length, raw, syntax: 'markdown' })
  }
  assert.deepEqual(found[2].trace, { use: null, via: 'direct', destination: null, reason: 'unmapped-destination' })
})

test('code, escapes, math and image alt text keep the shared parser exclusions', () => {
  const content = '`[code](Code.md)` \\[escaped](Escaped.md) $[math](Math.md)$ ![alt [fake](Fake.md)](Image.png) [actual](Actual.md)'
  const found = links(createMarkdownLinkProvenanceContext([block('literal', content)]).parseInline(0))
  assert.equal(found.length, 1)
  assert.equal(found[0].trace.destination?.raw, 'Actual.md')
})

test('cold contexts retain their captured block contents and reject nonexistent indices', () => {
  const blocks = [block('definition', '[r]: Old.md'), block('use', '[r]')], context = createMarkdownLinkProvenanceContext(blocks)
  blocks[0].content = '[r]: New.md'; blocks[1].content = '[changed](New.md)'
  const found = links(context.parseInline(1))
  assert.equal(found[0].token.attrGet('href'), 'Old.md')
  assert.equal(found[0].trace.destination?.raw, 'Old.md')
  for (const index of [-1, 2, 0.5, NaN]) assert.throws(() => context.parseInline(index), /block index/)
})

test('normal rendering allocates no provenance source maps and opt-in observation preserves rendering and existing source captures', () => {
  const source = '[one](One.md) <u><a href="Two.md">two</a></u>\r\n\r\n[r]: Three.md\r\n\r\n[r]'
  const normal: MarkdownEnvironment = {}, expected = markdownEngine.render(source, normal)
  assert.equal(normal.markdownSourceLinks, undefined)
  const observer: MarkdownLinkProvenanceObserver = { definition() {}, link() {} }
  assert.equal(markdownEngine.render(source, { markdownLinkProvenance: observer }), expected)
  const legacy: MarkdownEnvironment = { captureSourceLinks: true }, observed: MarkdownEnvironment = { captureSourceLinks: true, markdownLinkProvenance: observer }
  assert.equal(markdownEngine.render(source, legacy), markdownEngine.render(source, observed))
  assert.deepEqual(capturedMarkdownSourceLinks(legacy), capturedMarkdownSourceLinks(observed))
  const tokens = markdownEngine.parse(source, {})
  const visit = (items: MarkdownToken[]) => {
    for (const token of items) { assert.equal(token.meta?.sourceLinkProvenance, undefined); assert.equal(token.meta?.sourceMap, undefined); if (token.children) visit(token.children) }
  }
  visit(tokens)
})
