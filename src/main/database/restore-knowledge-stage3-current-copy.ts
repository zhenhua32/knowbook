// Main-owned exact current-original copies; these are never opened by SQLite.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CAPSULE_MAX_MANIFEST_BYTES, capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { requiredDagDatabaseFilesHash } from './restore-knowledge-required-dag-model'
import { capsule2SourceManifestHash } from './restore-knowledge-capsule2-source-seal-model'
import { readCompleteOriginalRootCurrentFiles3 } from './restore-knowledge-qualified-originals'
import { assertRootRestoreReferenceOriginalBytes3, readRootRestoreReferenceCopySource3,
  type RootRestoreReferencePlan3 } from './restore-knowledge-reference3-read'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { copyOriginCatalogFile, readOriginCatalogFile,
  syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { holdRootRestoreStage3Files3, assertRootRestoreStage3FilesHeld3,
  closeRootRestoreStage3FilesHeld3 } from './restore-knowledge-stage3-files'

export interface RootRestoreCurrentCopy3 { readonly kind: 'main-root-restore-current-original-copy' }
type CopySource = Awaited<ReturnType<typeof readRootRestoreReferenceCopySource3>>
type CurrentOriginal = Awaited<ReturnType<typeof readCompleteOriginalRootCurrentFiles3>>
type Binding = ReturnType<typeof referenceBinding>
type Manifest = ReturnType<typeof manifestBody>
type Value = ReturnType<typeof copyValue>
export type RootRestoreCurrentCopyValue3 = Value
interface Saved {
  readonly reference: RootRestoreReferencePlan3
  readonly copyId: string; readonly preparedAt: string
  readonly binding: Binding; readonly original: CurrentOriginal
  readonly directory: string; readonly databaseDirectory: string
  readonly manifest: Manifest; readonly manifestHash: string
}
const copies = new WeakMap<RootRestoreCurrentCopy3, Saved>()
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const invalid = (message: string): never => { throw new Error('Root3 current原件副本无效：' + message
  + '；未授SQL业务写入、可执行stage、安装或coverage权；失败目录保留。') }
const manifestHash = (body: Manifest) => capsuleBytesHash('knowbook.restore.stage3.current-copy.manifest.v1\0' + capsuleJson(body))
function referenceBinding(owner: CopySource) {
  return { referencePlanId: owner.referencePlanId, referenceManifestHash: owner.referenceManifestHash,
    baseIdentityPlanId: owner.baseIdentityPlanId, baseIdentityManifestHash: owner.baseIdentityManifestHash,
    baseIdentityAllocationHash: owner.baseIdentityAllocationHash,
    derivedReferenceAllocationHash: owner.derivedReferenceAllocationHash,
    checkedCanonicalCandidateHash: owner.checkedCanonicalCandidateHash,
    sourceMaterialHash: owner.sourceMaterialHash, currentMaterialHash: owner.currentMaterialHash,
    conservationHash: owner.conservationHash, originalDescriptorHash: owner.originalDescriptorHash }
}
function manifestBody(copyId: string, preparedAt: string, binding: Binding, original: CurrentOriginal) {
  const source = original.sourceManifest
  return { kind: 'root-restore-current-original-copy' as const, version: 1 as const,
    scope: 'root-current-original-three-file-copy' as const, copyId, preparedAt, ...binding,
    originalReader: original.reader, originalRoot: original.root, originalCurrentBinding: original.binding,
    originalCurrentOrigin: original.origin, sourceManifestHash: capsule2SourceManifestHash(source),
    schemaVersion: source.schemaVersion, encoding: source.encoding,
    workspaceScope: source.workspaceScope, recoveryEpoch: source.recoveryEpoch,
    originalInventory: source.files, originalInventoryHash: requiredDagDatabaseFilesHash(source.files),
    originalBytesCopied: true as const, sqlOpened: false as const, businessSqlWritten: false as const,
    currentStageComplete: false as const, finalCurrentRetainedCutComplete: false as const,
    semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
}
function copyValue(saved: Saved) {
  return freezeCapsuleValue({ ...saved.manifest, copyManifestHash: saved.manifestHash })
}
function checkOriginalBinding(owner: CopySource, original: CurrentOriginal) {
  if (owner.location.profileRoot !== original.profileRoot || owner.location.operationId !== original.operationId
    || owner.originalDescriptorHash !== original.descriptorHash || owner.location.descriptorHash !== original.descriptorHash
    || owner.currentMaterialHash !== original.sourceManifest.sourceMaterialHash)
    return invalid('同genuine reference的root current角色/材料/原catalog locator不闭合')
  // The selected role is derived from the private bundle's root node. Source
  // and ancestors cannot be substituted even when their hashes/UUIDs coincide.
  if (requiredDagDatabaseFilesHash(original.sourceManifest.files) !== original.origin.databaseFilesHash)
    return invalid('current manifest与exact root current origin清单不同')
}
async function readCopyManifest(saved: Saved) {
  const path = join(saved.directory, 'manifest.json'), expected = capsuleJson(saved.manifest) + '\n'
  await readOriginCatalogFile(path, saved.original.profileRoot,
    { path: 'current-copy-manifest', bytes: Buffer.byteLength(expected), sha256: capsuleBytesHash(expected) })
  const actual = await readCapsule2AssetManifest(path, saved.original.profileRoot, CAPSULE_MAX_MANIFEST_BYTES)
  if (actual !== expected || manifestHash(saved.manifest) !== saved.manifestHash)
    return invalid('持久copy清单原bytes/hash变化')
}
async function reconstruct(saved: Saved): Promise<Value> {
  const owner = await readRootRestoreReferenceCopySource3(saved.reference)
  const original = await readCompleteOriginalRootCurrentFiles3(owner.original)
  checkOriginalBinding(owner, original)
  if (!same(referenceBinding(owner), saved.binding) || !same(original, saved.original))
    return invalid('genuine reference或其实际root current原件变化')
  const manifestText = capsuleJson(saved.manifest) + '\n'
  const inventory = saved.original.sourceManifest.files
  const held = await holdRootRestoreStage3Files3({ profileRoot: saved.original.profileRoot,
    directories: [{ path: saved.directory, entries: ['database', 'manifest.json'] },
      { path: saved.databaseDirectory, entries: inventory.filter(file => file.present).map(file => file.name) }],
    files: [{ path: join(saved.directory, 'manifest.json'), bytes: Buffer.byteLength(manifestText), sha256: capsuleBytesHash(manifestText) },
      ...inventory.filter(file => file.present).map(file => ({ path: join(saved.databaseDirectory, file.name), bytes: file.bytes,
        sha256: file.sha256 ?? invalid('present原文件缺hash') }))],
    absentFiles: inventory.filter(file => !file.present).map(file => join(saved.databaseDirectory, file.name)) })
  try {
    await assertRootRestoreReferenceOriginalBytes3(saved.reference)
    await readCopyManifest(saved)
    assertRootRestoreStage3FilesHeld3(held)
    return copyValue(saved)
  } finally { closeRootRestoreStage3FilesHeld3(held) }
}
/** Bytes-only preparation. The only input is a genuine reference handle.
 * The future fixed stage factory owns its one fresh reference joint SQL/K
 * read, then coordinates this copy and compares these durable bindings.
 * This factory itself never opens SQL or re-authenticates caller data. */
export async function prepareRootRestoreCurrentCopy3(reference: RootRestoreReferencePlan3) {
  const owner = await readRootRestoreReferenceCopySource3(reference)
  const original = await readCompleteOriginalRootCurrentFiles3(owner.original)
  checkOriginalBinding(owner, original)
  const binding = referenceBinding(owner), copyId = randomUUID(), preparedAt = new Date().toISOString()
  const collection = join(original.profileRoot, 'backups', 'database-restore', original.operationId, 'restore-current-copies-v3')
  const directory = join(collection, copyId), databaseDirectory = join(directory, 'database')
  await restoreDirectory(collection, original.profileRoot)
  await restoreDirectory(directory, original.profileRoot, true)
  await restoreDirectory(databaseDirectory, original.profileRoot, true)
  const byName = new Map(original.files.map(source => [source.path.slice(source.path.lastIndexOf('/') + 1), source]))
  for (const file of original.sourceManifest.files) {
    if (!file.present) continue
    const source = byName.get(file.name)
    if (!source || file.sha256 === null || source.bytes !== file.bytes || source.sha256 !== file.sha256)
      return invalid('实际current原文件不能精确join完整清单')
    await copyOriginCatalogFile(source.sourcePath, source.sourceRoot, join(databaseDirectory, file.name), original.profileRoot,
      { path: file.name, bytes: file.bytes, sha256: file.sha256 })
  }
  const manifest = manifestBody(copyId, preparedAt, binding, original), text = capsuleJson(manifest) + '\n'
  if (Buffer.byteLength(text) > CAPSULE_MAX_MANIFEST_BYTES) return invalid('副本小清单超现有manifest格式预算')
  await writeCapsule2AssetCopy(join(directory, 'manifest.json'), Buffer.from(text), original.profileRoot)
  await syncRestoreDirectory(databaseDirectory); await syncRestoreDirectory(directory); await syncRestoreDirectory(collection)
  await syncOriginCatalogAncestors(collection, original.profileRoot)
  const saved: Saved = { reference, copyId, preparedAt, binding, original, directory, databaseDirectory,
    manifest, manifestHash: manifestHash(manifest) }
  const value = await reconstruct(saved)
  const copy: RootRestoreCurrentCopy3 = Object.freeze({ kind: 'main-root-restore-current-original-copy' })
  copies.set(copy, saved)
  return Object.freeze({ copy, value, copyId, manifestHash: saved.manifestHash, directory })
}
export async function readRootRestoreCurrentCopy3(copy: RootRestoreCurrentCopy3) {
  const saved = copies.get(copy)
  if (!saved) return invalid('不是实际Main current原件副本句柄')
  return reconstruct(saved)
}
/** Fixed Main downstream metadata. It does not open SQL, mint a stage/permit,
 * or accept a caller path. A future writer must accept this genuine copy
 * handle, perform its fixed transaction/readback, and own the mutation state;
 * the returned path/DTO is never an alternative factory input. */
export async function readRootRestoreCurrentCopyForStage3(copy: RootRestoreCurrentCopy3) {
  const saved = copies.get(copy)
  if (!saved) return invalid('不是实际Main current原件副本句柄')
  const value = await reconstruct(saved)
  return Object.freeze({ reference: saved.reference, value, copyId: saved.copyId, manifestHash: saved.manifestHash,
    profileRoot: saved.original.profileRoot, operationId: saved.original.operationId,
    directory: saved.directory, databaseDirectory: saved.databaseDirectory,
    databasePath: join(saved.databaseDirectory, 'knowbook.db') })
}
/** Durable locator only. The genuine reference/private original chain derives
 * every binding and the complete root.current inventory again. The copied
 * manifest never selects a source path, new seed, SQL reader or permission. */
export async function reopenRootRestoreCurrentCopy3(reference: RootRestoreReferencePlan3,
  input: { readonly copyId: string; readonly expectedManifestHash: string }) {
  const owner = await readRootRestoreReferenceCopySource3(reference)
  const locator = capsuleRecord(input, ['copyId','expectedManifestHash'])
  const copyId = durableSqlDagUuid(locator.copyId), expected = durableSqlDagHash(locator.expectedManifestHash)
  const original = await readCompleteOriginalRootCurrentFiles3(owner.original)
  checkOriginalBinding(owner, original)
  const binding = referenceBinding(owner), directory = join(original.profileRoot, 'backups', 'database-restore',
    original.operationId, 'restore-current-copies-v3', copyId), databaseDirectory = join(directory, 'database')
  const bytes = await readCapsule2AssetManifest(join(directory, 'manifest.json'), original.profileRoot, CAPSULE_MAX_MANIFEST_BYTES)
  let parsed: unknown
  try { parsed = JSON.parse(bytes) } catch { return invalid('cold copy清单不是完整JSON') }
  const stamp = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.getOwnPropertyDescriptor(parsed, 'preparedAt')?.value : undefined
  if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString() !== stamp)
    return invalid('cold copy原准备时点不是canonical ISO')
  const manifest = manifestBody(copyId, stamp, binding, original)
  capsuleRecord(parsed, Object.keys(manifest))
  if (bytes !== capsuleJson(manifest) + '\n' || manifestHash(manifest) !== expected)
    return invalid('cold copy不是同genuine reference/实际current原件的exact持久清单')
  const saved: Saved = { reference, copyId, preparedAt: stamp, binding, original, directory, databaseDirectory,
    manifest, manifestHash: expected }
  const value = await reconstruct(saved)
  const copy: RootRestoreCurrentCopy3 = Object.freeze({ kind: 'main-root-restore-current-original-copy' })
  copies.set(copy, saved)
  return Object.freeze({ copy, value, copyId, manifestHash: expected, directory })
}
