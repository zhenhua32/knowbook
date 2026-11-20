import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { capsuleBytesHash, capsuleJson, capsuleRecord } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { readRootKnowledgeConservationContent3, readRootKnowledgeConservationContentAndOriginals5, readRootKnowledgePlanLocation3, assertRootKnowledgePlanOriginalBytes3,
  readRootKnowledgeOriginalOwnerForCopy3, readReopenedRootKnowledgeConservationInputs5, readPreparedRootKnowledgeInputs5,
  type ReopenedRootKnowledgeInputs5, type PreparedRootKnowledgeInputs5,
  type RootKnowledgeConservationPlan3 } from './restore-knowledge-root3-read'
import { deriveRootRestoreIdentityPlan3, identity3Invalid, type Identity3Kernel, type Identity3Inputs } from './restore-knowledge-identity3-model'
import { deriveExactV3RepeatProof, projectV3RepeatReference5, type ExactV3RepeatProof } from './restore-knowledge-v3-repeat-proof'
import type { RestoreKnowledgePriorInstall } from './restore-knowledge-install-proof'

export interface RootRestoreIdentityPlan3 { readonly kind: 'main-root-restore-identity-plan' }
type Location = Awaited<ReturnType<typeof readRootKnowledgePlanLocation3>>
type Value = ReturnType<typeof deriveRootRestoreIdentityPlan3>
type Manifest = ReturnType<typeof manifestBody>
type OwnedRepeat = { proof: ExactV3RepeatProof; prior: RestoreKnowledgePriorInstall; sourceMaterialHash: string; currentMaterialHash: string;
  assertPlanManifests: () => Promise<void> }
