import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { CURRENT_DATABASE_SCHEMA_VERSION } from '../src/main/database/schema-version'
import type { DocumentBlock, DocumentBlockDraft } from '../src/shared/contracts'
import type { MoveDocumentBlocksInput } from '../src/shared/document-block-moves'

type Harness = { readonly store: KnowbookStore; root: string; restart: () => KnowbookStore }
function withStore(run: (harness: Harness) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-block-transfers-'))
  const databasePath = join(root, 'knowbook.db')
  let current = new KnowbookStore(databasePath)
  const harness: Harness = {
    root,
    get store() { return current },
    restart() { current.destroy(); current = new KnowbookStore(databasePath); return current }
  }
  try { run(harness) } finally {
    current.destroy()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('knowbook-block-transfers-'))
    rmSync(root, { recursive: true, force: true })
  }
}
function block(id: string, content: string, type = 'paragraph', depth = 0, parentBlockId: string | null = null): DocumentBlockDraft {
  return { id, content, type, checked: false, depth, parentBlockId }
}
function create(store: KnowbookStore, title: string, blocks: DocumentBlockDraft[]): string {
  const id = store.createDocument(null)
  store.updateDocument(id, { title, summary: title + ' summary', blocks })
  return id
}
function seed(store: KnowbookStore) {
  const source = create(store, 'MoveSource', [
    block('src-prefix', 'source stays [moved](MoveSource.md#src-task)'),
    { ...block('src-task', 'UniqueTransferTask [survivor](#src-keep)', 'numbered-todo'),
      checked: true, tags: ['project'], highlight: 'blue', listStart: 7, markdownFormat: { listMarker: ')', listLoose: true } },
    { ...block('src-child', 'Child', 'bulleted-list', 1, 'src-task'), tags: ['child'], markdownFormat: { listMarker: '+' } },
    { ...block('src-grandchild', 'Grandchild', 'todo', 2, 'src-child'), checked: true, highlight: 'yellow' },
    block('src-keep', 'Original surviving block')
  ])
  const target = create(store, 'MoveTarget', [
    block('target-root', 'Target owner', 'todo'),
    block('target-child', 'Target child', 'todo', 1, 'target-root'),
    block('target-tail', 'Target tail')
  ])
  const incoming = create(store, 'Incoming', [block('incoming', '[moved](MoveSource.md#src-task) [[MoveSource#src-child]] [kept](MoveSource.md#src-keep) [[MoveSource#src-keep]] [[MoveSource]]')])
  const unrelated = create(store, 'Unchanged', [block('unrelated', '[kept](MoveSource.md#src-keep) [[MoveSource]]')])
  return { source, target, incoming, unrelated }
}
function input(store: KnowbookStore, source: string, target: string, extra: Partial<MoveDocumentBlocksInput> = {}): MoveDocumentBlocksInput {
  return { fromDocumentId: source, toDocumentId: target, blockIds: ['src-task'],
    expectedFromUpdatedAt: store.getDocumentDetail(source)!.updatedAt,
    expectedToUpdatedAt: store.getDocumentDetail(target)!.updatedAt, ...extra }
}
function withoutOrder(blocks: DocumentBlock[]) {
  return blocks.map(({ sortOrder: _order, ...value }) => value)
}
function state(store: KnowbookStore) {
  const db = store.getUnsafeDatabaseHandle()
  return Object.fromEntries(['documents', 'blocks', 'document_history', 'document_block_routes',
    'document_block_moves', 'markdown_link_sources', 'links'].map(table =>
    [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
}

test('real store moves complete subtrees with original IDs, metadata, timestamps and precise references', () => withStore(({ store }) => {
  const ids = seed(store), original = store.getDocumentDetail(ids.source)!
  const unrelated = store.getDocumentDetail(ids.unrelated)!
  const db = store.getUnsafeDatabaseHandle()
  const originalCreatedAt = db.prepare('SELECT id,created_at FROM blocks WHERE id IN (?, ?, ?) ORDER BY id')
    .all('src-task', 'src-child', 'src-grandchild')
  const counts = new Map([ids.source, ids.target, ids.incoming].map(id => [id, store.documentRecovery.listHistory(id).length]))
  const result = store.moveDocumentBlocks(input(store, ids.source, ids.target, { beforeBlockId: 'target-tail' }))
  assert.equal(result.state, 'applied')
  assert.deepEqual(result.movedBlockIds, ['src-task', 'src-child', 'src-grandchild'])
  assert.deepEqual(new Set(result.affectedDocumentIds), new Set([ids.source, ids.target, ids.incoming]))
  assert.deepEqual(result.source.blocks.map(value => value.id), ['src-prefix', 'src-keep'])
  assert.deepEqual(result.target.blocks.map(value => value.id), ['target-root', 'target-child', 'src-task', 'src-child', 'src-grandchild', 'target-tail'])
  assert.deepEqual(withoutOrder(result.target.blocks.filter(value => result.movedBlockIds.includes(value.id))),
    withoutOrder(original.blocks.filter(value => result.movedBlockIds.includes(value.id))).map(value =>
      value.id === 'src-task' ? { ...value, content: 'UniqueTransferTask [survivor](MoveSource.md#src-keep)' } : value))
  assert.deepEqual(db.prepare('SELECT id,created_at FROM blocks WHERE id IN (?, ?, ?) ORDER BY id').all(...result.movedBlockIds), originalCreatedAt)
  assert.match(result.source.blocks[0].content, /MoveTarget\.md#src-task/)
  const incoming = store.getDocumentDetail(ids.incoming)!
  assert.equal(incoming.blocks[0].content, '[moved](MoveTarget.md#src-task) [[MoveTarget#src-child]] [kept](MoveSource.md#src-keep) [[MoveSource#src-keep]] [[MoveSource]]')
  assert.deepEqual(store.getDocumentDetail(ids.unrelated), unrelated)
  assert.equal(store.getBlockReference('MoveSource', 'src-task')!.documentId, ids.target)
  assert.equal(store.getBlockReference('MoveTarget', 'src-task')!.documentId, ids.target)
  assert.equal(store.getBlockReference('WrongPath', 'src-task'), null)
  assert.equal(store.searchDocuments('UniqueTransferTask')[0]?.documentId, ids.target)
  assert.ok(result.target.outgoingLinks.some(value => value.id === ids.source))
  for (const id of result.affectedDocumentIds) {
    assert.equal(store.documentRecovery.listHistory(id).length, counts.get(id)! + 1)
    assert.equal(store.documentRecovery.listHistory(id)[0].reason, 'move')
  }
  const ownerCounts = db.prepare('SELECT id,block_count FROM documents WHERE id IN (?,?) ORDER BY id').all(ids.source, ids.target) as Array<{ id: string; block_count: number }>
  assert.equal(ownerCounts.find(value => value.id === ids.source)!.block_count, result.source.blocks.length)
  assert.equal(ownerCounts.find(value => value.id === ids.target)!.block_count, result.target.blocks.length)
}))

test('parent and before placement rebases moved depth without adopting existing target children', () => withStore(({ store }) => {
  const ids = seed(store)
  const result = store.moveDocumentBlocks(input(store, ids.source, ids.target, {
    parentBlockId: 'target-root', beforeBlockId: 'target-child'
  }))
  assert.deepEqual(result.target.blocks.map(value => value.id), ['target-root', 'src-task', 'src-child', 'src-grandchild', 'target-child', 'target-tail'])
  const byId = new Map(result.target.blocks.map(value => [value.id, value]))
  assert.equal(byId.get('src-task')!.parentBlockId, 'target-root')
  assert.equal(byId.get('src-task')!.depth, 1)
  assert.equal(byId.get('src-child')!.parentBlockId, 'src-task')
  assert.equal(byId.get('src-child')!.depth, 2)
  assert.equal(byId.get('src-grandchild')!.parentBlockId, 'src-child')
  assert.equal(byId.get('src-grandchild')!.depth, 3)
  assert.equal(byId.get('target-child')!.parentBlockId, 'target-root')
  assert.equal(byId.get('target-child')!.depth, 1)
}))

test('moving the complete source creates a fresh blank block whose identity survives paired undo and redo', () => withStore(({ store }) => {
  const source = create(store, 'WholeSource', [
    { ...block('whole-task', 'Whole task', 'todo'), checked: true },
    block('whole-child', 'Whole child', 'todo', 1, 'whole-task')
  ])
  const target = create(store, 'WholeTarget', [block('whole-target', 'Target')])
  const original = store.getDocumentDetail(source)!.blocks
  const moved = store.moveDocumentBlocks(input(store, source, target, { blockIds: ['whole-task'] }))
  assert.equal(moved.source.blocks.length, 1)
  const blank = moved.source.blocks[0]
  assert.equal(blank.type, 'paragraph')
  assert.equal(blank.content, '')
  assert.ok(!moved.movedBlockIds.includes(blank.id))
  const undone = store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: moved.expectedUpdatedAtByDocument })
  assert.deepEqual(undone.source.blocks, original)
  const redone = store.redoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: undone.expectedUpdatedAtByDocument })
  assert.deepEqual(redone.source.blocks, moved.source.blocks)
  assert.deepEqual(redone.target.blocks, moved.target.blocks)
}))

