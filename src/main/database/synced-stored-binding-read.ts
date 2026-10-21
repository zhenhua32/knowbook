import type Database from 'better-sqlite3'
import type { SyncedBindingKey, SyncedCanonicalWire, SyncedLinkBinding, SyncedLinkTarget, SyncedOriginV1 } from '../../shared/synced-blocks'
import { SyncedValidationError, validateSyncedBindings, validateSyncedCanonicalWire, validateSyncedOrigin } from '../../shared/syncedBlockValidation'
import { parseSyncedBindingOccurrences as occurrences } from '../sync/synced-binding-occurrences'
import { readRawBlockIdentity, resolveRawLiveBlockOwner } from './block-identities-raw-read'

export interface SyncedVerifiedBindingSource { key: SyncedBindingKey; url: string; target: SyncedLinkTarget }
function fail(message: string): never { throw new SyncedValidationError('binding', message) }
const key = (value: Omit<SyncedLinkBinding, 'target'>) => JSON.stringify([value.blockId, value.from, value.to, value.raw, value.syntax])

/** Original stored-side parser/physical-target validation, not an effective
 * write guard or source ticket. No capability repository or public reader is
 * imported; the original plannedGroupId-only validation rule is unchanged. */
export function checkStoredTarget(db: Database.Database, target: SyncedLinkTarget, plannedGroupId?: string): void {
  if (target.kind !== 'block') return
  // Captured target state/owner hints can outlive a rename, deletion or move.
  // Only the stable ID is authoritative. Never replace it from the old URL.
  const identity = readRawBlockIdentity(db, target.id)
  const owner = resolveRawLiveBlockOwner(db, target.id)
  if (!identity) {
    if (plannedGroupId && target.documentId === null && target.state === 'live'
      && db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(plannedGroupId)) return
    fail('已知块目标缺少保留身份；不能按名称重新绑定。')
  }
  if (plannedGroupId && (identity.owner.kind !== 'group' || identity.owner.id !== plannedGroupId)) {
    fail('候选 canonical 目标身份仍由其它归属保留。')
  }
  if (owner?.kind === 'group' && !db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(owner.id)) {
    fail('已知 canonical 目标缺少真实同步组。')
  }
}

/** Validate a trusted journal/persisted side without reinterpreting its targets
 * against today's paths. Historical state hints are not executable resolution. */
export function assertSyncedStoredBindings(db: Database.Database, origin: SyncedOriginV1,
  blocks: readonly SyncedCanonicalWire[], bindings: readonly SyncedLinkBinding[], plannedGroupId?: string): void {
  readSyncedBindingSources(db, origin, blocks, bindings, plannedGroupId)
}

/** Only actual whole-forest parser destinations can become copy sources.
 * Source tickets call this without the candidate-only plannedGroupId exception. */
export function readSyncedBindingSources(db: Database.Database, origin: SyncedOriginV1,
  blocks: readonly SyncedCanonicalWire[], bindings: readonly SyncedLinkBinding[], plannedGroupId?: string): SyncedVerifiedBindingSource[] {
  const checkedOrigin = validateSyncedOrigin(origin), checkedBlocks = validateSyncedCanonicalWire(blocks)
  const checked = validateSyncedBindings(bindings, checkedBlocks), parsed = occurrences(checkedOrigin, checkedBlocks)
  const actual = new Map(parsed.map(item => [key(item), item]))
  const candidateIds = new Set(checkedBlocks.map(block => block.id))
  if (actual.size !== parsed.length || checked.length !== actual.size) fail('链接绑定未准确覆盖实际 Markdown 目的地。')
  const seen = new Set<string>()
  return checked.map(binding => {
    const identity = key(binding)
    if (!actual.has(identity) || seen.has(identity)) fail('链接绑定范围与实际语法不一致。')
    seen.add(identity)
    checkStoredTarget(db, binding.target, plannedGroupId && binding.target.kind === 'block' && candidateIds.has(binding.target.id) ? plannedGroupId : undefined)
    const { target, ...range } = binding
    return { key: range, target, url: actual.get(identity)!.url }
  })
}
