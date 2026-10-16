import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { appSchema } from '../src/main/database/schema'
import { assertSyncedBlockSchema, installSyncedBlockSchema } from '../src/main/database/synced-schema'

const born = '2020-01-02T03:04:05+08:00', now = '2026-10-16T00:00:00.000Z'
const uuid = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`
const options = { workspaceScope: uuid(1), recoveryEpoch: uuid(2), now }
type Identity = { id: string; last_owner_kind: string; last_owner_id: string; state: string; created_at: string | null }

function withLegacy(run: (db: Database.Database) => void) {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys=ON')
    db.exec(appSchema)
    db.exec(`CREATE TABLE document_templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,
      title TEXT NOT NULL,summary TEXT NOT NULL,blocks_json TEXT NOT NULL,created_at TEXT NOT NULL)`)
    db.pragma('user_version=25')
    for (const id of ['a', 'b', 'c']) db.prepare(`INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(id, id, id, id, born, now)
    run(db)
  } finally { db.close() }
}
function install(db: Database.Database) { db.transaction(() => installSyncedBlockSchema(db, options))() }
function identity(db: Database.Database, id: string): Identity | undefined {
  return db.prepare('SELECT * FROM block_identities WHERE id=?').get(id) as Identity | undefined
}
function count(db: Database.Database, sql: string, ...parameters: string[]): number {
  const row = db.prepare<string[], { n: number }>(sql).get(...parameters)
  assert.ok(row)
  return row.n
}
function block(db: Database.Database, id: string, owner = 'a', createdAt = born,
  extra: { parent?: string | null; depth?: number; type?: string; content?: string; sort?: number } = {}) {
  db.prepare(`INSERT INTO blocks(id,document_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,language,highlight,created_at,updated_at)
    VALUES(?,?,?,?,?,?,0,?,'["keep"]',NULL,'yellow',?,?)`)
    .run(id, owner, extra.parent ?? null, extra.sort ?? 0, extra.type ?? 'paragraph', extra.content ?? 'Body', extra.depth ?? 0, createdAt, now)
}
function group(db: Database.Database, value = 10) {
  const id = uuid(value)
  db.prepare(`INSERT INTO synced_groups(id,creation_id,created_at,origin_json,bindings_json,revision,topology_revision,history_cursor,history_position)
    VALUES(?,?,?,?,'[]',?,?,?,0)`).run(id, uuid(value + 1), born,
    JSON.stringify({ version: 1, documentId: 'a', pathAtCreation: 'a', firstInstanceId: uuid(value + 2) }),
    uuid(value + 3), uuid(value + 4), uuid(value + 5))
  return id
}
function canonical(db: Database.Database, id: string, groupId: string, createdAt = born, parent: string | null = null, depth = 0) {
  db.prepare(`INSERT INTO synced_group_blocks(id,group_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,created_at)
    VALUES(?,?,?,0,'paragraph','Shared',0,?,'["keep"]',?)`).run(id, groupId, parent, depth, createdAt)
}
function history(db: Database.Database, id: string, owner: string, blocks: unknown[]) {
  db.prepare('INSERT INTO document_history VALUES(?,?,?,?,?,?,?)').run(id, owner, owner, owner, now, 'edit',
    JSON.stringify({ title: owner, summary: '', blocks }))
}
function draft(id: string, createdAt?: string) {
  return { id, type: 'paragraph', content: 'Body', checked: false, depth: 0, parentBlockId: null,
    ...(createdAt === undefined ? {} : { createdAt }) }
}

test('schema26 installation requires the outer transaction and enabled foreign keys, and never advances user_version', () => {
  withLegacy(db => {
    assert.throws(() => installSyncedBlockSchema(db), /外层/)
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='block_identities'").get(), undefined)
    db.pragma('foreign_keys=OFF')
    assert.throws(() => install(db), /外键/)
    db.pragma('foreign_keys=ON')
    install(db)
    assert.equal(db.pragma('user_version', { simple: true }), 25)
    assert.equal(db.inTransaction, false)
  })
})

