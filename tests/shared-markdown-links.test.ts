import assert from 'node:assert/strict'
import test from 'node:test'
import { collectMarkdownDestinations, collectMarkdownSourceLinks, parseLocalMarkdownUrl, relativeMarkdownPath, resolveMarkdownDocumentPath, rewriteMarkdownDestinations } from '../src/shared/markdownLinks.ts'
import { collectMarkdownAnchors } from '../src/shared/markdownAnchors.ts'
import { markdownEngine } from '../src/shared/markdownEngine.ts'

test('Markdown destination edits preserve code, labels, titles, references, escaped parentheses and linked images', () => {
  const source = [
    '[guide](../docs/Guide.md#安装 "title")',
    '![图](<images/中文 图.png> "a title")',
    '[![nested](./a.png)](Target.md)',
    '', '[ref]: ./images/a\\(b\\).png "reference title"', '',
    '![reference][ref]',
    '| Image | Link |', '| --- | --- |', '| ![cell](cell.png) | [next](Next.md) |',
    '`![code](code.png)` and \\[escaped](escaped.md)',
    '```md', '![fenced](fenced.png)', '```',
    '', '    [indented](indented.md)',
    '', '> ![quoted](quote.png)',
    '', '- ![listed](list.png)'
  ].join('\n')
  const urls = collectMarkdownDestinations(source).map((entry) => entry.url)
  assert.deepEqual(urls, [
    '../docs/Guide.md#%E5%AE%89%E8%A3%85', 'images/%E4%B8%AD%E6%96%87%20%E5%9B%BE.png', './a.png', 'Target.md', './images/a(b).png',
    'cell.png', 'Next.md', 'quote.png', 'list.png'
  ])
  const rewritten = rewriteMarkdownDestinations(source, ({ url }) => `assets/${url.split('/').at(-1)}`)
  assert.ok(rewritten.includes('![图](<assets/%E4%B8%AD%E6%96%87%20%E5%9B%BE.png> "a title")'))
  assert.ok(rewritten.includes('[ref]: assets/a%28b%29.png "reference title"'))
  assert.ok(rewritten.includes('`![code](code.png)`'))
  assert.ok(rewritten.includes('\\[escaped](escaped.md)'))
  assert.ok(rewritten.includes('![fenced](fenced.png)'))
  assert.ok(rewritten.includes('    [indented](indented.md)'))
})

test('relative document paths decode once, normalize dots and reject root escapes and external protocols', () => {
  assert.deepEqual(resolveMarkdownDocumentPath('Docs/Start', '../参考%20资料.md#安装'), { path: '参考 资料', fragment: '安装' })
  assert.deepEqual(resolveMarkdownDocumentPath('Docs/Start', './Next.md#second'), { path: 'Docs/Next', fragment: 'second' })
  assert.deepEqual(resolveMarkdownDocumentPath('Docs/Start', '#本章'), { path: 'Docs/Start', fragment: '本章' })
  assert.deepEqual(resolveMarkdownDocumentPath('Docs/Start', '/Root.md'), { path: 'Root', fragment: '' })
  for (const url of ['../../secret.md', 'https://host/test.md', 'file:///test.md', '//host/file.md', 'javascript:alert(1)', 'image.png', '%ZZ.md', 'C%3A/secret.md']) {
    assert.equal(resolveMarkdownDocumentPath('Docs/Start', url), null, url)
  }
  assert.equal(parseLocalMarkdownUrl('./%00file.png'), null)
  assert.equal(relativeMarkdownPath('Docs/Start.md', 'Images/中文 文件.md'), '../Images/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md')
})

test('destination scanning respects paragraph boundaries and literal Markdown inside link titles', () => {
  const source = '`unclosed\n\n![real](image.png)\n\n`later`\n\n[outer](Guide.md "![literal](image.png)")\n\n[invalid]: image.png trailing text'
  const rewritten = rewriteMarkdownDestinations(source, ({ url }) => `copied/${url}`)
  assert.ok(rewritten.includes('![real](copied/image.png)'))
  assert.ok(rewritten.includes('[outer](copied/Guide.md "![literal](image.png)")'))
  assert.ok(rewritten.includes('[invalid]: image.png trailing text'))
  const withMetadata = '---\nsummary: "[metadata](image.png)"\n---\n\n![body](image.png)'
  assert.equal(rewriteMarkdownDestinations(withMetadata, () => 'copied.png'), '---\nsummary: "[metadata](image.png)"\n---\n\n![body](copied.png)')
})

