import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { hashBoundedCapsuleJson } from './restore-knowledge-capsule-json-hash'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { assertRootRestoreIdentityOriginalBytes3, readRootRestoreIdentityGraphInputs3, readRootRestoreIdentityInputsAndOriginals5,
  readRootRestoreIdentityPlanLocation3, readRootRestoreIdentityOriginalOwnerForCopy3, readReopenedRootRestoreIdentityInputs5,
  withReopenedRootRestoreIdentityInputs5, readPreparedRootRestoreIdentityInputs5,
  type PreparedRootIdentityInputs5, type ReopenedRootIdentityInputs5, type RootRestoreIdentityPlan3 } from './restore-knowledge-identity3-read'
import { withReopenedRootKnowledgeConservationInputs5 } from './restore-knowledge-root3-read'
import { assertCompleteOriginalVerificationBytes5 } from './restore-knowledge-qualified-originals'
import { deriveRootRestoreReferenceAllocation3, normalizeReference3Choices, validateReference3Kernel,
  type Reference3Allocation, type Reference3Choices, type Reference3Kernel } from './restore-knowledge-reference3-model'
import { canonical3WireHashInput, deriveRootRestoreCanonicalCandidateWithCells3, openRootRestoreCanonicalCandidateWithCells3,
  type Canonical3WireSource } from './restore-knowledge-canonical3-model'
import { navigation3TableHashInput, type Navigation3TableSource } from './restore-knowledge-navigation3-tables'
import { checkMerge3NativeStorage3 } from './restore-knowledge-merge3-native'
import { assertMerge3JsonBudget } from './restore-knowledge-merge3-storage'
import { deriveSelectedPendingLocalBody5, parsePendingLocalComponentLocator5,
  type PendingLocalComponentLocator5, type SelectedPendingLocalBody5 } from './restore-knowledge-pending-local-selection5'
import { assertPendingLocalCandidateCellOnly5 } from './restore-knowledge-pending-local-cell5'
import { withReferenceOriginalRows5, type ReferenceOriginalRows5 } from './restore-knowledge-reference-original-rows5'

export interface RootRestoreReferencePlan3 { readonly kind: 'main-root-restore-reference-plan' }
type BaseLocation = Awaited<ReturnType<typeof readRootRestoreIdentityPlanLocation3>>
type Location = BaseLocation['location']
type Data = Awaited<ReturnType<typeof readRootRestoreIdentityGraphInputs3>>
type Candidate = ReturnType<typeof checkedCandidate>
type ScopedCandidate = Omit<Candidate, 'tables' | 'activeGroupWires'> & {
  readonly tables: readonly Navigation3TableSource[]
  readonly activeGroupWires: Canonical3WireSource
}
interface ColdReferenceInputs<C extends ScopedCandidate> {
  readonly data: Data
  readonly allocation: Reference3Allocation
  readonly candidate: C
  readonly value: ReferenceValue<C>
  readonly kernel: Reference3Kernel
  readonly choices: Reference3Choices
  readonly referencePlanId: string
  readonly referenceManifestHash: string
  assertPlanManifests(): Promise<void>
}
interface ReferenceValue<C extends ScopedCandidate> { readonly allocation: Reference3Allocation; readonly candidate: C }
export type ColdRootRestoreReferenceInputs5 = ColdReferenceInputs<Candidate>
export type ScopedColdRootRestoreReferenceInputs5 = ColdReferenceInputs<ScopedCandidate>
export type Reference3Value = ReferenceValue<Candidate>
export type ScopedReference3Value = ReferenceValue<ScopedCandidate>
type Manifest = ReturnType<typeof manifestBody>
type Pending = { choice: PendingLocalComponentLocator5; baseCandidateHash: string }
type Captured = Pick<Awaited<ReturnType<typeof readRootRestoreIdentityInputsAndOriginals5>>, 'pair' | 'working'>
interface Saved {
  readonly identity: RootRestoreIdentityPlan3
  readonly planId: string
  readonly basePlanId: string
  readonly baseManifestHash: string
  readonly location: Location
  readonly directory: string
  readonly manifestHash: string
}
const owners = new WeakMap<RootRestoreReferencePlan3, Saved>()
const maxManifestBytes = 16 * 1024
const invalid = (message: string): never => { throw new Error('完整恢复引用规划无效：' + message + '；未授安装、历史执行或coverage接受权。') }
const same = (a: unknown, b: unknown): boolean => capsuleJson(a) === capsuleJson(b)
const manifestHash = (value: Manifest) => capsuleBytesHash('knowbook.restore.reference3.manifest.v' + value.version + '\0' + capsuleJson(value))
const directory = (location: Location, planId: string) => join(location.profileRoot, 'backups', 'database-restore',
  location.operationId, 'restore-reference-plans-v3', planId)
function checkedCandidate(data: Data, allocation: Reference3Allocation, choices: Reference3Choices) {
  return checkedCandidateWithCells(data, allocation, choices).candidate
}
function checkedCandidateWithCells(data: Data, allocation: Reference3Allocation, choices: Reference3Choices, pending?: SelectedPendingLocalBody5) {
  const checked = checkCanonicalResult(deriveRootRestoreCanonicalCandidateWithCells3(data, allocation,
    checkMerge3NativeStorage3, { anonymousValues: choices.anonymousValues }, pending))
  assertMerge3JsonBudget(checked.candidate)
  return checked
}