type Saved = { knowledge: RootKnowledgeConservationPlan3; planId: string; location: Location; directory: string; manifestHash: string; repeat?: OwnedRepeat }
const plans = new WeakMap<RootRestoreIdentityPlan3, Saved>()
const maxManifestBytes = 8192
const manifestHash = (value: Manifest) => capsuleBytesHash('knowbook.restore.identity3.manifest.v1\0' + capsuleJson(value))
function manifestBody(location: Location, planId: string, inputs: Identity3Inputs, kernel: Identity3Kernel, value: Value, repeat?: ExactV3RepeatProof) {
  return { kind: 'prepared-root-restore-identity-plan' as const, version: repeat ? 4 as const : 3 as const, planId,
    originalDescriptorHash: location.descriptorHash, conservationHash: inputs.knowledge.conservationHash,
    sourceMaterialHash: inputs.source.materialHash, currentMaterialHash: inputs.current.materialHash,
    kernel, allocationHash: value.allocationHash, semanticValidationComplete: false as const,
    acceptedCoverage: false as const, effective: false as const, permit: false as const,
    ...(repeat ? { repeatOperationId: repeat.operationId, repeatProofHash: repeat.proofHash } : {}) }
}
function directory(location: Location, planId: string) {
  return join(location.profileRoot, 'backups', 'database-restore', location.operationId, 'restore-identity-plans-v3', planId)
}
async function readManifest(saved: Saved) {
  const text = await readCapsule2AssetManifest(join(saved.directory, 'manifest.json'), saved.location.profileRoot, maxManifestBytes)
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return identity3Invalid('持久预分配清单不是完整JSON') }
  const version = raw && typeof raw === 'object' && 'version' in raw ? raw.version : null
  const row = capsuleRecord(raw, ['kind','version','planId','originalDescriptorHash','conservationHash','sourceMaterialHash','currentMaterialHash','kernel','allocationHash',
    'semanticValidationComplete','acceptedCoverage','effective','permit', ...(version === 4 ? ['repeatOperationId', 'repeatProofHash'] : [])])
  if (row.kind !== 'prepared-root-restore-identity-plan' || version !== 3 && version !== 4 || durableSqlDagUuid(row.planId) !== saved.planId
    || row.originalDescriptorHash !== saved.location.descriptorHash || row.semanticValidationComplete !== false || row.acceptedCoverage !== false
    || row.effective !== false || row.permit !== false) return identity3Invalid('持久预分配不是本次原件的非安装清单')
  for (const field of ['conservationHash','sourceMaterialHash','currentMaterialHash','allocationHash']) durableSqlDagHash(row[field])
  if (version === 4) { durableSqlDagUuid(row.repeatOperationId); durableSqlDagHash(row.repeatProofHash) }
  const kernel = capsuleRecord(row.kernel, ['seed','preparedAt'])
  if (typeof kernel.seed !== 'string' || !/^[0-9a-f]{64}$/.test(kernel.seed) || typeof kernel.preparedAt !== 'string'
    || !Number.isFinite(Date.parse(kernel.preparedAt)) || new Date(kernel.preparedAt).toISOString() !== kernel.preparedAt) return identity3Invalid('持久Main规划kernel损坏')
  const value = row as unknown as Manifest
  if (text !== capsuleJson(value) + '\n' || manifestHash(value) !== saved.manifestHash) return identity3Invalid('持久预分配清单字节或hash变化')
  return value
}
async function readExactV3Repeat(location: Location, inputs: Identity3Inputs, installed?: readonly RestoreKnowledgePriorInstall[],
  operationId?: string): Promise<OwnedRepeat | undefined> {
  const archive = inputs.source.assetArchive
  if (archive.version !== 6) return undefined
  const entries = inputs.current.priorCoverageRequirements.entries.filter(entry => !operationId || entry.operationId === operationId)
    .sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt))
  if (!entries.length) return undefined
  const { readRestoreKnowledgePriorInstall, readVerifiedRestoreKnowledgePriorInstall } = await import('./restore-knowledge-install-proof')
  const previous = new Map(installed?.map(handle => {
    const actual = readVerifiedRestoreKnowledgePriorInstall(handle)
    return [actual.requirement.operationId, { handle, actual }] as const
  }))
  if (installed && (previous.size !== entries.length || previous.size !== installed.length || entries.some(entry => {
    const actual = previous.get(entry.operationId)?.actual
    return !actual || actual.profileRoot !== location.profileRoot || capsuleJson(actual.requirement) !== capsuleJson(entry)
  }))) return identity3Invalid('V3 原 current 安装链不完整')
  for (const entry of entries) {
    const known = previous.get(entry.operationId)
    const prior = known?.handle ?? await readRestoreKnowledgePriorInstall(location.profileRoot, entry.root, entry)
    const actual = known?.actual ?? readVerifiedRestoreKnowledgePriorInstall(prior)
    if (actual.profileRoot !== location.profileRoot || capsuleJson(actual.requirement) !== capsuleJson(entry))
      return identity3Invalid('先前 V3 安装凭据与本次 current 不一致')
    if (actual.sourceArchive.snapshotId !== archive.backupV3.snapshotId) continue
    if (actual.sourceArchive.inventoryHash !== archive.backupV3.inventoryHash)
      return identity3Invalid('同一 V3 snapshotId 的已安装清单哈希不同')
    return actual.withReferenceOriginalRows(projectV3RepeatReference5, async reference => {
      const proof = deriveExactV3RepeatProof(inputs, reference, entry)
      if (!proof) return identity3Invalid('已安装凭据与真实 V3 原件不一致')
      return { proof, prior, sourceMaterialHash: inputs.source.materialHash, currentMaterialHash: inputs.current.materialHash,
        assertPlanManifests: reference.assertPlanManifests }
    })
  }
}
async function assertOwnedRepeat(saved: Saved, inputs: Identity3Inputs, manifest: Manifest) {
  if (manifest.repeatOperationId) {
    const owned = saved.repeat ?? await readExactV3Repeat(saved.location, inputs, undefined, manifest.repeatOperationId)
    if (!owned || owned.proof.proofHash !== manifest.repeatProofHash || owned.sourceMaterialHash !== inputs.source.materialHash
      || owned.currentMaterialHash !== inputs.current.materialHash) return identity3Invalid('实际 V3 重复身份与持久清单不同')
    const { readVerifiedRestoreKnowledgePriorInstall } = await import('./restore-knowledge-install-proof')
    await readVerifiedRestoreKnowledgePriorInstall(owned.prior).assertOriginalProof()
    await owned.assertPlanManifests()
    saved.repeat = owned
  }
}
async function rebuildIdentity(saved: Saved, inputs: Identity3Inputs, manifest: Manifest) {
  await assertOwnedRepeat(saved, inputs, manifest)
  const repeat = saved.repeat?.proof
  return { value: deriveRootRestoreIdentityPlan3(inputs, manifest.kernel, repeat), repeat }
}
async function reconstructInputs(saved: Saved) {
  const before = await readManifest(saved), inputs = await readRootKnowledgeConservationContent3(saved.knowledge)
  const { value, repeat } = await rebuildIdentity(saved, inputs, before)
  const actual = manifestBody(saved.location, saved.planId, inputs, before.kernel, value, repeat)
  if (capsuleJson(actual) !== capsuleJson(before)) return identity3Invalid('实际完整SQL/K/内容不等于持久预分配输入')
  await readManifest(saved); await assertRootKnowledgePlanOriginalBytes3(saved.knowledge)
  return Object.freeze({ value, inputs, kernel: before.kernel, ...(repeat ? { repeat } : {}) })
}
async function reconstruct(saved: Saved) { return (await reconstructInputs(saved)).value }
function mint(saved: Saved) {
  const plan: RootRestoreIdentityPlan3 = Object.freeze({ kind: 'main-root-restore-identity-plan' })
  plans.set(plan, saved); return plan
}
/** A fixed Main factory owns entropy, clock, full original reads and the
 * exclusive durable kernel. No caller maps, UUID generator, rows or seed enter.
 * Only the kernel/hash is retained; every later use rebuilds every actual K. */
