import assert from 'node:assert/strict'
import test from 'node:test'
import { collectMarkdownDestinations, parseLocalMarkdownUrl, relativeMarkdownPath, resolveMarkdownDocumentPath, rewriteMarkdownDestinations } from '../src/shared/markdownLinks.ts'
import { collectMarkdownAnchors } from '../src/shared/markdownAnchors.ts'

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
