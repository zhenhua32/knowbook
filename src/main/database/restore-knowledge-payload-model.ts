import type { SyncedGroupWire, SyncedOriginV1, SyncedLinkBinding } from '../../shared/synced-blocks'
import type { SyncedGroupLifecycle } from './synced-lifecycle-state'
import type { SyncedRemoteObservationMarker } from './synced-remote-observation-codec'
import type { SyncedLogicalDeletionProof } from '../sync/synced-logical-deletion-model'
import type { SyncedLogicalDeletionChoiceProof } from '../sync/synced-logical-deletion-choice-model'
import type { ExchangeJob, ExchangeReceipt, ExchangeHostCut } from '../sync/synced-exchange-model'
import type { SyncedRecoveryHistoryBoundary } from './synced-recovery-boundary-model'
import type { RawHistoricalEvidenceFact } from './synced-history-evidence-model'
import type { decodeHostJournal, HostSide } from './synced-host-journal'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import type { RawRestoreSqlCell } from './restore-knowledge-sql-cell'

export interface KnowledgeCapsuleRef {
  readonly kind: 'durable-sql-capsule-ref'; readonly version: 1
  readonly operationId: string; readonly capsuleId: string; readonly manifestHash: string
}
/** Exact SQLite storage classes. TEXT/blob bytes use the original DB encoding;
 * integers and IEEE754 bits never pass through JSON numeric coercion. */
export type KnowledgeSqlCell = RawRestoreSqlCell
export interface KnowledgeRowRef {
  readonly table: string; readonly key: readonly KnowledgeSqlCell[]; readonly occurrence: number; readonly rowHash: string
}
export interface KnowledgeOriginalRow extends KnowledgeRowRef { readonly cells: readonly KnowledgeSqlCell[] }
export interface KnowledgeOriginalTable {
  readonly table: string; readonly columns: readonly string[]; readonly primaryKey: readonly string[]
  readonly fullColumnsHash: string; readonly disclosure: 'complete-evidence-rows' | 'identity-projection'
  readonly rows: readonly KnowledgeOriginalRow[]
}
export interface KnowledgeTuple {
  readonly groupId: string; readonly creationId: string; readonly createdAt: string; readonly origin: SyncedOriginV1
}
export interface KnowledgeGroup {
  readonly tuple: KnowledgeTuple; readonly comparisonKey: string; readonly originalOriginJson: string
  readonly source: KnowledgeRowRef; readonly lifecycle: SyncedGroupLifecycle | null
  readonly guards: { readonly revision: string; readonly topologyRevision: string; readonly historyCursor: string; readonly historyPosition: number }
  readonly lifecycleSource: KnowledgeRowRef | null
  readonly retirement: { readonly wire: SyncedGroupWire; readonly semanticHash: string; readonly retiredAt: string;
    readonly createHistoryId: string; readonly source: KnowledgeRowRef } | null
  readonly createJournalSource: KnowledgeRowRef | null
}
export interface KnowledgeExposure {
  readonly attempt: { readonly id: string; readonly requestHash: string; readonly channel: string; readonly targetFingerprint: string;
    readonly publicationHash: string; readonly state: 'possible' | 'confirmed'; readonly createdAt: string; readonly confirmedAt: string | null }
  readonly kind: 'member-attempt' | 'active-observation' | 'retired-observation-anchor' | 'permanent-denial-anchor' | 'history-boundary-anchor'
  readonly members: readonly { readonly tuple: KnowledgeTuple; readonly comparisonKey: string; readonly revision: string;
    readonly topologyRevision: string; readonly semanticHash: string; readonly source: KnowledgeRowRef }[]
  readonly source: KnowledgeRowRef
}
export interface KnowledgeObservation { readonly marker: SyncedRemoteObservationMarker; readonly source: KnowledgeRowRef }
export interface KnowledgeDenial {
  readonly proof: SyncedLogicalDeletionProof | SyncedLogicalDeletionChoiceProof
  readonly comparisonKey: string; readonly source: KnowledgeRowRef
  readonly receipt: ExchangeReceipt; readonly job: ExchangeJob
  readonly mandatoryMaterial: readonly KnowledgeRowRef[]
}
export interface KnowledgeOccupancy {
  readonly namespace: 'document' | 'block' | 'group' | 'instance' | 'database' | 'column' | 'view' | 'entity'; readonly id: string
  readonly kind: 'physical' | 'ledger' | 'history' | 'template' | 'route' | 'restore-map'
  readonly ownerKind: 'document' | 'group' | 'reserved' | 'database' | null; readonly ownerId: string | null
  readonly knownBirth: string | null; readonly source: KnowledgeRowRef
  readonly incarnationKey: string | null
}
export interface KnowledgeHostJournal {
  readonly historyToken: string; readonly kind: 'bare-create' | 'host-command' | 'host-final'
  readonly documentIds: readonly string[]; readonly source: KnowledgeRowRef
  readonly mappings: readonly KnowledgeRowRef[]
  readonly decoded: { readonly kind: 'finite'; readonly value: ReturnType<typeof decodeHostJournal> }
    | { readonly kind: 'bare-create'; readonly before: readonly HostSide[]; readonly after: readonly HostSide[] }
}
/** This is complete original SQL material for a previously strict-dispatched
 * finite family, not a material/spool or historical execution permit. Primary
 * and support references resolve to full storage-class rows in originals. */
