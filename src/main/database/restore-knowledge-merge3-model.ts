import { parseDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { hashBoundedCapsuleJson } from './restore-knowledge-capsule-json-hash'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Key, graph3PatchTable, graph3Text, graph3Value, type Graph3Inputs } from './restore-knowledge-graph3-data'
import { applyMerge3DocumentLayout3 } from './restore-knowledge-merge3-layout'
import { MERGE3_PHYSICAL_TABLES, selectMerge3PhysicalRows3 } from './restore-knowledge-merge3-physical'
import { MERGE3_CONTENT_TABLES, assertMerge3JsonBudget, assertMerge3StorageTablesBudget, finishMerge3Table, prepareMerge3Table,
  type FinishedMerge3Table, type Merge3ContentTable, type Merge3InputRow,
  type Merge3RowDisposition, type Merge3SelectedRow, type PreparedMerge3Table } from './restore-knowledge-merge3-storage'
import { deriveRootRestoreTemplateReferences3 } from './restore-knowledge-template3-model'

export interface Merge3Choices { readonly anonymousValues: 'source' | 'current' | 'unresolved' }
export interface Merge3Conflict {
  readonly code: string; readonly table: Merge3ContentTable; readonly rowKeys: readonly string[]; readonly detail: unknown
}
export interface Merge3ReplacementScope {
  readonly key: string; readonly table: Merge3ContentTable
  readonly ownerKind: 'document' | 'group' | 'entity' | 'definition' | 'template' | 'anonymous-collection'
  readonly ownerId: string | null; readonly sourceRowKeys: readonly string[]; readonly currentRowKeys: readonly string[]
  readonly policy: string
}
type Values = Record<string, unknown>
type Row = { readonly row: Merge3InputRow; readonly value: Values }
type FinalTable = FinishedMerge3Table['table']
type FinalRow = FinalTable['rows'][number]
type FinalEntry = { readonly row: FinalRow; readonly value: Values }
const definitionTables = ['databases', 'document_database_columns', 'database_saved_views', 'database_entities'] as const
const text = (value: unknown): string => typeof value === 'string' ? value : graph3Conflict('merge-content-expected-text', typeof value)
const nullableText = (value: unknown): string | null => value === null ? null : text(value)
const decision = (policy: string, owner: unknown) => policy + ':' + capsuleBytesHash(capsuleJson(owner))
const pkKey = (row: Merge3InputRow): string | null => row.primaryKeyCells === null ? null : capsuleJson(row.primaryKeyCells)
function normalizeChoices(input?: Merge3Choices): Merge3Choices {
  if (input === undefined) return { anonymousValues: 'unresolved' }
  const value = capsuleRecord(input, ['anonymousValues'])
  return value.anonymousValues === 'source' || value.anonymousValues === 'current' || value.anonymousValues === 'unresolved'
    ? { anonymousValues: value.anonymousValues } : graph3Conflict('merge-anonymous-choice', value.anonymousValues)
}
function* policyRows(table: PreparedMerge3Table, side: 'source' | 'current', columns: readonly string[]): IterableIterator<Row> {
  const indexes = columns.map(column => table.columns.indexOf(column))
  if (indexes.includes(-1)) return graph3Conflict('merge-policy-projection-column', table.name)
  // prepareMerge3Table validated every cell in both original and target
  // encodings. The policy only needs coordinates in the prepared target.
  for (const row of side === 'source' ? table.sourceRows : table.currentRows) {
    const value = Object.fromEntries(columns.map((column, index) => [column, graph3Value(row.cells[indexes[index]], table.targetEncoding)]))
    yield { row, value }
  }
}
function byOwner(entries: Iterable<Row>, column: string, predicate: (row: Row) => boolean = () => true): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const entry of entries) {
    if (!predicate(entry)) continue
    const owner = nullableText(entry.value[column])
    if (owner === null) continue
    const keys = result.get(owner) ?? []; keys.push(entry.row.key); result.set(owner, keys)
  }
  return result
}
function* finalRows(table: FinalTable, columns: readonly string[]): IterableIterator<FinalEntry> {
  const indexes = columns.map(column => table.columns.indexOf(column))
  if (indexes.includes(-1)) return graph3Conflict('merge-final-projection-column', table.name)
  for (const row of table.rows) {
    const value = Object.fromEntries(columns.map((column, index) => [column, graph3Value(row.cells[indexes[index]], table.encoding)]))
    yield { row, value }
  }
}

