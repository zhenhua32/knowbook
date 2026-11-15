import Database from 'better-sqlite3'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseStrictJson } from '../../shared/strictJson'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { readRawPriorKnowledgeCoverageOwned } from './restore-knowledge-coverage-raw-read'
import { readInstalledV3AssetContinuity, validateInstalledV3AssetArchiveProof,
  type InstalledV3AssetArchiveProof, type InstalledV3AssetContinuity } from './restore-knowledge-installed-v3-assets'
import { assertInstalledV3ManyFiles, CAPSULE_INSTALLED_TRANSFERS_DIRECTORY, validateInstalledV3Many,
  type InstalledV3Many } from './restore-knowledge-installed-v3-many'
import { readOriginCatalogFile } from './restore-knowledge-origin-bundle-files'
import { isBackupV3AssetPath, type ArchiveV3 } from '../backup/v3-format'
import type { BackupV3RestoreSource } from '../backup/v3-reader'
import { assertBackupV3RestoreSqlArchiveProjection, assertBackupV3RestoreSqlStageOriginal,
  type BackupV3RestoreSqlStage } from '../backup/v3-restore-sql-stage'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { assertOwnedRawCapsuleOriginal, assertOwnedRawCapsuleScratchReady, assertOwnedRawCapsuleScratchContent,
  readOwnedRawCapsuleOriginal, type OwnedRawCapsuleOriginal } from './restore-knowledge-capsule-files'
