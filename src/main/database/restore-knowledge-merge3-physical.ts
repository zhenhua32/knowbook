import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { canBlockNestUnder } from '../../shared/blockTypes'
import { isSyncedUuid, parseSyncedBlockPayload, SYNCED_MAX_DEPTH, SyncedValidationError,
  validateSyncedCanonicalEdit, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_RAW_MAX_ROWS } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Key, graph3Rows, type Graph3Inputs } from './restore-knowledge-graph3-data'
import { assertMerge3JsonBudget, merge3RowValues, type Merge3InputRow, type Merge3OriginalRowRef, type Merge3RowDisposition,
  type Merge3SelectedRow, type PreparedMerge3Table } from './restore-knowledge-merge3-storage'

export const MERGE3_PHYSICAL_TABLES = Object.freeze(['documents', 'blocks', 'synced_groups', 'synced_group_blocks', 'synced_instances'] as const)
export type Merge3PhysicalTable = typeof MERGE3_PHYSICAL_TABLES[number]
export interface Merge3PhysicalSelection {
  readonly name: Merge3PhysicalTable
  readonly selectedRows: readonly Merge3SelectedRow[]
  readonly dispositions: readonly Merge3RowDisposition[]
}
export interface Merge3PhysicalConflict {
  readonly code: string; readonly table: Merge3PhysicalTable; readonly rowKeys: readonly string[]
  readonly detail: unknown
}
type Values = Record<string, unknown>
type Row = { row: Merge3InputRow; value: Values }
type PhysicalGroup = Graph3Inputs['inputs']['source']['source']['physical']['groups'][number]
type GroupState = { side: 'source' | 'current'; sourceGroupId: string; targetGroupId: string;
  absence: PhysicalGroup['absence']; active: boolean; originalLifecycle: PhysicalGroup['lifecycle']; sourceRef: Merge3OriginalRowRef }
const same = (left: unknown, right: unknown): boolean => capsuleJson(left) === capsuleJson(right)
const text = (value: unknown): string => typeof value === 'string' ? value : graph3Conflict('merge-physical-text', typeof value)
const nullableText = (value: unknown): string | null => value === null ? null : text(value)
const integer = (value: unknown): number => typeof value === 'bigint' && Number.isSafeInteger(Number(value))
  ? Number(value) : graph3Conflict('merge-physical-integer', typeof value)
const decision = (kind: string, owner: unknown) => kind + ':' + capsuleBytesHash(capsuleJson(owner))

/** Fixed current-aware candidate policy, not a caller-selectable merge mode.
 * Incoming rows have already passed the source identity/reference transforms.
 * Each participating host/group replaces its WHOLE corresponding forest;
 * absent incoming children never accidentally retain current children. Other
 * current rows stay exact. No history, guard, lifecycle or prune is installed. */
