import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedStructureInput, SyncedStructureApplied, SyncedPlacement, SyncedRootSelection } from '../../src/shared/synced-blocks'
import { applySyncedHostCommand } from '../../src/main/database/synced-host-final'
import * as previous from './synced-host-command-insert-fixture'

export * from './synced-host-command-insert-fixture'
export type MoveCommand = Extract<SyncedStructureInput, { mode: 'command' }> & {
  action: { kind: 'move'; selection: SyncedRootSelection; target: SyncedPlacement }
}
export function moveRequest(db: Database.Database, options: { documentId?: string; selectedRootIds?: string[];
  target?: Partial<SyncedPlacement>; dirty?: (working: MoveCommand['hostsWorkingBefore'][number]['workingBefore']) => void
} = {}): MoveCommand {
  const documentId = options.documentId ?? previous.a, base = previous.request(db, [documentId])
  const working = base.hostsWorkingBefore[0].workingBefore
  options.dirty?.(working)
  const sides = [{ documentId, ...working }]
  return { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore: base.hostsWorkingBefore,
    ...previous.guards(db, [documentId], sides), action: { kind: 'move', selection: {
      documentId, selectedRootIds: options.selectedRootIds ?? [previous.bodyId(documentId)]
    }, target: { documentId, parentBlockId: null, beforeBlockId: working.blocks[0]?.id ?? null, depth: 0, ...options.target } } }
}
export function moved(result: ReturnType<typeof applySyncedHostCommand>): SyncedStructureApplied {
  assert.equal(result.status, 'applied', 'The supported positive move has an actual accepted logical delta')
  if (result.status !== 'applied') throw new Error('A successful real move ACK is required: ' + JSON.stringify(result))
  assert.ok(result.historyToken, 'A nonidentity real move commits its executable history token')
  return result
}
export function mixedForest(db: Database.Database) {
  const owner = ' move:real owner ', child = ' move:real child ', outside = ' move:outside '
  const input = previous.command(db, { dirty: working => working.blocks.push({ ...previous.freshBlock(owner, 'Owner'), type: 'toggle' },
    { ...previous.freshBlock(child, 'Child'), depth: 1, parentBlockId: owner }, previous.freshBlock(outside, 'Outside')),
    target: { parentBlockId: owner, beforeBlockId: child, depth: 1 } })
  const ack = previous.insertAck(applySyncedHostCommand(db, input))
  return { owner, child, outside, nestedId: input.action.instanceId, input, ack }
}
