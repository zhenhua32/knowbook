import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { capsuleBytesHash, capsuleJson, capsuleRecord } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { readRootKnowledgeConservationContent3, readRootKnowledgePlanLocation3, assertRootKnowledgePlanOriginalBytes3,
  type RootKnowledgeConservationPlan3 } from './restore-knowledge-root3-read'
import { deriveRootRestoreIdentityPlan3, identity3Invalid, type Identity3Kernel, type Identity3Inputs } from './restore-knowledge-identity3-model'

export interface RootRestoreIdentityPlan3 { readonly kind: 'main-root-restore-identity-plan' }
type Location = Awaited<ReturnType<typeof readRootKnowledgePlanLocation3>>
type Value = ReturnType<typeof deriveRootRestoreIdentityPlan3>
type Manifest = ReturnType<typeof manifestBody>
type Saved = { knowledge: RootKnowledgeConservationPlan3; planId: string; location: Location; directory: string; manifestHash: string }
const plans = new WeakMap<RootRestoreIdentityPlan3, Saved>()
const maxManifestBytes = 8192
const manifestHash = (value: Manifest) => capsuleBytesHash('knowbook.restore.identity3.manifest.v1\0' + capsuleJson(value))
function manifestBody(location: Location, planId: string, inputs: Identity3Inputs, kernel: Identity3Kernel, value: Value) {
  return { kind: 'prepared-root-restore-identity-plan' as const, version: 3 as const, planId,
    originalDescriptorHash: location.descriptorHash, conservationHash: inputs.knowledge.conservationHash,
    sourceMaterialHash: inputs.source.materialHash, currentMaterialHash: inputs.current.materialHash,
    kernel, allocationHash: value.allocationHash, semanticValidationComplete: false as const,
    acceptedCoverage: false as const, effective: false as const, permit: false as const }
}
function directory(location: Location, planId: string) {
  return join(location.profileRoot, 'backups', 'database-restore', location.operationId, 'restore-identity-plans-v3', planId)
}
async function readManifest(saved: Saved) {
  const text = await readCapsule2AssetManifest(join(saved.directory, 'manifest.json'), saved.location.profileRoot, maxManifestBytes)
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return identity3Invalid('持久预分配清单不是完整JSON') }
  const row = capsuleRecord(raw, ['kind','version','planId','originalDescriptorHash','conservationHash','sourceMaterialHash','currentMaterialHash','kernel','allocationHash',
    'semanticValidationComplete','acceptedCoverage','effective','permit'])
  if (row.kind !== 'prepared-root-restore-identity-plan' || row.version !== 3 || durableSqlDagUuid(row.planId) !== saved.planId
    || row.originalDescriptorHash !== saved.location.descriptorHash || row.semanticValidationComplete !== false || row.acceptedCoverage !== false
    || row.effective !== false || row.permit !== false) return identity3Invalid('持久预分配不是本次原件的非安装清单')
  for (const field of ['conservationHash','sourceMaterialHash','currentMaterialHash','allocationHash']) durableSqlDagHash(row[field])
  const kernel = capsuleRecord(row.kernel, ['seed','preparedAt'])
  if (typeof kernel.seed !== 'string' || !/^[0-9a-f]{64}$/.test(kernel.seed) || typeof kernel.preparedAt !== 'string'
    || !Number.isFinite(Date.parse(kernel.preparedAt)) || new Date(kernel.preparedAt).toISOString() !== kernel.preparedAt) return identity3Invalid('持久Main规划kernel损坏')
  const value = row as unknown as Manifest
  if (text !== capsuleJson(value) + '\n' || manifestHash(value) !== saved.manifestHash) return identity3Invalid('持久预分配清单字节或hash变化')
  return value
}
async function reconstruct(saved: Saved) {
  const before = await readManifest(saved), inputs = await readRootKnowledgeConservationContent3(saved.knowledge)
  const value = deriveRootRestoreIdentityPlan3(inputs, before.kernel), actual = manifestBody(saved.location, saved.planId, inputs, before.kernel, value)
  if (capsuleJson(actual) !== capsuleJson(before)) return identity3Invalid('实际完整SQL/K/内容不等于持久预分配输入')
  await readManifest(saved); await assertRootKnowledgePlanOriginalBytes3(saved.knowledge)
  return value
}
function mint(saved: Saved) {
  const plan: RootRestoreIdentityPlan3 = Object.freeze({ kind: 'main-root-restore-identity-plan' })
  plans.set(plan, saved); return plan
}
/** A fixed Main factory owns entropy, clock, full original reads and the
 * exclusive durable kernel. No caller maps, UUID generator, rows or seed enter.
 * Only the kernel/hash is retained; every later use rebuilds every actual K. */
export async function prepareRootRestoreIdentityPlan3(knowledge: RootKnowledgeConservationPlan3) {
  const inputs = await readRootKnowledgeConservationContent3(knowledge), location = await readRootKnowledgePlanLocation3(knowledge)
  const kernel = { seed: randomBytes(32).toString('hex'), preparedAt: new Date().toISOString() }, planId = randomUUID()
  const value = deriveRootRestoreIdentityPlan3(inputs, kernel), body = manifestBody(location, planId, inputs, kernel, value)
  const collection = join(location.profileRoot, 'backups', 'database-restore', location.operationId, 'restore-identity-plans-v3'), target = directory(location, planId)
  await restoreDirectory(collection, location.profileRoot); await restoreDirectory(target, location.profileRoot, true)
  const text = capsuleJson(body) + '\n'
  if (Buffer.byteLength(text) > maxManifestBytes) return identity3Invalid('持久kernel超过固定小清单预算')
  await writeCapsule2AssetCopy(join(target, 'manifest.json'), Buffer.from(text), location.profileRoot)
  await syncRestoreDirectory(target); await syncRestoreDirectory(collection)
  await syncOriginCatalogAncestors(collection, location.profileRoot)
  const saved: Saved = { knowledge, location, directory: target, planId, manifestHash: manifestHash(body) }
  await readManifest(saved); await assertRootKnowledgePlanOriginalBytes3(knowledge)
  return Object.freeze({ plan: mint(saved), value, planId, manifestHash: saved.manifestHash, directory: target })
}
export async function readRootRestoreIdentityPlan3(handle: RootRestoreIdentityPlan3) {
  const entry = plans.get(handle)
  if (!entry) return identity3Invalid('不是实际Main持久身份规划句柄')
  return reconstruct(entry)
}
/** Restart accepts only a genuine newly reconstructed knowledge owner and the
 * exact durable plan locator/hash. A saved allocation DTO cannot mint a plan. */
export async function reopenRootRestoreIdentityPlan3(knowledge: RootKnowledgeConservationPlan3, input: { planId: string; expectedManifestHash: string }) {
  const location = await readRootKnowledgePlanLocation3(knowledge), row = capsuleRecord(input, ['planId','expectedManifestHash'])
  const planId = durableSqlDagUuid(row.planId), expected = durableSqlDagHash(row.expectedManifestHash)
  const saved: Saved = { knowledge, location, planId, directory: directory(location, planId), manifestHash: expected }
  const value = await reconstruct(saved)
  return Object.freeze({ plan: mint(saved), value, planId, manifestHash: expected, directory: saved.directory })
}
