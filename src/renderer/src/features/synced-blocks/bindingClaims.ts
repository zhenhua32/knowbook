import type { SyncedBindingClaim, SyncedBindingKey, SyncedCanonicalEdit } from '@shared/synced-blocks'
import { validateSyncedBindingClaims } from '@shared/syncedBlockInputs'
import { SyncedValidationError } from '@shared/syncedBlockValidation'

const key = (value: SyncedBindingKey) => JSON.stringify([value.blockId, value.from, value.to, value.raw, value.syntax])
function invalid(): never { throw new SyncedValidationError('binding', '链接编辑来源与当前草稿不一致，请保留草稿后重新打开编辑器。') }

/** This checks the renderer's editing step, not its authority to choose targets.
 * Main separately proves whole-forest AST coverage and all source identities. */
export function validateSyncedWorkingClaims(input: unknown, before: readonly SyncedCanonicalEdit[],
  after: readonly SyncedCanonicalEdit[]): SyncedBindingClaim[] {
  const claims = validateSyncedBindingClaims(input)
  const oldBlocks = new Map(before.map(block => [block.id, block])), nextBlocks = new Map(after.map(block => [block.id, block]))
  const contains = (range: SyncedBindingKey, blocks: ReadonlyMap<string, SyncedCanonicalEdit>) => {
    const block = blocks.get(range.blockId)
    return block && range.to <= block.content.length && block.content.slice(range.from, range.to) === range.raw
  }
  for (const claim of claims) {
    if (!contains(claim.destination, nextBlocks)) invalid()
    if (claim.kind === 'continue' && !contains(claim.source, oldBlocks)) invalid()
    if (claim.kind === 'copy' && claim.source.kind === 'current' && !contains(claim.source.key, oldBlocks)) invalid()
  }
  return claims
}

/** Compose two accepted edit steps using exact occurrence identities. Equal
 * URLs, equal text, block order and today's document paths grant no lineage. */
export function composeSyncedBindingClaims(beforeToMiddle: readonly SyncedBindingClaim[],
  middleToAfter: readonly SyncedBindingClaim[]): SyncedBindingClaim[] {
  const previous = validateSyncedBindingClaims(beforeToMiddle), next = validateSyncedBindingClaims(middleToAfter)
  const byDestination = new Map(previous.map(claim => [key(claim.destination), claim]))
  const result: SyncedBindingClaim[] = next.map(claim => {
    if (claim.kind === 'new') return claim
    if (claim.kind === 'copy' && claim.source.kind === 'ticket') return claim
    const source = claim.kind === 'continue' ? claim.source : claim.source.kind === 'current' ? claim.source.key : invalid()
    const origin = byDestination.get(key(source))
    if (!origin) return invalid()
    if (origin.kind === 'new') return { kind: 'new', destination: claim.destination }
    if (origin.kind === 'copy') return { kind: 'copy', source: origin.source, destination: claim.destination }
    return claim.kind === 'continue'
      ? { kind: 'continue', source: origin.source, destination: claim.destination }
      : { kind: 'copy', source: { kind: 'current', key: origin.source }, destination: claim.destination }
  })
  return validateSyncedBindingClaims(result)
}

/** A same-text new/copy intent can change a stable target; do not erase it as a
 * text noop or collapse it when a coalesced edit returns to its original text. */
export function syncedBindingClaimsAreIdentity(claims: readonly SyncedBindingClaim[]): boolean {
  return claims.every(claim => claim.kind === 'continue' && key(claim.source) === key(claim.destination))
}
