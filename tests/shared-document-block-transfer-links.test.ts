import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { rewriteDocumentBlockTransferLinks, blockTransferLinkBindingKey, type BlockTransferLinkContext } from '../src/shared/documentBlockTransferLinks'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '../src/shared/markdownLinks'
import { markdownEngine } from '../src/shared/markdownEngine'

const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })
function context(movedIds: string[], sourcePath = 'Docs/Source'): BlockTransferLinkContext {
  return { sourcePath, fromPath: 'Docs/Source', toPath: 'Archive/Target', movedIds: new Set(movedIds), bindings: new Map() }
}

test('only moved block fragments follow ownership while labels, query bytes, aliases and unsafe literals stay exact', () => {
  const content = '[**中文标签**](Docs/Source.md?raw=%23#move) [留](Docs/Source.md#keep) [文档](Docs/Source.md) '
    + '[[Docs/Source#move|  原别名]] [[Docs/Source#keep|保留]] [[Source#move|歧义]] '
    + '[external](https://example.com/Docs/Source.md#move) [bad](javascript:Docs/Source.md#move) '
    + '`[code](Docs/Source.md#move) [[Docs/Source#move]]` $[math](Docs/Source.md#move)$ '
    + '<span href="Docs/Source.md#move">属性原文</span> <!-- Docs/Source.md#move -->'
  const block = { ...paragraph('inlink', content), tags: [' Exact '], highlight: 'purple' }
  const input = context(['move'], 'Outside')
  input.bindings = new Map([[blockTransferLinkBindingKey('inlink', 'Docs/Source#move|  原别名'), { path: 'Docs/Source', fragment: 'move', kind: 'block' }]])
  const next = rewriteDocumentBlockTransferLinks([block], input)
  assert.equal(next[0].content, content.replace('](Docs/Source.md?raw=%23#move)', '](Archive/Target.md?raw=%23#move)')
    .replace('[[Docs/Source#move|  原别名]]', '[[Archive/Target#move|  原别名]]'))
  assert.deepEqual({ ...next[0], content }, block)
  assert.equal(block.content, content)
})

test('moved outgoing links keep their original document or asset context and local surviving fragments cross back', () => {
  const source = paragraph('move', '[stay](#keep) [self](#move) [doc](./Other.md?q=1#heading) '
    + '[asset](assets/report.pdf) ![image](images/a.png) [[./Other#heading|  alias]] [[#keep|留]] [[#move|自身]]')
  const input = context(['move'])
  input.bindings = new Map([
    [blockTransferLinkBindingKey('move', './Other#heading|  alias'), { path: 'Docs/Other', fragment: 'heading', kind: 'heading' }],
    [blockTransferLinkBindingKey('move', '#keep|留'), { path: 'Docs/Source', fragment: 'keep', kind: 'block' }],
    [blockTransferLinkBindingKey('move', '#move|自身'), { path: 'Docs/Source', fragment: 'move', kind: 'block' }]
  ])
  const next = rewriteDocumentBlockTransferLinks([source], input)
  assert.equal(next[0].content, '[stay](../Docs/Source.md#keep) [self](#move) [doc](../Docs/Other.md?q=1#heading) '
    + '[asset](../Docs/assets/report.pdf) ![image](../Docs/images/a.png) [[Docs/Other#heading|  alias]] [[Docs/Source#keep|留]] [[#move|自身]]')
  const links = collectDocumentMarkdownLinks(next).filter(link => link.kind !== 'wiki' && link.kind !== 'image')
  assert.deepEqual(links.slice(0, 3).map(link => resolveMarkdownDocumentPath('Archive/Target', link.url)), [
    { path: 'Docs/Source', fragment: 'keep' }, { path: 'Archive/Target', fragment: 'move' }, { path: 'Docs/Other', fragment: 'heading' }
  ])
})

