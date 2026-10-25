import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES, type Capsule2RawSqlTable, type Capsule2TableRole } from './restore-knowledge-capsule2-raw-model'
import type { readRootKnowledgeConservationContent3 } from './restore-knowledge-root3-read'

type Inputs = Awaited<ReturnType<typeof readRootKnowledgeConservationContent3>>
export const content3Invalid = (message: string): never => { throw new Error('完整恢复内容选择无效：' + message + '；身份映射、历史切点、资产提交及accepted覆盖仍须完整安装规划。') }
const actions = {
  content: 'map-and-rewrite-before-install',
  'identity-evidence': 'merge-qualified-identity-evidence',
  'execution-history-evidence': 'retain-evidence-and-establish-fresh-cut',
  derived: 'rebuild',
  'policy-unresolved': 'preserve-current-policy-no-source-replay'
} as const satisfies Record<Capsule2TableRole, string>
const tableHash = (table: Capsule2RawSqlTable) => capsuleBytesHash('knowbook.restore.content3.original-table.v1\0' + capsuleJson(table))

/** Data only. Source rows are candidate business values, still in their exact
 * original encoding/storage classes. Nothing here is executable SQL or an ID
 * allocation. Every other table has an explicit disposition and a binding to
 * its complete original. Group headers still contain original CAS/cursors as
 * evidence; the explicit execution-column plan below requires replacing them.
 * Credentials and plugin grants are outside the candidate business tables. */
export function selectRootRestoreContent3(inputs: Inputs) {
  const { source, current, knowledge } = inputs
  const candidateTables = source.source.sourceContent.tables.filter(table => table.role === 'content')
  const dispositions = ([['source', source], ['current', current]] as const).flatMap(([side, packet]) => {
    const payloads = knowledge.constraints.payloads.filter(payload => !payload.witness.domain.length && payload.witness.side === side)
    if (payloads.length !== 1 || payloads[0].input.knowledge.sourceMaterialHash !== packet.materialHash
      || payloads[0].input.knowledge.assetArchiveHash !== packet.assetArchiveHash) return content3Invalid('角色完整包与原域见证不一致')
    return packet.source.sourceContent.tables.map(table => ({ side, payload: payloads[0].key, table: table.name,
      role: table.role, rows: table.rows.length, originalTableHash: tableHash(table),
      action: side === 'current' && table.role === 'content' ? 'retain-current-for-conflict-check' as const : actions[table.role],
      selectedAsIncomingContent: side === 'source' && table.role === 'content' }))
  })
  const body = { kind: 'complete-root-restore-content-selection' as const, version: 3 as const,
    root: knowledge.constraints.root, conservationHash: knowledge.conservationHash,
    sourceMaterialHash: source.materialHash, currentMaterialHash: current.materialHash,
    sourceEncoding: source.source.sourceContent.encoding, currentEncoding: current.source.sourceContent.encoding,
    sourceSchemaVersion: source.source.sourceContent.schemaVersion, currentSchemaVersion: current.source.sourceContent.schemaVersion,
    sourceAssetArchiveHash: source.assetArchiveHash, currentAssetArchiveHash: current.assetArchiveHash,
    candidateTables, dispositions,
    executionColumns: [
      { table: 'documents', column: 'updated_at', action: 'fresh-document-cas' },
      { table: 'synced_groups', column: 'revision', action: 'fresh-group-cas' },
      { table: 'synced_groups', column: 'topology_revision', action: 'fresh-topology-cas' },
      { table: 'synced_groups', column: 'history_cursor', action: 'fresh-history-baseline' },
      { table: 'synced_groups', column: 'history_position', action: 'reset-history-position-to-zero' },
      { table: 'synced_instances', column: 'binding_version', action: 'fresh-instance-binding' }
    ] as const,
    derivedTables: ([['source', source], ['current', current]] as const).flatMap(([side, packet]) =>
      packet.source.sourceContent.derivedTablesNotRepeated.map(table => ({ side, table, action: 'rebuild' as const }))),
    identities: 'requires-complete-qualified-allocation-and-reference-rewrite' as const,
    history: 'requires-fresh-workspace-epoch-group-cas-and-host-cut' as const,
    assets: 'requires-rollbackable-original-bound-staging' as const,
    sourcePolicyReplayAllowed: false as const, originalInputClosureAuthenticated: true as const,
    semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return content3Invalid('完整候选超过原有限材料预算，不能截断')
  return freezeCapsuleValue({ ...body, selectionHash: capsuleBytesHash('knowbook.restore.content3.selection.v1\0' + encoded) })
}
