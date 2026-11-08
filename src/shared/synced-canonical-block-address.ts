import { assertSyncedShape, isSyncedBlockId, isSyncedUuid } from './syncedBlockValidation'
import type { WorkspaceSearchOccurrence } from './workspace-search-occurrence'

export interface SyncedCanonicalBlockAddress {
  groupId: string
  creationId: string
  groupCreatedAt: string
  blockId: string
  blockCreatedAt: string
}

export type SyncedCanonicalBlockNavigationResult =
  | { status: 'ready'; occurrence: WorkspaceSearchOccurrence }
  | { status: 'invalid-address' | 'missing-target' | 'target-mismatch' | 'no-instance' | 'ambiguous-instance' }

export const SYNCED_CANONICAL_BLOCK_ADDRESS_PREFIX = 'knowbook-sync-block://'
const fields = ['groupId', 'creationId', 'groupCreatedAt', 'blockId', 'blockCreatedAt'] as const
const pattern = /^knowbook-sync-block:\/\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\?groupBirth=([^/?#&]+)&blockBirth=([^/?#&]+)$/

function isCanonicalBirth(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function encodeBlockSegment(value: string): string {
  if (value === '.' || value === '..') return value.replace(/\./g, '%2E')
  return encodeURIComponent(value).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())
}

export function formatSyncedCanonicalBlockAddress(value: SyncedCanonicalBlockAddress): string {
  assertSyncedShape(value, fields)
  if (!isSyncedUuid(value.groupId) || !isSyncedUuid(value.creationId) || !isSyncedBlockId(value.blockId)
    || !isCanonicalBirth(value.groupCreatedAt) || !isCanonicalBirth(value.blockCreatedAt)) {
    throw new TypeError('同步正文块地址的身份或出生时间无效。')
  }
  return `${SYNCED_CANONICAL_BLOCK_ADDRESS_PREFIX}${value.groupId}/${value.creationId}/${encodeBlockSegment(value.blockId)}`
    + `?groupBirth=${encodeURIComponent(value.groupCreatedAt)}&blockBirth=${encodeURIComponent(value.blockCreatedAt)}`
}

/** The persistent address contains block identity only. Occurrence guards are
 * read by Main when it opens the link. Never normalize this URI with URL. */
export function parseSyncedCanonicalBlockAddress(input: unknown): SyncedCanonicalBlockAddress | null {
  const match = typeof input === 'string' ? pattern.exec(input) : null
  if (!match) return null
  const [, groupId, creationId, block, groupBirth, blockBirth] = match
  try {
    const address = { groupId, creationId, blockId: decodeURIComponent(block),
      groupCreatedAt: decodeURIComponent(groupBirth), blockCreatedAt: decodeURIComponent(blockBirth) }
    return formatSyncedCanonicalBlockAddress(address) === input ? address : null
  } catch { return null }
}
