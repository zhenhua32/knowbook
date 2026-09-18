import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownContent, MarkdownInline, MarkdownReferencesContext, renderMarkdownNodes } from '../src/renderer/src/components/MarkdownContent.tsx'
import { MarkdownTablePreview } from '../src/renderer/src/components/MarkdownTablePreview.tsx'
import { BlockRichMediaPreview } from '../src/renderer/src/components/BlockRichMediaPreview.tsx'
import { DocumentOutlinePanel } from '../src/renderer/src/components/DocumentOutlinePanel.tsx'
import { collectMarkdownReferences, markdownEngine, markdownTokenTree } from '../src/shared/markdownEngine.ts'
import { extractBlockRichMedia } from '../src/renderer/src/utils/blockRichMedia.ts'
import { getActiveUiText } from '../src/renderer/src/i18n.ts'
import { renderInlineContent } from '../src/renderer/src/components/InlineContentRenderer.tsx'

test('inline rendering handles delimiter nesting, escapes, entities and multi-backtick spans', () => {
  const html = renderToStaticMarkup(<MarkdownInline content={'__bold__ **bold *italic*** ~~gone~~ \\*literal\\* ``a ` b`` &amp;'} />)
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /<strong>bold <em>italic<\/em><\/strong>/)
  assert.match(html, /<del>gone<\/del>/)
  assert.match(html, /\*literal\*/)
  assert.match(html, /<code[^>]*>a ` b<\/code>/)
  assert.doesNotMatch(html, /&amp;amp;/)
  assert.equal(renderToStaticMarkup(<MarkdownInline content="snake_case_word" />), 'snake_case_word')
})

test('reading preserves soft/hard breaks and nested quotes without rendering raw HTML', () => {
  const html = renderToStaticMarkup(<MarkdownContent content={'line one\nline two  \nhard break\n\n> outer\n>\n> > inner\n\n<img src=x onerror=alert(1)>'} />)
  assert.match(html, /line one\nline two<br\/>hard break/)
  assert.equal((html.match(/<blockquote>/g) ?? []).length, 2)
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<img|<script/)
})

test('body, tables and media resolve the same document-wide reference definitions', () => {
  const references = collectMarkdownReferences('[link]: https://example.com/path_(one) "label"\n[img]: https://example.com/img.png')
  const html = renderToStaticMarkup(<MarkdownReferencesContext.Provider value={references}>
    <MarkdownContent content="[**Link**][link]" />
    <MarkdownTablePreview content={'| Header | Value |\n| - | - |\n| __bold__ | [Link][link] |'} label="table" />
    <BlockRichMediaPreview content="![Image][img]" ui={getActiveUiText()} />
  </MarkdownReferencesContext.Provider>)
  assert.match(html, /title="label"><strong>Link<\/strong><\/button>/)
  assert.match(html, /<td><strong>bold<\/strong><\/td>/)
  assert.match(html, /<img[^>]+src="https:\/\/example.com\/img.png"/)
  assert.equal((html.match(/title="label"/g) ?? []).length, 2)
})

test('wiki links and media inside code or escaped syntax stay literal', () => {
  const html = renderToStaticMarkup(<MarkdownInline content={'[[Go]] `[[Code]]` \\[\\[Literal\\]\\]'} onReference={() => {}} />)
  assert.equal((html.match(/<button/g) ?? []).length, 1)
  const media = extractBlockRichMedia('`![hidden](https://example.com/a.png)`\n\n```md\n[hidden](https://example.com)\n```\n\n![shown](https://example.com/b_(1).png)')
  assert.deepEqual(media, { images: [{ alt: 'shown', url: 'https://example.com/b_(1).png' }], links: [] })
  const unsafe = renderToStaticMarkup(<MarkdownInline content={'[bad](javascript:alert(1)) ![bad](data:text/html;base64,AAAA)'} />)
  assert.doesNotMatch(unsafe, /<button|<img/)
  const legacy = renderToStaticMarkup(<>{renderInlineContent('**[[Go]]** `[[Go]]`', () => {}, [{ id: 'go', title: 'Go', path: 'Go' }])}</>)
  assert.match(legacy, /<strong><button/)
  assert.equal((legacy.match(/<button/g) ?? []).length, 1)
})

test('outline nests every heading level, including skipped levels', () => {
  const html = renderToStaticMarkup(<DocumentOutlinePanel title="Outline" emptyHeadingTitleLevel1="H1" emptyHeadingTitleLevel2="H2"
    onSelect={() => {}} items={[
      { index: 0, level: 1, title: 'Chapter' }, { index: 1, level: 3, title: 'Section' },
      { index: 2, level: 6, title: 'Detail' }, { index: 3, level: 2, title: 'Next' }
    ]} />)
  assert.match(html, /toc-entry-h3[^]*Section[^]*toc-children[^]*toc-entry-h6[^]*Detail/)
  assert.match(html, /<\/ol><\/li><li class="toc-entry toc-entry-h2"/)
})

test('nested tasks render consistently without changing reusable parser tokens', () => {
  const nodes = markdownTokenTree(markdownEngine.parse('> - [x] **Done**\n> - [ ] Next', {}))
  const before = JSON.stringify(nodes)
  const render = () => renderToStaticMarkup(<>{renderMarkdownNodes(nodes)}</>)
  const html = render()
  assert.match(html, /checked=""/)
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2)
  assert.match(html, /<strong>Done<\/strong>/)
  assert.doesNotMatch(html, /\[x\]|\[ \]/)
  assert.equal(render(), html)
  assert.equal(JSON.stringify(nodes), before)
})

test('automatic web links follow GFM path boundaries in renderer and media previews', () => {
  const content = 'www.google.com/search?q=(business))+ok www.example.com/query&hl; hello@mail+xyz.example'
  const html = renderToStaticMarkup(<MarkdownInline content={content} />)
  assert.match(html, /title="http:\/\/www.google.com\/search\?q=\(business\)\)\+ok"/)
  assert.match(html, /title="http:\/\/www.example.com\/query"/)
  assert.match(html, /&amp;hl;/)
  assert.doesNotMatch(html, /title="mailto:hello@mail\+xyz.example"/)
  assert.equal(extractBlockRichMedia('www.example.com').links[0]?.url, 'http://www.example.com/')
})