test('migration preserves opaque live IDs, exact timestamps, all block bytes and old path routes', () => {
  withLegacy(db => {
    const id = ' __proto__:旧块 中文 '
    block(db, id, 'a', born, { content: 'First\r\n\nSecond' })
    block(db, '\0opaque\0', 'b')
    db.prepare('INSERT INTO document_block_routes VALUES(?,?)').run(' Old/路径 ', id)
    const before = db.prepare('SELECT * FROM blocks WHERE id=?').get(id)
    install(db)
    assert.deepEqual(db.prepare('SELECT * FROM blocks WHERE id=?').get(id), before)
    assert.deepEqual(identity(db, id), { id, last_owner_kind: 'document', last_owner_id: 'a', state: 'live', created_at: born })
    assert.equal(identity(db, '\0opaque\0')?.id, '\0opaque\0', 'SQLite text length must not truncate a historical opaque ID at NUL')
    assert.deepEqual(db.prepare('SELECT * FROM document_block_routes').all(), [{ document_path: ' Old/路径 ', block_id: id }])
    const keys = db.pragma('foreign_key_list(document_block_routes)') as Array<{ table: string; on_delete: string }>
    assert.equal(keys[0].table, 'block_identities')
    assert.equal(keys[0].on_delete, 'RESTRICT')
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  })
})

test('retained history/trash have unknown birth times; template and missing backup identities are reserved without a fake document owner', () => {
  withLegacy(db => {
    history(db, 'h', 'a', [draft('history')])
    db.prepare('INSERT INTO document_trash VALUES(?,?,?,?,?)').run('gone', 'Gone', 'Gone', now,
      JSON.stringify({ document: { id: 'gone' }, content: { title: 'Gone', summary: '', blocks: [draft('trash')] }, values: [], entities: [] }))
    db.prepare('INSERT INTO document_templates VALUES(?,?,?,?,?,?,?)').run('t', 'T', '', '', '', JSON.stringify([draft('template')]), now)
    db.prepare('INSERT INTO backup_restore_identities VALUES(?,?,?,?,?,?)').run('lineage', 'block', 'source', 'missing', 'missing', 'reserved-backup')
    install(db)
    for (const [id, owner] of [['history', 'a'], ['trash', 'gone']]) assert.deepEqual(identity(db, id), {
      id, last_owner_kind: 'document', last_owner_id: owner, state: 'retained', created_at: null
    })
    for (const id of ['template', 'reserved-backup']) {
      assert.equal(identity(db, id)?.last_owner_kind, 'reserved')
      assert.equal(identity(db, id)?.state, 'retained')
      assert.equal(identity(db, id)?.created_at, null)
      assert.throws(() => block(db, id), /another owner/)
    }
    block(db, 'history', 'a', now)
    assert.equal(identity(db, 'history')?.created_at, now, 'first accepted restore fills an unknown birth time rather than claiming to recover it')
    assert.equal(identity(db, 'history')?.state, 'live')
    assert.throws(() => block(db, 'trash', 'a'), /another owner/)
  })
})

test('ambiguous historical owners stay reserved while live rows and explicit latest move state take precedence', () => {
  withLegacy(db => {
    for (const owner of ['a', 'b']) history(db, `h-${owner}`, owner, [draft('ambiguous'), draft('moved'), draft('live')])
    block(db, 'live', 'c')
    const side = (owner: string) => JSON.stringify([{ documentId: owner, path: owner, updatedAt: now,
      content: { title: owner, summary: '', blocks: [draft('moved', born)] } }])
    db.prepare('INSERT INTO document_block_moves VALUES(?,?,?,?,?,?,?,?,?,?)').run(uuid(50), 'a', 'b', 'applied',
      JSON.stringify(['moved']), side('a'), side('b'), '{}', born, now)
    install(db)
    assert.equal(identity(db, 'ambiguous')?.last_owner_kind, 'reserved')
    assert.equal(identity(db, 'ambiguous')?.created_at, null)
    assert.equal(identity(db, 'live')?.last_owner_id, 'c')
    assert.equal(identity(db, 'live')?.state, 'live')
    assert.deepEqual(identity(db, 'moved'), { id: 'moved', last_owner_kind: 'document', last_owner_id: 'b', state: 'retained', created_at: born })
    assert.throws(() => block(db, 'moved', 'a'), /another owner/)
    block(db, 'moved', 'b')
    assert.equal(identity(db, 'moved')?.state, 'live')
  })
})