type KeepResource = (close: () => void) => void
function scopedCandidateBuilder(retain: KeepResource) {
  return (data: Data, allocation: Reference3Allocation, choices: Reference3Choices, pending?: SelectedPendingLocalBody5) => {
    const opened = openRootRestoreCanonicalCandidateWithCells3(data, allocation, checkMerge3NativeStorage3,
      { anonymousValues: choices.anonymousValues }, pending)
    try {
      const checked = checkCanonicalResult(opened.value)
      retain(opened.close)
      return checked
    } catch (error) {
      opened.close()
      throw error
    }
  }
}

type CanonicalResult = ReturnType<typeof openRootRestoreCanonicalCandidateWithCells3<ReturnType<typeof checkMerge3NativeStorage3>>>['value']
function checkCanonicalResult<C extends CanonicalResult['candidate']>(
  { candidate: model, tableInspection: nativeStorageChecks, ...cells }: Omit<CanonicalResult, 'candidate'> & { candidate: C }) {
  const conflicts = [...model.conflicts, ...nativeStorageChecks.conflicts]
  const body = { ...model, nativeStorageChecks, conflicts, candidateConflictFree: conflicts.length === 0,
    catalogNameNativeCheckPending: false as const, finalCurrentRetainedCutComplete: false as const,
    referenceRewriteComplete: false as const, semanticValidationComplete: false as const,
    acceptedCoverage: false as const, effective: false as const, permit: false as const }
  assertMerge3JsonBudget({ ...body, tables: [], activeGroupWires: [] })
  const checkedCanonicalCandidateHash = hashBoundedCapsuleJson(candidateHashInput(body), CAPSULE2_RAW_MAX_JSON_BYTES,
    'knowbook.restore.canonical3.checked-candidate.v1\0')
    ?? invalid('完整候选超过原JSON预算，不能截断')
  const value = { ...body, checkedCanonicalCandidateHash }
  return Object.freeze({ ...cells, candidate: freezeCapsuleValue(value) })
}

function candidateHashInput<C extends Pick<CanonicalResult['candidate'], 'tables' | 'activeGroupWires'>>(candidate: C) {
  return { ...candidate, tables: navigation3TableHashInput(candidate.tables), activeGroupWires: canonical3WireHashInput(candidate.activeGroupWires) }
}

function assertReferenceBudget(value: ScopedReference3Value) {
  const { allocation, candidate } = value
  assertMerge3JsonBudget({ allocation })
  if (!hashBoundedCapsuleJson({ allocation, candidate: candidateHashInput(candidate) }, CAPSULE2_RAW_MAX_JSON_BYTES))
    return invalid('完整候选超过原JSON预算，不能截断')
}

type CandidateBuildResult<C extends ScopedCandidate> = Omit<ReturnType<typeof checkedCandidateWithCells>, 'candidate'> & { readonly candidate: C }
type CandidateBuilder<C extends ScopedCandidate> = (data: Data, allocation: Reference3Allocation,
  choices: Reference3Choices, pending?: SelectedPendingLocalBody5) => CandidateBuildResult<C>