export async function prepareRootRestoreIdentityPlan3(knowledge: RootKnowledgeConservationPlan3,
  options?: { readonly repeatV3: readonly RestoreKnowledgePriorInstall[] }) {
  return (await prepareIdentity(knowledge, await readRootKnowledgeConservationContent3(knowledge), options)).result
}

type IdentityOptions = Parameters<typeof prepareRootRestoreIdentityPlan3>[1]
async function prepareIdentity(knowledge: RootKnowledgeConservationPlan3, inputs: Identity3Inputs, options?: IdentityOptions) {
  const location = await readRootKnowledgePlanLocation3(knowledge)
  const kernel = { seed: randomBytes(32).toString('hex'), preparedAt: new Date().toISOString() }, planId = randomUUID()
  const owned = options?.repeatV3.length ? await readExactV3Repeat(location, inputs, options.repeatV3) : undefined
  const repeat = owned?.proof
  const value = deriveRootRestoreIdentityPlan3(inputs, kernel, repeat), body = manifestBody(location, planId, inputs, kernel, value, repeat)
  const collection = join(location.profileRoot, 'backups', 'database-restore', location.operationId, 'restore-identity-plans-v3'), target = directory(location, planId)
  await restoreDirectory(collection, location.profileRoot); await restoreDirectory(target, location.profileRoot, true)
  const text = capsuleJson(body) + '\n'
  if (Buffer.byteLength(text) > maxManifestBytes) return identity3Invalid('持久kernel超过固定小清单预算')
  await writeCapsule2AssetCopy(join(target, 'manifest.json'), Buffer.from(text), location.profileRoot)
  await syncRestoreDirectory(target); await syncRestoreDirectory(collection)
  await syncOriginCatalogAncestors(collection, location.profileRoot)
  const saved: Saved = { knowledge, location, directory: target, planId, manifestHash: manifestHash(body), ...(owned ? { repeat: owned } : {}) }
  await readManifest(saved); await assertRootKnowledgePlanOriginalBytes3(knowledge)
  const result = Object.freeze({ plan: mint(saved), value, planId, manifestHash: saved.manifestHash, directory: target })
  return { result, actual: Object.freeze({ value, inputs, kernel, ...(repeat ? { repeat } : {}) }) }
}

export interface PreparedRootIdentityInputs5 { readonly kind: 'main-prepared-root-identity-inputs' }
type PreparedIdentity = { knowledge: RootKnowledgeConservationPlan3; knowledgeScope: PreparedRootKnowledgeInputs5;
  plan: RootRestoreIdentityPlan3; actual: Awaited<ReturnType<typeof reconstructInputs>> }
