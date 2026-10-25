import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid, DURABLE_SQL_DAG_MAX_CAPSULES, DURABLE_SQL_DAG_MAX_DEPTH,
  DURABLE_SQL_DAG_MAX_NODES, DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES, DURABLE_SQL_DAG_MAX_TOTAL_NODE_BYTES } from './restore-knowledge-dag-model'
import { canonicalRequiredSqlDagRoot, writeRequiredSqlDagNodeFile } from './restore-knowledge-required-dag-files'
import { parseRequiredSqlDagNode, requiredDagCapsuleLocator, requiredDagParentUnion, requiredDagRootLocator,
  requiredDagDatabaseFilesHash, requiredDagInterpretationHash, validateRequiredSqlDagNode, type RequiredSqlDagNode } from './restore-knowledge-required-dag-model'
import { readActualNoPriorOriginalInput, type reopenActualFirstRequiredSqlDagWithInitialMaterial } from './restore-knowledge-mixed-required-dag-read'
import { readPreparedMixedOriginBundleOriginalInputs, assertPreparedMixedOriginBundleOriginalBytes, type PreparedMixedOriginBundle } from './restore-knowledge-mixed-origin-bundle-read'
import { parseMixedOriginBundleDescriptor, mixedOriginBundleHash, mixedOriginBundleFiles, mixedOriginBundleDirectories,
  mixedOriginBundleSideFiles, type MixedOriginBundleDescriptor } from './restore-knowledge-mixed-origin-bundle-model'