function checkedPendingCandidateWithCells<C extends ScopedCandidate>(
  captured: Captured, data: Data, allocation: Reference3Allocation, choices: Reference3Choices,
  original: C, choice: PendingLocalComponentLocator5, buildCandidate: CandidateBuilder<C>) {
  if (original.pendingLocalBody || !original.candidateConflictFree || !original.finalForestValidated) return invalid('原候选未通过整表校验')
  const pending = deriveSelectedPendingLocalBody5(captured, choice)
  const cells = buildCandidate(data, allocation, choices, pending), { candidate } = cells
  if (!candidate.pendingLocalBody || !candidate.candidateConflictFree || !candidate.finalForestValidated) return invalid('pending候选未通过整表校验')
  assertPendingLocalCandidateCellOnly5(original.tables, candidate.tables, candidate.pendingLocalBody)
  return cells
}
function manifestBody(base: BaseLocation, planId: string, data: Data, kernel: Reference3Kernel,
  choices: Reference3Choices, value: Reference3Allocation, candidate: ScopedCandidate, pending?: Pending) {
  const fields = { kind: 'prepared-root-restore-reference-plan' as const, policyVersion: kernel.policyVersion, purposeVersion: 1 as const,
    planId, baseIdentityPlanId: base.planId, baseIdentityManifestHash: base.manifestHash,
    baseIdentityAllocationHash: data.value.allocationHash, originalDescriptorHash: base.location.descriptorHash,
    conservationHash: data.inputs.knowledge.conservationHash, sourceMaterialHash: data.inputs.source.materialHash,
    currentMaterialHash: data.inputs.current.materialHash, sourcePayload: value.sourcePayload, currentPayload: value.currentPayload,
    sourceWitnessHash: capsuleBytesHash(capsuleJson(value.sourceWitness)), currentWitnessHash: capsuleBytesHash(capsuleJson(value.currentWitness)),
    kernel, choices, derivedReferenceAllocationHash: value.derivedReferenceAllocationHash,
    canonicalCandidateHash: candidate.canonicalCandidateHash, checkedCanonicalCandidateHash: candidate.checkedCanonicalCandidateHash,
    finalCurrentRetainedCutComplete: false as const, referenceRewriteComplete: false as const, semanticValidationComplete: false as const,
    acceptedCoverage: false as const, effective: false as const, permit: false as const }
  if (pending) {
    if (!candidate.pendingLocalBody) return invalid('pending 清单缺实际候选证明')
    return { ...fields, version: 2 as const, pendingSelection: pending.choice, pendingBaseCandidateHash: pending.baseCandidateHash,
      pendingCellProofHash: candidate.pendingLocalBody.proofHash }
  }
  return { ...fields, version: 1 as const }
}
async function readManifest(saved: Saved): Promise<Manifest> {
  const bytes = await readCapsule2AssetManifest(join(saved.directory, 'manifest.json'), saved.location.profileRoot, maxManifestBytes)
  let value: unknown
  try { value = JSON.parse(bytes) } catch { return invalid('引用kernel清单不是完整JSON') }
  const version = value !== null && typeof value === 'object' && 'version' in value ? value.version : undefined
  if (version !== 1 && version !== 2) return invalid('未知引用清单版本')
  const row = capsuleRecord(value, ['kind','version','policyVersion','purposeVersion','planId','baseIdentityPlanId',
    'baseIdentityManifestHash','baseIdentityAllocationHash','originalDescriptorHash','conservationHash','sourceMaterialHash',
    'currentMaterialHash','sourcePayload','currentPayload','sourceWitnessHash','currentWitnessHash','kernel','choices',
    'derivedReferenceAllocationHash','canonicalCandidateHash','checkedCanonicalCandidateHash','finalCurrentRetainedCutComplete',
    'referenceRewriteComplete','semanticValidationComplete','acceptedCoverage','effective','permit',
    ...(version === 2 ? ['pendingSelection','pendingBaseCandidateHash','pendingCellProofHash'] : [])])
  const kernel = validateReference3Kernel(row.kernel as Reference3Kernel)
  if (row.kind !== 'prepared-root-restore-reference-plan' || row.version !== version || row.policyVersion !== kernel.policyVersion || row.purposeVersion !== 1
    || durableSqlDagUuid(row.planId) !== saved.planId || durableSqlDagUuid(row.baseIdentityPlanId) !== saved.basePlanId
    || row.baseIdentityManifestHash !== saved.baseManifestHash || row.originalDescriptorHash !== saved.location.descriptorHash
    || row.finalCurrentRetainedCutComplete !== false || row.referenceRewriteComplete !== false || row.semanticValidationComplete !== false
    || row.acceptedCoverage !== false || row.effective !== false || row.permit !== false) return invalid('不是本次base owner绑定的非安装引用清单')
  for (const name of ['baseIdentityManifestHash','baseIdentityAllocationHash','originalDescriptorHash','conservationHash','sourceMaterialHash',
    'currentMaterialHash','sourceWitnessHash','currentWitnessHash','derivedReferenceAllocationHash','canonicalCandidateHash',
    'checkedCanonicalCandidateHash']) durableSqlDagHash(row[name])
  if (typeof row.sourcePayload !== 'string' || typeof row.currentPayload !== 'string') return invalid('清单角色来源不是原完整payload key')
  normalizeReference3Choices(row.choices as Reference3Choices)
  if (version === 2) {
    parsePendingLocalComponentLocator5(row.pendingSelection)
    durableSqlDagHash(row.pendingBaseCandidateHash)
    durableSqlDagHash(row.pendingCellProofHash)
  }
  const body = row as unknown as Manifest
  if (bytes !== capsuleJson(body) + '\n' || manifestHash(body) !== saved.manifestHash) return invalid('持久引用清单字节或hash变化')
  return body
}
async function readBaseLocation(saved: Saved): Promise<BaseLocation> {
  const base = await readRootRestoreIdentityPlanLocation3(saved.identity)
  if (base.planId !== saved.basePlanId || base.manifestHash !== saved.baseManifestHash || !same(base.location, saved.location))
    return invalid('genuine base identity的原locator或manifest已变化')
  return base
}
async function reconstruct(saved: Saved) {
  const before = await readManifest(saved), base = await readBaseLocation(saved)
  if (before.version === 2) return (await reconstructWithOriginals(saved, before, base, checkedCandidateWithCells)).actual
  // Exactly one fresh complete SQL/K read per fixed public call. Metadata and
  // tail-byte checks do not reread SQL or turn a DTO into an authority.
  const data = await readRootRestoreIdentityGraphInputs3(saved.identity)
  const allocation = deriveRootRestoreReferenceAllocation3(data, before.kernel, before.choices)
  if (allocation.purposes.some(purpose => purpose.targetId === saved.planId)) return invalid('引用plan locator与新分配身份碰撞')
  const candidate = checkedCandidate(data, allocation, before.choices)
  const actual = manifestBody(base, saved.planId, data, before.kernel, before.choices, allocation, candidate)
  if (!same(actual, before)) return invalid('完整原件、base allocation或引用派生不等于持久清单')
  const value: Reference3Value = Object.freeze({ allocation, candidate })
  assertMerge3JsonBudget(value)
  await readManifest(saved)
  await assertRootRestoreIdentityOriginalBytes3(saved.identity)
  await readManifest(saved)
  return Object.freeze({ data, allocation, candidate, value, kernel: before.kernel, choices: before.choices,
    referencePlanId: saved.planId, referenceManifestHash: saved.manifestHash })
}
function mint(saved: Saved): RootRestoreReferencePlan3 {
  const plan: RootRestoreReferencePlan3 = Object.freeze({ kind: 'main-root-restore-reference-plan' })
  owners.set(plan, saved); return plan
}
/** Main owns entropy, time, filesystem locations and full originals. The only
 * external inputs are a genuine old identity owner and a closed finite choice.
 * The durable base manifest and old public DTO/hash are never rewritten. */