test('source references split from their definitions become explicit without changing escaped visible labels or titles', () => {
  const blocks = [paragraph('move', '[**可见\\]标签**][ref] ![图\\]片][img] [Shortcut] [Collapsed][]'),
    paragraph('definitions', '[ref]: ./Next.md#fragment "中文标题"\n[img]: pictures/a.png "原图"\n[Shortcut]: https://example.com/a\n[Collapsed]: Other.md')]
  const next = rewriteDocumentBlockTransferLinks(blocks, context(['move']))
  assert.equal(next[0].content, '[**可见\\]标签**](../Docs/Next.md#fragment "中文标题") ![图\\]片](../Docs/pictures/a.png "原图") '
    + '[Shortcut](https://example.com/a) [Collapsed](../Docs/Other.md)')
  assert.deepEqual(next[1], blocks[1])
})

test('moved definitions retain reference syntax with private labels while source survivors and target definitions keep their bindings', () => {
  const blocks = [paragraph('remain', '[Remaining][shared]'), paragraph('move-use', '[**Visible**][shared]'),
    paragraph('move-definition', '[shared]: ./Neighbor.md "Original title"')]
  const input = context(['move-use', 'move-definition'])
  input.targetContent = '[shared]: Existing.md\n[knowbook-moved-1]: AlsoExisting.md'
  const next = rewriteDocumentBlockTransferLinks(blocks, input)
  assert.equal(next[0].content, '[Remaining](./Neighbor.md "Original title")')
  assert.equal(next[1].content, '[**Visible**][knowbook-moved-2]')
  assert.equal(next[2].content, '[knowbook-moved-2]: ../Docs/Neighbor.md "Original title"')
  assert.equal(collectDocumentMarkdownLinks(next).filter(link => link.kind === 'definition').length, 1)
})

test('table escaping and CRLF are preserved and code/math blocks never acquire rewritten references', () => {
  const table = paragraph('table', '| Ref |\r\n| --- |\r\n| [[Docs/Source#move\\|字面别名]] |')
  const blocks = [table, { ...paragraph('code', '[[Docs/Source#move]] [x](Docs/Source.md#move)'), type: 'code', language: 'markdown' },
    { ...paragraph('math', '[[Docs/Source#move]]'), type: 'math' }]
  const input = context(['move'], 'Outside')
  input.bindings = new Map([[blockTransferLinkBindingKey('table', 'Docs/Source#move|字面别名'), { path: 'Docs/Source', fragment: 'move', kind: 'block' }]])
  const next = rewriteDocumentBlockTransferLinks(blocks, input)
  assert.equal(next[0].content, table.content.replace('Docs/Source#move', 'Archive/Target#move'))
  assert.deepEqual(next.slice(1), blocks.slice(1))
})

test('duplicate reference definitions keep their first binding when only a later unused definition moves', () => {
  const blocks = [paragraph('first', '[ref]: First.md "First title"'), paragraph('move-use', '[Visible][ref]'),
    paragraph('move-duplicate', '[ref]: Second.md "Unused title"')]
  const next = rewriteDocumentBlockTransferLinks(blocks, context(['move-use', 'move-duplicate']))
  assert.deepEqual(next[0], blocks[0])
  assert.equal(next[1].content, '[Visible](../Docs/First.md "First title")')
  assert.equal(next[2].content, '[knowbook-moved-1]: ../Docs/Second.md "Unused title"')
})

test('multiline list labels and table cell reference labels retain exact local source ranges', () => {
  const blocks: DocumentBlockDraft[] = [
    { ...paragraph('list', '[one\n **two**][ref]'), type: 'bulleted-list' },
    paragraph('table', '| Link |\r\n| --- |\r\n| [字面\\|标签][ref] |'),
    paragraph('definition', '[ref]: ./Next.md "Title"')
  ]
  const next = rewriteDocumentBlockTransferLinks(blocks, context(['list', 'table']))
  assert.equal(next[0].content, '[one\n **two**](../Docs/Next.md "Title")')
  assert.equal(next[1].content, blocks[1].content.replace('[字面\\|标签][ref]', '[字面\\|标签](../Docs/Next.md "Title")'))
  assert.deepEqual(next[2], blocks[2])
})

