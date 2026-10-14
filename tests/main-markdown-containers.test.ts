import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownRestoreService } from '../src/main/backup/importer'
import { MarkdownBackupService } from '../src/main/backup/exporter'
import { buildDraftMarkdownExport } from '../src/renderer/src/utils/documentMarkdown'
import { serializeBlocksToMarkdown } from '../src/shared/markdown'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument'
import type { DocumentBlockDraft } from '../src/shared/contracts'

const body: DocumentBlockDraft[] = [
  { id: 'yaml', type: 'frontmatter', content: '---\ncustom: "user YAML"\n---', checked: false, depth: 0 },
  { id: 'owner', type: 'callout', content: 'Callout [Title][guide]\n**second line**', checked: false, depth: 0, markdownFormat: { calloutKind: 'warning', calloutIcon: 'pin', calloutTone: 'orange' } },
  { id: 'heading', type: 'heading-1', content: 'Native', checked: false, depth: 1, parentBlockId: 'owner' },
  { id: 'task', type: 'numbered-todo', content: 'Task [^n]', checked: true, depth: 1, parentBlockId: 'owner', listStart: 7, markdownFormat: { listMarker: ')', listLoose: false } },
  { id: 'nested-list', type: 'bulleted-list', content: 'Nested', checked: false, depth: 2, parentBlockId: 'task', markdownFormat: { listMarker: '+', listLoose: false } },
  { id: 'toggle', type: 'toggle', content: 'Toggle `</summary>`', checked: false, depth: 1, parentBlockId: 'owner' },
  { id: 'child', type: 'paragraph', content: 'Body [^n]', checked: false, depth: 2, parentBlockId: 'toggle', tags: ['keep'], highlight: 'yellow' },
  { id: 'code', type: 'code', content: '</details>\n</aside>', checked: false, depth: 2, parentBlockId: 'toggle', language: 'text', markdownFormat: { codeInfo: 'text' } },
  { id: 'table', type: 'table', content: '<!-- knowbook:table-widths:v1 [160,null] -->\n| A | B |\n| - | - |\n| [Guide][guide] | X |', checked: false, depth: 1, parentBlockId: 'owner' },
  { id: 'definitions', type: 'paragraph', content: '[guide]: Guide.md#heading\n\n[^n]: Definition', checked: false, depth: 1, parentBlockId: 'owner' },
  { id: 'after', type: 'paragraph', content: 'After', checked: false, depth: 0 }
]
function document(store: KnowbookStore) {
  const snapshot = store.getAllDocumentSnapshots().find(value => value.path === 'Native')
  assert.ok(snapshot)
  return store.getDocumentDetail(snapshot.id)!
}

test('native mixed trees survive three real plain-file cycles with a single page title and fresh identities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-native-plain-')), stores: KnowbookStore[] = []
  try {
    const initial = new KnowbookStore(join(root, 'initial.sqlite')); stores.push(initial)
    const id = initial.createDocument(null); initial.updateDocument(id, { title: 'Native', summary: '', blocks: body })
    let source = buildDraftMarkdownExport(document(initial)).markdown, canonical = '', previousIds = new Set<string>()
    for (let cycle = 0; cycle < 3; cycle++) {
      assert.doesNotMatch(source, /knowbook:block|parentBlockId|"id"|id="owner"/)
      const input = join(root, 'input-' + cycle); mkdirSync(input)
      writeFileSync(join(input, 'Native.md'), source)
      assert.equal(readFileSync(join(input, 'Native.md'), 'utf8'), source)
      const store = new KnowbookStore(join(root, 'plain-' + cycle + '.sqlite')); stores.push(store)
      await new MarkdownRestoreService(store).restoreFromDirectory(input)
      const value = document(store)
      assert.equal(value.blocks.length, body.length)
      assert.equal(value.blocks[0].content, body[0].content)
      assert.equal(value.blocks.filter(block => block.type === 'heading-1' && block.content === 'Native').length, 1, 'only the nested body heading survives; the exported page H1 is removed')
      assert.deepEqual(value.blocks.map(block => block.type), body.map(block => block.type))
      assert.deepEqual(value.blocks.map(block => block.depth), body.map(block => block.depth))
      assert.equal(value.blocks[2].parentBlockId, value.blocks[1].id)
      assert.equal(value.blocks[6].parentBlockId, value.blocks[5].id)
      assert.ok(value.blocks.every(block => !previousIds.has(block.id)))
      previousIds = new Set(value.blocks.map(block => block.id))
      const written = serializeBlocksToMarkdown(value.blocks)
      if (cycle === 0) canonical = written
      else assert.equal(written, canonical)
      const model = parseMarkdownDocumentBlocks(value.blocks, value.title)
      assert.equal(model.footnoteOrigins.size, 2)
      assert.equal(model.headings.filter(heading => heading.text === 'Native').length, 1)
      source = buildDraftMarkdownExport(value).markdown
    }
  } finally { for (const store of stores) store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('three real backup exports and restores keep exact native block identities, parents and absent default format', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-native-backup-')), stores: KnowbookStore[] = []
  try {
    let store = new KnowbookStore(join(root, 'initial.sqlite')); stores.push(store)
    const id = store.createDocument(null); store.updateDocument(id, { title: 'Native', summary: 'Summary', blocks: body })
    const expected = document(store)
    assert.equal(expected.blocks[5].markdownFormat, undefined)
    for (let cycle = 0; cycle < 3; cycle++) {
      const directory = join(root, 'backup-' + cycle)
      await new MarkdownBackupService(store, directory).exportAll()
      const written = readFileSync(join(directory, 'Native.md'), 'utf8')
      assert.equal((written.match(/<!-- knowbook:block /g) ?? []).length, body.length)
      const restored = new KnowbookStore(join(root, 'restored-' + cycle + '.sqlite')); stores.push(restored)
      await new MarkdownRestoreService(restored).restoreFromDirectory(directory)
      const actual = document(restored)
      assert.equal(actual.title, expected.title)
      assert.equal(actual.summary, expected.summary)
      assert.deepEqual(actual.blocks, expected.blocks)
      assert.equal(actual.blocks[5].markdownFormat, undefined)
      store = restored
    }
  } finally { for (const store of stores) store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('invalid marked input and contradictory backup ownership never mutate existing knowledge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-native-invalid-')), store = new KnowbookStore(join(root, 'workspace.sqlite'))
  try {
    const id = store.createDocument(null); store.updateDocument(id, { title: 'Native', summary: 'Keep', blocks: body })
    const before = store.getAllDocumentSnapshots(), input = join(root, 'input'); mkdirSync(input)
    const cases = [
      '<details data-knowbook-container="toggle-v1">\n<summary>Broken</summary>\n\nBody',
      serializeBlocksToMarkdown(document(store).blocks, { includeBlockMetadata: true }).replace('"parentBlockId":"owner"', '"parentBlockId":"foreign"')
    ]
    for (const source of cases) {
      writeFileSync(join(input, 'Native.md'), source)
      await assert.rejects(new MarkdownRestoreService(store).restoreFromDirectory(input), /Invalid native Markdown container/)
      assert.deepEqual(store.getAllDocumentSnapshots(), before)
    }
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})
