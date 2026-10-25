import type { CoverageCapsuleReference, CoverageRootReference, RawCoverageRequirement } from './restore-knowledge-coverage-model'
import type { CompleteOriginalRootData, OriginalSourceInput } from './restore-knowledge-original-input-types'
import type { KnowledgeOccupancy } from './restore-knowledge-payload-model'
import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { knowledgeGroupComparisonKey, knowledgeHash } from './restore-knowledge-payload-model'
import { requiredDagRootLocator } from './restore-knowledge-required-dag-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { DURABLE_SQL_DAG_MAX_CAPSULES, DURABLE_SQL_DAG_MAX_DEPTH, DURABLE_SQL_DAG_MAX_NODES } from './restore-knowledge-dag-model'

export type Root3Projection = OriginalSourceInput['knowledge']['projection']
export interface Root3Witness {
  /** Every entry is interpreted in the preceding original node. No receiving
   * profile namespace, bare UUID or hash deduplication identifies this domain. */
  readonly domain: readonly CoverageRootReference[]
  readonly side: 'source' | 'current'
  readonly capsule: CoverageCapsuleReference
  readonly projectionHash: string
}
export interface Root3Payload {
  readonly key: string; readonly witness: Root3Witness
  readonly input: OriginalSourceInput
}
const commonFamilies = ['originals', 'groups', 'denials', 'exposures', 'observations', 'occupancy', 'identities', 'instances', 'hostStates', 'pins',
  'bindings', 'databaseViewReferences', 'hostJournals', 'exchangeCuts', 'recoveryBoundaries', 'restoreLineage',
  'groupHistories', 'archivedGroupHistories', 'historicalMaterial'] as const
