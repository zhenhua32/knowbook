import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { parseMarkdownBackupDocument, parseMarkdownBlocks, renderMarkdownFrontmatter, serializeBlocksToMarkdown } from '../src/shared/markdown'
import { markdownEngine } from '../src/shared/markdownEngine'
import { collectMarkdownDestinations, rewriteMarkdownDestinations } from '../src/shared/markdownLinks'
import { collectMarkdownAnchors } from '../src/shared/markdownAnchors'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets, rewriteDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { parsePastedMarkdown, getMarkdownShortcut } from '../src/renderer/src/utils/markdownInput'
import { createMarkdownSourceDraft, replaceMarkdownSource, markdownSourceDraftToBlocks } from '../src/renderer/src/utils/markdownSourceDraft'
import { formatMarkdownSelection } from '../src/renderer/src/utils/markdownFormatting'
import { MarkdownContent } from '../src/renderer/src/components/MarkdownContent'
import { documentYaml, commonHtml } from './fixtures/markdown-frontmatter-html'

test('opaque YAML survives paste, source edits, formatting and three plain/backup cycles', () => {
  let source = documentYaml + '\n\n# Title\n\nBody'
  for (let cycle = 0; cycle < 3; cycle++) {
    const parsed = parseMarkdownBackupDocument(source)
    assert.equal(parsed.isKnowbookBackup, false)
    assert.equal(parsed.blocks[0].type, 'frontmatter')
    assert.equal(parsed.blocks[0].content, documentYaml)
    assert.deepEqual(collectMarkdownDestinations(source), [])
    const backup = renderMarkdownFrontmatter({ id: 'internal', path: 'Root/Title' }) + serializeBlocksToMarkdown(parsed.blocks, { includeBlockMetadata: true })
    assert.deepEqual(collectMarkdownDestinations(backup), [])
    const restored = parseMarkdownBackupDocument(backup)
    assert.equal(restored.isKnowbookBackup, true)
    assert.deepEqual(restored.blocks, parsed.blocks)
    source = serializeBlocksToMarkdown(restored.blocks)
  }
  const blocks = parsePastedMarkdown(source).map((block, index) => ({ ...block, id: `id-${index}` }))
  assert.equal(getMarkdownShortcut(blocks[0], documentYaml), null)
  const draft = createMarkdownSourceDraft(blocks), from = draft.source.indexOf('Alice')
  const changed = markdownSourceDraftToBlocks(replaceMarkdownSource(draft, { from, to: from + 5, insert: '李华' }))
  assert.equal(changed[0].id, 'id-0')
  assert.equal(changed[0].type, 'frontmatter')
  assert.equal(changed[0].content, documentYaml.replace('Alice', '李华'))
  assert.equal(formatMarkdownSelection(source, from, from + 5, 'bold').content, source)
  assert.ok(formatMarkdownSelection(source, 0, source.length, 'bold').content.startsWith(documentYaml + '\n\n'))
  assert.equal(parseMarkdownBlocks('---\nordinary text\n---')[0].type, 'divider')
  assert.equal(parseMarkdownBlocks(documentYaml.replaceAll('\n', '\r\n'))[0].content, documentYaml)
  assert.equal(parseMarkdownBlocks(documentYaml.replace(/---$/, '...'))[0].type, 'frontmatter')
})

test('supported HTML has consistent structure, exact link positions and stable source round trips', () => {
  const render = (source: string) => JSDOM.fragment(markdownEngine.render(source))
  let source = commonHtml
  for (let cycle = 0; cycle < 3; cycle++) {
    const tree = render(source)
    assert.equal(tree.querySelector('p')?.textContent, 'Press Ctrl + SH2O and x2.')
    assert.equal(tree.querySelectorAll('kbd').length, 2)
    assert.equal(tree.querySelector('sub')?.textContent, '2')
    assert.equal(tree.querySelector('sup')?.textContent, '2')
    assert.equal(tree.querySelector('details summary strong')?.textContent, '说明')
    assert.equal(tree.querySelector('details h2')?.textContent, '折叠内容')
    assert.equal(tree.querySelector('details input')?.hasAttribute('checked'), true)
    assert.equal(tree.querySelector('img')?.getAttribute('width'), '240')
    assert.equal(tree.querySelector('img')?.getAttribute('alt'), '示例图片')
    assert.equal(tree.querySelector('a[id]')?.id, '中文-anchor')
    assert.equal(tree.querySelector('details p:last-child a')?.getAttribute('href'), 'Other.md#target')
    const blocks = parseMarkdownBlocks(source)
    assert.equal(blocks.filter((block) => block.type === 'html').length, 1)
    const exported = serializeBlocksToMarkdown(blocks)
    assert.deepEqual(parseMarkdownBlocks(serializeBlocksToMarkdown(blocks, { includeBlockMetadata: true })), blocks)
    if (cycle > 0) assert.equal(exported, source)
    source = exported
  }
  const links = collectMarkdownDestinations(source)
  const html = links.filter((link) => link.syntax === 'html')
  assert.deepEqual(html.map((link) => link.url), ['assets/image.png', 'Other.md?view=1&lang=zh#target'])
  assert.deepEqual(html.map((link) => source.slice(link.start, link.end)), ['assets/image.png', 'Other.md?view=1&amp;lang=zh#target'])
  const replacement = 'New & "quoted".md?a=1&b=2#target'
  const changed = rewriteMarkdownDestinations(source, (link) => link.syntax === 'html' && link.kind === 'link' ? replacement : null)
  assert.equal(collectMarkdownDestinations(changed).find((link) => link.syntax === 'html' && link.kind === 'link')?.url, replacement)
  const blocks = parseMarkdownBlocks(source).map((block, index) => ({ ...block, id: `html-${index}` }))
  assert.equal(collectDocumentMarkdownLinks(blocks).filter((link) => link.kind !== 'wiki' && link.syntax === 'html').length, 2)
  assert.equal(collectMarkdownAnchors('Title', blocks).find((anchor) => anchor.slug === '中文-anchor')?.blockId, 'html-1')
  assert.ok(getMarkdownHeadingTargets(blocks, 'Title').some((target) => target.slug === '中文-anchor'))
  const rewritten = rewriteDocumentMarkdownLinks(blocks, (link) => link.kind !== 'wiki' && link.syntax === 'html' && link.kind === 'link' ? replacement : null)
  assert.equal(collectDocumentMarkdownLinks(rewritten).find((link) => link.kind !== 'wiki' && link.syntax === 'html' && link.kind === 'link')?.url, replacement)
  const table = '| Link | Other |\n| - | - |\n| <a href="Other.md?q=a\\|b&amp;x=1">Go</a> | Keep |'
  const moved = rewriteDocumentMarkdownLinks(parseMarkdownBlocks(table), () => 'Moved.md?q=a|b&x=1')
  const tableTree = render(serializeBlocksToMarkdown(moved))
  assert.equal(tableTree.querySelectorAll('tbody td').length, 2)
  assert.equal(tableTree.querySelector('td a')?.getAttribute('href'), 'Moved.md?q=a|b&x=1')
})

