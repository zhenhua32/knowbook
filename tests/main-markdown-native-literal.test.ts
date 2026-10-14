import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownRestoreService } from '../src/main/backup/importer'
import { MarkdownBackupService } from '../src/main/backup/exporter'
import { buildDraftMarkdownExport } from '../src/renderer/src/utils/documentMarkdown'
import { parseMarkdownBlocks, serializeBlocksToMarkdown } from '../src/shared/markdown'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { NATIVE_LITERAL_MARKER as marker } from '../src/shared/markdownNativeText'
import type { DocumentBlockDraft } from '../src/shared/contracts'

const block = (id: string, type: string, content: string, depth = 0, parentBlockId: string | null = null, extra: Partial<DocumentBlockDraft> = {}): DocumentBlockDraft =>
  ({ id, type, content, depth, parentBlockId, checked: false, ...extra })
const literal = marker + '&lt;/aside&gt; ' + marker.repeat(2) + '&lt;/summary&gt; \\</div> &lt;/details&gt; &amp;lt;/div&amp;gt;'
function forest(): DocumentBlockDraft[] {
  return [block('owner', 'callout', '[Before](Guide.md#one) alpha</div>\n\nbeta</summary>\n</aside>\n</details>\n[After](Guide.md#two) ' + literal,
    0, null, { tags: ['owner'], highlight: 'blue', markdownFormat: { calloutKind: 'warning', calloutIcon: 'pin', calloutTone: 'orange' } }),
  block('closer', 'paragraph', '</aside>', 1, 'owner', { tags: ['child'], highlight: 'yellow' }),
  block('heading', 'heading-1', 'Literal title', 1, 'owner'),
  block('nested', 'toggle', 'Nested</summary>\n\n[After](Guide.md#three) ' + literal, 1, 'owner'),
  block('leaf', 'paragraph', '</details>', 2, 'nested'),
  block('code', 'code', marker + '&lt;/aside&gt;\n</aside>\n</details>', 2, 'nested', { language: 'text' }),
  block('math', 'math', marker + '&lt;/aside&gt;\n</aside>', 2, 'nested'),
  block('legacy', 'html', '<details>\n<summary>Legacy</summary>\n\n<details data-knowbook-container="toggle-v1" data-knowbook-escape="literal-v1">\n<summary>Inner ' + marker + '&lt;/aside&gt;</summary>\n\n' + marker + '&lt;/aside&gt;\n\n</details>\n\n</details>', 1, 'owner'),
  block('figure', 'html', '<figure><img src="image.png" alt="Alt"><figcaption>' + marker + '&lt;/aside&gt; Caption</figcaption></figure>', 1, 'owner'),
  block('after', 'paragraph', 'Outside ' + literal)]
}
const structure = (blocks: DocumentBlockDraft[]) => blocks.map(value => [value.type, value.content, value.depth])
function read(store: KnowbookStore) {
  const document = store.getAllDocumentSnapshots().find(document => document.title === 'Literal title')
  assert.ok(document); return store.getDocumentDetail(document.id)!
}

test('literal native closers and marker/entity examples survive three real plain-file cycles with fresh IDs and one page H1', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-native-literal-plain-')), stores: KnowbookStore[] = []
  try {
    const initial = new KnowbookStore(join(root, 'initial.sqlite')); stores.push(initial)
    const id = initial.createDocument(null); initial.updateDocument(id, { title: 'Literal title', summary: '', blocks: forest() })
    const expected = read(initial).blocks
    let source = buildDraftMarkdownExport(read(initial)).markdown, previousIds = new Set(expected.map(block => block.id))
    for (let cycle = 0; cycle < 3; cycle++) {
      assert.doesNotMatch(source, /knowbook:block|parentBlockId/)
      const input = join(root, 'input-' + cycle); mkdirSync(input); writeFileSync(join(input, 'Literal title.md'), source)
      const restored = new KnowbookStore(join(root, 'plain-' + cycle + '.sqlite')); stores.push(restored)
      await new MarkdownRestoreService(restored).restoreFromDirectory(input)
      const actual = read(restored)
      assert.deepEqual(structure(actual.blocks), structure(expected))
      assert.equal(actual.blocks.filter(block => block.type === 'heading-1' && block.content === 'Literal title').length, 1)
      assert.equal(actual.blocks[1].parentBlockId, actual.blocks[0].id)
      assert.equal(actual.blocks[4].parentBlockId, actual.blocks[3].id)
      assert.ok(actual.blocks.every(block => !previousIds.has(block.id)))
      previousIds = new Set(actual.blocks.map(block => block.id))
      assert.deepEqual(collectDocumentMarkdownLinks(actual.blocks).filter(link => link.kind === 'link').map(link => actual.blocks[link.blockIndex].content.slice(link.start, link.end)), ['Guide.md#one', 'Guide.md#two', 'Guide.md#three'])
      source = buildDraftMarkdownExport(actual).markdown
    }
  } finally { for (const store of stores) store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('three real native-literal backup exports retain exact stable IDs, parents, tags, formats and raw legacy/code source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-native-literal-backup-')), stores: KnowbookStore[] = []
  try {
    let store = new KnowbookStore(join(root, 'initial.sqlite')); stores.push(store)
    const id = store.createDocument(null); store.updateDocument(id, { title: 'Literal title', summary: 'Summary', blocks: forest() })
    const expected = read(store)
    for (let cycle = 0; cycle < 3; cycle++) {
      const directory = join(root, 'backup-' + cycle)
      await new MarkdownBackupService(store, directory).exportAll()
      const source = readFileSync(join(directory, 'Literal title.md'), 'utf8')
      assert.equal((source.match(/<!-- knowbook:block /g) ?? []).length, expected.blocks.length)
      const restored = new KnowbookStore(join(root, 'restored-' + cycle + '.sqlite')); stores.push(restored)
      await new MarkdownRestoreService(restored).restoreFromDirectory(directory)
      const actual = read(restored)
      assert.equal(actual.summary, expected.summary); assert.deepEqual(actual.blocks, expected.blocks)
      assert.equal(actual.blocks[3].markdownFormat, undefined)
      const plain = serializeBlocksToMarkdown(actual.blocks), parsed = parseMarkdownBlocks(plain)
      assert.deepEqual(parsed.map(block => [block.type, block.content, block.depth]), structure(expected.blocks))
      store = restored
    }
  } finally { for (const store of stores) store.destroy(); rmSync(root, { recursive: true, force: true }) }
})