export function selectMerge3PhysicalRows3(data: Graph3Inputs, prepared: readonly PreparedMerge3Table[]) {
  const source = data.inputs.source.source, current = data.inputs.current.source
  const byTable = new Map<Merge3PhysicalTable, PreparedMerge3Table>()
  for (const table of prepared) if (MERGE3_PHYSICAL_TABLES.includes(table.name as Merge3PhysicalTable)) {
    const name = table.name as Merge3PhysicalTable
    if (byTable.has(name)) return graph3Conflict('merge-duplicate-physical-table', name)
    byTable.set(name, table)
  }
  const sourceOriginals = new Map<Merge3PhysicalTable, Map<string, Values>>()
  const decoded = new Map<Merge3PhysicalTable, { source: Row[]; current: Row[] }>()
  for (const name of MERGE3_PHYSICAL_TABLES) {
    const table = byTable.get(name) ?? graph3Conflict('merge-missing-physical-table', name)
    if (table.sourceEncoding !== source.sourceContent.encoding || table.currentEncoding !== current.sourceContent.encoding
      || table.targetEncoding !== current.sourceContent.encoding) return graph3Conflict('merge-physical-encoding', name)
    const sides = [['source', source, table.sourceRows], ['current', current, table.currentRows]] as const
    const values = { source: [] as Row[], current: [] as Row[] }
    for (const [side, packet, rows] of sides) {
      const originals = graph3Rows(packet.sourceContent, name), index = new Map(originals.map(row => [row.original.sourceRowId, row]))
      const payloads = data.inputs.knowledge.constraints.payloads.filter(payload => !payload.witness.domain.length && payload.witness.side === side)
      const originalTable = packet.sourceContent.tables.find(table => table.name === name)!
      if (payloads.length !== 1 || rows.length !== originals.length || !same(table.originalColumns[side], originalTable.columns)
        || side === 'current' && !same(table.columns, originalTable.columns)) return graph3Conflict('merge-physical-original-closure', { name, side })
      const seen = new Set<string>()
      for (const row of rows) {
        const original = index.get(row.ref.sourceRowId)
        if (!original || seen.has(row.ref.sourceRowId) || !same(row.originalCells, original.original.cells)
          || side === 'current' && !same(row.cells, original.original.cells)
          || row.ref.side !== side || row.ref.table !== name || row.ref.payload !== payloads[0].key
          || row.ref.materialHash !== data.inputs[side].materialHash || !same(row.ref.witness, payloads[0].witness))
          return graph3Conflict('merge-physical-original-row', { name, side, sourceRowId: row.ref.sourceRowId })
        seen.add(row.ref.sourceRowId)
        values[side].push({ row, value: merge3RowValues(table, row) })
      }
      if (side === 'source') sourceOriginals.set(name, new Map(originals.map(row => [row.original.sourceRowId, row.value])))
    }
    decoded.set(name, values)
  }
  const assignments = new Map<string, typeof data.value.assignments>()
  for (const slot of data.value.assignments) {
    const key = graph3Key(slot.kind, slot.sourceId), slots = assignments.get(key) ?? []
    slots.push(slot); assignments.set(key, slots)
  }
  function slot(kind: 'document' | 'block' | 'group', row: Values, ownerKind: 'document' | 'group' | null, ownerId: string | null) {
    const id = text(row.id), slots = (assignments.get(graph3Key(kind, id)) ?? []).filter(item => item.physical && !item.ambiguous
      && item.birth === row.created_at && item.ownerKind === ownerKind && item.ownerId === ownerId)
    if (slots.length !== 1) return graph3Conflict('merge-physical-allocation', { kind, id, ownerKind, ownerId })
    return slots[0]
  }
  const documentTargets = new Map<string, string>(), groupTargets = new Map<string, string>(), blockTargets = new Map<string, string>()
  const sourceDocuments = new Map(source.physical.documents.map(document => [document.documentId, document]))
  const sourceGroups = new Map(source.physical.groups.map(group => [group.groupId, group]))
  const currentGroups = new Map(current.physical.groups.map(group => [group.groupId, group]))
  const knowledgeGroups = new Map(data.inputs.source.knowledge.groups.map(group => [group.tuple.groupId, group]))
  for (const name of ['documents', 'synced_groups'] as const) {
    const rows = decoded.get(name)!.source
    if (rows.length !== (name === 'documents' ? sourceDocuments.size : sourceGroups.size)) return graph3Conflict('merge-physical-header-closure', name)
    const claimed = new Set<string>()
    for (const entry of rows) {
      const original = sourceOriginals.get(name)!.get(entry.row.ref.sourceRowId)!, id = text(original.id)
      const fact = name === 'documents' ? sourceDocuments.get(id) : sourceGroups.get(id)
      if (!fact || name === 'documents' && sourceDocuments.get(id)!.createdAt !== original.created_at)
        return graph3Conflict('merge-physical-source-header', { name, id })
      const mapped = slot(name === 'documents' ? 'document' : 'group', original, null, null), targetId = text(entry.value.id)
      if (targetId !== mapped.targetId || claimed.has(targetId)) return graph3Conflict('merge-physical-target-header', { name, id, targetId })
      claimed.add(targetId)
      if (name === 'documents') documentTargets.set(id, targetId)
      else {
        if (mapped.incarnation !== knowledgeGroups.get(id)?.comparisonKey || entry.value.creation_id !== mapped.targetCreationId || entry.value.origin_json !== original.origin_json
          || entry.value.bindings_json !== original.bindings_json) return graph3Conflict('merge-physical-group-provenance', id)
        groupTargets.set(id, targetId)
      }
    }
  }
  for (const name of ['blocks', 'synced_group_blocks'] as const) for (const entry of decoded.get(name)!.source) {
    const original = sourceOriginals.get(name)!.get(entry.row.ref.sourceRowId)!, id = text(original.id)
    const ownerKind = name === 'blocks' ? 'document' : 'group', ownerId = text(original[name === 'blocks' ? 'document_id' : 'group_id'])
    const mapped = slot('block', original, ownerKind, ownerId)
    if (entry.value.id !== mapped.targetId || blockTargets.has(id)) return graph3Conflict('merge-physical-source-block', id)
    blockTargets.set(id, mapped.targetId)
  }
  const requiredTarget = (index: ReadonlyMap<string, string>, id: unknown, kind: string): string =>
    index.get(text(id)) ?? graph3Conflict('merge-physical-missing-source-owner', { kind, id })
  const mappedParent = (id: unknown) => id === null ? null : requiredTarget(blockTargets, id, 'parent')
  for (const entry of decoded.get('documents')!.source) {
    const original = sourceOriginals.get('documents')!.get(entry.row.ref.sourceRowId)!
    if (entry.value.parent_id !== (original.parent_id === null ? null : requiredTarget(documentTargets, original.parent_id, 'document-parent')))
      return graph3Conflict('merge-physical-document-parent-map', original.id)
  }
  for (const name of ['blocks', 'synced_group_blocks'] as const) for (const entry of decoded.get(name)!.source) {
    const original = sourceOriginals.get(name)!.get(entry.row.ref.sourceRowId)!, owner = name === 'blocks' ? 'document_id' : 'group_id'
    if (entry.value[owner] !== requiredTarget(name === 'blocks' ? documentTargets : groupTargets, original[owner], owner)
      || entry.value.parent_block_id !== mappedParent(original.parent_block_id) || entry.value.type !== original.type
      || entry.value.depth !== original.depth || entry.value.sort_order !== original.sort_order)
      return graph3Conflict('merge-physical-block-owner-map', original.id)
    if (entry.value.type === 'synced-block') {
      const before = parseSyncedBlockPayload(text(original.content)), after = parseSyncedBlockPayload(text(entry.value.content))
      if (after.groupId !== requiredTarget(groupTargets, before.groupId, 'payload-group')) return graph3Conflict('merge-physical-payload-map', original.id)
    }
  }
  for (const entry of decoded.get('synced_instances')!.source) {
    const original = sourceOriginals.get('synced_instances')!.get(entry.row.ref.sourceRowId)!
    if (entry.value.instance_id !== requiredTarget(blockTargets, original.instance_id, 'instance')
      || entry.value.host_document_id !== requiredTarget(documentTargets, original.host_document_id, 'instance-host')
      || entry.value.group_id !== requiredTarget(groupTargets, original.group_id, 'instance-group')
      || entry.value.parent_block_id !== mappedParent(original.parent_block_id)) return graph3Conflict('merge-physical-instance-map', original.instance_id)
  }

  const participatingDocumentIds = [...documentTargets.values()], participatingGroupIds = [...groupTargets.values()]
  const hosts = new Set(participatingDocumentIds), groups = new Set(participatingGroupIds)
  const conflicts: Merge3PhysicalConflict[] = []
  const conflict = (code: string, table: Merge3PhysicalTable, rows: readonly Row[], detail: unknown) => {
    conflicts.push({ code, table, rowKeys: rows.map(entry => entry.row.key), detail })
  }
  const selected = new Map<Merge3PhysicalTable, Row[]>(), tables: Merge3PhysicalSelection[] = []
  let selectedCount = 0
  for (const name of MERGE3_PHYSICAL_TABLES) {
    const values = decoded.get(name)!, pk = name === 'synced_instances' ? 'instance_id' : 'id'
    const incoming = new Map(values.source.map(entry => [text(entry.value[pk]), entry]))
    const currentById = new Map(values.current.map(entry => [text(entry.value[pk]), entry]))
    if (incoming.size !== values.source.length || currentById.size !== values.current.length) return graph3Conflict('merge-physical-duplicate-pk', name)
    const replaces = (entry: Row) => name === 'documents' || name === 'synced_groups' ? incoming.has(text(entry.value[pk]))
      : name === 'blocks' ? hosts.has(text(entry.value.document_id)) : name === 'synced_instances' ? hosts.has(text(entry.value.host_document_id))
        : groups.has(text(entry.value.group_id))
    const dispositions: Merge3RowDisposition[] = [], selectedRows: Merge3SelectedRow[] = [], rows: Row[] = []
    for (const entry of values.source) {
      const old = currentById.get(text(entry.value[pk]))
      if (old && !replaces(old)) {
        dispositions.push({ rowKey: entry.row.key, status: 'conflict', decision: decision('physical-retained-pk-collision', old.row.key) })
        conflict('incoming-physical-id-occupied-by-retained-current', name, [entry, old], { id: text(entry.value[pk]) })
        continue
      }
      const exact = old && entry.row.primaryKeyCells !== null && old.row.primaryKeyCells !== null && same(entry.row.primaryKeyCells, old.row.primaryKeyCells)
      selectedRows.push({ rowKey: entry.row.key, replaceCurrentRowKey: exact && old ? old.row.key : null })
      dispositions.push({ rowKey: entry.row.key, status: 'selected', decision: decision('physical-source-whole-owner-forest', name) })
      rows.push(entry)
    }
    for (const entry of values.current) {
      if (replaces(entry)) dispositions.push({ rowKey: entry.row.key, status: 'replaced', decision: decision('physical-whole-owner-forest-replaced', name) })
      else {
        selectedRows.push({ rowKey: entry.row.key, replaceCurrentRowKey: null }); rows.push(entry)
        dispositions.push({ rowKey: entry.row.key, status: 'selected', decision: decision('physical-unparticipating-current-retained', name) })
      }
    }
    selectedCount += rows.length
    if (selectedCount > CAPSULE2_RAW_MAX_ROWS) return graph3Conflict('merge-physical-selected-row-budget', selectedCount)
    selected.set(name, rows); tables.push({ name, selectedRows, dispositions })
  }
  const groupStates: GroupState[] = selected.get('synced_groups')!.map(entry => {
    const original = entry.row.ref.side === 'source' ? sourceOriginals.get('synced_groups')!.get(entry.row.ref.sourceRowId)! : entry.value
    const id = text(original.id), fact = (entry.row.ref.side === 'source' ? sourceGroups : currentGroups).get(id)
    if (!fact || (fact.snapshot !== null) !== (fact.absence === null)) return graph3Conflict('merge-physical-original-group-activity', id)
    return { side: entry.row.ref.side, sourceGroupId: id, targetGroupId: text(entry.value.id), absence: fact.absence,
      active: fact.snapshot !== null, originalLifecycle: fact.lifecycle, sourceRef: entry.row.ref }
  })
  const stateByGroup = new Map(groupStates.map(state => [state.targetGroupId, state]))
  validatePhysicalSelection(selected, stateByGroup, conflict)
  const body = { kind: 'root-restore-current-aware-physical-selection' as const, version: 3 as const, tables,
    participatingDocumentIds, participatingGroupIds, participatingGroups: groupStates.filter(state => state.side === 'source'), groupStates, conflicts,
    physicalShapeValidated: conflicts.length === 0, rewrittenBindingsValidated: false as const,
    expandedProjectionBudgetValidated: false as const,
    originalGroupActivityPreserved: true as const, materializationDecisionsComplete: false as const,
    pathsValidated: false as const, referenceRewriteComplete: false as const, semanticValidationComplete: false as const,
    sourceHistoryReplayed: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  assertMerge3JsonBudget(body)
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('merge-physical-output-budget', null)
  return freezeCapsuleValue({ ...body, physicalSelectionHash: capsuleBytesHash('knowbook.restore.merge3.physical.v1\0' + encoded) })
}

function validatePhysicalSelection(selected: ReadonlyMap<Merge3PhysicalTable, Row[]>, states: ReadonlyMap<string, GroupState>,
  conflict: (code: string, table: Merge3PhysicalTable, rows: readonly Row[], detail: unknown) => void): void {
  const documents = new Map(selected.get('documents')!.map(entry => [text(entry.value.id), entry]))
  const groups = new Map(selected.get('synced_groups')!.map(entry => [text(entry.value.id), entry]))
  const owners = new Map<string, { table: 'blocks' | 'synced_group_blocks'; entry: Row }>()
  const complete = new Set<string>()
  for (const [id, document] of documents) {
    const chain = new Set<string>(); let next: string | null = id
    while (next !== null && !complete.has(next)) {
      if (chain.has(next)) { conflict('merged-document-parent-cycle', 'documents', [document], { id: next }); break }
      chain.add(next)
      const row = documents.get(next)
      if (!row) { conflict('merged-document-parent-missing', 'documents', [document], { id: next }); break }
      next = nullableText(row.value.parent_id)
    }
    for (const item of chain) complete.add(item)
  }
  const forests = new Map<string, { rows: Row[]; blocks: SyncedStableBlockDraft[] }>()
  for (const name of ['blocks', 'synced_group_blocks'] as const) {
    const byOwner = new Map<string, Row[]>()
    for (const entry of selected.get(name)!) {
      const id = text(entry.value.id), prior = owners.get(id)
      if (prior) conflict('merged-block-has-multiple-physical-owners', name, [prior.entry, entry], { id })
      else owners.set(id, { table: name, entry })
      const owner = text(entry.value[name === 'blocks' ? 'document_id' : 'group_id'])
      if (!(name === 'blocks' ? documents : groups).has(owner)) conflict('merged-block-owner-missing', name, [entry], { owner })
      const rows = byOwner.get(owner) ?? []; rows.push(entry); byOwner.set(owner, rows)
    }
    for (const [owner, rows] of byOwner) {
      rows.sort((a, b) => integer(a.value.sort_order) - integer(b.value.sort_order) || (text(a.value.id) < text(b.value.id) ? -1 : 1))
      if (rows.some((entry, index) => integer(entry.value.sort_order) < 0 || index > 0 && entry.value.sort_order === rows[index - 1].value.sort_order))
        conflict('merged-forest-order', name, rows, { owner })
      const blocks = rows.map(entry => physicalBlock(entry.value))
      try { if (name === 'blocks') validateSyncedHostForest(blocks); else validateSyncedCanonicalEdit(blocks) }
      catch (error) {
        if (!(error instanceof SyncedValidationError)) throw error
        conflict('merged-physical-forest-shape', name, rows, { owner, reason: error.code })
      }
      forests.set(graph3Key(name, owner), { rows, blocks })
    }
  }
  for (const [id, group] of groups) if (states.get(id)?.active && !forests.get(graph3Key('synced_group_blocks', id))?.blocks.length)
    conflict('merged-active-group-has-no-canonical-forest', 'synced_groups', [group], { groupId: id })
  const canonicalStats = new Map<string, { maxDepth: number; rootTypes: string[] }>()
  for (const [id] of groups) {
    const blocks = forests.get(graph3Key('synced_group_blocks', id))?.blocks ?? []
    canonicalStats.set(id, { maxDepth: blocks.reduce((depth, block) => Math.max(depth, block.depth), 0),
      rootTypes: [...new Set(blocks.filter(block => block.depth === 0).map(block => block.type))] })
  }
  const parentCompatibility = new Map<string, boolean>()
  const instances = new Map(selected.get('synced_instances')!.map(entry => [text(entry.value.instance_id), entry]))
  const references = new Set<string>()
  for (const [hostId] of documents) {
    const forest = forests.get(graph3Key('blocks', hostId))
    if (!forest) continue
    const parentTypes = new Map(forest.blocks.map(block => [block.id, block.type]))
    for (let index = 0; index < forest.blocks.length; index++) {
      const block = forest.blocks[index]
      if (block.type !== 'synced-block') continue
      const row = forest.rows[index], groupId = parseSyncedBlockPayload(block.content).groupId, registry = instances.get(block.id)
      references.add(block.id)
      if (!registry || registry.value.group_id !== groupId || registry.value.host_document_id !== hostId
        || registry.value.parent_block_id !== block.parentBlockId || integer(registry.value.depth) !== block.depth
        || !isSyncedUuid(registry.value.binding_version)) conflict('merged-instance-registry-mirror', 'blocks', registry ? [row, registry] : [row], { instanceId: block.id })
      const group = groups.get(groupId), state = states.get(groupId), canonical = canonicalStats.get(groupId)
      if (!group || !state?.active) {
        conflict('merged-reference-target-is-missing-or-inactive', 'blocks', group ? [row, group] : [row], { instanceId: block.id, groupId, absence: state?.absence ?? null })
        continue
      }
      if (!canonical) continue
      const parentType = block.parentBlockId === null ? null : parentTypes.get(block.parentBlockId)
      const compatibilityKey = graph3Key(groupId, parentType === undefined ? ['missing-parent'] : parentType)
      let compatible = parentCompatibility.get(compatibilityKey)
      if (compatible === undefined) {
        compatible = parentType !== undefined && (parentType === null || canonical.rootTypes.every(type => canBlockNestUnder(parentType, type)))
        parentCompatibility.set(compatibilityKey, compatible)
      }
      if (!compatible)
        conflict('merged-canonical-root-parent-role', 'blocks', [row], { instanceId: block.id, groupId })
      if (block.depth + canonical.maxDepth > SYNCED_MAX_DEPTH)
        conflict('merged-canonical-expanded-depth', 'blocks', [row], { instanceId: block.id, groupId })
    }
  }
  for (const [id, entry] of instances) if (!references.has(id)) conflict('merged-registry-without-reference-leaf', 'synced_instances', [entry], { instanceId: id })
}

function physicalBlock(row: Values): SyncedStableBlockDraft {
  const json = (value: unknown) => {
    const source = text(value)
    return parseStrictJson(source, { maxBytes: Math.max(1, Buffer.byteLength(source)), maxDepth: 32 })
  }
  if (row.checked !== 0n && row.checked !== 1n) return graph3Conflict('merge-physical-checked', text(row.id))
  if (typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return graph3Conflict('merge-physical-birth', text(row.id))
  return { id: text(row.id), type: text(row.type), content: text(row.content), checked: row.checked === 1n,
    depth: integer(row.depth), parentBlockId: nullableText(row.parent_block_id),
    ...(row.tags_json === null ? {} : { tags: json(row.tags_json) as string[] }),
    ...(row.language === null ? {} : { language: text(row.language) }),
    ...(row.list_start === null ? {} : { listStart: integer(row.list_start) }),
    ...(row.markdown_format_json === null ? {} : { markdownFormat: json(row.markdown_format_json) as NonNullable<SyncedStableBlockDraft['markdownFormat']> }),
    ...(row.highlight === null ? {} : { highlight: text(row.highlight) }) }
}