/** Complete current-aware BUSINESS candidate, not an installation plan. Every
 * row comes from the same authenticated Graph3 read when called by its Main
 * owner. Source content transformations and current retention are explicit;
 * no execution history, policy, credential or source operation is replayed. */
export function deriveRootRestoreMergedContent3(data: Graph3Inputs, inputChoices?: Merge3Choices) {
  const choices = normalizeChoices(inputChoices), upstream = deriveRootRestoreTemplateReferences3(data)
  const source = data.inputs.source.source.sourceContent, current = data.inputs.current.source.sourceContent
  for (const [side, content] of [['source', source], ['current', current]] as const) {
    const tables = content.tables.filter(table => table.role === 'content')
    if (tables.length !== MERGE3_CONTENT_TABLES.length || new Set(tables.map(table => table.name)).size !== MERGE3_CONTENT_TABLES.length
      || tables.some(table => !MERGE3_CONTENT_TABLES.includes(table.name as Merge3ContentTable)))
      return graph3Conflict('merge-original-content-table-closure', side)
  }
  const payload = (side: 'source' | 'current') => {
    const values = data.inputs.knowledge.constraints.payloads.filter(value => !value.witness.domain.length && value.witness.side === side)
    if (values.length !== 1) return graph3Conflict('merge-root-payload-closure', side)
    return { payload: values[0].key, materialHash: data.inputs[side].materialHash, witness: values[0].witness }
  }
  const sourceMaterial = payload('source'), currentMaterial = payload('current')
  const original = (side: 'source' | 'current', name: Merge3ContentTable) => {
    const tables = (side === 'source' ? source : current).tables.filter(table => table.name === name && table.role === 'content')
    return tables.length === 1 ? tables[0] : graph3Conflict('merge-original-content-table', { side, name })
  }
  if (upstream.tables.length !== MERGE3_CONTENT_TABLES.length || new Set(upstream.tables.map(table => table.name)).size !== MERGE3_CONTENT_TABLES.length)
    return graph3Conflict('merge-upstream-content-table-closure', null)
  const candidateByName = new Map(upstream.tables.map(table => [table.name, table]))
  const birthChanges: Array<{ table: typeof definitionTables[number]; sourceRowId: string; currentRowId: string; value: string }> = []
  // Definition reuse preserves the target object's original birth, including
  // the intentionally identified source/target default catalogs. Original
  // source bytes and refs remain untouched; this is a declared candidate patch.
  for (const name of definitionTables) {
    const currentTable = original('current', name)
    const idColumn = currentTable.columns.indexOf('id'), birthColumn = currentTable.columns.indexOf('created_at')
    if (idColumn < 0 || birthColumn < 0) return graph3Conflict('merge-definition-birth-columns', name)
    const target = new Map<string, { readonly sourceRowId: string; readonly birth: unknown }>()
    for (const row of currentTable.rows) {
      target.set(text(graph3Value(row.cells[idColumn], current.encoding)),
        { sourceRowId: row.sourceRowId, birth: graph3Value(row.cells[birthColumn], current.encoding) })
    }
    const candidate = candidateByName.get(name) ?? graph3Conflict('merge-upstream-definition-table', name)
    candidateByName.set(name, graph3PatchTable(candidate, source.encoding, (row, sourceRowId): Record<string, string | null | bigint> => {
      const old = target.get(text(row.id))
      if (!old || row.created_at === old.birth) return {}
      const value = text(old.birth)
      birthChanges.push({ table: name, sourceRowId, currentRowId: old.sourceRowId, value })
      return { created_at: value }
    }))
  }
  const prepared = MERGE3_CONTENT_TABLES.map(name => prepareMerge3Table({ sourceOriginal: original('source', name),
    sourceCandidate: candidateByName.get(name) ?? graph3Conflict('merge-upstream-table', name), currentOriginal: original('current', name),
    sourceEncoding: source.encoding, currentEncoding: current.encoding, source: sourceMaterial, current: currentMaterial }))
  const byName = new Map(prepared.map(table => [table.name, table]))
  const policy = (name: Merge3ContentTable, columns: readonly string[]) => {
    const table = byName.get(name)!
    return { source: [...policyRows(table, 'source', columns)], current: [...policyRows(table, 'current', columns)] }
  }
  const physical = selectMerge3PhysicalRows3(data, prepared)
  const selections = new Map<Merge3ContentTable, { selectedRows: readonly Merge3SelectedRow[]; dispositions: readonly Merge3RowDisposition[] }>(
    physical.tables.map(table => [table.name, table]))
  const conflicts: Merge3Conflict[] = [...physical.conflicts]
  const replacementScopes: Merge3ReplacementScope[] = []
  function scope(table: Merge3ContentTable, ownerKind: Merge3ReplacementScope['ownerKind'], ownerId: string | null,
    sourceRowKeys: readonly string[], currentRowKeys: readonly string[], policy: string): void {
    replacementScopes.push({ key: decision('merge-scope', [table, ownerKind, ownerId, policy]), table, ownerKind, ownerId,
      sourceRowKeys, currentRowKeys, policy })
  }
  const addConflict = (code: string, table: Merge3ContentTable, entries: readonly Row[], detail: unknown) =>
    conflicts.push({ code, table, rowKeys: entries.map(entry => entry.row.key), detail })
  // Definition rows use exact transformed target PKs. No source-absent
  // database/catalog definition is pruned by this new current-aware policy.
  for (const name of definitionTables) {
    const { sourceRows, currentRows } = byName.get(name)!, old = new Map(currentRows.map(row => [pkKey(row)!, row]))
    if (sourceRows.some(row => row.primaryKeyCells === null) || currentRows.some(row => row.primaryKeyCells === null))
      return graph3Conflict('merge-definition-null-pk', name)
    const incoming = new Set(sourceRows.map(row => pkKey(row)!)), selectedRows: Merge3SelectedRow[] = [], dispositions: Merge3RowDisposition[] = []
    for (const row of sourceRows) {
      const previous = old.get(pkKey(row)!)
      selectedRows.push({ rowKey: row.key, replaceCurrentRowKey: previous?.key ?? null })
      dispositions.push({ rowKey: row.key, status: 'selected', decision: decision('source-definition-exact-target-pk', name) })
    }
    for (const row of currentRows) {
      const replaced = incoming.has(pkKey(row)!)
      if (!replaced) selectedRows.push({ rowKey: row.key, replaceCurrentRowKey: null })
      dispositions.push({ rowKey: row.key, status: replaced ? 'replaced' : 'selected',
        decision: decision(replaced ? 'source-definition-exact-target-pk' : 'unparticipating-current-definition-retained', name) })
    }
    selections.set(name, { selectedRows, dispositions })
    scope(name, 'definition', null, sourceRows.map(row => row.key), currentRows.map(row => row.key),
      'source-exact-target-pk-current-others-retained-target-birth-preserved')
  }
  const templateValues = policy('document_templates', ['id', 'created_at'])
  const currentTemplates = new Map(templateValues.current.map(row => [pkKey(row.row)!, row]))
  const sourceTemplates = new Map(templateValues.source.map(row => [pkKey(row.row)!, row]))
  const templateRows: Merge3SelectedRow[] = [], templateDispositions: Merge3RowDisposition[] = [], replacedTemplates = new Set<string>()
  for (const entry of templateValues.source) {
    const old = currentTemplates.get(pkKey(entry.row)!)
    const compatible = old && source.workspaceScope === current.workspaceScope && entry.value.created_at === old.value.created_at
    if (old && !compatible) {
      templateDispositions.push({ rowKey: entry.row.key, status: 'conflict', decision: decision('template-unallocated-incarnation-collision', text(entry.value.id)) })
      addConflict('template-identity-collision-without-exact-workspace-and-birth', 'document_templates', [entry, old], {
        templateId: text(entry.value.id), sourceWorkspaceScope: source.workspaceScope, currentWorkspaceScope: current.workspaceScope,
        sourceCreatedAt: text(entry.value.created_at), currentCreatedAt: text(old.value.created_at), currentPreserved: true,
        templateIdentityAllocated: false
      })
    } else {
      templateRows.push({ rowKey: entry.row.key, replaceCurrentRowKey: old?.row.key ?? null })
      if (old) replacedTemplates.add(old.row.key)
      templateDispositions.push({ rowKey: entry.row.key, status: 'selected', decision: decision(old ? 'template-source-exact-workspace-birth-row' : 'template-source-free-id-insert', text(entry.value.id)) })
    }
    scope('document_templates', 'template', text(entry.value.id), [entry.row.key], old ? [old.row.key] : [], compatible
      ? 'explicit-source-whole-template-row-exact-workspace-id-birth' : old ? 'unallocated-template-collision-current-display-source-conflict' : 'source-free-template-id-insert')
  }
  for (const entry of templateValues.current) {
    const replaced = replacedTemplates.has(entry.row.key)
    if (!replaced) templateRows.push({ rowKey: entry.row.key, replaceCurrentRowKey: null })
    templateDispositions.push({ rowKey: entry.row.key, status: replaced ? 'replaced' : 'selected',
      decision: decision(replaced ? 'template-source-exact-workspace-birth-row' : 'current-template-retained', text(entry.value.id)) })
    if (!sourceTemplates.has(pkKey(entry.row)!)) scope('document_templates', 'template', text(entry.value.id), [], [entry.row.key], 'current-template-outside-source-retained')
  }
  selections.set('document_templates', { selectedRows: templateRows, dispositions: templateDispositions })

  const documents = new Set(physical.participatingDocumentIds)
  const entities = new Set<string>()
  for (const entry of policyRows(byName.get('database_entities')!, 'source', ['id'])) entities.add(text(entry.value.id))
  selectEntityValues()
  selectDocumentAndLegacyValues()
  function selectEntityValues(): void {
    const name = 'database_entity_values', values = policy(name, ['entity_id'])
    const currentByPk = new Map(values.current.map(entry => [pkKey(entry.row)!, entry]))
    const selectedRows: Merge3SelectedRow[] = [], dispositions: Merge3RowDisposition[] = []
    for (const entry of values.source) {
      const owner = text(entry.value.entity_id)
      if (!entities.has(owner)) return graph3Conflict('merge-source-entity-value-owner', owner)
      const old = currentByPk.get(pkKey(entry.row)!)
      selectedRows.push({ rowKey: entry.row.key, replaceCurrentRowKey: old?.row.key ?? null })
      dispositions.push({ rowKey: entry.row.key, status: 'selected', decision: decision('source-whole-entity-value-family', owner) })
    }
    for (const entry of values.current) {
      const owner = text(entry.value.entity_id), replaced = entities.has(owner)
      if (!replaced) selectedRows.push({ rowKey: entry.row.key, replaceCurrentRowKey: null })
      dispositions.push({ rowKey: entry.row.key, status: replaced ? 'replaced' : 'selected',
        decision: decision(replaced ? 'source-whole-entity-value-family' : 'current-unparticipating-entity-values-retained', owner) })
    }
    const sourceByEntity = byOwner(values.source, 'entity_id'), currentByEntity = byOwner(values.current, 'entity_id')
    for (const owner of entities) scope(name, 'entity', owner, sourceByEntity.get(owner) ?? [],
      currentByEntity.get(owner) ?? [], 'source-whole-new-entity-value-family')
    selections.set(name, { selectedRows, dispositions })
  }
  function selectDocumentAndLegacyValues(): void {
    const name = 'document_database_values', values = policy(name, ['document_id', 'entity_id'])
    const selectedRows: Merge3SelectedRow[] = [], dispositions: Merge3RowDisposition[] = []
    const anonymous = (entry: Row) => entry.value.document_id === null && entry.value.entity_id === null
    const sourceAnonymous = values.source.filter(anonymous), currentAnonymous = values.current.filter(anonymous)
    const anonymousSide = choices.anonymousValues !== 'unresolved' ? choices.anonymousValues
      : sourceAnonymous.length && currentAnonymous.length ? 'unresolved' : sourceAnonymous.length ? 'source' : 'current'
    const currentByPk = new Map(values.current.filter(entry => entry.row.primaryKeyCells !== null).map(entry => [pkKey(entry.row)!, entry]))
    const retainedPkConflicts = new Map<string, Row>()
    for (const entry of values.current) {
      if (anonymous(entry)) {
        const kept = anonymousSide !== 'source'
        if (kept) selectedRows.push({ rowKey: entry.row.key, replaceCurrentRowKey: null })
        dispositions.push({ rowKey: entry.row.key, status: kept ? 'selected' : 'replaced',
          decision: decision(anonymousSide === 'unresolved' ? 'anonymous-unresolved-current-display' : 'anonymous-whole-collection-' + anonymousSide, null) })
        continue
      }
      const documentId = nullableText(entry.value.document_id), entityId = nullableText(entry.value.entity_id)
      const documentParticipates = documentId !== null && documents.has(documentId), entityParticipates = entityId !== null && entities.has(entityId)
      const dualConflict = documentId !== null && entityId !== null && documentParticipates !== entityParticipates
      const replaced = !dualConflict && (documentParticipates || entityParticipates)
      if (!replaced) selectedRows.push({ rowKey: entry.row.key, replaceCurrentRowKey: null })
      dispositions.push({ rowKey: entry.row.key, status: replaced ? 'replaced' : 'selected', decision: decision(dualConflict
        ? 'dual-linked-legacy-current-preserved-owner-conflict' : replaced ? 'source-whole-owned-legacy-value-family' : 'current-unparticipating-legacy-values-retained', [documentId, entityId]) })
      if (dualConflict) {
        retainedPkConflicts.set(pkKey(entry.row)!, entry)
        addConflict('legacy-value-dual-owner-only-one-participates', name, [entry], { documentId, entityId, documentParticipates, entityParticipates, currentPreserved: true })
      }
    }
    for (const entry of values.source) {
      if (anonymous(entry)) {
        const kept = anonymousSide === 'source', unresolved = anonymousSide === 'unresolved'
        if (kept) selectedRows.push({ rowKey: entry.row.key, replaceCurrentRowKey: null })
        dispositions.push({ rowKey: entry.row.key, status: kept ? 'selected' : unresolved ? 'conflict' : 'excluded',
          decision: decision(unresolved ? 'anonymous-source-awaits-whole-collection-choice' : 'anonymous-whole-collection-' + anonymousSide, null) })
        continue
      }
      const documentId = nullableText(entry.value.document_id), entityId = nullableText(entry.value.entity_id)
      if (documentId !== null && !documents.has(documentId) || entityId !== null && !entities.has(entityId))
        return graph3Conflict('merge-source-legacy-value-owner', { documentId, entityId })
      const blocked = entry.row.primaryKeyCells === null ? undefined : retainedPkConflicts.get(pkKey(entry.row)!)
      if (blocked) {
        dispositions.push({ rowKey: entry.row.key, status: 'conflict', decision: decision('incoming-value-blocked-by-retained-dual-owner', blocked.row.key) })
        addConflict('incoming-value-pk-blocked-by-retained-dual-owner', name, [entry, blocked], { documentId, entityId, currentPreserved: true })
      } else {
        const old = entry.row.primaryKeyCells === null ? undefined : currentByPk.get(pkKey(entry.row)!)
        selectedRows.push({ rowKey: entry.row.key, replaceCurrentRowKey: old?.row.key ?? null })
        dispositions.push({ rowKey: entry.row.key, status: 'selected', decision: decision('source-whole-owned-legacy-value-family', [documentId, entityId]) })
      }
    }
    if (anonymousSide === 'unresolved') addConflict('anonymous-value-collections-require-explicit-whole-choice', name,
      [...sourceAnonymous, ...currentAnonymous], { sourceOccurrences: sourceAnonymous.length, currentOccurrences: currentAnonymous.length,
        currentDisplayed: true, sourceCurrentOccurrencesComparedByValue: false, preserveUnresolved: true })
    scope(name, 'anonymous-collection', null, sourceAnonymous.map(entry => entry.row.key), currentAnonymous.map(entry => entry.row.key),
      'whole-anonymous-family-' + anonymousSide)
    const sourceByDocument = byOwner(values.source, 'document_id'), currentByDocument = byOwner(values.current, 'document_id')
    const sourceByEntity = byOwner(values.source, 'entity_id', row => row.value.document_id === null)
    const currentByEntity = byOwner(values.current, 'entity_id', row => row.value.document_id === null)
    for (const owner of documents) scope(name, 'document', owner, sourceByDocument.get(owner) ?? [],
      currentByDocument.get(owner) ?? [], 'source-whole-document-value-family-dual-owner-conflicts-preserved')
    for (const owner of entities) scope(name, 'entity', owner, sourceByEntity.get(owner) ?? [], currentByEntity.get(owner) ?? [],
      'source-whole-null-document-legacy-entity-value-family')
    selections.set(name, { selectedRows, dispositions })
  }
  // Physical forests have the same explicit owner scopes as their selector.
  for (const name of MERGE3_PHYSICAL_TABLES) {
    const table = byName.get(name)!
    if (name === 'blocks' || name === 'synced_instances') {
      const column = name === 'blocks' ? 'document_id' : 'host_document_id'
      const sourceByHost = byOwner(policyRows(table, 'source', [column]), column), currentByHost = byOwner(policyRows(table, 'current', [column]), column)
      for (const owner of documents) scope(name, 'document', owner, sourceByHost.get(owner) ?? [], currentByHost.get(owner) ?? [], 'source-whole-host-forest')
    } else if (name === 'synced_group_blocks') {
      const column = 'group_id'
      const sourceByGroup = byOwner(policyRows(table, 'source', [column]), column), currentByGroup = byOwner(policyRows(table, 'current', [column]), column)
      for (const owner of physical.participatingGroupIds)
        scope(name, 'group', owner, sourceByGroup.get(owner) ?? [], currentByGroup.get(owner) ?? [], 'source-whole-canonical-forest')
    }
    else scope(name, name === 'documents' ? 'document' : 'group', null, table.sourceRows.map(row => row.key),
      table.currentRows.map(row => row.key), 'source-exact-header-current-unparticipating-retained')
  }
  const finished = prepared.map(table => {
    const selection = selections.get(table.name) ?? graph3Conflict('merge-missing-table-dispositions', table.name)
    return finishMerge3Table(table, selection.selectedRows, selection.dispositions)
  })
  assertMerge3StorageTablesBudget(finished)
  const layout = applyMerge3DocumentLayout3(data, finished.map(value => value.table))
  const finalByName = new Map(layout.tables.map(table => [table.name, table]))
  if (layout.tables.length !== MERGE3_CONTENT_TABLES.length || finalByName.size !== MERGE3_CONTENT_TABLES.length)
    return graph3Conflict('merge-layout-content-table-closure', null)
  const finalFinished = finished.map(value => ({ ...value, table: finalByName.get(value.table.name) ?? graph3Conflict('merge-layout-table-missing', value.table.name) }))
  assertMerge3StorageTablesBudget(finalFinished)
  const catalogConflicts = validateCatalogRelations(finalFinished.map(value => value.table), data.value.targetCatalogId)
  conflicts.push(...layout.conflicts, ...catalogConflicts)
  const storage = finished.map(value => ({ name: value.table.name, preparedHash: value.preparedHash, storageHash: value.storageHash,
    dispositions: value.dispositions, conflicts: value.conflicts }))
  const replacedCurrentRows = storage.flatMap(table => table.dispositions.filter(row => row.sourceRef.side === 'current' && row.status === 'replaced').map(row => row.sourceRef))
  const reusedCurrentRefs = new Set(finished.flatMap(table => table.table.rows.flatMap(row => row.replaces ? [graph3Key(row.replaces)] : [])))
  const removedCurrentRows = replacedCurrentRows.filter(ref => !reusedCurrentRefs.has(graph3Key(ref)))
  const birthRows = new Map(definitionTables.map(name => {
    const table = byName.get(name)!
    return [name, { source: new Map(table.sourceRows.map(row => [row.ref.sourceRowId, row])), current: new Map(table.currentRows.map(row => [row.ref.sourceRowId, row])) }] as const
  }))
  const definitionBirthRetentions = birthChanges.map(change => {
    const table = birthRows.get(change.table)!, sourceRow = table.source.get(change.sourceRowId)!, currentRow = table.current.get(change.currentRowId)!
    return { table: change.table, column: 'created_at' as const, sourceRef: sourceRow.ref, currentRef: currentRow.ref, value: change.value }
  })
  const body = { kind: 'root-restore-current-aware-merged-content-candidate' as const, version: 3 as const,
    scope: 'root-source-and-current-content' as const, conservationHash: data.inputs.knowledge.conservationHash,
    identityAllocationHash: data.value.allocationHash, templateReferenceHash: upstream.templateReferenceHash,
    sourceMaterialHash: data.inputs.source.materialHash, currentMaterialHash: data.inputs.current.materialHash,
    sourceEncoding: source.encoding, currentEncoding: current.encoding, targetEncoding: current.encoding,
    tables: finalFinished.map(value => value.table), storage, definitionBirthRetentions,
    physical: { physicalSelectionHash: physical.physicalSelectionHash, participatingDocumentIds: physical.participatingDocumentIds,
      participatingGroupIds: physical.participatingGroupIds, participatingGroups: physical.participatingGroups, groupStates: physical.groupStates,
      physicalShapeValidated: physical.physicalShapeValidated, originalGroupActivityPreserved: physical.originalGroupActivityPreserved,
      rewrittenBindingsValidated: false as const, expandedProjectionBudgetValidated: false as const },
    layout: { layoutHash: layout.layoutHash, changes: layout.changes }, choices, replacementScopes,
    replacedCurrentRows, removedCurrentRows, conflicts, conflictFree: conflicts.length === 0,
    policy: { participatingHosts: 'source-whole-forest-current-other-hosts-retained', participatingCanonical: 'source-whole-forest-current-other-groups-retained',
      definitions: 'source-exact-target-pk-current-other-definitions-retained-target-created-at-preserved',
      templates: 'source-row-replaces-only-exact-workspace-id-created-at-otherwise-current-and-conflict',
      values: 'source-whole-participating-owner-family-legacy-and-new-families-remain-distinct',
      dualLinkedLegacyValues: 'one-owner-participating-retains-current-blocks-same-pk-source-and-conflicts',
      anonymousValues: 'whole-family-explicit-choice-both-nonempty-default-unresolved-current-display',
      sourceAbsentDefinitionsPruned: false, sourceAbsentDocumentsDeleted: false, sourceHistoryReplayed: false, sourcePolicyReplayed: false } as const,
    fullCurrentContentSelectionComplete: true as const, catalogRelationsValidated: catalogConflicts.length === 0,
    catalogNameNativeCheckPending: true as const, referenceRewriteComplete: false as const,
    semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  assertMerge3JsonBudget(body)
  const mergedContentHash = hashBoundedCapsuleJson(body, CAPSULE2_RAW_MAX_JSON_BYTES, 'knowbook.restore.merge3.content.v1\0')
    ?? graph3Conflict('complete-merged-content-budget', null)
  return freezeCapsuleValue({ ...body, mergedContentHash })
}

function validateCatalogRelations(tables: readonly FinalTable[], catalogId: string): Merge3Conflict[] {
  const byName = new Map(tables.map(table => [table.name, table])), conflicts: Merge3Conflict[] = []
  const definitions = (name: 'documents' | typeof definitionTables[number], columns: readonly string[] = []) => {
    const table = byName.get(name)!, values = new Map<string, FinalEntry>()
    for (const entry of finalRows(table, ['id', ...columns])) values.set(text(entry.value.id), entry)
    if (values.size !== table.rows.length) return graph3Conflict('merge-final-definition-pk', name)
    return values
  }
  const documents = definitions('documents'), databases = definitions('databases')
  const columns = definitions('document_database_columns', ['database_id']), views = definitions('database_saved_views', ['database_id'])
  const entities = definitions('database_entities', ['database_id', 'document_id'])
  const conflict = (code: string, table: Merge3ContentTable, rows: readonly FinalEntry[], detail: unknown) =>
    conflicts.push({ code, table, rowKeys: rows.map(row => row.row.key), detail })
  if (!databases.has(catalogId)) conflict('merged-default-catalog-missing', 'databases', [], { catalogId })
  for (const [name, definitions] of [['document_database_columns', columns], ['database_saved_views', views], ['database_entities', entities]] as const) {
    for (const entry of definitions.values()) {
      const databaseId = text(entry.value.database_id)
      if (!databases.has(databaseId)) conflict('merged-catalog-definition-database-missing', name, [entry], { databaseId })
    }
  }
  const linkedDocuments = new Map<string, FinalEntry>()
  for (const entry of entities.values()) {
    const documentId = nullableText(entry.value.document_id)
    if (documentId === null) continue
    if (!documents.has(documentId)) conflict('merged-entity-document-missing', 'database_entities', [entry], { documentId })
    const key = graph3Key(text(entry.value.database_id), documentId), old = linkedDocuments.get(key)
    if (old) conflict('merged-entity-document-owner-not-unique', 'database_entities', [old, entry], { databaseId: text(entry.value.database_id), documentId })
    else linkedDocuments.set(key, entry)
  }
  for (const name of ['database_entity_values', 'document_database_values'] as const) for (const entry of finalRows(byName.get(name)!,
    name === 'document_database_values' ? ['column_id', 'entity_id', 'document_id'] : ['column_id', 'entity_id'])) {
    const fieldId = text(entry.value.column_id), field = columns.get(fieldId), entityId = nullableText(entry.value.entity_id)
    if (!field) conflict('merged-value-column-missing', name, [entry], { columnId: fieldId })
    if (name === 'document_database_values') {
      const documentId = nullableText(entry.value.document_id)
      if (documentId !== null && !documents.has(documentId)) conflict('merged-value-document-missing', name, [entry], { documentId })
    }
    if (name === 'database_entity_values' && entityId === null) conflict('merged-entity-value-owner-null', name, [entry], { columnId: fieldId })
    if (entityId !== null) {
      const entity = entities.get(entityId)
      if (!entity) conflict('merged-value-entity-missing', name, [entry], { entityId })
      else if (field && entity.value.database_id !== field.value.database_id)
        conflict('merged-value-entity-column-database-mismatch', name, [entry, entity, field], { entityId, columnId: fieldId })
    }
  }
  // Missing authored targets stay missing. Only an actually present saved view
  // with another database owner is contradictory, exactly as the raw reader.
  for (const name of ['blocks', 'synced_group_blocks'] as const) {
    const table = byName.get(name)!, content = table.columns.indexOf('content')
    for (const entry of finalRows(table, ['type'])) if (entry.value.type === 'database-view') {
      const atom = parseDatabaseViewPayload(text(graph3Value(entry.row.cells[content], table.encoding)))
      const view = atom.viewId === null ? undefined : views.get(atom.viewId)
      if (view && view.value.database_id !== atom.databaseId) conflict('merged-physical-view-database-owner-mismatch', name, [entry, view], {
        databaseId: atom.databaseId, viewId: atom.viewId
      })
    }
  }
  return conflicts
}
