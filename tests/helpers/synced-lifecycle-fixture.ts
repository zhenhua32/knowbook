import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedCanonicalWire, SyncedGroupWire } from '../../src/shared/synced-blocks'
import { canonicalSyncedPortableJson } from '../../src/shared/syncedBlockPortable'
import { getSyncedGroupSnapshots } from '../../src/main/database/synced-blocks-read'
import { syncedLifecycleSemanticHash } from '../../src/main/database/synced-lifecycle-state'
import { born, host, now } from './synced-content-fixture'

/** Existing tests that manually insert groups in a current Store must also
 * supply accurate state before canonical rows. This is a fixture-only legacy
 * unknown registration, never an application API for proving non-publication. */
export function unknownGroup27(db: Database.Database, groupId: string, blocks: SyncedCanonicalWire[]): void {
  const group = db.prepare('SELECT * FROM synced_groups WHERE id=?').get(groupId) as {
    id: string; creation_id: string; created_at: string; origin_json: string; bindings_json: string;
    revision: string; topology_revision: string
  }
  const wire: SyncedGroupWire = { kind: 'synced-group', id: group.id, creationId: group.creation_id,
    createdAt: group.created_at, origin: JSON.parse(group.origin_json), bindings: JSON.parse(group.bindings_json), blocks }
  db.prepare(`INSERT INTO synced_group_lifecycle(group_id,creation_id,state,state_version,exposure_state,create_history_id,
    activation_revision,activation_topology_revision,activation_hash,activation_instances_json,created_at,updated_at)
    VALUES(?,?,'active',1,'unknown',NULL,?,?,?,'[]',?,?)`).run(group.id, group.creation_id, group.revision,
    group.topology_revision, syncedLifecycleSemanticHash(wire), now, now)
}

/** Explicit SQL fixtures for persistent state/read tests. These helpers do not
 * implement or claim the production structure writer or its inverse. */
export function createdGroup27(db: Database.Database, content = 'Newly created group') {
  const groupId = randomUUID(), creationId = randomUUID(), instanceId = randomUUID(), childId = ` opaque:${randomUUID()}\0 `
  const journalId = randomUUID(), revision = randomUUID(), topologyRevision = randomUUID(), bindingVersion = randomUUID()
  const origin = { version: 1 as const, documentId: host, pathAtCreation: 'Original/Host', firstInstanceId: instanceId }
  const wire: SyncedGroupWire = { kind: 'synced-group', id: groupId, creationId, createdAt: born, origin, bindings: [],
    blocks: [{ id: childId, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null, createdAt: born }] }
  const hash = syncedLifecycleSemanticHash(wire)
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(host, host, host, host, born, now)
    db.prepare(`INSERT INTO synced_groups(id,creation_id,created_at,origin_json,revision,topology_revision,history_cursor)
      VALUES(?,?,?,?,?,?,?)`).run(groupId, creationId, born, canonicalSyncedPortableJson(origin), revision, topologyRevision, randomUUID())
    db.prepare(`INSERT INTO synced_host_history(id,action_json,before_json,after_json,before_hash,after_hash,created_at)
      VALUES(?,?,'[]','[]',?,?,?)`).run(journalId, canonicalSyncedPortableJson({ kind: 'create', documentId: host,
      selectedRootIds: [childId], groupId, instanceId }), syncedLifecycleSemanticHash([]), syncedLifecycleSemanticHash([]), now)
    db.prepare(`INSERT INTO synced_group_lifecycle(group_id,creation_id,state,state_version,exposure_state,create_history_id,
      activation_revision,activation_topology_revision,activation_hash,activation_instances_json,created_at,updated_at)
      VALUES(?,?,'active',1,'never',?,?,?,?,?,?,?)`).run(groupId, creationId, journalId, revision, topologyRevision, hash,
      canonicalSyncedPortableJson([{ instanceId, hostDocumentId: host, bindingVersion }]), now, now)
    db.prepare(`INSERT INTO synced_group_blocks(id,group_id,sort_order,type,content,checked,depth,created_at)
      VALUES(?,?,0,'paragraph',?,0,0,?)`).run(childId, groupId, content, born)
    const order = (db.prepare('SELECT coalesce(max(sort_order),-1)+1 AS next FROM blocks WHERE document_id=?').get(host) as { next: number }).next
    db.prepare(`INSERT INTO blocks(id,document_id,sort_order,type,content,checked,depth,created_at,updated_at)
      VALUES(?,?,?,'synced-block',?,0,0,?,?)`).run(instanceId, host, order, JSON.stringify({ version: 1, groupId }), born, now)
    db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,NULL,0)')
      .run(instanceId, groupId, host, bindingVersion)
  })()
  return { groupId, creationId, instanceId, childId, journalId, wire, hash }
}

export function retireFixture27(db: Database.Database, fixture: ReturnType<typeof createdGroup27>): void {
  const item = getSyncedGroupSnapshots(db, { groupIds: [fixture.groupId] }).items[0]
  assert.equal(item.status, 'ready')
  db.transaction(() => {
    db.prepare(`INSERT INTO synced_group_retirements(group_id,creation_id,create_history_id,wire_json,semantic_hash,retired_at)
      VALUES(?,?,?,?,?,?)`).run(fixture.groupId, fixture.creationId, fixture.journalId,
      canonicalSyncedPortableJson(fixture.wire), fixture.hash, now)
    db.prepare('DELETE FROM synced_instances WHERE group_id=?').run(fixture.groupId)
    db.prepare('DELETE FROM blocks WHERE id=?').run(fixture.instanceId)
    db.prepare('DELETE FROM synced_group_blocks WHERE group_id=?').run(fixture.groupId)
    db.prepare(`UPDATE synced_group_lifecycle SET state='retired-create',state_version=state_version+1,updated_at=? WHERE group_id=?`)
      .run(now, fixture.groupId)
  })()
}
