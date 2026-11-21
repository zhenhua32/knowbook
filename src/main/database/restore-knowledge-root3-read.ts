import { assertCompleteOriginalPackageBytes, assertCompleteOriginalVerificationBytes5, readCompleteOriginalPackage, captureMixedOriginalPackageWithInitialInputs,
  captureQualifiedOriginalBundle, captureQualifiedOriginalBundleWithInitialContent5, captureQualifiedOriginalBundleFromReferences,
  captureReopenedQualifiedOriginalBundle, captureReopenedQualifiedOriginalContent5,
  type CompleteOriginalBundle } from './restore-knowledge-qualified-originals'
import type { CompleteOriginalPackage } from './restore-knowledge-original-input-types'
import { deriveRoot3KnowledgeConstraints, root3Invalid, type Root3KnowledgeConstraints } from './restore-knowledge-root3-model'
import { freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readRoot3OriginalReferenceResolutions } from './restore-knowledge-root3-contexts'
import { scopeCurrentReferenceBlocks5, scopeIncomingReferenceTables5, withReferenceOriginalRows5 } from './restore-knowledge-reference-original-rows5'
import { isWorkingAssetArchive5 } from './restore-knowledge-capsule2-asset-archive'

export interface RootKnowledgeConservationPlan3 { readonly kind: 'main-complete-qualified-knowledge-plan' }
const plans = new WeakMap<RootKnowledgeConservationPlan3, { original: CompleteOriginalBundle; expectedHash: string }>()

/** The only owner factory reads a genuine complete original package. Caller
 * projections, envelopes, reference subsets and resolver callbacks never enter. */
export async function prepareRootKnowledgeConservationPlan3(original: CompleteOriginalBundle) {
  return mintFromInitial(original, await readCompleteOriginalPackage(original))
}
async function mintFromInitial(original: CompleteOriginalBundle, actual: CompleteOriginalPackage) {
  const value = deriveRoot3KnowledgeConstraints(actual.original, await readRoot3OriginalReferenceResolutions(actual))
  await assertCompleteOriginalPackageBytes(original)
  const plan: RootKnowledgeConservationPlan3 = Object.freeze({ kind: 'main-complete-qualified-knowledge-plan' })
  plans.set(plan, { original, expectedHash: value.conservationHash })
  return Object.freeze({ plan, value: owned(value) })
}
/** Initial sharing is confined to these fixed Main capture calls. Hot reads
 * below never reuse their initial K or constraints. */
export async function captureMixedRootKnowledgeConservationPlan3(input: Parameters<typeof captureMixedOriginalPackageWithInitialInputs>[0]) {
  const captured = await captureMixedOriginalPackageWithInitialInputs(input)
  const knowledge = await mintFromInitial(captured.bundle, captured.originalPackage)
  return Object.freeze({ ...captured, knowledgePlan: knowledge.plan, knowledgeValue: knowledge.value })
}
export async function captureRootKnowledgeConservationPlanFromCertifiedSources3(input: Parameters<typeof captureQualifiedOriginalBundle>[0]) {
  const captured = await captureQualifiedOriginalBundle(input)
  const knowledge = await mintFromInitial(captured.bundle, captured.originalPackage)
  return Object.freeze({ ...captured, knowledgePlan: knowledge.plan, knowledgeValue: knowledge.value })
}
export async function captureRootKnowledgeConservationPlanFromReferences3(input: Parameters<typeof captureQualifiedOriginalBundleFromReferences>[0]) {
  const captured = await captureQualifiedOriginalBundleFromReferences(input)
  const knowledge = await mintFromInitial(captured.bundle, captured.originalPackage)
  return Object.freeze({ ...captured, knowledgePlan: knowledge.plan, knowledgeValue: knowledge.value })
}
export async function captureReopenedRootKnowledgeConservationPlan3(input: Parameters<typeof captureReopenedQualifiedOriginalBundle>[0]) {
  const captured = await captureReopenedQualifiedOriginalBundle(input)
  const knowledge = await mintFromInitial(captured.bundle, captured.originalPackage)
  return Object.freeze({ ...captured, knowledgePlan: knowledge.plan, knowledgeValue: knowledge.value })
}

export interface ReopenedRootKnowledgeInputs5 { readonly kind: 'main-reopened-root-knowledge-inputs' }
export interface PreparedRootKnowledgeInputs5 { readonly kind: 'main-prepared-root-knowledge-inputs' }
type KnowledgeOriginals = Awaited<ReturnType<typeof readRootKnowledgeConservationContentAndOriginals5>>
type OriginalRowStores = Parameters<Parameters<typeof withReferenceOriginalRows5>[0]>
const reopenedInputs = new WeakMap<ReopenedRootKnowledgeInputs5, { plan: RootKnowledgeConservationPlan3; data: KnowledgeOriginals }>()
const preparedInputs = new WeakMap<PreparedRootKnowledgeInputs5, { plan: RootKnowledgeConservationPlan3; data: KnowledgeOriginals }>()

