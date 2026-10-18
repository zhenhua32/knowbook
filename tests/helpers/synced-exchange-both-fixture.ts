import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { previewSyncedExchangeBoth, resolveSyncedExchangeBoth } from '../../src/main/sync/synced-exchange'
import type { SyncedExchangeBothDecision, SyncedExchangeBothPreviewComponent } from '../../src/main/sync/synced-exchange-both-types'
import { withConflicts, randomUUID, runtime, editKeepingKeys, completed, snapshot } from './synced-exchange-conflict-fixture'
import { command, insertAck } from './synced-host-command-insert-fixture'
import { applySyncedHostCommand } from '../../src/main/database/synced-host-final'
export * from './synced-exchange-conflict-fixture'
export { previewSyncedExchangeBoth, resolveSyncedExchangeBoth }
export type Preview = Extract<Awaited<ReturnType<typeof previewSyncedExchangeBoth>>, { status: 'ready' }>['preview']
export type BothResult = Awaited<ReturnType<typeof resolveSyncedExchangeBoth>>
export type Accepted = Extract<BothResult, { status: 'applied' | 'noop' | 'deferred' }>
export type Base = Omit<Parameters<Parameters<typeof withConflicts>[0]>[0], 'preview' | 'resolve'>
export type Profile = Base['B']
export type Fixture = Base & {
  previewBoth: (profile?: Profile, previewId?: string) => ReturnType<typeof previewSyncedExchangeBoth>
  resolveBoth: (preview: Preview, decisions: SyncedExchangeBothDecision[], operationId?: string, profile?: Profile) => ReturnType<typeof resolveSyncedExchangeBoth>
}
export async function withBoth(run: (f: Fixture) => Promise<void>, options: Parameters<typeof withConflicts>[1] = {}) {
  return withConflicts(async f => run(bindBoth(f)), options)
}
export function bindBoth(f: Base): Fixture {
    const previewBoth = (profile = f.B, previewId: string = randomUUID()) => f.track(previewSyncedExchangeBoth(profile.db,
      { previewId, userDataRoot: profile.root, target: f.targetConfig }, runtime))
    const resolveBoth = (p: Preview, decisions: SyncedExchangeBothDecision[], operationId: string = randomUUID(), profile = f.B) =>
      f.track(resolveSyncedExchangeBoth(profile.db, { ...f.input(operationId, profile), previewId: p.previewId, decisions }, runtime))
    return { ...f, previewBoth, resolveBoth }
}
export function readyBoth(value: Awaited<ReturnType<typeof previewSyncedExchangeBoth>>): Preview {
  assert.equal(value.status, 'ready')
  assert.ok(value.status === 'ready', 'A real both preview captures the complete authenticated source component')
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.preview) && Object.isFrozen(value.preview.components), 'Both preview shells and component collection are readonly')
  for (const c of value.preview.components) assert.ok(Object.isFrozen(c) && Object.isFrozen(c.copyDocuments) && Object.isFrozen(c.groups) && Object.isFrozen(c.entities), 'Both exposes immutable copy, group and authored-entity destinations')
  return value.preview
}
export function bothComponent(p: Preview, key: string): SyncedExchangeBothPreviewComponent {
  const c = p.components.find(value => value.keys.includes(key))
  assert.ok(c, 'The exact real dependency component is present in the both preview')
  return c
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export function selectBoth(c: SyncedExchangeBothPreviewComponent, options: { copies?: string[]; hosts?: 'existing' | 'none' | 'copied' } = {}): SyncedExchangeBothDecision {
  assert.ok(c.choices.includes('both'), 'Only a fully guarded original both candidate is selected')
  const copies = [...new Set(options.copies ?? c.copyDocuments.map(doc => doc.sourceDocumentId))].sort(compare)
  const groups = c.groups.map(group => ({ groupId: group.sourceGroupId,
    hosts: group.hosts.filter(host => options.hosts === 'none' ? false : options.hosts === 'existing' ? host.destination === 'existing'
      : options.hosts === 'copied' ? host.destination === 'copied' && copies.includes(host.sourceDocumentId)
        : copies.includes(host.sourceDocumentId) ? host.destination === 'copied' : host.destination === 'existing')
      .map(({ sourceDocumentId, sourceInstanceId, destination }) => ({ sourceDocumentId, sourceInstanceId, destination }))
      .sort((a, b) => compare(a.sourceDocumentId, b.sourceDocumentId) || compare(a.sourceInstanceId, b.sourceInstanceId) || compare(a.destination, b.destination))
  })).sort((a, b) => compare(a.groupId, b.groupId))
  return { componentId: c.componentId, copyDocumentIds: copies, groups }
}
export function acceptedBoth(value: BothResult): Accepted {
  assert.ok(value.status === 'applied' || value.status === 'noop' || value.status === 'deferred', 'The real both operation settled an installed finite result rather than a published-local blocker')
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.forks), 'The installed both result and original fork summaries are readonly')
  return value
}
export function forkSummary(value: Accepted, componentId: string) {
  const summary = value.forks.find(row => row.componentId === componentId)
  assert.ok(summary, 'The exact accepted component has its original immutable allocation summary')
  assert.match(summary.allocationHash, /^[a-f0-9]{64}$/)
  return summary
}
export async function overlappingGroup(f: Base) {
  const id = f.ack.createdLifecycle.groupId
  completed(await f.exchange(f.A)); completed(await f.exchange(f.B))
  editKeepingKeys(f.A, id, blocks => { blocks[0].content = 'REMOTE conflicting prefix ' + blocks[0].content })
  completed(await f.exchange(f.A), 'applied')
  editKeepingKeys(f.B, id, blocks => { blocks[0].content = 'LOCAL conflicting prefix ' + blocks[0].content })
  return id
}
export function insert(profile: Profile, groupId: string, documentId: string, options: { instanceId?: string; parentBlockId?: string | null; depth?: number } = {}) {
  const input = command(profile.db, { documentId, groupId, instanceId: options.instanceId,
    target: { parentBlockId: options.parentBlockId ?? null, depth: options.depth ?? 0 } })
  return { input, ack: insertAck(applySyncedHostCommand(profile.db, input)) }
}
export function physicalKnowledge(db: Database.Database) {
  const tables = ['documents', 'blocks', 'synced_groups', 'synced_group_blocks', 'synced_instances', 'block_identities']
  return Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM ' + table).all().map(row => JSON.stringify(row)).sort()]))
}
export function identity(db: Database.Database, id: string) {
  return db.prepare('SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get(id) as
    { id: string; last_owner_kind: string; last_owner_id: string | null; state: string; created_at: string | null } | undefined
}
export function directGroupSource(f: Base, id: string) { return snapshot(f.B.db, id) }
