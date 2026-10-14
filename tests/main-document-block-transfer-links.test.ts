import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { MarkdownLinkIndex, type MarkdownIndexedDocument } from '../src/main/database/markdown-link-index'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'

const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })
function fixture(run: (db: Database.Database, index: MarkdownLinkIndex, documents: Map<string, MarkdownIndexedDocument>, save: (document: MarkdownIndexedDocument) => void) => void) {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, path TEXT UNIQUE, title TEXT);
    CREATE TABLE blocks (id TEXT PRIMARY KEY, document_id TEXT, type TEXT, content TEXT, checked INTEGER, depth INTEGER,
      parent_block_id TEXT, sort_order INTEGER, language TEXT, list_start INTEGER, markdown_format_json TEXT);
    CREATE TABLE markdown_link_sources (source_document_id TEXT, source_block_id TEXT, source_offset INTEGER, url TEXT,
      kind TEXT, target_path TEXT, fragment TEXT, PRIMARY KEY(source_block_id, source_offset));
    CREATE INDEX idx_transfer_links_target ON markdown_link_sources(target_path);
    CREATE TABLE document_block_routes (document_path TEXT, block_id TEXT, PRIMARY KEY(document_path, block_id));`)
  const index = new MarkdownLinkIndex(db), documents = new Map<string, MarkdownIndexedDocument>()
  const save = (document: MarkdownIndexedDocument) => {
    documents.set(document.id, document)
    db.prepare('INSERT OR REPLACE INTO documents (id,path,title) VALUES (?,?,?)').run(document.id, document.path, document.title)
    db.prepare('DELETE FROM blocks WHERE document_id = ?').run(document.id)
    const insert = db.prepare(`INSERT INTO blocks (id,document_id,type,content,checked,depth,parent_block_id,sort_order,language,list_start,markdown_format_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    for (const [sortOrder, block] of document.blocks.entries()) insert.run(block.id, document.id, block.type, block.content, Number(block.checked), block.depth,
      block.parentBlockId ?? null, sortOrder, block.language ?? null, block.listStart ?? null, block.markdownFormat ? JSON.stringify(block.markdownFormat) : null)
  }
  try { run(db, index, documents, save) } finally { db.close() }
}

test('the source index plans only affected documents and preserves metadata while incoming and outgoing block routes move', () => fixture((db, index, documents, save) => {
  const source: MarkdownIndexedDocument = { id: 'from', path: 'Docs/Source', title: 'Source', blocks: [
    { ...paragraph('move', '[keep](#keep) [self](#move) [neighbor](Neighbor.md)'), tags: ['原标签'], highlight: 'blue' },
    paragraph('keep', '[[move|  bare alias]] [moved](#move) [heading](#stable)'),
    { ...paragraph('heading', 'Stable'), type: 'heading-2' }
  ] }
  const target: MarkdownIndexedDocument = { id: 'to', path: 'Archive/Target', title: 'Target', blocks: [paragraph('target', '目标原文')] }
  const incoming: MarkdownIndexedDocument = { id: 'incoming', path: 'Outside', title: 'Outside', blocks: [
    { ...paragraph('in', '[[Docs/Source#move|  原别名]] [visible](Docs/Source.md?x=1#move) [[Source#move|ambiguous]] '
      + '[doc](Docs/Source.md) [keep](Docs/Source.md#keep) [heading](Docs/Source.md#stable) '
      + '`[[Docs/Source#move]]` [web](https://example.com/Docs/Source.md#move)\n\n[Use][ref]\n\n[ref]: Docs/Source.md#move "Reference title"'),
      tags: ['Keep exact'], highlight: 'purple' }
  ] }
  for (const document of [source, target, incoming, { id: 'same-title', path: 'Other/Source', title: 'Source', blocks: [paragraph('other', 'Other')] },
    { id: 'unrelated', path: 'Unrelated', title: 'Unrelated', blocks: [paragraph('unrelated', '[[Docs/Source]] [top](Docs/Source.md)')] }]) save(document)
  for (const id of documents.keys()) index.syncDocument(id)
  const reads: string[] = []
  const updates = index.planBlockTransferReferences({ source, target, sourceBlocks: source.blocks.slice(1), targetBlocks: [...target.blocks, source.blocks[0]], movedIds: ['move'] },
    id => { reads.push(id); return documents.get(id) ?? null })
  assert.deepEqual(reads, ['incoming'])
  assert.deepEqual(updates.map(update => update.documentId), ['from', 'to', 'incoming'])
  const changed = new Map(updates.map(update => [update.documentId, update.blocks]))
  assert.equal(changed.get('to')![1].content, '[keep](../Docs/Source.md#keep) [self](#move) [neighbor](../Docs/Neighbor.md)')
  assert.deepEqual({ ...changed.get('to')![1], content: source.blocks[0].content }, source.blocks[0])
  assert.equal(changed.get('from')![0].content, '[[Archive/Target#move|  bare alias]] [moved](../Archive/Target.md#move) [heading](#stable)')
  assert.equal(changed.get('incoming')![0].content, incoming.blocks[0].content.replace('[[Docs/Source#move|  原别名]]', '[[Archive/Target#move|  原别名]]')
    .replace('](Docs/Source.md?x=1#move)', '](Archive/Target.md?x=1#move)').replace('[ref]: Docs/Source.md#move', '[ref]: Archive/Target.md#move'))
  assert.deepEqual({ ...changed.get('incoming')![0], content: incoming.blocks[0].content }, incoming.blocks[0])
  for (const update of updates) save({ ...documents.get(update.documentId)!, blocks: update.blocks })
  db.prepare('INSERT INTO document_block_routes VALUES (?,?)').run(source.path, 'move')
  for (const update of updates) index.syncDocument(update.documentId)
  assert.equal((index.resolveWiki('Docs/Source#move', 'Outside'))?.id, target.id)
  assert.equal(index.resolveWiki('Wrong/Path#move', 'Outside'), null)
  assert.deepEqual(index.check('incoming', () => null).issues.map(issue => issue.reason), ['ambiguous-reference'])
  const backSource = documents.get('to')!, backTarget = documents.get('from')!
  const back = index.planBlockTransferReferences({ source: backSource, target: backTarget, sourceBlocks: backSource.blocks.slice(0, 1),
    targetBlocks: [backSource.blocks[1], ...backTarget.blocks], movedIds: ['move'] }, id => documents.get(id) ?? null)
  const backMap = new Map(back.map(update => [update.documentId, update.blocks]))
  assert.ok(backMap.get('incoming')![0].content.includes('[[Docs/Source#move|  原别名]]'))
  assert.equal(collectDocumentMarkdownLinks(backMap.get('incoming')!).filter(link => link.url.includes('Archive/Target')).length, 0)
}))

