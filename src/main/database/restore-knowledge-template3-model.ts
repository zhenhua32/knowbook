import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { assertPersistedTemplateForest, parseSyncedBlockPayload, serializeSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { deriveRootRestoreStructureReferences3 } from './restore-knowledge-structure3-model'
import { graph3Conflict, graph3Key, graph3PatchTable, graph3Rows, graph3Text, type Graph3Inputs } from './restore-knowledge-graph3-data'
import { knowledgeGroupComparisonKey, type KnowledgeRowRef } from './restore-knowledge-payload-model'
import { template3ContentStringRanges } from './restore-knowledge-template3-json'

const text = (value: unknown): string => typeof value === 'string' ? value : graph3Conflict('template-original-text', typeof value)
const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
function blocks(raw: string) {
  let value: unknown
  try { value = JSON.parse(raw) as unknown; assertPersistedTemplateForest(value) }
  catch { return graph3Conflict('template-original-persisted-forest', null) }
  return value as SyncedStableBlockDraft[]
}
type GroupReference = { blockIndex: number; localId: string; sourceGroupId: string | null; targetGroupId: string | null;
  status: 'physical' | 'missing-reservation' | 'opaque-draft'; assignmentKey: string | null; groupSource: KnowledgeRowRef | null;
  tuple: Graph3Inputs['inputs']['source']['knowledge']['groups'][number]['tuple'] | null; resolvedHistoricalBirth: false }

/** Saved drafts have their own local ID domain. Recovery does not instantiate
 * them, expand variables, guess a host path or create an instance. Their future
 * ordinary copy keeps the existing Store rules; all navigation bytes stay put.
 * Strict group payloads alone follow this source's exact group/allocation. */
export function deriveRootRestoreTemplateReferences3(data: Graph3Inputs) {
  const structure = deriveRootRestoreStructureReferences3(data), raw = data.inputs.source.source.sourceContent
  const knowledge = data.inputs.source.knowledge
  const originals = graph3Rows(raw, 'document_templates')
  const originalByRow = new Map(originals.map(row => [row.original.sourceRowId, row]))
  const groupRows = new Map(graph3Rows(raw, 'synced_groups').map(row => [text(row.value.id), row]))
  const knowledgeGroups = new Map(knowledge.groups.map(group => [group.tuple.groupId, group]))
  const allocations = new Map<string, typeof data.value.assignments>()
  for (const slot of data.value.assignments) if (slot.kind === 'group') {
    const values = allocations.get(slot.sourceId) ?? []; values.push(slot); allocations.set(slot.sourceId, values)
  }
  const missingByTemplate = new Map<string, typeof data.value.assignments>()
  for (const slot of data.value.assignments) if (slot.kind === 'group' && !slot.physical && slot.state === 'missing-reservation') {
    const seen = new Set<string>()
    for (const index of slot.facts) {
      const fact = knowledge.occupancy[index]
      if (fact.namespace !== 'group' || fact.id !== slot.sourceId || fact.source.table !== 'document_templates') continue
      const key = graph3Key(fact.source, fact.id)
      if (seen.has(key)) continue
      seen.add(key)
      const values = missingByTemplate.get(key) ?? []; values.push(slot); missingByTemplate.set(key, values)
    }
  }
  const candidateGroups = new Set(graph3Rows({ ...raw, tables: structure.tables }, 'synced_groups').map(row => text(row.value.id)))
  const currentGroups = new Set(graph3Rows(data.inputs.current.source.sourceContent, 'synced_groups').map(row => text(row.value.id)))
  const templateEvidence = knowledge.originals.find(table => table.table === 'document_templates')
    ?? graph3Conflict('template-original-evidence-table', null)
  const templateSources = new Map<string, KnowledgeRowRef>()
  for (const row of templateEvidence.rows) {
    if (row.key.length !== 1) return graph3Conflict('template-original-evidence-key', row.key)
    const id = graph3Text(row.key[0], knowledge.encoding)
    if (templateSources.has(id)) return graph3Conflict('template-duplicate-original-evidence', id)
    templateSources.set(id, { table: row.table, key: row.key, occurrence: row.occurrence, rowHash: row.rowHash })
  }
  const physicalGroupCache = new Map<string, { group: NonNullable<ReturnType<typeof knowledgeGroups.get>>; slot: typeof data.value.assignments[number] }>()
  let referenceMinimumBytes = 0
  const keepReference = (reference: GroupReference) => {
    referenceMinimumBytes += Buffer.byteLength(capsuleJson(reference))
    if (referenceMinimumBytes > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('complete-template-reference-candidate-budget', null)
    return reference
  }
  function groupReference(templateSource: KnowledgeRowRef, block: SyncedStableBlockDraft, blockIndex: number): GroupReference {
    let sourceGroupId: string
    try { sourceGroupId = parseSyncedBlockPayload(block.content).groupId }
    catch { return keepReference({ blockIndex, localId: block.id, sourceGroupId: null, targetGroupId: null, status: 'opaque-draft',
      assignmentKey: null, groupSource: null, tuple: null, resolvedHistoricalBirth: false }) }
    const row = groupRows.get(sourceGroupId), group = knowledgeGroups.get(sourceGroupId), slots = allocations.get(sourceGroupId) ?? []
    if (row) {
      let physical = physicalGroupCache.get(sourceGroupId)
      if (!physical) {
        if (!group || group.tuple.createdAt !== row.value.created_at || group.tuple.creationId !== row.value.creation_id
          || !same(group.tuple.origin, JSON.parse(text(row.value.origin_json))) || group.originalOriginJson !== row.value.origin_json
          || group.comparisonKey !== knowledgeGroupComparisonKey(group.tuple)) return graph3Conflict('template-source-group-tuple', sourceGroupId)
        const selected = slots.filter(slot => slot.physical && !slot.ambiguous && slot.birth === row.value.created_at
          && slot.incarnation === group.comparisonKey)
        if (selected.length !== 1) return graph3Conflict('template-physical-group-allocation', sourceGroupId)
        physical = { group, slot: selected[0] }; physicalGroupCache.set(sourceGroupId, physical)
      }
      return keepReference({ blockIndex, localId: block.id, sourceGroupId, targetGroupId: physical.slot.targetId, status: 'physical',
        assignmentKey: physical.slot.key, groupSource: physical.group.source, tuple: physical.group.tuple, resolvedHistoricalBirth: false })
    }
    // Follow the precise source-template occupancy fact, including an unknown
    // birth demand. A same-ID history fact or current physical group is not it.
    const selected = missingByTemplate.get(graph3Key(templateSource, sourceGroupId)) ?? []
    if (selected.length !== 1) return graph3Conflict('template-missing-group-allocation', { sourceGroupId, templateSource })
    const slot = selected[0]
    if (candidateGroups.has(slot.targetId) || currentGroups.has(slot.targetId)) return graph3Conflict('template-missing-group-would-activate', sourceGroupId)
    return keepReference({ blockIndex, localId: block.id, sourceGroupId, targetGroupId: slot.targetId, status: 'missing-reservation',
      assignmentKey: slot.key, groupSource: null, tuple: null, resolvedHistoricalBirth: false })
  }
  const templates: Array<{ templateId: string; createdAt: string; sourceRowId: string; templateSource: KnowledgeRowRef;
    originalBlocksJson: string; upstreamBlocksJson: string; candidateBlocksJson: string;
    localAssignments: Array<{ key: string; templateId: string; localId: string; targetLocalId: string; parentLocalId: string | null }>;
    groupReferences: GroupReference[]; contentEdits: Array<{ blockIndex: number; localId: string; from: number; to: number; before: string; after: string }>;
    localReferencePolicy: 'preserve-local-ids-and-all-navigation-bytes-until-instantiation'; summaryLocalRemapping: false }> = []
  let bytes = 0
  const tables = structure.tables.map(table => table.name !== 'document_templates' ? table : graph3PatchTable(table, raw.encoding, (value, sourceRowId) => {
    const original = originalByRow.get(sourceRowId) ?? graph3Conflict('template-original-rowid', sourceRowId)
    const templateId = text(original.value.id), templateSource = templateSources.get(templateId)
      ?? graph3Conflict('template-missing-original-evidence', templateId)
    if (value.id !== templateId) return graph3Conflict('template-identity-changed-upstream', templateId)
    const originalBlocksJson = text(original.value.blocks_json), upstreamBlocksJson = text(value.blocks_json)
    if (Buffer.byteLength(capsuleJson(originalBlocksJson)) + Buffer.byteLength(capsuleJson(upstreamBlocksJson)) > CAPSULE2_RAW_MAX_JSON_BYTES)
      return graph3Conflict('complete-template-reference-candidate-budget', null)
    const before = blocks(originalBlocksJson), upstream = blocks(upstreamBlocksJson), ranges = template3ContentStringRanges(upstreamBlocksJson)
    if (before.length !== upstream.length || ranges.length !== before.length) return graph3Conflict('template-upstream-cardinality', templateId)
    const localAssignments = before.map((block, index) => {
      const { content: _oldContent, ...originalFields } = block, { content: _content, ...upstreamFields } = upstream[index]
      if (!same(originalFields, upstreamFields) || block.type !== 'database-view' && block.content !== upstream[index].content)
        return graph3Conflict('template-upstream-local-structure', { templateId, index })
      return { key: graph3Key('template-local', templateSource, block.id), templateId,
        localId: block.id, targetLocalId: block.id, parentLocalId: block.parentBlockId }
    })
    const groupReferences = before.flatMap((block, index) => block.type === 'synced-block' ? [groupReference(templateSource, block, index)] : [])
    const contentEdits = groupReferences.flatMap(reference => {
      if (reference.targetGroupId === null || reference.targetGroupId === reference.sourceGroupId) return []
      const block = upstream[reference.blockIndex], range = ranges[reference.blockIndex]
      if (JSON.parse(upstreamBlocksJson.slice(range.from, range.to)) !== block.content) return graph3Conflict('template-content-range-mismatch', templateId)
      return [{ blockIndex: reference.blockIndex, localId: block.id, ...range, before: block.content,
        after: serializeSyncedBlockPayload({ version: 1, groupId: reference.targetGroupId }) }]
    })
    const pieces: string[] = [], editsByIndex = new Map(contentEdits.map(edit => [edit.blockIndex, edit]))
    let end = 0
    for (const edit of contentEdits) {
      pieces.push(upstreamBlocksJson.slice(end, edit.from), JSON.stringify(edit.after)); end = edit.to
    }
    pieces.push(upstreamBlocksJson.slice(end))
    const candidateBlocksJson = contentEdits.length ? pieces.join('') : upstreamBlocksJson
    const after = blocks(candidateBlocksJson)
    for (let index = 0; index < after.length; index++) {
      const expected = editsByIndex.get(index)?.after ?? upstream[index].content
      if (!same({ ...upstream[index], content: expected }, after[index])) return graph3Conflict('template-candidate-unexpected-change', { templateId, index })
    }
    const template = { templateId, createdAt: text(original.value.created_at), sourceRowId, templateSource,
      originalBlocksJson, upstreamBlocksJson, candidateBlocksJson, localAssignments, groupReferences, contentEdits,
      localReferencePolicy: 'preserve-local-ids-and-all-navigation-bytes-until-instantiation' as const, summaryLocalRemapping: false as const }
    bytes += Buffer.byteLength(capsuleJson(template))
    if (bytes > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('complete-template-reference-candidate-budget', null)
    templates.push(template)
    return { blocks_json: candidateBlocksJson }
  }))
  if (templates.length !== originals.length) return graph3Conflict('template-candidate-row-closure', null)
  const changedCells = tables.flatMap(table => {
    const original = raw.tables.find(item => item.name === table.name)!
    return table.rows.flatMap((row, index) => {
      const columns = table.columns.filter((_, column) => !same(row.cells[column], original.rows[index].cells[column]))
      return columns.length ? [{ table: table.name, sourceRowId: row.sourceRowId, columns }] : []
    })
  })
  const body = { kind: 'complete-root-restore-template-reference-candidate' as const, version: 3 as const,
    scope: 'root-source-saved-template-references' as const, sourceWitness: data.value.sourceWitness, sourcePayload: data.value.sourcePayload,
    conservationHash: data.inputs.knowledge.conservationHash, identityAllocationHash: data.value.allocationHash,
    structureReferenceHash: structure.structureReferenceHash, sourceMaterialHash: data.inputs.source.materialHash, currentMaterialHash: data.inputs.current.materialHash,
    tables, changedCells, templates, templateStructureReferencesRewritten: true as const, templateGroupReferencesRewritten: true as const,
    templateLocalIdsPreserved: true as const, templateLocalNavigationBytesPreserved: true as const,
    futureCopyRules: { wikiBare: 'exact-local-id', wikiFragment: 'strip-one-caret-match-local-id-clear-path-keep-alias',
      markdownFragment: 'exact-local-fragment-without-caret-normalization-clear-path-and-query', images: 'same-fragment-rules', summary: 'no-local-id-remap',
      variables: 'expand-once-at-explicit-instantiation', nonlocalNavigation: 'late-bound-until-explicit-instantiation' } as const,
    currentRetentionMerged: false as const, sourcePolicyReplayed: false as const, sourceHistoryReplayed: false as const,
    referenceRewriteComplete: false as const, semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('complete-template-reference-candidate-budget', null)
  return freezeCapsuleValue({ ...body, templateReferenceHash: capsuleBytesHash('knowbook.restore.template3.candidate.v1\0' + encoded) })
}
