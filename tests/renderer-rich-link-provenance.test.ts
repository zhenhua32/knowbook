import assert from 'node:assert/strict'
import test from 'node:test'
import { DOMParser, DOMSerializer, Fragment, type Mark, type Node } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { collectMarkdownSourceLinks } from '../src/shared/markdownLinks'
import { markdownEngine } from '../src/shared/markdownEngine'
import { richTextSchema as schema } from '../src/renderer/src/rich-text/schema'
import { draftBlocksToRichDoc, reconcileRichTextBlockIds, richDocToDraftBlocks, richTextInlineFingerprint,
  serializeRichTextInline, serializeRichTextInlineHtml, serializeRichTextInlineHtmlWithLinkTrace,
  serializeRichTextInlineWithLinkTrace } from '../src/renderer/src/rich-text/model'
import { RICH_LINK_OCCURRENCE_ATTR, richLinkOccurrence, withRichLinkOccurrence,
  type RichInlineLinkSerialization } from '../src/renderer/src/rich-text/linkProvenance'

const draft = (content = ''): DocumentBlockDraft => ({ id: ' __proto__:正文 ', type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null, tags: ['保留'], highlight: 'yellow' })
function link(href = 'Target.md', token: string | null = null, title: string | null = null): Mark {
  return withRichLinkOccurrence(schema.marks.link.create({ href, title }), token)
}
function block(children: Node[], source = ''): Node {
  return schema.nodes.text_block.create({ block: draft(source), originalInline: 'changed' }, children)
}
function exact(result: RichInlineLinkSerialization): void {
  for (const destination of result.linkDestinations) {
    assert.equal(result.content.slice(destination.from, destination.to), destination.raw)
    assert.equal(destination.to - destination.from, destination.raw.length)
    assert.equal(destination.syntax, 'markdown')
    assert.equal(Number.isSafeInteger(destination.from), true)
  }
}

test('runtime tokens keep adjacent equal-href occurrence boundaries without changing ordinary null-token marks', () => {
  const ordinary = block([schema.text('First', [link()]), schema.text('Second', [link()])])
  assert.equal(ordinary.childCount, 1, 'Ordinary links retain their existing PM merge behavior')
  const traced = block([schema.text('First', [link('Target.md', 'source-A')]), schema.text('Second', [link('Target.md', 'source-B')])])
  assert.equal(traced.childCount, 2)
  const result = serializeRichTextInlineWithLinkTrace(traced)
  assert.equal(result.content, '[First](Target.md)[Second](Target.md)')
  assert.equal(result.content, serializeRichTextInline(traced))
  assert.deepEqual(result.linkDestinations.map(item => [item.token, item.occurrenceIndex, item.raw]), [
    ['source-A', 0, 'Target.md'], ['source-B', 0, 'Target.md']
  ])
  exact(result)
  assert.equal(serializeRichTextInline(ordinary), '[FirstSecond](Target.md)')
  assert.equal(serializeRichTextInlineWithLinkTrace(ordinary).linkDestinations[0].token, null)
})

test('runtime tokens never enter DOM, external DOM parsing, Markdown, persisted drafts or fingerprints', () => {
  const source = '[First](Target.md)[Second](Target.md)', original = draftBlocksToRichDoc([draft(source)]).firstChild!
  const traced = original.copy(Fragment.fromArray([
    schema.text('First', [link('Target.md', 'SECRET-A')]), schema.text('Second', [link('Target.md', 'SECRET-B')])
  ]))
  assert.equal(richTextInlineFingerprint(traced), richTextInlineFingerprint(original), 'A token-only text split is not a persisted inline change')
  assert.deepEqual(richDocToDraftBlocks(schema.nodes.doc.create(null, traced)), [draft(source)])
  assert.equal(JSON.stringify(richDocToDraftBlocks(schema.nodes.doc.create(null, traced))).includes('SECRET'), false)
  const dom = new JSDOM('')
  try {
    const serialized = DOMSerializer.fromSchema(schema).serializeFragment(traced.content, { document: dom.window.document })
    const host = dom.window.document.createElement('div')
    host.append(serialized)
    assert.equal(host.querySelectorAll('a').length, 2)
    assert.equal(host.innerHTML.includes('SECRET'), false)
    assert.equal(host.innerHTML.includes(RICH_LINK_OCCURRENCE_ATTR), false)
    host.querySelector('a')!.setAttribute(RICH_LINK_OCCURRENCE_ATTR, 'forged-external')
    const parsed = DOMParser.fromSchema(schema).parse(host)
    parsed.descendants(node => {
      for (const mark of node.marks) if (mark.type.name === 'link') assert.equal(richLinkOccurrence(mark), null)
    })
  } finally { dom.window.close() }
  const hrefChanged = traced.copy(Fragment.fromArray([schema.text('FirstSecond', [link('Other.md', 'SECRET-A')])]))
  const titleChanged = traced.copy(Fragment.fromArray([schema.text('FirstSecond', [link('Target.md', 'SECRET-A', 'different title')])]))
  assert.notEqual(richTextInlineFingerprint(hrefChanged), richTextInlineFingerprint(original))
  assert.notEqual(richTextInlineFingerprint(titleChanged), richTextInlineFingerprint(original), 'Only the private token is excluded')
})

