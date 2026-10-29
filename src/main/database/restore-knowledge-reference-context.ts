import { capsule2AssetArchiveOriginalBytes3 } from './restore-knowledge-capsule2-asset-archive'
import { randomUUID } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagList, durableSqlDagUuid, DURABLE_SQL_DAG_MAX_PARENTS } from './restore-knowledge-dag-model'
import { readSealedCapsule2SourceInputs, assertSealedCapsule2SourceOriginalBytes, type SealedCapsule2Source } from './restore-knowledge-capsule2-source-seal'
import { rawPriorCoverageRequirementsHash, type CoverageInputBinding } from './restore-knowledge-coverage-model'
import { requiredDagDatabaseFilesHash, requiredDagInterpretationHash, type RequiredDagBundleOrigin } from './restore-knowledge-required-dag-model'
import { writeCapsule2AssetCopy, readCapsule2AssetManifest } from './restore-knowledge-capsule2-assets-files'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { canonicalRequiredSqlDagRoot } from './restore-knowledge-required-dag-files'
import { writeOriginalFrameDirectory, assertOriginalFrameDirectory, type OriginalFrameCopy } from './restore-knowledge-original-frame-files'
import { settleOriginCatalogBatch, syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { readCompleteOriginalPackage, assertCompleteOriginalPackageBytes, readReferenceContextOriginals, type CompleteOriginalBundle } from './restore-knowledge-qualified-originals'
import { validateCapsule2ReferenceContext, parseCapsule2ReferenceContext, requiredReferenceRoots, capsule2ReferenceContextHash,
  referenceContextMountedRoots, referenceContextInvalid as bad, referenceContextObjectPath,
  type Capsule2ReferenceContextDescriptor } from './restore-knowledge-reference-context-model'
import { validateCapsule2BoundSourceManifest, capsule2BoundSourceHash, BOUND_SOURCE_MANIFEST_MAX_BYTES } from './restore-knowledge-bound-source-model'
import { qualifiedOriginalSide, type QualifiedOriginalSide } from './restore-knowledge-qualified-original-model'
import { CAPSULE2_READER } from './restore-knowledge-capsule2-raw-model'
import type { OriginalSourceInput } from './restore-knowledge-original-input-types'

export interface OwnedOriginalReferenceContext { readonly kind: 'owned-original-reference-context' }
export interface BoundCapsule2OriginalInputs { readonly kind: 'bound-capsule2-original-inputs' }
type Source = Awaited<ReturnType<typeof readSealedCapsule2SourceInputs>>
type Context = { source: SealedCapsule2Source; profileRoot: string; directory: string; descriptor: Capsule2ReferenceContextDescriptor; hash: string; text: string }
const contexts = new WeakMap<OwnedOriginalReferenceContext, Context>()
const bindings = new WeakMap<BoundCapsule2OriginalInputs, { context: OwnedOriginalReferenceContext; directory: string; text: string; hash: string }>()
const used = new WeakSet<OwnedOriginalReferenceContext>()
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const sourcePins = (source: Source) => ({ operationId: source.value.operationId, capsuleId: source.value.capsuleId,
  sourceManifestHash: source.info.manifestHash, sourceMaterialHash: source.value.materialHash,
  rawRequirementsHash: rawPriorCoverageRequirementsHash(source.value.priorCoverageRequirements) })
function mint(entry: Context): OwnedOriginalReferenceContext {
  const handle: OwnedOriginalReferenceContext = Object.freeze({ kind: 'owned-original-reference-context' }); contexts.set(handle, entry); return handle
}
async function verify(entry: Context) {
  if (!entry.descriptor.requirements.entries.length || !entry.descriptor.parents.length) return bad('完整引用context必须对应非空原SQL要求')
  const source = await readSealedCapsule2SourceInputs(entry.source)
  if (source.profileRoot !== entry.profileRoot || !same(sourcePins(source), entry.descriptor.source)
    || !same(source.value.priorCoverageRequirements, entry.descriptor.requirements)) return bad('实际来源SQL、完整prior-C或上下文绑定变化')
  const text = await readCapsule2AssetManifest(join(entry.directory, 'descriptor.json'), entry.profileRoot)
  if (text !== entry.text) return bad('实际context原字节变化')
  const descriptor = parseCapsule2ReferenceContext(text, entry.hash)
  const originals = await readReferenceContextOriginals({ profileRoot: entry.profileRoot, directory: entry.directory, descriptor })
  await assertSealedCapsule2SourceOriginalBytes(entry.source)
  return { source, ...originals, descriptor, contextHash: entry.hash, contextText: text, profileRoot: entry.profileRoot, directory: entry.directory }
}
async function independentParents(originals: readonly Awaited<ReturnType<typeof readCompleteOriginalPackage>>[]): Promise<void> {
  // Compare real, simultaneously open descriptors, not canonical strings,
  // path.dev wildcards, truncated Windows volume ids or caller stat DTOs.
  const held: Awaited<ReturnType<typeof open>>[] = [], identities = new Set<string>()
  try {
    for (const original of originals) {
      const fd = await open(join(original.directory, 'descriptor.json'), 'r'); held.push(fd)
      const stat = await fd.stat({ bigint: true }), key = String(stat.dev) + ':' + String(stat.ino)
      if (!stat.isFile() || stat.nlink !== 1n || !stat.ino || process.platform === 'win32' && !stat.dev || identities.has(key)) return bad('不同原引用不能复用同一实际FD原件域')
      identities.add(key)
    }
  } finally {
    const closed = await Promise.allSettled(held.map(fd => fd.close()))
    for (const result of closed) if (result.status === 'rejected') throw result.reason
  }
}
/** The complete parent array is in the original SQL's sorted reference order.
 * Repeated hashes still require separate genuine, physically independent owners.
 * No DTO, parent prefix, selector, resolver callback or local UUID search enters. */
export async function captureOriginalReferenceContext(input: { source: SealedCapsule2Source; parents: readonly CompleteOriginalBundle[] }) {
  return (await captureOriginalReferenceContextWithInitialInputs(input)).context
}
/** The initial data belongs solely to this same complete source/copy capture.
 * It is never stored as an authority cache or accepted on a later handle read. */
export async function captureOriginalReferenceContextWithInitialInputs(input: Parameters<typeof captureOriginalReferenceContext>[0]) {
  const row = capsuleRecord(input, ['source','parents']), source = await readSealedCapsule2SourceInputs(row.source as SealedCapsule2Source)
  const handles = durableSqlDagList(row.parents, DURABLE_SQL_DAG_MAX_PARENTS) as readonly CompleteOriginalBundle[], roots = requiredReferenceRoots(source.value.priorCoverageRequirements)
  if (!roots.length || handles.length !== roots.length || new Set(handles).size !== handles.length) return bad('必须提供非空原SQL引用全集及独立原件句柄')
  const originals: Awaited<ReturnType<typeof readCompleteOriginalPackage>>[] = []
  await settleOriginCatalogBatch(handles.map((handle, index) => ({ handle, index })), async item => { originals[item.index] = await readCompleteOriginalPackage(item.handle) })
  if (new Set(originals.map(original => original.directory)).size !== originals.length) return bad('不同原引用不能复用同一物理原件域')
  await independentParents(originals)
  const descriptor = validateCapsule2ReferenceContext({ kind: 'capsule2-original-reference-context', version: 1,
    scope: 'complete-referenced-original-inputs', contextId: randomUUID(), source: sourcePins(source), requirements: source.value.priorCoverageRequirements,
    parents: originals.map((original, index) => ({ reference: roots[index], mountId: randomUUID(), reader: original.reader,
      descriptorHash: original.descriptorHash, originalRoot: original.original.root, materialHash: original.original.materialHash,
      originalSqlBytes: original.original.originalSqlBytes, managedOriginalBytes: original.original.managedOriginalBytes,
      files: original.files.map(({ frame, path, bytes, sha256 }) => ({ frame, path, bytes, sha256 })), directories: original.directories })),
    acceptedCoverage: false, effective: false, permit: false })
  const profileRoot = source.profileRoot, base = join(profileRoot, 'backups', 'database-restore', source.value.operationId, 'knowledge-original-reference-contexts')
  const directory = join(base, descriptor.contextId), text = capsuleJson(descriptor) + '\n'
  await restoreDirectory(base, profileRoot)
  const files: OriginalFrameCopy[] = originals.flatMap((original, index) => original.files.map(file => ({ ...file, frame: [descriptor.parents[index].mountId, ...file.frame] })))
  await writeOriginalFrameDirectory({ profileRoot, directory, descriptorText: text, files })
  // Every source original was read by its real SQL owner above. Recheck its
  // entire pinned immutable byte tree, not just the final file copied from it.
  await settleOriginCatalogBatch(handles, handle => assertCompleteOriginalPackageBytes(handle))
  const entry: Context = { source: row.source as SealedCapsule2Source, profileRoot, directory, descriptor, hash: capsule2ReferenceContextHash(descriptor), text }
  await assertSealedCapsule2SourceOriginalBytes(entry.source)
  await assertOriginalFrameDirectory(directory, text, files); await syncOriginCatalogAncestors(base, profileRoot)
  const mounted = referenceContextMountedRoots(descriptor)
  const parents = originals.map((original, index) => ({ original: original.original,
    reference: mounted.find(root => root.namespace.kind === 'imported-bundle' && root.namespace.mountId === descriptor.parents[index].mountId)! }))
  const value = { source, parents, descriptor, contextHash: entry.hash, contextText: text, profileRoot, directory }
  return Object.freeze({ context: mint(entry), value: freezeCapsuleValue(value) })
}
export async function readOriginalReferenceContext(handle: OwnedOriginalReferenceContext) {
  const entry = contexts.get(handle); if (!entry) return bad('不是Main完整原件context私有句柄')
  return verify(entry)
}
/** Reopen is bound to a genuine complete source and its own fixed context path.
 * It never searches the receiving profile for historical operation UUIDs. */
export async function reopenOriginalReferenceContext(input: { source: SealedCapsule2Source; contextId: string; expectedContextHash: string }) {
  const row = capsuleRecord(input, ['source','contextId','expectedContextHash']), source = await readSealedCapsule2SourceInputs(row.source as SealedCapsule2Source)
  const directory = join(source.profileRoot, 'backups', 'database-restore', source.value.operationId, 'knowledge-original-reference-contexts', durableSqlDagUuid(row.contextId))
  const text = await readCapsule2AssetManifest(join(directory, 'descriptor.json'), source.profileRoot)
  const descriptor = parseCapsule2ReferenceContext(text, row.expectedContextHash as string)
  if (descriptor.contextId !== row.contextId) return bad('context locator不相等')
  const entry: Context = { source: row.source as SealedCapsule2Source, profileRoot: source.profileRoot, directory, descriptor, hash: capsule2ReferenceContextHash(descriptor), text }
  await verify(entry); return mint(entry)
}
export async function bindCapsule2OriginalInputs(context: OwnedOriginalReferenceContext): Promise<BoundCapsule2OriginalInputs> {
  return (await captureBoundCapsule2OriginalInputs(context)).source
}
/** Initial input is produced only by this same binding factory's full context
 * read. No old handle or caller packet can select it. */
export async function captureBoundCapsule2OriginalInputs(context: OwnedOriginalReferenceContext) {
  return bindCapturedContext(context, await readOriginalReferenceContext(context))
}
/** Only a newly captured complete context supplies this initial binding input.
 * No existing handle or caller snapshot can bypass its later full read. */
export async function captureBoundOriginalInputsFromReferences(input: Parameters<typeof captureOriginalReferenceContext>[0]) {
  const captured = await captureOriginalReferenceContextWithInitialInputs(input)
  const bound = await bindCapturedContext(captured.context, captured.value)
  return Object.freeze({ ...bound, context: captured.context, contextData: captured.value })
}
async function bindCapturedContext(context: OwnedOriginalReferenceContext, actual: Awaited<ReturnType<typeof readOriginalReferenceContext>>) {
  const c = actual.descriptor, value = actual.source.value
  if (used.has(context)) return bad('同一context已开始绑定；不能覆盖或重试')
  used.add(context)
  const manifest = validateCapsule2BoundSourceManifest({ kind: 'capsule2-bound-reference-inputs', version: 1, readerVersion: CAPSULE2_READER,
    scope: 'complete-source-and-referenced-original-inputs', operationId: value.operationId, capsuleId: value.capsuleId,
    sourceManifestHash: actual.source.info.manifestHash, sourceMaterialHash: value.materialHash, sourceKnowledgeHash: value.knowledge.observationHash,
    rawRequirementsHash: c.source.rawRequirementsHash, contextId: c.contextId, contextHash: actual.contextHash,
    requiredCoverageEntries: c.requirements.entries.length, referencedRoots: c.parents.length, resolvedRootsHash: capsuleBytesHash(capsuleJson(referenceContextMountedRoots(c))),
    originalReferenceDomain: 'explicit-complete-original-context', originalInputsComplete: true,
    certified: false, semanticValidationComplete: false, acceptedCoverage: false, effective: false, permit: false, policyReplayAllowed: false })
  const base = join(actual.profileRoot, 'backups', 'database-restore', value.operationId, 'knowledge-reference-inputs-v1'), directory = join(base, value.capsuleId), text = capsuleJson(manifest) + '\n'
  await restoreDirectory(base, actual.profileRoot); await restoreDirectory(directory, actual.profileRoot, true)
  await writeCapsule2AssetCopy(join(directory, 'binding.json'), Buffer.from(text), actual.profileRoot)
  await syncRestoreDirectory(directory); await syncOriginCatalogAncestors(base, actual.profileRoot)
  const handle: BoundCapsule2OriginalInputs = Object.freeze({ kind: 'bound-capsule2-original-inputs' })
  bindings.set(handle, { context, directory, text, hash: capsule2BoundSourceHash(manifest) })
  const initial = await readBoundInput(actual.profileRoot, bindings.get(handle)!, actual)
  await tryAssertBoundCapsule2OriginalBytes(actual.profileRoot, handle)
  return Object.freeze({ source: handle, initial })
}
/** Only a complete byte bracket for a surrounding factory's actual captured
 * SQL. No snapshot, source projection or semantic authority is returned. */
export async function tryAssertBoundCapsule2OriginalBytes(profile: string, handle: unknown): Promise<boolean> {
  const bound = bindings.get(handle as BoundCapsule2OriginalInputs); if (!bound) return false
  const entry = contexts.get(bound.context); if (!entry) return bad('bound context不在Main私有registry')
  if (await canonicalRequiredSqlDagRoot(profile) !== entry.profileRoot) return bad('bound source不属于此实际profile')
  await assertSealedCapsule2SourceOriginalBytes(entry.source)
  const files = entry.descriptor.parents.flatMap(parent => parent.files.map(file => ({ ...file, frame: [parent.mountId, ...file.frame] })))
  await assertOriginalFrameDirectory(entry.directory, entry.text, files)
  const path = join(bound.directory, 'binding.json')
  if (!same((await readdir(bound.directory)).sort(), ['binding.json'])
    || await readCapsule2AssetManifest(path, entry.profileRoot, BOUND_SOURCE_MANIFEST_MAX_BYTES) !== bound.text) return bad('bound来源原字节或目录变化')
  return true
}
/** Fixed registry dispatch only. A true handle must still reread its complete
 * source, every referenced original, its binding and all source metadata. */
export async function tryReadBoundCapsule2OriginalInputs(profile: string, handle: unknown) {
  const entry = bindings.get(handle as BoundCapsule2OriginalInputs); if (!entry) return null
  const root = await canonicalRequiredSqlDagRoot(profile), actual = await readOriginalReferenceContext(entry.context)
  return readBoundInput(root, entry, actual)
}
async function readBoundInput(root: string, entry: NonNullable<ReturnType<typeof bindings.get>>, actual: Awaited<ReturnType<typeof readOriginalReferenceContext>>) {
  const value = actual.source.value
  if (root !== actual.profileRoot) return bad('bound source不属于此实际profile')
  const before = await readCapsule2AssetManifest(join(entry.directory, 'binding.json'), root, BOUND_SOURCE_MANIFEST_MAX_BYTES)
  if (before !== entry.text || !same((await readdir(entry.directory)).sort(), ['binding.json'])) return bad('实际bound来源原字节/目录变化')
  const origin: RequiredDagBundleOrigin = { kind: 'bound-original-bundle', version: 1, mountId: actual.descriptor.contextId,
    bundleDescriptorHash: actual.contextHash, databaseFilesHash: requiredDagDatabaseFilesHash(value.sourceInventory), rawRequirementsHash: actual.descriptor.source.rawRequirementsHash }
  const binding: CoverageInputBinding = { capsule: { kind: 'restore-knowledge-origin-capsule-ref', version: 1, namespace: { kind: 'native' },
    operationId: value.operationId, capsuleId: value.capsuleId, manifestHash: entry.hash, readerVersion: CAPSULE2_READER },
    interpretationHash: requiredDagInterpretationHash(origin), rawRequirementsHash: origin.rawRequirementsHash, requiredRoots: referenceContextMountedRoots(actual.descriptor) }
  const input: OriginalSourceInput = { binding, origin, originalSqlBytes: value.sourceInventory.reduce((n, file) => n + file.bytes, 0),
    managedOriginalBytes: capsule2AssetArchiveOriginalBytes3(value.assetArchive), knowledge: { readerVersion: CAPSULE2_READER,
      projection: value.knowledge, projectionHash: value.knowledge.observationHash, sourceMaterialHash: value.materialHash, assetArchiveHash: value.assetArchiveHash } }
  const operation = join(root, 'backups', 'database-restore', value.operationId)
  const side: QualifiedOriginalSide = { kind: 'bound-capsule2', bindingText: before, contextText: actual.contextText,
    sourceManifestText: await readCapsule2AssetManifest(join(actual.source.info.directory, 'manifest.json'), root),
    assetManifestText: await readCapsule2AssetManifest(join(operation, 'knowledge-complete-assets-v2', value.capsuleId, 'manifest.json'), root) }
  qualifiedOriginalSide(side, binding, origin)
  if (before !== await readCapsule2AssetManifest(join(entry.directory, 'binding.json'), root, BOUND_SOURCE_MANIFEST_MAX_BYTES)
    || !same((await readdir(entry.directory)).sort(), ['binding.json'])) return bad('bound来源读取结束时变化')
  return { input, side, actual, parentCopies: actual.descriptor.parents.flatMap(parent => parent.files.map(file => ({ ...file,
    frame: [actual.descriptor.contextId, parent.mountId, ...file.frame], sourceRoot: actual.directory,
    sourcePath: join(actual.directory, ...referenceContextObjectPath([parent.mountId, ...file.frame], file.path).split('/')) }))) }
}
