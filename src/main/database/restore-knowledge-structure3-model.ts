import { parseSyncedBlockPayload, serializeSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { deriveRootRestoreDatabaseReferences3 } from './restore-knowledge-database3-model'
import { graph3Conflict, graph3Key, graph3PatchTable, graph3Rows, type Graph3Inputs } from './restore-knowledge-graph3-data'

type Kind = 'document' | 'block' | 'group'
type Row = Record<string, unknown>
const text = (value: unknown): string => typeof value === 'string' ? value : graph3Conflict('expected-structure-text', typeof value)

/** Column-level intermediate data only. In particular a forked canonical ID
 * still has its ORIGINAL binding keys and Origin. Those require a separate
 * provenance/range transform before this can be a wire or installation input.
 * Path strings and template-local identities are never structural SQL IDs. */
export function deriveRootRestoreStructureReferences3(data: Graph3Inputs) {
  const database = deriveRootRestoreDatabaseReferences3(data)
  const source = data.inputs.source.source.sourceContent
  const rows = (name: string) => graph3Rows(source, name).map(row => row.value)
  const documents = new Map(rows('documents').map(row => [text(row.id), row]))
  const blocks = new Map(rows('blocks').map(row => [text(row.id), row]))
  const groups = new Map(rows('synced_groups').map(row => [text(row.id), row]))
  const canonical = new Map(rows('synced_group_blocks').map(row => [text(row.id), row]))
  const instances = new Map(rows('synced_instances').map(row => [text(row.instance_id), row]))
  const assignments = new Map<string, typeof data.value.assignments>()
  for (const item of data.value.assignments) {
    const key = graph3Key(item.kind, item.sourceId)
    assignments.set(key, [...(assignments.get(key) ?? []), item])
  }
  const sourceRows = (kind: Kind, id: string): Row | undefined => kind === 'document' ? documents.get(id)
    : kind === 'group' ? groups.get(id) : blocks.get(id) ?? canonical.get(id)
  const physical = (kind: Kind, id: string) => {
    const row = sourceRows(kind, id)
    const slots = (assignments.get(graph3Key(kind, id)) ?? []).filter(item => item.physical && !item.ambiguous)
    if (!row || slots.length !== 1) return graph3Conflict('missing-or-ambiguous-physical-structure', { kind, id })
    const slot = slots[0], ownerKind = kind !== 'block' ? null : blocks.has(id) ? 'document' : 'group'
    const ownerId = ownerKind === 'document' ? row.document_id : ownerKind === 'group' ? row.group_id : null
    if (slot.birth !== row.created_at || slot.ownerKind !== ownerKind || slot.ownerId !== ownerId
      || kind === 'group' && !slot.targetCreationId) return graph3Conflict('structure-allocation-owner-or-birth', { kind, id })
    return slot
  }
  // Blocks and canonical children share one identity namespace; instances are
  // the very same host block, never a second allocation selected by spelling.
  for (const id of canonical.keys()) if (blocks.has(id)) return graph3Conflict('duplicate-physical-block-owner', id)
  const claimed = new Set<string>()
  for (const [kind, values] of [['document', documents], ['block', blocks], ['block', canonical], ['group', groups]] as const) {
    for (const id of values.keys()) {
      const target = graph3Key(kind, physical(kind, id).targetId)
      if (claimed.has(target)) return graph3Conflict('duplicate-target-structure-identity', { kind, id })
      claimed.add(target)
    }
  }
  const map = (kind: Kind, id: unknown): string => physical(kind, text(id)).targetId
  const parent = (row: Row, ownerColumn: 'document_id' | 'group_id'): string | null => {
    if (row.parent_block_id === null) return null
    const id = text(row.parent_block_id), ancestor = ownerColumn === 'document_id' ? blocks.get(id) : canonical.get(id)
    if (!ancestor || ancestor[ownerColumn] !== row[ownerColumn]) return graph3Conflict('cross-owner-structure-parent', { id, ownerColumn })
    return map('block', id)
  }
  for (const row of instances.values()) {
    const id = text(row.instance_id), block = blocks.get(id)
    if (!block || block.type !== 'synced-block' || block.document_id !== row.host_document_id
      || block.parent_block_id !== row.parent_block_id || block.depth !== row.depth
      || parseSyncedBlockPayload(text(block.content)).groupId !== row.group_id) return graph3Conflict('structure-instance-host-mismatch', id)
    map('group', row.group_id)
  }
  for (const row of blocks.values()) if (row.type === 'synced-block' && !instances.has(text(row.id)))
    return graph3Conflict('structure-synced-host-without-instance', row.id)

  const tables = database.tables.map(table => graph3PatchTable(table, source.encoding, row => {
    switch (table.name) {
      case 'documents': return { id: map('document', row.id), parent_id: row.parent_id === null ? null : map('document', row.parent_id) }
      case 'blocks': {
        const changes: Record<string, string | null> = { id: map('block', row.id), document_id: map('document', row.document_id),
          parent_block_id: parent(row, 'document_id') }
        if (row.type === 'synced-block') {
          const before = parseSyncedBlockPayload(text(row.content)), groupId = map('group', before.groupId)
          changes.content = groupId === before.groupId ? text(row.content) : serializeSyncedBlockPayload({ version: 1, groupId })
        }
        return changes
      }
      case 'synced_groups': return { id: map('group', row.id), creation_id: physical('group', text(row.id)).targetCreationId! }
      case 'synced_group_blocks': return { id: map('block', row.id), group_id: map('group', row.group_id), parent_block_id: parent(row, 'group_id') }
      case 'synced_instances': {
        const block = blocks.get(text(row.instance_id))!
        return { instance_id: map('block', row.instance_id), group_id: map('group', row.group_id),
          host_document_id: map('document', row.host_document_id), parent_block_id: parent(block, 'document_id') }
      }
      default: return {}
    }
  }))
  // Report the union of database and structural changes against the actual
  // original cells, retaining the complete raw table/row order and rowid proof.
  const changedCells = tables.flatMap(table => {
    const original = source.tables.find(item => item.name === table.name)!
    return table.rows.flatMap((row, index) => {
      const columns = table.columns.filter((_, column) => capsuleJson(row.cells[column]) !== capsuleJson(original.rows[index].cells[column]))
      return columns.length ? [{ table: table.name, sourceRowId: row.sourceRowId, columns }] : []
    })
  })
  const body = { kind: 'complete-root-restore-physical-structure-candidate' as const, version: 3 as const,
    conservationHash: data.inputs.knowledge.conservationHash, identityAllocationHash: data.value.allocationHash,
    databaseReferenceHash: database.databaseReferenceHash,
    sourceMaterialHash: data.inputs.source.materialHash, currentMaterialHash: data.inputs.current.materialHash,
    tables, changedCells, physicalStructureReferencesRewritten: true as const, physicalSyncedPayloadsRewritten: true as const,
    provenanceReferencesRewritten: false as const, linkBindingsRewritten: false as const, templateStructureReferencesRewritten: false as const,
    currentRetentionMerged: false as const, structuralMergeStillRequired: true as const,
    pending: ['origin-provenance', 'markdown-heading-and-binding-ranges', 'template-local-identities-and-synced-payloads',
      'current-retention-and-path-conflicts', 'fresh-execution-cut', 'rollbackable-assets-and-atomic-installation'] as const,
    sourcePolicyReplayed: false as const, sourceHistoryReplayed: false as const,
    referenceRewriteComplete: false as const, semanticValidationComplete: false as const, acceptedCoverage: false as const,
    effective: false as const, permit: false as const }
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('complete-structure-reference-candidate-budget', null)
  return freezeCapsuleValue({ ...body, structureReferenceHash: capsuleBytesHash('knowbook.restore.structure3.candidate.v1\0' + encoded) })
}