export interface KnowledgeHistoricalMaterial {
  readonly fact: RawHistoricalEvidenceFact; readonly primary: KnowledgeRowRef; readonly supports: readonly KnowledgeRowRef[]
}
export interface KnowledgeCapturedBinding {
  readonly binding: SyncedLinkBinding; readonly source: KnowledgeRowRef
  readonly provenance: 'current-stored' | 'retirement' | 'group-history' | 'archive-history' | 'denial-before' | 'create-journal'
}
export interface CapsuleKnowledgePayload {
  readonly kind: 'durable-sql-knowledge-payload'; readonly version: 1; readonly material: 'durable-sql-only'
  readonly capsule: KnowledgeCapsuleRef; readonly schemaVersion: 26 | 27
  readonly workspaceScope: string | null; readonly recoveryEpoch: string | null
  readonly schemaHash: string; readonly inventoryHash: string; readonly encoding: string
  readonly lifecycleAvailability: 'schema27' | 'not-in-schema26'
  readonly originals: readonly KnowledgeOriginalTable[]; readonly groups: readonly KnowledgeGroup[]
  readonly exposures: readonly KnowledgeExposure[]; readonly observations: readonly KnowledgeObservation[]
  readonly denials: readonly KnowledgeDenial[]; readonly occupancy: readonly KnowledgeOccupancy[]
  readonly identities: readonly { readonly id: string; readonly ownerKind: 'document' | 'group' | 'reserved'; readonly ownerId: string;
    readonly state: 'live' | 'retained'; readonly createdAt: string | null; readonly source: KnowledgeRowRef }[]
  readonly instances: readonly { readonly instanceId: string; readonly groupId: string; readonly hostDocumentId: string;
    readonly bindingVersion: string; readonly parentBlockId: string | null; readonly depth: number; readonly source: KnowledgeRowRef }[]
  readonly hostStates: readonly { readonly documentId: string; readonly cursor: string; readonly position: number; readonly source: KnowledgeRowRef }[]
  readonly pins: readonly { readonly groupId: string; readonly kind: string; readonly pinId: string; readonly createdAt: string; readonly source: KnowledgeRowRef }[]
  readonly bindings: readonly KnowledgeCapturedBinding[]
  readonly databaseViewReferences: readonly { readonly databaseId: string; readonly viewId: string | null;
    readonly fieldIds: readonly string[]; readonly source: KnowledgeRowRef }[]
  readonly hostJournals: readonly KnowledgeHostJournal[]
  readonly exchangeCuts: readonly { readonly cut: ExchangeHostCut; readonly source: KnowledgeRowRef; readonly journalSource: KnowledgeRowRef }[]
  readonly recoveryBoundaries: readonly { readonly boundary: SyncedRecoveryHistoryBoundary; readonly source: KnowledgeRowRef;
    readonly markerSource: KnowledgeRowRef; readonly anchorSource: KnowledgeRowRef }[]
  readonly restoreLineage: readonly { readonly lineage: string; readonly kind: 'document' | 'block' | 'database' | 'column' | 'view' | 'entity';
    readonly sourceDatabaseId: string; readonly sourceId: string; readonly state: 'live' | 'missing'; readonly targetId: string; readonly source: KnowledgeRowRef }[]
  readonly groupHistories: readonly { readonly historyId: string; readonly groupId: string; readonly position: number;
    readonly before: SyncedGroupWire; readonly after: SyncedGroupWire; readonly source: KnowledgeRowRef }[]
  readonly archivedGroupHistories: readonly { readonly archive: 'exchange' | 'recovery'; readonly operationId: string;
    readonly archivedAt: string; readonly historyId: string; readonly groupId: string; readonly position: number;
    readonly before: SyncedGroupWire; readonly after: SyncedGroupWire; readonly source: KnowledgeRowRef }[]
  readonly historicalMaterial: readonly KnowledgeHistoricalMaterial[]
}
export interface KnowledgeOrigin { readonly capsule: KnowledgeCapsuleRef; readonly workspaceScope: string | null; readonly recoveryEpoch: string | null }
export type KnowledgeMappingField = 'scope' | 'owner-kind' | 'owner-id' | 'known-birth' | 'incarnation'
export interface KnowledgeUnionDiagnostic {
  readonly kind: 'durable-sql-knowledge-union-diagnostic'; readonly version: 1; readonly status: 'evidence-only'
  readonly payloads: readonly CapsuleKnowledgePayload[]
  readonly groups: readonly { readonly comparisonKey: string; readonly variants: readonly { readonly origin: KnowledgeOrigin; readonly value: KnowledgeGroup }[] }[]
  readonly permanentDenials: readonly { readonly origin: KnowledgeOrigin; readonly value: KnowledgeDenial }[]
  readonly exposures: readonly { readonly origin: KnowledgeOrigin; readonly value: KnowledgeExposure }[]
  readonly observations: readonly { readonly origin: KnowledgeOrigin; readonly value: KnowledgeObservation }[]
  readonly exposureKnowledge: readonly { readonly comparisonKey: string; readonly origin: KnowledgeOrigin;
    readonly lifecycleExposure: SyncedGroupLifecycle['exposure'] | 'not-in-schema26';
    readonly attemptLowerBound: 'none-recorded' | 'possible' | 'confirmed';
    readonly activeRemoteObservation: boolean; readonly retiredRemoteObservation: boolean }[]
  readonly occupancy: readonly { readonly origin: KnowledgeOrigin; readonly value: KnowledgeOccupancy }[]
  /** Different per-original known-value sets are mapping-plan candidates, never
   * contradictions. Historical moves/births can explain them. Identical copies
   * do not create a new ambiguity; unknown values never negate known evidence. */
  readonly mappingAmbiguities: readonly { readonly namespace: KnowledgeOccupancy['namespace']; readonly id: string;
    readonly reasons: readonly KnowledgeMappingField[]
    readonly fields: readonly { readonly field: KnowledgeMappingField;
      readonly alternatives: readonly { readonly knownValues: readonly string[]; readonly capsules: readonly KnowledgeCapsuleRef[] }[] }[]
    readonly variants: readonly { readonly origin: KnowledgeOrigin; readonly value: KnowledgeOccupancy }[] }[]
  /** Selected primary rowHash differences only. Supports may evolve independently.
   * Same scope/locator is no accepted lineage, corruption finding or authority. */
  readonly historicalPrimaryRowDifferences: readonly { readonly family: RawHistoricalEvidenceFact['family']; readonly key: string;
    readonly variants: readonly { readonly origin: KnowledgeOrigin; readonly value: KnowledgeHistoricalMaterial }[] }[]
}
export const knowledgeHash = (domain: string, value: unknown): string => capsuleBytesHash(capsuleJson({ domain, value }))
export const knowledgeCapsuleKey = (value: KnowledgeCapsuleRef): string => capsuleJson(value)
/** Comparison candidates only. No mutable CAS/cursor/lifecycle/journal hash is
 * part of this key; equal keys never establish a content or mapping capability. */
