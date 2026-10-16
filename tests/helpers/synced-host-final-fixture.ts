import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { SyncedBindingKey, SyncedCanonicalEdit, SyncedGroupSaved, SyncedHostWorkingBefore,
  SyncedStableBlockDraft, SyncedStructureApplied, SyncedStructureInput, SyncedRestoreHostInput } from '../../src/shared/synced-blocks'
import { parseSyncedBlockPayload, syncedCanonicalEdits } from '../../src/shared/syncedBlockValidation'
import { installSyncedLifecycleSchema } from '../../src/main/database/synced-lifecycle-schema'
import { applySyncedHostFinal, restoreSyncedHostOperation, getSyncedHostHistory } from '../../src/main/database/synced-host-final'
import { updateSyncedBlockGroup } from '../../src/main/database/synced-blocks-content'
import { getSyncedGroupSnapshots } from '../../src/main/database/synced-blocks-read'
import { initialize, ordinary, createGroup, paragraph, born, now, host, other, groupId, instanceId, uuid } from './synced-content-fixture'

export { applySyncedHostFinal, restoreSyncedHostOperation, getSyncedHostHistory, born, now, groupId, instanceId }
export const a = host, b = other, c = ' third:宿主\0 ', secondGroup = uuid(11)
export const bodyId = (documentId: string) => documentId + ':ordinary正文'
export const copy = <T>(value: T): T => structuredClone(value)
export type HostFinal = Extract<SyncedStructureInput, { mode: 'host-final' }>
export type LogicalHost = HostFinal['finalAfter'][number]
export function snapshot(db: Database.Database, id = groupId) {
  const item = getSyncedGroupSnapshots(db, { groupIds: [id] }).items[0]
  assert.ok(item && item.status === 'ready', 'The actual positive group fixture has a complete Main snapshot')
  return item.snapshot
}

export function withHostDatabase(run: (db: Database.Database, second: () => Database.Database) => void) {
  const folder = mkdtempSync(join(tmpdir(), 'knowbook-host-final-')), file = join(folder, 'workspace.db')
  const db = new Database(file), connections: Database.Database[] = []
  try {
    initialize(db)
    db.prepare('UPDATE documents SET title=?,path=?,summary=? WHERE id=?').run('Host A', 'Home/Host A', '', a)
    db.prepare('UPDATE documents SET title=?,path=?,summary=? WHERE id=?').run('Host B', 'Home/Host B', '', b)
    db.prepare('INSERT INTO documents(id,title,slug,path,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(c, 'Host C', 'host-c', 'Home/Host C', '', born, now)
    for (const id of [a, b, c]) {
      ordinary(db, bodyId(id), { owner: id, sort: id === a ? 1 : 0 })
      db.prepare('UPDATE blocks SET content=?,tags_json=?,highlight=? WHERE id=?')
        .run('Body ' + (id === a ? 'A' : id === b ? 'B' : 'C'), JSON.stringify(['original']), 'blue', bodyId(id))
    }
    db.prepare("UPDATE blocks SET tags_json='[]' WHERE type='synced-block'").run()
    createGroup(db, secondGroup, [paragraph(' other-group:child ', 'Other canonical body')])
    db.prepare('INSERT INTO document_block_routes(document_path,block_id) VALUES(?,?)').run('Old/Host A', bodyId(a))
    db.pragma('user_version=26')
    db.transaction(() => { installSyncedLifecycleSchema(db, now); db.pragma('user_version=27') })()
    run(db, () => {
      const next = new Database(file); next.pragma('foreign_keys=ON'); connections.push(next); return next
    })
  } finally {
    for (const connection of connections) if (connection.open) connection.close()
    if (db.open) db.close()
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()))
    assert.ok(basename(folder).startsWith('knowbook-host-final-'), 'Only this isolated host-final fixture folder is removed')
    rmSync(folder, { recursive: true, force: true })
  }
}

