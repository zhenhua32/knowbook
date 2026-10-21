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
