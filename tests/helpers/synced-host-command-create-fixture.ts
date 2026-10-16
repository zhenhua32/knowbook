import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedCanonicalEdit, SyncedStructureInput, SyncedStructureAction } from '../../src/shared/synced-blocks'
import { updateSyncedBlockGroup } from '../../src/main/database/synced-blocks-content'
import { applySyncedHostCommand, restoreSyncedHostOperation, getSyncedCreateRestoreContext,
  type SyncedHostCreateApplied } from '../../src/main/database/synced-host-final'
import { ordinary } from './synced-content-fixture'
import * as previous from './synced-host-command-move-fixture'

// DRAFT: frozen Main-only ACK/context design d170f436...; not executed.
// Existing frozen fixture modules are consumed through a new re-export only.
export * from './synced-host-command-move-fixture'
export { getSyncedCreateRestoreContext }
export type CreateCommand = Extract<SyncedStructureInput, { mode: 'command' }> & {
  action: Extract<SyncedStructureAction, { kind: 'create' }>
}
export function createRequest(db: Database.Database, options: {
  documentId?: string; selectedRootIds?: string[]; groupId?: string; instanceId?: string
  dirty?: (working: CreateCommand['hostsWorkingBefore'][number]['workingBefore']) => void
} = {}): CreateCommand {
  const documentId = options.documentId ?? previous.a, base = previous.request(db, [documentId])
  const working = base.hostsWorkingBefore[0].workingBefore
  options.dirty?.(working)
  const guards = previous.guards(db, [documentId], [{ documentId, ...working }])
  return { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore: base.hostsWorkingBefore, ...guards,
    action: { kind: 'create', documentId, selectedRootIds: options.selectedRootIds ?? [previous.bodyId(documentId)],
      groupId: options.groupId ?? randomUUID(), instanceId: options.instanceId ?? randomUUID() } }
}
export function seedCreateBlocks(db: Database.Database, blocks: Array<{ id: string; content: string; type?: string; depth?: number; parent?: string }>, documentId = previous.a) {
  const row = db.prepare('SELECT coalesce(max(sort_order),-1)+1 AS next FROM blocks WHERE document_id=?').get(documentId) as { next: number }
  blocks.forEach((block, index) => {
    ordinary(db, block.id, { owner: documentId, sort: row.next + index, type: block.type ?? 'paragraph', depth: block.depth, parent: block.parent })
    db.prepare("UPDATE blocks SET content=?,tags_json='[]' WHERE id=?").run(block.content, block.id)
  })
}
export function editCreatedGroup(db: Database.Database, groupId: string, blocks?: SyncedCanonicalEdit[]) {
  const before = previous.snapshot(db, groupId), instance = before.instances[0]
  assert.ok(instance, 'The real created group has an actual registered instance for a content command')
  return previous.savedGroup(updateSyncedBlockGroup(db, { groupId, expectedRevision: before.revision,
    expectedTopologyRevision: before.topologyRevision, clientOperationId: randomUUID(),
    expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
    blocks: blocks ?? before.blocks.map(({ createdAt: _birth, ...block }) => ({ ...block, content: block.content + ' changed' })) }))
}
export function createdOperation(db: Database.Database, operationId: string) {
  const row = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
    .get(operationId) as { client_operation_id: string; request_hash: string; result_json: string; created_at: string } | undefined
  assert.ok(row, 'The real create or inverse writer committed its exact operation row'); return row
}
export function createdJournal(db: Database.Database, token: string | null) {
  assert.ok(token, 'A real create and its inverse use the original nonnull create journal token')
  const row = db.prepare('SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at FROM synced_host_history WHERE id=?')
    .get(token) as { id: string; action_json: string; before_json: string; after_json: string; before_hash: string; after_hash: string; created_at: string } | undefined
  assert.ok(row, 'The actual immutable finite create journal exists'); return row
}
export function created(value: ReturnType<typeof applySyncedHostCommand>): SyncedHostCreateApplied {
  assert.ok(value.status === 'applied' && 'createdLifecycle' in value, 'A real create or exact inverse returns its independent Main lifecycle ACK')
  if (value.status !== 'applied' || !('createdLifecycle' in value)) throw new Error('An actual create lifecycle ACK is required: ' + JSON.stringify(value))
  assert.ok(value.historyToken, 'A create lifecycle transition retains its original nonnull create history token')
  return value
}
export function createRestoreInput(db: Database.Database, ack: SyncedHostCreateApplied, direction: 'undo' | 'redo') {
  const context = getSyncedCreateRestoreContext(db, { historyToken: ack.historyToken, direction })
  assert.ok(context.status === 'ready', 'The real exact-tail create restore context is available at this supported transition')
  if (context.status !== 'ready') throw new Error('A real ready create restore context is required: ' + JSON.stringify(context))
  return { input: { clientOperationId: randomUUID(), ...context.restore }, context }
}
export function restoreCreated(db: Database.Database, ack: SyncedHostCreateApplied, direction: 'undo' | 'redo') {
  const { input, context } = createRestoreInput(db, ack, direction)
  return { input, context, ack: created(restoreSyncedHostOperation(db, input)) }
}