import { capsuleBytesHash, capsuleJson, capsuleRecord, capsuleText, freezeCapsuleValue,
  validateDurableSqlCapsuleInventory, type DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { readRawCapsule2AssetReferencesOwned } from './restore-knowledge-capsule2-assets-read'
import { captureCapsule2ManagedTreeData, captureCapsule2ManagedTreeWithInstalledAssets, type Capsule2ManagedTreeData } from './restore-knowledge-capsule2-managed-assets-files'
import { validateCapsule2ManagedTree } from './restore-knowledge-capsule2-assets-model'
import { captureCapsule2AssetReferenceProvenanceOwned3, validateCapsule2AssetReferenceProvenance1,
  captureCapsule2AssetReferenceProvenance2Owned3, validateCapsule2AssetReferenceProvenance2,
  captureCapsuleV3PortableAssetProvenance, validateCapsuleV3PortableAssetProvenance,
  captureCapsuleInstalledAssetProvenance, validateCapsuleInstalledAssetProvenance,
  captureCapsuleInstalledCombinedAssetProvenance, validateCapsuleInstalledCombinedAssetProvenance,
  type Capsule2AssetReferenceProvenance1, type Capsule2AssetReferenceProvenance2 } from './restore-knowledge-capsule2-asset-provenance'
import { CAPSULE_V3_CONTENT_DIRECTORY, capsuleV3PortableManagedTree, copyCapsuleV3ArchiveOriginals,
  readCapsuleV3ArchiveOriginals, validateCapsuleV3ArchiveProof, validateCapsuleV3ManagedTree,
  type CapsuleV3ArchiveProof } from './restore-knowledge-capsule-v3-assets'
import { DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES } from './restore-knowledge-dag-model'
import { prepareCapsule2MergeContextOriginals3, reopenCapsule2MergeContextOriginals3, visitCapsule2MergeContextOriginals3, assertCapsule2MergeContextOriginalBytes3,
  validateCapsule2MergeContextInventory3, type Capsule2MergeContextInventory3, type PreparedCapsule2MergeContexts3 } from './restore-knowledge-capsule2-merge-contexts'
import { createRootRestoreSupplementalAssetObserver3 } from './restore-knowledge-assets3-supplement'
import { describeCapsule2AssetScopeSupplement3, validateCapsule2AssetScopeSupplementDescriptor3, capsule2CombinedAssetUris3,
  type Capsule2AssetScopeSupplementDescriptor3 } from './restore-knowledge-capsule2-asset-supplement-model'
import { assertCapsule2AssetDirectory as directory, readCapsule2AssetManifest,
  writeCapsule2AssetCopy as writeNew, readCapsule2AssetCopy as readExact } from './restore-knowledge-capsule2-assets-files'

/** The physical Main-managed tree and the SQL's actual reference literals are
 * separate source facts. Missing, foreign and future reference targets never
 * cause automatic file/network access or disappear from the original SQL. */
import { prepareCapsule2BaseProjection4, readCapsule2BaseProjection4, reopenCapsule2BaseProjection4,
  assertCapsule2BaseProjectionOriginalBytes4, validateCapsule2BaseProjectionPointer4, describeCapsule2BaseProjectionPointer4,
  type PreparedCapsule2BaseProjection4, type Capsule2BaseProjectionCommitment4, type Capsule2BaseProjectionPointer4 } from './restore-knowledge-capsule2-base-projection4'
import { prepareCapsule2MergeContextOriginals4, reopenCapsule2MergeContextOriginals4, visitCapsule2MergeContextOriginals4,
  assertCapsule2MergeContextOriginalBytes4, validateCapsule2MergeContextInventory4,
  type PreparedCapsule2MergeContexts4, type Capsule2MergeContextInventory4 } from './restore-knowledge-capsule2-merge-contexts4'
import { createRootRestoreSupplementalAssetObserver4 } from './restore-knowledge-assets4-supplement'
import { describeCapsule2AssetScopeSupplement4, validateCapsule2AssetScopeSupplementDescriptor4, capsule2CombinedAssetUris4,
  type Capsule2AssetScopeSupplementDescriptor4 } from './restore-knowledge-capsule2-asset-supplement4-model'
import {prepareCapsule2BaseProjectionForWorking5,reopenCapsule2BaseProjectionForWorking5} from './restore-knowledge-capsule2-base-projection4'
import {prepareWorkingOriginals5,reopenWorkingOriginals5,readWorkingOriginalsInventory5,assertWorkingOriginalBytes5,
 type PreparedWorkingOriginals5} from './restore-knowledge-capsule5-working-originals'
import {describeWorkingOriginals5,validateWorkingOriginalsPointer5,type WorkingOriginalsPointer5} from './restore-knowledge-capsule5-working-model'
import {describeCapsule5AssetScopeSupplement5,validateCapsule5AssetScopeSupplement5,capsule5CombinedAssetUris5,
 type Capsule5AssetScopeSupplementDescriptor5} from './restore-knowledge-capsule5-asset-supplement-model'
interface Capsule2AssetArchiveBase {
  readonly kind: 'capsule2-complete-asset-archive'
  readonly material: 'main-managed-tree-and-original-reference-literals'
  readonly certified: false; readonly semanticValidationComplete: false; readonly permit: false
  readonly capsuleId: string; readonly schemaVersion: 26 | 27; readonly sourceInventory: readonly DurableSqlCapsuleFile[]
  readonly sourceContentHash: string; readonly workspaceHistoryObservationHash: string; readonly assetReferencesObservationHash: string
  readonly referenceCount: number; readonly referenceUris: readonly string[]; readonly tree: Capsule2ManagedTreeData
}
export interface Capsule2AssetReferenceCoverage2 {
  readonly kind: 'base-asset-observation-capture-only'; readonly version: 1; readonly baseObserverVersion: 3
  readonly assetReferencesObservationHash: string; readonly baseTypedScopesCaptured: true
  readonly supplementalCustomMergeScopesCaptured: false; readonly allAssetScopesCaptured: false
  readonly semanticSelectionPermission: false; readonly finalAssetClosureComplete: false
  readonly acceptedCoverage: false; readonly effective: false; readonly installPermit: false
}
export interface Capsule2AssetReferenceCoverage3 {
  readonly kind: 'base-and-supplemental-asset-observation-capture'; readonly version: 1
  readonly baseObserverVersion: 3; readonly supplementalObserverVersion: 1
  readonly assetReferencesObservationHash: string; readonly supplementalObservationHash: string
  readonly baseTypedScopesCaptured: true; readonly supplementalCustomMergeScopesCaptured: boolean
  readonly allAssetScopesCaptured: false; readonly semanticSelectionPermission: false
  readonly finalAssetClosureComplete: false; readonly acceptedCoverage: false; readonly effective: false; readonly installPermit: false
  readonly wholeContextInputsMemoryBounded: false; readonly completeV3AssetAdapter: false
}
export type Capsule2AssetReferenceCoverage4 = Omit<Capsule2AssetReferenceCoverage3, 'version' | 'supplementalObserverVersion'> & {
  readonly version: 2; readonly supplementalObserverVersion: 2
}
export interface Capsule5AssetReferenceCoverage5 {
 readonly kind:'base-and-complete-merge-working-observation';readonly version:1;readonly baseObserverVersion:3;readonly supplementalObserverVersion:3
 readonly assetReferencesObservationHash:string;readonly supplementalObservationHash:string;readonly supportedMergeFamilies:readonly [2,3,4,5,6,7]
 readonly baseTypedScopesCaptured:true;readonly mergedWorkingScopesCaptured:boolean;readonly allAssetScopesCaptured:false
 readonly semanticSelectionPermission:false;readonly finalAssetClosureComplete:false;readonly acceptedCoverage:false;readonly effective:false;readonly installPermit:false
 readonly wholeContextInputsMemoryBounded:false;readonly completeV3AssetAdapter:false
}
type WorkingArchiveFields = { readonly referenceProvenance: Capsule2AssetReferenceProvenance2; readonly baseProjection: Capsule2BaseProjectionPointer4;
  readonly workingOriginals: WorkingOriginalsPointer5; readonly assetScopeSupplement: Capsule5AssetScopeSupplementDescriptor5;
  readonly coverage: Capsule5AssetReferenceCoverage5 }
export type Capsule2AssetArchiveManifest = Capsule2AssetArchiveBase & (
  { readonly version: 1; readonly referencePolicy: 'retain-literals-without-reference-file-access' }
  | { readonly version: 2; readonly referencePolicy: 'capture-owned-aliases-retain-unresolved-literals';
    readonly referenceProvenance: Capsule2AssetReferenceProvenance1; readonly coverage: Capsule2AssetReferenceCoverage2 }
  | { readonly version: 3; readonly referencePolicy: 'capture-owned-base-and-supplemental-aliases-retain-unresolved-literals';
    readonly referenceProvenance: Capsule2AssetReferenceProvenance2; readonly contextOriginals: Capsule2MergeContextInventory3;
    readonly assetScopeSupplement: Capsule2AssetScopeSupplementDescriptor3; readonly coverage: Capsule2AssetReferenceCoverage3 }
  | { readonly version: 4; readonly referencePolicy: 'capture-owned-base-and-settled-context-aliases-retain-unresolved-literals';
    readonly referenceProvenance: Capsule2AssetReferenceProvenance2; readonly contextOriginals: Capsule2MergeContextInventory4;
    readonly baseProjection: Capsule2BaseProjectionPointer4;
    readonly assetScopeSupplement: Capsule2AssetScopeSupplementDescriptor4; readonly coverage: Capsule2AssetReferenceCoverage4 }
  | (WorkingArchiveFields & { readonly version: 5; readonly referencePolicy: 'capture-owned-base-and-all-merge-working-aliases-retain-unresolved-literals' })
  | { readonly version: 6; readonly referencePolicy: 'capture-verified-v3-portable-aliases';
    readonly backupV3: CapsuleV3ArchiveProof; readonly referenceProvenance: Capsule2AssetReferenceProvenance1;
    readonly coverage: Capsule2AssetReferenceCoverage2 }
  | { readonly version: 7; readonly referencePolicy: 'capture-previously-installed-v3-native-aliases';
    readonly installedV3: InstalledV3AssetArchiveProof; readonly referenceProvenance: Capsule2AssetReferenceProvenance1;
    readonly coverage: Capsule2AssetReferenceCoverage2 }
  | (WorkingArchiveFields & { readonly version: 8; readonly referencePolicy: 'capture-installed-v3-native-base-and-original-working-aliases';
    readonly installedV3: InstalledV3AssetArchiveProof })
  | { readonly version: 9; readonly referencePolicy: 'capture-previously-installed-multiple-v3-native-aliases';
    readonly installedV3Many: InstalledV3Many; readonly referenceProvenance: Capsule2AssetReferenceProvenance1;
    readonly coverage: Capsule2AssetReferenceCoverage2 }
  | (WorkingArchiveFields & { readonly version: 10; readonly referencePolicy: 'capture-installed-multiple-v3-native-base-and-original-working-aliases';
    readonly installedV3Many: InstalledV3Many }))

export function isWorkingAssetArchive5(archive: Capsule2AssetArchiveManifest): archive is Extract<Capsule2AssetArchiveManifest, { version: 5 | 8 | 10 }> {
  return archive.version === 5 || archive.version === 8 || archive.version === 10
}
export interface PreparedCapsule2AssetArchive { readonly kind: 'prepared-capsule2-complete-asset-archive' }
export interface Capsule2AssetArchiveInfo { readonly directory: string; readonly manifest: Capsule2AssetArchiveManifest; readonly manifestHash: string }
type Saved = Capsule2AssetArchiveInfo & { original: OwnedRawCapsuleOriginal; root: string; bytes: Buffer; contextOwner?: PreparedCapsule2MergeContexts3; contextOwner4?: PreparedCapsule2MergeContexts4; baseOwner4?: PreparedCapsule2BaseProjection4; workingOwner5?:PreparedWorkingOriginals5 }
const archives = new WeakMap<PreparedCapsule2AssetArchive, Saved>(), used = new WeakSet<OwnedRawCapsuleOriginal>()
const bad = (message: string): never => { throw new Error('capsule2完整附件归档无效：' + message + '；原引用保留，不授外部文件读取、认证或安装权。') }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const hash = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : bad('原hash无效')
const archiveDomain = (version: Capsule2AssetArchiveManifest['version']) => 'knowbook.capsule2.complete-asset-archive.v' + version
const referencePolicies = {
  1: 'retain-literals-without-reference-file-access',
  2: 'capture-owned-aliases-retain-unresolved-literals',
  3: 'capture-owned-base-and-supplemental-aliases-retain-unresolved-literals',
  4: 'capture-owned-base-and-settled-context-aliases-retain-unresolved-literals',
  5: 'capture-owned-base-and-all-merge-working-aliases-retain-unresolved-literals',
  6: 'capture-verified-v3-portable-aliases',
  7: 'capture-previously-installed-v3-native-aliases',
  8: 'capture-installed-v3-native-base-and-original-working-aliases',
  9: 'capture-previously-installed-multiple-v3-native-aliases',
  10: 'capture-installed-multiple-v3-native-base-and-original-working-aliases'
} as const
const extraArchiveKeys = {
  1: [],
  2: ['referenceProvenance','coverage'],
  3: ['referenceProvenance','coverage','contextOriginals','assetScopeSupplement'],
  4: ['referenceProvenance','coverage','contextOriginals','assetScopeSupplement','baseProjection'],
  5: ['referenceProvenance','coverage','workingOriginals','assetScopeSupplement','baseProjection'],
  6: ['referenceProvenance','coverage','backupV3'],
  7: ['referenceProvenance','coverage','installedV3'],
  8: ['referenceProvenance','coverage','workingOriginals','assetScopeSupplement','baseProjection','installedV3'],
  9: ['referenceProvenance','coverage','installedV3Many'],
  10: ['referenceProvenance','coverage','workingOriginals','assetScopeSupplement','baseProjection','installedV3Many']
} as const
const manifestHash = (value: Capsule2AssetArchiveManifest) => capsuleBytesHash(archiveDomain(value.version) + '\0' + capsuleJson(value))
function baseCoverage(assetReferencesObservationHash: string): Capsule2AssetReferenceCoverage2 {
  return freezeCapsuleValue({ kind: 'base-asset-observation-capture-only', version: 1, baseObserverVersion: 3,
    assetReferencesObservationHash, baseTypedScopesCaptured: true, supplementalCustomMergeScopesCaptured: false,
    allAssetScopesCaptured: false, semanticSelectionPermission: false, finalAssetClosureComplete: false,
    acceptedCoverage: false, effective: false, installPermit: false })
}
function supplementalCoverage(assetReferencesObservationHash: string, supplement: Capsule2AssetScopeSupplementDescriptor3): Capsule2AssetReferenceCoverage3 {
  return freezeCapsuleValue({ kind: 'base-and-supplemental-asset-observation-capture', version: 1, baseObserverVersion: 3, supplementalObserverVersion: 1,
    assetReferencesObservationHash, supplementalObservationHash: supplement.observationHash, baseTypedScopesCaptured: true,
    supplementalCustomMergeScopesCaptured: supplement.unsupportedHolders.count === 0, allAssetScopesCaptured: false, semanticSelectionPermission: false,
    finalAssetClosureComplete: false, acceptedCoverage: false, effective: false, installPermit: false,
    wholeContextInputsMemoryBounded: false, completeV3AssetAdapter: false })
}

function settledCoverage4(assetReferencesObservationHash: string, supplement: Capsule2AssetScopeSupplementDescriptor4): Capsule2AssetReferenceCoverage4 {
  return freezeCapsuleValue({ kind: 'base-and-supplemental-asset-observation-capture', version: 2, baseObserverVersion: 3, supplementalObserverVersion: 2,
    assetReferencesObservationHash, supplementalObservationHash: supplement.observationHash, baseTypedScopesCaptured: true,
    supplementalCustomMergeScopesCaptured: supplement.unsupportedHolders.count === 0,
    allAssetScopesCaptured: false, semanticSelectionPermission: false, finalAssetClosureComplete: false, acceptedCoverage: false, effective: false, installPermit: false,
    wholeContextInputsMemoryBounded: false, completeV3AssetAdapter: false })
}
function workingCoverage5(baseHash:string,supplement:Capsule5AssetScopeSupplementDescriptor5):Capsule5AssetReferenceCoverage5 {
 return freezeCapsuleValue({kind:'base-and-complete-merge-working-observation',version:1,baseObserverVersion:3,supplementalObserverVersion:3,
 assetReferencesObservationHash:baseHash,supplementalObservationHash:supplement.observationHash,supportedMergeFamilies:[2,3,4,5,6,7] as const,
 baseTypedScopesCaptured:true,mergedWorkingScopesCaptured:supplement.unsupportedHolders.count===0,allAssetScopesCaptured:false,semanticSelectionPermission:false,
 finalAssetClosureComplete:false,acceptedCoverage:false,effective:false,installPermit:false,wholeContextInputsMemoryBounded:false,completeV3AssetAdapter:false})
}
function parse(text: string, capsuleId: string, expectedHash: string): Capsule2AssetArchiveManifest {
  const parsed = parseStrictJson(text, { maxBytes: CAPSULE2_RAW_MAX_JSON_BYTES, maxDepth: 12 })
  const version = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).version : null
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6
    && version !== 7 && version !== 8 && version !== 9 && version !== 10)
    return bad('未知archive版本，不降级或补造权属')
  const row = capsuleRecord(parsed, ['kind','version','material','referencePolicy','certified','semanticValidationComplete','permit',
    'capsuleId','schemaVersion','sourceInventory','sourceContentHash','workspaceHistoryObservationHash','assetReferencesObservationHash','referenceCount','referenceUris','tree',
    ...extraArchiveKeys[version]])
  if (text !== capsuleJson(parsed) + '\n' || capsuleBytesHash(archiveDomain(version) + '\0' + capsuleJson(parsed)) !== hash(expectedHash)) return bad('规范原字节或预期hash不符')
  if (row.kind !== 'capsule2-complete-asset-archive' || row.material !== 'main-managed-tree-and-original-reference-literals'
    || row.referencePolicy !== referencePolicies[version]
    || row.certified !== false || row.semanticValidationComplete !== false
    || row.permit !== false || row.capsuleId !== capsuleId || row.schemaVersion !== 26 && row.schemaVersion !== 27) return bad('格式、身份或权限标志无效')
  if (typeof row.referenceCount !== 'number' || !Number.isSafeInteger(row.referenceCount) || row.referenceCount < 0
    || !Array.isArray(row.referenceUris) || row.referenceUris.length > row.referenceCount) return bad('完整引用计数不闭合')
  const uris = row.referenceUris.map(value => capsuleText(value, CAPSULE2_RAW_MAX_JSON_BYTES))
  if (row.referenceCount > 0 && uris.length === 0) return bad('非空引用被降为空集合')
  for (let index = 1; index < uris.length; index++) if (uris[index - 1] >= uris[index]) return bad('原引用未排序或重复')
  const schemaVersion: 26 | 27 = row.schemaVersion
  const base = { kind: 'capsule2-complete-asset-archive' as const, material: 'main-managed-tree-and-original-reference-literals' as const,
    certified: false as const, semanticValidationComplete: false as const, permit: false as const, capsuleId, schemaVersion,
    sourceInventory: validateDurableSqlCapsuleInventory(row.sourceInventory), sourceContentHash: hash(row.sourceContentHash),
    workspaceHistoryObservationHash: hash(row.workspaceHistoryObservationHash), assetReferencesObservationHash: hash(row.assetReferencesObservationHash),
    referenceCount: row.referenceCount, referenceUris: uris,
    tree: version >= 6 ? validateCapsuleV3ManagedTree(row.tree) : validateCapsule2ManagedTree(row.tree) }
  if (version === 1) return freezeCapsuleValue({ ...base, version: 1, referencePolicy: 'retain-literals-without-reference-file-access' })
  if (version === 7) {
    const installedV3 = validateInstalledV3AssetArchiveProof(row.installedV3, base.tree), coverage = baseCoverage(base.assetReferencesObservationHash)
    if (capsuleJson(row.coverage) !== capsuleJson(coverage)) return bad('V3 安装连续性不可提升基础覆盖')
    const result: Capsule2AssetArchiveManifest = freezeCapsuleValue({ ...base, version, referencePolicy: referencePolicies[version],
      installedV3, coverage, referenceProvenance: validateCapsuleInstalledAssetProvenance(row.referenceProvenance, base, base.tree,
        new Set(installedV3.aliases.map(alias => alias.relativePath))) })
    assertOriginalBudget(result)
    return result
  }
  if (version === 9) {
    const installedV3Many = validateInstalledV3Many(row.installedV3Many, base.tree), coverage = baseCoverage(base.assetReferencesObservationHash)
    if (capsuleJson(row.coverage) !== capsuleJson(coverage)) return bad('混合 V3 安装连续性不可提升基础覆盖')
    const result: Capsule2AssetArchiveManifest = freezeCapsuleValue({ ...base, version, referencePolicy: referencePolicies[version],
      installedV3Many, coverage, referenceProvenance: validateCapsuleInstalledAssetProvenance(row.referenceProvenance, base, base.tree,
        new Set(installedV3Many.aliases.map(entry => entry.alias.relativePath))) })
    assertOriginalBudget(result)
    return result
  }
  if (version === 6) {
    const backupV3 = validateCapsuleV3ArchiveProof(row.backupV3), coverage = baseCoverage(base.assetReferencesObservationHash)
    if (capsuleJson(row.coverage) !== capsuleJson(coverage) || capsuleJson(base.tree) !== capsuleJson(capsuleV3PortableManagedTree(backupV3)))
      return bad('V3 portable原件树、库存或基础覆盖声明不闭合')
    const result: Capsule2AssetArchiveManifest = freezeCapsuleValue({ ...base, version, referencePolicy: referencePolicies[version],
      backupV3, coverage, referenceProvenance: validateCapsuleV3PortableAssetProvenance(row.referenceProvenance, base, base.tree) })
    assertOriginalBudget(result)
    return result
  }
  if(version===5 || version===8 || version===10){
   const baseProjection=validateCapsule2BaseProjectionPointer4(row.baseProjection),workingOriginals=validateWorkingOriginalsPointer5(row.workingOriginals),assetScopeSupplement=validateCapsule5AssetScopeSupplement5(row.assetScopeSupplement)
   const coverage=workingCoverage5(base.assetReferencesObservationHash,assetScopeSupplement)
   if(baseProjection.version!==(version===10?3:version===8?2:1)||assetScopeSupplement.sourceContentHash!==base.sourceContentHash||assetScopeSupplement.baseManifestHash!==baseProjection.baseManifestHash||capsuleJson(row.coverage)!==capsuleJson(coverage))return bad('working5来源/覆盖绑定不符')
   const binding={...base,assetScopeSupplementHash:assetScopeSupplement.observationHash,referenceUris:capsule5CombinedAssetUris5(base.referenceUris,assetScopeSupplement)}
   const common={...base,baseProjection,workingOriginals,assetScopeSupplement,coverage}
   if (version === 10) {
     const installedV3Many = validateInstalledV3Many(row.installedV3Many, base.tree)
     const referenceProvenance = validateCapsuleInstalledCombinedAssetProvenance(row.referenceProvenance, binding, base.tree,
       new Set(installedV3Many.aliases.map(entry => entry.alias.relativePath)))
     const result = freezeCapsuleValue({ ...common, version: 10 as const, referencePolicy: referencePolicies[version], installedV3Many, referenceProvenance })
     assertOriginalBudget(result)
     return result
   }
   const installedV3=version===8?validateInstalledV3AssetArchiveProof(row.installedV3,base.tree):undefined
   const result:Capsule2AssetArchiveManifest=freezeCapsuleValue(installedV3
     ? {...common,version:8,referencePolicy:referencePolicies[8],installedV3,referenceProvenance:validateCapsuleInstalledCombinedAssetProvenance(row.referenceProvenance,binding,base.tree,new Set(installedV3.aliases.map(alias=>alias.relativePath)))}
     : {...common,version:5,referencePolicy:referencePolicies[5],referenceProvenance:validateCapsule2AssetReferenceProvenance2(row.referenceProvenance,binding,base.tree)})
   assertOriginalBudget(result);return result
  }
  if (version === 4) {
    const baseProjection = validateCapsule2BaseProjectionPointer4(row.baseProjection), contextOriginals = validateCapsule2MergeContextInventory4(row.contextOriginals)
    const assetScopeSupplement = validateCapsule2AssetScopeSupplementDescriptor4(row.assetScopeSupplement), coverage = settledCoverage4(base.assetReferencesObservationHash, assetScopeSupplement)
    if (baseProjection.version !== 1 || contextOriginals.sourceContentHash !== base.sourceContentHash || contextOriginals.baseManifestHash !== baseProjection.baseManifestHash
      || assetScopeSupplement.sourceContentHash !== base.sourceContentHash || assetScopeSupplement.baseManifestHash !== baseProjection.baseManifestHash
      || assetScopeSupplement.settledEvidenceHash !== contextOriginals.settledEvidenceHash || capsuleJson(row.coverage) !== capsuleJson(coverage)) return bad('v4 base/context/settled/supplement不属于同一原件')
    const result: Capsule2AssetArchiveManifest = freezeCapsuleValue({ ...base, version: 4, baseProjection, contextOriginals, assetScopeSupplement, coverage,
      referencePolicy: 'capture-owned-base-and-settled-context-aliases-retain-unresolved-literals',
      referenceProvenance: validateCapsule2AssetReferenceProvenance2(row.referenceProvenance, { ...base,
        assetScopeSupplementHash: assetScopeSupplement.observationHash, referenceUris: capsule2CombinedAssetUris4(base.referenceUris, assetScopeSupplement) }, base.tree) })
    assertOriginalBudget(result); return result
  }
  if (version === 3) {
    const contextOriginals = validateCapsule2MergeContextInventory3(row.contextOriginals), assetScopeSupplement = validateCapsule2AssetScopeSupplementDescriptor3(row.assetScopeSupplement)
    if (contextOriginals.sourceContentHash !== base.sourceContentHash || assetScopeSupplement.sourceContentHash !== base.sourceContentHash) return bad('v3 context/supplement不属于原SQL')
    const coverage = supplementalCoverage(base.assetReferencesObservationHash, assetScopeSupplement)
    if (capsuleJson(row.coverage) !== capsuleJson(coverage)) return bad('v3覆盖策略不属于完整实际补充观察或被升级')
    const result: Capsule2AssetArchiveManifest = freezeCapsuleValue({ ...base, version: 3,
      referencePolicy: 'capture-owned-base-and-supplemental-aliases-retain-unresolved-literals', contextOriginals, assetScopeSupplement, coverage,
      referenceProvenance: validateCapsule2AssetReferenceProvenance2(row.referenceProvenance, { ...base,
        assetScopeSupplementHash: assetScopeSupplement.observationHash, referenceUris: capsule2CombinedAssetUris3(base.referenceUris, assetScopeSupplement) }, base.tree) })
    assertOriginalBudget(result)
    return result
  }
  const coverage = baseCoverage(base.assetReferencesObservationHash)
  if (capsuleJson(row.coverage) !== capsuleJson(coverage)) return bad('部分覆盖策略不可被caller DTO升级或改变观察域')
  return freezeCapsuleValue({ ...base, version: 2, referencePolicy: 'capture-owned-aliases-retain-unresolved-literals', coverage,
    referenceProvenance: validateCapsule2AssetReferenceProvenance1(row.referenceProvenance, base, base.tree) })
}