import { captureReopenedCertifiedCapsuleNoPriorSourceInputs, type CertifiedDurableSqlCapsule } from './restore-knowledge-capsule-read'
import { captureReopenedCertifiedCapsule2Source, type CertifiedCapsule2NoPriorSource } from './restore-knowledge-capsule2-source-certificate'
import { CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES } from './restore-knowledge-capsule2-source-certificate-model'
import { captureReopenedSealedCapsule2Source, readSealedCapsule2SourceInputs, type SealedCapsule2Source } from './restore-knowledge-capsule2-source-seal'
import { rawPriorCoverageRequirementsHash, validateCoverageCapsuleReference, type CoverageInputBinding } from './restore-knowledge-coverage-model'
import { knowledgeHash, knowledgePayloadHash } from './restore-knowledge-payload-model'
import { CAPSULE2_READER } from './restore-knowledge-capsule2-raw-model'
import { parseCapsule2BoundSourceManifest } from './restore-knowledge-bound-source-model'
import { readCapsule2AssetManifest } from './restore-knowledge-capsule2-assets-files'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { canonicalOriginCatalogRoot, originCatalogLocalPath, copyOriginCatalogFile, settleOriginCatalogBatch, syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { assertOriginalFrameDirectory, readOriginalFrameText, writeOriginalFrameDirectory, type OriginalFrameCopy } from './restore-knowledge-original-frame-files'
import { referenceContextFileKey, referenceContextObjectPath, referenceContextMountedRoots, referenceContextInvalid as bad,
  REFERENCE_CONTEXT_MAX_BYTES, type ReferenceContextFile, type ReferenceContextDirectory, type Capsule2ReferenceContextDescriptor } from './restore-knowledge-reference-context-model'
import { parseQualifiedOriginalDescriptor, qualifiedOriginalInventory, qualifiedOriginalDescriptorHash, qualifiedOriginalSide,
  validateQualifiedOriginalDescriptor, type QualifiedOriginalDescriptor, type QualifiedOriginalSide } from './restore-knowledge-qualified-original-model'
import { tryReadBoundCapsule2OriginalInputs, tryAssertBoundCapsule2OriginalBytes, captureBoundCapsule2OriginalInputs,
  captureBoundOriginalInputsFromReferences, type BoundCapsule2OriginalInputs, type OwnedOriginalReferenceContext } from './restore-knowledge-reference-context'
import type { CompleteOriginalPackage, CompleteOriginalRootData, OriginalSourceInput } from './restore-knowledge-original-input-types'

export interface QualifiedOriginalBundle { readonly kind: 'qualified-original-input-bundle' }
export type CompleteOriginalBundle = PreparedMixedOriginBundle | QualifiedOriginalBundle
type Source = CertifiedDurableSqlCapsule | CertifiedCapsule2NoPriorSource | BoundCapsule2OriginalInputs
type Inventory = { files: readonly ReferenceContextFile[]; directories: readonly ReferenceContextDirectory[] }
type NodeReaders = { profile: string; sources: Map<string, CertifiedDurableSqlCapsule | CertifiedCapsule2NoPriorSource | SealedCapsule2Source> }
type ReaderState = Map<string, NodeReaders>
type View = Inventory & { directory: string; profileRoot: string; descriptorText: string; readers: ReaderState }
type Saved = { profileRoot: string; operationId: string; mountId: string; directory: string; hash: string; readers: ReaderState }
const bundles = new WeakMap<QualifiedOriginalBundle, Saved>()
// Only genuine SQL-reader handles are retained. Every hot use rereads their
// actual SQL; the immutable package is independently checked before and after.
// States are per physical domain, never keyed/deduplicated by root hash.
const capturedReaders = new WeakMap<CompleteOriginalPackage, ReaderState>()
const same = (a: unknown, b: unknown): boolean => capsuleJson(a) === capsuleJson(b)
const starts = (frame: readonly string[], prefix: readonly string[]) => prefix.length <= frame.length && prefix.every((part, index) => frame[index] === part)
const sorted = <T extends Pick<ReferenceContextFile, 'frame' | 'path'>>(items: readonly T[]): T[] => [...items].sort((a, b) => referenceContextFileKey(a) < referenceContextFileKey(b) ? -1 : 1)
const header = (text: string): ReferenceContextFile => ({ frame: [], path: 'descriptor.json', bytes: Buffer.byteLength(text), sha256: capsuleBytesHash(text) })
function viewPath(view: View, file: ReferenceContextFile): string {
  return !file.frame.length && file.path === 'descriptor.json' ? join(view.directory, 'descriptor.json')
    : originCatalogLocalPath(view.directory, referenceContextObjectPath(file.frame, file.path))
}
function packageFrom(view: View, reader: CompleteOriginalPackage['reader'], hash: string, original: CompleteOriginalRootData): CompleteOriginalPackage {
  return freezeCapsuleValue({ reader, directory: view.directory, descriptorHash: hash, descriptorText: view.descriptorText, original,
    files: sorted(view.files).map(file => ({ ...file, sourcePath: viewPath(view, file), sourceRoot: view.directory })), directories: sorted(view.directories) })
}
function domainInventory(view: View, prefix: readonly string[], expected: Inventory, descriptorText: string): void {
  const relative = <T extends Pick<ReferenceContextFile, 'frame' | 'path'>>(items: readonly T[]) =>
    sorted(items.filter(file => starts(file.frame, prefix)).map(file => ({ ...file, frame: file.frame.slice(prefix.length) })))
  if (!same(relative(view.files), sorted([header(descriptorText), ...expected.files])) || !same(relative(view.directories), sorted(expected.directories)))
    return bad('逻辑原件子域不是其固定reader完整生成的文件/目录闭集')
}
async function domainText(view: View, prefix: readonly string[]): Promise<string> {
  if (!prefix.length) return view.descriptorText
  const file = view.files.find(file => same(file.frame, prefix) && file.path === 'descriptor.json')
  if (!file) return bad('原件域缺实际descriptor')
  return readOriginalFrameText(view.directory, file, REFERENCE_CONTEXT_MAX_BYTES)
}
async function verificationProfile(view: View, prefix: readonly string[], directories: readonly ReferenceContextDirectory[]) {
  const base = join(view.profileRoot, 'original-input-verification'), profile = join(base, randomUUID())
  await restoreDirectory(base, view.profileRoot); await restoreDirectory(profile, view.profileRoot, true)
  const dirs = directories.filter(dir => !dir.frame.length && dir.path !== 'catalog').map(dir => {
    if (!dir.path.startsWith('catalog/')) return bad('本节点不是固定catalog目录')
    return dir.path.slice('catalog/'.length)
  }).sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
  for (const dir of dirs) await restoreDirectory(originCatalogLocalPath(profile, dir), profile)
  const files = view.files.filter(file => same(file.frame, prefix) && file.path.startsWith('catalog/'))
  await settleOriginCatalogBatch(files, file => copyOriginCatalogFile(viewPath(view, file), view.directory,
    originCatalogLocalPath(profile, file.path.slice('catalog/'.length)), profile, file))
  return profile
}
type Budget = { nodes: number; capsules: number; nodeBytes: number; bytes: number }
const budget = (): Budget => ({ nodes: 0, capsules: 0, nodeBytes: 0, bytes: 0 })
function charge(b: Budget, node: RequiredSqlDagNode, depth: number): void {
  b.nodes++; b.capsules += 2; b.nodeBytes += Buffer.byteLength(capsuleJson(node))
  if (depth > DURABLE_SQL_DAG_MAX_DEPTH || b.nodes > DURABLE_SQL_DAG_MAX_NODES || b.capsules > DURABLE_SQL_DAG_MAX_CAPSULES || b.nodeBytes > DURABLE_SQL_DAG_MAX_TOTAL_NODE_BYTES)
    return bad('完整实际原件图超原DAG深度/节点/来源/node字节预算；不能截断')
}
function totals(inputs: readonly OriginalSourceInput[], parents: CompleteOriginalRootData['parents'], depth: number) {
  const originalSqlBytes = inputs.reduce((n, i) => n + i.originalSqlBytes, 0) + parents.reduce((n, p) => n + p.original.originalSqlBytes, 0)
  const managedOriginalBytes = inputs.reduce((n, i) => n + i.managedOriginalBytes, 0) + parents.reduce((n, p) => n + p.original.managedOriginalBytes, 0)
  if (!Number.isSafeInteger(originalSqlBytes + managedOriginalBytes) || originalSqlBytes + managedOriginalBytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES) return bad('完整实际SQL及附件原件超原DAG预算')
  return { originalSqlBytes, managedOriginalBytes, nodes: 1 + parents.reduce((n, p) => n + p.original.nodes, 0),
    capsules: 2 + parents.reduce((n, p) => n + p.original.capsules, 0), depth, nodeBytes: 0 }
}
function ownInput(value: Awaited<ReturnType<typeof readActualNoPriorOriginalInput>>): OriginalSourceInput {
  return { binding: value.binding, origin: value.origin, knowledge: value.knowledge,
    originalSqlBytes: value.originalSqlBytes, managedOriginalBytes: value.managedOriginalBytes }
}
type LegacyMaterial = Pick<Awaited<ReturnType<typeof reopenActualFirstRequiredSqlDagWithInitialMaterial>>['value'],
  'root' | 'node' | 'inputs' | 'materialHash' | 'originalSqlBytes' | 'managedOriginalBytes'>
function legacyData(descriptor: MixedOriginBundleDescriptor, value: LegacyMaterial): CompleteOriginalRootData {
  const node = parseRequiredSqlDagNode(descriptor.nodeText)
  const inputs = [descriptor.source, descriptor.current].map((side, index) => {
    const binding = index ? node.current : node.source, actual = value.inputs.find(input => requiredDagCapsuleLocator(input.binding) === requiredDagCapsuleLocator(binding))!
    const files = mixedOriginBundleSideFiles(side, binding)
    return { binding: actual.binding, origin: actual.origin, knowledge: actual.knowledge,
      originalSqlBytes: files.inventory.reduce((n, f) => n + f.bytes, 0), managedOriginalBytes: files.files.filter(f => /\/files\/[0-9a-f]{64}$/.test(f.path)).reduce((n, f) => n + f.bytes, 0) }
  })
  if (value.originalSqlBytes !== inputs.reduce((n, i) => n + i.originalSqlBytes, 0) || value.managedOriginalBytes !== inputs.reduce((n, i) => n + i.managedOriginalBytes, 0)) return bad('legacy完整实际字节计数不等于原清单')
  return freezeCapsuleValue({ root: value.root, node: value.node, inputs, parents: [], materialHash: value.materialHash,
    scope: 'complete-original-input-closure', originalInputsComplete: true, semanticValidationComplete: false,
    originalSqlBytes: value.originalSqlBytes, managedOriginalBytes: value.managedOriginalBytes, nodes: 1, capsules: 2, depth: 1,
    nodeBytes: Buffer.byteLength(descriptor.nodeText), acceptedCoverage: false, effective: false, permit: false })
}
function assertParent(descriptor: Capsule2ReferenceContextDescriptor['parents'][number], actual: CompleteOriginalRootData): void {
  if (!same(descriptor.originalRoot, actual.root) || descriptor.materialHash !== actual.materialHash
    || descriptor.originalSqlBytes !== actual.originalSqlBytes || descriptor.managedOriginalBytes !== actual.managedOriginalBytes) return bad('父引用必须绑定实际全量重建的root、材料和原字节')
}
async function contextParents(view: View, prefix: readonly string[], context: Capsule2ReferenceContextDescriptor, b: Budget, depth: number): Promise<CompleteOriginalRootData['parents']> {
  const mounted = referenceContextMountedRoots(context), parents: Array<CompleteOriginalRootData['parents'][number]> = []
  // One shared traversal budget and sequential recursive descent: no recursive
  // fanout, hash deduplication, local fallback or caller-controlled loader.
  for (const parent of context.parents) {
    const original = await walk(view, [...prefix, parent.mountId], parent.reader, parent.descriptorHash, b, depth)
    assertParent(parent, original)
    const reference = mounted.find(root => root.namespace.kind === 'imported-bundle' && root.namespace.mountId === parent.mountId)!
    parents.push({ reference, original })
  }
  return parents
}
async function reopenedInput(readers: NodeReaders, side: QualifiedOriginalSide, binding: CoverageInputBinding, origin: OriginalSourceInput['origin'], context: Capsule2ReferenceContextDescriptor | null): Promise<OriginalSourceInput> {
  const profile = readers.profile, ref = binding.capsule, key = requiredDagCapsuleLocator(binding), previous = readers.sources.get(key)
  if (side.kind === 'durable-sql-v1') {
    if (previous) return ownInput(await readActualNoPriorOriginalInput(profile, previous as CertifiedDurableSqlCapsule))
    const actual = await captureReopenedCertifiedCapsuleNoPriorSourceInputs({ profileRoot: profile, operationId: ref.operationId, capsuleId: ref.capsuleId, expectedManifestHash: ref.manifestHash })
    readers.sources.set(key, actual.source)
    const value = actual.value, proof = { kind: 'no-prior-coverage-references' as const, version: 1 as const,
      databaseFilesHash: requiredDagDatabaseFilesHash(value.originalFiles), rawRequirementsHash: value.rawRequirementsHash }
    const capsule = validateCoverageCapsuleReference({ kind: 'restore-knowledge-origin-capsule-ref', version: 1, namespace: { kind: 'native' }, ...value.capsule })
    return { binding: { capsule, interpretationHash: requiredDagInterpretationHash(proof), rawRequirementsHash: value.rawRequirementsHash, requiredRoots: [] }, origin: proof,
      originalSqlBytes: value.originalFiles.reduce((n, file) => n + file.bytes, 0), managedOriginalBytes: 0,
      knowledge: { readerVersion: value.capsule.readerVersion, projection: actual.projection, projectionHash: knowledgePayloadHash(actual.projection), sourceMaterialHash: null, assetArchiveHash: null } }
  }
  if (side.kind === 'complete-capsule2') {
    if (previous) return ownInput(await readActualNoPriorOriginalInput(profile, previous as CertifiedCapsule2NoPriorSource))
    const captured = await captureReopenedCertifiedCapsule2Source({ profileRoot: profile, operationId: ref.operationId, capsuleId: ref.capsuleId, expectedCertificateHash: ref.manifestHash })
    readers.sources.set(key, captured.source)
    const value = captured.value, rawRequirementsHash = rawPriorCoverageRequirementsHash(value.priorCoverageRequirements)
    const proof = { kind: 'no-prior-coverage-references' as const, version: 1 as const, databaseFilesHash: requiredDagDatabaseFilesHash(value.sourceInventory), rawRequirementsHash }
    const capsule = validateCoverageCapsuleReference({ kind: 'restore-knowledge-origin-capsule-ref', version: 1, namespace: { kind: 'native' },
      operationId: ref.operationId, capsuleId: ref.capsuleId, manifestHash: captured.info.certificateHash, readerVersion: CAPSULE2_READER })
    return { binding: { capsule, interpretationHash: requiredDagInterpretationHash(proof), rawRequirementsHash, requiredRoots: [] }, origin: proof,
      originalSqlBytes: value.sourceInventory.reduce((n, file) => n + file.bytes, 0), managedOriginalBytes: value.assetArchive.tree.files.reduce((n, file) => n + file.bytes, 0),
      knowledge: { readerVersion: CAPSULE2_READER, projection: value.knowledge, projectionHash: value.knowledge.observationHash, sourceMaterialHash: value.materialHash, assetArchiveHash: value.assetArchiveHash } }
  }
  if (!context) return bad('bound来源缺完整context')
  const bound = parseCapsule2BoundSourceManifest(side.bindingText, ref.operationId, ref.capsuleId, ref.manifestHash)
  const source = previous ? await readSealedCapsule2SourceInputs(previous as SealedCapsule2Source)
    : await captureReopenedSealedCapsule2Source({ profileRoot: profile, operationId: ref.operationId, capsuleId: ref.capsuleId, expectedManifestHash: bound.sourceManifestHash })
  if (!previous && 'source' in source) readers.sources.set(key, source.source)
  const value = source.value
  if (bound.sourceMaterialHash !== value.materialHash || bound.sourceKnowledgeHash !== value.knowledge.observationHash
    || !same(context.requirements, value.priorCoverageRequirements) || context.source.rawRequirementsHash !== rawPriorCoverageRequirementsHash(value.priorCoverageRequirements))
    return bad('bound来源实际全量SQL/K/附件/四角色prior-C不等于原context')
  return { binding, origin, knowledge: { readerVersion: CAPSULE2_READER, projection: value.knowledge, projectionHash: value.knowledge.observationHash,
    sourceMaterialHash: value.materialHash, assetArchiveHash: value.assetArchiveHash },
    originalSqlBytes: value.sourceInventory.reduce((n, f) => n + f.bytes, 0), managedOriginalBytes: value.assetArchive.tree.files.reduce((n, f) => n + f.bytes, 0) }
}
async function walk(view: View, prefix: readonly string[], reader: CompleteOriginalPackage['reader'], hash: string, b: Budget, depth: number): Promise<CompleteOriginalRootData> {
  const text = await domainText(view, prefix), stateKey = capsuleJson(prefix)
  if (reader === 'prepared-mixed-v2') {
    const descriptor = parseMixedOriginBundleDescriptor(text)
    if (mixedOriginBundleHash(descriptor) !== hash) return bad('实际legacy父descriptor pin变化')
    const inventory = { files: mixedOriginBundleFiles(descriptor).map(file => ({ ...file, frame: [] })), directories: mixedOriginBundleDirectories(descriptor).map(path => ({ frame: [], path })) }
    domainInventory(view, prefix, inventory, text); charge(b, parseRequiredSqlDagNode(descriptor.nodeText), depth)
    let state = view.readers.get(stateKey)
    if (!state) { state = { profile: await verificationProfile(view, prefix, inventory.directories), sources: new Map() }; view.readers.set(stateKey, state) }
    const node = parseRequiredSqlDagNode(descriptor.nodeText), actual: OriginalSourceInput[] = []
    for (const [side, binding, origin] of [[descriptor.source, node.source, node.origins.source], [descriptor.current, node.current, node.origins.current]] as const) {
      const input = await reopenedInput(state, side, binding, origin, null)
      if (!same(input.binding, binding) || !same(input.origin, origin)) return bad('legacy实际来源与原node不同')
      actual.push(input)
    }
    const originalSqlBytes = actual.reduce((n, i) => n + i.originalSqlBytes, 0), managedOriginalBytes = actual.reduce((n, i) => n + i.managedOriginalBytes, 0)
    const inputs = actual.map(input => {
      if (input.origin.kind !== 'no-prior-coverage-references') return bad('legacy来源不能解释非空prior-C')
      return { capsule: input.binding.capsule, binding: input.binding, origin: input.origin, knowledge: input.knowledge }
    })
      .sort((a, z) => requiredDagCapsuleLocator(a.binding) < requiredDagCapsuleLocator(z.binding) ? -1 : 1)
    const body = { kind: 'actual-required-root-source-material' as const, version: 3 as const, scope: 'exact-first-generation-original-input-pair' as const,
      root: descriptor.root, node, inputs, originalSqlBytes, managedOriginalBytes, totalOriginalBytes: originalSqlBytes + managedOriginalBytes,
      preparedEvidence: true as const, fullRootInputSetProven: true as const, emptyKnowledgeProven: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
    if (Buffer.byteLength(capsuleJson(body)) > REFERENCE_CONTEXT_MAX_BYTES) return bad('legacy完整原材料超有限预算')
    const value = { ...body, materialHash: knowledgeHash('knowbook.knowledge.actual-required-root-material.v3', body) }
    const data = legacyData(descriptor, value)
    b.bytes += data.originalSqlBytes + data.managedOriginalBytes
    if (b.bytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES) return bad('实际完整原件全集超预算')
    return data
  }
  const descriptor = parseQualifiedOriginalDescriptor(text, hash), inventory = qualifiedOriginalInventory(descriptor), node = parseRequiredSqlDagNode(descriptor.nodeText)
  domainInventory(view, prefix, inventory, text); charge(b, node, depth)
  const sides = [qualifiedOriginalSide(descriptor.source, node.source, node.origins.source), qualifiedOriginalSide(descriptor.current, node.current, node.origins.current)]
  const parents: Array<CompleteOriginalRootData['parents'][number]> = []
  for (const side of sides) if (side.context) parents.push(...await contextParents(view, [...prefix, side.context.contextId], side.context, b, depth + 1))
  parents.sort((a, z) => requiredDagRootLocator(a.reference) < requiredDagRootLocator(z.reference) ? -1 : 1)
  if (!same(parents.map(p => p.reference), node.parents)) return bad('实际父原件全集与原node不相等')
  let state = view.readers.get(stateKey)
  if (!state) { state = { profile: await verificationProfile(view, prefix, inventory.directories), sources: new Map() }; view.readers.set(stateKey, state) }
  const inputs: OriginalSourceInput[] = []
  for (const [side, binding, origin] of [[sides[0], node.source, node.origins.source], [sides[1], node.current, node.origins.current]] as const) {
    const actual = await reopenedInput(state, side.value, binding, origin, side.context)
    if (!same(actual.binding, binding) || !same(actual.origin, origin)) return bad('实际来源input与原node不同')
    b.bytes += actual.originalSqlBytes + actual.managedOriginalBytes
    if (b.bytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES) return bad('实际完整来源字节超原预算')
    inputs.push(actual)
  }
  const counts = totals(inputs, parents, 1 + Math.max(0, ...parents.map(p => p.original.depth)))
  counts.nodeBytes = Buffer.byteLength(descriptor.nodeText) + parents.reduce((n, p) => n + p.original.nodeBytes, 0)
  const body = { root: descriptor.root, node, inputs, parents, ...counts, scope: 'complete-original-input-closure' as const,
    originalInputsComplete: true as const, semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > REFERENCE_CONTEXT_MAX_BYTES) return bad('实际完整递归来源材料超原有限预算，不截断')
  return freezeCapsuleValue({ ...body, materialHash: capsuleBytesHash('knowbook.complete-original-inputs.v1\0' + encoded) })
}
function viewFor(directory: string, profileRoot: string, descriptorText: string, inventory: Inventory, readers: ReaderState = new Map()): View {
  return { directory, profileRoot, descriptorText, files: [header(descriptorText), ...inventory.files], directories: inventory.directories, readers }
}
async function readDirectoryBytes(directory: string, profileRoot: string, hash?: string) {
  const root = await canonicalOriginCatalogRoot(directory), text = await readCapsule2AssetManifest(join(root, 'descriptor.json'), root)
  const descriptor = parseQualifiedOriginalDescriptor(text, hash), inventory = qualifiedOriginalInventory(descriptor), view = viewFor(root, profileRoot, text, inventory)
  await assertOriginalFrameDirectory(root, text, inventory.files)
  return { root, text, descriptor, inventory, view }
}
async function readDirectory(directory: string, profileRoot: string, hash?: string, readers: ReaderState = new Map()): Promise<CompleteOriginalPackage> {
  const { root, text, descriptor, inventory, view } = await readDirectoryBytes(directory, profileRoot, hash)
  view.readers = readers
  const actual = await walk(view, [], 'qualified-originals-v1', qualifiedOriginalDescriptorHash(descriptor), budget(), 1)
  await assertOriginalFrameDirectory(root, text, inventory.files)
  const result = packageFrom(view, 'qualified-originals-v1', qualifiedOriginalDescriptorHash(descriptor), actual)
  capturedReaders.set(result, readers); return result
}
/** Fixed Main byte bracket only. No SQL data or authority is returned. */
export async function assertCompleteOriginalPackageBytes(handle: CompleteOriginalBundle): Promise<void> {
  const entry = bundles.get(handle as QualifiedOriginalBundle)
  if (entry) { await readDirectoryBytes(entry.directory, entry.profileRoot, entry.hash); return }
  await assertPreparedMixedOriginBundleOriginalBytes(handle as PreparedMixedOriginBundle)
}
/** Fixed data reader for a context's complete independently copied originals.
 * It returns no authority handle and never interprets native refs via profile. */
export async function readReferenceContextOriginals(input: { profileRoot: string; directory: string; descriptor: Capsule2ReferenceContextDescriptor }) {
  const root = await canonicalOriginCatalogRoot(input.directory), text = capsuleJson(input.descriptor) + '\n'
  const files = input.descriptor.parents.flatMap(parent => parent.files.map(file => ({ ...file, frame: [parent.mountId, ...file.frame] })))
  const directories = input.descriptor.parents.flatMap(parent => parent.directories.map(dir => ({ ...dir, frame: [parent.mountId, ...dir.frame] })))
  const view = viewFor(root, input.profileRoot, text, { files, directories })
  await assertOriginalFrameDirectory(root, text, files)
  const parents = await contextParents(view, [], input.descriptor, budget(), 1)
  await assertOriginalFrameDirectory(root, text, files)
  return freezeCapsuleValue({ parents })
}
/** Registry dispatch precedes any property access. Both readers reconstruct
 * actual originals every time; diagnostics cannot stand in for a package. */
export async function readCompleteOriginalPackage(handle: CompleteOriginalBundle): Promise<CompleteOriginalPackage> {
  const entry = bundles.get(handle as QualifiedOriginalBundle)
  if (entry) return readDirectory(entry.directory, entry.profileRoot, entry.hash, entry.readers)
  const actual = await readPreparedMixedOriginBundleOriginalInputs(handle as PreparedMixedOriginBundle), value = actual.value
  const original = legacyData(actual.descriptor, { root: value.originalRoot, node: value.originalNode, materialHash: value.sourceMaterialHash,
    inputs: value.inputs, originalSqlBytes: value.originalSqlBytes, managedOriginalBytes: value.managedOriginalBytes })
  return freezeCapsuleValue({ reader: 'prepared-mixed-v2' as const, directory: actual.directory, descriptorText: capsuleJson(actual.descriptor) + '\n',
    descriptorHash: actual.descriptorHash, original, files: sorted(actual.files.map(file => ({ ...file, frame: [], sourceRoot: actual.profileRoot }))),
    directories: sorted(actual.directories.map(path => ({ frame: [], path }))) })
}
async function nativeInput(profileRoot: string, source: Source) {
  const bound = await tryReadBoundCapsule2OriginalInputs(profileRoot, source)
  if (bound) return { input: bound.input, side: bound.side, parentCopies: bound.parentCopies }
  const actual = await readActualNoPriorOriginalInput(profileRoot, source as CertifiedDurableSqlCapsule | CertifiedCapsule2NoPriorSource), ref = actual.binding.capsule
  const operation = join(profileRoot, 'backups', 'database-restore', ref.operationId)
  const text = (collection: string, leaf: string, max?: number) => readCapsule2AssetManifest(join(operation, collection, ref.capsuleId, leaf), profileRoot, max)
  const side: QualifiedOriginalSide = ref.readerVersion === 'knowbook-durable-sql-v1'
    ? { kind: 'durable-sql-v1', manifestText: await text('knowledge-capsules', 'manifest.json') }
    : { kind: 'complete-capsule2', certificateText: await text('knowledge-source-certificates-v2', 'certificate.json', CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES),
      sourceManifestText: await text('knowledge-source-capsules-v2', 'manifest.json'), assetManifestText: await text('knowledge-complete-assets-v2', 'manifest.json') }
  qualifiedOriginalSide(side, actual.binding, actual.origin)
  return { input: ownInput(actual), side, parentCopies: [] as OriginalFrameCopy[] }
}
async function pair(profileRoot: string, source: Source, current: Source) {
  const results = await Promise.allSettled([nativeInput(profileRoot, source), nativeInput(profileRoot, current)])
  if (results[0].status === 'rejected') throw results[0].reason
  if (results[1].status === 'rejected') throw results[1].reason
  return [results[0].value, results[1].value] as const
}
async function destination(profileRoot: string, operationId: string) {
  const mountId = randomUUID(), base = join(profileRoot, 'backups', 'database-restore', durableSqlDagUuid(operationId), 'qualified-original-bundles-v1')
  await restoreDirectory(base, profileRoot)
  return { mountId, directory: join(base, mountId), base }
}
function mint(entry: Saved): QualifiedOriginalBundle {
  const handle: QualifiedOriginalBundle = Object.freeze({ kind: 'qualified-original-input-bundle' }); bundles.set(handle, entry); return handle
}
/** Builds an independent physical input closure, including every actual C
 * reference domain. This is preparation only, not semantic coverage or install. */
export async function captureQualifiedOriginalBundle(input: { profileRoot: string; operationId: string; dagId: string; source: Source; current: Source }) {
  const row = capsuleRecord(input, ['profileRoot','operationId','dagId','source','current']), profileRoot = await canonicalRequiredSqlDagRoot(row.profileRoot)
  return buildOriginalBundle(profileRoot, row.operationId as string, row.dagId as string, [row.source as Source, row.current as Source],
    await pair(profileRoot, row.source as Source, row.current as Source))
}
/** One binding/root construction, accepting a genuine context instead of a
 * diagnostic packet. Shares only the full capture just made inside this call. */
export async function captureQualifiedOriginalBundleFromReferenceContext(input: { profileRoot: string; operationId: string; dagId: string; context: OwnedOriginalReferenceContext; current: Source }) {
  const row = capsuleRecord(input, ['profileRoot','operationId','dagId','context','current']), profileRoot = await canonicalRequiredSqlDagRoot(row.profileRoot)
  const results = await Promise.allSettled([captureBoundCapsule2OriginalInputs(row.context as OwnedOriginalReferenceContext), nativeInput(profileRoot, row.current as Source)] as const)
  if (results[0].status === 'rejected') throw results[0].reason
  if (results[1].status === 'rejected') throw results[1].reason
  const bound = results[0].value
  if (bound.initial.actual.profileRoot !== profileRoot) return bad('完整context不属于本次实际profile')
  const actual = await buildOriginalBundle(profileRoot, row.operationId as string, row.dagId as string, [bound.source, row.current as Source], [bound.initial, results[1].value])
  return Object.freeze({ ...actual, bound: bound.source })
}
/** One new source/context/binding/root preparation. Shares only actual inputs
 * captured inside this invocation, never a caller DTO or a cached K packet. */
export async function captureQualifiedOriginalBundleFromReferences(input: { profileRoot: string; operationId: string; dagId: string; source: SealedCapsule2Source; parents: readonly CompleteOriginalBundle[]; current: Source }) {
  const row = capsuleRecord(input, ['profileRoot','operationId','dagId','source','parents','current']), profileRoot = await canonicalRequiredSqlDagRoot(row.profileRoot)
  const results = await Promise.allSettled([captureBoundOriginalInputsFromReferences({ source: row.source as SealedCapsule2Source, parents: row.parents as readonly CompleteOriginalBundle[] }), nativeInput(profileRoot, row.current as Source)] as const)
  if (results[0].status === 'rejected') throw results[0].reason
  if (results[1].status === 'rejected') throw results[1].reason
  const bound = results[0].value
  if (bound.initial.actual.profileRoot !== profileRoot) return bad('完整source/context不属于本次实际profile')
  const actual = await buildOriginalBundle(profileRoot, row.operationId as string, row.dagId as string, [bound.source, row.current as Source], [bound.initial, results[1].value])
  return Object.freeze({ ...actual, bound: bound.source, context: bound.context, contextData: bound.contextData })
}
async function buildOriginalBundle(profileRoot: string, operationId: string, dagId: string, handles: readonly [Source, Source], initial: readonly [Awaited<ReturnType<typeof nativeInput>>, Awaited<ReturnType<typeof nativeInput>>]) {
  const source = initial[0].input, current = initial[1].input
  const node = validateRequiredSqlDagNode({ kind: 'restore-required-sql-knowledge-dag-node', version: 2, readerVersion: 'knowbook-required-sql-knowledge-dag-v2', material: 'durable-sql-only',
    source: source.binding, current: current.binding, origins: { source: source.origin, current: current.origin }, parents: requiredDagParentUnion(source.binding.requiredRoots, current.binding.requiredRoots) })
  const file = await writeRequiredSqlDagNodeFile(profileRoot, operationId, dagId, node)
  const descriptor = validateQualifiedOriginalDescriptor({ kind: 'restore-qualified-original-inputs', version: 1, root: file.ref, nodeText: capsuleJson(node),
    source: initial[0].side, current: initial[1].side, acceptedCoverage: false, effective: false, permit: false })
  const inventory = qualifiedOriginalInventory(descriptor), own = inventory.files.filter(file => !file.frame.length).map(file => ({ ...file, sourceRoot: profileRoot,
    sourcePath: originCatalogLocalPath(profileRoot, file.path.slice('catalog/'.length)) }))
  const files = [...own, ...initial.flatMap(side => side.parentCopies)]
  if (!same(sorted(files.map(({ frame, path, bytes, sha256 }) => ({ frame, path, bytes, sha256 }))), inventory.files)) return bad('实际来源提供的文件不是完整qualified inventory')
  const target = await destination(profileRoot, operationId), text = capsuleJson(descriptor) + '\n'
  await writeOriginalFrameDirectory({ profileRoot, directory: target.directory, descriptorText: text, files })
  for (const [source, before] of [[handles[0], initial[0]], [handles[1], initial[1]]] as const) {
    if (!await tryAssertBoundCapsule2OriginalBytes(profileRoot, source)) {
      const last = await nativeInput(profileRoot, source)
      if (!same({ input: before.input, side: before.side }, { input: last.input, side: last.side })) return bad('实际完整来源在复制期间变化')
    }
  }
  await syncOriginCatalogAncestors(target.base, profileRoot)
  const hash = qualifiedOriginalDescriptorHash(descriptor), actual = await readDirectory(target.directory, profileRoot, hash)
  return Object.freeze({ bundle: mint({ profileRoot, operationId, mountId: target.mountId, directory: target.directory, hash, readers: capturedReaders.get(actual)! }), value: actual.original,
    directory: target.directory, mountId: target.mountId, descriptorHash: hash, originalPackage: actual })
}
export async function importQualifiedOriginalBundle(input: { profileRoot: string; operationId: string; sourceDirectory: string; expectedDescriptorHash: string }) {
  const copied = await prepareQualifiedOriginalImport(input)
  const actual = await captureReopenedQualifiedOriginalBundle({ profileRoot: copied.profileRoot, operationId: copied.operationId,
    mountId: copied.mountId, expectedDescriptorHash: copied.descriptorHash })
  return Object.freeze({ ...actual, directory: copied.directory, mountId: copied.mountId, descriptorHash: copied.descriptorHash })
}
/** Complete durable byte copy only. This deliberately has no bundle handle or
 * K/material value. A new process can subsequently run the real cold reader. */
export async function prepareQualifiedOriginalImport(input: Parameters<typeof importQualifiedOriginalBundle>[0]) {
  const row = capsuleRecord(input, ['profileRoot','operationId','sourceDirectory','expectedDescriptorHash']), profileRoot = await canonicalRequiredSqlDagRoot(row.profileRoot), hash = durableSqlDagHash(row.expectedDescriptorHash)
  // Incoming metadata never authorizes SQL. Validate/copy the entire bounded
  // original tree, then run all fixed actual readers on the independent copy.
  const source = await readDirectoryBytes(row.sourceDirectory as string, profileRoot, hash), target = await destination(profileRoot, row.operationId as string)
  const files = source.inventory.files.map(file => ({ ...file, sourceRoot: source.root, sourcePath: viewPath(source.view, file) }))
  await writeOriginalFrameDirectory({ profileRoot, directory: target.directory, descriptorText: source.text, files })
  await readDirectoryBytes(source.root, profileRoot, hash); await syncOriginCatalogAncestors(target.base, profileRoot)
  await readDirectoryBytes(target.directory, profileRoot, hash)
  return freezeCapsuleValue({ profileRoot, operationId: row.operationId as string, directory: target.directory, mountId: target.mountId, descriptorHash: hash,
    files: files.map(file => ({ ...file, sourceRoot: target.directory, sourcePath: originCatalogLocalPath(target.directory, referenceContextObjectPath(file.frame, file.path)) })),
    scope: 'copied-original-bytes-only' as const, semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const })
}
export async function reopenQualifiedOriginalBundle(input: { profileRoot: string; operationId: string; mountId: string; expectedDescriptorHash: string }) {
  return (await captureReopenedQualifiedOriginalBundle(input)).bundle
}
/** Only this cold reopen's just-completed full actual read can supply its
 * initial data. Later reads still traverse every original and SQL again. */
export async function captureReopenedQualifiedOriginalBundle(input: Parameters<typeof reopenQualifiedOriginalBundle>[0]) {
  const row = capsuleRecord(input, ['profileRoot','operationId','mountId','expectedDescriptorHash']), profileRoot = await canonicalRequiredSqlDagRoot(row.profileRoot)
  const operationId = durableSqlDagUuid(row.operationId), mountId = durableSqlDagUuid(row.mountId), hash = durableSqlDagHash(row.expectedDescriptorHash)
  const directory = join(profileRoot, 'backups', 'database-restore', operationId, 'qualified-original-bundles-v1', mountId)
  const actual = await readDirectory(directory, profileRoot, hash)
  return Object.freeze({ bundle: mint({ profileRoot, operationId, mountId, directory, hash, readers: capturedReaders.get(actual)! }), value: actual.original, originalPackage: actual })
}