test('heading anchors use displayed text, duplicate suffixes, Chinese, Setext and nested headings', () => {
  const block = (id: string, type: string, content: string) => ({ id, type, content, depth: 0, checked: false })
  const anchors = collectMarkdownAnchors('Guide', [
    block('a', 'heading-2', '**Hello** `World`!'),
    block('b', 'heading-2', 'Hello World'),
    block('c', 'heading-2', 'Hello World-1'),
    block('d', 'heading-2', '安装 &amp; 使用'),
    block('q', 'quote', '## Nested\n\nSetext\n---'),
    block('code', 'code', '# not a heading'),
    block('e', 'heading-1', 'Guide')
  ])
  assert.deepEqual(anchors.map(({ slug, blockId, headingIndex }) => [slug, blockId, headingIndex]), [
    ['guide', undefined, 0], ['hello-world', 'a', 0], ['hello-world-1', 'b', 0], ['hello-world-1-1', 'c', 0],
    ['安装--使用', 'd', 0], ['nested', 'q', 0], ['setext', 'q', 1], ['guide-1', 'e', 0]
  ])
})

test('table links are bounded by individual cells, including escaped pipes and ignored extra cells', () => {
  const source = '| A | B |\n| - | - |\n| $unclosed | [math](Math.md)$ |\n| `unclosed | [code](Code.md)` |\n| a\\|b [pipe](Pipe\\|Name.md) | [kept](Kept.md) | [ignored](Kept.md) |'
  const links = collectMarkdownDestinations(source)
  assert.deepEqual(links.map((link) => link.url), ['Math.md', 'Code.md', 'Pipe%7CName.md', 'Kept.md'])
  assert.deepEqual(links.map((link) => source.slice(link.start, link.end)), ['Math.md', 'Code.md', 'Pipe\\|Name.md', 'Kept.md'])
  const rewritten = rewriteMarkdownDestinations(source, ({ url }) => 'New/' + url)
  assert.ok(rewritten.includes('[ignored](Kept.md)'))
  assert.ok(rewritten.includes('[pipe](New/Pipe%7CName.md)'))
  assert.equal((markdownEngine.render(rewritten).match(/href="New\//g) ?? []).length, 4)
})

test('source positions survive containers, Unicode, multiline labels, footnotes and every line ending', () => {
  const source = [
    '# 中文 👩🏽‍💻 [heading](Heading.md) #', '',
    'Setext [title](Setext.md)', '---', '',
    '> [!note]   [title](Title.md)   ', '> [body](Body.md)', '',
    '> - [x] [task](Task.md)', '>   continued [line](Continued.md)', '',
    '- item', '', '  [label', '  continuation](Multiline.md)', '',
    '- > | A | B |', '  > | - | - |', '  > | [cell](Cell.md) | ![image](Image.png) |', '',
    '[used][ref]', '', '> [ref]:', '>   <Reference.md>', '>   "title"', '',
    'Inline ^[body [inside](Inline.md) ^[nested [deep](Deep.md)]]', '',
    '[^unused]: [kept](Unused.md) ^[also [kept](NestedUnused.md)]', '',
    'End of definitions.', '', '\t[code](NotALink.md)', '', '![alt [plain](NotALink.md)](Alt.png)'
  ].join('\n')
  const expected = ['Heading.md', 'Setext.md', 'Title.md', 'Body.md', 'Task.md', 'Continued.md', 'Multiline.md',
    'Cell.md', 'Image.png', 'Reference.md', 'Inline.md', 'Deep.md', 'Unused.md', 'NestedUnused.md', 'Alt.png']
  for (const newline of ['\n', '\r\n', '\r']) {
    const input = source.replace(/\n/g, newline)
    const links = collectMarkdownDestinations(input)
    assert.deepEqual(links.map((link) => link.url), expected)
    assert.deepEqual(links.map((link) => input.slice(link.start, link.end)), expected)
    const rewritten = rewriteMarkdownDestinations(input, ({ url }) => 'New/' + url)
    assert.deepEqual(collectMarkdownDestinations(rewritten).map((link) => link.url), expected.map((url) => 'New/' + url))
    assert.ok(rewritten.includes('[plain](NotALink.md)'))
    assert.equal(rewritten.split(newline).length, input.split(newline).length)
  }
})

test('nested label syntax and repeated literal URLs cannot authorize source edits', () => {
  const source = '[outer [inner](Target.md)](Target.md)\n\n[[[Target]]](Target.md)\n\n[<file:///Target.md>](Target.md)\n\n[[Target]]'
  const links = collectMarkdownSourceLinks(source)
  assert.deepEqual(links.map((link) => link.kind), ['link', 'link', 'link', 'wiki'])
  const rewritten = rewriteMarkdownDestinations(source, () => 'Moved.md')
  assert.ok(rewritten.startsWith('[outer [inner](Moved.md)](Target.md)'))
  assert.ok(rewritten.includes('[[[Target]]](Moved.md)'))
  assert.ok(rewritten.includes('[<file:///Target.md>](Moved.md)'))
  const html = markdownEngine.render(rewritten)
  assert.equal((html.match(/<a /g) ?? []).length, 3)
  assert.doesNotMatch(html, /<a[^>]*><a/)
  const image = '![alt [plain](Plain.md) ^[note [visible](Footnote.md)]](Image.png)'
  assert.deepEqual(collectMarkdownDestinations(image).map((link) => link.url), ['Footnote.md', 'Image.png'])
  assert.match(markdownEngine.render(image), /href="Footnote.md"/)
})
