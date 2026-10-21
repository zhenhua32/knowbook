import { capsuleJson } from '../../src/main/database/restore-knowledge-capsule-model'
import { knowledgeGroupComparisonKey, knowledgePayloadHash, type CapsuleKnowledgePayload, type KnowledgeDenial,
  type KnowledgeOccupancy, type KnowledgeHistoricalMaterial } from '../../src/main/database/restore-knowledge-payload-model'
import { requiredDagInterpretationHash } from '../../src/main/database/restore-knowledge-required-dag-model'
import type { QualifiedKnowledgePayload2 } from '../../src/main/database/restore-knowledge-qualified-payload-model'

/** Entirely synthetic structure/comparison data. No SQL/Main/old-proof validity,
 * real source, mount, actual originals or certification is asserted or minted. */
export const uid = (value: number): string => '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
const digest = (value: string): string => value.repeat(64)
export function qualifiedStructureFixture(mount = 1): QualifiedKnowledgePayload2 {
  const capsule = { kind: 'durable-sql-capsule-ref' as const, version: 1 as const, operationId: uid(1), capsuleId: uid(2), manifestHash: digest('a') }
  const sqlRef = { table: 'synced_operations', key: [['text', Buffer.from('row').toString('base64')] as const], occurrence: 0, rowHash: digest('b') }
  const tuple = { groupId: uid(3), creationId: uid(4), createdAt: '2040-01-02T03:04:05.006Z', origin: {
    version: 1 as const, documentId: ' old:源\0 ', pathAtCreation: ' Old/路径 ', firstInstanceId: uid(5) } }
  const comparisonKey = knowledgeGroupComparisonKey(tuple)
  const before = { kind: 'synced-group', id: tuple.groupId, creationId: tuple.creationId, createdAt: tuple.createdAt, origin: tuple.origin }
  // Deliberately opaque/unvalidated historical bodies: only the comparison
  // before tuple and same-envelope row edges are exercised by this pure model.
  const denial = { proof: { before }, comparisonKey, source: sqlRef, receipt: {}, job: {}, mandatoryMaterial: [sqlRef] } as unknown as KnowledgeDenial
  const occupancy: KnowledgeOccupancy = { namespace: 'block', id: 'same:历史\0 opaque', kind: 'history', ownerKind: 'document', ownerId: 'A',
    knownBirth: null, source: sqlRef, incarnationKey: null }
  const material: KnowledgeHistoricalMaterial = { fact: { family: 'group-ack', version: null, evidenceClass: 'durable-only',
    locator: { table: 'synced_operations', key: ['row'], rowHash: digest('c') }, supports: [] }, primary: sqlRef, supports: [] }
  const projection: CapsuleKnowledgePayload = {
    kind: 'durable-sql-knowledge-payload', version: 1, material: 'durable-sql-only', capsule, schemaVersion: 27,
    workspaceScope: uid(6), recoveryEpoch: uid(7), schemaHash: digest('d'), inventoryHash: digest('e'), encoding: 'UTF-8', lifecycleAvailability: 'schema27',
    originals: [{ table: 'synced_operations', columns: ['client_operation_id', 'integer_value', 'real_value', 'empty_value'], primaryKey: ['client_operation_id'],
      fullColumnsHash: digest('f'), disclosure: 'identity-projection', rows: [{ ...sqlRef, cells: [sqlRef.key[0], ['integer', '9223372036854775807'], ['real-ieee754-le', '0000000000000080'], ['null']] }] }],
    groups: [{ tuple, comparisonKey, originalOriginJson: capsuleJson(tuple.origin), source: sqlRef,
      lifecycle: { groupId: tuple.groupId, creationId: tuple.creationId, state: 'active', stateVersion: 1, exposure: 'never', createHistoryId: null,
        activationRevision: uid(8), activationTopologyRevision: uid(9), activationHash: digest('a'), activationInstances: [] },
      guards: { revision: uid(8), topologyRevision: uid(9), historyCursor: uid(10), historyPosition: 0 }, lifecycleSource: null, retirement: null, createJournalSource: null }],
    exposures: [{ attempt: { id: uid(11), requestHash: digest('a'), channel: 'synthetic comparison', targetFingerprint: digest('a'),
      publicationHash: digest('a'), state: 'confirmed', createdAt: tuple.createdAt, confirmedAt: tuple.createdAt }, kind: 'member-attempt',
      members: [{ tuple, comparisonKey, revision: uid(8), topologyRevision: uid(9), semanticHash: digest('a'), source: sqlRef }], source: sqlRef }],
    observations: [{ source: sqlRef, marker: { kind: 'synced-remote-exposure-observation', version: 1, workspaceScope: uid(6), recoveryEpoch: uid(7),
      incarnation: tuple, observedAt: tuple.createdAt, remote: { channel: 'webdav-manifest5-observed', targetFingerprint: digest('a'), remoteWorkspaceId: uid(12),
        manifestHash: digest('a'), groupHash: digest('a'), closureHash: digest('a') }, local: { state: 'active', revision: uid(8), topologyRevision: uid(9),
        semanticHash: digest('a'), createHistoryId: null }, persistence: { kind: 'active-confirmed', attemptId: uid(11) } } }],
    denials: [denial], occupancy: [occupancy], historicalMaterial: [material], identities: [], instances: [], hostStates: [], pins: [], bindings: [],
    databaseViewReferences: [], hostJournals: [], exchangeCuts: [], recoveryBoundaries: [], restoreLineage: [], groupHistories: [], archivedGroupHistories: []
  }
  const originalOrigin = { kind: 'no-prior-coverage-references' as const, version: 1 as const, databaseFilesHash: digest('a'), rawRequirementsHash: digest('b') }
  const originalCapsule = { kind: 'restore-knowledge-origin-capsule-ref' as const, version: 1 as const, namespace: { kind: 'native' as const },
    operationId: capsule.operationId, capsuleId: capsule.capsuleId, manifestHash: capsule.manifestHash, readerVersion: 'knowbook-durable-sql-v1' as const }
  return { kind: 'qualified-durable-sql-knowledge-payload-diagnostic', version: 2,
    capsule: { ...originalCapsule, namespace: { kind: 'imported-bundle', mountId: uid(100 + mount), bundleDescriptorHash: digest('a') } },
    originalBinding: { capsule: originalCapsule, interpretationHash: requiredDagInterpretationHash(originalOrigin), rawRequirementsHash: originalOrigin.rawRequirementsHash, requiredRoots: [] },
    originalOrigin, projection, projectionHash: knowledgePayloadHash(projection), projectionStructure: 'descriptor-safe-local-rows-only',
    projectionSemanticsAuthenticated: false, certified: false, acceptedCoverage: false, effective: false, permit: false }
}
export function changeProjection(input: QualifiedKnowledgePayload2, change: (projection: CapsuleKnowledgePayload) => CapsuleKnowledgePayload): QualifiedKnowledgePayload2 {
  const projection = change(input.projection)
  return { ...input, projection, projectionHash: knowledgePayloadHash(projection) }
}
