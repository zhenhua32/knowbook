import { capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { validateCoverageCapsuleReference, validateCoverageRootReference, type CoverageCapsuleReference, type CoverageRootReference } from './restore-knowledge-coverage-model'
import { captureRequiredRootBundleSource, extractRequiredRootKnowledgeMaterial, readRequiredRootKnowledgeMaterial, reopenFirstRequiredSqlDag,
  type CertifiedRequiredSqlDag, type RequiredRootKnowledgeMaterial } from './restore-knowledge-required-dag-read'
import { createOriginBundleVerificationProfile, importOriginBundleOriginal, readMountedOriginBundle, writeOriginBundleFromOwnedSource,
  type OriginBundleOriginal } from './restore-knowledge-origin-bundle-files'
import { originBundleInvalid } from './restore-knowledge-origin-bundle-model'

/** Evidence identity only. The actual accepted root still requires a separate
 * fence/intent/SQL owner; this registry has no current-effective role. */
export interface PreparedOriginBundle { readonly kind: 'prepared-origin-bundle' }
type Saved = Awaited<ReturnType<typeof readMountedOriginBundle>> & {
  dag: CertifiedRequiredSqlDag; material: RequiredRootKnowledgeMaterial; verificationProfile: string
}
const preparedBundles = new WeakMap<PreparedOriginBundle, Saved>()
export interface ExportPreparedOriginBundleInput { readonly operationId: string; readonly bundleId: string }
export interface ImportPreparedOriginBundleInput { readonly profileRoot: string; readonly operationId: string; readonly sourceDirectory: string }
export interface ReopenPreparedOriginBundleInput { readonly profileRoot: string; readonly operationId: string; readonly mountId: string; readonly expectedDescriptorHash: string }

/** No caller root/ref/filemap. The genuine material owner's complete private
 * source supplies all immutable native originals and original namespace bytes. */
export async function exportPreparedOriginBundle(material: RequiredRootKnowledgeMaterial, input: ExportPreparedOriginBundleInput): Promise<OriginBundleOriginal> {
  const row = capsuleRecord(input, ['operationId', 'bundleId'])
  return writeOriginBundleFromOwnedSource(await captureRequiredRootBundleSource(material), durableSqlDagUuid(row.operationId), durableSqlDagUuid(row.bundleId))
}
async function certifyMounted(input: Awaited<ReturnType<typeof readMountedOriginBundle>>): Promise<PreparedOriginBundle> {
  // This is a new independent copy. Real required owner opens its capsule SQL
  // snapshots here and cannot modify the immutable imported original catalog.
  const verificationProfile = await createOriginBundleVerificationProfile(input), ref = input.original.descriptor.root
  const dag = await reopenFirstRequiredSqlDag({ profileRoot: verificationProfile, operationId: ref.operationId, dagId: ref.dagId, expectedRootHash: ref.rootHash })
  const material = await extractRequiredRootKnowledgeMaterial(dag), value = await readRequiredRootKnowledgeMaterial(material)
  if (capsuleJson(value.root) !== capsuleJson(ref) || capsuleJson(value.node) !== input.original.descriptor.nodeText
    || value.capsuleBindings.length !== 2 || value.union.payloads.length !== 2) return originBundleInvalid('实际完整SQL重开/material不等于catalog原root及全部原件')
  const actual = await readMountedOriginBundle(input.profileRoot, input.operationId, input.mountId, input.original.descriptorHash)
  const handle: PreparedOriginBundle = Object.freeze({ kind: 'prepared-origin-bundle' })
  preparedBundles.set(handle, { ...actual, dag, material, verificationProfile })
  return handle
}
/** Incoming descriptor is untrusted data. A handle is minted only after full
 * original bytes and every actual capsule SQL certifier have succeeded. */
export async function importPreparedOriginBundle(input: ImportPreparedOriginBundleInput): Promise<PreparedOriginBundle> {
  const row = capsuleRecord(input, ['profileRoot', 'operationId', 'sourceDirectory'])
  return certifyMounted(await importOriginBundleOriginal(row.profileRoot as string, durableSqlDagUuid(row.operationId), row.sourceDirectory as string))
}
/** Restart entry. expectedHash only pins incoming bytes; it never authorizes
 * a descriptor, and the same complete SQL certification is always performed. */
export async function reopenPreparedOriginBundle(input: ReopenPreparedOriginBundleInput): Promise<PreparedOriginBundle> {
  const row = capsuleRecord(input, ['profileRoot', 'operationId', 'mountId', 'expectedDescriptorHash'])
  return certifyMounted(await readMountedOriginBundle(row.profileRoot as string, durableSqlDagUuid(row.operationId), durableSqlDagUuid(row.mountId), durableSqlDagHash(row.expectedDescriptorHash)))
}
function qualifiedRoot(entry: Saved): CoverageRootReference {
  return validateCoverageRootReference({ ...entry.original.descriptor.root,
    namespace: { kind: 'imported-bundle', mountId: entry.mountId, bundleDescriptorHash: entry.original.descriptorHash } })
}
/** Ref projection describes the bundle's original-domain binding. It is not a
 * resolver or a caller-supplied alias map, and cannot be used as a permit. */
export async function readPreparedOriginBundle(handle: PreparedOriginBundle) {
  const entry = preparedBundles.get(handle)
  if (!entry) return originBundleInvalid('不是Main完整catalog+SQL认证的bundle私有句柄')
  const first = await readMountedOriginBundle(entry.profileRoot, entry.operationId, entry.mountId, entry.original.descriptorHash)
  const value = await readRequiredRootKnowledgeMaterial(entry.material)
  if (capsuleJson(value.root) !== capsuleJson(first.original.descriptor.root) || capsuleJson(value.node) !== first.original.descriptor.nodeText)
    return originBundleInvalid('私有真实material与原catalog不闭合')
  const capsules: CoverageCapsuleReference[] = value.capsuleBindings.map(item => validateCoverageCapsuleReference({ ...item.capsule,
    namespace: { kind: 'imported-bundle', mountId: entry.mountId, bundleDescriptorHash: first.original.descriptorHash } }))
  await readMountedOriginBundle(entry.profileRoot, entry.operationId, entry.mountId, entry.original.descriptorHash)
  return freezeCapsuleValue({ kind: 'prepared-origin-bundle-diagnostic' as const, version: 1 as const,
    profileRoot: entry.profileRoot, operationId: entry.operationId, mountId: entry.mountId, descriptorHash: first.original.descriptorHash,
    originalDirectory: first.original.directory, root: qualifiedRoot(entry), capsules,
    originalRoot: first.original.descriptor.root, originalNodeText: first.original.descriptor.nodeText,
    interpretation: { kind: 'actual-immutable-first-bundle-domain' as const, descriptorHash: first.original.descriptorHash,
      databaseFilesHashes: value.capsuleBindings.map(item => item.origin.databaseFilesHash),
      requiredRootReferences: value.capsuleBindings.map(item => item.binding.requiredRoots),
      note: 'original native refs are relative to this bundle; physical verification/native paths are not origin authority' as const },
    groups: value.union.groups.length, permanentDenials: value.union.permanentDenials.length,
    preparedEvidence: true as const, acceptedCoverage: false as const, emptyKnowledgeProven: false as const,
    effectivePermit: false as const, fullNonemptyAncestorSupport: false as const })
}

// Actual imported whole-source seam. Only this existing owner can access the
// Saved mount/material pair; a public bundle diagnostic cannot mint a source.
import { captureOwnedRequiredKnowledgeSource, readOwnedRequiredKnowledgeSource,
  type OwnedRequiredKnowledgeSource, type OwnedRequiredKnowledgeData, type OwnedRequiredKnowledgeInput } from './restore-knowledge-required-dag-read'
import { originBundleExpectedFiles } from './restore-knowledge-origin-bundle-model'
import { parseRequiredSqlDagNode, requiredDagCapsuleLocator } from './restore-knowledge-required-dag-model'

export interface OwnedFirstImportedKnowledgeSource { readonly kind: 'owned-first-imported-whole-knowledge-source' }
export interface OwnedFirstImportedKnowledgeInput extends Omit<OwnedRequiredKnowledgeInput, 'capsule'> {
  readonly capsule: CoverageCapsuleReference; readonly originalCapsule: CoverageCapsuleReference
}
export interface OwnedFirstImportedKnowledgeData {
  readonly kind: 'owned-first-imported-whole-knowledge-data'; readonly version: 1
  readonly descriptorHash: string; readonly root: CoverageRootReference; readonly originalRoot: CoverageRootReference
  readonly originalNodeText: string; readonly sourceMaterialHash: string
  readonly inputs: readonly OwnedFirstImportedKnowledgeInput[]
  readonly interpretation: 'actual-immutable-single-first-bundle-domain'
  readonly preparedEvidence: true; readonly acceptedCoverage: false; readonly effective: false; readonly permit: false
}
type ImportedKnowledgeSourceEntry = { bundle: PreparedOriginBundle; required: OwnedRequiredKnowledgeSource; value: OwnedFirstImportedKnowledgeData }
const importedKnowledgeSources = new WeakMap<OwnedFirstImportedKnowledgeSource, ImportedKnowledgeSourceEntry>()
type Mounted = Awaited<ReturnType<typeof readMountedOriginBundle>>

function assertSameMountedKnowledgeOriginal(entry: Saved, actual: Mounted): void {
  if (actual.profileRoot !== entry.profileRoot || actual.operationId !== entry.operationId || actual.mountId !== entry.mountId
    || actual.original.directory !== entry.original.directory || actual.original.descriptorHash !== entry.original.descriptorHash
    || capsuleJson(actual.original.descriptor) !== capsuleJson(entry.original.descriptor)
    || capsuleJson(originBundleExpectedFiles(actual.original.descriptor)) !== capsuleJson(originBundleExpectedFiles(entry.original.descriptor)))
    return originBundleInvalid('qualified whole source真实mounted原件/准确catalog变化')
}
function importedWholeKnowledgeData(entry: Saved, mounted: Mounted, value: OwnedRequiredKnowledgeData): OwnedFirstImportedKnowledgeData {
  assertSameMountedKnowledgeOriginal(entry, mounted)
  const descriptor = mounted.original.descriptor, node = parseRequiredSqlDagNode(descriptor.nodeText)
  if (capsuleJson(value.root) !== capsuleJson(descriptor.root) || value.nodeText !== descriptor.nodeText || value.inputs.length !== 2)
    return originBundleInvalid('qualified whole source真实required根/node/全集不等于原catalog')
  const seen = new Set<string>(), inputs: OwnedFirstImportedKnowledgeInput[] = []
  for (const input of value.inputs) {
    const binding = node[input.role], origin = node.origins[input.role], locator = requiredDagCapsuleLocator(binding)
    if (seen.has(locator) || input.locator !== locator || capsuleJson(input.binding) !== capsuleJson(binding)
      || capsuleJson(input.origin) !== capsuleJson(origin) || capsuleJson(input.capsule) !== capsuleJson(binding.capsule)
      || input.manifestText !== (input.role === 'source' ? descriptor.sourceManifestText : descriptor.currentManifestText))
      return originBundleInvalid('qualified whole source逐原角色/ref/hash/binding/origin/真实manifest不闭合')
    seen.add(locator)
    // Only the actual mounted owner's identity qualifies the outer reference.
    // Inner native K1 refs, binding/origin, node and all historical rows stay exact.
    inputs.push({ ...input, originalCapsule: input.capsule, capsule: validateCoverageCapsuleReference({ ...input.capsule,
      namespace: { kind: 'imported-bundle', mountId: entry.mountId, bundleDescriptorHash: mounted.original.descriptorHash } }) })
  }
  if (seen.size !== 2 || !seen.has(requiredDagCapsuleLocator(node.source)) || !seen.has(requiredDagCapsuleLocator(node.current)))
    return originBundleInvalid('qualified whole source数量相等但准确原input集合不相等')
  return freezeCapsuleValue({ kind: 'owned-first-imported-whole-knowledge-data', version: 1,
    descriptorHash: mounted.original.descriptorHash, root: qualifiedRoot(entry), originalRoot: descriptor.root,
    originalNodeText: descriptor.nodeText, sourceMaterialHash: value.sourceMaterialHash, inputs,
    interpretation: 'actual-immutable-single-first-bundle-domain', preparedEvidence: true, acceptedCoverage: false, effective: false, permit: false })
}
async function mountedKnowledgeOriginal(entry: Saved): Promise<Mounted> {
  const actual = await readMountedOriginBundle(entry.profileRoot, entry.operationId, entry.mountId, entry.original.descriptorHash)
  assertSameMountedKnowledgeOriginal(entry, actual)
  return actual
}
/** One genuine first bundle only. Required capture performs two actual SQL
 * extractions, then mounted late-read closes the original catalog boundary. */
export async function captureOwnedFirstImportedKnowledgeSource(bundle: PreparedOriginBundle) {
  const entry = preparedBundles.get(bundle)
  if (!entry) return originBundleInvalid('不是Main真实bundle私有句柄，不能mint qualified whole source')
  const first = await mountedKnowledgeOriginal(entry), captured = await captureOwnedRequiredKnowledgeSource(entry.material)
  const value = importedWholeKnowledgeData(entry, first, captured.value)
  const last = await mountedKnowledgeOriginal(entry)
  if (capsuleJson(first.original.descriptor) !== capsuleJson(last.original.descriptor)) return originBundleInvalid('qualified capture期间原catalog变化')
  const handle: OwnedFirstImportedKnowledgeSource = Object.freeze({ kind: 'owned-first-imported-whole-knowledge-source' })
  importedKnowledgeSources.set(handle, { bundle, required: captured.source, value })
  return Object.freeze({ source: handle, value })
}
/** Fixed mounted-before -> genuine whole source -> late-mounted sequence.
 * Verification/native placement never becomes a resolver for original refs. */
export async function readOwnedFirstImportedKnowledgeSource(handle: OwnedFirstImportedKnowledgeSource): Promise<OwnedFirstImportedKnowledgeData> {
  const source = importedKnowledgeSources.get(handle)
  if (!source) return originBundleInvalid('不是Main真实mounted whole source私有句柄')
  const entry = preparedBundles.get(source.bundle)
  if (!entry) return originBundleInvalid('qualified whole source丢失真实bundle owner')
  const first = await mountedKnowledgeOriginal(entry), value = importedWholeKnowledgeData(entry, first, await readOwnedRequiredKnowledgeSource(source.required))
  await mountedKnowledgeOriginal(entry)
  if (capsuleJson(value) !== capsuleJson(source.value)) return originBundleInvalid('qualified whole source全投影/实际mount前像变化')
  return source.value
}
