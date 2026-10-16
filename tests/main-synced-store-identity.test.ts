import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { BlockIdentityRepository } from '../src/main/database/block-identities'
import { getSyncedGroupSnapshots } from '../src/main/database/synced-blocks-read'
import type { DocumentBlockDraft } from '../src/shared/contracts'

const paragraph = (id: string, content = 'Text'): DocumentBlockDraft => ({ id, type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null })
function fixture(run: (store: KnowbookStore, databasePath: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-synced-identities-'))
  const databasePath = join(directory, 'workspace.db'), store = new KnowbookStore(databasePath)
  try { run(store, databasePath) } finally { store.destroy(); rmSync(directory, { recursive: true, force: true }) }
}
function save(store: KnowbookStore, documentId: string, blocks: DocumentBlockDraft[], title = 'Identity owner') {
  store.updateDocument(documentId, { title, summary: '', blocks })
  return store.getDocumentDetail(documentId)!
}

test('ordinary delete and same-owner restoration preserve opaque IDs, original creation time and old routes', () => fixture(store => {
  const id = store.createDocument(null), blockId = ' __proto__:旧块 ', keep = paragraph('keep', 'Keep')
  const before = save(store, id, [paragraph(blockId), keep], 'Before rename')
  const repository = new BlockIdentityRepository(store.getUnsafeDatabaseHandle()), originalCreatedAt = repository.get(blockId)!.createdAt
  const renamed = save(store, id, [paragraph(blockId), keep], 'After rename')
  assert.equal(store.getBlockReference(before.path, blockId)?.block.id, blockId)
  save(store, id, [keep], renamed.title)
  assert.deepEqual(repository.get(blockId), { id: blockId, owner: { kind: 'document', id }, state: 'retained', createdAt: originalCreatedAt })
  assert.equal(repository.resolveLiveOwner(blockId), null)
  assert.equal(store.getBlockReference(before.path, blockId), null)
  const route = store.getUnsafeDatabaseHandle().prepare('SELECT count(*) AS n FROM document_block_routes WHERE document_path = ? AND block_id = ?')
    .get(before.path, blockId) as { n: number }
  assert.equal(route.n, 1)
  save(store, id, [paragraph(blockId), keep], renamed.title)
  const restored = store.getUnsafeDatabaseHandle().prepare('SELECT created_at FROM blocks WHERE id = ?').get(blockId) as { created_at: string }
  assert.equal(restored.created_at, originalCreatedAt)
  assert.equal(store.getBlockReference(before.path, blockId)?.documentId, id)
  assert.deepEqual(repository.resolveLiveOwner(blockId), { kind: 'document', id })
}))

test('foreign live and retained ordinary identities reject before metadata or recovery history changes', () => fixture(store => {
  const a = store.createDocument(null), b = store.createDocument(null), blockId = ' foreign:中文 '
  save(store, a, [paragraph(blockId), paragraph('a-keep')], 'Owner A')
  const before = store.getDocumentDetail(b)!, history = store.documentRecovery.listHistory(b)
  for (const retained of [false, true]) {
    if (retained) save(store, a, [paragraph('a-keep')], 'Owner A')
    assert.throws(() => save(store, b, [paragraph(blockId)], 'Must not rename'), /保留|占用/)
    assert.deepEqual(store.getDocumentDetail(b), before)
    assert.deepEqual(store.documentRecovery.listHistory(b), history)
  }
}))

test('reserved and canonical retained identities cannot be taken by the ordinary save boundary', () => fixture(store => {
  const id = store.createDocument(null), before = store.getDocumentDetail(id)!, db = store.getUnsafeDatabaseHandle()
  for (const kind of ['reserved', 'group'] as const) {
    const blockId = randomUUID()
    db.prepare(`INSERT INTO block_identities (id,last_owner_kind,last_owner_id,state,created_at) VALUES (?,?,?,'retained',NULL)`)
      .run(blockId, kind, randomUUID())
    assert.throws(() => save(store, id, [paragraph(blockId)], 'Must not rename'), /保留|占用/)
    assert.deepEqual(store.getDocumentDetail(id), before)
    assert.equal(new BlockIdentityRepository(db).get(blockId)!.state, 'retained')
  }
}))

test('a known document reservation with unknown historic creation time is filled only on explicit restoration', () => fixture(store => {
  const id = store.createDocument(null), blockId = 'history-only:旧块', db = store.getUnsafeDatabaseHandle()
  db.prepare(`INSERT INTO block_identities (id,last_owner_kind,last_owner_id,state,created_at) VALUES (?,'document',?,'retained',NULL)`)
    .run(blockId, id)
  const identities = new BlockIdentityRepository(db)
  assert.equal(identities.get(blockId)!.createdAt, null)
  save(store, id, [paragraph(blockId)])
  const restored = db.prepare('SELECT created_at FROM blocks WHERE id = ?').get(blockId) as { created_at: string }
  assert.ok(Number.isFinite(Date.parse(restored.created_at)))
  assert.equal(identities.get(blockId)!.createdAt, restored.created_at)
  assert.equal(identities.get(blockId)!.state, 'live')
}))

test('independent SQLite Store clients share the retained identity boundary after owner deletion', () => fixture((a, databasePath) => {
  const source = a.createDocument(null), target = a.createDocument(null), blockId = 'independent-owner'
  save(a, source, [paragraph(blockId)], 'Source')
  const b = new KnowbookStore(databasePath)
  try {
    a.deleteDocument(source)
    const before = b.getDocumentDetail(target)!
    assert.throws(() => save(b, target, [paragraph(blockId)], 'Must not rename'), /保留|占用/)
    assert.deepEqual(b.getDocumentDetail(target), before)
    a.restoreTrashedDocument(source)
    assert.equal(b.getDocumentDetail(source)!.blocks[0].id, blockId)
  } finally { b.destroy() }
}))

test('ordinary document IPC storage cannot fabricate a synchronized reference without a structure transaction', () => fixture(store => {
  const id = store.createDocument(null), before = store.getDocumentDetail(id)!, history = store.documentRecovery.listHistory(id)
  const block = { ...paragraph(randomUUID()), type: 'synced-block', content: JSON.stringify({ version: 1, groupId: randomUUID() }) }
  assert.throws(() => save(store, id, [block], 'Must not rename'), /结构事务/)
  assert.deepEqual(store.getDocumentDetail(id), before)
  assert.deepEqual(store.documentRecovery.listHistory(id), history)
}))

test('reopening schema26 with a missing identity guard rejects without silently repairing its authority', () => fixture((store, databasePath) => {
  const db = store.getUnsafeDatabaseHandle()
  db.exec('DROP TRIGGER trg_synced_identity_delete')
  const schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()
  const namespace = db.prepare('SELECT * FROM synced_workspace_state').all()
  assert.throws(() => new KnowbookStore(databasePath), /缺少或损坏关键结构/)
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), schema)
  assert.deepEqual(db.prepare('SELECT * FROM synced_workspace_state').all(), namespace)
}))