test('an intact details block moves its reference definitions and body links without touching literal HTML attributes', () => {
  const source = { ...paragraph('move', '<details open><summary>标题</summary>\n\n[正文][r]\n\n[r]: ./Other.md "Title"\n\n'
    + '<span data-link="./Other.md">原始属性</span>\n</details>'), type: 'html' }
  const next = rewriteDocumentBlockTransferLinks([source], context(['move']))
  assert.equal(next[0].content, source.content.replace('[正文][r]', '[正文][knowbook-moved-1]')
    .replace('[r]: ./Other.md', '[knowbook-moved-1]: ../Docs/Other.md'))
  assert.deepEqual({ ...next[0], content: source.content }, source)
})

test('inline footnote reference links preserve their rendered destination when their definition stays in the source document', () => {
  const blocks = [paragraph('move', 'Note^[Use [**link**][ref] and `[literal][ref]`]'), paragraph('definition', '[ref]: ./Next.md "Title"')]
  const before = markdownEngine.render(blocks.map(block => block.content).join('\n\n'))
  assert.ok(before.includes('href="./Next.md" title="Title"><strong>link</strong>'))
  const next = rewriteDocumentBlockTransferLinks(blocks, context(['move']))
  assert.equal(next[0].content, 'Note^[Use [**link**](../Docs/Next.md "Title") and `[literal][ref]`]')
  const after = markdownEngine.render(next[0].content)
  assert.ok(after.includes('href="../Docs/Next.md" title="Title"><strong>link</strong>'))
  assert.ok(after.includes('<code>[literal][ref]</code>'))
  assert.deepEqual(next[1], blocks[1])
})

test('named footnotes copy their complete reachable closure with private names and explicit original reference destinations', () => {
  const blocks = [paragraph('move', 'Body[^note] and ^[nested[^note]] and \`literal[^note]\`'),
    paragraph('definition', '[^note]: First [link][r] and [local](#keep), nested[^inner].\n\n    Next paragraph **bold**.\n\n    - list item\n    - second item\n\n[^inner]: Inner [image](assets/file.pdf) and \`code[^note]\`\n\n[r]: ./Next.md "Title"'),
    paragraph('keep', 'Keep source[^note]')]
  const input = context(['move'])
  input.targetContent = 'Existing[^note]\n\n[^note]: Wrong target definition\n\n[^knowbook-footnote-moved-1]: Reserved'
  const next = rewriteDocumentBlockTransferLinks(blocks, input)
  assert.deepEqual(next.slice(1), blocks.slice(1))
  assert.ok(!next[0].content.includes('Body[^note]'))
  assert.ok(next[0].content.includes('literal[^note]'))
  const html = markdownEngine.render(input.targetContent + '\n\n' + next[0].content)
  assert.ok(html.includes('Wrong target definition'), 'pre-existing target bindings retain their own definition')
  assert.ok(html.includes('First <a href="../Docs/Next.md" title="Title">link</a>'))
  assert.ok(html.includes('href="../Docs/Source.md#keep"'))
  assert.ok(html.includes('Next paragraph <strong>bold</strong>'))
  assert.ok(html.includes('<li>list item</li>') && html.includes('<li>second item</li>'))
  assert.ok(html.includes('href="../Docs/assets/file.pdf"'))
  assert.ok(html.includes('<code>code[^note]</code>'))
  assert.ok(html.includes('<code>literal[^note]</code>'))
  assert.ok(html.includes('nested<sup class="footnote-ref">'))
})

