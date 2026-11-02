import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { AttachmentStore } from '../src/main/attachments'
import { WebDavSyncService } from '../src/main/sync/service'
import { createEphemeralCredentialStorage } from '../src/main/credential-storage'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../src/shared/webdav-sync'
import { assertSyncedBlockSchema } from '../src/main/database/synced-schema'
import { hasCanonicalRuntimeDataOwned } from '../src/main/database/canonical-runtime-read'

const originals = (file: string) => ['','-wal','-shm','-journal'].map(suffix => ({suffix,bytes:existsSync(file + suffix) ? readFileSync(file + suffix) : null}))

test('actual orphan lifecycle and exposure-member remnants without groups are detected before old WebDAV and rejected on complete startup without original writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-canonical-orphan-')), originalFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async () => { networkCalls++; throw new Error('Orphan namespace reached a forbidden network request.') }
  try {
    for (const family of ['lifecycle','exposure-member'] as const) {
      const file = join(root, family, 'storage', 'knowbook.db'), store = KnowbookStore.openCanonicalRuntime(file)
      const service = new WebDavSyncService(store, new AttachmentStore(join(root, family, 'storage', 'assets')), createEphemeralCredentialStorage(randomUUID))
      try {
        service.saveConfig({...DEFAULT_WEBDAV_SYNC_CONFIG,url:'https://example.invalid/personal/',username:'owner',password:'retained'})
        const db = store.getUnsafeDatabaseHandle(), groupId = randomUUID(), creationId = randomUUID(), now = new Date().toISOString()
        const schema = db.prepare('SELECT name,type,sql FROM sqlite_master ORDER BY name,type').all()
        db.pragma('foreign_keys=OFF')
        const triggerName = family === 'lifecycle' ? 'trg_synced_lifecycle_insert_guard' : 'trg_synced_exposure_member_insert'
        const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName) as {sql:string}
        assert.ok(trigger?.sql)
        db.transaction(() => {
          // Corrupt original rows with the real SQL engine, then restore the
          // exact original DDL before testing either production consumer.
          db.exec('DROP TRIGGER ' + triggerName)
          if (family === 'lifecycle') db.prepare(`INSERT INTO synced_group_lifecycle(group_id,creation_id,state,state_version,exposure_state,
            create_history_id,activation_revision,activation_topology_revision,activation_hash,activation_instances_json,created_at,updated_at)
            VALUES(?,?,'active',1,'unknown',NULL,?,?,?,'[]',?,?)`).run(groupId,creationId,randomUUID(),randomUUID(),'a'.repeat(64),now,now)
          else db.prepare(`INSERT INTO synced_group_exposure_members(attempt_id,group_id,creation_id,revision,topology_revision,semantic_hash)
            VALUES(?,?,?,?,?,?)`).run(randomUUID(),groupId,creationId,randomUUID(),randomUUID(),'b'.repeat(64))
          db.exec(trigger.sql)
        })()
        assertSyncedBlockSchema(db)
        assert.deepEqual(db.prepare('SELECT name,type,sql FROM sqlite_master ORDER BY name,type').all(),schema,'Every original schema27 table/index/guard is restored exactly')
        for (const table of ['synced_groups','synced_group_blocks','synced_instances','synced_operations','synced_group_history','synced_host_history','synced_group_pins','synced_exposure_attempts'])
          assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as {n:number}).n,0,table + ' is genuinely empty')
        assert.equal(db.transaction(() => hasCanonicalRuntimeDataOwned(db))(),true)
        assert.ok((db.pragma('foreign_key_check') as unknown[]).length > 0,'The original contains an actual orphan, not a forged detector return value')
        const config = service.getStatus().config
        await assert.rejects(service.sync(),/旧 WebDAV/)
        assert.equal(networkCalls,0)
        assert.deepEqual(service.getStatus().config,config)
      } finally { await service.stop(); store.destroy() }
      const before = originals(file)
      assert.throws(() => KnowbookStore.openCanonicalRuntime(file),/生命周期|foreign|原|Canonical|损坏/)
      assert.deepEqual(originals(file),before,'Admission rejects the actual residual rows before WAL/appSchema/seed writes')
    }
  } finally {
    globalThis.fetch = originalFetch
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('knowbook-canonical-orphan-'))
    assert.equal(lstatSync(root).isSymbolicLink(), false)
    rmSync(root, { recursive: true, force: true })
  }
})
