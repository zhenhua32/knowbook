import assert from 'node:assert/strict'
import test from 'node:test'
import { collectDocumentMarkdownCompatibility } from '../src/shared/markdownCompatibility'
import { parseMarkdownBlocks } from '../src/shared/markdown'
import { markdownEngine } from '../src/shared/markdownEngine'
import { collectMarkdownDestinations, rewriteMarkdownDestinations } from '../src/shared/markdownLinks'
import { draftBlocksToRichDoc, richDocToDraftBlocks, richTextInlineFingerprint } from '../src/renderer/src/rich-text/model'

const diagnose = (source: string) => {
  const blocks = parseMarkdownBlocks(source).map((block, index) => ({ ...block, id: `block-${index}` }))
  const before = JSON.stringify(blocks), rendered = markdownEngine.render(source)
  const issues = collectDocumentMarkdownCompatibility(blocks)
  assert.equal(JSON.stringify(blocks), before)
  assert.equal(markdownEngine.render(source), rendered)
  for (const issue of issues) {
    const block = blocks.find((block) => block.id === issue.blockId)!
    assert.ok(block.content.slice(issue.offset).startsWith(issue.source.split('\n')[0]), JSON.stringify(issue))
  }
  return issues
}

test('import diagnostics distinguish unsupported HTML and discarded attributes with exact block locations', () => {
  const issues = diagnose('Before <div align="center">text</div>\n\n<kbd class="key">Ctrl</kbd> and <img src="x.png" width="50%" onerror="alert(1)">\n\n<a href="javascript:alert(1)">bad</a>')
  assert.deepEqual(issues.map((issue) => issue.reason), ['unsupported-html', 'html-attributes', 'html-attributes', 'html-attributes'])
  assert.deepEqual(diagnose('<kbd>Ctrl</kbd><br><sub>2</sub><sup>3</sup> <a id="anchor"></a> <img src="x.png" width="80">'), [])
})

test('diagnostics exclude fenced and inline code, math, YAML, escapes, alt text and unused reference titles', () => {
  assert.deepEqual(diagnose([
    '---', 'example: "<div>raw</div>"', '---', '',
    '`<div>code</div>` and $<span>x</span>$ and \\<div> escaped', '',
    '```html', '<div>code</div>', '```', '',
    '$$', '<script>math</script>', '$$', '',
    '![<span>alt</span>](image.png)', '',
    '[unused]: https://example.test "<iframe>title</iframe>"', '',
    '[![image](image.png)](https://example.test)', '',
    '&lt;div&gt; and <https://example.test>'
  ].join('\n')), [])
})

test('diagnostics preserve positions in nested details, quotes, lists, footnotes and tables', () => {
  const issues = diagnose([
    '> <details class="box">', '> <summary>`<div>example</div>`</summary>', '>',
    '> - <kbd style="color:red">Ctrl</kbd>', '>',
    '>   <details>', '>   <summary>Nested</summary>', '>', '>   <iframe src="https://example.test"></iframe>', '>', '>   </details>', '>',
    '> ```html', '> <div>code</div>', '> ```', '>', '> </details>', '',
    '| A | B |', '| --- | --- |', '| `<div>code</div>` | <kbd class="x">A</kbd> |', '',
    'Footnote[^n].', '', '[^n]: <span>Footnote</span>'
  ].join('\n'))
  assert.deepEqual(issues.map((issue) => issue.reason), ['html-attributes', 'html-attributes', 'unsupported-html', 'html-attributes', 'unsupported-html'])
})

test('unsupported note embeds and external block syntax are diagnosed; aliases and images are supported', () => {
  const issues = diagnose('![[Picture.png]] and [[Note|label]] and [[Note#^block]] and `![[code]]` and [[Ordinary]]')
  assert.deepEqual(issues.map((issue) => issue.reason), ['wiki-syntax'])
  assert.equal(diagnose('![[Note]]')[0].reason, 'wiki-syntax')
  assert.deepEqual(diagnose('\\![[Ordinary]] and `![[Ordinary]]`'), [])
})

test('native underline, finite colors and the exact neutral shell render without weakening bare HTML diagnostics', () => {
  const source = 'Before <u><strong>中文 😀</strong></u> <span data-knowbook-text-color="blue" data-knowbook-background-color="yellow">color</span> '
    + '<span data-knowbook-inline="true"><em>neutral</em> literal **text**</span> after'
  assert.deepEqual(diagnose(source), [])
  const document = draftBlocksToRichDoc([{ id: 'native', type: 'paragraph', content: source, checked: false, depth: 0, parentBlockId: null }])
  assert.equal(document.firstChild!.type.name, 'text_block')
  const underlined = document.firstChild!.content.content.find(node => node.text === '中文 😀')!
  assert.deepEqual(underlined.marks.map(mark => mark.type.name), ['strong', 'underline'])
  const colored = document.firstChild!.content.content.find(node => node.text === 'color')!
  assert.deepEqual(colored.marks.map(mark => [mark.type.name, mark.attrs.color]), [['textColor', 'blue'], ['backgroundColor', 'yellow']])
  assert.match(markdownEngine.renderInline(source), /<u><strong>中文 😀<\/strong><\/u>/)
  assert.match(markdownEngine.renderInline(source), /<em>neutral<\/em> literal \*\*text\*\*/)
  const saved = richDocToDraftBlocks(document)
  assert.equal(richTextInlineFingerprint(draftBlocksToRichDoc(saved).firstChild!), richTextInlineFingerprint(document.firstChild!))
  assert.deepEqual(diagnose('<span>old bare span</span>').map(issue => [issue.reason, issue.offset, issue.source]), [['unsupported-html', 0, '<span>']])
  for (const invalid of ['<span data-knowbook-inline="false">text</span>', '<span data-knowbook-inline="TRUE">text</span>',
    '<span data-knowbook-inline="true" style="color:red">text</span>', '<u data-knowbook-inline="true">text</u>',
    '<span data-knowbook-inline="true" onclick="evil()">text</span>']) {
    assert.ok(diagnose(invalid).length > 0, invalid)
    assert.equal(draftBlocksToRichDoc([{ id: 'invalid', type: 'paragraph', content: invalid, checked: false, depth: 0 }]).firstChild!.type.name, 'source_block', invalid)
    assert.doesNotMatch(markdownEngine.render(invalid), /<(?:span|u)[^>]+(?:style|onclick)=/)
  }
})

test('bare managed file autolinks are collected and exported without touching literal examples', () => {
  const source = 'A file:///tmp/asset.png, then `file:///tmp/code.png` and $file:///tmp/math.png$.'
  const destinations = collectMarkdownDestinations(source)
  assert.deepEqual(destinations.map((entry) => [source.slice(entry.start, entry.end), entry.syntax]), [['file:///tmp/asset.png', 'bare']])
  assert.equal(rewriteMarkdownDestinations(source, () => './asset.png'), 'A [file:///tmp/asset.png](./asset.png), then `file:///tmp/code.png` and $file:///tmp/math.png$.')
})