test('moving named definitions copies their full closure back to source survivors and does not bind target notes of the same name', () => {
  const blocks = [paragraph('stay', 'Survivor[^n]'), paragraph('move', 'Moved[^n]\n\n[^n]: Original [asset](pictures/a.png) and nested[^inner]\n\n[^inner]: Inner [ref][r]'),
    paragraph('reference', '[r]: ./Neighbor.md')]
  const input = context(['move']); input.targetContent = 'Target[^n]\n\n[^n]: Target only'
  const next = rewriteDocumentBlockTransferLinks(blocks, input)
  assert.ok(next[0].content.includes('knowbook-footnote-source-'))
  assert.ok(next[1].content.includes('knowbook-footnote-moved-'))
  const sourceHtml = markdownEngine.render(next.filter(block => block.id !== 'move').map(block => block.content).join('\n\n'))
  const targetHtml = markdownEngine.render(input.targetContent + '\n\n' + next[1].content)
  assert.ok(sourceHtml.includes('href="pictures/a.png"'))
  assert.ok(sourceHtml.includes('href="./Neighbor.md"'))
  assert.ok(targetHtml.includes('href="../Docs/pictures/a.png"'))
  assert.ok(targetHtml.includes('href="../Docs/Neighbor.md"'))
  assert.ok(targetHtml.includes('Target only'))
  assert.equal((sourceHtml.match(/Original/g) ?? []).length, 1)
  assert.equal((targetHtml.match(/Original/g) ?? []).length, 1)
})

test('cyclic named notes copy each definition once, preserve CRLF bodies, and refuse unsafe container copies before any mutation', () => {
  const blocks = [paragraph('move', 'Note[^a]'), paragraph('definition', '[^a]: A[^b]\r\n\r\n    Continued\r\n\r\n[^b]: B[^a]')]
  const next = rewriteDocumentBlockTransferLinks(blocks, context(['move']))
  assert.equal((next[0].content.match(/\[\^knowbook-footnote-moved-\d+\]:/g) ?? []).length, 2)
  assert.ok(next[0].content.includes('A[^knowbook-footnote-moved-2]\r\n\r\n    Continued'))
  assert.ok(markdownEngine.render(next[0].content).includes('Continued'))
  const unsafe = [{ ...paragraph('move', 'Note[^n]'), type: 'todo' }, paragraph('definition', '[^n]: Original')]
  const before = structuredClone(unsafe)
  assert.throws(() => rewriteDocumentBlockTransferLinks(unsafe, context(['move'])), /脚注定义.*未移动任何块/)
  assert.deepEqual(unsafe, before)
})

test('unused moved footnote definitions and undefined source literals never capture target notes of the same name', () => {
  const input = context(['move']); input.targetContent = 'Target[^n]\n\n[^n]: Target definition'
  const next = rewriteDocumentBlockTransferLinks([paragraph('stay', 'Unrelated source'), paragraph('move', '[^n]: Unused moved definition')], input)
  assert.ok(next[1].content.startsWith('[^knowbook-footnote-moved-1]:'))
  const html = markdownEngine.render(next[1].content + '\n\n' + input.targetContent)
  assert.ok(html.includes('Target definition'))
  assert.ok(!html.includes('Unused moved definition'))
  const literal = rewriteDocumentBlockTransferLinks([paragraph('move', 'Undefined[^n] and \`literal[^n]\`')], input)
  assert.equal(literal[0].content, 'Undefined\\[^n] and \`literal[^n]\`')
  const literalHtml = markdownEngine.render(literal[0].content + '\n\n' + input.targetContent)
  assert.ok(literalHtml.includes('Undefined[^n]'))
  assert.equal((literalHtml.match(/class="footnote-ref"/g) ?? []).length, 1)
})