test('this foundation rejects a valid same-schema orphan canonical body before WAL or metadata writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-synced-reader-gate-')), databasePath = join(directory, 'workspace.db')
  let store: KnowbookStore | null = new KnowbookStore(databasePath)
  try {
    const documentId = store.createDocument(null), groupId = randomUUID(), createdAt = new Date().toISOString()
    const db = store.getUnsafeDatabaseHandle()
    db.prepare(`INSERT INTO synced_groups(id,creation_id,created_at,origin_json,revision,topology_revision,history_cursor)
      VALUES(?,?,?,?,?,?,?)`).run(groupId, randomUUID(), createdAt, JSON.stringify({ version: 1, documentId,
        pathAtCreation: store.getDocumentDetail(documentId)!.path, firstInstanceId: randomUUID() }), randomUUID(), randomUUID(), randomUUID())
    db.prepare(`INSERT INTO synced_group_blocks(id,group_id,sort_order,type,content,created_at)
      VALUES(?,?,0,'paragraph','Future canonical body',?)`).run('future-canonical', groupId, createdAt)
    const snapshot = getSyncedGroupSnapshots(db, { groupIds: [groupId] }).items[0]
    assert.equal(snapshot.status, 'ready', 'This is valid canonical content, including a zero-instance orphan')
    store.destroy(); store = null
    const standalone = new Database(databasePath)
    standalone.pragma('journal_mode=DELETE'); standalone.close()
    const digest = () => createHash('sha256').update(readFileSync(databasePath)).digest('hex')
    const before = digest()
    assert.equal(existsSync(databasePath + '-wal'), false)
    assert.throws(() => new KnowbookStore(databasePath), /此构建尚不支持.*同步块正文/)
    assert.equal(digest(), before, 'Refusal preserves every database byte, not only the ordinary document rows')
    assert.equal(existsSync(databasePath + '-wal'), false)
    assert.equal(existsSync(databasePath + '-shm'), false)
  } finally { store?.destroy(); rmSync(directory, { recursive: true, force: true }) }
})

test('rejecting unsupported canonical content committed only in a crashed writer WAL preserves every original file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-synced-wal-gate-')), databasePath = join(directory, 'workspace.db')
  try {
    const store = new KnowbookStore(databasePath), documentId = store.createDocument(null)
    const origin = { version: 1, documentId, pathAtCreation: store.getDocumentDetail(documentId)!.path, firstInstanceId: randomUUID() }
    store.destroy()
    const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
    const beforeWal = digest(databasePath)
    const groupId = randomUUID(), createdAt = new Date().toISOString()
    // process.exit deliberately skips SQLite close: the committed group must
    // remain exclusively in a real WAL, with no live connection holding it.
    const result = spawnSync(process.execPath, ['-e', `
      const Database = require(process.argv[1]);
      const db = new Database(process.argv[2]);
      const value = JSON.parse(process.argv[3]);
      db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0'); db.pragma('foreign_keys=ON');
      db.transaction(() => {
        db.prepare('INSERT INTO synced_groups(id,creation_id,created_at,origin_json,revision,topology_revision,history_cursor) VALUES(?,?,?,?,?,?,?)').run(...value.group);
        db.prepare("INSERT INTO synced_group_blocks(id,group_id,sort_order,type,content,created_at) VALUES(?,?,0,'paragraph','Only in committed WAL',?)").run(value.blockId,value.group[0],value.group[2]);
      })();
      process.stdout.write(String(db.prepare('SELECT count(*) AS count FROM synced_groups').get().count));
      process.exit(0);
    `, createRequire(import.meta.url).resolve('better-sqlite3'), databasePath,
    JSON.stringify({ group: [groupId, randomUUID(), createdAt, JSON.stringify(origin), randomUUID(), randomUUID(), randomUUID()], blockId: randomUUID() })],
    { windowsHide: true, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '1')
    assert.equal(digest(databasePath), beforeWal, 'The group commit is not yet checkpointed into the database')
    const files = ['', '-wal', '-shm'].map(suffix => ({ path: databasePath + suffix, sha256: digest(databasePath + suffix) }))
    assert.ok(readFileSync(databasePath + '-wal').length > 32)
    assert.throws(() => new KnowbookStore(databasePath), /此构建尚不支持.*同步块正文/)
    for (const file of files) assert.equal(digest(file.path), file.sha256, `Refusal must preserve ${file.path}`)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
