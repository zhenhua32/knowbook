import type Database from 'better-sqlite3'
import type { EditorRecoveryBase, EditorRecoveryRecord } from '../../shared/editor-recovery-drafts'
import { canonicalRecoveryOriginalAliasMaterial, canonicalRecoveryRecordedAliasMaterial } from '../../shared/editor-recovery-canonical'
import { readSyncedRecoveryBaselineAliasOwned2 } from '../database/synced-binding-sources'
import { hostHash } from '../database/synced-host-journal'
import { SYNCED_METADATA_BASELINE2_PREFIX } from '../database/synced-metadata-capture-record2'

/** Actual Main owner and its immutable original alias. Only the resulting
 * compact digest is stored alongside the exact draft generation. */
export function captureCanonicalOriginalAliasOwned(db: Database.Database, base: EditorRecoveryBase, readOwnerId: string): string | undefined {
  const old = base.originals[0]
  if (base.owner.kind !== 'group' || base.originals.length !== 1 || old.kind !== 'metadata2-baseline') return undefined
  const actual = readSyncedRecoveryBaselineAliasOwned2(db, readOwnerId), point = actual?.original
  if (!actual || !point || point.kind !== 'synced-metadata2-read-baseline-record' || !point.pointHash
    || point.recordHash !== old.requestHash || old.key !== SYNCED_METADATA_BASELINE2_PREFIX + point.pointHash
    || point.workspaceScope !== base.workspaceScope || point.recoveryEpoch !== base.recoveryEpoch
    || point.sources.length !== 1 || point.sources[0].wire.id !== base.owner.groupId) return undefined
  return hostHash(canonicalRecoveryOriginalAliasMaterial(base, readOwnerId, actual.bindingSource))
}

/** Reconstruct the original renderer packet's exact mapping only to compare
 * it against the private side record's independent Main capture. */
export function verifyCanonicalOriginalAlias(record: EditorRecoveryRecord): boolean {
  const material = canonicalRecoveryRecordedAliasMaterial(record)
  return material !== null && hostHash(material) === record.canonicalOriginalAliasHash
}