test('deleting physical blocks retains identities and routes, and only the same document can restore them', () => {
  withLegacy(db => {
    block(db, 'old')
    db.prepare('INSERT INTO document_block_routes VALUES(?,?)').run('old-a', 'old')
    install(db)
    db.prepare('DELETE FROM blocks WHERE id=?').run('old')
    assert.equal(identity(db, 'old')?.state, 'retained')
    assert.equal(count(db, 'SELECT count(*) AS n FROM document_block_routes'), 1)
    assert.throws(() => block(db, 'old', 'b'), /another owner/)
    assert.throws(() => block(db, 'old', 'a', now), /creation time/)
    block(db, 'old')
    assert.equal(identity(db, 'old')?.created_at, born)
    assert.throws(() => db.prepare('DELETE FROM block_identities WHERE id=?').run('old'), /cannot be deleted/)
    const beforeRename = db.prepare('SELECT * FROM block_identities ORDER BY id').all()
    // SQLite may run either the rename or physical-consistency guard first.
    assert.throws(() => db.prepare('UPDATE block_identities SET id=? WHERE id=?').run('other', 'old'),
      error => (error as { code?: string }).code === 'SQLITE_CONSTRAINT_TRIGGER')
    assert.deepEqual(db.prepare('SELECT * FROM block_identities ORDER BY id').all(), beforeRename)
  })
})

test('ordinary cross-document UPDATE remains atomic, preserves time and updates retained ownership', () => {
  withLegacy(db => {
    block(db, 'move')
    install(db)
    db.prepare('UPDATE blocks SET document_id=?,updated_at=? WHERE id=?').run('b', now, 'move')
    assert.equal(identity(db, 'move')?.last_owner_id, 'b')
    assert.equal(identity(db, 'move')?.created_at, born)
    db.prepare('DELETE FROM blocks WHERE id=?').run('move')
    assert.throws(() => block(db, 'move', 'a'), /another owner/)
    block(db, 'move', 'b')
    assert.equal(identity(db, 'move')?.state, 'live')
    assert.throws(() => db.prepare('UPDATE blocks SET id=? WHERE id=?').run('renamed', 'move'), /cannot be changed/)
    assert.throws(() => db.prepare('UPDATE blocks SET created_at=? WHERE id=?').run(now, 'move'), /cannot be changed/)
  })
})

test('document to canonical owner transition preserves routes and requires release before an explicit claim', () => {
  withLegacy(db => {
    block(db, 'shared')
    db.prepare('INSERT INTO document_block_routes VALUES(?,?)').run('a-before', 'shared')
    install(db)
    const groupId = group(db)
    assert.throws(() => canonical(db, 'shared', groupId), /physical owner/)
    assert.throws(() => db.prepare("UPDATE block_identities SET last_owner_kind='group',last_owner_id=? WHERE id='shared'").run(groupId), /agree/)
    db.transaction(() => {
      db.prepare('DELETE FROM blocks WHERE id=?').run('shared')
      db.prepare("UPDATE block_identities SET last_owner_kind='group',last_owner_id=? WHERE id=?").run(groupId, 'shared')
      canonical(db, 'shared', groupId)
    })()
    assert.deepEqual(identity(db, 'shared'), { id: 'shared', last_owner_kind: 'group', last_owner_id: groupId, state: 'live', created_at: born })
    assert.equal(count(db, 'SELECT count(*) AS n FROM document_block_routes WHERE block_id=?', 'shared'), 1)
    assert.throws(() => block(db, 'shared'), /physical owner/)
    db.prepare('DELETE FROM synced_group_blocks WHERE id=?').run('shared')
    assert.equal(identity(db, 'shared')?.state, 'retained')
    assert.throws(() => block(db, 'shared'), /another owner/)
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  })
})

test('only a released retained identity may accept an explicitly selected wire birth time', () => {
  withLegacy(db => {
    block(db, 'wire')
    install(db)
    const groupId = group(db)
    assert.throws(() => db.prepare('UPDATE block_identities SET created_at=? WHERE id=?').run(now, 'wire'), /agree/)
    db.transaction(() => {
      db.prepare('DELETE FROM blocks WHERE id=?').run('wire')
      db.prepare("UPDATE block_identities SET last_owner_kind='group',last_owner_id=?,created_at=? WHERE id=?").run(groupId, now, 'wire')
      canonical(db, 'wire', groupId, now)
    })()
    assert.equal(identity(db, 'wire')?.created_at, now)
    assert.throws(() => db.prepare('UPDATE synced_group_blocks SET created_at=? WHERE id=?').run(born, 'wire'), /cannot be changed/)
  })
})