export async function prepareRootRestoreReferencePlan3(identity: RootRestoreIdentityPlan3, inputChoices?: Reference3Choices,
  scope?: PreparedRootIdentityInputs5) {
  return (await prepareReference3(identity, inputChoices, checkedCandidateWithCells, scope)).prepared
}

async function prepareReference3<C extends ScopedCandidate>(identity: RootRestoreIdentityPlan3, inputChoices: Reference3Choices | undefined,
  buildCandidate: CandidateBuilder<C>,
  scope?: PreparedRootIdentityInputs5) {
  const choices = normalizeReference3Choices(inputChoices), base = await readRootRestoreIdentityPlanLocation3(identity)
  const captured = scope ? await readPreparedRootRestoreIdentityInputs5(identity, scope) : undefined
  const data = captured?.actual ?? await readRootRestoreIdentityGraphInputs3(identity)
  const kernel: Reference3Kernel = { kind: 'root-restore-reference-kernel', version: 1, policyVersion: 2, purposeVersion: 1,
    seed: randomBytes(32).toString('hex'), preparedAt: new Date().toISOString() }
  const planId = randomUUID(), allocation = deriveRootRestoreReferenceAllocation3(data, kernel, choices)
  if (allocation.purposes.some(purpose => purpose.targetId === planId)) return invalid('引用plan locator与新分配身份碰撞')
  const { candidate, ordinaryEdits, physicalLocations } = buildCandidate(data, allocation, choices)
  const value = Object.freeze({ allocation, candidate })
  const prepared = await persistReference3(identity, base, planId, data, kernel, choices, value)
  if (scope) await readPreparedRootRestoreIdentityInputs5(identity, scope)
  const actual = Object.freeze({ data, allocation, candidate, value, kernel, choices, referencePlanId: planId,
    referenceManifestHash: prepared.manifestHash })
  return { prepared, captured: captured && Object.freeze({ ...captured, actual, cells: Object.freeze({ ordinaryEdits, physicalLocations }) }) }
}
type ReferenceAddress = Omit<Awaited<ReturnType<typeof prepareRootRestoreReferencePlan3>>, 'value'>

/** Share only the newly persisted ordinary plan and the original SQL read
 * owned by this invocation's prepared identity scope. */
export async function withPreparedRootRestoreReferenceInputs5<Preview, T>(identity: RootRestoreIdentityPlan3, inputChoices: Reference3Choices | undefined,
  identityScope: PreparedRootIdentityInputs5,
  review: (address: ReferenceAddress, value: ScopedReference3Value, scope: RootRestoreStageInputs5) => Promise<Preview>,
  run: (address: ReferenceAddress, scope: RootRestoreStageInputs5, preview: Preview) => Promise<T>): Promise<T> {
  return withReferenceResources(async resources => {
    let staged: Promise<T>, reference: RootRestoreReferencePlan3
    {
      const { prepared, captured } = await prepareReference3(identity, inputChoices, scopedCandidateBuilder(close => resources.push(close)), identityScope)
      if (!captured) return invalid('联合阶段需要本次准备的真实身份规划')
      const { plan, planId, manifestHash, directory } = prepared
      const address = Object.freeze({ plan, planId, manifestHash, directory })
      let previewValue: ScopedReference3Value | undefined = prepared.value
      reference = plan
      staged = runRootRestoreStageInputs5(reference, undefined, async scope => {
        if (!previewValue) return invalid('本次预览引用已释放')
        const reviewed = review(address, previewValue, scope)
        previewValue = undefined
        return run(address, scope, await reviewed)
      }, captured, resources)
    }
    const result = await staged
    await readPreparedRootRestoreIdentityInputs5(identity, identityScope)
    await assertRootRestoreReferenceOriginalBytes3(reference)
    return result
  })
}

