import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { parseMarkdownBlocks, serializeBlocksToMarkdown } from '../src/shared/markdown'
import { markdownEngine } from '../src/shared/markdownEngine'

const block = (id: string, content: string, type = 'paragraph', depth = 0, parentBlockId: string | null = null): DocumentBlockDraft =>
  ({ id, content, type, checked: false, depth, parentBlockId })
function withStore(run: (harness: { store: KnowbookStore; restart: () => KnowbookStore }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-native-transfer-')), path = join(root, 'workspace.sqlite')
  let store = new KnowbookStore(path)
  try { run({ store, restart() { store.destroy(); store = new KnowbookStore(path); return store } }) }
  finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
}
function create(store: KnowbookStore, title: string, blocks: DocumentBlockDraft[]) {
  const id = store.createDocument(null); store.updateDocument(id, { title, summary: '', blocks }); return id
}
function move(store: KnowbookStore, source: string, target: string, blockIds: string[]) {
  return store.moveDocumentBlocks({ fromDocumentId: source, toDocumentId: target, blockIds,
    expectedFromUpdatedAt: store.getDocumentDetail(source)!.updatedAt, expectedToUpdatedAt: store.getDocumentDetail(target)!.updatedAt })
}
function state(store: KnowbookStore) {
  const db = store.getUnsafeDatabaseHandle()
  return Object.fromEntries(['documents', 'blocks', 'document_history', 'document_block_routes', 'document_block_moves', 'markdown_link_sources', 'links']
    .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
}
function assertRoundTrips(blocks: DocumentBlockDraft[]) {
  const rendered = markdownEngine.render(serializeBlocksToMarkdown(blocks))
  for (const includeBlockMetadata of [false, true]) {
    let source = serializeBlocksToMarkdown(blocks, { includeBlockMetadata })
    const canonical = source
    for (let cycle = 0; cycle < 3; cycle++) {
      if (!includeBlockMetadata) assert.doesNotMatch(source, /knowbook:block|parentBlockId/)
      assert.equal(markdownEngine.render(source), rendered)
      const parsed = parseMarkdownBlocks(source)
      if (includeBlockMetadata) {
        assert.deepEqual(parsed.map(value => [value.id, value.parentBlockId, value.markdownFormat]), blocks.map(value => [value.id, value.parentBlockId, value.markdownFormat]))
      } else assert.ok(parsed.every(value => value.id === undefined))
      source = serializeBlocksToMarkdown(parsed, { includeBlockMetadata })
      if (includeBlockMetadata) assert.equal(source, canonical)
    }
  }
}

test('real store moves native mixed children and title bindings with stable identity, paired history and three semantic export cycles', () => withStore(harness => {
  let store = harness.store
  const source = create(store, 'NativeSource', [
    block('keep', 'Source survivor[^note]'),
    { ...block('owner', '[Local](#^keep) [Reference][ref]\nTitle[^note] `literal[^note] [Reference][ref] </div>`', 'callout'),
      tags: ['owner'], highlight: 'orange', markdownFormat: { calloutKind: 'warning', calloutIcon: 'pin', calloutTone: 'orange' } },
    block('heading', 'Mixed heading', 'heading-2', 1, 'owner'),
    { ...block('task', 'Task [Reference][ref] [^note]', 'numbered-todo', 1, 'owner'), checked: true, listStart: 7, markdownFormat: { listMarker: ')', listLoose: false } },
    block('toggle', '[Nested][ref] and [^note]', 'toggle', 1, 'owner'),
    { ...block('nested', 'Nested [local](#^keep)', 'paragraph', 2, 'toggle'), tags: ['child'], highlight: 'yellow' },
    { ...block('code', '[Reference][ref] [^note] </details> </aside>', 'code', 2, 'toggle'), language: 'text' },
    block('advanced', '[!TIP] Advanced [Reference][ref] [^note]\n\nBody `[Reference][ref] [^note]`', 'quote', 1, 'owner'),
    block('table', '<!-- knowbook:table-widths:v1 [160,null] -->\n| Link | Note |\n| - | - |\n| [Reference][ref] | [^note] |', 'table', 1, 'owner'),
    block('host', 'Moved top-level note host'),
    block('definitions', '[ref]: Other.md "Original title"\n\n[^note]: Original [Reference][ref] and [local](#^keep), nested[^inner].\n\n    Complete **paragraph**.\n\n[^inner]: Inner [asset](assets/file.pdf) `literal[^note]`')
  ])
  const target = create(store, 'NativeTarget', [block('target', 'Target[^note] [Existing][ref]\n\n[^note]: Wrong target note\n\n[ref]: WrongTarget.md\n\n[^knowbook-footnote-moved-1]: Reserved')])
  const incoming = create(store, 'NativeIncoming', [block('incoming', '[Moved](NativeSource.md#^owner) [[NativeSource#^nested|Original alias]]', 'toggle'),
    block('incoming-child', 'Child remains', 'paragraph', 1, 'incoming')])
  const before = new Map([source, target, incoming].map(id => [id, store.getDocumentDetail(id)!.blocks]))
  const originalTimes = store.getUnsafeDatabaseHandle().prepare("SELECT id,created_at FROM blocks WHERE document_id = ? AND id <> 'keep' AND id <> 'definitions' ORDER BY id").all(source)
  const result = move(store, source, target, ['owner', 'host'])
  assert.deepEqual(result.movedBlockIds, ['owner', 'heading', 'task', 'toggle', 'nested', 'code', 'advanced', 'table', 'host'])
  assert.deepEqual(result.source.blocks.map(value => value.id), ['keep', 'definitions'])
  assert.deepEqual(new Set(result.affectedDocumentIds), new Set([source, target, incoming]))
  const moved = result.target.blocks.find(value => value.id === 'owner')!
  assert.match(moved.content, /^\[Local\]\(NativeSource\.md#\^keep\) \[Reference\]\(Other\.md "Original title"\)\nTitle\[\^knowbook-footnote-moved-\d+\]/)
  assert.ok(moved.content.endsWith('`literal[^note] [Reference][ref] </div>`'))
  assert.deepEqual({ ...moved, content: before.get(source)![1].content, sortOrder: before.get(source)![1].sortOrder }, before.get(source)![1])
  const nestedToggle = result.target.blocks.find(value => value.id === 'toggle')!
  assert.match(nestedToggle.content, /^\[Nested\]\(Other\.md "Original title"\) and \[\^knowbook-footnote-moved-\d+\]$/)
  assert.equal(nestedToggle.markdownFormat, undefined)
  assert.equal(nestedToggle.parentBlockId, 'owner')
  assert.match(result.target.blocks.find(value => value.id === 'advanced')!.content, /^\[!TIP\] Advanced \[Reference\]\(Other\.md "Original title"\) \[\^knowbook-footnote-moved-\d+\]\n\nBody `\[Reference\]\[ref\] \[\^note\]`$/)
  assert.equal(result.target.blocks.find(value => value.id === 'nested')!.parentBlockId, 'toggle')
  assert.deepEqual(result.target.blocks.find(value => value.id === 'code')!, { ...before.get(source)!.find(value => value.id === 'code')!, sortOrder: result.target.blocks.find(value => value.id === 'code')!.sortOrder })
  assert.match(result.target.blocks.find(value => value.id === 'table')!.content, /^<!-- knowbook:table-widths:v1 \[160,null\] -->/)
  assert.deepEqual(store.getUnsafeDatabaseHandle().prepare("SELECT id,created_at FROM blocks WHERE document_id = ? AND id <> 'target' ORDER BY id").all(target), originalTimes)
  assert.equal(store.getDocumentDetail(incoming)!.blocks[0].content, '[Moved](NativeTarget.md#^owner) [[NativeTarget#^nested|Original alias]]')
  assert.equal(store.getBlockReference('NativeSource', '^nested')!.documentId, target)
  assert.equal(store.getBlockReference('WrongPath', '^nested'), null)
  const rendered = markdownEngine.render(serializeBlocksToMarkdown(result.target.blocks))
  assert.ok(rendered.includes('Wrong target note') && rendered.includes('href="WrongTarget.md">Existing</a>'))
  assert.ok(rendered.includes('Original <a href="Other.md" title="Original title">Reference</a>'))
  assert.ok(rendered.includes('Complete <strong>paragraph</strong>'))
  assert.ok(rendered.includes('href="NativeSource.md#%5Ekeep"'))
  assertRoundTrips(result.target.blocks)
  const after = new Map([source, target, incoming].map(id => [id, store.getDocumentDetail(id)!.blocks]))
  store = harness.restart()
  assert.equal(store.getBlockReference('NativeSource', '^nested')!.documentId, target)
  const undone = store.undoDocumentBlockMove({ operationId: result.operationId, expectedUpdatedAtByDocument: result.expectedUpdatedAtByDocument })
  for (const [id, blocks] of before) assert.deepEqual(store.getDocumentDetail(id)!.blocks, blocks)
  const redone = store.redoDocumentBlockMove({ operationId: result.operationId, expectedUpdatedAtByDocument: undone.expectedUpdatedAtByDocument })
  for (const [id, blocks] of after) assert.deepEqual(store.getDocumentDetail(id)!.blocks, blocks)
  assert.equal(redone.state, 'applied')
}))

test('real store copies moved note closure back to surviving native titles using only independent top-level paragraph hosts', () => withStore(({ store }) => {
  const source = create(store, 'NativeSource', [block('stay', 'Surviving[^note] [Ref][ref]', 'toggle'),
    block('stay-child', 'Child stays', 'paragraph', 1, 'stay'), block('source-host', 'Source host'),
    block('owner', 'Moved[^note] [Ref][ref]', 'callout'), block('child', 'Mixed child', 'paragraph', 1, 'owner'),
    block('move-host', 'Moved host\n\n[^note]: Original [Ref][ref] and nested[^inner]\n\n[^inner]: Nested [local](#^source-host)\n\n[ref]: Neighbor.md')])
  const target = create(store, 'NativeTarget', [block('target', 'Existing[^note] [Ref][ref]\n\n[^note]: Target only\n\n[ref]: Wrong.md')])
  const result = move(store, source, target, ['owner', 'move-host'])
  assert.match(result.source.blocks[0].content, /^Surviving\[\^knowbook-footnote-source-\d+\] \[Ref\]\(Neighbor\.md\)$/)
  const sourceHost = result.source.blocks.find(value => value.id === 'source-host')!
  assert.equal((sourceHost.content.match(/\[\^knowbook-footnote-source-\d+\]:/g) ?? []).length, 2)
  assert.match(result.target.blocks.find(value => value.id === 'owner')!.content, /^Moved\[\^knowbook-footnote-moved-\d+\] \[Ref\]\[knowbook-moved-\d+\]$/)
  const sourceHtml = markdownEngine.render(serializeBlocksToMarkdown(result.source.blocks)), targetHtml = markdownEngine.render(serializeBlocksToMarkdown(result.target.blocks))
  assert.ok(sourceHtml.includes('Original <a href="Neighbor.md">Ref</a>'))
  assert.ok(targetHtml.includes('Original <a href="Neighbor.md">Ref</a>'))
  assert.ok(targetHtml.includes('Target only') && targetHtml.includes('href="Wrong.md">Ref</a>'))
  assert.ok(sourceHtml.includes('href="#%5Esource-host"'))
  assert.ok(targetHtml.includes('href="NativeSource.md#%5Esource-host"'))
  assertRoundTrips(result.source.blocks); assertRoundTrips(result.target.blocks)
}))

test('real store refuses native title note copying without the existing safe paragraph hosts and rolls back every participant', () => {
  for (const boundary of ['target-host', 'source-definition']) withStore(({ store }) => {
    const source = create(store, 'NativeSource', [block('owner', 'Title[^note]', 'toggle'),
      block('child', 'Mixed child', 'paragraph', 1, 'owner'),
      ...(boundary === 'source-definition' ? [block('host', 'Moved top-level host'), block('definition-owner', 'Surviving definition owner', 'callout'),
        block('nested-definition', '[^note]: Nested unsafe definition', 'paragraph', 1, 'definition-owner')] : []),
      block('definitions', boundary === 'source-definition' ? 'Unrelated' : '[^note]: Safe source definition')])
    const target = create(store, 'NativeTarget', [block('target', 'Target remains')])
    create(store, 'Incoming', [block('incoming', '[Moved](NativeSource.md#^owner)', 'callout')])
    const before = state(store)
    assert.throws(() => move(store, source, target, boundary === 'source-definition' ? ['owner', 'host'] : ['owner']), /脚注定义.*未移动任何块/)
    assert.deepEqual(state(store), before)
  })
})