export const knowledgeGroupComparisonKey = (tuple: KnowledgeTuple): string => knowledgeHash('knowbook.knowledge.group-tuple.v1', {
  groupId: tuple.groupId, creationId: tuple.creationId, createdAt: tuple.createdAt, origin: tuple.origin
})
export const knowledgeDocumentComparisonKey = (id: string, createdAt: string): string => knowledgeHash('knowbook.knowledge.document-birth.v1', { id, createdAt })
export const knowledgePayloadHash = (value: CapsuleKnowledgePayload): string => knowledgeHash('knowbook.knowledge.payload.v1', value)

/** Pure diagnostic projection; caller DTOs accepted here cannot mint any private
 * payload/union identity. Different snapshots retain all original variants. */
export function unionKnowledgePayloadDiagnostics(input: readonly CapsuleKnowledgePayload[]): KnowledgeUnionDiagnostic {
  const unique = new Map<string, CapsuleKnowledgePayload>()
  for (const payload of input) {
    const key = knowledgeCapsuleKey(payload.capsule), previous = unique.get(key)
    if (previous && knowledgePayloadHash(previous) !== knowledgePayloadHash(payload)) throw new Error('同一准确capsule原件产生矛盾完整payload')
    unique.set(key, payload)
  }
  const payloads = [...unique].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value)
  const groups = new Map<string, Array<{ origin: KnowledgeOrigin; value: KnowledgeGroup }>>()
  const permanentDenials: Array<{ origin: KnowledgeOrigin; value: KnowledgeDenial }> = []
  const exposures: Array<{ origin: KnowledgeOrigin; value: KnowledgeExposure }> = [], observations: Array<{ origin: KnowledgeOrigin; value: KnowledgeObservation }> = []
  const occupancy: Array<{ origin: KnowledgeOrigin; value: KnowledgeOccupancy }> = []
  const exposureKnowledge: Array<KnowledgeUnionDiagnostic['exposureKnowledge'][number]> = []
  const historicalPrimaryRows = new Map<string, Array<{ origin: KnowledgeOrigin; value: KnowledgeHistoricalMaterial }>>()
  for (const payload of payloads) {
    const origin = { capsule: payload.capsule, workspaceScope: payload.workspaceScope, recoveryEpoch: payload.recoveryEpoch }
    for (const value of payload.groups) {
      const list = groups.get(value.comparisonKey) ?? []; list.push({ origin, value }); groups.set(value.comparisonKey, list)
      const attempts = payload.exposures.filter(attempt => attempt.members.some(member => member.comparisonKey === value.comparisonKey))
      const markers = payload.observations.filter(item => knowledgeGroupComparisonKey(item.marker.incarnation) === value.comparisonKey)
      exposureKnowledge.push({ comparisonKey: value.comparisonKey, origin, lifecycleExposure: value.lifecycle?.exposure ?? 'not-in-schema26',
        attemptLowerBound: attempts.some(item => item.attempt.state === 'confirmed') ? 'confirmed' : attempts.length ? 'possible' : 'none-recorded',
        activeRemoteObservation: markers.some(item => item.marker.persistence.kind === 'active-confirmed'),
        retiredRemoteObservation: markers.some(item => item.marker.persistence.kind === 'retired-disabled') })
    }
    for (const value of payload.denials) permanentDenials.push({ origin, value }) // Never subtract due to another live/never/scope snapshot.
    for (const value of payload.exposures) exposures.push({ origin, value })
    for (const value of payload.observations) observations.push({ origin, value })
    for (const value of payload.occupancy) occupancy.push({ origin, value })
    for (const value of payload.historicalMaterial) {
      // Exclude evolving state/head/baseline/exposure primaries. All remaining
      // primary row variants are diagnostic across originals, not contradictions
      // or authority; equal locators do not establish accepted shared lineage.
      if (['initial-baseline', 'exchange-state', 'exchange-job-head', 'member-exposure'].includes(value.fact.family)) continue
      const key = capsuleJson([origin.workspaceScope, value.fact.family, value.fact.locator.table, value.fact.locator.key])
      const list = historicalPrimaryRows.get(key) ?? []; list.push({ origin, value }); historicalPrimaryRows.set(key, list)
    }
  }
  const byId = new Map<string, typeof occupancy>()
  for (const value of occupancy) { const key = capsuleJson([value.value.namespace, value.value.id]), list = byId.get(key) ?? []; list.push(value); byId.set(key, list) }
  const mappingAmbiguities: Array<KnowledgeUnionDiagnostic['mappingAmbiguities'][number]> = []
  for (const variants of byId.values()) {
    const reasons: KnowledgeMappingField[] = []
    const ambiguousFields: Array<KnowledgeUnionDiagnostic['mappingAmbiguities'][number]['fields'][number]> = []
    const fields = [
      ['scope', (item: typeof occupancy[number]) => item.origin.workspaceScope],
      ['owner-kind', (item: typeof occupancy[number]) => item.value.ownerKind],
      ['owner-id', (item: typeof occupancy[number]) => item.value.ownerId],
      ['known-birth', (item: typeof occupancy[number]) => item.value.knownBirth],
      ['incarnation', (item: typeof occupancy[number]) => item.value.incarnationKey]
    ] as const
    for (const [field, get] of fields) {
      const byCapsule = new Map<string, { capsule: KnowledgeCapsuleRef; knownValues: Set<string> }>()
      for (const item of variants) {
        const value = get(item)
        if (value === null) continue // Unknown is never counterevidence.
        const key = knowledgeCapsuleKey(item.origin.capsule)
        const known = byCapsule.get(key) ?? { capsule: item.origin.capsule, knownValues: new Set<string>() }
        known.knownValues.add(value); byCapsule.set(key, known)
      }
      const alternatives = new Map<string, { knownValues: string[]; capsules: KnowledgeCapsuleRef[] }>()
      for (const known of byCapsule.values()) {
        const knownValues = [...known.knownValues].sort(), key = capsuleJson(knownValues)
        const alternative = alternatives.get(key) ?? { knownValues, capsules: [] }
        alternative.capsules.push(known.capsule); alternatives.set(key, alternative)
      }
      // A capsule can retain several owners/births from legitimate history.
      // Compare whole known-value sets per original, rather than crossing
      // values across copies. Even different sets are only plan ambiguities.
      if (alternatives.size > 1) {
        reasons.push(field)
        ambiguousFields.push({ field, alternatives: [...alternatives].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([, value]) => value) })
      }
    }
    if (reasons.length) mappingAmbiguities.push({ namespace: variants[0].value.namespace, id: variants[0].value.id, reasons,
      fields: ambiguousFields, variants })
  }
  const historicalPrimaryRowDifferences = [...historicalPrimaryRows].filter(([, variants]) => new Set(variants.map(item => item.value.fact.locator.rowHash)).size > 1)
    .map(([key, variants]) => ({ family: variants[0].value.fact.family, key, variants }))
  return freezeCapsuleValue({ kind: 'durable-sql-knowledge-union-diagnostic' as const, version: 1 as const, status: 'evidence-only' as const,
    payloads, groups: [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([comparisonKey, variants]) => ({ comparisonKey, variants })),
    permanentDenials, exposures, observations, exposureKnowledge, occupancy, mappingAmbiguities, historicalPrimaryRowDifferences })
}