test('Markdown trace records actual escaped href writes rather than matching equal URL text in labels or titles', () => {
  const href = 'Target(a).md?x=1&y=2#中文', title = 'Title "Target(a).md" 😀'
  const input = block([
    schema.text('Target(a).md plain before '),
    schema.text('😀 Target(a).md label', [link(href, 'source', title), schema.marks.strong.create()]),
    schema.text(' Target(a).md plain after')
  ])
  const result = serializeRichTextInlineWithLinkTrace(input), escaped = href.replace(/[\(\)"]/g, '\\$&')
  assert.equal(result.content, serializeRichTextInline(input))
  assert.equal(result.linkDestinations.length, 1)
  assert.equal(result.linkDestinations[0].raw, escaped)
  assert.equal(result.linkDestinations[0].href, href)
  assert.equal(result.linkDestinations[0].format, 'markdown')
  assert.equal(result.content.slice(result.linkDestinations[0].from - 2, result.linkDestinations[0].from), '](')
  assert.ok(result.content.includes('\\"Target(a).md\\"'))
  exact(result)
  const actual = collectMarkdownSourceLinks(result.content).filter(item => item.kind !== 'image')
  assert.deepEqual(actual.map(item => [item.start, item.end]), result.linkDestinations.map(item => [item.from, item.to]))
})

test('Markdown empty hrefs keep real zero-width positions before titles and after UTF16 labels', () => {
  for (const title of [null, '标题 "😀"']) {
    const input = block([schema.text('🙂 prefix '), schema.text('中文😀', [link('', 'empty', title)])])
    const result = serializeRichTextInlineWithLinkTrace(input), destination = result.linkDestinations[0]
    assert.equal(result.content, serializeRichTextInline(input))
    assert.equal(destination.from, destination.to)
    assert.equal(destination.raw, '')
    if (title) assert.equal(result.content.slice(destination.from - 3, destination.from + 1), '](<>')
    else assert.equal(result.content.slice(destination.from - 2, destination.from), '](')
    assert.equal(destination.href, '')
    exact(result)
    const actual = collectMarkdownSourceLinks(result.content).filter(item => item.kind !== 'image')
    assert.deepEqual(actual.map(item => [item.start, item.end]), [[destination.from, destination.to]])
    assert.deepEqual(actual.map(item => item.url), [''], 'The title is never reinterpreted as a quoted URL')
    const links = markdownEngine.parseInline(result.content, {})[0].children!.filter(token => token.type === 'link_open')
    assert.equal(links.length, 1)
    assert.equal(links[0].attrGet('href'), '')
    assert.equal(links[0].attrGet('title'), title)
  }
})

test('ordinary formatting of an empty-href titled link preserves its actual href and escaped emoji title', () => {
  const title = '标题 "quoted" 🙂', source = `[中文😀](<> "${title.replace(/"/g, '\\"')}")`
  const initial = draftBlocksToRichDoc([draft(source)])
  assert.equal(initial.firstChild!.type.name, 'text_block')
  assert.deepEqual(richDocToDraftBlocks(initial), [draft(source)], 'Untouched source bytes remain unchanged')
  const state = EditorState.create({ doc: initial })
  const changed = state.tr.addMark(1, 1 + initial.firstChild!.content.size, schema.marks.strong.create()).doc
  const persisted = richDocToDraftBlocks(changed), content = persisted[0].content
  assert.deepEqual({ ...persisted[0], content: source }, draft(source))
  assert.ok(content.includes('](<> "标题 \\"quoted\\" 🙂")'))
  const links = markdownEngine.parseInline(content, {})[0].children!.filter(token => token.type === 'link_open')
  assert.equal(links.length, 1)
  assert.equal(links[0].attrGet('href'), '')
  assert.equal(links[0].attrGet('title'), title)
  const restored = draftBlocksToRichDoc(persisted)
  assert.equal(richTextInlineFingerprint(restored.firstChild!), richTextInlineFingerprint(changed.firstChild!))
  const traced = serializeRichTextInlineWithLinkTrace(changed.firstChild!), destination = traced.linkDestinations[0]
  assert.equal(traced.content, content)
  assert.equal(destination.from, destination.to)
  assert.equal(destination.raw, '')
  assert.equal(traced.content.slice(destination.from - 3, destination.from + 1), '](<>')
  const actual = collectMarkdownSourceLinks(content).filter(item => item.kind !== 'image')
  assert.deepEqual(actual.map(item => [item.url, item.start, item.end]), [['', destination.from, destination.to]])
  exact(traced)
})

test('separate Markdown emissions of one token receive mechanical occurrence indexes', () => {
  const shared = link('Target.md', 'shared-source'), input = block([
    schema.text('first', [shared]), schema.text(' gap '), schema.text('second', [shared])
  ])
  const result = serializeRichTextInlineWithLinkTrace(input)
  assert.equal(result.content, serializeRichTextInline(input))
  assert.equal(result.content, '[first](Target.md) gap [second](Target.md)')
  assert.deepEqual(result.linkDestinations.map(item => [item.token, item.occurrenceIndex]), [['shared-source', 0], ['shared-source', 1]])
  exact(result)
})

test('HTML trace records escaped attribute bytes independently from rendered text offsets and preserves old serializer output', () => {
  const href = 'Target.md?x=1&quoted="two"&tag=<中文>\r\n#end', title = '标题 "href & Target.md"'
  const input = block([schema.text('🙂 Target.md plain '), schema.text('styled <&>\r\n', [link(href, 'html', title), schema.marks.underline.create()])])
  const ordinary = serializeRichTextInlineHtml(input), result = serializeRichTextInlineHtmlWithLinkTrace(input)
  assert.deepEqual({ content: result.content, startOffsets: result.startOffsets, endOffsets: result.endOffsets }, ordinary)
  assert.equal(result.content, serializeRichTextInline(input))
  const destination = result.linkDestinations[0]
  assert.equal(destination.format, 'html')
  assert.equal(destination.raw, 'Target.md?x=1&amp;quoted=&quot;two&quot;&amp;tag=&lt;中文&gt;&#13;&#10;#end')
  assert.equal(destination.href, href)
  assert.equal(result.content.slice(destination.from - 9, destination.from), '<a href="')
  assert.ok(result.startOffsets['🙂 Target.md plain '.length] > destination.to, 'Rendered text offsets begin after href and title markup')
  const dom = JSDOM.fragment(result.content)
  assert.equal(dom.querySelector('a')!.getAttribute('href'), href)
  assert.equal(dom.querySelector('a')!.getAttribute('title'), title)
  exact(result)
})

test('one runtime source can produce several exact HTML href emissions without assigning semantic copy authority', () => {
  const shared = link('Target.md', 'one-source')
  const input = block([
    schema.text('First', [shared, schema.marks.underline.create()]),
    schema.text('Second', [shared, schema.marks.underline.create(), schema.marks.strong.create()]),
    schema.text('Third', [link('Target.md', 'other-source'), schema.marks.underline.create()]),
    schema.text('Fourth', [shared, schema.marks.underline.create()])
  ])
  const result = serializeRichTextInlineWithLinkTrace(input)
  assert.equal(result.content, serializeRichTextInline(input))
  assert.deepEqual(result.linkDestinations.map(item => [item.token, item.occurrenceIndex]), [
    ['one-source', 0], ['one-source', 1], ['other-source', 0], ['one-source', 2]
  ])
  assert.ok(result.linkDestinations.every(item => !Object.hasOwn(item, 'target') && !Object.hasOwn(item, 'emission')))
  assert.equal(JSDOM.fragment(result.content).querySelectorAll('a').length, 4)
  exact(result)
})

test('empty HTML hrefs retain their exact attribute point and text selection offsets', () => {
  const input = block([schema.text('😀', [link('', 'empty-html', 'title'), schema.marks.underline.create()])])
  const ordinary = serializeRichTextInlineHtml(input), result = serializeRichTextInlineHtmlWithLinkTrace(input), destination = result.linkDestinations[0]
  assert.equal(destination.from, destination.to)
  assert.equal(destination.raw, '')
  assert.equal(result.content.slice(destination.from - 9, destination.from + 1), '<a href=""')
  assert.deepEqual(result.startOffsets, ordinary.startOffsets)
  assert.deepEqual(result.endOffsets, ordinary.endOffsets)
  exact(result)
})

test('autolinks and preceding literal exclamation escaping use the original Markdown writer positions', () => {
  const href = 'https://example.com/a(b)?x=1&y=2', input = block([
    schema.text('literal !'), schema.text('label', [link('Target.md', 'markdown')]), schema.text(' '), schema.text(href, [link(href, 'autolink')])
  ])
  const result = serializeRichTextInlineWithLinkTrace(input)
  assert.equal(result.content, serializeRichTextInline(input))
  assert.ok(result.content.includes('\\![label](Target.md)'))
  assert.ok(result.content.endsWith(`<${href}>`))
  assert.deepEqual(result.linkDestinations.map(item => [item.token, item.format, item.raw]), [
    ['markdown', 'markdown', 'Target.md'], ['autolink', 'autolink', href]
  ])
  const auto = result.linkDestinations[1]
  assert.equal(result.content[auto.from - 1], '<')
  assert.equal(result.content[auto.to], '>')
  exact(result)
  const actual = collectMarkdownSourceLinks(result.content).filter(item => item.kind !== 'image')
  assert.deepEqual(actual.map(item => [item.start, item.end]), result.linkDestinations.map(item => [item.from, item.to]))
})

test('actual PM split/join and ID repair preserve runtime occurrence tokens without putting them into persisted metadata', () => {
  const input = block([schema.text('ABCD', [link('Target.md', 'surviving-source')])])
  const state = EditorState.create({ doc: schema.nodes.doc.create(null, input) })
  const split = reconcileRichTextBlockIds(state.tr.split(3).doc)
  assert.equal(split.childCount, 2)
  assert.notEqual(split.child(0).attrs.block.id, split.child(1).attrs.block.id)
  const pieces = [split.child(0), split.child(1)].map(node => serializeRichTextInlineWithLinkTrace(node))
  assert.deepEqual(pieces.map(piece => piece.linkDestinations.map(item => item.token)), [['surviving-source'], ['surviving-source']])
  assert.deepEqual(pieces.map(piece => piece.content), ['[AB](Target.md)', '[CD](Target.md)'])
  const joined = EditorState.create({ doc: split }).tr.join(split.child(0).nodeSize).doc
  assert.equal(joined.childCount, 1)
  const result = serializeRichTextInlineWithLinkTrace(joined.firstChild!)
  assert.equal(result.content, '[ABCD](Target.md)')
  assert.equal(result.linkDestinations[0].token, 'surviving-source')
  const persisted = richDocToDraftBlocks(joined)
  assert.equal(persisted[0].content, result.content)
  assert.equal(JSON.stringify(persisted).includes(RICH_LINK_OCCURRENCE_ATTR), false)
  assert.equal(JSON.stringify(persisted).includes('surviving-source'), false)
  exact(result)
})

test('invalid runtime tokens fail closed and changing a token cannot hide real href, title or presentation changes', () => {
  const original = link('Target.md', 'original', 'title')
  assert.equal(withRichLinkOccurrence(original, 'original'), original)
  assert.equal(richLinkOccurrence(withRichLinkOccurrence(original, null)), null)
  for (const token of ['', ' \t\r\n ', 3, {}]) {
    assert.throws(() => withRichLinkOccurrence(original, token as string), /临时来源标识/)
    const invalid = schema.marks.link.create({ href: 'Target.md', [RICH_LINK_OCCURRENCE_ATTR]: token })
    assert.throws(() => serializeRichTextInlineWithLinkTrace(block([schema.text('label', [invalid])])), /临时来源标识/)
  }
  assert.throws(() => richLinkOccurrence(schema.marks.strong.create()), /真实链接/)
  assert.throws(() => withRichLinkOccurrence(schema.marks.strong.create(), 'token'), /真实链接/)
  const first = block([schema.text('label', [original])])
  const onlyToken = block([schema.text('label', [withRichLinkOccurrence(original, 'next')])])
  const styled = block([schema.text('label', [withRichLinkOccurrence(original, 'next'), schema.marks.strong.create()])])
  assert.equal(richTextInlineFingerprint(first), richTextInlineFingerprint(onlyToken))
  assert.notEqual(richTextInlineFingerprint(first), richTextInlineFingerprint(styled))
})
