import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { htmlClipboardToMarkdown } from '../src/shared/htmlClipboard'
import { markdownEngine } from '../src/shared/markdownEngine'
import { parseMarkdownBlocks } from '../src/shared/markdown'

const rendered = (html: string) => JSDOM.fragment(markdownEngine.render(htmlClipboardToMarkdown(html)))

test('browser fragments retain headings, paragraphs, inline formatting, links and hard breaks', () => {
  const source = '<!--StartFragment-->' + Array.from({ length: 6 }, (_, index) => `<h${index + 1}>标题 ${index + 1}</h${index + 1}>`).join('')
    + '<p>First <strong>bold</strong>, <em>italic</em>, <del>old</del>, <code>a ` b</code> <a href="https://example.test/文档?q=1&amp;x=2">链接</a><br>Second.</p><!--EndFragment-->'
  const tree = rendered(source)
  for (let level = 1; level <= 6; level++) assert.equal(tree.querySelector(`h${level}`)?.textContent, `标题 ${level}`)
  assert.equal(tree.querySelector('strong')?.textContent, 'bold')
  assert.equal(tree.querySelector('em')?.textContent, 'italic')
  assert.equal(tree.querySelector('del')?.textContent, 'old')
  assert.equal(tree.querySelector('code')?.textContent, 'a ` b')
  assert.equal(tree.querySelector('a')?.textContent, '链接')
  assert.equal(tree.querySelector('a')?.getAttribute('href'), 'https://example.test/%E6%96%87%E6%A1%A3?q=1&x=2')
  assert.equal(tree.querySelectorAll('br').length, 1)
})

test('Word span formatting and Notion list fragments retain semantic text without foreign metadata', () => {
  const source = '<p class="MsoNormal" style="margin:0"><span style="font-weight:700">重点</span> <span style="font-style:italic">说明</span></p>'
    + '<ul class="bulleted-list" data-block-id="foreign"><li>父项<ul><li><strong>子项</strong><ol start="3"><li>三级</li></ol></li></ul></li><li>最后</li></ul>'
    + '<!-- knowbook:block {"id":"stolen","tags":["foreign"]} -->'
  const markdown = htmlClipboardToMarkdown(source), tree = JSDOM.fragment(markdownEngine.render(markdown))
  assert.equal(tree.querySelector('p strong')?.textContent, '重点')
  assert.equal(tree.querySelector('p em')?.textContent, '说明')
  assert.equal(tree.querySelector('ul > li > ul > li strong')?.textContent, '子项')
  assert.equal(tree.querySelector('ul ol')?.getAttribute('start'), '3')
  assert.match(tree.querySelector('ul ol li')?.textContent ?? '', /三级/)
  assert.equal(tree.querySelectorAll('li').length, 4)
  assert.ok(!markdown.includes('stolen') && !markdown.includes('foreign'))
  assert.ok(parseMarkdownBlocks(markdown).every(block => !block.id && !block.tags))
})

test('checkbox tasks, ordered list starts and blockquotes preserve content', () => {
  const tree = rendered('<ol start="5"><li><input type="checkbox" checked>Done</li><li><input type="checkbox">Todo<ul><li>Child</li></ul></li></ol><blockquote><p>Quoted <b>text</b></p><p>Second</p></blockquote>')
  assert.equal(tree.querySelector('ol')?.getAttribute('start'), '5')
  const checkboxes = tree.querySelectorAll('input[type=checkbox]')
  assert.equal(checkboxes.length, 2)
  assert.equal(checkboxes[0].hasAttribute('checked'), true)
  assert.equal(checkboxes[1].hasAttribute('checked'), false)
  assert.equal(tree.querySelector('blockquote strong')?.textContent, 'text')
  assert.match(tree.querySelector('blockquote')?.textContent ?? '', /Second/)
})

test('GFM tables retain formatted cells and all merged-cell and caption text', () => {
  const html = '<table><caption>统计说明</caption><thead><tr><th colspan="2">Group</th><th>Value</th></tr></thead><tbody>'
    + '<tr><td rowspan="2"><strong>A | B</strong></td><td>Second<br>line</td><td><a href="https://example.test">Site</a></td></tr>'
    + '<tr><td>Tail</td><td><em>End</em></td></tr></tbody></table>'
  const markdown = htmlClipboardToMarkdown(html), tree = JSDOM.fragment(markdownEngine.render(markdown))
  assert.equal(tree.querySelectorAll('th').length, 3)
  assert.equal(tree.querySelectorAll('tbody tr').length, 2)
  assert.equal(tree.querySelector('td strong')?.textContent, 'A | B')
  assert.equal(tree.querySelector('td a')?.textContent, 'Site')
  assert.equal(tree.querySelector('td em')?.textContent, 'End')
  assert.ok(tree.textContent?.includes('统计说明') && tree.textContent.includes('Tail') && tree.textContent.includes('Second'))
  assert.equal(markdown.split('A \\| B').length - 1, 1)
})