const preparedIdentities = new WeakMap<PreparedRootIdentityInputs5, PreparedIdentity>()

export async function withPreparedRootRestoreIdentityInputs5<T>(knowledge: RootKnowledgeConservationPlan3,
  knowledgeScope: PreparedRootKnowledgeInputs5, options: IdentityOptions,
  run: (identity: Awaited<ReturnType<typeof prepareRootRestoreIdentityPlan3>>, scope: PreparedRootIdentityInputs5) => Promise<T>) {
  const captured = await readPreparedRootKnowledgeInputs5(knowledge, knowledgeScope)
  const { result, actual } = await prepareIdentity(knowledge, captured.value, options)
  const scope: PreparedRootIdentityInputs5 = Object.freeze({ kind: 'main-prepared-root-identity-inputs' })
  preparedIdentities.set(scope, { knowledge, knowledgeScope, plan: result.plan, actual })
  try { return await run(result, scope) }
  finally { preparedIdentities.delete(scope) }
}

export async function readPreparedRootRestoreIdentityInputs5(plan: RootRestoreIdentityPlan3, scope: PreparedRootIdentityInputs5) {
  const entry = preparedIdentities.get(scope), saved = plans.get(plan)
  if (!entry || entry.plan !== plan || !saved) return identity3Invalid('不是本次准备的真实身份规划')
  const manifest = await readManifest(saved)
  const captured = await readPreparedRootKnowledgeInputs5(entry.knowledge, entry.knowledgeScope)
  await assertOwnedRepeat(saved, entry.actual.inputs, manifest)
  await readManifest(saved)
  if (preparedIdentities.get(scope) !== entry) return identity3Invalid('身份准备范围已结束')
  return Object.freeze({ actual: entry.actual, pair: captured.pair, original: captured.original, working: captured.working })
}
export async function readRootRestoreIdentityPlan3(handle: RootRestoreIdentityPlan3) {
  const entry = plans.get(handle)
  if (!entry) return identity3Invalid('不是实际Main持久身份规划句柄')
  return reconstruct(entry)
}
/** Fixed Main-only joint read for the graph planner. Both the allocation and
 * complete business originals belong to this same authenticated SQL read;
 * caller DTOs, returned rows and callbacks cannot replace either side. */
export async function readRootRestoreIdentityGraphInputs3(handle: RootRestoreIdentityPlan3) {
  const entry = plans.get(handle)
  if (!entry) return identity3Invalid('不是实际Main持久身份规划句柄')
  return reconstructInputs(entry)
}
/** Main-only genuine-owner metadata. This performs no SQL projection and is
 * not a substitute for the fresh complete read. Only the private Saved entry
 * supplies the directory, operation and base manifest binding. */
export async function readRootRestoreIdentityPlanLocation3(handle: RootRestoreIdentityPlan3) {
  const entry = plans.get(handle)
  if (!entry) return identity3Invalid('不是实际Main持久身份规划句柄')
  await readManifest(entry)
  return Object.freeze({ planId: entry.planId, manifestHash: entry.manifestHash,
    location: Object.freeze({ ...entry.location }) })
}
export async function assertRootRestoreIdentityOriginalBytes3(handle: RootRestoreIdentityPlan3) {
  const entry = plans.get(handle)
  if (!entry) return identity3Invalid('不是实际Main持久身份规划句柄')
  await readManifest(entry); await assertRootKnowledgePlanOriginalBytes3(entry.knowledge); await readManifest(entry)
}
/** The surrounding reference owner authenticates both manifests. Registry
 * identity alone routes the copy capability; caller metadata never enters. */
export function readRootRestoreIdentityOriginalOwnerForCopy3(handle: RootRestoreIdentityPlan3) {
  const entry = plans.get(handle)
  if (!entry) return identity3Invalid('不是实际Main持久身份规划句柄')
  return readRootKnowledgeOriginalOwnerForCopy3(entry.knowledge)
}
/** Restart accepts only a genuine newly reconstructed knowledge owner and the
 * exact durable plan locator/hash. A saved allocation DTO cannot mint a plan. */