async function persistReference3<C extends ScopedCandidate>(identity: RootRestoreIdentityPlan3, base: BaseLocation, planId: string, data: Data,
  kernel: Reference3Kernel, choices: Reference3Choices, value: ReferenceValue<C>, pending?: Pending) {
  assertReferenceBudget(value)
  const body = manifestBody(base, planId, data, kernel, choices, value.allocation, value.candidate, pending), location = base.location
  const target = directory(location, planId), collection = join(location.profileRoot, 'backups', 'database-restore',
    location.operationId, 'restore-reference-plans-v3')
  const bytes = capsuleJson(body) + '\n'
  if (Buffer.byteLength(bytes) > maxManifestBytes) return invalid('引用kernel超出固定小清单预算')
  await restoreDirectory(collection, location.profileRoot)
  await restoreDirectory(target, location.profileRoot, true)
  await writeCapsule2AssetCopy(join(target, 'manifest.json'), Buffer.from(bytes), location.profileRoot)
  await syncRestoreDirectory(target); await syncRestoreDirectory(collection)
  await syncOriginCatalogAncestors(collection, location.profileRoot)
  const saved: Saved = { identity, location, directory: target, planId, manifestHash: manifestHash(body),
    basePlanId: base.planId, baseManifestHash: base.manifestHash }
  await readManifest(saved)
  await assertRootRestoreIdentityOriginalBytes3(identity)
  await readManifest(saved)
  return Object.freeze({ plan: mint(saved), value, planId, manifestHash: saved.manifestHash, directory: target })
}
export async function readRootRestoreReferencePlan3(plan: RootRestoreReferencePlan3) {
  const saved = owners.get(plan)
  if (!saved) return invalid('不是实际Main持久引用规划句柄')
  return (await reconstruct(saved)).value
}
/** Fixed Main downstream joint read. Caller data/maps cannot replace either
 * the genuine complete base inputs or the freshly rebuilt new allocation. */
export async function readRootRestoreReferenceGraphInputs3(plan: RootRestoreReferencePlan3) {
  const saved = owners.get(plan)
  if (!saved) return invalid('不是实际Main持久引用规划句柄')
  return reconstruct(saved)
}
export async function assertRootRestoreReferenceOriginalBytes3(plan: RootRestoreReferencePlan3) {
  const saved = owners.get(plan)
  if (!saved) return invalid('不是实际Main持久引用规划句柄')
  await readManifest(saved)
  await assertRootRestoreIdentityOriginalBytes3(saved.identity)
  await readManifest(saved)
}
/** Fixed bytes-only downstream seam. No complete SQL/K read occurs here.
 * The future stage factory separately performs exactly one fresh joint read;
 * this routes only the genuine original owner and pinned manifest metadata. */
export async function readRootRestoreReferenceCopySource3(plan: RootRestoreReferencePlan3) {
  const saved = owners.get(plan)
  if (!saved) return invalid('不是实际Main持久引用规划句柄')
  const before = await readManifest(saved)
  await readBaseLocation(saved)
  const original = readRootRestoreIdentityOriginalOwnerForCopy3(saved.identity)
  await readManifest(saved)
  return Object.freeze({ original, referencePlanId: saved.planId, referenceManifestHash: saved.manifestHash,
    baseIdentityPlanId: before.baseIdentityPlanId, baseIdentityManifestHash: before.baseIdentityManifestHash,
    baseIdentityAllocationHash: before.baseIdentityAllocationHash,
    derivedReferenceAllocationHash: before.derivedReferenceAllocationHash,
    checkedCanonicalCandidateHash: before.checkedCanonicalCandidateHash,
    sourceMaterialHash: before.sourceMaterialHash, currentMaterialHash: before.currentMaterialHash,
    conservationHash: before.conservationHash, originalDescriptorHash: before.originalDescriptorHash,
    ...(before.version === 2 ? { pendingCellProofHash: before.pendingCellProofHash } : {}),
    location: Object.freeze({ ...saved.location }) })
}
/** Reopening dispatches only the known policy/purpose version. It never mints
 * a new seed, migrates a base manifest or silently chooses a newer policy. */
export async function reopenRootRestoreReferencePlan3(identity: RootRestoreIdentityPlan3,
  input: { readonly planId: string; readonly expectedManifestHash: string }) {
  const saved = await reopenSaved(identity, input)
  const actual = await reconstruct(saved)
  return reopenedReference(saved, actual.value)
}

async function reopenSaved(identity: RootRestoreIdentityPlan3,
  input: { readonly planId: string; readonly expectedManifestHash: string }): Promise<Saved> {
  const row = capsuleRecord(input, ['planId','expectedManifestHash'])
  const planId = durableSqlDagUuid(row.planId), expected = durableSqlDagHash(row.expectedManifestHash)
  const base = await readRootRestoreIdentityPlanLocation3(identity)
  return { identity, planId, manifestHash: expected, location: base.location, directory: directory(base.location, planId),
    basePlanId: base.planId, baseManifestHash: base.manifestHash }
}

function reopenedReference(saved: Saved, value: Reference3Value) {
  return Object.freeze({ plan: mint(saved), value, planId: saved.planId, manifestHash: saved.manifestHash, directory: saved.directory })
}

/** Read a single cold Reference3 against both pinned plans and the complete
 * original package. The caller separately authenticates the installed pin. */
