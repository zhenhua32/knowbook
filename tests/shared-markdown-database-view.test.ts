import assert from 'node:assert/strict'
import test from 'node:test'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { parseDatabaseViewPayload, serializeDatabaseViewPayload, assertDatabaseViewStructure } from '../src/shared/databaseViewBlock'
import { renderDatabaseViewFence, hasMarkdownDatabaseViewTokens } from '../src/shared/markdownDatabaseView'
import { parseMarkdownBlocks, serializeBlocksToMarkdown, serializeMarkdownWithBlockRanges, type MarkdownRenderableBlock } from '../src/shared/markdown'
import { markdownEngine } from '../src/shared/markdownEngine'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument'
import { collectDocumentMarkdownLinks, rewriteDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { requiresDatabaseViewProtocol, validateRecord, type SyncDocument } from '../src/main/sync/model'
import { mergeSyncDocument } from '../src/main/sync/merge'

const payload = () => ({ version: 1 as const, databaseId: 'source-db', viewId: 'saved-view', config: {
  ...createDefaultDatabaseViewConfig('table'), query: '``` </div> [Literal](file:///private/a.md) <!-- knowbook-native-text:v1 -->'
} })
const atom = (): MarkdownRenderableBlock => ({ id: 'view-atom', type: 'database-view', content: serializeDatabaseViewPayload(payload()),
  checked: false, depth: 0, parentBlockId: null, tags: ['metadata'], highlight: 'blue' })
const shape = (blocks: MarkdownRenderableBlock[]) => blocks.map(block => [block.type, block.content, block.depth ?? 0, !!block.checked, block.language, block.markdownFormat])
const sync = (blocks: MarkdownRenderableBlock[]): SyncDocument => ({ kind: 'document', id: 'document', parentId: null, sortOrder: 0,
  createdAt: '2026-10-15T00:00:00.000Z', content: { title: 'Database host', summary: '', blocks: blocks as SyncDocument['content']['blocks'] } })

test('database view atoms retain complete configuration through three plain and backup cycles in mixed native forests', () => {
  const forest: MarkdownRenderableBlock[] = [
    { id: 'owner', type: 'toggle', content: 'Owner', checked: false, depth: 0, markdownFormat: { toggleDefaultOpen: false } },
    { ...atom(), depth: 1, parentBlockId: 'owner' }, { id: 'tail', type: 'paragraph', content: 'After', checked: false, depth: 0 }
  ]
  for (const includeBlockMetadata of [false, true]) {
    let blocks = forest
    for (let cycle = 0; cycle < 3; cycle++) {
      const source = serializeBlocksToMarkdown(blocks, { includeBlockMetadata })
      blocks = parseMarkdownBlocks(source.replace(/\n/g, '\r\n'))
      assert.deepEqual(shape(blocks), shape(forest))
      if (includeBlockMetadata) {
        assert.equal(blocks[1].id, 'view-atom'); assert.equal(blocks[1].parentBlockId, 'owner')
        assert.deepEqual(blocks[1].tags, ['metadata']); assert.equal(blocks[1].highlight, 'blue')
      }
      const model = parseMarkdownDocumentBlocks(blocks)
      assert.equal(model.blockNodes[1][0].token.type, 'knowbook_database_view')
      assert.deepEqual(model.blockNodes[1][0].token.meta?.databaseViewPayload, payload())
    }
  }
})

test('fence length, token source map and block ranges cover the exact finite atom without leaking records or metadata', () => {
  const original = atom(), source = renderDatabaseViewFence(original.content)
  assert.ok(source.startsWith('````knowbook-database-view-v1\n'))
  const tokens = markdownEngine.parse(source, {})
  assert.equal(tokens.length, 1); assert.equal(tokens[0].type, 'knowbook_database_view')
  assert.deepEqual(tokens[0].map, [0, 3]); assert.equal(tokens[0].content, original.content)
  const rendered = serializeMarkdownWithBlockRanges([original])
  assert.equal(rendered.markdown, source); assert.deepEqual(rendered.ranges, [{ index: 0, startLine: 0, endLine: 3 }])
  assert.deepEqual(collectDocumentMarkdownLinks([original]), [])
  assert.deepEqual(rewriteDocumentMarkdownLinks([original], () => 'changed.md'), [original])
  assert.doesNotMatch(markdownEngine.render(source), /<a |<script/)
})

test('reserved fences remain literal inside outer code, quote, list, footnote and unmarked legacy HTML', () => {
  const finite = renderDatabaseViewFence(atom().content)
  for (const source of ['~~~~~markdown\n' + finite + '\n~~~~~', finite.split('\n').map(line => '> ' + line).join('\n'),
    '- Body\n\n' + finite.split('\n').map(line => '  ' + line).join('\n'),
    'Ref[^n]\n\n[^n]: Body\n\n' + finite.split('\n').map(line => '    ' + line).join('\n'),
    '<details>\n<summary>Legacy</summary>\n\n' + finite + '\n\n</details>']) {
    assert.equal(hasMarkdownDatabaseViewTokens(markdownEngine.parse(source, {})), false, source)
    assert.equal(parseMarkdownBlocks(source).some(block => block.type === 'database-view'), false, source)
  }
})

test('unknown or malformed actual reserved atoms fail before Markdown or backup can discard their authored data', () => {
  const finite = renderDatabaseViewFence(atom().content)
  for (const source of [finite.replace('view-v1', 'view-v2'), finite.replace('view-v1', 'view-v1 extra'), finite.slice(0, finite.lastIndexOf('\n')),
    finite.replace('"version":1', '"version":1,"version":1'), finite.replace('"databaseId":"source-db"', '"databaseId":null'),
    '<!-- knowbook:block {"type":"paragraph"} -->\n' + finite,
    '<!-- knowbook:block {"type":"database-view","markdownFormat":{}} -->\n' + finite,
    '<!-- knowbook:block {"type":"database-view","id":123,"depth":"2","parentBlockId":123} -->\n' + finite,
    '<!-- knowbook:block {"type":"database-view","depth":-1} -->\n' + finite,
    '<!-- knowbook:block {"type":"database-view"} -->\n' + finite + '\n\nExtra paragraph']) {
    assert.throws(() => parseMarkdownBlocks(source), Error, source)
  }
})

test('database atoms are leaves at root or within titled containers and columns, and malformed attributes are never normalized away', () => {
  for (const extra of [{ checked: true }, { language: 'json' }, { listStart: 1 }, { markdownFormat: {} }, { depth: 1 }, { parentBlockId: 'closed' }]) {
    assert.throws(() => serializeBlocksToMarkdown([{ ...atom(), ...extra }]))
  }
  for (const blocks of [[atom(), { id: 'child', type: 'paragraph', content: 'Child', depth: 1, parentBlockId: 'view-atom' }],
    [{ id: 'list', type: 'bulleted-list', content: 'List', depth: 0 }, { ...atom(), depth: 1, parentBlockId: 'list' }]]) {
    assert.throws(() => assertDatabaseViewStructure(blocks))
  }
})

test('protocol4 detects actual finite source in full context, validates typed atoms and rejects typed fast path bypasses', () => {
  assert.equal(requiresDatabaseViewProtocol(sync([atom()])), true)
  for (const protocol of [1, 2, 3] as const) assert.throws(() => validateRecord(sync([atom()]), 'doc:document', protocol), /文内数据库/)
  assert.doesNotThrow(() => validateRecord(sync([atom()]), 'doc:document', 4))
  const actual = { id: 'hidden', type: 'paragraph', content: renderDatabaseViewFence(atom().content), checked: false, depth: 0 }
  assert.equal(requiresDatabaseViewProtocol(sync([actual])), true)
  assert.equal(requiresDatabaseViewProtocol(sync([{ ...actual, type: 'quote' }])), false)
  assert.throws(() => requiresDatabaseViewProtocol(sync([atom(), { ...actual, content: actual.content.replace('view-v1', 'view-v9') }])))
})

test('concurrent database configuration changes remain atomic and custom text cannot create a third database identity', () => {
  const base = sync([atom(), { id: 'body', type: 'paragraph', content: 'Body', depth: 0, checked: false }])
  const local = structuredClone(base), remote = structuredClone(base)
  const a = parseDatabaseViewPayload(local.content.blocks[0].content), b = parseDatabaseViewPayload(remote.content.blocks[0].content)
  a.databaseId = 'other-a'; b.databaseId = 'other-b'; a.config.query = 'A'; b.config.query = 'B'
  local.content.blocks[0].content = serializeDatabaseViewPayload(a); remote.content.blocks[0].content = serializeDatabaseViewPayload(b)
  remote.content.blocks[1].content = 'Remote body'
  const first = mergeSyncDocument(base, local, remote)
  assert.equal(first.unresolved.length, 1); assert.equal(first.unresolved[0].canEditText, false)
  assert.equal(first.document.content.blocks[0].content, local.content.blocks[0].content)
  assert.equal(first.document.content.blocks[1].content, 'Remote body')
  const key = first.unresolved[0].id
  assert.equal(mergeSyncDocument(base, local, remote, { [key]: { choice: 'custom', text: atom().content } }).unresolved.length, 1)
  const chosen = mergeSyncDocument(base, local, remote, { [key]: { choice: 'remote' } })
  assert.equal(chosen.unresolved.length, 0); assert.equal(chosen.document.content.blocks[0].content, remote.content.blocks[0].content)
})
