import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { appSchema } from '../src/main/database/schema'
import { installSyncedBlockSchema } from '../src/main/database/synced-schema'
import { getSyncedGroupSnapshots, getSyncedHostHistory, listSyncedGroups } from '../src/main/database/synced-blocks-read'
import type { SyncedCanonicalWire, SyncedGroupSnapshot, SyncedLinkBinding } from '../src/shared/synced-blocks'
import { SyncedValidationError } from '../src/shared/syncedBlockValidation'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'

const born = '2020-01-02T03:04:05+08:00', now = '2026-10-16T00:00:00.000Z'
const uuid = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`
const host = ' 宿主:__proto__ '

function initialize(db: Database.Database) {
  db.pragma('foreign_keys=ON')
  db.exec(appSchema)
  db.exec('ALTER TABLE blocks ADD COLUMN list_start INTEGER; ALTER TABLE blocks ADD COLUMN markdown_format_json TEXT;')
  for (const id of [host, 'other']) db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, id, id, id, born, now)
  db.transaction(() => installSyncedBlockSchema(db, { workspaceScope: uuid(900), recoveryEpoch: uuid(901), now }))()
}
function withDatabase(run: (db: Database.Database) => void) {
  const db = new Database(':memory:')
  try { initialize(db); run(db) } finally { db.close() }
}
const paragraph = (id: string, content = 'Body'): SyncedCanonicalWire => ({
  id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null, createdAt: born
})
function group(db: Database.Database, index: number, blocks: SyncedCanonicalWire[] = [paragraph(`body:${index}`)],
  options: { path?: string; bindings?: SyncedLinkBinding[]; position?: number } = {}) {
  const id = uuid(index)
  db.prepare(`INSERT INTO synced_groups(id,creation_id,created_at,origin_json,bindings_json,revision,topology_revision,history_cursor,history_position)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, uuid(index + 1000), born,
    JSON.stringify({ version: 1, documentId: host, pathAtCreation: options.path ?? 'Original/Path', firstInstanceId: uuid(index + 2000) }),
    JSON.stringify(options.bindings ?? []), uuid(index + 3000), uuid(index + 4000), uuid(index + 5000), options.position ?? 0)
  const insert = db.prepare(`INSERT INTO synced_group_blocks(id,group_id,parent_block_id,sort_order,type,content,checked,depth,
    tags_json,language,list_start,markdown_format_json,highlight,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  blocks.forEach((block, sort) => insert.run(block.id, id, block.parentBlockId, sort, block.type, block.content, block.checked ? 1 : 0,
    block.depth, block.tags === undefined ? null : JSON.stringify(block.tags), block.language ?? null, block.listStart ?? null,
    block.markdownFormat === undefined ? null : JSON.stringify(block.markdownFormat), block.highlight ?? null, block.createdAt))
  return id
}
function ordinary(db: Database.Database, id: string, type = 'toggle') {
  db.prepare(`INSERT INTO blocks(id,document_id,parent_block_id,sort_order,type,content,checked,depth,created_at,updated_at)
    VALUES(?,?,NULL,0,?,'Parent',0,0,?,?)`).run(id, host, type, born, now)
}
function instance(db: Database.Database, id: string, groupId: string, options: { parent?: string; depth?: number; owner?: string; sort?: number } = {}) {
  const owner = options.owner ?? host, parent = options.parent ?? null, depth = options.depth ?? (parent === null ? 0 : 1)
  db.prepare(`INSERT INTO blocks(id,document_id,parent_block_id,sort_order,type,content,checked,depth,created_at,updated_at)
    VALUES(?,?,?,?,'synced-block',?,0,?,?,?)`).run(id, owner, parent, options.sort ?? 1, JSON.stringify({ version: 1, groupId }), depth, born, now)
  db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,?,?)')
    .run(id, groupId, owner, uuid(Number(id.slice(-12)) + 100), parent, depth)
}
function snapshot(db: Database.Database, id: string): SyncedGroupSnapshot {
  const result = getSyncedGroupSnapshots(db, { groupIds: [id] }).items[0]
  assert.ok(result.status === 'ready')
  return result.snapshot
}
function changes(db: Database.Database): number {
  return (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count
}
function groupHistory(db: Database.Database, groupId: string, position: number, token: string) {
  db.prepare('INSERT INTO synced_group_history(id,group_id,position,before_json,after_json,before_hash,after_hash,created_at) VALUES(?,?,?,\'[]\',\'[]\',\'before\',\'after\',?)')
    .run(token, groupId, position, now)
}
function hostHistory(db: Database.Database, position: number, token: string) {
  db.prepare('INSERT INTO synced_host_history VALUES(?,\'{"kind":"delete"}\',\'[]\',\'[]\',\'before\',\'after\',?)').run(token, now)
  db.prepare('INSERT INTO synced_host_history_documents VALUES(?,?,?)').run(token, host, position)
}

test('real group snapshots deduplicate UUID requests in first-occurrence order and retain missing items plus the persistent namespace', () => {
  withDatabase(db => {
    const a = group(db, 10), b = group(db, 20), missing = uuid(30), before = changes(db)
    const result = getSyncedGroupSnapshots(db, { groupIds: [b, missing, a, b] })
    assert.equal(result.workspaceScope, uuid(900))
    assert.deepEqual(result.items.map(item => item.status === 'ready' ? item.snapshot.groupId : item.groupId), [b, missing, a])
    assert.deepEqual(result.items.map(item => item.status), ['ready', 'missing', 'ready'])
    assert.deepEqual(getSyncedGroupSnapshots(db, { groupIds: [] }), { workspaceScope: uuid(900), items: [] })
    assert.equal(changes(db), before)
    assert.equal(db.inTransaction, false)
  })
})

test('canonical fields, immutable origin and bindings are decoded strictly without normalizing old identity or timestamp bytes', () => {
  withDatabase(db => {
    const id = ' __proto__:正文\0 ', content = '[link](child.md)'
    const blocks: SyncedCanonicalWire[] = [
      { ...paragraph(id, content), tags: [' keep '], highlight: 'yellow' },
      { ...paragraph('code', 'console.log(1)'), type: 'code', language: 'javascript', markdownFormat: { codeInfo: 'javascript title="Old alias"' } },
      { ...paragraph('fold', 'Fold'), type: 'toggle', markdownFormat: { toggleDefaultOpen: true } },
      { ...paragraph('nested', 'Inside'), depth: 1, parentBlockId: 'fold' }
    ]
    const bindings: SyncedLinkBinding[] = [{ blockId: id, from: 7, to: 15, raw: 'child.md', syntax: 'markdown',
      target: { kind: 'document', id: ' gone document ', state: 'missing' } }]
    const groupId = group(db, 10, blocks, { bindings })
    db.prepare('UPDATE documents SET path=? WHERE id=?').run('Moved/Host', host)
    const value = snapshot(db, groupId)
    assert.deepEqual(value.blocks, blocks)
    assert.deepEqual(value.bindings, bindings)
    assert.deepEqual(value.origin, { version: 1, documentId: host, pathAtCreation: 'Original/Path', firstInstanceId: uuid(2010) })
    assert.equal(value.createdAt, born)
    assert.equal(value.maxRelativeDepth, 1)
    assert.deepEqual(value.instances, [])
  })
})

test('omitted tags and explicit empty tags survive SQLite and canonical JSON as different wire semantics', () => {
  withDatabase(db => {
    const blocks = [paragraph('absent'), { ...paragraph('empty'), tags: [] }]
    const value = snapshot(db, group(db, 10, blocks))
    assert.equal(Object.hasOwn(value.blocks[0], 'tags'), false)
    assert.deepEqual(value.blocks[1].tags, [])
    assert.equal(Object.hasOwn(value.blocks[1], 'tags'), true)
    assert.equal(canonicalSyncedPortableJson(value.blocks), canonicalSyncedPortableJson(blocks))
    const hash = (value: unknown) => createHash('sha256').update(canonicalSyncedPortableJson(value)).digest('hex')
    assert.notEqual(hash(value.blocks[0]), hash({ ...value.blocks[0], tags: [] }))
    assert.deepEqual(snapshot(db, uuid(10)).blocks, value.blocks)
  })
})

test('instance positions derive parentType from the real host and preserve multiple occurrences of one canonical forest', () => {
  withDatabase(db => {
    const groupId = group(db, 10)
    ordinary(db, ' 父块 ')
    instance(db, uuid(100), groupId, { parent: ' 父块 ' })
    instance(db, uuid(101), groupId, { owner: 'other' })
    const value = snapshot(db, groupId)
    assert.deepEqual(value.instances, [
      { instanceId: uuid(100), hostDocumentId: host, bindingVersion: uuid(200), depth: 1, parentBlockId: ' 父块 ', parentType: 'toggle' },
      { instanceId: uuid(101), hostDocumentId: 'other', bindingVersion: uuid(201), depth: 0, parentBlockId: null, parentType: null }
    ])
    assert.equal(value.blocks.length, 1, 'a group snapshot keeps one canonical forest rather than materializing its instances')
    db.prepare('UPDATE blocks SET type=\'callout\' WHERE id=?').run(' 父块 ')
    assert.equal(snapshot(db, groupId).instances[0].parentType, 'callout')
  })
})

test('an orphan is listed and readable, but a real leaf with a missing registry entry is never silently reported as an orphan', () => {
  withDatabase(db => {
    const groupId = group(db, 10)
    assert.deepEqual(snapshot(db, groupId).instances, [])
    assert.equal(listSyncedGroups(db, { query: '', offset: 0, limit: 10 }).items[0].liveInstances, 0)
    instance(db, uuid(100), groupId)
    db.prepare('DELETE FROM synced_instances WHERE instance_id=?').run(uuid(100))
    assert.throws(() => snapshot(db, groupId), error => error instanceof SyncedValidationError && error.code === 'binding')
    assert.throws(() => listSyncedGroups(db, { query: '', offset: 0, limit: 10 }), SyncedValidationError)
  })
})

test('registry and actual leaf ownership mismatch is rejected rather than trusting stored position fields', () => {
  withDatabase(db => {
    const groupId = group(db, 10)
    instance(db, uuid(100), groupId)
    db.exec('DROP TRIGGER trg_synced_instance_update_guard')
    db.prepare('UPDATE synced_instances SET host_document_id=? WHERE instance_id=?').run('other', uuid(100))
    assert.throws(() => snapshot(db, groupId), error => error instanceof SyncedValidationError && error.code === 'binding')
  })
})

test('actual parent role/depth and every registered occurrence constrain the read snapshot', () => {
  for (const change of ['role', 'depth'] as const) withDatabase(db => {
    const groupId = group(db, 10)
    ordinary(db, 'parent')
    instance(db, uuid(100), groupId, { parent: 'parent' })
    if (change === 'role') db.prepare('UPDATE blocks SET type=\'code\' WHERE id=\'parent\'').run()
    else db.prepare('UPDATE blocks SET depth=2 WHERE id=\'parent\'').run()
    assert.throws(() => snapshot(db, groupId), SyncedValidationError)
  })
  withDatabase(db => {
    const groupId = group(db, 10, [{ ...paragraph('task'), type: 'todo', checked: true }])
    ordinary(db, 'todo-parent', 'todo')
    instance(db, uuid(100), groupId, { parent: 'todo-parent' })
    assert.equal(snapshot(db, groupId).instances[0].parentType, 'todo', 'transparent list references accept genuine canonical list roots')
  })
})

test('a deep second occurrence rejects a snapshot even when its first occurrence has ample depth', () => {
  withDatabase(db => {
    const groupId = group(db, 10, [{ ...paragraph('shared-root'), type: 'toggle' },
      { ...paragraph('shared-child'), parentBlockId: 'shared-root', depth: 1 }])
    instance(db, uuid(100), groupId, { owner: 'other' })
    for (let depth = 0; depth < 6; depth++) db.prepare(`INSERT INTO blocks
      (id,document_id,parent_block_id,sort_order,type,content,checked,depth,created_at,updated_at)
      VALUES(?,?,?,?,'toggle','Nest',0,?,?,?)`).run(`parent-${depth}`, host, depth ? `parent-${depth - 1}` : null, depth, depth, born, now)
    instance(db, uuid(101), groupId, { parent: 'parent-5', depth: 6, sort: 6 })
    assert.throws(() => snapshot(db, groupId), error => error instanceof SyncedValidationError && error.code === 'depth'
      && error.blockingInstances.length === 1 && error.blockingInstances[0].instanceId === uuid(101))
  })
})

test('read boundaries reject empty canonical forests, stale link ranges, duplicate JSON keys and global owner inconsistency', () => {
  withDatabase(db => {
    const groupId = group(db, 10, [])
    assert.throws(() => snapshot(db, groupId), SyncedValidationError)
  })
  withDatabase(db => {
    const groupId = group(db, 10)
    db.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run(JSON.stringify([
      { blockId: 'body:10', from: 0, to: 2, raw: 'Wrong', syntax: 'markdown', target: { kind: 'document', id: 'other', state: 'live' } }
    ]), groupId)
    assert.throws(() => snapshot(db, groupId), SyncedValidationError)
  })
  withDatabase(db => {
    const groupId = group(db, 10)
    db.prepare('UPDATE synced_groups SET origin_json=? WHERE id=?')
      .run(`{"version":1,"version":1,"documentId":"other","pathAtCreation":"Old","firstInstanceId":"${uuid(2010)}"}`, groupId)
    assert.throws(() => snapshot(db, groupId), /JSON/)
  })
  withDatabase(db => {
    const groupId = group(db, 10)
    db.exec('DROP TRIGGER trg_synced_identity_update_consistency')
    db.prepare('UPDATE block_identities SET state=\'retained\' WHERE id=?').run('body:10')
    assert.throws(() => snapshot(db, groupId), error => error instanceof SyncedValidationError && error.code === 'identity')
  })
})

test('reverse identity reads reject absent or foreign physical rows only within requested groups and permit retained identities', () => {
  for (const corruption of ['absent', 'foreign-physical', 'missing-group']) withDatabase(db => {
    const broken = group(db, 10, undefined, { path: 'Broken' })
    group(db, 20, undefined, { path: 'Foreign' })
    const safe = group(db, 30, undefined, { path: 'Safe' }), missing = uuid(40)
    db.prepare(`INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at)
      VALUES('retained-only','group',?,'retained',?)`).run(broken, born)
    assert.equal(snapshot(db, broken).groupId, broken, 'a legitimate retired child need not retain physical content')
    if (corruption === 'foreign-physical') {
      db.exec('DROP TRIGGER trg_synced_identity_update_consistency')
      db.prepare('UPDATE block_identities SET last_owner_id=? WHERE id=?').run(broken, 'body:20')
    } else {
      db.exec('DROP TRIGGER trg_synced_identity_insert_consistency')
      db.prepare(`INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at)
        VALUES('live-without-content','group',?,'live',?)`).run(corruption === 'missing-group' ? missing : broken, born)
    }
    const before = changes(db), requested = corruption === 'missing-group' ? missing : broken
    assert.throws(() => getSyncedGroupSnapshots(db, { groupIds: [requested] }),
      error => error instanceof SyncedValidationError && error.code === 'identity')
    if (corruption !== 'missing-group') assert.throws(() => listSyncedGroups(db, { query: 'Broken', offset: 0, limit: 100 }),
      error => error instanceof SyncedValidationError && error.code === 'identity')
    assert.equal(snapshot(db, safe).groupId, safe, 'an unrelated corrupt identity does not turn a scoped read into a full database audit')
    assert.deepEqual(listSyncedGroups(db, { query: 'Safe', offset: 0, limit: 100 }).items.map(item => item.groupId), [safe])
    assert.equal(changes(db), before)
    assert.equal(db.inTransaction, false)
  })
})

test('group history tokens come from the exact cursor position and its adjacent redo, including the zero position', () => {
  withDatabase(db => {
    const groupId = group(db, 10, undefined, { position: 1 })
    groupHistory(db, groupId, 1, uuid(600)); groupHistory(db, groupId, 2, uuid(601))
    assert.deepEqual(snapshot(db, groupId).history, { cursor: uuid(5010), undoToken: uuid(600), redoToken: uuid(601) })
    db.prepare('UPDATE synced_groups SET history_position=0 WHERE id=?').run(groupId)
    assert.deepEqual(snapshot(db, groupId).history, { cursor: uuid(5010), undoToken: null, redoToken: uuid(600) })
    db.prepare('DELETE FROM synced_group_history WHERE group_id=? AND position=1').run(groupId)
    assert.throws(() => snapshot(db, groupId), /精确尾/)
    db.prepare('UPDATE synced_groups SET history_position=1 WHERE id=?').run(groupId)
    assert.throws(() => snapshot(db, groupId), /精确尾/)
  })
})

test('host history reads the persistent tail and fails closed for a missing state, cursor or journal gap without writing one', () => {
  withDatabase(db => {
    const before = changes(db)
    assert.throws(() => getSyncedHostHistory(db, { documentId: host }), /尚未初始化/)
    assert.equal(changes(db), before)
    db.prepare('INSERT INTO synced_host_history_state VALUES(?,?,1)').run(host, uuid(700))
    assert.throws(() => getSyncedHostHistory(db, { documentId: host }), /精确尾/)
    hostHistory(db, 1, uuid(701)); hostHistory(db, 2, uuid(702))
    const ready = changes(db)
    assert.deepEqual(getSyncedHostHistory(db, { documentId: host }), { cursor: uuid(700), undoToken: uuid(701), redoToken: uuid(702) })
    assert.equal(changes(db), ready)
    db.prepare('UPDATE synced_host_history_state SET position=0 WHERE document_id=?').run(host)
    assert.deepEqual(getSyncedHostHistory(db, { documentId: host }), { cursor: uuid(700), undoToken: null, redoToken: uuid(701) })
    db.prepare('DELETE FROM synced_host_history_documents WHERE document_id=? AND position=1').run(host)
    assert.throws(() => getSyncedHostHistory(db, { documentId: host }), /精确尾/)
    db.prepare('UPDATE synced_host_history_state SET cursor=\'bad-cursor\',position=2 WHERE document_id=?').run(host)
    assert.throws(() => getSyncedHostHistory(db, { documentId: host }), SyncedValidationError)
  })
})

test('group list searches all real body blocks and immutable origin paths, uses literal query text and paginates stable orphan-inclusive totals', () => {
  withDatabase(db => {
    const a = group(db, 10, [paragraph('first', 'One'), paragraph('second', 'ALPHA\nSecond')], { path: 'Original/A' })
    const b = group(db, 20, [paragraph('third', 'Beta')], { path: 'Original/Alpha' })
    const c = group(db, 30, [paragraph('fourth', '100%_literal')], { path: 'Original/C' })
    assert.deepEqual(listSyncedGroups(db, { query: 'alpha', offset: 0, limit: 1 }), {
      total: 2, items: [{ groupId: a, preview: 'One ALPHA Second', originPath: 'Original/A', liveInstances: 0 }]
    })
    assert.equal(listSyncedGroups(db, { query: 'alpha', offset: 1, limit: 1 }).items[0].groupId, b)
    assert.deepEqual(listSyncedGroups(db, { query: 'alpha', offset: 2, limit: 1 }), { total: 2, items: [] })
    assert.deepEqual(listSyncedGroups(db, { query: '100%_', offset: 0, limit: 100 }).items.map(item => item.groupId), [c])
    assert.deepEqual(listSyncedGroups(db, { query: 'x'.repeat(2001), offset: 0, limit: 1 }), { total: 0, items: [] }, 'read query has no invented 2000-character write budget')
  })
})

test('all read inputs reject extra fields, sparse IDs, invalid scalars and out-of-range pagination without database changes', () => {
  withDatabase(db => {
    const before = changes(db)
    for (const input of [null, [], { groupIds: uuid(10) }, { groupIds: [uuid(10)], extra: true }, { groupIds: new Array(1) },
      { groupIds: [' old '] }, { groupIds: new Array(100_001).fill(uuid(10)) }]) {
      assert.throws(() => getSyncedGroupSnapshots(db, input), SyncedValidationError)
    }
    for (const input of [{ query: 1, offset: 0, limit: 1 }, { query: '', offset: -1, limit: 1 },
      { query: '', offset: 0.5, limit: 1 }, { query: '', offset: Number.MAX_SAFE_INTEGER + 1, limit: 1 },
      { query: '', offset: 0, limit: 0 }, { query: '', offset: 0, limit: 101 }, { query: '', offset: 0, limit: NaN },
      { query: '', offset: 0, limit: 1, extra: true }]) assert.throws(() => listSyncedGroups(db, input), SyncedValidationError)
    for (const input of [{ documentId: '' }, { documentId: 1 }, { documentId: host, cursor: uuid(1) }]) {
      assert.throws(() => getSyncedHostHistory(db, input), SyncedValidationError)
    }
    assert.equal(changes(db), before)
    assert.equal(db.inTransaction, false)
  })
})

test('list count, page and canonical preview stay in one real SQLite read snapshot when another WAL connection commits between queries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowbook-synced-read-')), file = join(directory, 'isolated.db')
  const reader = new Database(file)
  let writer: Database.Database | undefined
  try {
    initialize(reader); reader.pragma('journal_mode=WAL')
    const first = group(reader, 10, [paragraph('first', 'First')])
    writer = new Database(file); writer.pragma('foreign_keys=ON')
    const currentWriter = writer
    let committed = false
    const observed = new Proxy(reader, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql)
        if (!sql.startsWith('SELECT count(*) AS count FROM synced_groups')) return statement
        return new Proxy(statement, { get(actual, method) {
          if (method === 'get') return (...parameters: unknown[]) => {
            assert.equal(reader.inTransaction, true)
            const value = actual.get(...parameters)
            if (!committed) { committed = true; currentWriter.transaction(() => group(currentWriter, 20, [paragraph('second', 'Second')]))() }
            return value
          }
          const value = Reflect.get(actual, method, actual)
          return typeof value === 'function' ? value.bind(actual) : value
        } })
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    assert.deepEqual(listSyncedGroups(observed, { query: '', offset: 0, limit: 100 }), {
      total: 1, items: [{ groupId: first, preview: 'First', originPath: 'Original/Path', liveInstances: 0 }]
    })
    assert.equal(committed, true)
    assert.equal(reader.inTransaction, false)
    assert.equal(listSyncedGroups(reader, { query: '', offset: 0, limit: 100 }).total, 2)
  } finally {
    writer?.close(); reader.close(); rmSync(directory, { recursive: true, force: true })
  }
})