test('stale source or target versions and invalid subtree placements never mutate the database', () => withStore(({ store }) => {
  const ids = seed(store), before = state(store)
  const attempts: Array<Partial<MoveDocumentBlocksInput>> = [
    { expectedFromUpdatedAt: 'stale' }, { expectedToUpdatedAt: 'stale' },
    { blockIds: ['src-prefix', 'src-keep'] }, { blockIds: ['not-owned'] },
    { beforeBlockId: 'target-child' }, { parentBlockId: 'target-tail' },
    { toDocumentId: ids.source }
  ]
  for (const extra of attempts) {
    assert.throws(() => store.moveDocumentBlocks(input(store, ids.source, ids.target, extra)), /文档已变化|完整连续子树|不同的来源/)
    assert.deepEqual(state(store), before)
  }
}))

test('a failure while normalizing the target rolls back transferred rows, references, histories, aliases and journal', () => withStore(({ store }) => {
  const ids = seed(store), before = state(store), db = store.getUnsafeDatabaseHandle()
  db.exec("CREATE TEMP TRIGGER reject_transfer BEFORE UPDATE OF updated_at ON documents WHEN NEW.id = '" + ids.target +
    "' BEGIN SELECT RAISE(ABORT, 'injected transfer failure'); END")
  assert.throws(() => store.moveDocumentBlocks(input(store, ids.source, ids.target)), /injected transfer failure/)
  assert.deepEqual(state(store), before)
  assert.equal(store.getBlockReference('MoveSource', 'src-task')!.documentId, ids.source)
  assert.equal(store.getBlockReference('MoveTarget', 'src-task'), null)
  db.exec('DROP TRIGGER reject_transfer')
  assert.equal(store.moveDocumentBlocks(input(store, ids.source, ids.target)).state, 'applied')
}))