const families = [...commonFamilies, 'coverageAnchors', 'coverageMaterial', 'legacyRestoreReceipts'] as const
export type Root3FactFamily = typeof families[number]
export interface Root3FactReference { readonly payload: string; readonly family: Root3FactFamily; readonly index: number }
export interface Root3GroupConstraint {
  readonly comparisonKey: string
  readonly groups: readonly Root3FactReference[]; readonly denials: readonly Root3FactReference[]
  readonly exposures: readonly Root3FactReference[]; readonly observations: readonly Root3FactReference[]
  readonly disposition: 'permanent-denial' | 'preserve-exposure' | 'preserve-identity'
  readonly requiresQualifiedIncarnationMapping: true
  readonly activeObservationIsInstallationPermission: false
}
export interface Root3MappingConstraint {
  readonly namespace: KnowledgeOccupancy['namespace']; readonly id: string
  readonly facts: readonly Root3FactReference[]
  readonly variants: readonly { readonly payload: string; readonly workspaceScope: string | null; readonly ownerKind: KnowledgeOccupancy['ownerKind']
    readonly ownerId: string | null; readonly knownBirth: string | null; readonly incarnationKey: string | null
    readonly facts: readonly Root3FactReference[] }[]
  readonly requiresQualifiedMapping: true
}
export interface Root3PriorReference {
  readonly payload: string; readonly requirement: RawCoverageRequirement
  readonly resolvedDomain: readonly CoverageRootReference[]
  readonly originalRoot: CoverageRootReference; readonly originalInputsHash: string
  /** The original SQL row, its copied input graph and its complete K are
   * available. The coverage's material/plan/cut still require acceptance. */
  readonly acceptedCoverage: false
}
export interface Root3ReferenceResolution {
  readonly domain: readonly CoverageRootReference[]; readonly capsule: CoverageCapsuleReference
  readonly originalReference: CoverageRootReference; readonly mountedReference: CoverageRootReference
}
export interface Root3KnowledgeConstraints {
  readonly kind: 'complete-qualified-knowledge-conservation-plan'; readonly version: 3
  readonly root: CoverageRootReference; readonly originalInputsHash: string
  readonly nodes: readonly { readonly domain: readonly CoverageRootReference[]; readonly root: CoverageRootReference
    readonly originalInputsHash: string; readonly payloads: readonly string[] }[]
  readonly payloads: readonly Root3Payload[]
  readonly facts: Readonly<Record<Root3FactFamily, readonly Root3FactReference[]>>
  readonly groups: readonly Root3GroupConstraint[]; readonly mapping: readonly Root3MappingConstraint[]
  readonly priorCoverage: readonly Root3PriorReference[]
  readonly completeOriginalInputSet: 'requires-private-main-owner'
  readonly coverageAcceptanceRequired: number
  readonly semanticValidationComplete: false; readonly acceptedCoverage: false; readonly effective: false; readonly permit: false
  /** This is a conservation constraint hash, never coverage.planHash for an
   * installed content/identity/history/asset transition. */
  readonly conservationHash: string
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const same = (a: unknown, b: unknown): boolean => capsuleJson(a) === capsuleJson(b)
export const root3WitnessKey = (witness: Root3Witness): string => knowledgeHash('knowbook.root3.complete-witness.v3', witness)
export function root3Invalid(message: string): never {
  throw new Error('完整qualified知识规划无效：' + message + '；规划不授coverage接受、政策重放或安装权。')
}
function familyRows(projection: Root3Projection, family: Root3FactFamily): readonly unknown[] {
  if (family === 'coverageAnchors' || family === 'coverageMaterial' || family === 'legacyRestoreReceipts')
    return 'coverageAnchors' in projection ? projection[family] : []
  return projection[family]
}
/** Derive data only. The Main owner below must supply the complete actual SQL
 * capture. In particular this function never brands a caller DTO as genuine. */
export function deriveRoot3KnowledgeConstraints(original: CompleteOriginalRootData, resolutions: readonly Root3ReferenceResolution[]): Root3KnowledgeConstraints {
  const payloads: Root3Payload[] = [], nodes: Root3KnowledgeConstraints['nodes'][number][] = []
  const priorCoverage: Root3PriorReference[] = [], domains = new Set<string>()
  const consumedResolutions = new Set<Root3ReferenceResolution>()
  let planningBytes = 0
  const charge = (value: unknown): void => {
    planningBytes += Buffer.byteLength(capsuleJson(value))
    if (planningBytes > CAPSULE2_RAW_MAX_JSON_BYTES) return root3Invalid('完整规划数据超原有限JSON预算，不截断')
  }
  function walk(value: CompleteOriginalRootData, domain: readonly CoverageRootReference[]): void {
    if (domain.length >= DURABLE_SQL_DAG_MAX_DEPTH || nodes.length >= DURABLE_SQL_DAG_MAX_NODES) return root3Invalid('完整原域图超原深度/节点预算')
    const domainKey = capsuleJson(domain)
    if (domains.has(domainKey)) return root3Invalid('逻辑原域重复')
    domains.add(domainKey)
    const own: string[] = [], entries: Array<{ side: 'source' | 'current'; input: OriginalSourceInput }> = []
    for (const [side, binding] of [['source', value.node.source], ['current', value.node.current]] as const) {
      const matching = value.inputs.filter(input => same(input.binding, binding))
      if (matching.length !== 1) return root3Invalid('两侧完整原输入未唯一覆盖原node')
      entries.push({ side, input: matching[0] })
    }
    if (value.inputs.length !== 2 || same(entries[0].input.binding.capsule, entries[1].input.binding.capsule)) return root3Invalid('缺独立两侧原输入')
    const node = { domain, root: value.root, originalInputsHash: value.materialHash, payloads: own }
    charge(node); nodes.push(node)
    for (const { side, input } of entries) {
      if (payloads.length >= DURABLE_SQL_DAG_MAX_CAPSULES) return root3Invalid('完整输入超原capsule预算')
      const projection = input.knowledge.projection
      const witness: Root3Witness = { domain, side, capsule: input.binding.capsule, projectionHash: input.knowledge.projectionHash }
      const key = root3WitnessKey(witness)
      const payload = { key, witness, input }
      charge(key); charge(payload); own.push(key); payloads.push(payload)
      const requirements = 'priorCoverageRequirements' in projection ? projection.priorCoverageRequirements.entries : []
      if (requirements.length && input.binding.capsule.readerVersion !== 'knowbook-durable-sql-coverage-v2') return root3Invalid('v1不能承载prior-C')
      const required = input.binding.requiredRoots
      const parents = value.parents.filter(parent => required.some(ref => same(ref, parent.reference)))
      if (parents.length !== required.length) return root3Invalid('完整原域父引用未被原件全集覆盖')
      const rawRoots = [...new Map(requirements.map(entry => [requiredDagRootLocator(entry.root), entry.root])).values()]
        .sort((a, b) => compare(requiredDagRootLocator(a), requiredDagRootLocator(b)))
      if (rawRoots.length !== required.length) return root3Invalid('原SQL与绑定的父引用全集不闭合')
      const mappings = resolutions.filter(resolution => same(resolution.domain, domain) && same(resolution.capsule, input.binding.capsule))
      if (mappings.length !== required.length) return root3Invalid('缺完整实际引用上下文映射')
      for (const ref of required) if (mappings.filter(mapping => same(mapping.mountedReference, ref)).length !== 1) return root3Invalid('实际mounted原域映射缺失或重复')
      for (const requirement of requirements) {
        const matching = mappings.filter(mapping => same(mapping.originalReference, requirement.root))
        if (matching.length !== 1) return root3Invalid('原SQL引用未由其完整上下文唯一解释')
        consumedResolutions.add(matching[0])
        const parent = parents.find(candidate => same(candidate.reference, matching[0].mountedReference))
        if (!parent || !same({ ...requirement.root, namespace: parent.original.root.namespace }, parent.original.root)) return root3Invalid('原SQL引用与所复制原root不一致')
        const prior = { payload: key, requirement, resolvedDomain: [...domain, parent.reference],
          originalRoot: parent.original.root, originalInputsHash: parent.original.materialHash, acceptedCoverage: false as const }
        charge(prior); priorCoverage.push(prior)
      }
    }
    if (!same(value.parents.map(parent => parent.reference), value.node.parents)) return root3Invalid('原node完整父集发生变化')
    for (const parent of value.parents) walk(parent.original, [...domain, parent.reference])
  }
  walk(original, [])
  if (consumedResolutions.size !== resolutions.length) return root3Invalid('实际上下文映射含未消费额外引用')
  if (nodes.length !== original.nodes || payloads.length !== original.capsules) return root3Invalid('完整原件节点/来源计数不闭合')
  const facts = Object.fromEntries(families.map(family => [family, []])) as unknown as Record<Root3FactFamily, Root3FactReference[]>
  const groupMap = new Map<string, { comparisonKey: string; groups: Root3FactReference[]; denials: Root3FactReference[]
    exposures: Root3FactReference[]; observations: Root3FactReference[]; exposed: boolean }>()
  const group = (key: string) => {
    let result = groupMap.get(key)
    if (!result) { result = { comparisonKey: key, groups: [], denials: [], exposures: [], observations: [], exposed: false }; charge(result); groupMap.set(key, result) }
    return result
  }
  const mapping = new Map<string, { namespace: KnowledgeOccupancy['namespace']; id: string; facts: Root3FactReference[]
    variants: Map<string, Root3MappingConstraint['variants'][number] & { facts: Root3FactReference[] }> }>()
  for (const payload of payloads) {
    const projection = payload.input.knowledge.projection
    for (const family of families) for (let index = 0; index < familyRows(projection, family).length; index++) {
      const ref = { payload: payload.key, family, index }; charge(ref); facts[family].push(ref)
    }
    projection.groups.forEach((value, index) => {
      const result = group(value.comparisonKey)
      const ref = { payload: payload.key, family: 'groups' as const, index }; charge(ref); result.groups.push(ref)
      // Missing schema26 lifecycle is unknown historical exposure, never a
      // proof of "never" that could erase a conservative restore constraint.
      result.exposed ||= value.lifecycle === null || value.lifecycle.exposure !== 'never'
    })
    projection.denials.forEach((value, index) => {
      const ref = { payload: payload.key, family: 'denials' as const, index }; charge(ref); group(value.comparisonKey).denials.push(ref)
    })
    projection.exposures.forEach((value, index) => {
      for (const key of new Set(value.members.map(member => member.comparisonKey))) {
        const result = group(key), ref = { payload: payload.key, family: 'exposures' as const, index }
        charge(ref); result.exposed = true; result.exposures.push(ref)
      }
    })
    projection.observations.forEach((value, index) => {
      const result = group(knowledgeGroupComparisonKey(value.marker.incarnation))
      const ref = { payload: payload.key, family: 'observations' as const, index }; charge(ref)
      result.exposed = true; result.observations.push(ref)
    })
    projection.occupancy.forEach((value, index) => {
      const key = capsuleJson([value.namespace, value.id]), ref: Root3FactReference = { payload: payload.key, family: 'occupancy', index }
      let entry = mapping.get(key)
      if (!entry) { entry = { namespace: value.namespace, id: value.id, facts: [], variants: new Map() }; charge({ namespace: value.namespace, id: value.id }) }
      const variant = { payload: payload.key, workspaceScope: projection.workspaceScope, ownerKind: value.ownerKind, ownerId: value.ownerId,
        knownBirth: value.knownBirth, incarnationKey: value.incarnationKey }
      const variantKey = capsuleJson(variant)
      let found = entry.variants.get(variantKey)
      if (!found) { found = { ...variant, facts: [] }; charge(found) }
      charge(ref); charge(ref); entry.facts.push(ref); found.facts.push(ref); entry.variants.set(variantKey, found); mapping.set(key, entry)
    })
  }
  const body = { kind: 'complete-qualified-knowledge-conservation-plan' as const, version: 3 as const,
    root: original.root, originalInputsHash: original.materialHash, nodes, payloads, facts,
    groups: [...groupMap].sort(([a], [b]) => compare(a, b)).map(([, { exposed, ...value }]) => ({ ...value,
      disposition: value.denials.length ? 'permanent-denial' as const : exposed ? 'preserve-exposure' as const : 'preserve-identity' as const,
      requiresQualifiedIncarnationMapping: true as const,
      activeObservationIsInstallationPermission: false as const })),
    mapping: [...mapping].sort(([a], [b]) => compare(a, b)).map(([, value]) => ({ namespace: value.namespace, id: value.id, facts: value.facts,
      variants: [...value.variants].sort(([a], [b]) => compare(a, b)).map(([, variant]) => variant), requiresQualifiedMapping: true as const })),
    priorCoverage, completeOriginalInputSet: 'requires-private-main-owner' as const, coverageAcceptanceRequired: priorCoverage.length,
    semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  if (Buffer.byteLength(capsuleJson(body)) > CAPSULE2_RAW_MAX_JSON_BYTES) return root3Invalid('完整知识规划超原有限JSON预算，不截断')
  return freezeCapsuleValue({ ...body, conservationHash: knowledgeHash('knowbook.qualified-knowledge-conservation-plan.v3', body) })
}

/** Exact fact lookup retains the original reader's full projection, including
 * capsule2 coverage anchors/material and every original row/history body. */
export function root3Fact(plan: Root3KnowledgeConstraints, reference: Root3FactReference): unknown {
  const payload = plan.payloads.find(value => value.key === reference.payload)
  if (!payload || !families.includes(reference.family) || !Number.isSafeInteger(reference.index) || reference.index < 0
    || reference.index >= familyRows(payload.input.knowledge.projection, reference.family).length) return root3Invalid('事实引用不属于完整规划')
  return familyRows(payload.input.knowledge.projection, reference.family)[reference.index]
}
