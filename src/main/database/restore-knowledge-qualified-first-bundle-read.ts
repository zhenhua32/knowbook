import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { knowledgeHash } from './restore-knowledge-payload-model'
import { captureOwnedFirstImportedKnowledgeSource, readOwnedFirstImportedKnowledgeSource,
  type PreparedOriginBundle, type OwnedFirstImportedKnowledgeSource, type OwnedFirstImportedKnowledgeData } from './restore-knowledge-origin-bundle-read'
import { validateQualifiedKnowledgePayload2, qualifiedKnowledgePayload2Hash } from './restore-knowledge-qualified-payload-model'
import { unionQualifiedKnowledgeDiagnostics2, qualifiedKnowledgeUnion2Hash } from './restore-knowledge-qualified-union-model'
import { originBundleInvalid } from './restore-knowledge-origin-bundle-model'

/** Only prepared evidence identity. No accepted/live/source installer, Root3,
 * generic cross-owner domain interpretation or capsule2 reader is provided. */
export interface PreparedFirstImportedQualifiedKnowledge { readonly kind: 'prepared-first-imported-qualified-knowledge' }
type Source = OwnedFirstImportedKnowledgeData
function materialValue(source: Source) {
  const payloads = source.inputs.map(input => validateQualifiedKnowledgePayload2({
    kind: 'qualified-durable-sql-knowledge-payload-diagnostic', version: 2, capsule: input.capsule,
    originalBinding: input.binding, originalOrigin: input.origin, projection: input.projection, projectionHash: input.projectionHash,
    projectionStructure: 'descriptor-safe-local-rows-only', projectionSemanticsAuthenticated: false,
    certified: false, acceptedCoverage: false, effective: false, permit: false }))
  const union = unionQualifiedKnowledgeDiagnostics2(payloads), unionHash = qualifiedKnowledgeUnion2Hash(payloads)
  const inputBindings = source.inputs.map((input, index) => ({ role: input.role, locator: input.locator,
    capsule: input.capsule, originalCapsule: input.originalCapsule, originalBinding: input.binding, originalOrigin: input.origin,
    originalFiles: input.originalFiles, projectionHash: input.projectionHash, payloadHash: qualifiedKnowledgePayload2Hash(payloads[index]) }))
  const body = { kind: 'prepared-first-imported-qualified-knowledge-data' as const, version: 1 as const,
    scope: 'one-actual-first-bundle-whole-private-map' as const, descriptorHash: source.descriptorHash,
    inputSetCompleteness: 'exact-actual-saved-first-bundle-input-set' as const,
    root: source.root, originalRoot: source.originalRoot, originalNodeText: source.originalNodeText,
    sourceMaterialHash: source.sourceMaterialHash, interpretation: source.interpretation, inputBindings, union, unionHash,
    preparedEvidence: true as const, certified: false as const, acceptedCoverage: false as const,
    effective: false as const, permit: false as const, emptyKnowledgeProven: false as const,
    fullNonemptyAncestorSupport: false as const, fullRootInputSetProven: false as const }
  const materialHash = knowledgeHash('knowbook.knowledge.qualified-first-bundle-material.v1', body)
  return freezeCapsuleValue({ ...body, materialHash })
}
export type PreparedFirstImportedQualifiedKnowledgeData = ReturnType<typeof materialValue>
type Saved = { source: OwnedFirstImportedKnowledgeSource; sourceValue: Source; value: PreparedFirstImportedQualifiedKnowledgeData }
const preparedQualified = new WeakMap<PreparedFirstImportedQualifiedKnowledge, Saved>()
function sameSource(expected: Source, actual: Source): void {
  if (capsuleJson(expected) !== capsuleJson(actual)) return originBundleInvalid('qualified prepared material实际whole source前后变化')
}
/** The only factory takes ONE genuine bundle handle. It accepts no projection
 * list, namespace, domainId, desired-ref set, generic union or callback loader. */
export async function prepareFirstImportedQualifiedKnowledge(bundle: PreparedOriginBundle): Promise<PreparedFirstImportedQualifiedKnowledge> {
  const captured = await captureOwnedFirstImportedKnowledgeSource(bundle), source = captured.source, sourceValue = captured.value
  const value = materialValue(sourceValue)
  sameSource(sourceValue, await readOwnedFirstImportedKnowledgeSource(source))
  const handle: PreparedFirstImportedQualifiedKnowledge = Object.freeze({ kind: 'prepared-first-imported-qualified-knowledge' })
  preparedQualified.set(handle, { source, sourceValue, value })
  return handle
}
/** Main-internal complete material; ordinary diagnostics below expose counts.
 * Rebuild pure comparison from private immutable facts, then run the actual
 * mounted-before/whole-source/late-mounted final check. No new hot-read SQL. */
export async function readPreparedFirstImportedQualifiedKnowledge(handle: PreparedFirstImportedQualifiedKnowledge): Promise<PreparedFirstImportedQualifiedKnowledgeData> {
  const entry = preparedQualified.get(handle)
  if (!entry) return originBundleInvalid('不是Main真实whole source创建的qualified material私有句柄')
  const actual = materialValue(entry.sourceValue)
  if (capsuleJson(actual) !== capsuleJson(entry.value)) return originBundleInvalid('qualified material完整原像/hash变化')
  sameSource(entry.sourceValue, await readOwnedFirstImportedKnowledgeSource(entry.source))
  return entry.value
}
export async function diagnosePreparedFirstImportedQualifiedKnowledge(handle: PreparedFirstImportedQualifiedKnowledge) {
  const value = await readPreparedFirstImportedQualifiedKnowledge(handle)
  return freezeCapsuleValue({ kind: 'prepared-first-imported-qualified-knowledge-summary' as const, version: 1 as const,
    root: value.root, descriptorHash: value.descriptorHash, materialHash: value.materialHash, unionHash: value.unionHash,
    scope: value.scope, inputSetCompleteness: value.inputSetCompleteness, actualInputCount: value.inputBindings.length,
    groups: value.union.groups.length, permanentDenials: value.union.permanentDenials.length,
    observations: value.union.observations.length, exposures: value.union.exposures.length,
    preparedEvidence: true as const, certified: false as const, acceptedCoverage: false as const,
    effective: false as const, permit: false as const, fullRootInputSetProven: false as const })
}