test('paired history persists across restarts, restores all references and refuses ordinary history stealing', () => withStore(harness => {
  let store = harness.store
  const ids = seed(store)
  const originals = new Map([ids.source, ids.target, ids.incoming].map(id => [id, store.documentRecovery.readContent(id)]))
  const moved = store.moveDocumentBlocks(input(store, ids.source, ids.target))
  const history = store.documentRecovery.listHistory(ids.source)[0]
  assert.equal(history.reason, 'move')
  const afterMove = state(store)
  assert.throws(() => store.restoreDocumentHistory(ids.source, history.id, moved.source.updatedAt), /历史版本中的块已移到其他文档/)
  assert.deepEqual(state(store), afterMove)
  store = harness.restart()
  const undone = store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: moved.expectedUpdatedAtByDocument })
  assert.equal(undone.state, 'undone')
  for (const [id, original] of originals) assert.deepEqual(store.documentRecovery.readContent(id), original)
  assert.equal(store.getBlockReference('MoveTarget', 'src-task')!.documentId, ids.source)
  assert.equal(store.getBlockReference('WrongPath', 'src-task'), null)
  assert.throws(() => store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: undone.expectedUpdatedAtByDocument }), /已撤销/)
  store = harness.restart()
  const redone = store.redoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: undone.expectedUpdatedAtByDocument })
  assert.equal(redone.state, 'applied')
  assert.deepEqual(redone.source.blocks, moved.source.blocks)
  assert.deepEqual(redone.target.blocks, moved.target.blocks)
  assert.equal(store.getDocumentDetail(ids.incoming)!.blocks[0].content, '[moved](MoveTarget.md#src-task) [[MoveTarget#src-child]] [kept](MoveSource.md#src-keep) [[MoveSource#src-keep]] [[MoveSource]]')
  assert.equal(store.getBlockReference('MoveSource', 'src-child')!.documentId, ids.target)
  assert.throws(() => store.redoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: redone.expectedUpdatedAtByDocument }), /已应用/)
}))

test('paired undo requires every rewritten reference document and refuses later edits on either owner or incoming document', () => {
  for (const changed of ['source', 'target', 'incoming'] as const) withStore(({ store }) => {
    const ids = seed(store), moved = store.moveDocumentBlocks(input(store, ids.source, ids.target))
    const incomplete = { ...moved.expectedUpdatedAtByDocument }
    delete incomplete[ids.incoming]
    const before = state(store)
    assert.throws(() => store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: incomplete }), /文档已变化/)
    assert.deepEqual(state(store), before)
    const detail = store.getDocumentDetail(ids[changed])!
    store.updateDocument(detail.id, { ...detail, expectedUpdatedAt: detail.updatedAt,
      blocks: detail.blocks.map((value, index) => index === 0 ? { ...value, content: value.content + ' later edit' } : value) })
    const edited = state(store)
    assert.throws(() => store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: moved.expectedUpdatedAtByDocument }), /文档已变化/)
    assert.deepEqual(state(store), edited)
  })
})