async function withCheckedRootRestoreReferenceFromQualified5<T>(
  qualified: Parameters<typeof withReopenedRootKnowledgeConservationInputs5>[0],
  identity: Parameters<typeof withReopenedRootRestoreIdentityInputs5>[2],
  reference: Parameters<typeof reopenRootRestoreReferencePlan3>[1],
  read: (checked: ScopedColdRootRestoreReferenceInputs5) => Promise<T>) {
  return withReopenedRootKnowledgeConservationInputs5(qualified, (knowledge, knowledgeScope) =>
    withReopenedRootRestoreIdentityInputs5(knowledge, knowledgeScope, identity, async (plan, scope) => {
      const saved = await reopenSaved(plan, reference)
      return withReferenceResources(async resources => {
        const { actual } = await reconstructWithOriginals(saved, await readManifest(saved), await readBaseLocation(saved),
          scopedCandidateBuilder(close => resources.push(close)), scope)
        return read(Object.freeze({ ...actual, async assertPlanManifests() {
          await readManifest(saved)
          await readBaseLocation(saved)
        } }))
      })
    }))
}

/** Historical consumers borrow the rows and semantic graph from the same
 * checked invocation. Keep both readers open through the selected projection. */
export async function withRootRestoreReferenceOriginalRowsFromQualified5<Projection, Result>(
  qualified: Parameters<typeof withCheckedRootRestoreReferenceFromQualified5>[0],
  identity: Parameters<typeof withCheckedRootRestoreReferenceFromQualified5>[1],
  reference: Parameters<typeof withCheckedRootRestoreReferenceFromQualified5>[2],
  project: (checked: ScopedColdRootRestoreReferenceInputs5,
    rows: Readonly<{ source: ReferenceOriginalRows5; current: ReferenceOriginalRows5 }>) => Projection,
  read: (projection: Projection) => Promise<Result>) {
  return withCheckedRootRestoreReferenceFromQualified5(qualified, identity, reference, checked =>
    withReferenceOriginalRows5(async store => {
      const { source, current } = checked.data.inputs
      return project(checked, Object.freeze({ source: store('source', source.source.sourceContent),
        current: store('current', current.source.sourceContent) }))
    }, read))
}

/** Reopen an explicit pending selection from the actual qualified mount and
 * both durable plan locators. The caller receives the checked planning result. */
export async function reopenRootRestorePendingReferenceFromQualified5(
  qualified: Parameters<typeof withReopenedRootKnowledgeConservationInputs5>[0],
  identity: Parameters<typeof withReopenedRootRestoreIdentityInputs5>[2],
  reference: Parameters<typeof reopenRootRestoreReferencePlan3>[1]) {
  return reopenPendingReferenceInputs(qualified, identity, reference, async opened => opened)
}

/** Share this same cold SQL reconstruction only within the pending stage's
 * bounded call. The original byte tails still bracket every downstream read. */
export async function withReopenedRootRestorePendingReferenceFromQualified5<T>(
  qualified: Parameters<typeof withReopenedRootKnowledgeConservationInputs5>[0],
  identity: Parameters<typeof withReopenedRootRestoreIdentityInputs5>[2],
  reference: Parameters<typeof reopenRootRestoreReferencePlan3>[1],
  run: (opened: ReturnType<typeof reopenedReference>, scope: RootRestoreStageInputs5) => Promise<T>) {
  return reopenPendingReferenceInputs(qualified, identity, reference, (opened, captured, proofHash) =>
    runRootRestoreStageInputs5(opened.plan, proofHash, stageScope => run(opened, stageScope), captured))
}

async function reopenPendingReferenceInputs<T>(
  qualified: Parameters<typeof withReopenedRootKnowledgeConservationInputs5>[0],
  identity: Parameters<typeof withReopenedRootRestoreIdentityInputs5>[2],
  reference: Parameters<typeof reopenRootRestoreReferencePlan3>[1],
  run: (opened: ReturnType<typeof reopenedReference>, captured: ReferenceInputs, proofHash: string) => Promise<T>) {
  return withReopenedRootKnowledgeConservationInputs5(qualified, (knowledge, knowledgeScope) =>
    withReopenedRootRestoreIdentityInputs5(knowledge, knowledgeScope, identity, async (plan, scope) => {
      const saved = await reopenSaved(plan, reference)
      const before = await readManifest(saved), base = await readBaseLocation(saved)
      if (before.version !== 2) return invalid('联合冷重开要求实际pending引用清单')
      const captured = await reconstructWithOriginals(saved, before, base, checkedCandidateWithCells, scope)
      const opened = reopenedReference(saved, captured.actual.value)
      return run(opened, captured, before.pendingCellProofHash)
    }))
}

/** Fixed genuine reference read for original-coordinate consumers. The
 * original complete pair is propagated from the same Root3/identity SQL read,
 * not independently reread or retained across calls. Existing manifests,
 * allocation/candidate hashes, choices, kernels and all byte tails stay exact. */
export async function readRootRestoreReferenceInputsAndOriginals5(plan: RootRestoreReferencePlan3) {
  const saved = owners.get(plan)
  if (!saved) return invalid('不是实际Main持久引用规划句柄')
  const before = await readManifest(saved), base = await readBaseLocation(saved)
  return reconstructWithOriginals(saved, before, base, checkedCandidateWithCells)
}

