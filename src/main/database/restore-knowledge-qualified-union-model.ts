import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import type { CoverageCapsuleReference } from './restore-knowledge-coverage-model'
import { knowledgeGroupComparisonKey, knowledgeHash, type CapsuleKnowledgePayload, type KnowledgeGroup, type KnowledgeDenial,
  type KnowledgeExposure, type KnowledgeObservation, type KnowledgeOccupancy, type KnowledgeMappingField, type KnowledgeHistoricalMaterial } from './restore-knowledge-payload-model'
import { QUALIFIED_KNOWLEDGE_MAX_INPUTS, QUALIFIED_KNOWLEDGE_MAX_JSON_BYTES, qualifiedKnowledgeList, qualifiedKnowledgeInvalid,
  qualifiedKnowledgeCompare as compare, qualifiedKnowledgeLocalLocator, validateQualifiedKnowledgePayload2,
  qualifiedKnowledgePayload2Hash, type QualifiedKnowledgePayload2 } from './restore-knowledge-qualified-payload-model'

/** inputIndex is ONLY an occurrence in the supplied comparison envelope. It is
 * not an owner identity, source handle, physical original count or durable ID. */
export interface QualifiedKnowledgeWitness2 {
  readonly inputIndex: number; readonly capsule: CoverageCapsuleReference; readonly payloadHash: string
  readonly workspaceScope: string | null; readonly recoveryEpoch: string | null
}
export interface QualifiedKnowledgeVariant2<T> { readonly origin: QualifiedKnowledgeWitness2; readonly value: T }
type OccupancyVariant = QualifiedKnowledgeVariant2<KnowledgeOccupancy>
export interface QualifiedKnowledgeUnion2 {
  readonly kind: 'qualified-durable-sql-knowledge-union-diagnostic'; readonly version: 2; readonly status: 'evidence-only'
  readonly payloads: readonly QualifiedKnowledgePayload2[]
  readonly groups: readonly { readonly comparisonKey: string; readonly variants: readonly QualifiedKnowledgeVariant2<KnowledgeGroup>[] }[]
  readonly permanentDenials: readonly QualifiedKnowledgeVariant2<KnowledgeDenial>[]
  readonly exposures: readonly QualifiedKnowledgeVariant2<KnowledgeExposure>[]
  readonly observations: readonly QualifiedKnowledgeVariant2<KnowledgeObservation>[]
  readonly occupancy: readonly OccupancyVariant[]
  readonly exposureKnowledge: readonly { readonly comparisonKey: string; readonly origin: QualifiedKnowledgeWitness2
    readonly lifecycleExposure: 'never' | 'unknown' | 'possible' | 'confirmed' | 'not-in-schema26'
    readonly attemptLowerBound: 'none-recorded' | 'possible' | 'confirmed'; readonly activeRemoteObservation: boolean; readonly retiredRemoteObservation: boolean }[]
  readonly mappingAmbiguities: readonly { readonly namespace: KnowledgeOccupancy['namespace']; readonly id: string; readonly reasons: readonly KnowledgeMappingField[]
    readonly fields: readonly { readonly field: KnowledgeMappingField; readonly alternatives: readonly { readonly knownValues: readonly string[]
      readonly capsules: readonly CoverageCapsuleReference[]; readonly witnesses: readonly QualifiedKnowledgeWitness2[] }[] }[]
    readonly variants: readonly OccupancyVariant[] }[]
  readonly historicalPrimaryRowDifferences: readonly { readonly family: KnowledgeHistoricalMaterial['fact']['family']; readonly key: string
    readonly variants: readonly QualifiedKnowledgeVariant2<KnowledgeHistoricalMaterial>[] }[]
  readonly localLocatorConflictCandidates: readonly { readonly locator: string; readonly classification: 'given-envelope-structural-only'
    readonly variants: readonly QualifiedKnowledgeWitness2[] }[]
  readonly certified: false; readonly acceptedCoverage: false; readonly effective: false; readonly permit: false; readonly fullRootInputSetProven: false
}
/** Rebuild directly from every complete per-input projection. Do not strip a
 * namespace and pass bare refs, old union1 groups or ambiguities to a K1 union.
 * Exact duplicate occurrences remain witnesses; no new ambiguity follows. */
