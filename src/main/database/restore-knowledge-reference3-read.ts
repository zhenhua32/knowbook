import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { assertRootRestoreIdentityOriginalBytes3, readRootRestoreIdentityGraphInputs3,
  readRootRestoreIdentityPlanLocation3, readRootRestoreIdentityOriginalOwnerForCopy3,
  type RootRestoreIdentityPlan3 } from './restore-knowledge-identity3-read'
import { deriveRootRestoreReferenceAllocation3, normalizeReference3Choices, validateReference3Kernel,
  type Reference3Allocation, type Reference3Choices, type Reference3Kernel } from './restore-knowledge-reference3-model'
import { deriveRootRestoreCanonicalCandidate3 } from './restore-knowledge-canonical3-model'
import { checkMerge3NativeStorage3 } from './restore-knowledge-merge3-native'
import { assertMerge3JsonBudget } from './restore-knowledge-merge3-storage'

export interface RootRestoreReferencePlan3 { readonly kind: 'main-root-restore-reference-plan' }
type BaseLocation = Awaited<ReturnType<typeof readRootRestoreIdentityPlanLocation3>>
type Location = BaseLocation['location']
type Data = Awaited<ReturnType<typeof readRootRestoreIdentityGraphInputs3>>
type Candidate = ReturnType<typeof checkedCandidate>
export interface Reference3Value { readonly allocation: Reference3Allocation; readonly candidate: Candidate }
type Manifest = ReturnType<typeof manifestBody>
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
const manifestHash = (value: Manifest) => capsuleBytesHash('knowbook.restore.reference3.manifest.v1\0' + capsuleJson(value))
const directory = (location: Location, planId: string) => join(location.profileRoot, 'backups', 'database-restore',
  location.operationId, 'restore-reference-plans-v3', planId)