test('safe images preserve alt, title and allowed dimensions while attributes stay restricted', () => {
  const tree = rendered('<p><img src="https://example.test/a.png" alt="说明 &amp; 名称" title="图注" width="240" height="120" onerror="steal()" style="position:fixed" srcset="https://bad.test/a 2x"></p><p><img src="assets/a.png" alt="Relative"></p>')
  assert.equal(tree.querySelector('img')?.getAttribute('width'), '240')
  assert.equal(tree.querySelector('img')?.getAttribute('height'), '120')
  assert.equal(tree.querySelector('img')?.getAttribute('alt'), '说明 & 名称')
  assert.equal(tree.querySelector('img')?.getAttribute('title'), '图注')
  assert.equal(tree.querySelectorAll('img').length, 2)
  assert.equal(tree.querySelectorAll('[onerror], [style], [srcset]').length, 0)
})

test('executable markup and unsafe destinations are discarded without losing link or image labels', () => {
  const source = '<script>steal()</script><style>body{display:none}</style><iframe>frame secrets</iframe><svg><text>foreign</text></svg>'
    + '<p onclick="steal()"><a href="java&#x73;cript:alert(1)">Keep link</a> '
    + '<a href="&#9;JaVaScRiPt:alert(1)">Keep second</a> <a href="//bad.test">Keep third</a> '
    + '<img src="data:image/svg+xml,test" alt="Keep image"><img src="blob:abc" alt="Keep blob">'
    + '<img src="mailto:bad@example.test" alt="Keep mail image"><a href="mailto:good@example.test">Mail</a></p>'
  const markdown = htmlClipboardToMarkdown(source), tree = JSDOM.fragment(markdownEngine.render(markdown))
  for (const label of ['Keep link', 'Keep second', 'Keep third', 'Keep image', 'Keep blob', 'Keep mail image']) assert.ok(tree.textContent?.includes(label))
  assert.equal(tree.querySelectorAll('script, style, iframe, svg, img, [onclick]').length, 0)
  assert.equal(tree.querySelectorAll('a').length, 1)
  assert.equal(tree.querySelector('a')?.getAttribute('href'), 'mailto:good@example.test')
  assert.ok(!markdown.includes('steal') && !markdown.includes('frame secrets') && !markdown.includes('foreign'))
})

test('literal Markdown syntax cannot change pasted text into blocks or steal metadata', () => {
  const tree = rendered('<p># ordinary * text [x](javascript:bad) &lt;!-- knowbook:block {"id":"stolen"} --&gt;</p><p>1. literal list</p><p>---</p>')
  assert.equal(tree.querySelectorAll('h1, ol, hr').length, 0)
  assert.ok(tree.textContent?.includes('# ordinary * text [x](javascript:bad)'))
  assert.ok(tree.textContent?.includes('<!-- knowbook:block {"id":"stolen"} -->'))
  assert.ok(parseMarkdownBlocks(htmlClipboardToMarkdown('<p>&lt;!-- knowbook:block {"id":"stolen"} --&gt;</p>')).every(block => !block.id))
})

test('fenced code preserves indentation and backticks, unknown containers keep their text, and empty fragments stay empty', () => {
  const tree = rendered('<pre><code class="language-ts">const x = `value`\n  ```\n</code></pre><custom-box>Unknown <span>中文</span></custom-box>')
  assert.equal(tree.querySelector('pre code')?.textContent, 'const x = `value`\n  ```\n')
  assert.equal(tree.querySelector('pre code')?.getAttribute('class'), 'language-ts')
  assert.ok(tree.textContent?.includes('Unknown 中文'))
  for (const html of ['', ' \n ', '<!--StartFragment--><!--EndFragment-->', '<p><br></p>', '<script>ignored()</script>']) assert.equal(htmlClipboardToMarkdown(html), '')
})
