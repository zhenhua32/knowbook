import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { assertSyncedBlockSchema } from '../src/main/database/synced-schema'
import { withV3Fixture, allTables, snapshot, oldChildId } from './helpers/synced-backup-v3-fixture'

const originalFiles = (file: string) => ['','-wal','-shm','-journal'].map(suffix => {
  const path = file + suffix
  return { suffix, bytes: existsSync(path) ? readFileSync(path) : null }
})

test('the explicit complete Store reopens a real canonical profile twice while the foundation constructor still refuses its unchanged original', async () => {
  await withV3Fixture(f => {
    const before = allTables(f.db), canonical = snapshot(f.db, f.groupId)
    assert.ok(canonical.blocks.some(block => block.id === oldChildId && block.id.includes('\0')))
    f.close()
    const bytes = originalFiles(f.file)
    assert.throws(() => new KnowbookStore(f.file), /尚不支持.*同步块|同步块正文/)
    assert.deepEqual(originalFiles(f.file), bytes)
    for (let visit = 0; visit < 2; visit++) {
      const current = KnowbookStore.openCanonicalRuntime(f.file), sender = Object.freeze({ visit })
      try {
        assert.equal(current.getUnsafeDatabaseHandle().pragma('user_version', { simple: true }), 27)
        assert.deepEqual(allTables(current.getUnsafeDatabaseHandle()), before, 'Admission must not rewrite any original SQL row')
        const opened = current.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: f.hostId,
          instanceId: f.instanceId, groupId: f.groupId })
        assert.equal(opened.status, 'ready')
        if (opened.status !== 'ready') throw new Error('The real original reference was not reopened')
        const result = current.invokeSyncedEditingSession(sender, { sessionId: opened.session.sessionId,
          method: 'getSyncedGroupSnapshots', input: { groupIds: [f.groupId] } })
        const item = result.items[0]
        assert.equal(item.status, 'ready')
        if (item.status !== 'ready') throw new Error('The original group could not be read through Main')
        assert.deepEqual(item.snapshot, canonical)
        assert.deepEqual(allTables(current.getUnsafeDatabaseHandle()), before)
      } finally { current.destroy() }
    }
  })
})

test('a complete reader does not impose a portable group text limit on an unrelated persisted ordinary document', async () => {
  await withV3Fixture(f => {
    const detail = f.store.getDocumentDetail(f.targetId)!
    const large = '普通原文🙂'.repeat(22_000)
    assert.ok(large.length > 100_000)
    f.store.updateDocument(f.targetId, { title: detail.title, summary: detail.summary,
      blocks: detail.blocks.map(block => ({ ...block, content: large })) })
    const before = allTables(f.db)
    f.close()
    const current = KnowbookStore.openCanonicalRuntime(f.file)
    try {
      assert.equal(current.getDocumentDetail(f.targetId)!.blocks[0].content, large)
      assert.deepEqual(allTables(current.getUnsafeDatabaseHandle()), before)
    } finally { current.destroy() }
  })
})

for (const corruption of ['canonical-birth', 'instance-mirror'] as const) {
  test('complete startup rejects actual ' + corruption + ' corruption before changing original database or sidecar bytes', async () => {
    await withV3Fixture(f => {
      f.close()
      const db = new Database(f.file)
      try {
        db.pragma('foreign_keys=ON')
        const trigger = corruption === 'canonical-birth' ? 'trg_synced_identity_update_consistency' : 'trg_synced_instance_update_guard'
        const original = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger) as { sql: string }
        assert.ok(original?.sql)
        db.transaction(() => {
          // Corrupt the isolated original rows, then restore the exact schema.
          // Admission must detect data damage, rather than just missing DDL.
          db.exec('DROP TRIGGER ' + trigger)
          if (corruption === 'canonical-birth') db.prepare('UPDATE block_identities SET created_at=? WHERE id=?')
            .run('1999-01-01T00:00:00.000Z', oldChildId)
          else db.prepare('UPDATE synced_instances SET depth=depth+1 WHERE instance_id=?').run(f.instanceId)
          db.exec(original.sql)
          assertSyncedBlockSchema(db)
        })()
        assert.deepEqual(db.pragma('foreign_key_check'), [])
      } finally { db.close() }
      const bytes = originalFiles(f.file)
      assert.throws(() => KnowbookStore.openCanonicalRuntime(f.file), /identity|归属|创建|出生|镜像|引用|同步|Canonical/)
      assert.deepEqual(originalFiles(f.file), bytes, 'The complete refusal must precede WAL/appSchema/repair')
    })
  })
}