test('references defined inside copied notes get private names and cannot change later target references', () => {
  const input = context(['move']); input.targetContent = 'Target [link][r]\n\n[r]: WrongTarget.md'
  const blocks = [paragraph('move', 'Use[^n]'), paragraph('definition', '[^n]: [Original][r]\n\n    [r]: Neighbor.md\n\n    Additional body')]
  const next = rewriteDocumentBlockTransferLinks(blocks, input)
  assert.ok(next[0].content.includes('[knowbook-footnote-reference-1]: ../Docs/Neighbor.md'))
  const html = markdownEngine.render(next[0].content + '\n\n' + input.targetContent)
  assert.ok(html.includes('href="../Docs/Neighbor.md">Original</a>'))
  assert.ok(html.includes('href="WrongTarget.md">link</a>'))
  assert.ok(html.includes('Additional body'))
})

test('named note uses inside link labels and inline notes retain their complete definitions while image alt stays literal', () => {
  const input = context(['move'])
  const blocks = [paragraph('move', '[Link[^n]](https://example.com) ![Alt[^n]](image.png) ^[inline[^n]]'),
    paragraph('definition', '[^n]: Original')]
  const before = markdownEngine.render(blocks.map(block => block.content).join('\n\n'))
  assert.ok(before.includes('Original'))
  const next = rewriteDocumentBlockTransferLinks(blocks, input)
  assert.ok(next[0].content.includes('[Link[^knowbook-footnote-moved-1]]'))
  assert.ok(next[0].content.includes('![Alt[^n]]'))
  assert.ok(next[0].content.includes('^[inline[^knowbook-footnote-moved-1]]'))
  assert.ok(markdownEngine.render(next[0].content).includes('Original'))
})

test('empty note bodies and definitions starting on a continuation line are located from parser boundaries and rendered completely', () => {
  const blocks = [paragraph('move', 'Empty[^empty] and body[^body]'),
    paragraph('empty', '[^empty]:'),
    paragraph('body', '[^body]:\n    First paragraph\n\n    Second **bold** paragraph')]
  const next = rewriteDocumentBlockTransferLinks(blocks, context(['move']))
  assert.ok(next[0].content.includes('[^knowbook-footnote-moved-2]:'))
  assert.ok(next[0].content.includes('[^knowbook-footnote-moved-1]:\n    First paragraph\n\n    Second **bold** paragraph'))
  const html = markdownEngine.render(next[0].content)
  assert.ok(html.includes('First paragraph'))
  assert.ok(html.includes('Second <strong>bold</strong> paragraph'))
  assert.equal((html.match(/class="footnote-item"/g) ?? []).length, 2)
})

test('named notes alongside shortcut references preserve the parser literal outer brackets and rendered link label', () => {
  const blocks = [paragraph('move', 'Body [Link[^n]][r] tail'), paragraph('definition', '[^n]: Original note\n\n[r]: ./Neighbor.md "Title"')]
  const next = rewriteDocumentBlockTransferLinks(blocks, context(['move']))
  assert.ok(next[0].content.startsWith('Body [Link[^knowbook-footnote-moved-1]][r](../Docs/Neighbor.md "Title") tail'))
  const html = markdownEngine.render(next[0].content)
  assert.ok(html.includes(']<a href="../Docs/Neighbor.md" title="Title">r</a>'))
  assert.ok(html.includes('Original note'))
  assert.ok(html.includes(' tail'))
  assert.deepEqual(next[1], blocks[1])
})

test('an unrelated unmoved note split across source blocks does not prevent moving ordinary text or literal code', () => {
  const blocks = [paragraph('move', 'Ordinary text'), paragraph('definition', '[^n]: Start'), paragraph('continuation', '    Continued'), paragraph('use', 'Source[^n]')]
  const next = rewriteDocumentBlockTransferLinks(blocks, context(['move']))
  assert.deepEqual(next, blocks)
  const code = [{ ...paragraph('move', '[^n]: literal code'), type: 'code' }, ...blocks.slice(1)]
  assert.deepEqual(rewriteDocumentBlockTransferLinks(code, context(['move'])), code)
})