function scopeQualifiedContent5(pair: KnowledgeOriginals['pair'], [store, storePhysical]: OriginalRowStores) {
  if (pair.source.assetArchive.version !== 6) return pair
  const source = Object.freeze({ ...pair.source, source: Object.freeze({ ...pair.source.source,
    sourceContent: scopeIncomingReferenceTables5(pair.source.source.sourceContent, store),
    physical: storePhysical(pair.source.source.physical)
  }) })
  const currentArchive = pair.current.assetArchive.version
  const scopeCurrent = currentArchive === 2 || currentArchive === 7 || currentArchive === 9 || isWorkingAssetArchive5(pair.current.assetArchive)
  const current = scopeCurrent ? Object.freeze({ ...pair.current,
    source: Object.freeze({ ...pair.current.source,
      sourceContent: scopeCurrentReferenceBlocks5(pair.current.source.sourceContent, store),
      physical: storePhysical(pair.current.source.physical, 'current')
    })
  }) : pair.current
  return Object.freeze({ originalPackage: pair.originalPackage, source, current })
}

/** Initial content comes from the copied and independently verified mount.
 * It is only available to the exact plan within the preparation call. */
export async function withPreparedRootKnowledgeInputs5<T>(
  input: Parameters<typeof captureQualifiedOriginalBundle>[0],
  run: (root: Awaited<ReturnType<typeof captureRootKnowledgeConservationPlanFromCertifiedSources3>>, scope: PreparedRootKnowledgeInputs5) => Promise<T>) {
  return withReferenceOriginalRows5(async (...stores) => {
    const { pair, working, ...captured } = await captureQualifiedOriginalBundleWithInitialContent5(input, stores[2],
      [stores[3]('source'), stores[3]('current')])
    const knowledge = await mintFromInitial(captured.bundle, captured.originalPackage)
    const root = Object.freeze({ ...captured, knowledgePlan: knowledge.plan, knowledgeValue: knowledge.value })
    const originals = scopeQualifiedContent5(pair, stores)
    const value = Object.freeze({ knowledge: knowledge.value, source: originals.source, current: originals.current })
    return { root, data: Object.freeze({ value, pair: originals, original: root.bundle, working }) }
  }, async ({ root, data }) => {
    const scope: PreparedRootKnowledgeInputs5 = Object.freeze({ kind: 'main-prepared-root-knowledge-inputs' })
    preparedInputs.set(scope, { plan: root.knowledgePlan, data })
    try {
      const result = await run(root, scope)
      await readPreparedRootKnowledgeInputs5(root.knowledgePlan, scope)
      return result
    } finally { preparedInputs.delete(scope) }
  })
}

export async function readPreparedRootKnowledgeInputs5(plan: RootKnowledgeConservationPlan3, scope: PreparedRootKnowledgeInputs5) {
  const entry = preparedInputs.get(scope)
  if (!entry || entry.plan !== plan) return root3Invalid('不是本次准备的真实知识原件')
  await assertRootKnowledgePlanOriginalBytes3(plan)
  await assertCompleteOriginalVerificationBytes5(entry.data.pair.originalPackage)
  if (preparedInputs.get(scope) !== entry) return root3Invalid('知识准备范围已结束')
  return entry.data
}

/** Keep the actual qualified content alive only for the fixed cold chain. */
export async function withReopenedRootKnowledgeConservationInputs5<T>(input: Parameters<typeof captureReopenedQualifiedOriginalBundle>[0],
  run: (plan: RootKnowledgeConservationPlan3, scope: ReopenedRootKnowledgeInputs5) => Promise<T>): Promise<T> {
  return withReferenceOriginalRows5(async (...stores) => {
    const { bundle, originalPackage, pair, working } = await captureReopenedQualifiedOriginalContent5(input, stores[2],
      [stores[3]('source'), stores[3]('current')])
    const { plan, value: knowledge } = await mintFromInitial(bundle, originalPackage)
    const originals = scopeQualifiedContent5(pair, stores)
    const value = Object.freeze({ knowledge, source: originals.source, current: originals.current })
    return { plan, data: Object.freeze({ value, pair: originals, original: bundle, working }) }
  }, async ({ plan, data }) => {
    const scope: ReopenedRootKnowledgeInputs5 = Object.freeze({ kind: 'main-reopened-root-knowledge-inputs' })
    reopenedInputs.set(scope, { plan, data })
    try {
      const result = await run(plan, scope)
      await assertCompleteOriginalVerificationBytes5(data.pair.originalPackage)
      return result
    } finally { reopenedInputs.delete(scope) }
  })
}