test('paired restore accepts an acknowledged new source revision only after exact semantic restoration', () => withStore(({ store }) => {
  const ids = seed(store), moved = store.moveDocumentBlocks(input(store, ids.source, ids.target))
  const semantic = store.documentRecovery.readContent(ids.source)
  store.updateDocument(ids.source, { ...semantic, expectedUpdatedAt: moved.source.updatedAt,
    blocks: semantic.blocks.map((value, index) => index === 0 ? { ...value, content: 'temporary editor change' } : value) })
  const edited = store.getDocumentDetail(ids.source)!
  store.updateDocument(ids.source, { ...semantic, expectedUpdatedAt: edited.updatedAt })
  const current = store.getDocumentDetail(ids.source)!
  assert.ok(Date.parse(current.updatedAt) > Date.parse(edited.updatedAt))
  assert.ok(Date.parse(edited.updatedAt) > Date.parse(moved.source.updatedAt))
  const acknowledged = { ...moved.expectedUpdatedAtByDocument, [ids.source]: current.updatedAt }
  const undone = store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: acknowledged })
  assert.equal(undone.state, 'undone')
  assert.equal(store.getBlockReference('MoveSource', 'src-task')!.documentId, ids.source)
}))

test('even acknowledged current revisions cannot overwrite different title, summary, tags or content', () => {
  for (const field of ['title', 'summary', 'tags', 'content'] as const) withStore(({ store }) => {
    const ids = seed(store), moved = store.moveDocumentBlocks(input(store, ids.source, ids.target))
    const semantic = store.documentRecovery.readContent(ids.source)
    store.updateDocument(ids.source, { ...semantic, expectedUpdatedAt: moved.source.updatedAt,
      ...(field === 'title' ? { title: 'ChangedTitle' } : {}),
      ...(field === 'summary' ? { summary: 'Changed summary' } : {}),
      blocks: semantic.blocks.map((value, index) => index !== 0 ? value
        : field === 'tags' ? { ...value, tags: ['later'] }
          : field === 'content' ? { ...value, content: 'Different content' } : value) })
    const acknowledged = { ...moved.expectedUpdatedAtByDocument, [ids.source]: store.getDocumentDetail(ids.source)!.updatedAt }
    const before = state(store)
    assert.throws(() => store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: acknowledged }), /文档已变化/)
    assert.deepEqual(state(store), before)
  })
})

test('same-content revisions in an incoming document still require its own caller acknowledgement', () => withStore(({ store }) => {
  const ids = seed(store), moved = store.moveDocumentBlocks(input(store, ids.source, ids.target))
  const semantic = store.documentRecovery.readContent(ids.incoming)
  store.updateDocument(ids.incoming, { ...semantic, expectedUpdatedAt: moved.expectedUpdatedAtByDocument[ids.incoming], summary: 'temporary incoming change' })
  const edited = store.getDocumentDetail(ids.incoming)!
  store.updateDocument(ids.incoming, { ...semantic, expectedUpdatedAt: edited.updatedAt })
  const before = state(store)
  assert.throws(() => store.undoDocumentBlockMove({
    operationId: moved.operationId, expectedUpdatedAtByDocument: moved.expectedUpdatedAtByDocument
  }), /文档已变化/)
  assert.deepEqual(state(store), before)
}))

test('ordinary history cannot delete transferred identities on the target or on the source after paired undo', () => withStore(({ store }) => {
  const ids = seed(store), moved = store.moveDocumentBlocks(input(store, ids.source, ids.target))
  const targetBeforeMove = store.documentRecovery.listHistory(ids.target)[0]
  const applied = state(store)
  assert.throws(() => store.restoreDocumentHistory(ids.target, targetBeforeMove.id, moved.target.updatedAt), /成对移动/)
  assert.deepEqual(state(store), applied)
  const undone = store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: moved.expectedUpdatedAtByDocument })
  const sourceAfterMove = store.documentRecovery.listHistory(ids.source)[0]
  assert.ok(!store.documentRecovery.getHistory(ids.source, sourceAfterMove.id).content.blocks.some(value => value.id === 'src-task'))
  const restored = state(store)
  assert.throws(() => store.restoreDocumentHistory(ids.source, sourceAfterMove.id, undone.source.updatedAt), /成对移动/)
  assert.deepEqual(state(store), restored)
}))

