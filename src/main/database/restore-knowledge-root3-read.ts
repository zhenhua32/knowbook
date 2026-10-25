import { assertCompleteOriginalPackageBytes, readCompleteOriginalPackage, captureMixedOriginalPackageWithInitialInputs,
  captureQualifiedOriginalBundleFromReferences, captureReopenedQualifiedOriginalBundle, type CompleteOriginalBundle } from './restore-knowledge-qualified-originals'
import type { CompleteOriginalPackage } from './restore-knowledge-original-input-types'
import { deriveRoot3KnowledgeConstraints, root3Invalid, type Root3KnowledgeConstraints } from './restore-knowledge-root3-model'
import { freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readRoot3OriginalReferenceResolutions } from './restore-knowledge-root3-contexts'

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
