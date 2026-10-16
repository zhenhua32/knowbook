import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedStructureAction, SyncedStructureInput, SyncedStructureApplied, SyncedPlacement } from '../../src/shared/synced-blocks'
import { applySyncedHostCommand } from '../../src/main/database/synced-host-final'
import { serializeSyncedBlockPayload } from '../../src/shared/syncedBlockValidation'
import * as original from './synced-host-final-fixture'

// This new helper consumes the original frozen host-final fixture without
// editing or replacing its schema, ownership, lifecycle or inverse helpers.
export * from './synced-host-final-fixture'
export { applySyncedHostCommand }
export type InsertCommand = Extract<SyncedStructureInput, { mode: 'command' }> & {
  action: Extract<SyncedStructureAction, { kind: 'insert' }>
}
export function command(db: Database.Database, options: {
  documentId?: string; groupId?: string; instanceId?: string; target?: Partial<SyncedPlacement>
  dirty?: (working: InsertCommand['hostsWorkingBefore'][number]['workingBefore']) => void
} = {}): InsertCommand {
  const documentId = options.documentId ?? original.a, groupId = options.groupId ?? original.groupId
  const hostFinal = original.request(db, [documentId])
  options.dirty?.(hostFinal.hostsWorkingBefore[0].workingBefore)
  const sides = hostFinal.hostsWorkingBefore.map(({ documentId, workingBefore }) => ({ documentId, ...workingBefore }))
  const guards = original.guards(db, [documentId], sides)
  if (!guards.groups.some(group => group.groupId === groupId)) {
    const source = original.snapshot(db, groupId)
    guards.groups.push({ groupId, expectedRevision: source.revision, expectedTopologyRevision: source.topologyRevision })
  }
  return { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore: hostFinal.hostsWorkingBefore, ...guards,
    action: { kind: 'insert', groupId, instanceId: options.instanceId ?? randomUUID(), target: {
      documentId, parentBlockId: null, beforeBlockId: null, depth: 0, ...options.target
    } } }
}
export function insertAck(value: ReturnType<typeof applySyncedHostCommand>): SyncedStructureApplied {
  assert.equal(value.status, 'applied', 'An actual insert has a real W/A delta and cannot be a noop')
  if (value.status !== 'applied') throw new Error('The positive fixture requires an actual insert writer ACK: ' + JSON.stringify(value))
  assert.ok(value.historyToken, 'An actual insert commits its executable journal token')
  return value
}
export function reference(id: string, groupId: string, depth = 0, parentBlockId: string | null = null) {
  return { id, type: 'synced-block', content: serializeSyncedBlockPayload({ version: 1, groupId }), checked: false, depth, parentBlockId, tags: [] }
}
export function groupGuard(db: Database.Database, id: string) {
  const row = db.prepare('SELECT revision,topology_revision FROM synced_groups WHERE id=?').get(id) as { revision: string; topology_revision: string }
  assert.ok(row, 'The guarded group row exists in this real SQLite fixture')
  return { groupId: id, expectedRevision: row.revision, expectedTopologyRevision: row.topology_revision }
}
export function parentChain(working: InsertCommand['hostsWorkingBefore'][number]['workingBefore'], count: number, prefix: string) {
  let parent: string | null = null
  for (let depth = 0; depth < count; depth++) {
    const id = prefix + depth
    working.blocks.push({ ...original.freshBlock(id, 'Container ' + depth), type: 'toggle', depth, parentBlockId: parent })
    parent = id
  }
  return parent!
}