test('failure updating a paired journal rolls back all restored data and later incoming edits block redo', () => withStore(({ store }) => {
  const ids = seed(store), moved = store.moveDocumentBlocks(input(store, ids.source, ids.target))
  const db = store.getUnsafeDatabaseHandle(), before = state(store)
  db.exec("CREATE TEMP TRIGGER reject_paired BEFORE UPDATE OF state ON document_block_moves WHEN NEW.id = '" + moved.operationId +
    "' BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END")
  assert.throws(() => store.undoDocumentBlockMove({
    operationId: moved.operationId, expectedUpdatedAtByDocument: moved.expectedUpdatedAtByDocument
  }), /injected journal failure/)
  assert.deepEqual(state(store), before)
  db.exec('DROP TRIGGER reject_paired')
  const undone = store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: moved.expectedUpdatedAtByDocument })
  const incoming = store.documentRecovery.readContent(ids.incoming)
  store.updateDocument(ids.incoming, { ...incoming, expectedUpdatedAt: undone.expectedUpdatedAtByDocument[ids.incoming], summary: 'later incoming edit' })
  const edited = state(store)
  assert.throws(() => store.redoDocumentBlockMove({
    operationId: moved.operationId, expectedUpdatedAtByDocument: undone.expectedUpdatedAtByDocument
  }), /文档已变化/)
  assert.deepEqual(state(store), edited)
}))

test('canonical caret block fragments retain spelling, exact ownership, old routes and surviving heading bindings', () => withStore(({ store }) => {
  const ids = seed(store), source = store.documentRecovery.readContent(ids.source)
  store.updateDocument(ids.source, { ...source, blocks: [...source.blocks, block('source-heading', 'Heading', 'heading-2')] })
  const canonicalText = '[moved](MoveSource.md#^src-task) [[MoveSource#^src-child]] [kept](MoveSource.md#^src-keep) [[MoveSource#^src-keep]] [heading](MoveSource.md#heading)'
  const canonical = create(store, 'Canonical', [block('canonical', canonicalText)])
  assert.deepEqual(store.checkDocumentLinks(canonical, () => null).issues, [])
  const moved = store.moveDocumentBlocks(input(store, ids.source, ids.target))
  assert.ok(moved.affectedDocumentIds.includes(canonical))
  assert.equal(store.getDocumentDetail(canonical)!.blocks[0].content, '[moved](MoveTarget.md#^src-task) [[MoveTarget#^src-child]] [kept](MoveSource.md#^src-keep) [[MoveSource#^src-keep]] [heading](MoveSource.md#heading)')
  assert.deepEqual(store.checkDocumentLinks(canonical, () => null).issues, [])
  assert.equal(store.getBlockReference('MoveSource', '^src-task')!.documentId, ids.target)
  assert.equal(store.getBlockReference('MoveTarget', '^src-child')!.documentId, ids.target)
  assert.equal(store.getBlockReference('WrongPath', '^src-task'), null)
  assert.equal(store.getBlockReference('MoveSource', '^^src-task'), null)
  assert.equal(store.getBlockReference('MoveSource', '^heading'), null)
  const lateAlias = create(store, 'LateAlias', [block('late-alias', '[old](MoveSource.md#^src-task) [[MoveSource#^src-child]]')])
  assert.deepEqual(store.checkDocumentLinks(lateAlias, () => null).issues, [])
  assert.ok(store.getDocumentDetail(lateAlias)!.outgoingLinks.some(value => value.id === ids.target))
  const undone = store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: moved.expectedUpdatedAtByDocument })
  assert.equal(store.getDocumentDetail(canonical)!.blocks[0].content, canonicalText)
  assert.deepEqual(store.checkDocumentLinks(canonical, () => null).issues, [])
  assert.equal(store.getBlockReference('MoveTarget', '^src-task')!.documentId, ids.source)
  assert.equal(store.getBlockReference('MoveSource', '^src-child')!.documentId, ids.source)
  assert.equal(undone.state, 'undone')
  assert.deepEqual(store.checkDocumentLinks(lateAlias, () => null).issues, [])
  assert.ok(store.getDocumentDetail(lateAlias)!.outgoingLinks.some(value => value.id === ids.source))
  assert.equal(store.getDocumentDetail(lateAlias)!.blocks[0].content, '[old](MoveSource.md#^src-task) [[MoveSource#^src-child]]')
}))

test('runtime IPC placement fields reject null before, empty strings, arrays, objects and numbers without writes', () => withStore(({ store }) => {
  const ids = seed(store), before = state(store)
  for (const field of ['beforeBlockId', 'parentBlockId'] as const) {
    for (const value of ['', '   ', 1, false, [], {}, null]) {
      if (field === 'parentBlockId' && value === null) continue
      const request = { ...input(store, ids.source, ids.target), [field]: value } as unknown as MoveDocumentBlocksInput
      assert.throws(() => store.moveDocumentBlocks(request), /目标位置无效/)
      assert.deepEqual(state(store), before)
    }
  }
}))