test('HTML attributes and malformed/foreign markup cannot introduce executable DOM', () => {
  const input = '<details open onclick="alert(1)" style="position:fixed"><summary>Safe</summary>\n\n'
    + '<img src="https://example.test/x.png" width="240" height="oops" onerror="alert(1)" srcset="https://bad.test/a 1x">\n\n'
    + '<a href="java&#x73;cript:alert(1)" id="__proto__">bad</a> '
    + '<a href="&#9;JaVaScRiPt:alert(1)">bad2</a> <img src="data:image/svg+xml,test"> '
    + '<svg onload="alert(1)"><script>alert(1)</script></svg>\n\n</details>'
  for (const rendered of [markdownEngine.render(input), renderToStaticMarkup(<MarkdownContent content={input} />)]) {
    const tree = JSDOM.fragment(rendered)
    assert.equal(tree.querySelectorAll('script, svg, iframe, style').length, 0)
    assert.equal(tree.querySelectorAll('[onclick], [onerror], [onload], [style], [srcset]').length, 0)
    assert.equal(tree.querySelectorAll('[href^="javascript:"], [src^="data:"]').length, 0)
    assert.equal(tree.querySelector('img')?.getAttribute('width'), '240')
    assert.equal(tree.querySelector('img')?.hasAttribute('height'), false)
    assert.equal(tree.querySelector('details')?.hasAttribute('open'), true)
  }
  assert.deepEqual(collectMarkdownDestinations('`<img src="hidden.png">`\n\n```html\n<a href="hidden.md">X</a>\n```'), [])
  const tree = JSDOM.fragment(renderToStaticMarkup(<MarkdownContent content={'<kbd>Ctrl</kbd><br><sub>2</sub><sup>3</sup> <a id="constructor"></a>'} />))
  assert.equal(tree.querySelectorAll('kbd, br, sub, sup').length, 4)
  assert.equal(tree.querySelector('[data-markdown-anchor]')?.getAttribute('data-markdown-anchor'), 'constructor')
  assert.equal(tree.querySelector('#constructor'), null)
})

test('details preserve container boundaries, nested content and literal closing tags in code', () => {
  const body = '<details>\n<summary>Outer</summary>\n\n```html\n</details>\n```\n\n<details open><summary>Inner</summary>\n\n<a href="Other.md">Link</a>\n\n</details>\n\n</details>'
  for (const source of [body, body.split('\n').map((line) => '> ' + line).join('\n'), '- ' + body.replaceAll('\n', '\n  ')]) {
    const html = markdownEngine.render(source), tree = JSDOM.fragment(html)
    assert.equal(tree.querySelector('details > summary')?.textContent, 'Outer')
    assert.equal(tree.querySelector('details details > summary')?.textContent, 'Inner')
    assert.equal(tree.querySelector('pre code')?.textContent, '</details>\n')
    assert.equal(tree.querySelectorAll('blockquote').length, source.startsWith('>') ? 1 : 0)
    const links = collectMarkdownDestinations(source)
    assert.equal(links.length, 1)
    assert.equal(source.slice(links[0].start, links[0].end), 'Other.md')
    const changed = rewriteMarkdownDestinations(source, () => 'Changed.md')
    assert.equal(collectMarkdownDestinations(changed)[0].url, 'Changed.md')
    assert.equal(markdownEngine.render(serializeBlocksToMarkdown(parseMarkdownBlocks(source))), html)
  }
})
