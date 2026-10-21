/** Finite original SQL evidence formats. These values describe historical
 * records only; neither a serializable fact nor its locator grants authority. */
const formats = {
  'group-ack': [null], 'host-ack': [1], 'host-create-ack': [1], 'initial-incoming': [1],
  'exchange-receipt': [1, 2, 3, 4, 5, 6, 7], 'remote-observation': [1],
  'logical-deletion-proof': [1, 2], 'recovery-epoch': [1], 'initial-baseline': [1],
  'exchange-state': [1, 2], 'exchange-job': [1, 2, 3, 4, 5, 6, 7], 'exchange-job-head': [1],
  'exchange-job-phase': [1, 2], 'conflict-preview': [1, 2], 'both-preview': [1, 2],
  'deletion-preview': [1], 'exchange-history-index': [1], 'exchange-history-row': [1],
  'exchange-host-cut': [1], 'backup-v3': [1], 'recovery-boundary': [1], 'member-exposure': [null]
} as const
for (const versions of Object.values(formats)) Object.freeze(versions)
export const RAW_SYNCED_HISTORICAL_FORMATS = Object.freeze(formats)
export type RawHistoricalEvidenceFamily = keyof typeof RAW_SYNCED_HISTORICAL_FORMATS
export const RAW_SYNCED_HISTORICAL_TABLES = Object.freeze(['synced_operations', 'app_settings', 'synced_exposure_attempts',
  'synced_group_exposure_members', 'synced_group_pins', 'synced_host_history', 'synced_group_history',
  'synced_groups', 'synced_group_lifecycle', 'synced_group_retirements', 'block_identities'] as const)
export type RawHistoricalEvidenceTable = typeof RAW_SYNCED_HISTORICAL_TABLES[number]
export interface RawHistoricalEvidenceLocator {
  readonly table: RawHistoricalEvidenceTable
  readonly key: readonly (string | number)[]
  readonly rowHash: string
}
export interface RawHistoricalEvidenceFact {
  readonly family: RawHistoricalEvidenceFamily
  readonly version: number | null
  readonly evidenceClass: 'durable-only' | 'index-attempt-only'
  readonly locator: RawHistoricalEvidenceLocator
  readonly supports: readonly RawHistoricalEvidenceLocator[]
}
export interface RawSyncedHistoricalEvidence {
  readonly version: 1
  readonly operations: number
  readonly metadata: number
  readonly facts: readonly RawHistoricalEvidenceFact[]
}
