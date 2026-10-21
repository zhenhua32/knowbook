import { relative, sep } from 'node:path'
import { capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { captureCertifiedCapsulePriorCoverage, readCertifiedCapsulePriorCoverage,
  readCertifiedDurableSqlCapsule, reopenCertifiedDurableSqlCapsule,
  type CertifiedCapsulePriorCoverage, type CertifiedDurableSqlCapsule, type UnresolvedCertifiedCapsulePriorCoverage } from './restore-knowledge-capsule-read'
import { validateCoverageCapsuleReference, validateCoverageRootReference,
  type CoverageInputBinding, type CoverageRootReference } from './restore-knowledge-coverage-model'
import { DURABLE_SQL_DAG_MAX_CAPSULES, DURABLE_SQL_DAG_MAX_NODES, DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES,
  DURABLE_SQL_DAG_MAX_TOTAL_NODE_BYTES } from './restore-knowledge-dag-model'
import { canonicalRequiredSqlDagRoot, readRequiredSqlDagNodeFile, writeRequiredSqlDagNodeFile,
  type RequiredSqlDagNodeFile } from './restore-knowledge-required-dag-files'
import { requiredDagCapsuleLocator, requiredDagDatabaseFilesHash, requiredDagInterpretationHash, requiredDagInvalid,
  requiredDagParentUnion, validateRequiredSqlDagNode, type RequiredDagNoPriorOrigin, type RequiredSqlDagNode } from './restore-knowledge-required-dag-model'

/** Real SQL-required prepared graph identity. Never an accepted/live context. */
export interface CertifiedRequiredSqlDag { readonly kind: 'certified-required-sql-dag' }
export interface CaptureFirstRequiredSqlDagInput {
  readonly profileRoot: string; readonly operationId: string; readonly dagId: string
  readonly source: CertifiedDurableSqlCapsule; readonly current: CertifiedDurableSqlCapsule
}
export interface ReopenFirstRequiredSqlDagInput {
  readonly profileRoot: string; readonly operationId: string; readonly dagId: string; readonly expectedRootHash: string
}
type Input = { capsule: CertifiedDurableSqlCapsule; captured: CertifiedCapsulePriorCoverage
  binding: CoverageInputBinding; origin: RequiredDagNoPriorOrigin; originalBytes: number }
type Saved = { profileRoot: string; file: RequiredSqlDagNodeFile; inputs: Map<string, Input>; totalOriginalBytes: number }
const certifiedRequired = new WeakMap<CertifiedRequiredSqlDag, Saved>()

/** Fixed first-generation pair only. Each started read, including its own
 * scratch/FD finally, settles before ordered failure escapes. No phase overlaps
 * the next phase, and the private input/result order is retained. */
async function settledRequiredInputMap<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<Awaited<R>[]> {
  const values: Awaited<R>[] = []
  for (let from = 0; from < items.length; from += 2) {
    const results = await Promise.allSettled(items.slice(from, from + 2).map(item => Promise.resolve().then(() => read(item))))
    for (let offset = 0; offset < results.length; offset++) {
      const result = results[offset]
      if (result.status === 'rejected') throw result.reason
      values[from + offset] = result.value
    }
  }
  return values
}

function firstBinding(value: UnresolvedCertifiedCapsulePriorCoverage): { binding: CoverageInputBinding; origin: RequiredDagNoPriorOrigin; originalBytes: number } {
  if (value.requirements.entries.length) return requiredDagInvalid('实际SQL要求非空：需完整coverage-v2/bundle owner，不能省略或降empty')
  const origin: RequiredDagNoPriorOrigin = { kind: 'no-prior-coverage-references', version: 1,
    databaseFilesHash: requiredDagDatabaseFilesHash(value.originalFiles), rawRequirementsHash: value.rawRequirementsHash }
  // This states only that the actual SQL has no prior-C relative roots to
  // interpret. It never identifies the source original domain as this profile.
  return { binding: { capsule: validateCoverageCapsuleReference({ kind: 'restore-knowledge-origin-capsule-ref', version: 1,
    namespace: { kind: 'native' }, ...value.capsule }), interpretationHash: requiredDagInterpretationHash(origin),
    rawRequirementsHash: value.rawRequirementsHash, requiredRoots: [] }, origin,
    originalBytes: value.originalFiles.reduce((sum, file) => sum + file.bytes, 0) }
}
async function originalInput(profileRoot: string, capsule: CertifiedDurableSqlCapsule): Promise<Input> {
  const captured = await captureCertifiedCapsulePriorCoverage(capsule), value = await readCertifiedCapsulePriorCoverage(captured)
  const seal = await readCertifiedDurableSqlCapsule(capsule), parts = relative(profileRoot, seal.manifestPath).split(sep)
  if (seal.manifest.version !== 1 || seal.manifest.readerVersion !== 'knowbook-durable-sql-v1'
    || parts.length !== 6 || parts[0] !== 'backups' || parts[1] !== 'database-restore' || parts[3] !== 'knowledge-capsules' || parts[5] !== 'manifest.json'
    || parts[2] !== value.capsule.operationId || parts[4] !== value.capsule.capsuleId || seal.manifestHash !== value.capsule.manifestHash)
    return requiredDagInvalid('首次producer只能使用本Main固定原件；foreign须真实importer，不能借同UUID路径')
  return { capsule, captured, ...firstBinding(value) }
}
function nodeFrom(source: Input, current: Input): RequiredSqlDagNode {
  return validateRequiredSqlDagNode({ kind: 'restore-required-sql-knowledge-dag-node', version: 2,
    readerVersion: 'knowbook-required-sql-knowledge-dag-v2', material: 'durable-sql-only',
    source: source.binding, current: current.binding, origins: { source: source.origin, current: current.origin },
    parents: requiredDagParentUnion(source.binding.requiredRoots, current.binding.requiredRoots) })
}
function completeInputs(source: Input, current: Input): { inputs: Map<string, Input>; totalOriginalBytes: number } {
  const inputs = new Map<string, Input>()
  for (const item of [source, current]) {
    const key = requiredDagCapsuleLocator(item.binding), previous = inputs.get(key)
    if (previous) return requiredDagInvalid('source/current实际原件locator重复；不能复用一侧冒充另一侧')
    inputs.set(key, item)
  }
  const totalOriginalBytes = [...inputs.values()].reduce((sum, item) => sum + item.originalBytes, 0)
  if (inputs.size > DURABLE_SQL_DAG_MAX_CAPSULES || !Number.isSafeInteger(totalOriginalBytes) || totalOriginalBytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES)
    return requiredDagInvalid('完整原件集合超原DAG预算；不能截断')
  return { inputs, totalOriginalBytes }
}
async function assertActualInputs(entry: Saved): Promise<void> {
  const originals = await settledRequiredInputMap([...entry.inputs.values()], async item => {
    const current = await readCertifiedCapsulePriorCoverage(item.captured), actual = firstBinding(current)
    if (capsuleJson(actual.binding) !== capsuleJson(item.binding) || capsuleJson(actual.origin) !== capsuleJson(item.origin)
      || actual.originalBytes !== item.originalBytes) return requiredDagInvalid('真实原SQL要求/原件身份变化')
    return item
  })
  if (originals.length !== 2 || capsuleJson(nodeFrom(originals[0], originals[1])) !== capsuleJson(entry.file.node)
    || completeInputs(originals[0], originals[1]).totalOriginalBytes !== entry.totalOriginalBytes) return requiredDagInvalid('私有完整两侧原件集合不闭合')
}
async function fresh(entry: Saved): Promise<void> {
  const first = await readRequiredSqlDagNodeFile(entry.profileRoot, entry.file.ref)
  if (capsuleJson(first.node) !== capsuleJson(entry.file.node)) return requiredDagInvalid('真实node被替换')
  await assertActualInputs(entry)
  const last = await readRequiredSqlDagNodeFile(entry.profileRoot, entry.file.ref)
  if (capsuleJson(last.node) !== capsuleJson(entry.file.node)) return requiredDagInvalid('读取原件期间node被替换')
}
function register(entry: Saved): CertifiedRequiredSqlDag {
  if (1 > DURABLE_SQL_DAG_MAX_NODES || entry.file.bytes > DURABLE_SQL_DAG_MAX_TOTAL_NODE_BYTES) return requiredDagInvalid('完整首代node超预算')
  const handle: CertifiedRequiredSqlDag = Object.freeze({ kind: 'certified-required-sql-dag' })
  certifiedRequired.set(handle, entry)
  return handle
}
/** No parents/origin/loader input: fixed SQL scans derive the complete first
 * generation parent set. Nonempty historical knowledge is fully allowed. */
export async function captureFirstRequiredSqlDag(input: CaptureFirstRequiredSqlDagInput): Promise<CertifiedRequiredSqlDag> {
  const row = capsuleRecord(input, ['profileRoot', 'operationId', 'dagId', 'source', 'current'])
  const profileRoot = await canonicalRequiredSqlDagRoot(row.profileRoot)
  const results = await Promise.allSettled([originalInput(profileRoot, row.source as CertifiedDurableSqlCapsule),
    originalInput(profileRoot, row.current as CertifiedDurableSqlCapsule)] as const)
  if (results[0].status === 'rejected') throw results[0].reason
  if (results[1].status === 'rejected') throw results[1].reason
  const source = results[0].value, current = results[1].value, complete = completeInputs(source, current), node = nodeFrom(source, current)
  const file = await writeRequiredSqlDagNodeFile(profileRoot, row.operationId as string, row.dagId as string, node)
  const entry: Saved = { profileRoot, file, ...complete }
  await fresh(entry)
  return register(entry)
}
/** Persisted first generation is never rewritten. Both real capsule V1 SQL
 * certifiers and fresh SQL requirements captures rerun before private mint. */
export async function reopenFirstRequiredSqlDag(input: ReopenFirstRequiredSqlDagInput): Promise<CertifiedRequiredSqlDag> {
  const row = capsuleRecord(input, ['profileRoot', 'operationId', 'dagId', 'expectedRootHash'])
  const profileRoot = await canonicalRequiredSqlDagRoot(row.profileRoot), ref = validateCoverageRootReference({ kind: 'restore-knowledge-origin-root-ref', version: 1,
    namespace: { kind: 'native' }, operationId: row.operationId, dagId: row.dagId, rootHash: row.expectedRootHash,
    readerVersion: 'knowbook-required-sql-knowledge-dag-v2' })
  const file = await readRequiredSqlDagNodeFile(profileRoot, ref), node = file.node
  if (node.parents.length || node.origins.source.kind !== 'no-prior-coverage-references' || node.origins.current.kind !== 'no-prior-coverage-references')
    return requiredDagInvalid('非首代要求闭包尚缺固定完整bundle/capsule-v2 owner；不当作empty')
  const reopen = async (binding: CoverageInputBinding): Promise<Input> => {
    const capsule = binding.capsule
    if (capsule.namespace.kind !== 'native' || capsule.readerVersion !== 'knowbook-durable-sql-v1') return requiredDagInvalid('无真实importer时不按本机解释foreign/capsule-v2')
    return originalInput(profileRoot, await reopenCertifiedDurableSqlCapsule({ profileRoot, operationId: capsule.operationId,
      capsuleId: capsule.capsuleId, expectedManifestHash: capsule.manifestHash }))
  }
  const results = await Promise.allSettled([reopen(node.source), reopen(node.current)] as const)
  if (results[0].status === 'rejected') throw results[0].reason
  if (results[1].status === 'rejected') throw results[1].reason
  const source = results[0].value, current = results[1].value
  if (capsuleJson(nodeFrom(source, current)) !== capsuleJson(node)) return requiredDagInvalid('两实际SQL重建不等于完整持久node')
  const entry: Saved = { profileRoot, file, ...completeInputs(source, current) }
  await fresh(entry)
  return register(entry)
}
export async function readCertifiedRequiredSqlDag(handle: CertifiedRequiredSqlDag) {
  const entry = certifiedRequired.get(handle)
  if (!entry) return requiredDagInvalid('不是Main真实SQL要求驱动DAG私有句柄')
  await fresh(entry)
  return freezeCapsuleValue({ kind: 'required-sql-knowledge-dag-diagnostic' as const, version: 2 as const,
    root: entry.file.ref, node: entry.file.node, capsules: [...entry.inputs.values()].map(item => item.binding.capsule),
    nodes: 1, height: 1, totalNodeBytes: entry.file.bytes, totalOriginalBytes: entry.totalOriginalBytes,
    preparedEvidence: true as const, emptyKnowledgeProven: false as const, acceptedCoverage: false as const })
}

import { extractCertifiedDurableSqlCapsuleKnowledge, readCertifiedCapsuleKnowledge, readCertifiedDurableSqlCapsuleNow,
  type CertifiedCapsuleKnowledge } from './restore-knowledge-capsule-read'
import { unionCertifiedCapsuleKnowledge, readCertifiedKnowledgeUnion, type CertifiedKnowledgeUnion } from './restore-knowledge-payload-read'
import { knowledgeHash, type KnowledgeCapsuleRef, type KnowledgeUnionDiagnostic } from './restore-knowledge-payload-model'
import type { CoverageCapsuleReference } from './restore-knowledge-coverage-model'
import type { DurableSqlCapsuleSeal } from './restore-knowledge-capsule-files'
import { assertRequiredSqlDagNodeFileNow } from './restore-knowledge-required-dag-files'

/** Separate from the original prepared-v1 RootKnowledgeMaterial registry. This
 * identity certifies complete prepared v2 material, never current-effective K. */
export interface RequiredRootKnowledgeMaterial { readonly kind: 'required-root-bound-knowledge-material' }
export interface RequiredRootCapsuleBinding {
  readonly capsule: CoverageCapsuleReference; readonly binding: CoverageInputBinding; readonly origin: RequiredDagNoPriorOrigin
}
type RequiredMaterial = { dag: CertifiedRequiredSqlDag; root: CoverageRootReference; node: RequiredSqlDagNode
  capsuleBindings: readonly RequiredRootCapsuleBinding[]; union: CertifiedKnowledgeUnion
  diagnostic: KnowledgeUnionDiagnostic; materialHash: string }
const requiredRootMaterials = new WeakMap<RequiredRootKnowledgeMaterial, RequiredMaterial>()

function requiredBareCapsule(ref: CoverageCapsuleReference): KnowledgeCapsuleRef {
  if (ref.namespace.kind !== 'native' || ref.readerVersion !== 'knowbook-durable-sql-v1')
    return requiredDagInvalid('typed K尚缺bundle/capsule2来源适配；不能抹namespace借v1 union')
  return { kind: 'durable-sql-capsule-ref', version: 1, operationId: ref.operationId, capsuleId: ref.capsuleId, manifestHash: ref.manifestHash }
}
/** No caller input. Every source is the actual owner's whole private map. */
function requiredMaterialBindings(entry: Saved): readonly RequiredRootCapsuleBinding[] {
  const records: RequiredRootCapsuleBinding[] = []
  for (const input of entry.inputs.values()) records.push({ capsule: structuredClone(input.binding.capsule),
    binding: structuredClone(input.binding), origin: structuredClone(input.origin) })
  records.sort((a, b) => requiredDagCapsuleLocator(a.binding) < requiredDagCapsuleLocator(b.binding) ? -1 : requiredDagCapsuleLocator(a.binding) > requiredDagCapsuleLocator(b.binding) ? 1 : 0)
  return freezeCapsuleValue(records)
}
function assertRequiredSavedStructure(entry: Saved): void {
  // The previous owner only registers this exact first generation. An actual
  // future DFS must provide its full node map, not be silently treated as one.
  if (entry.file.node.parents.length) return requiredDagInvalid('同步/typed material尚缺非首代完整node闭包owner，不能省父节点')
  const records = [...entry.inputs.values()]
  if (records.length !== 2 || capsuleJson(nodeFrom(records[0], records[1])) !== capsuleJson(entry.file.node)
    || completeInputs(records[0], records[1]).totalOriginalBytes !== entry.totalOriginalBytes)
    return requiredDagInvalid('私有v2完整输入/原分配不闭合')
}
function assertRequiredUnion(bindings: readonly RequiredRootCapsuleBinding[], diagnostic: KnowledgeUnionDiagnostic): void {
  const expected = bindings.map(record => requiredBareCapsule(record.capsule)).sort((a, b) => capsuleJson(a) < capsuleJson(b) ? -1 : capsuleJson(a) > capsuleJson(b) ? 1 : 0)
  const actual = diagnostic.payloads.map(payload => payload.capsule).sort((a, b) => capsuleJson(a) < capsuleJson(b) ? -1 : capsuleJson(a) > capsuleJson(b) ? 1 : 0)
  if (capsuleJson(expected) !== capsuleJson(actual)) return requiredDagInvalid('K union省略/替换准确v2全capsule集合')
}
function requiredMaterialHash(root: CoverageRootReference, node: RequiredSqlDagNode,
  capsuleBindings: readonly RequiredRootCapsuleBinding[], union: KnowledgeUnionDiagnostic): string {
  return knowledgeHash('knowbook.required-root-knowledge-material.v2', { root, node, capsuleBindings, union })
}
function requiredMaterialEntry(handle: RequiredRootKnowledgeMaterial): { material: RequiredMaterial; entry: Saved } {
  const material = requiredRootMaterials.get(handle)
  if (!material) return requiredDagInvalid('不是Main完整required-v2 RootMaterial私有句柄')
  const entry = certifiedRequired.get(material.dag)
  if (!entry) return requiredDagInvalid('required-v2 material丢失真实DAG owner')
  assertRequiredSavedStructure(entry)
  if (capsuleJson(material.root) !== capsuleJson(entry.file.ref) || capsuleJson(material.node) !== capsuleJson(entry.file.node)
    || capsuleJson(material.capsuleBindings) !== capsuleJson(requiredMaterialBindings(entry))) return requiredDagInvalid('v2 material准确root/binding/origin/全集变化')
  assertRequiredUnion(material.capsuleBindings, material.diagnostic)
  if (requiredMaterialHash(material.root, material.node, material.capsuleBindings, material.diagnostic) !== material.materialHash)
    return requiredDagInvalid('v2 material私有完整typed原像变化')
  return { material, entry }
}

/** The only material factory takes one genuine whole required-DAG handle. It
 * cannot take a generic payload array/union, refs DTO or caller-selected subset. */
export async function extractRequiredRootKnowledgeMaterial(handle: CertifiedRequiredSqlDag): Promise<RequiredRootKnowledgeMaterial> {
  const entry = certifiedRequired.get(handle)
  if (!entry) return requiredDagInvalid('v2 K提取不是Main完整真实required-DAG句柄')
  assertRequiredSavedStructure(entry)
  await fresh(entry)
  const capsuleBindings = requiredMaterialBindings(entry)
  const inputs: CertifiedCapsuleKnowledge[] = await settledRequiredInputMap([...entry.inputs.values()], async input => {
    const captured = await extractCertifiedDurableSqlCapsuleKnowledge(input.capsule), payload = await readCertifiedCapsuleKnowledge(captured)
    if (capsuleJson(payload.capsule) !== capsuleJson(requiredBareCapsule(input.binding.capsule))) return requiredDagInvalid('typed payload不属于真实qualified v2原件')
    return captured
  })
  const union = await unionCertifiedCapsuleKnowledge(inputs), diagnostic = await readCertifiedKnowledgeUnion(union)
  assertRequiredUnion(capsuleBindings, diagnostic)
  await fresh(entry)
  const root = entry.file.ref, node = entry.file.node, materialHash = requiredMaterialHash(root, node, capsuleBindings, diagnostic)
  const material: RequiredRootKnowledgeMaterial = Object.freeze({ kind: 'required-root-bound-knowledge-material' })
  requiredRootMaterials.set(material, { dag: handle, root, node, capsuleBindings, union, diagnostic, materialHash })
  return material
}
/** Full prepared typed data, Main-internal. Diagnostics below expose counts.
 * Immutable parsed facts are reused; all real artifacts are still freshly read. */
export async function readRequiredRootKnowledgeMaterial(handle: RequiredRootKnowledgeMaterial) {
  const { material, entry } = requiredMaterialEntry(handle)
  await fresh(entry)
  const diagnostic = await readCertifiedKnowledgeUnion(material.union)
  assertRequiredUnion(material.capsuleBindings, diagnostic)
  if (requiredMaterialHash(material.root, material.node, material.capsuleBindings, diagnostic) !== material.materialHash)
    return requiredDagInvalid('v2完整K union原像变化')
  await fresh(entry)
  return freezeCapsuleValue({ kind: 'required-root-knowledge-material-data' as const, version: 2 as const,
    root: material.root, node: material.node, capsuleBindings: material.capsuleBindings, materialHash: material.materialHash,
    union: diagnostic, preparedEvidence: true as const, acceptedCoverage: false as const, emptyKnowledgeProven: false as const })
}
export async function diagnoseRequiredRootKnowledgeMaterial(handle: RequiredRootKnowledgeMaterial) {
  const value = await readRequiredRootKnowledgeMaterial(handle)
  return freezeCapsuleValue({ kind: 'required-root-knowledge-material-summary' as const, version: 2 as const,
    root: value.root, materialHash: value.materialHash, capsules: value.capsuleBindings.length,
    groups: value.union.groups.length, permanentDenials: value.union.permanentDenials.length,
    exposureRecords: value.union.exposures.length, observations: value.union.observations.length,
    preparedEvidence: true as const, acceptedCoverage: false as const, permit: false as const })
}
function assertRequiredCapsuleSeal(entry: Saved, input: Input, seal: DurableSqlCapsuleSeal): void {
  const ref = input.binding.capsule, parts = relative(entry.profileRoot, seal.manifestPath).split(sep)
  if (ref.namespace.kind !== 'native' || ref.readerVersion !== 'knowbook-durable-sql-v1'
    || seal.manifest.version !== 1 || seal.manifest.readerVersion !== 'knowbook-durable-sql-v1' || seal.manifest.material !== 'durable-sql-only'
    || parts.length !== 6 || parts[0] !== 'backups' || parts[1] !== 'database-restore' || parts[3] !== 'knowledge-capsules' || parts[5] !== 'manifest.json'
    || parts[2] !== ref.operationId || parts[4] !== ref.capsuleId || seal.manifestHash !== ref.manifestHash
    || requiredDagDatabaseFilesHash(seal.manifest.files) !== input.origin.databaseFilesHash
    || seal.manifest.files.reduce((sum, file) => sum + file.bytes, 0) !== input.originalBytes
    || requiredDagInterpretationHash(input.origin) !== input.binding.interpretationHash)
    return requiredDagInvalid('同步v2 witness真实capsule/DBbytes/origin绑定变化')
}
/** No await/current SQL/frame/permit/cache. Its entire artifact closure comes
 * from this v2 owner's private maps, never the old v1 material registry. */
export function assertRequiredRootKnowledgeArtifactsFreshNow(handle: RequiredRootKnowledgeMaterial): void {
  const { entry } = requiredMaterialEntry(handle)
  assertRequiredSqlDagNodeFileNow(entry.profileRoot, entry.file)
  for (const input of entry.inputs.values()) assertRequiredCapsuleSeal(entry, input, readCertifiedDurableSqlCapsuleNow(input.capsule))
  assertRequiredSqlDagNodeFileNow(entry.profileRoot, entry.file)
}

// Fixed bundle source seam. This module never imports bundle FS/read owners.
import { originBundleExpectedFiles, originBundleNodePath, originBundleDescriptorHash, validateFirstOriginBundleDescriptor,
  type FirstOriginBundleDescriptor } from './restore-knowledge-origin-bundle-model'

export interface OwnedRequiredRootBundleSource { readonly kind: 'owned-required-root-bundle-source' }
const requiredBundleSources = new WeakMap<OwnedRequiredRootBundleSource, RequiredRootKnowledgeMaterial>()
/** Caller-selected paths/maps/namespace claims cannot mint this source. */
export async function captureRequiredRootBundleSource(material: RequiredRootKnowledgeMaterial): Promise<OwnedRequiredRootBundleSource> {
  await readRequiredRootKnowledgeMaterial(material)
  const handle: OwnedRequiredRootBundleSource = Object.freeze({ kind: 'owned-required-root-bundle-source' })
  requiredBundleSources.set(handle, material)
  return handle
}
/** Only file data, never a permit. The exporter accepts the private source
 * identity above and reruns this fixed full-map read before/after copying. */
export async function readRequiredRootBundleSource(handle: OwnedRequiredRootBundleSource) {
  const material = requiredBundleSources.get(handle)
  if (!material) return requiredDagInvalid('不是完整真实required material的bundle source私有句柄')
  const value = await readRequiredRootKnowledgeMaterial(material), { entry } = requiredMaterialEntry(material)
  const source = entry.inputs.get(requiredDagCapsuleLocator(entry.file.node.source)), current = entry.inputs.get(requiredDagCapsuleLocator(entry.file.node.current))
  if (!source || !current || entry.inputs.size !== 2) return requiredDagInvalid('bundle source缺完整原件闭包')
  const sourceSeal = await readCertifiedDurableSqlCapsule(source.capsule), currentSeal = await readCertifiedDurableSqlCapsule(current.capsule)
  const descriptor: FirstOriginBundleDescriptor = validateFirstOriginBundleDescriptor({ kind: 'restore-prepared-first-origin-bundle', version: 1,
    readerVersion: 'knowbook-prepared-origin-bundle-v1', material: 'durable-sql-only', root: value.root, nodeText: capsuleJson(value.node),
    sourceManifestText: capsuleJson(sourceSeal.manifest), currentManifestText: capsuleJson(currentSeal.manifest) })
  const files = originBundleExpectedFiles(descriptor).map(file => ({ ...file,
    sourcePath: file.path === originBundleNodePath(value.root) ? entry.file.path
      : entry.profileRoot + sep + file.path.slice('catalog/'.length).split('/').join(sep) }))
  await fresh(entry)
  return freezeCapsuleValue({ profileRoot: entry.profileRoot, descriptor, descriptorHash: originBundleDescriptorHash(descriptor), files })
}

// Whole qualified projection source seam. Authority stays in the existing
// required material/DAG WeakMaps; no caller DTO/ref/list can register a source.
import { knowledgePayloadHash, type CapsuleKnowledgePayload } from './restore-knowledge-payload-model'
import type { DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'

export interface OwnedRequiredKnowledgeSource { readonly kind: 'owned-required-whole-knowledge-source' }
export interface OwnedRequiredKnowledgeInput {
  readonly role: 'source' | 'current'; readonly locator: string
  readonly capsule: CoverageCapsuleReference; readonly binding: CoverageInputBinding; readonly origin: RequiredDagNoPriorOrigin
  readonly manifestText: string; readonly originalFiles: readonly DurableSqlCapsuleFile[]
  readonly projection: CapsuleKnowledgePayload; readonly projectionHash: string
}
export interface OwnedRequiredKnowledgeData {
  readonly kind: 'owned-required-whole-knowledge-data'; readonly version: 1
  readonly root: CoverageRootReference; readonly nodeText: string; readonly sourceMaterialHash: string
  readonly inputs: readonly OwnedRequiredKnowledgeInput[]
  readonly preparedEvidence: true; readonly acceptedCoverage: false; readonly effective: false; readonly permit: false
}
type RequiredKnowledgeSourceEntry = { material: RequiredRootKnowledgeMaterial; value: OwnedRequiredKnowledgeData
  captured: readonly { locator: string; knowledge: CertifiedCapsuleKnowledge }[] }
const requiredKnowledgeSources = new WeakMap<OwnedRequiredKnowledgeSource, RequiredKnowledgeSourceEntry>()

/** This is the entire actual Saved map, not the public diagnostic input count.
 * Locator uniqueness is meaningful only inside this genuine required owner. */
function wholeRequiredKnowledgeInputs(entry: Saved): readonly { locator: string; input: Input; role: 'source' | 'current' }[] {
  assertRequiredSavedStructure(entry)
  const sourceKey = requiredDagCapsuleLocator(entry.file.node.source), currentKey = requiredDagCapsuleLocator(entry.file.node.current)
  if (sourceKey === currentKey) return requiredDagInvalid('whole source两个原角色复用locator')
  const values: { locator: string; input: Input; role: 'source' | 'current' }[] = []
  for (const [locator, input] of entry.inputs) {
    if (locator !== requiredDagCapsuleLocator(input.binding) || input.binding.capsule.namespace.kind !== 'native'
      || input.binding.capsule.readerVersion !== 'knowbook-durable-sql-v1') return requiredDagInvalid('whole source私有Map key/原v1 ref不闭合')
    const role = locator === sourceKey ? 'source' : locator === currentKey ? 'current' : requiredDagInvalid('whole source有原node之外输入')
    if (capsuleJson(input.binding) !== capsuleJson(entry.file.node[role]) || capsuleJson(input.origin) !== capsuleJson(entry.file.node.origins[role])
      || input.origin.rawRequirementsHash !== input.binding.rawRequirementsHash
      || requiredDagInterpretationHash(input.origin) !== input.binding.interpretationHash)
      return requiredDagInvalid('whole source完整原binding/origin与角色变化')
    values.push({ locator, input, role })
  }
  values.sort((a, b) => a.locator < b.locator ? -1 : a.locator > b.locator ? 1 : 0)
  if (values.length !== 2 || new Set(values.map(value => value.locator)).size !== 2
    || !values.some(value => value.role === 'source') || !values.some(value => value.role === 'current'))
    return requiredDagInvalid('whole source不是准确首代全Map')
  return values
}
/** The existing material read retains both of its artifact freshness rounds.
 * Separate actual seals bind each DB/WAL/SHM inventory; the enclosing fixed
 * capture/read phase performs the final fresh after its new K reads. */
async function readWholeRequiredKnowledgeData(material: RequiredRootKnowledgeMaterial): Promise<OwnedRequiredKnowledgeData> {
  const value = await readRequiredRootKnowledgeMaterial(material), { entry } = requiredMaterialEntry(material)
  const expected = wholeRequiredKnowledgeInputs(entry), projections = new Map<string, CapsuleKnowledgePayload>()
  for (const payload of value.union.payloads) {
    const key = capsuleJson(payload.capsule)
    if (projections.has(key)) return requiredDagInvalid('whole source私有完整projection重复准确ref')
    projections.set(key, payload)
  }
  if (projections.size !== expected.length) return requiredDagInvalid('whole source完整projection全集有遗漏/额外项')
  const inputs = await settledRequiredInputMap(expected, async ({ locator, input, role }): Promise<OwnedRequiredKnowledgeInput> => {
    const bare = requiredBareCapsule(input.binding.capsule), projection = projections.get(capsuleJson(bare))
    const record = value.capsuleBindings.find(item => requiredDagCapsuleLocator(item.binding) === locator)
    if (!projection || !record || capsuleJson(record) !== capsuleJson({ capsule: input.binding.capsule, binding: input.binding, origin: input.origin }))
      return requiredDagInvalid('whole source逐locator/ref/hash/binding/origin与私有material不相等')
    const seal = await readCertifiedDurableSqlCapsule(input.capsule)
    assertRequiredCapsuleSeal(entry, input, seal)
    return { role, locator, capsule: input.binding.capsule, binding: input.binding, origin: input.origin,
      manifestText: capsuleJson(seal.manifest), originalFiles: seal.manifest.files, projection, projectionHash: knowledgePayloadHash(projection) }
  })
  return freezeCapsuleValue({ kind: 'owned-required-whole-knowledge-data', version: 1, root: value.root,
    nodeText: capsuleJson(value.node), sourceMaterialHash: value.materialHash, inputs,
    preparedEvidence: true, acceptedCoverage: false, effective: false, permit: false })
}
function sameRequiredKnowledgeData(expected: OwnedRequiredKnowledgeData, actual: OwnedRequiredKnowledgeData): void {
  if (capsuleJson(expected) !== capsuleJson(actual)) return requiredDagInvalid('whole source原root/node/全Map/完整projection前后变化')
}
/** Checks the same genuine private material's complete immutable facts after
 * final fresh. Does not repeat an already-completed material read wrapper or
 * replace artifact freshness with a DTO assertion. */
function assertWholeRequiredPrivateFacts(material: RequiredRootKnowledgeMaterial, expected: OwnedRequiredKnowledgeData): void {
  const { material: saved, entry } = requiredMaterialEntry(material), inputs = wholeRequiredKnowledgeInputs(entry)
  if (capsuleJson(saved.root) !== capsuleJson(expected.root) || capsuleJson(saved.node) !== expected.nodeText
    || saved.materialHash !== expected.sourceMaterialHash || expected.inputs.length !== inputs.length)
    return requiredDagInvalid('whole source末检真实root/node/material/全Map变化')
  const projections = new Map(saved.diagnostic.payloads.map(payload => [capsuleJson(payload.capsule), payload] as const))
  if (projections.size !== inputs.length || saved.diagnostic.payloads.length !== inputs.length)
    return requiredDagInvalid('whole source末检私有完整projection全集变化')
  for (const { locator, input, role } of inputs) {
    const record = expected.inputs.find(item => item.locator === locator), projection = projections.get(capsuleJson(requiredBareCapsule(input.binding.capsule)))
    if (!record || !projection || record.role !== role || capsuleJson(record.capsule) !== capsuleJson(input.binding.capsule)
      || capsuleJson(record.binding) !== capsuleJson(input.binding) || capsuleJson(record.origin) !== capsuleJson(input.origin)
      || requiredDagDatabaseFilesHash(record.originalFiles) !== input.origin.databaseFilesHash
      || knowledgePayloadHash(projection) !== record.projectionHash || capsuleJson(projection) !== capsuleJson(record.projection))
      return requiredDagInvalid('whole source末检逐原件ref/hash/binding/origin/完整projection变化')
  }
}
/** Fixed fresh SQL capture of BOTH actual private inputs. Started pair settles
 * before failure escapes; no source can be minted from an immutable DTO copy. */
export async function captureOwnedRequiredKnowledgeSource(material: RequiredRootKnowledgeMaterial) {
  const first = await readWholeRequiredKnowledgeData(material), { entry } = requiredMaterialEntry(material)
  const captured = await settledRequiredInputMap(wholeRequiredKnowledgeInputs(entry), async ({ locator, input }) => {
    const knowledge = await extractCertifiedDurableSqlCapsuleKnowledge(input.capsule), projection = await readCertifiedCapsuleKnowledge(knowledge)
    const expected = first.inputs.find(item => item.locator === locator)
    if (!expected || capsuleJson(projection.capsule) !== capsuleJson(requiredBareCapsule(input.binding.capsule))
      || knowledgePayloadHash(projection) !== expected.projectionHash || capsuleJson(projection) !== capsuleJson(expected.projection))
      return requiredDagInvalid('whole source本次实际SQL完整projection不等于genuine material对应原件')
    return { locator, knowledge }
  })
  await fresh(entry)
  assertWholeRequiredPrivateFacts(material, first)
  const handle: OwnedRequiredKnowledgeSource = Object.freeze({ kind: 'owned-required-whole-knowledge-source' })
  requiredKnowledgeSources.set(handle, { material, value: first, captured: Object.freeze(captured) })
  // The fixed upper owner can consume this completed capture's full facts.
  // Copying either field cannot register another source in the WeakMap.
  return Object.freeze({ source: handle, value: first })
}
/** Reuses the complete immutable SQL-captured projection. This read performs
 * real artifact freshness, not a new SQL extraction or a generic owner proof. */
export async function readOwnedRequiredKnowledgeSource(handle: OwnedRequiredKnowledgeSource): Promise<OwnedRequiredKnowledgeData> {
  const entry = requiredKnowledgeSources.get(handle)
  if (!entry) return requiredDagInvalid('不是Main全Map实际SQL捕获的whole source私有句柄')
  sameRequiredKnowledgeData(entry.value, await readWholeRequiredKnowledgeData(entry.material))
  await settledRequiredInputMap(entry.captured, async item => {
    const projection = await readCertifiedCapsuleKnowledge(item.knowledge), expected = entry.value.inputs.find(input => input.locator === item.locator)
    if (!expected || knowledgePayloadHash(projection) !== expected.projectionHash || capsuleJson(projection) !== capsuleJson(expected.projection))
      return requiredDagInvalid('whole source新捕获私有K完整原像变化')
  })
  const { entry: required } = requiredMaterialEntry(entry.material)
  await fresh(required)
  assertWholeRequiredPrivateFacts(entry.material, entry.value)
  return entry.value
}
