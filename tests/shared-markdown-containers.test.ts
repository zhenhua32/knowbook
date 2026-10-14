import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdownBlocks, parseMarkdownBackupDocument, serializeBlocksToMarkdown, serializeMarkdownWithBlockRanges, type MarkdownRenderableBlock, type MarkdownBlockSourceRange, type MarkdownContainerClosingRange } from '../src/shared/markdown'
import { markdownEngine, type MarkdownNode } from '../src/shared/markdownEngine'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument'
import { collectDocumentMarkdownLinks, rewriteDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { collectMarkdownSourceLinks } from '../src/shared/markdownLinks'
import { normalizeMarkdownFormat } from '../src/shared/markdownFormat'
import { NativeMarkdownContainerError } from '../src/shared/markdownContainers'
import { createMarkdownSourceDraft, replaceMarkdownSource, markdownSourceDraftToBlocks } from '../src/renderer/src/utils/markdownSourceDraft'
import { normalizeDraftBlocks, validateBlockTreeStructure } from '../src/renderer/src/utils/draftTreeNormalization'
import type { DocumentBlockDraft } from '../src/shared/contracts'

const block = (id: string, type: string, content: string, depth = 0, parentBlockId: string | null = null, extra: Partial<MarkdownRenderableBlock> = {}): MarkdownRenderableBlock =>
  ({ id, type, content, depth, parentBlockId, checked: false, ...extra })
const original = [
  block('owner', 'callout', 'Callout [Title][dest] ^[Inline title note]\nsoft *line* [direct](Guide.md#inside)', 0, null, { markdownFormat: { calloutKind: 'tip', calloutIcon: 'book', calloutTone: 'blue' } }),
  block('heading', 'heading-2', 'Inside heading', 1, 'owner'),
  block('body', 'paragraph', 'Body [Link][dest] and [^n]. [direct](Guide.md#inside).', 1, 'owner', { tags: ['body'], highlight: 'yellow' }),
  block('task', 'todo', 'Done **task**', 1, 'owner', { checked: true, markdownFormat: { listMarker: '+', listLoose: false } }),
  block('number', 'numbered-list', 'Nested numbered', 2, 'task', { listStart: 7, markdownFormat: { listMarker: ')', listLoose: false } }),
  block('number-next', 'numbered-list', 'Next', 2, 'task', { markdownFormat: { listMarker: ')', listLoose: false } }),
  block('code', 'code', '</aside>\n<details data-knowbook-container="toggle-v1">', 1, 'owner', { language: 'typescript', markdownFormat: { codeInfo: 'ts title=sample' } }),
  block('table', 'table', '| A | B |\n| - | - |\n| [Cell][dest] [Direct](Guide.md#inside) | Text |', 1, 'owner'),
  block('math', 'math', 'a^2', 1, 'owner'),
  block('legacy-html', 'html', '<details>\n<summary>Legacy</summary>\n\nBody\n\n</details>', 1, 'owner'),
  block('legacy-quote', 'quote', '[!NOTE]- Legacy callout\nBody', 1, 'owner'),
  block('toggle', 'toggle', 'Toggle `</summary>` [^n]', 1, 'owner', { markdownFormat: { toggleDefaultOpen: false } }),
  block('repeated-one', 'paragraph', 'Repeated', 2, 'toggle'),
  block('inner', 'toggle', 'Nested toggle', 2, 'toggle'),
  block('repeated-two', 'paragraph', 'Repeated', 3, 'inner'),
  block('definitions', 'paragraph', '[dest]: Guide.md#inside\n\n[^n]: Definition', 1, 'owner'),
  block('after', 'paragraph', 'After owner')
]
const semantic = (blocks: MarkdownRenderableBlock[]) => blocks.map(value => ({
  type: value.type, content: value.content, checked: Boolean(value.checked), depth: value.depth ?? 0, listStart: value.listStart,
  markdownFormat: normalizeMarkdownFormat(value.type, value.markdownFormat)
}))
const identity = (blocks: MarkdownRenderableBlock[]) => blocks.map(value => ({ ...semantic([value])[0], id: value.id, parentBlockId: value.parentBlockId ?? null,
  tags: value.tags, highlight: value.highlight }))
const walk = (nodes: MarkdownNode[]): MarkdownNode[] => nodes.flatMap(node => [node, ...walk(node.children)])

test('native mixed forests preserve structure and rendering through three ordinary cycles without exporting IDs', () => {
  let source = serializeBlocksToMarkdown(original)
  const expectedHtml = markdownEngine.render(source), expected = semantic(parseMarkdownBlocks(source))
  assert.deepEqual(expected.map(value => value.type), original.map(value => value.type))
  assert.deepEqual(expected.map(value => value.depth), original.map(value => value.depth))
  assert.deepEqual(expected.map(value => value.content), original.map(value => value.content))
  for (let cycle = 0; cycle < 3; cycle++) {
    assert.doesNotMatch(source, /knowbook:block|"id"|parentBlockId|repeated-one|repeated-two/)
    const restored = parseMarkdownBlocks(source)
    assert.ok(restored.every(value => value.id === undefined && value.parentBlockId === null))
    assert.deepEqual(semantic(restored), expected)
    const healed = normalizeDraftBlocks(restored.map(value => ({ ...value, checked: Boolean(value.checked), depth: value.depth ?? 0 })) as DocumentBlockDraft[])
    assert.equal(validateBlockTreeStructure(healed).valid, true)
    assert.equal(healed[1].parentBlockId, healed[0].id)
    assert.equal(healed[14].parentBlockId, healed[13].id)
    source = serializeBlocksToMarkdown(restored)
    assert.equal(markdownEngine.render(source), expectedHtml)
  }
})

test('recursive backup metadata retains all identities, annotations and undefined default-open intent for three cycles', () => {
  let blocks = original
  for (let cycle = 0; cycle < 3; cycle++) {
    const source = serializeBlocksToMarkdown(blocks, { includeBlockMetadata: true })
    assert.equal((source.match(/<!-- knowbook:block /g) ?? []).length, original.length)
    const restored = parseMarkdownBackupDocument(source).blocks
    assert.deepEqual(identity(restored), identity(original))
    assert.equal(restored[13].markdownFormat, undefined)
    assert.deepEqual(restored[11].markdownFormat, { toggleDefaultOpen: false })
    assert.equal(serializeBlocksToMarkdown(restored, { includeBlockMetadata: true }), source)
    blocks = restored
  }
})

test('owner title, mixed children and structural closers have disjoint exact source ranges', () => {
  for (const includeBlockMetadata of [false, true]) {
    const serialized = serializeMarkdownWithBlockRanges(original, { includeBlockMetadata })
    const ranges: MarkdownBlockSourceRange[] = [], closing: MarkdownContainerClosingRange[] = []
    const parsed = parseMarkdownBlocks(serialized.markdown, ranges, closing)
    assert.equal(parsed.length, original.length)
    assert.deepEqual(ranges, serialized.ranges)
    assert.deepEqual(closing, serialized.closingRanges)
    for (let index = 1; index < ranges.length; index++) assert.ok(ranges[index - 1].endLine <= ranges[index].startLine)
    for (const close of closing) {
      const own = serialized.markdown.split('\n').slice(close.startLine, close.endLine).join('\n')
      assert.match(own, /^<\/(?:details|aside)>$/)
      assert.ok(ranges.every(range => range.endLine <= close.startLine || range.startLine >= close.endLine))
    }
    const owner = serialized.markdown.split('\n').slice(ranges[0].startLine, ranges[0].endLine).join('\n')
    assert.ok(owner.includes(original[0].content))
    assert.match(owner, /<\/div>$/)
    assert.doesNotMatch(owner, /Inside heading|Done|Repeated/)
  }
})

test('one document parse resolves title references from children and assigns notes, links and tasks to their actual owners', () => {
  const model = parseMarkdownDocumentBlocks(original)
  const ownerNodes = walk(model.blockNodes[0])
  assert.ok(ownerNodes.some(node => node.token.type === 'link_open' && node.token.attrGet('href') === 'Guide.md#inside'))
  assert.equal(ownerNodes.filter(node => node.token.type === 'footnote_ref').length, 1)
  assert.ok(model.blockNodes.every(nodes => !walk(nodes).some(node => node.token.type === 'native_container_open')))
  assert.equal(walk(model.footnotes).filter(node => node.token.type === 'footnote_open').length, 2)
  assert.deepEqual([...model.footnoteOrigins.values()], [0, 2, 11])
  assert.deepEqual(model.readingLists.map(value => value.indices), [[3, 4, 5]])
  assert.equal([...model.taskTargets.values()].find(value => value.blockId === 'task')?.offset, null)
  const links = collectDocumentMarkdownLinks(original).filter(value => value.url === 'Guide.md#inside')
  assert.deepEqual(links.map(value => value.blockId), ['owner', 'body', 'table', 'definitions'])
  for (const link of links) assert.equal(original[link.blockIndex].content.slice(link.start, link.end), 'Guide.md#inside')
  const rewritten = rewriteDocumentMarkdownLinks(original, () => 'Moved.md#inside')
  assert.ok(collectDocumentMarkdownLinks(rewritten).filter(value => value.url === 'Moved.md#inside').length >= 4)
  assert.deepEqual(rewritten.map(value => [value.id, value.parentBlockId]), original.map(value => [value.id, value.parentBlockId]))
  const source = serializeBlocksToMarkdown(original)
  for (const link of collectMarkdownSourceLinks(source)) assert.ok(source.slice(link.start, link.end).length > 0)
})

test('default Toggle is open in ordinary source, explicit closed remains closed, and backup preserves absence', () => {
  for (const authored of [undefined, { toggleDefaultOpen: false }, { toggleDefaultOpen: true }]) {
    const values = [block('toggle', 'toggle', 'Title', 0, null, { markdownFormat: authored })]
    const plain = serializeBlocksToMarkdown(values)
    assert.equal(plain.split('\n')[0].includes(' open'), authored?.toggleDefaultOpen !== false)
    assert.equal(parseMarkdownBlocks(plain)[0].markdownFormat?.toggleDefaultOpen, authored?.toggleDefaultOpen !== false)
    assert.deepEqual(parseMarkdownBackupDocument(serializeBlocksToMarkdown(values, { includeBlockMetadata: true })).blocks[0].markdownFormat, authored)
  }
})

test('multi-line titles keep soft and hard breaks and ignore title closing text in inline code', () => {
  for (const type of ['toggle', 'callout']) for (const content of [
    'First\nSecond  \nThird', 'Code `before\n</summary>\nafter` title', 'Code `</div>` title', 'Unmatched ` literal'
  ]) {
    const values = [block('owner', type, content), block('child', 'paragraph', 'Body `code`', 1, 'owner')]
    for (const includeBlockMetadata of [false, true]) {
      const source = serializeBlocksToMarkdown(values, { includeBlockMetadata })
      const restored = parseMarkdownBlocks(source)
      assert.equal(restored[0].content, content)
      assert.equal(restored[1].content, 'Body `code`')
      assert.equal(restored[1].depth, 1)
      assert.equal(markdownEngine.render(source), markdownEngine.render(serializeBlocksToMarkdown(restored)))
    }
  }
})

test('unknown, incomplete, duplicated or unsafe marked shells are rejected while legacy literal syntax stays editable', () => {
  const shell = '<details data-knowbook-container="toggle-v1">\n<summary>Title</summary>\n\nBody\n\n</details>'
  for (const invalid of [
    shell.replace('toggle-v1', 'toggle-v99'), shell.replace('<details ', '<aside ').replace('</details>', '</aside>'),
    shell.replace('">', '" onclick="evil()">'), shell.replace('">', '" style="color:red">'),
    shell.replace('">', '" data-knowbook-container="toggle-v1">'), shell.slice(0, shell.lastIndexOf('</details>')),
    shell.replace('<summary>', '<summary onclick="evil()">'), shell.replace('<summary>Title</summary>', 'Missing title'),
    shell.replace('="toggle-v1"', ''), shell.replace('<details data-', '<details\ndata-'), shell.replace('">', '"'), shell.replace('<details', '<div').replace('</details>', '</div>')
  ]) assert.throws(() => parseMarkdownBlocks(invalid), NativeMarkdownContainerError, invalid)
  const legacy = '<details open>\n<summary>Legacy</summary>\n\nBody\n\n</details>'
  assert.equal(parseMarkdownBlocks(legacy)[0].type, 'html')
  assert.equal(parseMarkdownBlocks('> [!NOTE]- Title\n> Body')[0].type, 'quote')
  const quotedMarker = '<details title="data-knowbook-container=toggle-v1">\n<summary>Legacy</summary>\n\nBody\n\n</details>'
  assert.equal(parseMarkdownBlocks(quotedMarker)[0].type, 'html')
  assert.equal(parseMarkdownBlocks('~~~html\n' + shell + '\n~~~')[0].type, 'code')
  assert.equal(parseMarkdownBlocks('`<details data-knowbook-container="toggle-v99">`')[0].type, 'paragraph')
})

test('source edits keep repeated-child identities and parent paths without inheriting foreign metadata IDs', () => {
  const values = normalizeDraftBlocks(original.map(value => ({ ...value, checked: Boolean(value.checked), depth: value.depth ?? 0 })) as DocumentBlockDraft[])
  const draft = createMarkdownSourceDraft(values)
  const position = draft.anchors[14].from
  const changed = markdownSourceDraftToBlocks(replaceMarkdownSource(draft, { from: position, to: position + 'Repeated'.length, insert: 'Changed' }))
  assert.deepEqual(changed.map(value => value.id), values.map(value => value.id))
  assert.deepEqual(changed.map(value => value.parentBlockId), values.map(value => value.parentBlockId))
  assert.equal(changed[12].content, 'Repeated')
  assert.equal(changed[14].content, 'Changed')
  assert.equal(changed[13].markdownFormat, undefined)
  assert.equal(validateBlockTreeStructure(changed).valid, true)
  const titleAt = draft.source.indexOf('Nested toggle')
  const titleChanged = markdownSourceDraftToBlocks(replaceMarkdownSource(draft, { from: titleAt, to: titleAt + 13, insert: 'Edited title' }))
  assert.equal(titleChanged[13].id, 'inner')
  assert.equal(titleChanged[13].markdownFormat, undefined)
  assert.equal(titleChanged[14].parentBlockId, 'inner')
  const foreign = '<!-- knowbook:block {"type":"callout","id":"foreign","depth":1} -->\n<aside data-knowbook-container="callout-v1">\n<div data-knowbook-title="true">Inserted</div>\n\nNew child\n\n</aside>\n\n'
  const pasted = markdownSourceDraftToBlocks(replaceMarkdownSource(draft, { from: draft.anchors[1].from, to: draft.anchors[1].from, insert: foreign }))
  assert.ok(!pasted.some(value => value.id === 'foreign'))
  assert.equal(pasted.find(value => value.content === 'Inserted')?.parentBlockId, 'owner')
})

test('damaged native source is rejected before returning any replacement blocks', () => {
  const values = [block('owner', 'toggle', 'Title'), block('child', 'paragraph', 'Body', 1, 'owner')] as DocumentBlockDraft[]
  const draft = createMarkdownSourceDraft(values)
  const close = draft.source.lastIndexOf('</details>')
  assert.throws(() => markdownSourceDraftToBlocks(replaceMarkdownSource(draft, { from: close, to: close + 10, insert: '' })), NativeMarkdownContainerError)
  assert.equal(values[1].content, 'Body')
  assert.equal(values[1].parentBlockId, 'owner')
})

test('native backup metadata cannot flatten, duplicate or redirect a declared shell forest', () => {
  const source = serializeBlocksToMarkdown(original, { includeBlockMetadata: true })
  const change = (id: string, patch: Record<string, unknown>) => source.replace(/<!-- knowbook:block (\{.*\}) -->/g, (whole, json) => {
    const value = JSON.parse(json) as Record<string, unknown>
    return value.id === id ? '<!-- knowbook:block ' + JSON.stringify({ ...value, ...patch }) + ' -->' : whole
  })
  for (const invalid of [
    change('owner', { depth: 1 }), change('heading', { depth: 0 }), change('body', { parentBlockId: 'foreign' }),
    change('body', { parentBlockId: null }), change('inner', { parentBlockId: 'owner' }),
    change('heading', { id: 'owner' }), change('number', { depth: 7 }), change('body', { depth: 1.5 }),
    change('definitions', { parentBlockId: 'inner' }), change('toggle', { type: 'callout' }),
    change('body', { type: 'frontmatter' }),
    change('toggle', { markdownFormat: { toggleDefaultOpen: 'false' } }),
    change('owner', { markdownFormat: { calloutKind: 'unknown' } }),
    change('owner', { markdownFormat: { toggleDefaultOpen: true } }),
    change('owner', { markdownFormat: { calloutKind: 'note' } }),
    change('toggle', { markdownFormat: { toggleDefaultOpen: true } }),
    change('owner', { markdownFormat: null })
  ]) assert.throws(() => parseMarkdownBackupDocument(invalid), NativeMarkdownContainerError)
  assert.deepEqual(identity(parseMarkdownBackupDocument(source).blocks), identity(original))
})
test('a nested other-kind owner title cannot terminate its enclosing shell', () => {
  for (const [outer, inner, fake] of [['callout', 'toggle', '</aside>'], ['toggle', 'callout', '</details>']]) {
    const values = [block('outer', outer, 'Outer'), block('inner', inner, 'Title `before\n' + fake + '\nafter`', 1, 'outer'),
      block('leaf', 'paragraph', 'Child', 2, 'inner'), block('sibling', 'paragraph', 'Sibling', 1, 'outer')]
    for (const includeBlockMetadata of [false, true]) {
      const source = serializeBlocksToMarkdown(values, { includeBlockMetadata })
      const parsed = parseMarkdownBlocks(source)
      assert.deepEqual(parsed.map(value => [value.type, value.content, value.depth]), values.map(value => [value.type, value.content, value.depth]))
      assert.equal(serializeBlocksToMarkdown(parsed, { includeBlockMetadata }), source)
    }
  }
})
test('literal title closing tags before soft breaks never split native owners or their mixed child ranges', () => {
  for (const type of ['callout', 'toggle']) {
    const close = type === 'callout' ? '</div>' : '</summary>'
    for (const content of ['alpha' + close + '\nbeta', 'alpha' + close + '\nbeta' + close + '\ngamma',
      'alpha `fake' + close + '\n\nbeta` tail', 'alpha `fake' + close + '\n\nbeta` literal' + close + '\ngamma']) {
      const values = [block('owner', type, content), block('child', 'paragraph', 'Child', 1, 'owner'),
        block('nested', 'toggle', 'Nested', 1, 'owner'), block('grandchild', 'paragraph', 'Grandchild', 2, 'nested'), block('after', 'paragraph', 'After')]
      for (const includeBlockMetadata of [false, true]) {
        let blocks = values, rendered = ''
        for (let cycle = 0; cycle < 3; cycle++) {
          const serialized = serializeMarkdownWithBlockRanges(blocks, { includeBlockMetadata })
          if (cycle === 0) rendered = markdownEngine.render(serialized.markdown)
          else assert.equal(markdownEngine.render(serialized.markdown), rendered)
          const ranges: MarkdownBlockSourceRange[] = [], closing: MarkdownContainerClosingRange[] = []
          const parsed = parseMarkdownBlocks(serialized.markdown, ranges, closing)
          assert.deepEqual(parsed.map(value => [value.type, value.content, value.depth]), values.map(value => [value.type, value.content, value.depth]))
          assert.deepEqual(ranges, serialized.ranges)
          assert.deepEqual(closing, serialized.closingRanges)
          assert.ok(closing.every(close => ranges.every(range => range.endLine <= close.startLine || range.startLine >= close.endLine)))
          if (includeBlockMetadata) assert.deepEqual(parsed.map(value => [value.id, value.parentBlockId, value.markdownFormat]), values.map(value => [value.id, value.parentBlockId, value.markdownFormat]))
          else assert.ok(parsed.every(value => value.id === undefined))
          blocks = parsed
        }
      }
    }
  }
})