export async function reopenRootRestoreIdentityPlan3(knowledge: RootKnowledgeConservationPlan3, input: { planId: string; expectedManifestHash: string }) {
  const saved = await reopenSaved(knowledge, input)
  const value = await reconstruct(saved)
  return Object.freeze({ plan: mint(saved), value, planId: saved.planId, manifestHash: saved.manifestHash, directory: saved.directory })
}

async function reopenSaved(knowledge: RootKnowledgeConservationPlan3, input: { planId: string; expectedManifestHash: string }): Promise<Saved> {
  const location = await readRootKnowledgePlanLocation3(knowledge), row = capsuleRecord(input, ['planId','expectedManifestHash'])
  const planId = durableSqlDagUuid(row.planId), expected = durableSqlDagHash(row.expectedManifestHash)
  return { knowledge, location, planId, directory: directory(location, planId), manifestHash: expected }
}

export interface ReopenedRootIdentityInputs5 { readonly kind: 'main-reopened-root-identity-inputs' }
type IdentityOriginals = Awaited<ReturnType<typeof readRootRestoreIdentityInputsAndOriginals5>>
const reopenedInputs = new WeakMap<ReopenedRootIdentityInputs5, { plan: RootRestoreIdentityPlan3; data: IdentityOriginals }>()

/** Reopen the durable identity manifest against this invocation's genuine qualified read. */
export async function withReopenedRootRestoreIdentityInputs5<T>(knowledge: RootKnowledgeConservationPlan3, knowledgeScope: ReopenedRootKnowledgeInputs5,
  input: Parameters<typeof reopenRootRestoreIdentityPlan3>[1],
  run: (plan: RootRestoreIdentityPlan3, scope: ReopenedRootIdentityInputs5) => Promise<T>): Promise<T> {
  const saved = await reopenSaved(knowledge, input)
  const data = await reconstructInputsAndOriginals5(saved, knowledgeScope), plan = mint(saved)
  const scope: ReopenedRootIdentityInputs5 = Object.freeze({ kind: 'main-reopened-root-identity-inputs' })
  reopenedInputs.set(scope, { plan, data })
  try { return await run(plan, scope) }
  finally { reopenedInputs.delete(scope) }
}

export async function readReopenedRootRestoreIdentityInputs5(plan: RootRestoreIdentityPlan3, scope: ReopenedRootIdentityInputs5) {
  const entry = reopenedInputs.get(scope)
  if (!entry || entry.plan !== plan) return identity3Invalid('不是本次冷重开的真实身份规划')
  await assertRootRestoreIdentityOriginalBytes3(plan)
  if (reopenedInputs.get(scope) !== entry) return identity3Invalid('冷重开身份原件已结束')
  return entry.data
}

/** Fixed Main joint read from the private identity registry. Its released
 * inputs/allocation and runtime originals share the same fresh Root3 read;
 * no caller packet, mapper, mode or earlier result can replace that owner. */
export async function readRootRestoreIdentityInputsAndOriginals5(handle: RootRestoreIdentityPlan3) {
  const saved = plans.get(handle)
  if (!saved) return identity3Invalid('不是实际Main持久身份规划句柄')
  return reconstructInputsAndOriginals5(saved)
}

async function reconstructInputsAndOriginals5(saved: Saved, scope?: ReopenedRootKnowledgeInputs5) {
  const before = await readManifest(saved)
  const captured = scope
    ? await readReopenedRootKnowledgeConservationInputs5(saved.knowledge, scope)
    : await readRootKnowledgeConservationContentAndOriginals5(saved.knowledge)
  const inputs = captured.value
  const { value, repeat } = await rebuildIdentity(saved, inputs, before)
  const actual = manifestBody(saved.location, saved.planId, inputs, before.kernel, value, repeat)
  if (capsuleJson(actual) !== capsuleJson(before)) return identity3Invalid('实际完整SQL/K/内容不等于持久预分配输入')
  await readManifest(saved); await assertRootKnowledgePlanOriginalBytes3(saved.knowledge)
  const data = Object.freeze({ value, inputs, kernel: before.kernel, ...(repeat ? { repeat } : {}) })
  return Object.freeze({ actual: data, pair: captured.pair, original: captured.original, working: captured.working })
}