type BlockRow = { id: string; type: string; content: string; checked: number; depth: number; parent_block_id: string | null;
  tags_json: string | null; language: string | null; list_start: number | null; markdown_format_json: string | null; highlight: string | null }
export function logical(db: Database.Database, documentId: string): LogicalHost {
  const document = db.prepare('SELECT title,summary FROM documents WHERE id=?').get(documentId) as { title: string; summary: string } | undefined
  assert.ok(document, 'The fixture reads a real persistent host')
  const blocks = db.prepare(`SELECT id,type,content,checked,depth,parent_block_id,tags_json,language,list_start,markdown_format_json,highlight
    FROM blocks WHERE document_id=? ORDER BY sort_order`).all(documentId) as BlockRow[]
  return { documentId, title: document.title, summary: document.summary, blocks: blocks.map(block => ({
    id: block.id, type: block.type, content: block.content, checked: !!block.checked, depth: block.depth,
    parentBlockId: block.parent_block_id, tags: JSON.parse(block.tags_json ?? '[]') as string[],
    ...(block.language === null ? {} : { language: block.language }),
    ...(block.list_start === null ? {} : { listStart: block.list_start }),
    ...(block.markdown_format_json === null ? {} : { markdownFormat: JSON.parse(block.markdown_format_json) as SyncedStableBlockDraft['markdownFormat'] }),
    ...(block.highlight === null ? {} : { highlight: block.highlight }) })) }
}
export const stamp = (db: Database.Database, id: string) => (db.prepare('SELECT updated_at FROM documents WHERE id=?').get(id) as { updated_at: string }).updated_at
export function guards(db: Database.Database, participants: readonly string[], sides: readonly LogicalHost[]) {
  const groupIds = new Set<string>()
  for (const side of [...participants.map(id => logical(db, id)), ...sides]) for (const block of side.blocks) {
    if (block.type === 'synced-block') groupIds.add(parseSyncedBlockPayload(block.content).groupId)
  }
  const groups = [...groupIds].map(id => {
    const row = db.prepare('SELECT revision,topology_revision FROM synced_groups WHERE id=?').get(id) as { revision: string; topology_revision: string } | undefined
    assert.ok(row, 'Each positive fixture group guard names its actual persisted group')
    return { groupId: id, expectedRevision: row.revision, expectedTopologyRevision: row.topology_revision }
  })
  const expectedInstances = (db.prepare('SELECT instance_id,host_document_id,binding_version FROM synced_instances WHERE host_document_id IN (SELECT value FROM json_each(?)) ORDER BY instance_id')
    .all(JSON.stringify(participants)) as Array<{ instance_id: string; host_document_id: string; binding_version: string }>).map(row => ({
      instanceId: row.instance_id, hostDocumentId: row.host_document_id, bindingVersion: row.binding_version }))
  return { groups, expectedInstances }
}
export function request(db: Database.Database, documentIds = [a], change?: (after: LogicalHost[], before: SyncedHostWorkingBefore[]) => void): HostFinal {
  const hostsWorkingBefore = documentIds.map(documentId => {
    const { documentId: _id, ...workingBefore } = logical(db, documentId)
    return { documentId, expectedPersistedUpdatedAt: stamp(db, documentId), workingBefore }
  })
  const finalAfter = hostsWorkingBefore.map(({ documentId, workingBefore }) => ({ documentId, ...copy(workingBefore) }))
  change?.(finalAfter, hostsWorkingBefore)
  const before = hostsWorkingBefore.map(({ documentId, workingBefore }) => ({ documentId, ...workingBefore }))
  return { clientOperationId: randomUUID(), mode: 'host-final', reason: 'source-apply', hostsWorkingBefore,
    finalAfter, newRefSources: [], ...guards(db, documentIds, [...before, ...finalAfter]) }
}
export function changeBody(side: LogicalHost | SyncedHostWorkingBefore['workingBefore'], value: string) {
  const block = side.blocks.find(block => block.type !== 'synced-block')
  assert.ok(block, 'The fixture changes an actual ordinary body block')
  block.content = value
}
export function applied(result: ReturnType<typeof applySyncedHostFinal>): SyncedStructureApplied {
  assert.ok(result.status === 'applied' || result.status === 'noop', 'The real Main host-final writer accepted the supported fixture')
  if (result.status !== 'applied' && result.status !== 'noop') throw new Error('The fixture requires a successful actual structure ACK')
  return result
}
export function edit(db: Database.Database, documentIds: string[], value: string) {
  const input = request(db, documentIds, sides => sides.forEach(side => changeBody(side, value + ':' + side.documentId)))
  return { input, ack: applied(applySyncedHostFinal(db, input)) }
}
export function restoreInput(db: Database.Database, ack: SyncedStructureApplied, direction: 'undo' | 'redo'): SyncedRestoreHostInput {
  assert.ok(ack.historyToken, 'A nonidentity real host-final journal has an executable token')
  const documentIds = ack.hosts.map(host => host.documentId)
  const sides = ack.hosts.flatMap(host => [{ documentId: host.documentId, ...host.logicalBefore }, {
    documentId: host.documentId, title: host.after.title, summary: host.after.summary,
    blocks: host.after.blocks.map(({ sortOrder: _sortOrder, ...block }) => block)
  }])
  return { clientOperationId: randomUUID(), historyToken: ack.historyToken, direction,
    expectedHosts: documentIds.map(documentId => ({ documentId, expectedUpdatedAt: stamp(db, documentId) })),
    ...guards(db, documentIds, sides) }
}
export function restoreAck(db: Database.Database, ack: SyncedStructureApplied, direction: 'undo' | 'redo') {
  return applied(restoreSyncedHostOperation(db, restoreInput(db, ack, direction)))
}
export function allTables(db: Database.Database): Record<string, unknown> {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
  return Object.fromEntries(names.map(({ name }) => {
    const rows = db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()
    rows.sort((left, right) => { const a = JSON.stringify(left) ?? '', b = JSON.stringify(right) ?? ''; return a < b ? -1 : a > b ? 1 : 0 })
    return [name, rows]
  }))
}
export function withoutOperations(db: Database.Database) {
  const { synced_operations: _operations, ...rest } = allTables(db); return rest
}
export function totalChanges(db: Database.Database) { return (db.prepare('SELECT total_changes() AS value').get() as { value: number }).value }
export function identity(db: Database.Database, id: string) {
  return db.prepare('SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get(id) as {
    id: string; last_owner_kind: string; last_owner_id: string; state: string; created_at: string | null } | undefined
}
export function bodyBirth(db: Database.Database, id: string) { return (db.prepare('SELECT created_at FROM blocks WHERE id=?').get(id) as { created_at: string } | undefined)?.created_at }
export function freshBlock(id: string, content = 'new body'): SyncedStableBlockDraft {
  return { id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null, tags: [] }
}
export function savedGroup(result: ReturnType<typeof updateSyncedBlockGroup>): SyncedGroupSaved {
  assert.ok(result.status === 'saved' || result.status === 'noop', 'The real Main content writer accepted the positive canonical edit')
  if (result.status !== 'saved' && result.status !== 'noop') throw new Error('Fixture requires an actual content ACK')
  return result
}
export function groupEdit(db: Database.Database, blocks?: SyncedCanonicalEdit[]) {
  const before = snapshot(db), instance = before.instances[0]
  assert.ok(instance, 'The actual group has a real registered instance for this content edit')
  return savedGroup(updateSyncedBlockGroup(db, { groupId, expectedRevision: before.revision, expectedTopologyRevision: before.topologyRevision,
    clientOperationId: randomUUID(), expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
    blocks: blocks ?? syncedCanonicalEdits(before.blocks).map(block => ({ ...block, content: block.content + ' changed' })) }))
}
export function key(binding: SyncedBindingKey): SyncedBindingKey {
  return { blockId: binding.blockId, from: binding.from, to: binding.to, raw: binding.raw, syntax: binding.syntax }
}