function checkedCandidate(data: Data, allocation: Reference3Allocation, choices: Reference3Choices) {
  const model = deriveRootRestoreCanonicalCandidate3(data, allocation, { anonymousValues: choices.anonymousValues })
  const nativeStorageChecks = checkMerge3NativeStorage3(model.tables), conflicts = [...model.conflicts, ...nativeStorageChecks.conflicts]
  const body = { ...model, nativeStorageChecks, conflicts, candidateConflictFree: conflicts.length === 0,
    catalogNameNativeCheckPending: false as const, finalCurrentRetainedCutComplete: false as const,
    referenceRewriteComplete: false as const, semanticValidationComplete: false as const,
    acceptedCoverage: false as const, effective: false as const, permit: false as const }
  assertMerge3JsonBudget(body)
  const value = { ...body, checkedCanonicalCandidateHash: capsuleBytesHash('knowbook.restore.canonical3.checked-candidate.v1\0' + capsuleJson(body)) }
  assertMerge3JsonBudget(value)
  return freezeCapsuleValue(value)
}
function manifestBody(base: BaseLocation, planId: string, data: Data, kernel: Reference3Kernel,
  choices: Reference3Choices, value: Reference3Allocation, candidate: Candidate) {
  return { kind: 'prepared-root-restore-reference-plan' as const, version: 1 as const, policyVersion: 1 as const, purposeVersion: 1 as const,
    planId, baseIdentityPlanId: base.planId, baseIdentityManifestHash: base.manifestHash,
    baseIdentityAllocationHash: data.value.allocationHash, originalDescriptorHash: base.location.descriptorHash,
    conservationHash: data.inputs.knowledge.conservationHash, sourceMaterialHash: data.inputs.source.materialHash,
    currentMaterialHash: data.inputs.current.materialHash, sourcePayload: value.sourcePayload, currentPayload: value.currentPayload,
    sourceWitnessHash: capsuleBytesHash(capsuleJson(value.sourceWitness)), currentWitnessHash: capsuleBytesHash(capsuleJson(value.currentWitness)),
    kernel, choices, derivedReferenceAllocationHash: value.derivedReferenceAllocationHash,
    canonicalCandidateHash: candidate.canonicalCandidateHash, checkedCanonicalCandidateHash: candidate.checkedCanonicalCandidateHash,
    finalCurrentRetainedCutComplete: false as const, referenceRewriteComplete: false as const, semanticValidationComplete: false as const,
    acceptedCoverage: false as const, effective: false as const, permit: false as const }
}
async function readManifest(saved: Saved): Promise<Manifest> {
  const bytes = await readCapsule2AssetManifest(join(saved.directory, 'manifest.json'), saved.location.profileRoot, maxManifestBytes)
  let value: unknown
  try { value = JSON.parse(bytes) } catch { return invalid('引用kernel清单不是完整JSON') }
  const row = capsuleRecord(value, ['kind','version','policyVersion','purposeVersion','planId','baseIdentityPlanId',
    'baseIdentityManifestHash','baseIdentityAllocationHash','originalDescriptorHash','conservationHash','sourceMaterialHash',
    'currentMaterialHash','sourcePayload','currentPayload','sourceWitnessHash','currentWitnessHash','kernel','choices',
    'derivedReferenceAllocationHash','canonicalCandidateHash','checkedCanonicalCandidateHash','finalCurrentRetainedCutComplete',
    'referenceRewriteComplete','semanticValidationComplete','acceptedCoverage','effective','permit'])
  if (row.kind !== 'prepared-root-restore-reference-plan' || row.version !== 1 || row.policyVersion !== 1 || row.purposeVersion !== 1
    || durableSqlDagUuid(row.planId) !== saved.planId || durableSqlDagUuid(row.baseIdentityPlanId) !== saved.basePlanId
    || row.baseIdentityManifestHash !== saved.baseManifestHash || row.originalDescriptorHash !== saved.location.descriptorHash
    || row.finalCurrentRetainedCutComplete !== false || row.referenceRewriteComplete !== false || row.semanticValidationComplete !== false
    || row.acceptedCoverage !== false || row.effective !== false || row.permit !== false) return invalid('不是本次base owner绑定的非安装引用清单')
  for (const name of ['baseIdentityManifestHash','baseIdentityAllocationHash','originalDescriptorHash','conservationHash','sourceMaterialHash',
    'currentMaterialHash','sourceWitnessHash','currentWitnessHash','derivedReferenceAllocationHash','canonicalCandidateHash',
    'checkedCanonicalCandidateHash']) durableSqlDagHash(row[name])
  if (typeof row.sourcePayload !== 'string' || typeof row.currentPayload !== 'string') return invalid('清单角色来源不是原完整payload key')
  validateReference3Kernel(row.kernel as Reference3Kernel)
  normalizeReference3Choices(row.choices as Reference3Choices)
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
export async function prepareRootRestoreReferencePlan3(identity: RootRestoreIdentityPlan3, inputChoices?: Reference3Choices) {
  const choices = normalizeReference3Choices(inputChoices), base = await readRootRestoreIdentityPlanLocation3(identity)
  const data = await readRootRestoreIdentityGraphInputs3(identity)
  const kernel: Reference3Kernel = { kind: 'root-restore-reference-kernel', version: 1, policyVersion: 1, purposeVersion: 1,
    seed: randomBytes(32).toString('hex'), preparedAt: new Date().toISOString() }
  const planId = randomUUID(), allocation = deriveRootRestoreReferenceAllocation3(data, kernel, choices)
  if (allocation.purposes.some(purpose => purpose.targetId === planId)) return invalid('引用plan locator与新分配身份碰撞')
  const candidate = checkedCandidate(data, allocation, choices), value: Reference3Value = Object.freeze({ allocation, candidate })
  assertMerge3JsonBudget(value)
  const body = manifestBody(base, planId, data, kernel, choices, allocation, candidate), location = base.location
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
    location: Object.freeze({ ...saved.location }) })
}
/** Reopening dispatches only the known policy/purpose version. It never mints
 * a new seed, migrates a base manifest or silently chooses a newer policy. */
export async function reopenRootRestoreReferencePlan3(identity: RootRestoreIdentityPlan3,
  input: { readonly planId: string; readonly expectedManifestHash: string }) {
  const row = capsuleRecord(input, ['planId','expectedManifestHash'])
  const planId = durableSqlDagUuid(row.planId), expected = durableSqlDagHash(row.expectedManifestHash)
  const base = await readRootRestoreIdentityPlanLocation3(identity)
  const saved: Saved = { identity, planId, manifestHash: expected, location: base.location, directory: directory(base.location, planId),
    basePlanId: base.planId, baseManifestHash: base.manifestHash }
  const actual = await reconstruct(saved)
  return Object.freeze({ plan: mint(saved), value: actual.value, planId, manifestHash: expected, directory: saved.directory })
}