export interface RootRestoreStageInputs5 { readonly kind: 'main-root-restore-stage-inputs' }
type ReferenceInputs = Awaited<ReturnType<typeof readRootRestoreReferenceInputsAndOriginals5>>
type ScopedReferenceInputs = Awaited<ReturnType<typeof reconstructWithOriginals<ScopedCandidate>>>
const stageInputs = new WeakMap<RootRestoreStageInputs5, {
  reference: RootRestoreReferencePlan3; pendingCellProofHash: string | undefined
  resources: Array<() => void>; read?: Promise<ScopedReferenceInputs>
}>()

function releaseReferenceResources(resources: Array<() => void>) {
  for (const close of resources.splice(0).reverse()) close()
}

async function withReferenceResources<T>(run: (resources: Array<() => void>) => Promise<T>): Promise<T> {
  const resources: Array<() => void> = []
  try { return await run(resources) }
  finally { releaseReferenceResources(resources) }
}

/** A combined SQL/asset call can share one actual Reference3 reconstruction.
 * No SQL observation is cached on the reference or kept after the combined call. */
export async function withRootRestoreStageInputs5<T>(reference: RootRestoreReferencePlan3, pendingCellProofHash: string | undefined,
  run: (scope: RootRestoreStageInputs5) => Promise<T>): Promise<T> {
  return runRootRestoreStageInputs5(reference, pendingCellProofHash, run)
}

async function runRootRestoreStageInputs5<T>(reference: RootRestoreReferencePlan3, pendingCellProofHash: string | undefined,
  run: (scope: RootRestoreStageInputs5) => Promise<T>,
  captured?: ScopedReferenceInputs, resources: Array<() => void> = []): Promise<T> {
  const scope: RootRestoreStageInputs5 = Object.freeze({ kind: 'main-root-restore-stage-inputs' })
  if (captured && captured.actual.candidate.pendingLocalBody?.proofHash !== pendingCellProofHash)
    return invalid('联合阶段与实际持久pending选择不符')
  stageInputs.set(scope, { reference, pendingCellProofHash, resources, read: captured && Promise.resolve(captured) })
  captured = undefined
  try { return await run(scope) }
  finally {
    stageInputs.delete(scope)
    releaseReferenceResources(resources)
  }
}

/** No later stage can borrow the SQL read after the verified alias boundary. */
export function finishRootRestoreStageInputReads5(reference: RootRestoreReferencePlan3, scope: RootRestoreStageInputs5) {
  const saved = getStageInputs(reference, scope)
  stageInputs.delete(scope)
  releaseReferenceResources(saved.resources)
}

export function retainRootRestoreStageResource5(reference: RootRestoreReferencePlan3, scope: RootRestoreStageInputs5, close: () => void) {
  getStageInputs(reference, scope).resources.push(close)
}

function getStageInputs(reference: RootRestoreReferencePlan3, scope: RootRestoreStageInputs5) {
  const saved = stageInputs.get(scope)
  return saved?.reference === reference ? saved : invalid('不是本次同一genuine reference的阶段认证')
}

export async function readRootRestoreStageInputs5(reference: RootRestoreReferencePlan3, scope: RootRestoreStageInputs5) {
  const saved = getStageInputs(reference, scope)
  const previous = saved.read
  saved.read ??= (async () => {
    const owner = owners.get(reference)
    if (!owner) return invalid('不是实际Main持久引用规划句柄')
    const before = await readManifest(owner), base = await readBaseLocation(owner)
    const result = await reconstructWithOriginals(owner, before, base,
      scopedCandidateBuilder(close => retainRootRestoreStageResource5(reference, scope, close)))
    if (result.actual.candidate.pendingLocalBody?.proofHash !== saved.pendingCellProofHash)
      return invalid('联合阶段与实际持久pending选择不符')
    return result
  })()
  const result = await saved.read
  // A sibling stage may have copied or written its own output in between.
  // Authenticate the actual source/reference bytes again before reusing SQL.
  if (previous) {
    await assertCompleteOriginalVerificationBytes5(result.pair.originalPackage)
    await assertRootRestoreReferenceOriginalBytes3(reference)
  }
  if (stageInputs.get(scope) !== saved) return invalid('阶段认证已结束')
  return result
}