export function unionQualifiedKnowledgeDiagnostics2(input: unknown): QualifiedKnowledgeUnion2 {
  let inputBytes = 0
  const payloads = qualifiedKnowledgeList(input, QUALIFIED_KNOWLEDGE_MAX_INPUTS).map(source => {
    const payload = validateQualifiedKnowledgePayload2(source)
    inputBytes += Buffer.byteLength(capsuleJson(payload))
    if (inputBytes > QUALIFIED_KNOWLEDGE_MAX_JSON_BYTES) return qualifiedKnowledgeInvalid('全部输入outer JSON超准备预算')
    return payload
  })
  const groups = new Map<string, QualifiedKnowledgeVariant2<KnowledgeGroup>[]>()
  const permanentDenials: QualifiedKnowledgeVariant2<KnowledgeDenial>[] = [], exposures: QualifiedKnowledgeVariant2<KnowledgeExposure>[] = []
  const observations: QualifiedKnowledgeVariant2<KnowledgeObservation>[] = [], occupancy: OccupancyVariant[] = []
  const exposureKnowledge: QualifiedKnowledgeUnion2['exposureKnowledge'][number][] = []
  const historical = new Map<string, QualifiedKnowledgeVariant2<KnowledgeHistoricalMaterial>[]>()
  const locators = new Map<string, QualifiedKnowledgeWitness2[]>()
  payloads.forEach((envelope, inputIndex) => {
    const payload: CapsuleKnowledgePayload = envelope.projection
    const origin: QualifiedKnowledgeWitness2 = { inputIndex, capsule: envelope.capsule, payloadHash: qualifiedKnowledgePayload2Hash(envelope),
      workspaceScope: payload.workspaceScope, recoveryEpoch: payload.recoveryEpoch }
    const locator = qualifiedKnowledgeLocalLocator(envelope.capsule), prior = locators.get(locator) ?? []
    prior.push(origin); locators.set(locator, prior)
    for (const value of payload.groups) {
      const variants = groups.get(value.comparisonKey) ?? []; variants.push({ origin, value }); groups.set(value.comparisonKey, variants)
      const attempts = payload.exposures.filter(item => item.members.some(member => member.comparisonKey === value.comparisonKey))
      const markers = payload.observations.filter(item => knowledgeGroupComparisonKey(item.marker.incarnation) === value.comparisonKey)
      exposureKnowledge.push({ comparisonKey: value.comparisonKey, origin, lifecycleExposure: value.lifecycle?.exposure ?? 'not-in-schema26',
        attemptLowerBound: attempts.some(item => item.attempt.state === 'confirmed') ? 'confirmed' : attempts.length ? 'possible' : 'none-recorded',
        activeRemoteObservation: markers.some(item => item.marker.persistence.kind === 'active-confirmed'),
        retiredRemoteObservation: markers.some(item => item.marker.persistence.kind === 'retired-disabled') })
    }
    for (const value of payload.denials) permanentDenials.push({ origin, value })
    for (const value of payload.exposures) exposures.push({ origin, value })
    for (const value of payload.observations) observations.push({ origin, value })
    for (const value of payload.occupancy) occupancy.push({ origin, value })
    for (const value of payload.historicalMaterial) {
      if (['initial-baseline', 'exchange-state', 'exchange-job-head', 'member-exposure'].includes(value.fact.family)) continue
      // This selected-primary diagnostic deliberately retains K1's scope+family
      // key and four-family filter. It is not the stable group/document key.
      const key = capsuleJson([origin.workspaceScope, value.fact.family, value.fact.locator.table, value.fact.locator.key])
      const variants = historical.get(key) ?? []; variants.push({ origin, value }); historical.set(key, variants)
    }
  })
  const byId = new Map<string, OccupancyVariant[]>()
  for (const item of occupancy) {
    const key = capsuleJson([item.value.namespace, item.value.id]), variants = byId.get(key) ?? []
    variants.push(item); byId.set(key, variants)
  }
  const mappingAmbiguities: QualifiedKnowledgeUnion2['mappingAmbiguities'][number][] = []
  for (const variants of byId.values()) {
    const reasons: KnowledgeMappingField[] = [], fields: QualifiedKnowledgeUnion2['mappingAmbiguities'][number]['fields'][number][] = []
    const getters = [
      ['scope', (item: OccupancyVariant) => item.origin.workspaceScope], ['owner-kind', (item: OccupancyVariant) => item.value.ownerKind],
      ['owner-id', (item: OccupancyVariant) => item.value.ownerId], ['known-birth', (item: OccupancyVariant) => item.value.knownBirth],
      ['incarnation', (item: OccupancyVariant) => item.value.incarnationKey]
    ] as const
    for (const [field, get] of getters) {
      const byOccurrence = new Map<number, { origin: QualifiedKnowledgeWitness2; knownValues: Set<string> }>()
      for (const item of variants) {
        const value = get(item)
        if (value === null) continue
        const known = byOccurrence.get(item.origin.inputIndex) ?? { origin: item.origin, knownValues: new Set<string>() }
        known.knownValues.add(value); byOccurrence.set(item.origin.inputIndex, known)
      }
      const alternatives = new Map<string, { knownValues: string[]; capsules: CoverageCapsuleReference[]; witnesses: QualifiedKnowledgeWitness2[] }>()
      for (const { origin, knownValues: known } of byOccurrence.values()) {
        const knownValues = [...known].sort(compare), key = capsuleJson(knownValues)
        const alternative = alternatives.get(key) ?? { knownValues, capsules: [], witnesses: [] }
        alternative.capsules.push(origin.capsule); alternative.witnesses.push(origin); alternatives.set(key, alternative)
      }
      if (alternatives.size > 1) {
        reasons.push(field); fields.push({ field, alternatives: [...alternatives].sort(([a], [b]) => compare(a, b)).map(([, value]) => value) })
      }
    }
    if (reasons.length) mappingAmbiguities.push({ namespace: variants[0].value.namespace, id: variants[0].value.id, reasons, fields, variants })
  }
  const historicalPrimaryRowDifferences = [...historical].filter(([, variants]) => new Set(variants.map(item => item.value.fact.locator.rowHash)).size > 1)
    .map(([key, variants]) => ({ family: variants[0].value.fact.family, key, variants }))
  const localLocatorConflictCandidates = [...locators].filter(([, variants]) => new Set(variants.map(item => item.capsule.manifestHash)).size > 1)
    .map(([locator, variants]) => ({ locator, classification: 'given-envelope-structural-only' as const, variants }))
  const result: QualifiedKnowledgeUnion2 = { kind: 'qualified-durable-sql-knowledge-union-diagnostic', version: 2, status: 'evidence-only', payloads,
    groups: [...groups].sort(([a], [b]) => compare(a, b)).map(([comparisonKey, variants]) => ({ comparisonKey, variants })),
    permanentDenials, exposures, observations, exposureKnowledge, occupancy, mappingAmbiguities, historicalPrimaryRowDifferences, localLocatorConflictCandidates,
    certified: false, acceptedCoverage: false, effective: false, permit: false, fullRootInputSetProven: false }
  if (Buffer.byteLength(capsuleJson(result)) > QUALIFIED_KNOWLEDGE_MAX_JSON_BYTES) return qualifiedKnowledgeInvalid('完整union2 JSON超准备预算，不截断')
  return freezeCapsuleValue(result)
}
export const qualifiedKnowledgeUnion2Hash = (input: unknown): string => knowledgeHash('knowbook.knowledge.qualified-union.v2', unionQualifiedKnowledgeDiagnostics2(input))
export function summarizeQualifiedKnowledgeUnion2(input: unknown) {
  const value = unionQualifiedKnowledgeDiagnostics2(input)
  return freezeCapsuleValue({ kind: 'qualified-knowledge-union-summary', version: 2,
    inputOccurrences: value.payloads.length, inputs: value.payloads.map((item, inputIndex) => ({ inputIndex, capsule: item.capsule,
      payloadHash: qualifiedKnowledgePayload2Hash(item) })), groups: value.groups.length, permanentDenials: value.permanentDenials.length,
    exposures: value.exposures.length, observations: value.observations.length, mappingAmbiguities: value.mappingAmbiguities.length,
    historicalPrimaryRowDifferences: value.historicalPrimaryRowDifferences.length, localLocatorConflictCandidates: value.localLocatorConflictCandidates.length,
    certified: false, acceptedCoverage: false, effective: false, permit: false, fullRootInputSetProven: false })
}