test('canonical children have one global owner and deferred parents must stay within their group', () => {
  withLegacy(db => {
    install(db)
    const a = group(db), b = group(db, 30)
    db.prepare('UPDATE synced_groups SET creation_id=(SELECT creation_id FROM synced_groups WHERE id=?) WHERE id=?').run(a, b)
    assert.ok(db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(b), 'creation identity is scoped to a group, not globally unique across group IDs')
    canonical(db, 'parent', a)
    canonical(db, 'child', a, born, 'parent', 1)
    assert.equal(identity(db, 'child')?.last_owner_kind, 'group')
    assert.throws(() => block(db, 'child'), /physical owner/)
    assert.throws(() => db.transaction(() => canonical(db, 'foreign-child', b, born, 'parent', 1))(), /FOREIGN KEY/)
    assert.equal(identity(db, 'foreign-child'), undefined, 'failed deferred FK rolls back the identity registration too')
    assert.throws(() => db.prepare('UPDATE synced_group_blocks SET group_id=? WHERE id=?').run(b, 'child'), /explicit retained/)
    assert.throws(() => db.prepare("UPDATE synced_group_blocks SET type='synced-block' WHERE id='child'").run(), /CHECK/)
  })
})

test('instance rows match the actual leaf; deleting its host removes the instance but retains the group and identity', () => {
  withLegacy(db => {
    install(db)
    const groupId = group(db), id = uuid(80)
    canonical(db, 'canonical', groupId)
    block(db, id, 'a', born, { type: 'synced-block', content: JSON.stringify({ version: 1, groupId }) })
    const insert = db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,?,?)')
    assert.throws(() => insert.run(id, groupId, 'b', uuid(81), null, 0), /real host/)
    assert.throws(() => insert.run(id, groupId, 'a', uuid(81), null, 1), /real host/)
    insert.run(id, groupId, 'a', uuid(81), null, 0)
    assert.throws(() => db.prepare('UPDATE blocks SET document_id=? WHERE id=?').run('b', id), /atomic instance/)
    db.prepare('UPDATE blocks SET sort_order=5 WHERE id=?').run(id)
    assert.equal(db.prepare<[string], { binding_version: string }>('SELECT binding_version FROM synced_instances WHERE instance_id=?').get(id)?.binding_version, uuid(81))
    assert.throws(() => block(db, 'child-of-ref', 'a', born, { parent: id, depth: 1 }), /physical children/)
    db.prepare('DELETE FROM documents WHERE id=?').run('a')
    assert.equal(db.prepare('SELECT 1 FROM synced_instances WHERE instance_id=?').get(id), undefined)
    assert.ok(db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(groupId))
    assert.equal(identity(db, id)?.state, 'retained')
    assert.equal(identity(db, 'canonical')?.state, 'live')
  })
})

test('operations, history positions and persistent group pins have independent retained lifetimes', () => {
  withLegacy(db => {
    install(db)
    const groupId = group(db)
    db.prepare('INSERT INTO synced_operations VALUES(?,?,?,?)').run(uuid(90), 'request-hash', '{"status":"noop"}', now)
    assert.throws(() => db.prepare('INSERT INTO synced_operations VALUES(?,?,?,?)').run(uuid(90), 'other-hash', '{}', now), /UNIQUE/)
    const insertHistory = db.prepare('INSERT INTO synced_group_history VALUES(?,?,?,?,?,?,?,?)')
    insertHistory.run(uuid(91), groupId, 1, '[]', '[]', 'before', 'after', now)
    assert.throws(() => insertHistory.run(uuid(92), groupId, 1, '[]', '[]', 'before', 'after', now), /UNIQUE/)
    db.prepare('INSERT INTO synced_host_history VALUES(?,?,?,?,?,?,?)').run(uuid(93), '{"kind":"delete"}', '[]', '[]', 'before', 'after', now)
    db.prepare('INSERT INTO synced_host_history_documents VALUES(?,?,?)').run(uuid(93), 'a', 1)
    db.prepare('INSERT INTO synced_host_history_state VALUES(?,?,?)').run('a', uuid(94), 1)
    db.prepare('INSERT INTO synced_group_pins VALUES(?,?,?,?)').run(groupId, 'document-history', 'version', now)
    db.prepare('DELETE FROM documents WHERE id=?').run('a')
    assert.ok(db.prepare('SELECT 1 FROM synced_host_history_documents WHERE document_id=?').get('a'))
    assert.ok(db.prepare('SELECT 1 FROM synced_host_history_state WHERE document_id=?').get('a'))
    assert.throws(() => db.prepare('DELETE FROM synced_groups WHERE id=?').run(groupId), /FOREIGN KEY/)
    assert.equal(count(db, 'SELECT count(*) AS n FROM synced_group_pins'), 1)
  })
})