test('v21 migration copies the complete old database once and preserves every document/block field', () => withStore(harness => {
  let store = harness.store
  const ids = seed(store), content = store.documentRecovery.readContent(ids.source)
  store.updateDocument(ids.source, { ...content, blocks: [...content.blocks,
    { ...block('migration-code', 'const preserved = true', 'code'), language: 'typescript',
      tags: ['code'], highlight: 'purple', markdownFormat: { codeInfo: 'ts title=example' } }] })
  const db = store.getUnsafeDatabaseHandle()
  db.exec('DROP TABLE document_block_routes; DROP TABLE document_block_moves; PRAGMA user_version = 21')
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map(value => value.name)
  const rows = (database: Database.Database) => Object.fromEntries(tables.map(table =>
    [table, database.prepare('SELECT * FROM "' + table.replaceAll('"', '""') + '"').all().map(value => JSON.stringify(value)).sort()]))
  const before = rows(db)
  const previousCopies = readdirSync(harness.root).filter(name => name.includes('.pre-migration-'))
  store = harness.restart()
  const migrated = store.getUnsafeDatabaseHandle()
  assert.equal(migrated.pragma('user_version', { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION)
  assert.deepEqual(rows(migrated), before)
  assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM document_block_moves').get() as { count: number }).count, 0)
  assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM document_block_routes').get() as { count: number }).count, 0)
  const copies = readdirSync(harness.root).filter(name => name.includes('.pre-migration-'))
  const newCopies = copies.filter(name => !previousCopies.includes(name))
  assert.equal(newCopies.length, 1)
  assert.ok(newCopies[0].startsWith(`knowbook.db.pre-migration-v21-to-v${CURRENT_DATABASE_SCHEMA_VERSION}-`))
  const safety = new Database(join(harness.root, newCopies[0]), { readonly: true })
  try {
    assert.equal(safety.pragma('user_version', { simple: true }), 21)
    assert.deepEqual(rows(safety), before)
    assert.equal(safety.prepare("SELECT name FROM sqlite_master WHERE name IN ('document_block_moves','document_block_routes')").all().length, 0)
  } finally { safety.close() }
  store = harness.restart()
  assert.equal(store.getUnsafeDatabaseHandle().pragma('user_version', { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION)
  assert.deepEqual(rows(store.getUnsafeDatabaseHandle()), before)
  assert.deepEqual(readdirSync(harness.root).filter(name => name.includes('.pre-migration-')).sort(), copies.sort())
}))

test('paired move history is available from both owners across restarts and exposes exact immutable before/after blocks for undo and redo', () => withStore(harness => {
  let store = harness.store
  const ids = seed(store), before = new Map([ids.source, ids.target, ids.incoming].map(id => [id, store.documentRecovery.readContent(id)]))
  assert.equal(store.getDocumentBlockMoveHistory(ids.source), null)
  assert.equal(store.getDocumentBlockMoveHistory(ids.target), null)
  assert.equal(store.getDocumentBlockMoveHistory('missing-document'), null)
  const moved = store.moveDocumentBlocks(input(store, ids.source, ids.target))
  const after = new Map([ids.source, ids.target, ids.incoming].map(id => [id, store.documentRecovery.readContent(id)]))
  const sourceHistory = store.getDocumentBlockMoveHistory(ids.source)!, targetHistory = store.getDocumentBlockMoveHistory(ids.target)!
  assert.ok(sourceHistory); assert.ok(targetHistory)
  assert.equal(sourceHistory.operationId, moved.operationId)
  assert.equal(targetHistory.operationId, moved.operationId)
  assert.equal(sourceHistory.state, 'applied')
  assert.equal(targetHistory.state, 'applied')
  assert.deepEqual(sourceHistory.beforeBlocks, before.get(ids.source)!.blocks)
  assert.deepEqual(sourceHistory.afterBlocks, after.get(ids.source)!.blocks)
  assert.deepEqual(targetHistory.beforeBlocks, before.get(ids.target)!.blocks)
  assert.deepEqual(targetHistory.afterBlocks, after.get(ids.target)!.blocks)
  assert.deepEqual(sourceHistory.expectedUpdatedAtByDocument, moved.expectedUpdatedAtByDocument)
  assert.deepEqual(targetHistory.expectedUpdatedAtByDocument, moved.expectedUpdatedAtByDocument)
  assert.ok(sourceHistory.expectedUpdatedAtByDocument[ids.incoming], 'the visible owner entry acknowledges all rewritten reference documents')
  assert.equal(store.getDocumentBlockMoveHistory(ids.incoming), null, 'incoming references are participants without being a block owner')
  assert.equal(store.getDocumentBlockMoveHistory(ids.unrelated), null)
  const unchanged = state(store)
  store.getDocumentBlockMoveHistory(ids.source); store.getDocumentBlockMoveHistory(ids.target)
  assert.deepEqual(state(store), unchanged, 'opening the history entry must not checkpoint or write revisions')

  store = harness.restart()
  assert.deepEqual(store.getDocumentBlockMoveHistory(ids.source), sourceHistory)
  assert.deepEqual(store.getDocumentBlockMoveHistory(ids.target), targetHistory)
  const unrelated = store.documentRecovery.readContent(ids.unrelated)
  store.updateDocument(ids.unrelated, { ...unrelated, summary: 'Unrelated later summary' })
  assert.deepEqual(store.getDocumentBlockMoveHistory(ids.source), sourceHistory)
  const undone = store.undoDocumentBlockMove({ operationId: sourceHistory.operationId, expectedUpdatedAtByDocument: sourceHistory.expectedUpdatedAtByDocument })
  for (const [id, content] of before) assert.deepEqual(store.documentRecovery.readContent(id), content)
  for (const id of [ids.source, ids.target]) {
    const history = store.getDocumentBlockMoveHistory(id)!
    assert.equal(history.operationId, moved.operationId)
    assert.equal(history.state, 'undone')
    assert.deepEqual(history.beforeBlocks, before.get(id)!.blocks)
    assert.deepEqual(history.afterBlocks, after.get(id)!.blocks)
    assert.deepEqual(history.expectedUpdatedAtByDocument, undone.expectedUpdatedAtByDocument)
  }
  store = harness.restart()
  const redoHistory = store.getDocumentBlockMoveHistory(ids.target)!
  assert.equal(redoHistory.state, 'undone')
  const redone = store.redoDocumentBlockMove({ operationId: redoHistory.operationId, expectedUpdatedAtByDocument: redoHistory.expectedUpdatedAtByDocument })
  for (const [id, content] of after) assert.deepEqual(store.documentRecovery.readContent(id), content)
  for (const id of [ids.source, ids.target]) {
    const history = store.getDocumentBlockMoveHistory(id)!
    assert.equal(history.state, 'applied')
    assert.equal(history.operationId, moved.operationId)
    assert.deepEqual(history.beforeBlocks, before.get(id)!.blocks)
    assert.deepEqual(history.afterBlocks, after.get(id)!.blocks)
    assert.deepEqual(history.expectedUpdatedAtByDocument, redone.expectedUpdatedAtByDocument)
  }
}))

test('changes to any participant body, path, title, summary, block metadata or deletion disable both owner history entries in either state', () => {
  const changes: Array<[string, (store: KnowbookStore, id: string) => void]> = [
    ['body', (store, id) => {
      const content = store.documentRecovery.readContent(id)
      store.updateDocument(id, { ...content, blocks: content.blocks.map((block, index) => index === 0 ? { ...block, content: block.content + ' changed body' } : block) })
    }],
    ['path', (store, id) => { const parent = create(store, 'History changed parent', [block('history-new-parent', 'Parent')]); store.moveDocument(id, parent) }],
    ['title', (store, id) => { const content = store.documentRecovery.readContent(id); store.updateDocument(id, { ...content, title: 'History changed title' }) }],
    ['summary', (store, id) => { const content = store.documentRecovery.readContent(id); store.updateDocument(id, { ...content, summary: 'History changed summary' }) }],
    ['metadata', (store, id) => {
      const content = store.documentRecovery.readContent(id)
      store.updateDocument(id, { ...content, blocks: content.blocks.map((block, index) => index === 0 ? { ...block, tags: ['later metadata'], highlight: 'purple' } : block) })
    }],
    ['deleted', (store, id) => { store.deleteDocument(id) }]
  ]
  for (const phase of ['applied', 'undone'] as const) for (const participant of ['source', 'target', 'incoming'] as const) {
    for (const [field, change] of changes) withStore(({ store }) => {
      const ids = seed(store), moved = store.moveDocumentBlocks(input(store, ids.source, ids.target))
      if (phase === 'undone') store.undoDocumentBlockMove({ operationId: moved.operationId, expectedUpdatedAtByDocument: moved.expectedUpdatedAtByDocument })
      assert.ok(store.getDocumentBlockMoveHistory(ids.source))
      assert.ok(store.getDocumentBlockMoveHistory(ids.target))
      change(store, ids[participant])
      const changed = state(store)
      assert.equal(store.getDocumentBlockMoveHistory(ids.source), null, phase + ' ' + participant + ' ' + field + ' source')
      assert.equal(store.getDocumentBlockMoveHistory(ids.target), null, phase + ' ' + participant + ' ' + field + ' target')
      assert.deepEqual(state(store), changed, 'checking unavailable history must not undo the later change')
    })
  }
})

test('semantic restoration makes a paired history entry available with freshly acknowledged revisions without accepting its stale cursor', () => withStore(({ store }) => {
  const ids = seed(store), moved = store.moveDocumentBlocks(input(store, ids.source, ids.target))
  const oldHistory = store.getDocumentBlockMoveHistory(ids.target)!, semantic = store.documentRecovery.readContent(ids.source)
  store.updateDocument(ids.source, { ...semantic, summary: 'Temporary different summary' })
  assert.equal(store.getDocumentBlockMoveHistory(ids.source), null)
  assert.equal(store.getDocumentBlockMoveHistory(ids.target), null)
  store.updateDocument(ids.source, semantic)
  const current = store.getDocumentDetail(ids.source)!, currentHistory = store.getDocumentBlockMoveHistory(ids.target)!
  assert.ok(currentHistory)
  assert.equal(currentHistory.operationId, oldHistory.operationId)
  assert.equal(currentHistory.expectedUpdatedAtByDocument[ids.source], current.updatedAt)
  assert.notEqual(currentHistory.expectedUpdatedAtByDocument[ids.source], oldHistory.expectedUpdatedAtByDocument[ids.source])
  assert.deepEqual(currentHistory.beforeBlocks, oldHistory.beforeBlocks)
  assert.deepEqual(currentHistory.afterBlocks, oldHistory.afterBlocks)
  const before = state(store)
  assert.throws(() => store.undoDocumentBlockMove({ operationId: oldHistory.operationId, expectedUpdatedAtByDocument: oldHistory.expectedUpdatedAtByDocument }), /文档已变化/)
  assert.deepEqual(state(store), before)
  assert.equal(store.undoDocumentBlockMove({ operationId: currentHistory.operationId, expectedUpdatedAtByDocument: currentHistory.expectedUpdatedAtByDocument }).state, 'undone')
}))

test('trash restoration refuses a later imported owner of the same block identity and keeps every recoverable row across restart', () => withStore(harness => {
  let store = harness.store
  const source = create(store, 'Trash original', [{ ...block('trash-owned-id', 'Original trash body'), tags: ['original'], highlight: 'blue' }])
  store.deleteDocument(source)
  const archived = store.documentRecovery.getTrash(source)
  const target = store.createDocument(null)
  const imported = { title: 'Imported owner', summary: '', blocks: [{ ...block('trash-owned-id', 'Later imported body'), tags: ['later'], highlight: 'purple' }] }
  assert.throws(() => store.updateDocument(target, imported), /块身份.*保留/)
  // Arrange the explicit retained-owner transition of a trusted import kernel;
  // ordinary saves cannot perform it. This is not an import API acceptance.
  store.getUnsafeDatabaseHandle().transaction(() => {
    const changed = store.getUnsafeDatabaseHandle().prepare(`UPDATE block_identities SET last_owner_id=?
      WHERE id=? AND state='retained' AND last_owner_kind='document' AND last_owner_id=?`).run(target, 'trash-owned-id', source)
    assert.equal(changed.changes, 1)
    store.updateDocument(target, imported)
  })()
  store = harness.restart()
  const before = state(store), targetBefore = store.getDocumentDetail(target)
  const db = store.getUnsafeDatabaseHandle()
  const trashBefore = db.prepare('SELECT * FROM document_trash ORDER BY rowid').all()
  const originalRow = db.prepare('SELECT * FROM blocks WHERE id = ?').get('trash-owned-id')
  assert.throws(() => store.restoreTrashedDocument(source), /回收站中的块已移到其他文档.*回收站副本已保留/)
  assert.deepEqual(state(store), before)
  assert.deepEqual(db.prepare('SELECT * FROM document_trash ORDER BY rowid').all(), trashBefore)
  assert.deepEqual(db.prepare('SELECT * FROM blocks WHERE id = ?').get('trash-owned-id'), originalRow)
  assert.deepEqual(store.getDocumentDetail(target), targetBefore)
  assert.equal(store.getDocumentSnapshot(source), null)
  assert.deepEqual(store.documentRecovery.getTrash(source), archived)
  assert.equal(store.getBlockReference('Imported owner', '^trash-owned-id')!.documentId, target)
}))
