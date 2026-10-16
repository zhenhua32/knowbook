import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { restoreKnowbookDatabase } from '../src/main/database/restore-maintenance'
import { createdGroup27, retireFixture27 } from './helpers/synced-lifecycle-fixture'

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
async function fixture(run: (root: string, file: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-lifecycle-store-')), file = join(root, 'isolated.db')
  try { await run(root, file) } finally { rmSync(root, { recursive: true, force: true }) }
}
function closeAsStandalone(file: string): void {
  const db = new Database(file)
  try { db.pragma('journal_mode=DELETE') } finally { db.close() }
}
/** A unit fixture with the unchanged schema26 definitions, not the independent
 * archived old-reader evidence required by verify-schema27-legacy-readers.ts. */
function schema26Fixture(file: string): void {
  const store = new KnowbookStore(file)
  try {
    const id = store.createDocument(null)
    store.updateDocument(id, { title: 'Before schema27', summary: 'Preserve metadata', blocks: [{
      id: ' opaque old identity\0 ', type: 'paragraph', content: 'Original content', checked: false, depth: 0, parentBlockId: null }] })
  } finally { store.destroy() }
  const db = new Database(file)
  try {
    db.pragma('foreign_keys=ON')
    db.transaction(() => {
      const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND
        (name LIKE 'trg_synced_lifecycle_%' OR name LIKE 'trg_synced_retirement_%' OR name LIKE 'trg_synced_exposure_%')`)
        .all() as Array<{ name: string }>
      for (const { name } of triggers) { assert.match(name, /^[a-z_]+$/); db.exec(`DROP TRIGGER ${name}`) }
      for (const table of ['synced_group_exposure_members', 'synced_exposure_attempts', 'synced_group_retirements', 'synced_group_lifecycle']) db.exec(`DROP TABLE ${table}`)
      db.pragma('user_version=26')
    })()
    db.pragma('journal_mode=DELETE')
  } finally { db.close() }
}
function logical(file: string): unknown {
  const db = new Database(file, { readonly: true })
  try {
    return { version: db.pragma('user_version', { simple: true }),
      schema: db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),
      documents: db.prepare('SELECT * FROM documents ORDER BY id').all(), blocks: db.prepare('SELECT * FROM blocks ORDER BY id').all(),
      identities: db.prepare('SELECT * FROM block_identities ORDER BY id').all(), routes: db.prepare('SELECT * FROM document_block_routes ORDER BY document_path,block_id').all() }
  } finally { db.close() }
}

test('Store migration creates a real pre-27 safety copy and preserves original ordinary data/identities/routes', async () => fixture((_root, file) => {
  schema26Fixture(file)
  const before = logical(file) as { documents: unknown; blocks: unknown; identities: unknown; routes: unknown }
  const store = new KnowbookStore(file)
  store.destroy()
  const migrated = logical(file) as typeof before & { version: number }
  assert.equal(migrated.version, 27)
  for (const key of ['documents', 'blocks', 'identities', 'routes'] as const) assert.deepEqual(migrated[key], before[key])
  const backups = readdirSync(_root).filter(name => name.startsWith('isolated.db.pre-migration-v26-to-v27-'))
  assert.equal(backups.length, 1)
  assert.deepEqual(logical(join(_root, backups[0])), before)
}))

test('broken original26 authority is refused before making a migration safety copy or changing any original bytes', async () => {
  for (const damage of ['guard', 'workspace'] as const) await fixture((root, file) => {
    schema26Fixture(file)
    const db = new Database(file)
    try {
      if (damage === 'guard') db.exec('DROP TRIGGER trg_synced_identity_delete')
      else db.exec('DELETE FROM synced_workspace_state')
    } finally { db.close() }
    const before = hash(file), files = readdirSync(root).sort()
    assert.throws(() => new KnowbookStore(file), /关键结构|身份缺失/)
    assert.equal(hash(file), before)
    assert.deepEqual(readdirSync(root).sort(), files)
    assert.equal(existsSync(file + '-wal'), false)
  })
})

test('schema27 startup refuses missing lifecycle state or critical guards and never recreates them', async () => {
  for (const damage of ['state', 'guard'] as const) await fixture((_root, file) => {
    const store = new KnowbookStore(file), db = store.getUnsafeDatabaseHandle()
    if (damage === 'state') {
      const created = createdGroup27(db)
      const guard = (db.prepare("SELECT sql FROM sqlite_master WHERE name='trg_synced_lifecycle_delete_guard'").get() as { sql: string }).sql
      db.exec('DROP TRIGGER trg_synced_lifecycle_delete_guard')
      db.prepare('DELETE FROM synced_group_lifecycle WHERE group_id=?').run(created.groupId)
      db.exec(guard)
    } else db.exec('DROP TRIGGER trg_synced_exposure_member_delete')
    store.destroy(); closeAsStandalone(file)
    const before = hash(file)
    assert.throws(() => new KnowbookStore(file), /schema27/)
    assert.equal(hash(file), before)
    assert.equal(existsSync(file + '-wal'), false)
  })
})

test('schema27 startup refuses orphan retirement/member authority even with zero real groups and exact guards restored', async () => {
  for (const mode of ['retirement', 'member'] as const) await fixture((root, file) => {
    const store = new KnowbookStore(file)
    store.destroy()
    const db = new Database(file)
    try {
      db.pragma('foreign_keys=OFF')
      const name = mode === 'retirement' ? 'trg_synced_retirement_insert_guard' : 'trg_synced_exposure_member_insert'
      const guard = (db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name) as { sql: string }).sql
      db.exec(`DROP TRIGGER ${name}`)
      if (mode === 'retirement') {
        db.prepare(`INSERT INTO synced_group_retirements(group_id,creation_id,create_history_id,wire_json,semantic_hash,retired_at)
          VALUES(?,?,?,'{}',?,?)`).run(randomUUID(), randomUUID(), randomUUID(), '0'.repeat(64), '2026-10-16T00:00:00.000Z')
      } else {
        db.prepare(`INSERT INTO synced_group_exposure_members(attempt_id,group_id,creation_id,revision,topology_revision,semantic_hash)
          VALUES(?,?,?,?,?,?)`).run(randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), '0'.repeat(64))
      }
      db.exec(guard)
      assert.equal((db.prepare('SELECT count(*) AS count FROM synced_groups').get() as { count: number }).count, 0)
      assert.ok((db.pragma('foreign_key_check') as unknown[]).length)
      db.pragma('journal_mode=DELETE')
    } finally { db.close() }
    const before = hash(file), files = readdirSync(root).sort()
    assert.throws(() => new KnowbookStore(file), /schema27.*外键校验失败/)
    assert.equal(hash(file), before)
    assert.deepEqual(readdirSync(root).sort(), files)
    assert.equal(existsSync(file + '-wal'), false)
  })
})

test('restorer refuses malformed27 and complete retired groups before stopping processes or replacing the current DB', async () => {
  for (const mode of ['missing-table', 'missing-state', 'retired'] as const) await fixture(async (root, file) => {
    const store = new KnowbookStore(file), db = store.getUnsafeDatabaseHandle()
    if (mode === 'missing-table') db.exec('DROP TABLE synced_group_retirements')
    else {
      const created = createdGroup27(db)
      if (mode === 'retired') retireFixture27(db, created)
      else {
        const guard = (db.prepare("SELECT sql FROM sqlite_master WHERE name='trg_synced_lifecycle_delete_guard'").get() as { sql: string }).sql
        db.exec('DROP TRIGGER trg_synced_lifecycle_delete_guard')
        db.prepare('DELETE FROM synced_group_lifecycle WHERE group_id=?').run(created.groupId)
        db.exec(guard)
      }
    }
    store.destroy(); closeAsStandalone(file)
    const before = hash(file), profile = join(root, 'target'), target = join(profile, 'storage', 'knowbook.db')
    const targetStore = new KnowbookStore(target); targetStore.destroy(); closeAsStandalone(target)
    writeFileSync(target, 'Original target bytes must remain untouched')
    let stopped = false
    await assert.rejects(restoreKnowbookDatabase({ userDataRoot: profile, backupPath: file,
      stopProcesses: async () => { stopped = true; return [] } }), /schema27|尚不支持.*同步块正文/)
    assert.equal(stopped, false)
    assert.equal(hash(file), before)
    assert.equal(readFileSync(target, 'utf8'), 'Original target bytes must remain untouched')
  })
})
