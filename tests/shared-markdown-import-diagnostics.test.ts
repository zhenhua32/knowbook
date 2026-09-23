import assert from 'node:assert/strict'
import test from 'node:test'
import { collectDocumentMarkdownCompatibility } from '../src/shared/markdownCompatibility'
import { parseMarkdownBlocks } from '../src/shared/markdown'
import { markdownEngine } from '../src/shared/markdownEngine'
import { collectMarkdownDestinations, rewriteMarkdownDestinations } from '../src/shared/markdownLinks'

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

test('foreign wiki embeds and aliases are diagnosed without treating code examples as links', () => {
  const issues = diagnose('![[Picture.png]] and [[Note|label]] and [[Note#^block]] and `![[code]]` and [[Ordinary]]')
  assert.deepEqual(issues.map((issue) => issue.reason), ['wiki-syntax', 'wiki-syntax', 'wiki-syntax'])
  assert.deepEqual(diagnose('\\![[Ordinary]] and `![[Ordinary]]`'), [])
})

test('bare managed file autolinks are collected and exported without touching literal examples', () => {
  const source = 'A file:///tmp/asset.png, then `file:///tmp/code.png` and $file:///tmp/math.png$.'
  const destinations = collectMarkdownDestinations(source)
  assert.deepEqual(destinations.map((entry) => [source.slice(entry.start, entry.end), entry.syntax]), [['file:///tmp/asset.png', 'bare']])
  assert.equal(rewriteMarkdownDestinations(source, () => './asset.png'), 'A [file:///tmp/asset.png](./asset.png), then `file:///tmp/code.png` and $file:///tmp/math.png$.')
})