test('repeated installation preserves workspace UUIDs, retained owner reservations, canonical rows and migrated routes', () => {
  withLegacy(db => {
    block(db, 'retained')
    db.prepare('INSERT INTO document_block_routes VALUES(?,?)').run('old', 'retained')
    history(db, 'history', 'a', [draft('retained')])
    install(db)
    const groupId = group(db)
    db.transaction(() => {
      db.prepare('DELETE FROM blocks WHERE id=?').run('retained')
      db.prepare("UPDATE block_identities SET last_owner_kind='group',last_owner_id=? WHERE id=?").run(groupId, 'retained')
      canonical(db, 'retained', groupId)
    })()
    const before = identity(db, 'retained'), workspace = db.prepare('SELECT * FROM synced_workspace_state').all()
    db.pragma('user_version=24')
    db.transaction(() => installSyncedBlockSchema(db, { workspaceScope: uuid(100), recoveryEpoch: uuid(101), now }))()
    assert.deepEqual(identity(db, 'retained'), before)
    assert.deepEqual(db.prepare('SELECT * FROM synced_workspace_state').all(), workspace)
    assert.equal(count(db, 'SELECT count(*) AS n FROM document_block_routes'), 1)
    assert.equal(count(db, 'SELECT count(*) AS n FROM synced_group_blocks'), 1)
    assert.equal(db.pragma('user_version', { simple: true }), 24)
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  })
})

test('a bad legacy recovery record rolls the entire migration back without replacing routes or installing a partial schema', () => {
  withLegacy(db => {
    block(db, 'unchanged')
    db.prepare('INSERT INTO document_block_routes VALUES(?,?)').run('old', 'unchanged')
    db.prepare('INSERT INTO document_history VALUES(?,?,?,?,?,?,?)').run('bad', 'a', 'a', 'a', now, 'edit', '{broken')
    const before = db.prepare('SELECT * FROM blocks').all()
    assert.throws(() => install(db), /history:bad/)
    assert.deepEqual(db.prepare('SELECT * FROM blocks').all(), before)
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='block_identities'").get(), undefined)
    const keys = db.pragma('foreign_key_list(document_block_routes)') as Array<{ table: string }>
    assert.equal(keys[0].table, 'blocks')
    assert.equal(count(db, 'SELECT count(*) AS n FROM document_block_routes'), 1)
    assert.equal(db.pragma('user_version', { simple: true }), 25)
  })
})

test('read-only schema assertion rejects missing authority, guards or workspace identity without recreating them', () => {
  for (const damage of ['table', 'trigger', 'modified-trigger', 'workspace'] as const) withLegacy(db => {
    install(db)
    assertSyncedBlockSchema(db)
    if (damage === 'table') db.exec('DROP TABLE synced_operations')
    else if (damage === 'trigger' || damage === 'modified-trigger') {
      db.exec('DROP TRIGGER trg_synced_blocks_identity_insert_guard')
      if (damage === 'modified-trigger') db.exec('CREATE TRIGGER trg_synced_blocks_identity_insert_guard BEFORE INSERT ON blocks BEGIN SELECT 1; END;')
    }
    else db.exec('DELETE FROM synced_workspace_state')
    const schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()
    const namespace = db.prepare('SELECT * FROM synced_workspace_state').all()
    assert.throws(() => assertSyncedBlockSchema(db), /缺少|缺失/)
    assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), schema)
    assert.deepEqual(db.prepare('SELECT * FROM synced_workspace_state').all(), namespace)
    assert.equal(db.inTransaction, false)
  })
})