export async function readReopenedRootKnowledgeConservationInputs5(plan: RootKnowledgeConservationPlan3, scope: ReopenedRootKnowledgeInputs5) {
  const entry = reopenedInputs.get(scope)
  if (!entry || entry.plan !== plan) return root3Invalid('不是本次冷重开的真实知识原件')
  await assertRootKnowledgePlanOriginalBytes3(plan)
  if (reopenedInputs.get(scope) !== entry) return root3Invalid('冷重开知识原件已结束')
  return entry.data
}

function owned(value: Root3KnowledgeConstraints) {
  return freezeCapsuleValue({ kind: 'main-complete-qualified-knowledge-plan-data' as const, version: 1 as const,
    constraints: value, conservationHash: value.conservationHash,
    originalInputClosureAuthenticated: true as const, semanticValidationComplete: false as const,
    acceptedCoverage: false as const, effective: false as const, permit: false as const })
}
/** Rebuild every typed fact from every actual SQL original on every read.
 * Only the pre-existing private SQL readers survive; no K/result cache does. */
export async function readRootKnowledgeConservationPlan3(handle: RootKnowledgeConservationPlan3) {
  const entry = plans.get(handle)
  if (!entry) return root3Invalid('不是实际Main完整知识规划句柄')
  const actual = await readCompleteOriginalPackage(entry.original)
  const value = deriveRoot3KnowledgeConstraints(actual.original, await readRoot3OriginalReferenceResolutions(actual))
  await assertCompleteOriginalPackageBytes(entry.original)
  if (value.conservationHash !== entry.expectedHash) return root3Invalid('完整原域知识或规划变化')
  return owned(value)
}

/** Main-private complete business inputs for the content planner. The fixed
 * original reader, not caller packets or a K-to-content conversion, supplies
 * both roles. Rebuild the same complete qualified constraints in this read. */
export async function readRootKnowledgeConservationContent3(handle: RootKnowledgeConservationPlan3) {
  const entry = plans.get(handle)
  if (!entry) return root3Invalid('不是实际Main完整知识规划句柄')
  const { readCompleteOriginalContentPair3 } = await import('./restore-knowledge-qualified-originals')
  const actual = await readCompleteOriginalContentPair3(entry.original)
  const constraints = deriveRoot3KnowledgeConstraints(actual.originalPackage.original,
    await readRoot3OriginalReferenceResolutions(actual.originalPackage))
  await assertCompleteOriginalPackageBytes(entry.original)
  if (constraints.conservationHash !== entry.expectedHash) return root3Invalid('完整内容读取期间原域知识或规划变化')
  return Object.freeze({ knowledge: owned(constraints), source: actual.source, current: actual.current })
}

/** Actual owner metadata/byte bracket for durable candidate plans. Neither
 * function returns knowledge or upgrades this owner into an install permit. */
export async function readRootKnowledgePlanLocation3(handle: RootKnowledgeConservationPlan3) {
  const entry = plans.get(handle)
  if (!entry) return root3Invalid('不是实际Main完整知识规划句柄')
  const { readCompleteOriginalPlanLocation } = await import('./restore-knowledge-qualified-originals')
  return readCompleteOriginalPlanLocation(entry.original)
}
export async function assertRootKnowledgePlanOriginalBytes3(handle: RootKnowledgeConservationPlan3) {
  const entry = plans.get(handle)
  if (!entry) return root3Invalid('不是实际Main完整知识规划句柄')
  await assertCompleteOriginalPackageBytes(entry.original)
}
/** Fixed Main ownership routing only. This returns the genuine lower owner,
 * never a path/packet-derived authority and never a cached SQL projection. */
export function readRootKnowledgeOriginalOwnerForCopy3(handle: RootKnowledgeConservationPlan3) {
  const entry = plans.get(handle)
  if (!entry) return root3Invalid('不是实际Main完整知识规划句柄')
  return entry.original
}

/** Fixed genuine-owner same-read originals. The complete SQL/K, original
 * package and content pair come from this invocation's one real lower read.
 * Runtime originals never enter the released content body/hash or a cache. */
export async function readRootKnowledgeConservationContentAndOriginals5(handle: RootKnowledgeConservationPlan3) {
  const entry = plans.get(handle)
  if (!entry) return root3Invalid('不是实际Main完整知识规划句柄')
  const { readCompleteOriginalContentAndWorkingPair5 } = await import('./restore-knowledge-qualified-originals')
  const { pair: actual, working } = await readCompleteOriginalContentAndWorkingPair5(entry.original)
  const constraints = deriveRoot3KnowledgeConstraints(actual.originalPackage.original,
    await readRoot3OriginalReferenceResolutions(actual.originalPackage))
  await assertCompleteOriginalPackageBytes(entry.original)
  if (constraints.conservationHash !== entry.expectedHash) return root3Invalid('完整内容读取期间原域知识或规划变化')
  const value = Object.freeze({ knowledge: owned(constraints), source: actual.source, current: actual.current })
  return Object.freeze({ value, pair: actual, original: entry.original, working })
}