async function source(original: OwnedRawCapsuleOriginal, backupV3?: Omit<ArchiveV3, 'assets'>,
  installedV3?: Pick<InstalledV3AssetArchiveProof, 'root'>, expectedCoverage?: unknown) {
  const info = readOwnedRawCapsuleOriginal(original)
  await assertOwnedRawCapsuleScratchReady(original)
  const db = new Database(restoreSqliteFilename(info.databasePath), { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    const value = db.transaction(() => {
      if (backupV3) assertBackupV3RestoreSqlArchiveProjection(db, backupV3)
      if (installedV3) {
        const { entries } = readRawPriorKnowledgeCoverageOwned(db)
        const prior = entries.find(entry => capsuleJson(entry.root) === capsuleJson(installedV3.root))
        if (!prior || expectedCoverage && capsuleJson(prior) !== capsuleJson(expectedCoverage)
          || db.prepare("SELECT 1 FROM app_settings WHERE lower(CAST(key AS TEXT)) GLOB 'sync.webdav.protocol5.exchange-job.*' LIMIT 1").get())
          return bad('已安装 V3 本机归档需要同次 SQLite 覆盖且无 Working5 任务')
      }
      return readRawCapsule2AssetReferencesOwned(db)
    })()
    return { schemaVersion: db.pragma('user_version', { simple: true }) as 26 | 27,
      sourceContentHash: value.sourceContentHash, workspaceHistoryObservationHash: value.workspaceHistoryObservationHash,
      assetReferencesObservationHash: value.observationHash, referenceCount: value.scopes.reduce((count, scope) => count + scope.destinations.length, 0),
      referenceUris: [...new Set(value.scopes.flatMap(scope => scope.destinations.map(item => item.uri)))].sort(compare) }
  } finally { db.close(); await assertOwnedRawCapsuleScratchContent(original) }
}
async function observeContexts(owner: PreparedCapsule2MergeContexts3) {
  const state: { observer?: ReturnType<typeof createRootRestoreSupplementalAssetObserver3> } = {}
  const read = await visitCapsule2MergeContextOriginals3(owner, {
    begin(value) { state.observer = createRootRestoreSupplementalAssetObserver3(value.sourceContent, value.baseAssets) },
    context(value) { if (!state.observer) return bad('context回调先于同次真实原SQL'); state.observer.accept(value.replay) }
  })
  const observer = state.observer ?? bad('genuine context owner未给出完整原SQL观察')
  // Finish only after every sequential context and the owner's complete byte/
  // closure tail succeeded; no context header/binary array escapes this read.
  return { inventory: read.inventory, supplemental: observer.finish() }
}
async function observeContexts4(owner: PreparedCapsule2MergeContexts4) {
  const state: { observer?: ReturnType<typeof createRootRestoreSupplementalAssetObserver4> } = {}
  const read = await visitCapsule2MergeContextOriginals4(owner, {
    begin(value) { state.observer = createRootRestoreSupplementalAssetObserver4(value.base) },
    context(value) { if (!state.observer) return bad('context4回调先于同次genuine base'); state.observer.accept(value.replay) }
  })
  const observer = state.observer ?? bad('genuine context4未提供完整base source')
  return { inventory: read.inventory, baseCommitment: read.base.commitment, supplemental: observer.finish() }
}
/** Original-byte proof only. Read/archive/source-seal byte tails never query
 * SQL or replay a planner. Semantic observation has its own complete bracket. */
async function verifyBytes(value: Saved): Promise<Capsule2AssetArchiveInfo> {
  await assertOwnedRawCapsuleOriginal(value.original)
  const files = join(value.directory, 'files'), expectedNames = value.manifest.tree.files.map(file => file.hash).sort(compare)
  const version = value.manifest.version
  const expectedArchiveNames = version === 6 ? ['files','manifest.json',CAPSULE_V3_CONTENT_DIRECTORY]
    : version === 9 ? ['files',CAPSULE_INSTALLED_TRANSFERS_DIRECTORY,'manifest.json']
    : version === 10 ? ['base-provenance.json','contexts','files',CAPSULE_INSTALLED_TRANSFERS_DIRECTORY,'manifest.json']
    : version === 4 || isWorkingAssetArchive5(value.manifest) ? ['base-provenance.json','contexts','files','manifest.json']
    : version === 3 ? ['contexts','files','manifest.json'] : ['files','manifest.json']
  const closure = async () => {
    await directory(value.directory, value.root); await directory(files, value.root)
    if (capsuleJson((await readdir(value.directory)).sort(compare)) !== capsuleJson(expectedArchiveNames)
      || capsuleJson((await readdir(files)).sort(compare)) !== capsuleJson(expectedNames)) return bad('完整归档闭集变化')
  }
  await closure()
  await readExact(join(value.directory, 'manifest.json'), value.root, value.bytes.length, capsuleBytesHash(value.bytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  if (value.manifest.version === 6) await readCapsuleV3ArchiveOriginals(value.manifest.backupV3, value.manifest.tree, value.directory, value.root, false)
  else if (value.manifest.version === 7 || value.manifest.version === 8 || value.manifest.version === 9 || value.manifest.version === 10) for (const file of value.manifest.tree.files)
    await readOriginCatalogFile(join(files, file.hash), value.root, { path: file.hash, bytes: file.bytes, sha256: file.hash })
  else for (const file of value.manifest.tree.files) await readExact(join(files, file.hash), value.root, file.bytes, file.hash, ATTACHMENT_MAX_FILE_BYTES)
  if (value.manifest.version === 9) await assertInstalledV3ManyFiles(value.manifest.installedV3Many, value.directory, value.root)
  if(isWorkingAssetArchive5(value.manifest)){
   await assertCapsule2BaseProjectionOriginalBytes4(value.baseOwner4??bad('v5缺genuine base owner'))
   await assertWorkingOriginalBytes5(value.workingOwner5??bad('v5缺genuine working owner'))
  }
  if (value.manifest.version === 4) {
    await assertCapsule2BaseProjectionOriginalBytes4(value.baseOwner4 ?? bad('v4缺genuine base owner'))
    await assertCapsule2MergeContextOriginalBytes4(value.contextOwner4 ?? bad('v4缺genuine context owner'))
  }
  if (value.manifest.version === 3) await assertCapsule2MergeContextOriginalBytes3(value.contextOwner ?? bad('v3缺genuine context owner'))
  await closure(); await assertOwnedRawCapsuleOriginal(value.original)
  return freezeCapsuleValue({ directory: value.directory, manifest: value.manifest, manifestHash: value.manifestHash })
}
function assertBaseProjectionMatches4(base: Capsule2BaseProjectionCommitment4, archive: Extract<Capsule2AssetArchiveManifest, { version: 4 | 5 | 8 | 10 }>): void {
  if (capsuleJson(describeCapsule2BaseProjectionPointer4(base)) !== capsuleJson(archive.baseProjection)
    || base.capsuleId !== archive.capsuleId || base.schemaVersion !== archive.schemaVersion
    || base.sourceContentHash !== archive.sourceContentHash || base.workspaceHistoryObservationHash !== archive.workspaceHistoryObservationHash
    || base.assetReferencesObservationHash !== archive.assetReferencesObservationHash || base.referenceCount !== archive.referenceCount
    || capsuleJson(base.sourceInventory) !== capsuleJson(archive.sourceInventory) || capsuleJson(base.tree) !== capsuleJson(archive.tree)
    || capsuleJson(base.referenceUris) !== capsuleJson(archive.referenceUris)
    || (archive.version === 10 ? base.version !== 3 || capsuleJson(base.installedV3Many) !== capsuleJson(archive.installedV3Many)
      : archive.version === 8 ? base.version !== 2 || capsuleJson(base.installedV3) !== capsuleJson(archive.installedV3) : base.version !== 1))
    return bad('实际base原件、raw file/domain hash与完整archive来源不闭合')
}
async function verifyDetails4(value: Saved) {
  if (value.manifest.version !== 4) return bad('不是v4 archive')
  const info = await verifyBytes(value), contexts = await observeContexts4(value.contextOwner4 ?? bad('v4缺genuine context owner'))
  assertBaseProjectionMatches4(contexts.baseCommitment, value.manifest)
  if (capsuleJson(contexts.inventory) !== capsuleJson(value.manifest.contextOriginals)
    || capsuleJson(describeCapsule2AssetScopeSupplement4(contexts.supplemental)) !== capsuleJson(value.manifest.assetScopeSupplement)) return bad('v4实际完整context/settled观察与持久摘要不符')
  await verifyBytes(value)
  return { info, supplemental: contexts.supplemental }
}
async function verifyDetails5(value:Saved){
 if(!isWorkingAssetArchive5(value.manifest))return bad('不是 Working archive')
 const info=await verifyBytes(value),working=await readWorkingOriginalsInventory5(value.workingOwner5??bad('v5缺genuine working owner'))
 assertBaseProjectionMatches4(working.baseCommitment,value.manifest)
 if(capsuleJson(working.pointer)!==capsuleJson(value.manifest.workingOriginals)||working.manifest.sourceContentHash!==value.manifest.sourceContentHash
   ||capsuleJson(working.manifest.baseProjection)!==capsuleJson(value.manifest.baseProjection)
   ||capsuleJson(describeCapsule5AssetScopeSupplement5(working.observation))!==capsuleJson(value.manifest.assetScopeSupplement))return bad('完整working原件/分区/scope与archive5不符')
 await verifyBytes(value);return{info,workingSupplemental:working.observation,working}
}
async function verifyDetails(value: Saved) {
  if(isWorkingAssetArchive5(value.manifest))return verifyDetails5(value)
  if (value.manifest.version === 4) return verifyDetails4(value)
  const info = await verifyBytes(value)
  const contexts = value.manifest.version === 3 ? await observeContexts(value.contextOwner ?? bad('v3缺genuine context owner')) : undefined
  if (value.manifest.version === 3 && (!contexts || capsuleJson(contexts.inventory) !== capsuleJson(value.manifest.contextOriginals)
    || capsuleJson(describeCapsule2AssetScopeSupplement3(contexts.supplemental)) !== capsuleJson(value.manifest.assetScopeSupplement)))
    return bad('同次实际封存context重放/补充scope与持久v3不符')
  // In v3 the observer can be long-running. Managed copies, manifest, contexts
  // and SQL originals are all read again after it; the earlier byte pass is
  // never treated as proof of the post-observation files.
  if (value.manifest.version === 3) await verifyBytes(value)
  return { info, supplemental: contexts?.supplemental }
}
async function verify(value: Saved): Promise<Capsule2AssetArchiveInfo> { return verifyBytes(value) }
function start(original: OwnedRawCapsuleOriginal) {
  const info = readOwnedRawCapsuleOriginal(original)
  if (used.has(original)) return bad('同一原件已开始或失败，不能重入')
  used.add(original)
  return info
}
function register(value: Saved): PreparedCapsule2AssetArchive {
  const handle: PreparedCapsule2AssetArchive = Object.freeze({ kind: 'prepared-capsule2-complete-asset-archive' })
  archives.set(handle, value)
  return handle
}
async function prepareArchive(original: OwnedRawCapsuleOriginal, version: 1 | 2 | 3): Promise<PreparedCapsule2AssetArchive> {
  const info = start(original), observed = await source(original), capsuleId = basename(info.capsuleDirectory)
  const base = join(info.recoveryDirectory, 'knowledge-complete-assets-v2'), output = join(base, capsuleId), files = join(output, 'files')
  await restoreDirectory(base, info.profileRoot); await restoreDirectory(output, info.profileRoot, true); await restoreDirectory(files, info.profileRoot, true)
  const tree = await captureCapsule2ManagedTreeData(join(info.profileRoot, 'storage', 'assets'), info.profileRoot, files)
  const captured = version === 3 ? await prepareCapsule2MergeContextOriginals3(original) : undefined
  const contexts = captured ? await observeContexts(captured.owner) : undefined
  const supplement = contexts ? describeCapsule2AssetScopeSupplement3(contexts.supplemental) : undefined
  const common = { kind: 'capsule2-complete-asset-archive' as const, material: 'main-managed-tree-and-original-reference-literals' as const,
    certified: false as const, semanticValidationComplete: false as const, permit: false as const, capsuleId,
    sourceInventory: info.originalInventory, ...observed, tree }
  const manifest: Capsule2AssetArchiveManifest = version === 1
    ? freezeCapsuleValue({ ...common, version: 1, referencePolicy: 'retain-literals-without-reference-file-access' })
    : version === 2 ? freezeCapsuleValue({ ...common, version: 2, referencePolicy: 'capture-owned-aliases-retain-unresolved-literals',
      coverage: baseCoverage(observed.assetReferencesObservationHash),
      referenceProvenance: await captureCapsule2AssetReferenceProvenanceOwned3(original, observed, tree) })
    : freezeCapsuleValue({ ...common, version: 3, referencePolicy: 'capture-owned-base-and-supplemental-aliases-retain-unresolved-literals',
      coverage: supplementalCoverage(observed.assetReferencesObservationHash, supplement!), contextOriginals: contexts!.inventory, assetScopeSupplement: supplement!,
      referenceProvenance: await captureCapsule2AssetReferenceProvenance2Owned3(original, { ...observed,
        assetScopeSupplementHash: supplement!.observationHash, referenceUris: capsule2CombinedAssetUris3(observed.referenceUris, supplement!) }, tree) })
  const bytes = Buffer.from(capsuleJson(manifest) + '\n')
  if (manifest.version === 3) assertOriginalBudget(manifest)
  if (bytes.length > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整manifest超预算，不截断')
  await assertOwnedRawCapsuleOriginal(original)
  await writeNew(join(output, 'manifest.json'), bytes, info.profileRoot)
  await syncRestoreDirectory(output); await syncRestoreDirectory(base); await syncRestoreDirectory(info.recoveryDirectory)
  const saved: Saved = { original, root: info.profileRoot, directory: output, manifest, bytes, manifestHash: manifestHash(manifest), contextOwner: captured?.owner }
  await verify(saved)
  return register(saved)
}
/** Legacy capture stays archive v1, without inferred file URI authority. */
export async function prepareCapsule2AssetArchive(original: OwnedRawCapsuleOriginal): Promise<PreparedCapsule2AssetArchive> {
  return prepareArchive(original, 1)
}
/** Explicit Main producer; only the genuine original chooses the profile,
 * base typed observation and captured tree. No caller proofs/paths/URI list. */
export async function prepareCapsule2AssetArchiveWithProvenance3(original: OwnedRawCapsuleOriginal): Promise<PreparedCapsule2AssetArchive> {
  return prepareArchive(original, 2)
}

/** Exclusive next-current capture; the larger limit is solely a consequence
 * of the exact installed receipt, transfer alias and qualified V3 original. */
export async function prepareCapsule2AssetArchiveWithInstalledV3(original: OwnedRawCapsuleOriginal,
  readInstalled: () => Promise<InstalledV3AssetContinuity>) {
  const info = start(original)
  let installed: ReturnType<typeof readInstalledV3AssetContinuity> | undefined
  const capsuleId = basename(info.capsuleDirectory), base = join(info.recoveryDirectory, 'knowledge-complete-assets-v2')
  const output = join(base, capsuleId), files = join(output, 'files'), identities = new Map<string, { dev: string; ino: string }>()
  await restoreDirectory(base, info.profileRoot)
  await restoreDirectory(output, info.profileRoot, true)
  await restoreDirectory(files, info.profileRoot, true)
  const tree = await captureCapsule2ManagedTreeWithInstalledAssets(join(info.profileRoot, 'storage', 'assets'), info.profileRoot, files,
    async (path, destination) => {
      installed ??= readInstalledV3AssetContinuity(await readInstalled(), info.profileRoot)
      const captured = await installed.readAlias(path, destination)
      if (captured) {
        const previous = identities.get(path)
        if (previous && capsuleJson(previous) !== capsuleJson(captured.identity)) return bad('原安装附件 FD 变化')
        identities.set(path, captured.identity)
      }
      return captured?.alias
    })
  const observed = await source(original, undefined, installed?.requirement, installed?.requirement)
  const common = { kind: 'capsule2-complete-asset-archive' as const, material: 'main-managed-tree-and-original-reference-literals' as const,
    certified: false as const, semanticValidationComplete: false as const, permit: false as const, capsuleId,
    sourceInventory: info.originalInventory, ...observed, tree, coverage: baseCoverage(observed.assetReferencesObservationHash) }
  let manifest: Capsule2AssetArchiveManifest
  if (installed && identities.size) {
    const proof = await installed.proofForArchive(tree, output)
    const referenceProvenance = await captureCapsuleInstalledAssetProvenance(original, observed, tree, identities)
    manifest = proof.version === 7
      ? freezeCapsuleValue({ ...common, ...proof, referencePolicy: referencePolicies[7], referenceProvenance })
      : freezeCapsuleValue({ ...common, ...proof, referencePolicy: referencePolicies[9], referenceProvenance })
  } else {
    manifest = freezeCapsuleValue({ ...common, version: 2, referencePolicy: referencePolicies[2],
      referenceProvenance: await captureCapsule2AssetReferenceProvenanceOwned3(original, observed, tree) })
  }
  const bytes = Buffer.from(capsuleJson(manifest) + '\n')
  if (bytes.length > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('已安装附件归档超清单上限')
  assertOriginalBudget(manifest)
  await assertOwnedRawCapsuleOriginal(original)
  await writeNew(join(output, 'manifest.json'), bytes, info.profileRoot)
  await syncRestoreDirectory(output)
  await syncRestoreDirectory(base)
  await syncRestoreDirectory(info.recoveryDirectory)
  const saved: Saved = { original, root: info.profileRoot, directory: output, manifest, bytes, manifestHash: manifestHash(manifest) }
  await verify(saved)
  return register(saved)
}
/** Separate v3 producer. Never upgrades the released base-only v2 factory. */
export async function prepareCapsule2AssetArchiveWithContextProvenance3(original: OwnedRawCapsuleOriginal): Promise<PreparedCapsule2AssetArchive> {
  return prepareArchive(original, 3)
}
/** Explicit archive4 source producer. The genuine base capture is complete
 * before it decides which original SQL jobs still require a live spool. */
export async function prepareCapsule2AssetArchiveWithSettledContextProvenance4(original: OwnedRawCapsuleOriginal): Promise<PreparedCapsule2AssetArchive> {
  const info = start(original), capturedBase = await prepareCapsule2BaseProjection4(original), baseValue = await readCapsule2BaseProjection4(capturedBase.owner)
  const observed = baseValue.commitment, tree = baseValue.tree, capsuleId = basename(info.capsuleDirectory)
  const captured = await prepareCapsule2MergeContextOriginals4(original, capturedBase.owner), contexts = await observeContexts4(captured.owner)
  const supplement = describeCapsule2AssetScopeSupplement4(contexts.supplemental)
  const manifest: Capsule2AssetArchiveManifest = freezeCapsuleValue({ kind: 'capsule2-complete-asset-archive', version: 4,
    material: 'main-managed-tree-and-original-reference-literals', referencePolicy: 'capture-owned-base-and-settled-context-aliases-retain-unresolved-literals',
    certified: false, semanticValidationComplete: false, permit: false, capsuleId, schemaVersion: observed.schemaVersion, sourceInventory: observed.sourceInventory,
    sourceContentHash: observed.sourceContentHash, workspaceHistoryObservationHash: observed.workspaceHistoryObservationHash,
    assetReferencesObservationHash: observed.assetReferencesObservationHash, referenceCount: observed.referenceCount, referenceUris: observed.referenceUris, tree,
    baseProjection: describeCapsule2BaseProjectionPointer4(observed), contextOriginals: contexts.inventory, assetScopeSupplement: supplement, coverage: settledCoverage4(observed.assetReferencesObservationHash, supplement),
    referenceProvenance: await captureCapsule2AssetReferenceProvenance2Owned3(original, { sourceContentHash: observed.sourceContentHash,
      workspaceHistoryObservationHash: observed.workspaceHistoryObservationHash, assetReferencesObservationHash: observed.assetReferencesObservationHash,
      assetScopeSupplementHash: supplement.observationHash, referenceUris: capsule2CombinedAssetUris4(observed.referenceUris, supplement) }, tree) })
  assertOriginalBudget(manifest)
  const bytes = Buffer.from(capsuleJson(manifest) + '\n'), base = join(info.recoveryDirectory, 'knowledge-complete-assets-v2'), output = join(base, capsuleId)
  if (bytes.length > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('v4完整manifest超原预算，不截断')
  await assertOwnedRawCapsuleOriginal(original); await writeNew(join(output, 'manifest.json'), bytes, info.profileRoot)
  await syncRestoreDirectory(output); await syncRestoreDirectory(base); await syncRestoreDirectory(info.recoveryDirectory)
  const saved: Saved = { original, root: info.profileRoot, directory: output, manifest, bytes, manifestHash: manifestHash(manifest),
    baseOwner4: capturedBase.owner, contextOwner4: captured.owner }
  await verifyDetails4(saved); return register(saved)
}
/** One explicit Working5 capture; custom and automatic records of the same
 * original job share one header/object/asset namespace and one actual index. */
export async function prepareCapsule2AssetArchiveWithWorkingProvenance5(original:OwnedRawCapsuleOriginal,
 readInstalled?:()=>Promise<InstalledV3AssetContinuity>):Promise<PreparedCapsule2AssetArchive>{
 const info=start(original),base=await prepareCapsule2BaseProjectionForWorking5(original,readInstalled),observed=base.commitment,tree=observed.tree
 const working=await prepareWorkingOriginals5(original,base.owner),supplement=describeCapsule5AssetScopeSupplement5(working.observation),workingOriginals=describeWorkingOriginals5(working.manifest)
 const capsuleId=basename(info.capsuleDirectory),common={kind:'capsule2-complete-asset-archive',material:'main-managed-tree-and-original-reference-literals',
 certified:false,semanticValidationComplete:false,permit:false,capsuleId,
 schemaVersion:observed.schemaVersion,sourceInventory:observed.sourceInventory,sourceContentHash:observed.sourceContentHash,workspaceHistoryObservationHash:observed.workspaceHistoryObservationHash,
 assetReferencesObservationHash:observed.assetReferencesObservationHash,referenceCount:observed.referenceCount,referenceUris:observed.referenceUris,tree,baseProjection:describeCapsule2BaseProjectionPointer4(observed),
 workingOriginals,assetScopeSupplement:supplement,coverage:workingCoverage5(observed.assetReferencesObservationHash,supplement)} as const
 const binding={sourceContentHash:observed.sourceContentHash,workspaceHistoryObservationHash:observed.workspaceHistoryObservationHash,
 assetReferencesObservationHash:observed.assetReferencesObservationHash,assetScopeSupplementHash:supplement.observationHash,referenceUris:capsule5CombinedAssetUris5(observed.referenceUris,supplement)}
 const referenceProvenance = observed.version === 1 ? await captureCapsule2AssetReferenceProvenance2Owned3(original, binding, tree)
   : await captureCapsuleInstalledCombinedAssetProvenance(original, binding, tree, base.installedIdentities ?? bad('已安装V3 base 缺实际FD证明'))
 const manifest: Capsule2AssetArchiveManifest = freezeCapsuleValue(observed.version === 3
   ? { ...common, version: 10, referencePolicy: referencePolicies[10], installedV3Many: observed.installedV3Many, referenceProvenance }
   : observed.version === 2 ? { ...common, version: 8, referencePolicy: referencePolicies[8], installedV3: observed.installedV3, referenceProvenance }
   : { ...common, version: 5, referencePolicy: referencePolicies[5], referenceProvenance })
 assertOriginalBudget(manifest);const bytes=Buffer.from(capsuleJson(manifest)+'\n'),parent=join(info.recoveryDirectory,'knowledge-complete-assets-v2'),directory=join(parent,capsuleId)
 if(bytes.length>CAPSULE2_RAW_MAX_JSON_BYTES)return bad('archive5完整manifest超原预算，不截断')
 await assertOwnedRawCapsuleOriginal(original);await writeNew(join(directory,'manifest.json'),bytes,info.profileRoot);await syncRestoreDirectory(directory);await syncRestoreDirectory(parent);await syncRestoreDirectory(info.recoveryDirectory)
 const saved:Saved={original,root:info.profileRoot,directory,manifest,bytes,manifestHash:manifestHash(manifest),baseOwner4:base.owner,workingOwner5:working.owner}
 await verifyBytes(saved);return register(saved)
}
export async function prepareCapsule2AssetArchiveFromVerifiedV3(stage: BackupV3RestoreSqlStage, owner: BackupV3RestoreSource): Promise<PreparedCapsule2AssetArchive> {
  const original = await assertBackupV3RestoreSqlStageOriginal(stage, owner), info = start(original)
  const capsuleId = basename(info.capsuleDirectory), parent = join(info.recoveryDirectory, 'knowledge-complete-assets-v2')
  const output = join(parent, capsuleId), files = join(output, 'files')
  await restoreDirectory(parent, info.profileRoot)
  await restoreDirectory(output, info.profileRoot, true)
  await restoreDirectory(files, info.profileRoot, true)
  const { archive, proof, tree } = await copyCapsuleV3ArchiveOriginals(owner, output, info.profileRoot)
  const observed = await source(original, archive)
  const manifest: Capsule2AssetArchiveManifest = freezeCapsuleValue({ kind: 'capsule2-complete-asset-archive',
    version: 6, material: 'main-managed-tree-and-original-reference-literals', referencePolicy: referencePolicies[6],
    certified: false, semanticValidationComplete: false, permit: false, capsuleId, sourceInventory: info.originalInventory,
    ...observed, tree, backupV3: proof, coverage: baseCoverage(observed.assetReferencesObservationHash),
    referenceProvenance: await captureCapsuleV3PortableAssetProvenance(observed, tree, files, info.profileRoot) })
  assertOriginalBudget(manifest)
  const bytes = Buffer.from(capsuleJson(manifest) + '\n')
  if (bytes.length > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('V3完整manifest超原预算')
  await assertBackupV3RestoreSqlStageOriginal(stage, owner)
  await writeNew(join(output, 'manifest.json'), bytes, info.profileRoot)
  await syncRestoreDirectory(output)
  await syncRestoreDirectory(parent)
  await syncRestoreDirectory(info.recoveryDirectory)
  const saved: Saved = { original, root: info.profileRoot, directory: output, manifest, bytes, manifestHash: manifestHash(manifest) }
  await verifyBytes(saved)
  return register(saved)
}

export async function reopenCapsule2AssetArchive(original: OwnedRawCapsuleOriginal, expectedManifestHash: string): Promise<PreparedCapsule2AssetArchive> {
  return (await reopenArchive(original, expectedManifestHash)).archive
}

async function reopenArchive(original: OwnedRawCapsuleOriginal, expectedManifestHash: string) {
  const info = start(original), capsuleId = basename(info.capsuleDirectory), output = join(info.recoveryDirectory, 'knowledge-complete-assets-v2', capsuleId)
  await directory(output, info.profileRoot)
  const text = await readCapsule2AssetManifest(join(output, 'manifest.json'), info.profileRoot), manifest = parse(text, capsuleId, expectedManifestHash)
  const v3 = manifest.version === 6
    ? await readCapsuleV3ArchiveOriginals(manifest.backupV3, manifest.tree, output, info.profileRoot, true)
    : undefined
  const installed = manifest.version === 7 ? manifest.installedV3 : manifest.version === 9 ? manifest.installedV3Many : undefined
  const observed = await source(original, v3, installed)
  if (capsuleJson(manifest.sourceInventory) !== capsuleJson(info.originalInventory)) return bad('原SQL清单不符')
  for (const key of ['schemaVersion','sourceContentHash','workspaceHistoryObservationHash','assetReferencesObservationHash','referenceCount','referenceUris'] as const)
    if (capsuleJson(manifest[key]) !== capsuleJson(observed[key])) return bad('完整实际SQL来源或原引用变化')
  const base5=isWorkingAssetArchive5(manifest)?await reopenCapsule2BaseProjectionForWorking5(original,manifest.baseProjection.baseManifestHash,manifest.baseProjection):undefined
  const working5=isWorkingAssetArchive5(manifest)?await reopenWorkingOriginals5(original,base5??bad('v5缺base owner'),manifest.workingOriginals.manifestHash,manifest.workingOriginals):undefined
  const base4 = manifest.version === 4 ? await reopenCapsule2BaseProjection4(original, manifest.baseProjection.baseManifestHash, manifest.baseProjection) : undefined
  const captured4 = manifest.version === 4 ? await reopenCapsule2MergeContextOriginals4(original, base4 ?? bad('v4缺base owner'), manifest.contextOriginals) : undefined
  const captured = manifest.version === 3 ? await reopenCapsule2MergeContextOriginals3(original, manifest.contextOriginals) : undefined
  const saved: Saved = { original, root: info.profileRoot, directory: output, manifest, bytes: Buffer.from(text), manifestHash: expectedManifestHash, contextOwner: captured?.owner, baseOwner4: base5??base4, contextOwner4: captured4?.owner,workingOwner5:working5 }
  // Cold creation must join the persisted supplement to actual sealed context
  // observations before minting its first owner. Later byte-only tails may
  // rely on that immutable pinned manifest; they never reauthorize SQL DTOs.
  const working = isWorkingAssetArchive5(manifest) ? await verifyDetails5(saved) : undefined
  if (manifest.version === 3 || manifest.version === 4) await verifyDetails(saved)
  else if (!isWorkingAssetArchive5(manifest)) await verify(saved)
  return { archive: register(saved), working }
}

export interface ReopenedCapsule2ArchiveInputs5 { readonly kind: 'main-reopened-capsule2-archive-inputs5' }
const reopenedArchiveInputs = new WeakMap<ReopenedCapsule2ArchiveInputs5, {
  archive: PreparedCapsule2AssetArchive
  working: Awaited<ReturnType<typeof verifyDetails5>>
}>()

/** The first full Working5 observation belongs only to this cold reopen and
 * the exact registered archive until the enclosing source capture ends. */
export async function withReopenedCapsule2ArchiveInputs5<T>(original: OwnedRawCapsuleOriginal, expectedManifestHash: string,
  run: (archive: PreparedCapsule2AssetArchive, scope?: ReopenedCapsule2ArchiveInputs5) => Promise<T>): Promise<T> {
  const { archive, working } = await reopenArchive(original, expectedManifestHash)
  if (!working) return run(archive)
  const scope: ReopenedCapsule2ArchiveInputs5 = Object.freeze({ kind: 'main-reopened-capsule2-archive-inputs5' })
  reopenedArchiveInputs.set(scope, { archive, working })
  try {
    const result = await run(archive, scope)
    await assertCapsule2AssetArchiveOriginalBytes3(archive)
    return result
  } finally { reopenedArchiveInputs.delete(scope) }
}
export async function readCapsule2AssetArchive(handle: PreparedCapsule2AssetArchive): Promise<Capsule2AssetArchiveInfo> {
  const value = archives.get(handle)
  if (!value) return bad('不是Main实际准备的私有句柄')
  return verify(value)
}
export async function assertCapsule2AssetArchiveOriginalBytes3(handle: PreparedCapsule2AssetArchive): Promise<void> {
  const value = archives.get(handle)
  if (!value) return bad('不是Main实际archive原件owner')
  await verifyBytes(value)
}

/** Fixed Main source seam. A serialized archive/ref or caller inventory cannot
 * obtain an original; the complete archive and its immutable SQL are reread. */
export async function readCapsule2ArchiveSourceOriginal(handle: PreparedCapsule2AssetArchive): Promise<OwnedRawCapsuleOriginal> {
  const value = archives.get(handle)
  if (!value) return bad('不是Main实际准备的私有句柄')
  await verify(value)
  return value.original
}

/** Pure original manifest codec; parsing never creates an archive/source handle. */
export const parseCapsule2CompleteAssetArchiveManifest = parse

/** One complete fresh archive read supplies both facts to the fixed SQL owner.
 * The private registry binds the original; no caller pair or inventory can
 * choose it. Every original, manifest and blob check remains in verify. */
export async function readCapsule2ArchiveSourceInputs(handle: PreparedCapsule2AssetArchive) {
  const value = archives.get(handle)
  if (!value) return bad('不是Main实际准备的私有句柄')
  const read = await verifyDetails(value)
  return Object.freeze({ original:value.original,value:read.info,
    ...('supplemental' in read&&read.supplemental?{supplemental:read.supplemental}:{}),
    ...('workingSupplemental' in read?{workingSupplemental:read.workingSupplemental}:{}) })
}

/** Pure counting of unique sealed physical files in their separate namespaces.
 * SQL originals are added by each existing DAG owner, using its original cap. */
export function capsule2AssetArchiveOriginalBytes3(archive: Capsule2AssetArchiveManifest): number {
  const bytes = archive.tree.files.reduce((total, file) => total + file.bytes, 0)
    + (archive.version === 3 || archive.version === 4 ? archive.contextOriginals.files.reduce((total, file) => total + file.bytes, 0) : 0)
    + (archive.version === 4 ||isWorkingAssetArchive5(archive) ? archive.baseProjection.baseManifestFile.bytes : 0)
    + (isWorkingAssetArchive5(archive)?archive.workingOriginals.originalFileBytes+archive.workingOriginals.manifestFile.bytes:0)
    + (archive.version === 6 ? archive.backupV3.files.reduce((total, file) => total + (isBackupV3AssetPath(file.relativePath) ? 0 : file.bytes), 0) : 0)
    + (archive.version === 9 || archive.version === 10 ? archive.installedV3Many.transfers.reduce((total, file) => total + file.bytes, 0) : 0)
  if (!Number.isSafeInteger(bytes)) return bad('全部managed/context实际原字节计数越界')
  return bytes
}
function assertOriginalBudget(archive: Capsule2AssetArchiveManifest): void {
  const bytes = capsule2AssetArchiveOriginalBytes3(archive) + archive.sourceInventory.reduce((total, file) => total + file.bytes, 0)
  if (!Number.isSafeInteger(bytes) || bytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES) return bad('SQL+managed+context超原DAG总域')
}

/** Exact registered archive -> registered base owner. No caller path, proof
 * pair or matching hash DTO can select this full private read. The base proof
 * is not duplicated into the ordinary source material/manifest payload. */
export async function readCapsule2ArchiveBaseProjection4(handle: PreparedCapsule2AssetArchive): Promise<Awaited<ReturnType<typeof readCapsule2BaseProjection4>>> {
  const value = archives.get(handle)
  if (!value || value.manifest.version !== 4) return bad('不是genuine archive4 owner')
  await verifyBytes(value)
  const owner=value.baseOwner4??bad('缺genuine base owner')
  const base = await readCapsule2BaseProjection4(owner)
  assertBaseProjectionMatches4(base.commitment, value.manifest)
  await verifyBytes(value)
  return base
}

/** Registry-only full Working5 inventory/text source for actual native
 * transport builders. Non5 sources have no such original and return undefined. */
export async function readCapsule2ArchiveWorkingOriginals5(handle:PreparedCapsule2AssetArchive){
 const value=archives.get(handle);if(!value)return bad('不是genuine archive owner')
 await verifyBytes(value);if(!isWorkingAssetArchive5(value.manifest))return undefined
 const working=await readWorkingOriginalsInventory5(value.workingOwner5??bad('v5缺working owner'))
 assertBaseProjectionMatches4(working.baseCommitment,value.manifest)
 if(capsuleJson(working.pointer)!==capsuleJson(value.manifest.workingOriginals)||capsuleJson(describeCapsule5AssetScopeSupplement5(working.observation))!==capsuleJson(value.manifest.assetScopeSupplement))return bad('working5实际原件与archive不闭合')
 await verifyBytes(value);return working
}

/** A fixed genuine archive read supplies its same-invocation Working5 result.
 * Runtime originals stay outside source packets, archive manifests and hashes.
 * No DTO, selector, cache or caller verification mode enters this seam. */
export async function readCapsule2ArchiveSourceInputsWithWorking5(handle: PreparedCapsule2AssetArchive, scope?: ReopenedCapsule2ArchiveInputs5) {
  const value = archives.get(handle)
  if (!value) return bad('不是Main实际准备的私有句柄')
  const read = scope ? await readReopenedArchiveInputs5(handle, value, scope) : await verifyDetails(value)
  return Object.freeze({ original:value.original,value:read.info,
    ...('supplemental' in read&&read.supplemental?{supplemental:read.supplemental}:{}),
    ...('workingSupplemental' in read?{workingSupplemental:read.workingSupplemental}:{}),
    working:'working' in read?read.working:undefined })
}

async function readReopenedArchiveInputs5(archive: PreparedCapsule2AssetArchive, saved: Saved, scope: ReopenedCapsule2ArchiveInputs5) {
  const entry = reopenedArchiveInputs.get(scope)
  if (!entry || entry.archive !== archive || !isWorkingAssetArchive5(saved.manifest)) return bad('不是本次冷重开的实际archive5')
  const info = await verifyBytes(saved)
  if (reopenedArchiveInputs.get(scope) !== entry) return bad('archive5冷重开范围已结束')
  return { ...entry.working, info }
}

/** Fixed genuine-owner dispatch for the tail of a same-call complete read.
 * Only archive5 has the complete sealed Working input closure needed here.
 * This returns no SQL projection, cached observation or semantic permission. */
export async function tryAssertCapsule2ArchiveWorking5OriginalBytes5(handle: PreparedCapsule2AssetArchive): Promise<boolean> {
  const saved = archives.get(handle)
  if (!saved) return bad('不是genuine archive owner')
  if (!isWorkingAssetArchive5(saved.manifest)) return false
  await verifyBytes(saved)
  return true
}
