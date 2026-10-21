import type { CoverageCapsuleReference, CoverageCutReference, CoverageNamespace, CoverageRootReference,
  KnowledgeRestoreReceiptV2, RawCoverageRequirement, RawPriorCoverageRequirements,
  SyncedKnowledgeCoverageLinkV1, SyncedKnowledgeCoverageV1 } from '../../src/main/database/restore-knowledge-coverage-model'
import { coverageOperationId, coverageReceiptKey, coverageSettingKey, rawPriorCoverageRequirementsHash,
  syncedKnowledgeCoverageCutHash, syncedKnowledgeCoverageHash } from '../../src/main/database/restore-knowledge-coverage-model'

/** Deliberately caller-constructible pure DTOs. No SQLite row, ACK, certified
 * original, accepted DAG, bundle interpreter, stage or fence exists here. */
export const id = (value: number): string => '00000000-0000-0000-0000-' + value.toString(16).padStart(12, '0')
export const hash = (value: number): string => value.toString(16).padStart(64, '0')
export const at = '2042-03-04T05:06:07.008Z'
export const native: CoverageNamespace = { kind: 'native' }
export const bundle: CoverageNamespace = { kind: 'imported-bundle', mountId: id(900), bundleDescriptorHash: hash(901) }
export function capsule(value: number, namespace: CoverageNamespace = native): CoverageCapsuleReference {
  return { kind: 'restore-knowledge-origin-capsule-ref', version: 1, namespace, operationId: id(10),
    capsuleId: id(value), manifestHash: hash(value), readerVersion: 'knowbook-durable-sql-v1' }
}
export function root(value: number, namespace: CoverageNamespace = native, operationId = id(20)): CoverageRootReference {
  return { kind: 'restore-knowledge-origin-root-ref', version: 1, namespace, operationId,
    dagId: id(value), rootHash: hash(value), readerVersion: 'knowbook-required-sql-knowledge-dag-v2' }
}
export function ordinaryCut(operationId = id(10)): CoverageCutReference {
  return { kind: 'ordinary-empty-epoch-cut', version: 1, operationId, beforeWorkspaceScope: id(100),
    afterWorkspaceScope: id(101), beforeEpoch: id(102), afterEpoch: id(103), documentBoundary: at, acceptedAt: at }
}
export function historyCut(operationId = id(10)): CoverageCutReference {
  return { kind: 'synced-recovery-epoch-cut', version: 1, operationId, workspaceScope: id(101),
    beforeEpoch: id(102), afterEpoch: id(103), documentBoundary: at, acceptedAt: at, boundaryHash: hash(104), epochRequestHash: hash(105) }
}
export function requirements(): RawPriorCoverageRequirements {
  return { kind: 'restore-knowledge-unresolved-required-roots', version: 1, schemaVersion: 27, entries: [] }
}
export function rawRequirement(value: number, cut: CoverageCutReference = ordinaryCut(id(value))): RawCoverageRequirement {
  const operationId = id(value), rowHash = hash(value), historical = cut.kind === 'synced-recovery-epoch-cut'
  return { operationId, coverageHash: hash(value + 1), receiptHash: hash(value + 2), root: root(value + 3, native, operationId), cut, acceptedAt: at,
    supports: { coverage: { table: 'app_settings', key: [coverageSettingKey(operationId)], rowHash },
      link: { table: 'synced_operations', key: [coverageOperationId(operationId)], rowHash },
      receipt: { table: 'app_settings', key: [coverageReceiptKey(operationId)], rowHash },
      anchor: { table: 'synced_exposure_attempts', key: [coverageOperationId(operationId)], rowHash },
      boundary: historical ? { table: 'app_settings', key: ['synced.recovery.history.v1.' + operationId], rowHash } : null,
      epoch: historical ? { table: 'synced_operations', key: ['synced:recovery-epoch:v1:' + operationId], rowHash } : null } }
}
export interface StructureFixture {
  coverage: SyncedKnowledgeCoverageV1; link: SyncedKnowledgeCoverageLinkV1; receipt: KnowledgeRestoreReceiptV2
}
export function structureFixture(): StructureFixture {
  const rawHash = rawPriorCoverageRequirementsHash(requirements()), cut = ordinaryCut(), operationId = id(10)
  const coverage: SyncedKnowledgeCoverageV1 = { kind: 'synced-restore-knowledge-coverage', version: 1,
    readerVersion: 'knowbook-accepted-coverage-structure-v1', material: 'durable-sql-only', operationId, stageBase: 'current',
    source: { capsule: capsule(30, bundle), interpretationHash: hash(200), rawRequirementsHash: rawHash, requiredRoots: [] },
    current: { capsule: capsule(31), interpretationHash: hash(201), rawRequirementsHash: rawHash, requiredRoots: [] },
    root: root(32, native, operationId), rootMaterialHash: hash(202), planHash: hash(203),
    target: { workspaceScope: id(101), recoveryEpoch: id(103), documentBoundary: at }, cut, acceptedAt: at }
  return tupleFor(coverage)
}
/** Derives syntactic backwards hashes only. It is not a producer or acceptance. */
export function tupleFor(coverage: SyncedKnowledgeCoverageV1): StructureFixture {
  const link: SyncedKnowledgeCoverageLinkV1 = { kind: 'synced-restore-knowledge-coverage-link', version: 1, operationId: coverage.operationId,
    coverageHash: syncedKnowledgeCoverageHash(coverage), root: structuredClone(coverage.root), rootMaterialHash: coverage.rootMaterialHash,
    planHash: coverage.planHash, cutHash: syncedKnowledgeCoverageCutHash(coverage.cut), target: structuredClone(coverage.target), acceptedAt: coverage.acceptedAt }
  const receipt: KnowledgeRestoreReceiptV2 = { kind: 'controlled-database-restore-receipt', version: 2, material: 'durable-sql-only',
    operationId: coverage.operationId, stageBase: 'current', source: structuredClone(coverage.source.capsule), current: structuredClone(coverage.current.capsule),
    coverageHash: link.coverageHash, root: structuredClone(coverage.root), rootMaterialHash: coverage.rootMaterialHash, planHash: coverage.planHash,
    cutHash: link.cutHash, target: structuredClone(coverage.target), acceptedAt: coverage.acceptedAt }
  return { coverage: structuredClone(coverage), link, receipt }
}
export type Mutable<T> = { -readonly [Key in keyof T]: T[Key] extends object ? Mutable<T[Key]> : T[Key] }
export const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>