test('history routes are exact, follow the actual owner, and never revive removed aliases or retarget heading text', () => fixture((db, index, documents, save) => {
  save({ id: 'old', path: 'Docs/Source', title: 'Source', blocks: [{ ...paragraph('heading', 'Moved fragment'), type: 'heading-2' }] })
  save({ id: 'new', path: 'Archive/Target', title: 'Target', blocks: [paragraph('move', 'Actual block')] })
  save({ id: 'wrong', path: 'Wrong', title: 'Wrong', blocks: [] })
  save({ id: 'reader', path: 'Reader', title: 'Reader', blocks: [paragraph('read', '[[Docs/Source#move]] [MD](Docs/Source.md#move) [[Docs/Source#Moved fragment]]')] })
  assert.equal(index.resolveWiki('Docs/Source#move', 'Reader')?.exists, false)
  db.prepare('INSERT INTO document_block_routes VALUES (?,?)').run('Docs/Source', 'move')
  db.prepare('INSERT INTO document_block_routes VALUES (?,?)').run('Deleted/C#Source', 'move')
  assert.deepEqual({ id: index.resolveWiki('Docs/Source#move', 'Reader')?.id, path: index.resolveWiki('Docs/Source#move', 'Reader')?.path }, { id: 'new', path: 'Archive/Target' })
  assert.equal(index.resolveWiki('Wrong#move', 'Reader')?.exists, false)
  assert.equal(index.resolveWiki('Missing#move', 'Reader'), null)
  assert.equal(index.resolveWiki('Deleted/C#Source#move|  alias', 'Reader')?.id, 'new')
  assert.equal(index.resolveWiki('Docs/Source#Moved fragment', 'Reader')?.kind, 'heading')
  index.syncDocument('reader')
  assert.equal(index.check('reader', () => null).issues.length, 0)
  assert.equal((db.prepare('SELECT target_path FROM markdown_link_sources WHERE source_block_id = ? AND kind = ?').get('read', 'link') as { target_path: string }).target_path, 'Archive/Target')
  db.prepare('DELETE FROM document_block_routes WHERE document_path = ?').run('Docs/Source')
  assert.equal(index.resolveWiki('Docs/Source#move', 'Reader')?.exists, false)
  assert.equal(index.check('reader', () => null).issues.length, 2)
  assert.equal(documents.get('new')!.blocks[0].id, 'move')
}))

test('caret and percent-encoded block fragments stay distinct from headings and exact old routes preserve incoming indexes', () => fixture((db, index, documents, save) => {
  save({ id: 'old', path: 'Source', title: 'Source', blocks: [{ ...paragraph('heading', '^not-a-block'), type: 'heading-2' }, paragraph('keep', 'Keeper')] })
  save({ id: 'new', path: 'Target', title: 'Target', blocks: [paragraph('move', 'Moved')] })
  save({ id: 'reader', path: 'Reader', title: 'Reader', blocks: [paragraph('read', '[a](Source.md#^move) [b](Source.md#%5Emove) [[Source#^move]] [[Source#^not-a-block]] [c](Source.md#%5Enot-a-block)')] })
  assert.equal(index.resolveWiki('Source#^not-a-block', 'Reader')?.kind, 'block')
  assert.equal(index.resolveWiki('Source#^not-a-block', 'Reader')?.exists, false)
  db.prepare('INSERT INTO document_block_routes VALUES (?,?)').run('Source', 'move')
  index.syncDocument('reader')
  const rows = db.prepare("SELECT target_path, fragment FROM markdown_link_sources WHERE source_block_id = 'read' ORDER BY source_offset").all() as Array<{ target_path: string; fragment: string }>
  assert.deepEqual(rows.slice(0, 3).map(row => row.target_path), ['Target', 'Target', 'Target'])
  assert.deepEqual(index.check('reader', () => null).issues.map(issue => issue.reason), ['missing-block', 'missing-block'])
  assert.equal(index.resolveWiki('Wrong#^move', 'Reader'), null)
  save({ id: 'destination', path: 'Destination', title: 'Destination', blocks: [paragraph('destination-block', 'Destination')] })
  const source = documents.get('new')!, target = documents.get('destination')!
  const updates = index.planBlockTransferReferences({ source, target, sourceBlocks: [], targetBlocks: [...target.blocks, source.blocks[0]], movedIds: ['move'] }, id => documents.get(id) ?? null)
  const content = updates.find(update => update.documentId === 'reader')!.blocks[0].content
  assert.ok(content.includes('[a](Destination.md#^move)'))
  assert.ok(content.includes('[b](Destination.md#%5Emove)'))
  assert.ok(content.includes('[[Destination#^move]]'))
  assert.ok(content.includes('[[Source#^not-a-block]]'))
}))