async function reconstructWithOriginals<C extends ScopedCandidate>(saved: Saved, before: Manifest, base: BaseLocation,
  buildCandidate: CandidateBuilder<C>,
  scope?: ReopenedRootIdentityInputs5 | PreparedRootIdentityInputs5) {
  const captured = scope?.kind === 'main-prepared-root-identity-inputs'
    ? await readPreparedRootRestoreIdentityInputs5(saved.identity, scope)
    : scope ? await readReopenedRootRestoreIdentityInputs5(saved.identity, scope) : await readRootRestoreIdentityInputsAndOriginals5(saved.identity)
  const data = captured.actual
  const allocation = deriveRootRestoreReferenceAllocation3(data, before.kernel, before.choices)
  if (allocation.purposes.some(purpose => purpose.targetId === saved.planId)) return invalid('引用plan locator与新分配身份碰撞')
  const original = buildCandidate(data, allocation, before.choices)
  const pending = before.version === 2 ? { choice: before.pendingSelection, baseCandidateHash: before.pendingBaseCandidateHash } : undefined
  if (pending && original.candidate.checkedCanonicalCandidateHash !== pending.baseCandidateHash) return invalid('pending基准候选变化')
  const { candidate, ordinaryEdits, physicalLocations } = pending
    ? checkedPendingCandidateWithCells(captured, data, allocation, before.choices, original.candidate, pending.choice, buildCandidate) : original
  const actual = manifestBody(base, saved.planId, data, before.kernel, before.choices, allocation, candidate, pending)
  if (!same(actual, before)) return invalid('完整原件、base allocation或引用派生不等于持久清单')
  const value = Object.freeze({ allocation, candidate })
  assertReferenceBudget(value)
  await readManifest(saved)
  await assertRootRestoreIdentityOriginalBytes3(saved.identity)
  await readManifest(saved)
  const result = Object.freeze({ data, allocation, candidate, value, kernel: before.kernel, choices: before.choices,
    referencePlanId: saved.planId, referenceManifestHash: saved.manifestHash })
  return Object.freeze({ actual: result, pair: captured.pair, original: captured.original, working: captured.working,
    cells: Object.freeze({ ordinaryEdits, physicalLocations }) })
}

/** Checked preview bound to a genuine reference's originals and kernel. It
 * returns values only. The preview never mints a Reference3 or stage owner. */
export async function previewRootRestorePendingLocalBody5(plan: RootRestoreReferencePlan3, locator: unknown) {
  const choice = parsePendingLocalComponentLocator5(locator)
  const captured = await readRootRestoreReferenceInputsAndOriginals5(plan)
  const { data, allocation, choices, candidate: original } = captured.actual
  const { candidate } = checkedPendingCandidateWithCells(captured, data, allocation, choices, original, choice, checkedCandidateWithCells)
  await assertRootRestoreReferenceOriginalBytes3(plan)
  return freezeCapsuleValue({ referencePlanId: captured.actual.referencePlanId, referenceManifestHash: captured.actual.referenceManifestHash,
    originalCandidateHash: original.checkedCanonicalCandidateHash, candidate })
}

/** Persist an explicit choice against the base plan's genuine original and
 * unchanged kernel. The newly selected reference is still non-executable. */
export async function prepareRootRestoreReferenceWithPendingLocal5(plan: RootRestoreReferencePlan3, locator: unknown) {
  return (await preparePendingReference(plan, locator)).prepared
}

/** Share the exact same-call qualified inputs and selected physical cells with
 * one downstream stage. Both independently persisted reference owners stay pinned. */
export async function withPreparedRootRestorePendingReference5<T>(plan: RootRestoreReferencePlan3, locator: unknown,
  identityScope: PreparedRootIdentityInputs5,
  run: (prepared: Awaited<ReturnType<typeof prepareRootRestoreReferenceWithPendingLocal5>>, scope: RootRestoreStageInputs5) => Promise<T>): Promise<T> {
  const { prepared, captured, identity } = await preparePendingReference(plan, locator, identityScope)
  const proofHash = prepared.value.candidate.pendingLocalBody?.proofHash
  if (!proofHash) return invalid('联合阶段需要持久pending选择')
  const result = await runRootRestoreStageInputs5(prepared.plan, proofHash, stageScope => run(prepared, stageScope), captured)
  await assertRootRestoreReferenceOriginalBytes3(plan)
  await readPreparedRootRestoreIdentityInputs5(identity, identityScope)
  await assertRootRestoreReferenceOriginalBytes3(prepared.plan)
  return result
}

async function preparePendingReference(plan: RootRestoreReferencePlan3, locator: unknown, identityScope?: PreparedRootIdentityInputs5) {
  const choice = parsePendingLocalComponentLocator5(locator), saved = owners.get(plan)
  if (!saved) return invalid('不是实际Main持久引用规划句柄')
  const before = await readManifest(saved), base = await readBaseLocation(saved)
  const captured = await reconstructWithOriginals(saved, before, base, checkedCandidateWithCells, identityScope)
  const { data, allocation, kernel, choices, candidate: original } = captured.actual
  const { candidate, ordinaryEdits, physicalLocations } = checkedPendingCandidateWithCells(captured, data, allocation, choices, original, choice, checkedCandidateWithCells)
  const planId = randomUUID()
  if (allocation.purposes.some(purpose => purpose.targetId === planId)) return invalid('引用plan locator与新分配身份碰撞')
  await readBaseLocation(saved)
  await assertRootRestoreReferenceOriginalBytes3(plan)
  const value = Object.freeze({ allocation, candidate })
  const prepared = await persistReference3(saved.identity, base, planId, data, kernel, choices, value,
    { choice, baseCandidateHash: original.checkedCanonicalCandidateHash })
  const actual = Object.freeze({ data, allocation, candidate, value, kernel, choices, referencePlanId: prepared.planId,
    referenceManifestHash: prepared.manifestHash })
  return { prepared, identity: saved.identity, captured: Object.freeze({ ...captured, actual, cells: Object.freeze({ ordinaryEdits, physicalLocations }) }) }
}
