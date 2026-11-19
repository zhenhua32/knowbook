import Database from 'better-sqlite3'
import type { SyncedBindingKey, SyncedCanonicalWire, SyncedGroupWire, SyncedLinkBinding } from '../../shared/synced-blocks'
import { validateSyncedGroupWire, validateSyncedOrigin, SyncedValidationError, parseSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { validateSyncedWorkspaceGraph, expandSyncedGraphDocument } from '../../shared/syncedBlockGraph'
import { projectSyncedGroupBudget } from '../../shared/syncedBlockPortable'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { escapeMarkdownDestination, parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { parseWikiReference } from '../../shared/markdownWiki'
import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { hashBoundedCapsuleJson } from './restore-knowledge-capsule-json-hash'
import { CAPSULE2_RAW_MAX_JSON_BYTES, type Capsule2RawContent, type Capsule2RawSqlRow, type Capsule2RawSqlTable } from './restore-knowledge-capsule2-raw-model'
import { findGraph3OriginalRow, graph3Conflict, graph3Encode, graph3Key, graph3Value, type Graph3Inputs } from './restore-knowledge-graph3-data'
import { assertMerge3JsonBudget, type MergedRow3 } from './restore-knowledge-merge3-storage'
import type { RootRestoreMergedContentChoices3 } from './restore-knowledge-merge3-read'
import { deriveRootRestoreNavigationRewrite3 } from './restore-knowledge-navigation3-rewrite-model'
import { resolveFinalNavigation3, withStoredMerge3NavigationFinalIndex3,
  type Navigation3FinalIndex, type Navigation3Table, type StoredNavigation3Index } from './restore-knowledge-navigation3-merge-context'
import { renderNavigation3Destination } from './restore-knowledge-navigation3-rewrite-cells'
import { deriveRootRestoreReferenceAllocation3, toReference3GraphInputs } from './restore-knowledge-reference3-model'
import { collectSyncedBindingOccurrences } from '../sync/synced-binding-occurrences'
import { captureSyncedCreateSourceFacts } from './synced-host-create-plan'
import { transformCanonical3Cell, rewriteCanonical3OriginJson, type Canonical3TextEdit } from './restore-knowledge-canonical3-cells'
import { withSelectedPendingLocalBody5 } from './restore-knowledge-pending-local-cell5'
import type { SelectedPendingLocalBody5 } from './restore-knowledge-pending-local-selection5'
import { withStoredRestoreScopes } from './restore-knowledge-stored-scopes'

type Allocation = ReturnType<typeof deriveRootRestoreReferenceAllocation3>
type Side = 'source' | 'current'
type Entry = { table: Navigation3Table; row: MergedRow3; ordinal: number; value: Record<string, unknown> }
type FinalScope = Navigation3FinalIndex['scopes'][number]
type PriorOccurrence = { occurrenceKey: string; block: Omit<FinalScope['blocks'][number]['block'], 'content'> }
export interface Canonical3Conflict { readonly code: string; readonly side: Side | null; readonly rowKeys: readonly string[]; readonly detail: unknown }
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const keyOf = (key: SyncedBindingKey) => graph3Key(key.blockId, key.from, key.to, key.raw, key.syntax)
const onlyKey = ({ blockId, from, to, raw, syntax }: SyncedBindingKey): SyncedBindingKey => ({ blockId, from, to, raw, syntax })
const string = (value: unknown) => typeof value === 'string' ? value : graph3Conflict('canonical3-text', typeof value)
type EntryProjection = Readonly<Partial<Record<Navigation3Table['name'], readonly string[]>>>
const selectedGroupColumns = {
  synced_groups: ['id', 'creation_id', 'origin_json', 'bindings_json']
} satisfies EntryProjection

function originalTable(raw: Capsule2RawContent, name: 'synced_groups' | 'synced_group_blocks' | 'block_identities') {
  return raw.tables.find(table => table.name === name) ?? graph3Conflict('missing-source-table', name)
}

function originalValue(raw: Capsule2RawContent, table: Capsule2RawSqlTable, row: Capsule2RawSqlRow, column: string) {
  const index = table.columns.indexOf(column)
  return index < 0 ? undefined : graph3Value(row.cells[index], raw.encoding)
}

const ownerKey = (owner: string) => Buffer.from(owner, 'utf16le')
function indexSelectedBlocks(db: Database.Database, tables: readonly Navigation3Table[]) {
  const table = tables.find(table => table.name === 'synced_group_blocks') ?? graph3Conflict('canonical3-missing-selected-canonical-table', null)
  const columns = table.columns, owner = columns.indexOf('group_id'), id = columns.indexOf('id'), content = columns.indexOf('content')
  if (owner < 0 || id < 0 || content < 0) return graph3Conflict('canonical3-projection-column', { table: table.name })
  db.exec(`CREATE TEMP TABLE canonical_selected_members (owner BLOB NOT NULL, ordinal INTEGER NOT NULL,
    PRIMARY KEY(owner,ordinal)) WITHOUT ROWID`)
  const insert = db.prepare('INSERT INTO canonical_selected_members(owner,ordinal) VALUES (?,?)')
  db.transaction(() => {
    for (const [ordinal, row] of table.rows.entries())
      insert.run(ownerKey(string(graph3Value(row.cells[owner], table.encoding))), ordinal)
  })()
  const select = db.prepare('SELECT ordinal FROM canonical_selected_members WHERE owner=? ORDER BY ordinal').pluck()
  return {
    table, content,
    id: (row: MergedRow3) => string(graph3Value(row.cells[id], table.encoding)),
    *rows(group: string) {
      for (const ordinal of select.iterate(ownerKey(group)) as IterableIterator<number>) yield { ordinal, row: table.rows[ordinal] }
    }
  }
}

function stageCanonicalCellPatches(db: Database.Database) {
  db.exec(`CREATE TEMP TABLE canonical_cell_patches (table_name TEXT NOT NULL,
    ordinal INTEGER NOT NULL, column_index INTEGER NOT NULL, text_units BLOB NOT NULL,
    PRIMARY KEY(table_name,ordinal,column_index)) WITHOUT ROWID`)
  const write = db.prepare('INSERT INTO canonical_cell_patches VALUES (?,?,?,?)')
  const read = db.prepare('SELECT ordinal,column_index,text_units FROM canonical_cell_patches WHERE table_name=? ORDER BY ordinal,column_index')
  type Patch = { ordinal: number; column_index: number; text_units: Buffer }
  return {
    set(table: Navigation3Table, ordinal: number, column: number, value: string) {
      // Preserve exact JS code units until the target table encoding is applied.
      write.run(table.name, ordinal, column, Buffer.from(value, 'utf16le'))
    },
    apply(table: Navigation3Table): Navigation3Table {
      let rows: MergedRow3[] | undefined
      let previousOrdinal = -1
      let cells: MergedRow3['cells'][number][] = []
      for (const { ordinal, column_index, text_units } of read.iterate(table.name) as IterableIterator<Patch>) {
        rows ??= table.rows.slice()
        if (ordinal !== previousOrdinal) {
          const row = table.rows[ordinal]
          cells = row.cells.slice()
          rows[ordinal] = { ...row, cells }
          previousOrdinal = ordinal
        }
        cells[column_index] = graph3Encode(text_units.toString('utf16le'), table.encoding)
      }
      return rows === undefined ? table : { ...table, rows }
    }
  }
}

function indexFinalMembers(db: Database.Database, final: Pick<StoredNavigation3Index, 'physicalLocations' | 'physicalBlock'>, tables: readonly Navigation3Table[]) {
  db.exec(`CREATE TEMP TABLE canonical_final_members (kind TEXT NOT NULL, owner BLOB NOT NULL, sort_order INTEGER NOT NULL,
    ordinal INTEGER NOT NULL, PRIMARY KEY(kind,owner,sort_order,ordinal)) WITHOUT ROWID`)
  const insert = db.prepare('INSERT INTO canonical_final_members(kind,owner,sort_order,ordinal) VALUES (?,?,?,?)')
  db.transaction(() => {
    let ordinal = 0
    for (const table of tables) {
      if (table.name !== 'blocks' && table.name !== 'synced_group_blocks') continue
      const kind = table.name === 'blocks' ? 'document' : 'group', sortColumn = table.columns.indexOf('sort_order')
      for (const row of table.rows) {
        const block = final.physicalLocations[ordinal], cell = row.cells[sortColumn]
        if (!block || block.rowKey !== row.key) return graph3Conflict('canonical3-physical-row-order', row.key)
        if (cell?.[0] !== 'integer') return graph3Conflict('canonical3-order-storage', null)
        const owner = string(kind === 'document' ? block.documentId : block.groupId)
        insert.run(kind, ownerKey(owner), BigInt(cell[1]), ordinal++)
      }
    }
    if (ordinal !== final.physicalLocations.length) return graph3Conflict('canonical3-physical-row-order', null)
  })()
  const select = db.prepare('SELECT ordinal FROM canonical_final_members WHERE kind=? AND owner=? ORDER BY sort_order,ordinal').pluck()
  return function* members(kind: 'document' | 'group', owner: string) {
    for (const ordinal of select.iterate(kind, ownerKey(owner)) as IterableIterator<number>) {
      const { id, rowKey } = final.physicalLocations[ordinal]
      yield final.physicalBlock(id) ?? graph3Conflict('canonical3-physical-row-order', rowKey)
    }
  }
}

/** The preceding navigation index has already read and validated every cell
 * of these same tables. Keep the fields that the canonical lookups consume. */
function* projectEntries(tables: readonly Navigation3Table[], projection: EntryProjection): IterableIterator<Entry> {
  for (const table of tables) {
    const fields = projection[table.name]
    if (!fields) continue
    const columns = fields.map(column => {
      const index = table.columns.indexOf(column)
      if (index < 0) return graph3Conflict('canonical3-projection-column', { table: table.name, column })
      return { column, index }
    })
    for (const [ordinal, row] of table.rows.entries()) {
      const value = Object.fromEntries(columns.map(({ column, index }) => [column, graph3Value(row.cells[index], table.encoding)]))
      yield { table, row, ordinal, value }
    }
  }
}

/** Replace only the block coordinate. Keep the original path, query and alias. */
function remappedBlockUrl(url: string, syntax: 'markdown' | 'wiki', id: string) {
  if (syntax === 'wiki') {
    const reference = parseWikiReference(url), tail = reference.alias === null ? '' : url.slice(url.indexOf('|'))
    return (reference.hasFragment ? reference.path : '') + '#^' + id + tail
  }
  const local = parseLocalMarkdownUrl(url)
  if (!local) return graph3Conflict('canonical3-not-local-block-link', url)
  return url.split(/[?#]/, 1)[0] + local.suffix.split('#', 1)[0] + '#^' + encodeURIComponent(id)
}

/** Fixed pure pipeline; data and allocation are supplied by the new genuine
 * Main reference owner. Old identity3 manifests/DTOs are never mutated. */
export function deriveRootRestoreCanonicalCandidate3(data: Graph3Inputs, allocation: Allocation, choices?: RootRestoreMergedContentChoices3) {
  return deriveRootRestoreCanonicalCandidateWithCells3(data, allocation, choices).candidate
}

/** Runtime-only cell/range evidence from the same candidate derivation. */
export function deriveRootRestoreCanonicalCandidateWithCells3(data: Graph3Inputs, allocation: Allocation,
  choices?: RootRestoreMergedContentChoices3, pending?: SelectedPendingLocalBody5) {
  const db = new Database(':memory:')
  try {
    db.pragma('temp_store=FILE')
    if (db.pragma('temp_store', { simple: true }) !== 1) return graph3Conflict('canonical3-file-index-unavailable', null)
    db.pragma('temp.cache_size=-2048')
    return deriveWithCanonicalIndexes(db, data, allocation, choices, pending)
  } finally { db.close() }
}

function deriveWithCanonicalIndexes(db: Database.Database, data: Graph3Inputs, allocation: Allocation,
  choices?: RootRestoreMergedContentChoices3, pending?: SelectedPendingLocalBody5) {
  const derived = toReference3GraphInputs(data, allocation)
  const ordinary = deriveRootRestoreNavigationRewrite3(derived, choices)
  // Keep the original occurrence structure for the final grammar check. The
  // check uses rewritten content, so the original physical index can close first.
  return withStoredRestoreScopes((append: (id: string, blocks: PriorOccurrence[]) => void) => {
    const project = (before: StoredNavigation3Index, ordinaryTables: readonly Navigation3Table[]) => {
      const rewrite = rewriteCanonicalGroups(db, data, allocation, ordinaryTables, before)
      for (const scope of before.scopes()) {
        append(scope.scopeId, scope.blocks.map(({ occurrenceKey, block: { content: _content, ...block } }) => ({ occurrenceKey, block })))
      }
      return rewrite
    }
    if (pending) return withSelectedPendingLocalBody5(derived, ordinary, pending, project)
    return { selection: withStoredMerge3NavigationFinalIndex3(derived, ordinary.tables, index => project(index, ordinary.tables)), proof: undefined }
  }, ({ selection, proof }, prior) => finalizeCanonicalCandidate(db, data, allocation, derived, ordinary, selection, proof, prior.byId))
}

function rewriteCanonicalGroups(db: Database.Database, data: Graph3Inputs, allocation: Allocation, ordinaryTables: readonly Navigation3Table[],
  before: Pick<StoredNavigation3Index, 'documents' | 'physicalLocations'>) {
  const originals = (side: Side) => {
    const raw = data.inputs[side].source.sourceContent
    return { raw, groups: originalTable(raw, 'synced_groups'), blocks: originalTable(raw, 'synced_group_blocks') }
  }
  const original = { source: originals('source'), current: originals('current') }
  const currentGroupRows = new Map<unknown, Capsule2RawSqlRow>()
  for (const row of original.current.groups.rows)
    currentGroupRows.set(originalValue(original.current.raw, original.current.groups, row, 'id'), row)
  const groupBlocks = indexSelectedBlocks(db, ordinaryTables), active = new Set<string>()
  const knowledgeGroups = new Map((['source', 'current'] as const).map(side => [side,
    new Map(data.inputs[side].knowledge.groups.map(group => [group.tuple.groupId, group]))] as const))
  const facts = new Map((['source', 'current'] as const).map(side => [side,
    new Map(data.inputs[side].source.physical.groups.map(group => [group.groupId, group]))] as const))
  const origins = new Map<string, Allocation['origins'][number]>()
  for (const origin of allocation.origins) {
    const key = graph3Key(origin.side, origin.sourceGroupId)
    if (origins.has(key)) return graph3Conflict('canonical3-origin-duplicate', key)
    origins.set(key, origin)
  }
  const targets = new Map<string, Allocation['bindingTargets'][number]>()
  for (const target of allocation.bindingTargets) {
    const key = graph3Key(target.side, target.sourceGroupId, keyOf(target.key))
    if (targets.has(key)) return graph3Conflict('canonical3-binding-target-duplicate', key)
    targets.set(key, target)
  }
  const changes = stageCanonicalCellPatches(db), conflicts: Canonical3Conflict[] = []
  const conflict = (code: string, side: Side | null, rowKeys: readonly string[], detail: unknown) => conflicts.push({ code, side, rowKeys, detail })
  const edits: Array<{ side: Side; table: 'synced_group_blocks'; rowKey: string; column: 'content'; key: SyncedBindingKey; after: string }> = []
  const bindingProjections: Array<{ side: Side; groupId: string; rowKey: string; original: SyncedLinkBinding; binding: SyncedLinkBinding;
    proofKind: string; sourceGroupSource: unknown; originalHint: unknown }> = []
  const originProjections: Array<{ side: Side; groupId: string; rowKey: string; before: string; after: string; retainedFromCurrent: boolean }> = []
  const inactive: Array<{ side: Side; sourceGroupId: string; targetGroupId: string; rowKey: string }> = []
  const currentDocs = new Map(data.inputs.current.source.physical.documents.map(document => [document.documentId, document]))
  const finalDocs = new Map(before.documents.map(document => [document.id, document]))
  const finalBlockHosts = new Map(before.physicalLocations.map(block => [block.id, block.documentId]))

  for (const entry of projectEntries(ordinaryTables, selectedGroupColumns)) {
    const ref = entry.row.sourceRef, side = ref.side, { raw, groups, blocks } = original[side]
    const rawGroup = findGraph3OriginalRow(groups, ref.sourceRowId)
    if (!rawGroup) return graph3Conflict('canonical3-original-group-row', ref)
    const sourceId = string(originalValue(raw, groups, rawGroup, 'id')), groupId = string(entry.value.id)
    const originalOriginJson = originalValue(raw, groups, rawGroup, 'origin_json')
    const knowledge = knowledgeGroups.get(side)!.get(sourceId), fact = facts.get(side)!.get(sourceId)
    const origin = origins.get(graph3Key(side, sourceId))
    if (!knowledge || !fact || !origin || !same(origin.sourceGroupSource, knowledge.source) || origin.comparisonKey !== knowledge.comparisonKey
      || origin.targetGroupId !== groupId || origin.targetCreationId !== entry.value.creation_id
      || origin.originalOriginJson !== originalOriginJson) return graph3Conflict('canonical3-origin-source-join', { ref, origin })
    const originalOriginText = string(originalOriginJson), originalOrigin = validateSyncedOrigin(JSON.parse(originalOriginText))
    if (origin.origin.pathAtCreation !== originalOrigin.pathAtCreation) return graph3Conflict('canonical3-origin-path-changed', origin)
    let nextOrigin = rewriteCanonical3OriginJson(originalOriginText, origin.origin).text
    if (origin.originPolicy === 'retained-current') {
      const retained = currentGroupRows.get(groupId), currentKnowledge = knowledgeGroups.get('current')!.get(groupId)
      if (!retained || !currentKnowledge || currentKnowledge.comparisonKey !== (origin.retainedComparisonKey ?? knowledge.comparisonKey))
        return graph3Conflict('canonical3-retained-current-origin-tuple', groupId)
      const retainedOrigin = string(originalValue(original.current.raw, original.current.groups, retained, 'origin_json'))
      if (!same(validateSyncedOrigin(JSON.parse(retainedOrigin)), origin.origin))
        return graph3Conflict('canonical3-retained-current-origin-tuple', groupId)
      nextOrigin = retainedOrigin
    }
    if (nextOrigin !== entry.value.origin_json) changes.set(entry.table, entry.ordinal, entry.table.columns.indexOf('origin_json'), nextOrigin)
    originProjections.push({ side, groupId, rowKey: entry.row.key, before: string(entry.value.origin_json), after: nextOrigin,
      retainedFromCurrent: origin.originPolicy === 'retained-current' })
    if (fact.snapshot === null) {
      inactive.push({ side, sourceGroupId: sourceId, targetGroupId: groupId, rowKey: entry.row.key })
      if (side === 'source') conflict('inactive-source-materialization-policy-pending', side, [entry.row.key], { sourceId, groupId })
      continue
    }
    active.add(groupId)
    const snapshot = fact.snapshot, oldBindings = snapshot.bindings, parsed = collectSyncedBindingOccurrences(snapshot.origin, snapshot.blocks)
    const parsedKeys = new Map(parsed.map(item => [keyOf(item), item]))
    if (parsedKeys.size !== parsed.length || parsed.length !== oldBindings.length) return graph3Conflict('canonical3-original-parser-closure', sourceId)
    const grammar = new Map(collectDocumentMarkdownLinks(snapshot.blocks).map(link => [graph3Key(link.blockId, link.start, link.end), link]))
    const bindingsByBlock = new Map<string, SyncedLinkBinding[]>()
    for (const binding of oldBindings) { const list = bindingsByBlock.get(binding.blockId) ?? []; list.push(binding); bindingsByBlock.set(binding.blockId, list) }
    const originalToFinal = new Map<string, { ordinal: number; row: MergedRow3 }>()
    for (const selected of groupBlocks.rows(groupId)) {
      const block = selected.row
      if (block.sourceRef.side !== side) return graph3Conflict('canonical3-mixed-group-forest-source', block.sourceRef)
      const originalBlock = findGraph3OriginalRow(blocks, block.sourceRef.sourceRowId)
      if (!originalBlock || originalValue(raw, blocks, originalBlock, 'group_id') !== sourceId)
        return graph3Conflict('canonical3-canonical-row-source', block.sourceRef)
      originalToFinal.set(string(originalValue(raw, blocks, originalBlock, 'id')), selected)
    }
    if (originalToFinal.size !== snapshot.blocks.length) return graph3Conflict('canonical3-whole-canonical-forest', sourceId)
    const cellEdits = new Map<string, Canonical3TextEdit[]>(), effective = new Map<string, Allocation['bindingTargets'][number]>()
    for (const binding of oldBindings) {
      const parsedLink = parsedKeys.get(keyOf(binding)), target = targets.get(graph3Key(side, sourceId, keyOf(binding)))
      const block = originalToFinal.get(binding.blockId)?.row
      if (!parsedLink || !block || !target || !same(target.sourceGroupSource, knowledge.source) || target.comparisonKey !== knowledge.comparisonKey
        || !same(target.originalTarget, binding.target) || target.sourceCapture.provenance !== 'current-stored'
        || !same(target.sourceCapture.source, knowledge.source) || !same(target.sourceCapture.binding, binding))
        return graph3Conflict('canonical3-binding-source-join', { binding, target })
      effective.set(keyOf(binding), target)
      const role = grammar.get(graph3Key(binding.blockId, binding.from, binding.to))
      if (!role || role.url !== parsedLink.url) return graph3Conflict('canonical3-binding-grammar-source', binding)
      let replacement = binding.raw
      if (side === 'source' && target.target.kind === 'block' && (target.proofKind === 'qualified-missing'
        || target.proofKind === 'proved-same-source-group-block' && binding.target.kind === 'block' && binding.target.id !== target.target.id)) {
        const url = remappedBlockUrl(parsedLink.url, binding.syntax, target.target.id)
        replacement = role.kind === 'wiki' ? binding.raw.includes('\\|') ? url.replace(/\|/g, '\\|') : url
          : escapeMarkdownDestination(url, role.syntax)
      } else if (side === 'current' && target.proofKind === 'current-domain-preserved') {
        if (!same(target.target, binding.target)) return graph3Conflict('canonical3-current-target-reinterpreted', binding)
        const targetDocId = binding.target.kind === 'document' ? binding.target.id : binding.target.kind === 'heading' ? binding.target.documentId
          : binding.target.kind === 'block' ? finalBlockHosts.get(binding.target.id) : null
        const old = targetDocId ? currentDocs.get(targetDocId) : undefined, final = targetDocId ? finalDocs.get(targetDocId) : undefined
        if (old && final && old.createdAt === final.birth && old.path !== final.path) {
          const desired = binding.target.kind === 'document' ? { kind: 'document' as const, documentId: final.id, documentPath: final.path }
            : binding.target.kind === 'block' ? { kind: 'block' as const, documentId: final.id, documentPath: final.path, blockId: binding.target.id }
              : binding.target.kind === 'heading' ? { kind: 'heading' as const, documentId: final.id, documentPath: final.path, slug: binding.target.slug } : null
          if (desired) {
            const rendered = renderNavigation3Destination({ key: binding, url: parsedLink.url,
              grammar: { kind: role.kind, syntax: role.kind === 'wiki' ? 'wiki' : role.syntax ?? null } },
            { documentId: origin.origin.documentId, path: origin.origin.pathAtCreation }, desired)
            if ('reason' in rendered) conflict('canonical3-current-path-rewrite-unrepresentable', side, [block.key], { binding, reason: rendered.reason })
            else replacement = rendered.replacement
          }
        }
      }
      if (replacement !== binding.raw) {
        const list = cellEdits.get(binding.blockId) ?? []; list.push({ key: onlyKey(binding), after: replacement }); cellEdits.set(binding.blockId, list)
      }
    }
    const projectedByBinding = new Map<SyncedLinkBinding, SyncedBindingKey>()
    for (const block of snapshot.blocks) {
      const { row: selectedBlock, ordinal } = originalToFinal.get(block.id)!, ownBindings = bindingsByBlock.get(block.id) ?? []
      const content = string(graph3Value(selectedBlock.cells[groupBlocks.content], groupBlocks.table.encoding))
      if (ownBindings.length && content !== block.content) return graph3Conflict('canonical3-content-already-rewritten', block.id)
      const transformedCell = transformCanonical3Cell(content, ownBindings.map(onlyKey), cellEdits.get(block.id) ?? [], groupBlocks.table.encoding)
      if (transformedCell.text !== content) changes.set(groupBlocks.table, ordinal, groupBlocks.content, transformedCell.text)
      for (const edit of transformedCell.edits) edits.push({ side, table: 'synced_group_blocks', rowKey: selectedBlock.key, column: 'content', ...edit })
      for (const binding of ownBindings) projectedByBinding.set(binding, transformedCell.project(onlyKey(binding)))
    }
    const bindings: SyncedLinkBinding[] = oldBindings.map(binding => {
      const target = effective.get(keyOf(binding))!, { row: block } = originalToFinal.get(binding.blockId)!
      const projected = projectedByBinding.get(binding)!
      const next = { ...projected, blockId: groupBlocks.id(block), target: target.target }
      bindingProjections.push({ side, groupId, rowKey: block.key, original: binding, binding: next, proofKind: target.proofKind,
        sourceGroupSource: target.sourceGroupSource, originalHint: target.originalHint })
      return next
    })
    if (!same(bindings, JSON.parse(string(entry.value.bindings_json))))
      changes.set(entry.table, entry.ordinal, entry.table.columns.indexOf('bindings_json'), capsuleJson(bindings))
  }
  const tables = ordinaryTables.map(changes.apply)
  assertFinalStorageBudget(tables)
  return { tables, active, conflicts, edits, bindingProjections, originProjections, inactive }
}

function finalizeCanonicalCandidate(db: Database.Database, data: Graph3Inputs, allocation: Allocation, derived: Graph3Inputs,
  ordinary: ReturnType<typeof deriveRootRestoreNavigationRewrite3>, rewrite: ReturnType<typeof rewriteCanonicalGroups>,
  pendingProof: ReturnType<typeof withSelectedPendingLocalBody5>['proof'] | undefined,
  priorScope: (scopeId: string) => readonly PriorOccurrence[] | undefined) {
  const { tables, active, conflicts, edits, bindingProjections, originProjections, inactive } = rewrite
  const conflict: Conflict = (code, side, rowKeys, detail) => { conflicts.push({ code, side, rowKeys, detail }) }
  return withStoredMerge3NavigationFinalIndex3(derived, tables, final => {
    const physicalMembers = indexFinalMembers(db, final, tables)
    const afterGroups = new Map<string, Entry>()
    for (const entry of projectEntries(tables, { synced_groups: ['id'] })) afterGroups.set(string(entry.value.id), entry)
    const wires: SyncedGroupWire[] = []
    for (const id of active) {
      const { table, row } = afterGroups.get(id)!
      const field = (name: string) => {
        const index = table.columns.indexOf(name)
        if (index < 0) return graph3Conflict('canonical3-projection-column', { table: table.name, column: name })
        return graph3Value(row.cells[index], table.encoding)
      }
      const blocks = Array.from(physicalMembers('group', id), block => ({ ...block.block, createdAt: block.birth })) as SyncedCanonicalWire[]
      const wire = validateSyncedGroupWire({ kind: 'synced-group', id, creationId: field('creation_id'), createdAt: field('created_at'),
        origin: JSON.parse(string(field('origin_json'))), bindings: JSON.parse(string(field('bindings_json'))), blocks })
      const parsed = collectSyncedBindingOccurrences(wire.origin, wire.blocks), actual = new Set(parsed.map(keyOf))
      if (actual.size !== parsed.length || parsed.length !== wire.bindings.length || wire.bindings.some(binding => !actual.has(keyOf(binding))))
        return graph3Conflict('canonical3-final-parser-closure', id)
      projectSyncedGroupBudget(wire); wires.push(wire)
    }
    const ledgerOverlay = buildLedgerOverlay(data, final, allocation, conflict)
    validateTypedTargets(data, final, wires, ledgerOverlay, allocation, bindingProjections, conflict)
    let forestValidated = true
    try { validateSyncedWorkspaceGraph(final.documents.map(document => ({ documentId: document.id,
      blocks: Array.from(physicalMembers('document', document.id), block => block.block) })), wires) }
    catch (error) { if (!(error instanceof SyncedValidationError)) throw error; forestValidated = false; conflict('canonical3-final-forest', null, [], { code: error.code }) }
    validateOrdinaryDestinations(ordinary.projections, final, conflict)
    validateOrdinaryConsumers(priorScope, final, wires, bindingProjections, conflict)
    const projectedBudgets = measureNativeHostBudgets(final, tables, physicalMembers, wires)
    const body = { kind: 'root-restore-canonical-reference-candidate' as const, version: 3 as const,
      baseIdentityAllocationHash: allocation.baseIdentityAllocationHash, derivedReferenceAllocationHash: allocation.derivedReferenceAllocationHash,
      sourceMaterialHash: ordinary.sourceMaterialHash, currentMaterialHash: ordinary.currentMaterialHash,
      ordinaryNavigationRewriteHash: ordinary.navigationRewriteHash, tables, canonicalEdits: edits, originProjections, bindingProjections,
      ...(pendingProof ? { pendingLocalBody: pendingProof } : {}),
      activeGroupWires: wires, inactiveGroups: inactive, projectedBudgets, finalSyntaxIndexHash: final.indexHash,
      materialization: { reservationRows: allocation.materialization.reservationRows, ledgerOverlay,
        lifecycleIntents: allocation.materialization.lifecycleIntents, actualStageLedgerWritten: false as const, actualLifecycleRowsReady: false as const },
      conflicts: [...ordinary.conflicts, ...conflicts], candidateConflictFree: ordinary.conflicts.length === 0 && conflicts.length === 0,
      canonicalParserClosureValidated: true as const, canonicalWireShapeValidated: true as const, finalForestValidated: forestValidated,
      typedTargetOverlayChecked: true as const, typedTargetOverlayValid: conflicts.length === 0, finalOrdinaryScopesReparsed: true as const,
      rendererBindingPropagationImplemented: false as const, portableAssetProjectionBudgetValidated: false as const,
      actualStageBudgetValidated: false as const,
      inactiveMaterializationComplete: inactive.every(item => item.side === 'current'), templateNavigationRewritten: false as const,
      referenceRewriteComplete: false as const, semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
    assertMerge3JsonBudget(body)
    const canonicalCandidateHash = hashBoundedCapsuleJson(body, CAPSULE2_RAW_MAX_JSON_BYTES, 'knowbook.restore.canonical3.candidate.v1\0')
    if (canonicalCandidateHash === null) return graph3Conflict('canonical3-candidate-json-budget', null)
    const candidate = freezeCapsuleValue({ ...body, canonicalCandidateHash })
    return Object.freeze({ candidate, ordinaryEdits: ordinary.edits, physicalLocations: final.physicalLocations })
  })
}

type Ledger = { id: string; last_owner_kind: 'document' | 'group' | 'reserved'; last_owner_id: string; state: 'live' | 'retained'; created_at: string | null }
type Conflict = (code: string, side: Side | null, rowKeys: readonly string[], detail: unknown) => void
function buildLedgerOverlay(data: Graph3Inputs, final: Pick<StoredNavigation3Index, 'physicalLocations'>, allocation: Allocation, conflict: Conflict) {
  const physical = new Set(final.physicalLocations.map(block => block.id)), rows = new Map<string, Ledger>()
  const raw = data.inputs.current.source.sourceContent, table = originalTable(raw, 'block_identities')
  for (const row of table.rows) {
    const id = string(originalValue(raw, table, row, 'id')), birth = originalValue(raw, table, row, 'created_at')
    rows.set(id, { id, last_owner_kind: originalValue(raw, table, row, 'last_owner_kind') as Ledger['last_owner_kind'],
      last_owner_id: string(originalValue(raw, table, row, 'last_owner_id')),
      state: physical.has(id) ? 'live' : 'retained', created_at: birth === null ? null : string(birth) })
  }
  for (const block of final.physicalLocations) {
    const old = rows.get(block.id), kind = block.documentId === null ? 'group' as const : 'document' as const, owner = block.documentId ?? block.groupId!
    if (old && (old.created_at !== block.birth || old.last_owner_kind !== kind || old.last_owner_id !== owner))
      conflict('canonical3-physical-ledger-transition-not-proved', block.sourceRef.side, [block.rowKey], { old, block: block.id, owner, birth: block.birth })
    rows.set(block.id, { id: block.id, last_owner_kind: kind, last_owner_id: owner, state: 'live', created_at: block.birth })
    if (rows.size > 100_000) return graph3Conflict('canonical3-ledger-overlay-row-budget', null)
  }
  const reservationIds = new Set<string>()
  for (const row of allocation.materialization.reservationRows) {
    if (row.last_owner_kind !== 'reserved' || row.state !== 'retained' || row.created_at !== null || !row.id || !row.last_owner_id)
      return graph3Conflict('canonical3-reservation-shape', row)
    if (reservationIds.has(row.id)) return graph3Conflict('canonical3-duplicate-reservation-row', row.id)
    reservationIds.add(row.id)
    const old = rows.get(row.id)
    const sql = { id: row.id, last_owner_kind: row.last_owner_kind, last_owner_id: row.last_owner_id, state: row.state, created_at: row.created_at }
    if (physical.has(row.id) || old && !same(old, sql)) conflict('canonical3-reservation-collision', null, [], { row, old })
    else rows.set(row.id, { id: row.id, last_owner_kind: 'reserved', last_owner_id: row.last_owner_id, state: 'retained', created_at: null })
    if (rows.size > 100_000) return graph3Conflict('canonical3-ledger-overlay-row-budget', null)
  }
  return [...rows.values()]
}
function validateTypedTargets(data: Graph3Inputs, final: StoredNavigation3Index, wires: readonly SyncedGroupWire[], ledger: readonly Ledger[], allocation: Allocation,
  projections: readonly { side: Side; groupId: string; original: SyncedLinkBinding; binding: SyncedLinkBinding; rowKey: string; proofKind: string }[], conflict: Conflict) {
  const ids = new Map(ledger.map(row => [row.id, row])), docs = new Map(final.documents.map(document => [document.id, document]))
  const blocks = new Map(final.physicalLocations.map(block => [block.id, block]))
  const provedTargets = new Map(allocation.bindingTargets.filter(item => item.proofKind === 'proved-same-source-group-block')
    .map(item => [keyOf(item.key), item]))
  const currentDocs = new Map(data.inputs.current.source.physical.documents.map(document => [document.documentId, document]))
  const currentBlocks = new Map(data.inputs.current.source.physical.identities.filter(identity => identity.state === 'live')
    .map(identity => [identity.id, identity.created_at] as const))
  for (const wire of wires) if (!blocks.has(wire.origin.firstInstanceId) && !ids.has(wire.origin.firstInstanceId))
    conflict('canonical3-missing-origin-instance-reservation', null, [], { groupId: wire.id, id: wire.origin.firstInstanceId })
  const activeGroups = new Set(wires.map(wire => wire.id))
  for (const origin of allocation.origins) if (activeGroups.has(origin.targetGroupId)) {
    const born = blocks.get(origin.origin.firstInstanceId)?.birth ?? ids.get(origin.origin.firstInstanceId)?.created_at ?? null
    if (origin.firstInstanceProof === 'proved-historical-birth' && (origin.firstInstanceKnownBirth === null || born !== origin.firstInstanceKnownBirth))
      conflict('canonical3-origin-first-instance-birth-not-materialized', origin.side, [], { groupId: origin.targetGroupId, expected: origin.firstInstanceKnownBirth, actual: born })
    if (origin.firstInstanceProof === 'qualified-missing' && (blocks.has(origin.origin.firstInstanceId)
      || ids.get(origin.origin.firstInstanceId)?.last_owner_kind !== 'reserved' || born !== null))
      conflict('canonical3-origin-missing-first-instance-became-live', origin.side, [], origin)
    if (origin.documentProof === 'qualified-missing' && docs.has(origin.origin.documentId))
      conflict('canonical3-origin-missing-document-became-live', origin.side, [], origin)
  }
  for (const item of projections) {
    const target = item.binding.target
    if (target.kind === 'block' && !ids.has(target.id)) conflict('canonical3-block-target-without-ledger', item.side, [item.rowKey], target)
    if (item.side === 'source' && item.proofKind === 'proved-same-source-group-block') {
      const proved = provedTargets.get(keyOf(item.original)), mapped = target.kind === 'block' ? blocks.get(target.id) : undefined
      const identity = mapped && ids.get(mapped.id)
      if (!proved?.provedTargetBirth || !same(proved.target, target) || !mapped || mapped.sourceRef.side !== 'source'
        || mapped.groupId !== item.groupId || mapped.birth !== proved.provedTargetBirth || identity?.state !== 'live'
        || identity.last_owner_kind !== 'group' || identity.last_owner_id !== item.groupId || identity.created_at !== mapped.birth)
        conflict('canonical3-proved-source-group-target-not-materialized', item.side, [item.rowKey], target)
    }
    if (item.side === 'source' && item.proofKind === 'qualified-missing') {
      if (target.kind === 'document' && (target.state !== 'missing' || docs.has(target.id))
        || target.kind === 'heading' && (target.state !== 'missing' || docs.has(target.documentId))
        || target.kind === 'block' && (target.state !== 'missing' || blocks.has(target.id) || ids.get(target.id)?.last_owner_kind !== 'reserved'
          || ids.get(target.id)?.created_at !== null || target.documentId !== null && docs.has(target.documentId)))
        conflict('canonical3-isolated-source-target-became-live', item.side, [item.rowKey], target)
    }
    if (item.side === 'current' && item.proofKind === 'current-domain-preserved') {
      const documentId = target.kind === 'document' ? target.id : target.kind === 'heading' ? target.documentId : null
      if (documentId && docs.has(documentId) && currentDocs.get(documentId)?.createdAt !== docs.get(documentId)!.birth)
        conflict('canonical3-current-document-promoted-by-source', item.side, [item.rowKey], target)
      if (target.kind === 'block' && blocks.has(target.id) && currentBlocks.get(target.id) !== blocks.get(target.id)!.birth)
        conflict('canonical3-current-block-promoted-by-source', item.side, [item.rowKey], target)
    }
  }
  validateCurrentHeadingSemantics(data, final, projections, conflict)
}

/** Preserve the actual current meaning across this restore transition. The
 * captured state hint does not establish an old heading generation, and a new
 * source occurrence cannot claim an existing target merely by taking its slug.
 * This first draft reports a conflict on a lost/renamed bound slug instead of
 * fabricating a missing-heading sentinel or retargeting the old binding. */
function validateCurrentHeadingSemantics(data: Graph3Inputs, final: StoredNavigation3Index,
  projections: readonly { side: Side; binding: SyncedLinkBinding; rowKey: string; proofKind: string }[], conflict: Conflict) {
  const affected = projections.filter(item => item.side === 'current' && item.proofKind === 'current-domain-preserved' && item.binding.target.kind === 'heading')
  if (!affected.length) return
  const physical = data.inputs.current.source.physical
  const graph = validateSyncedWorkspaceGraph(physical.documents.map(document => ({ documentId: document.documentId, blocks: document.blocks })),
    physical.groups.flatMap(group => group.snapshot ? [{ kind: 'synced-group' as const, id: group.snapshot.groupId,
      creationId: group.snapshot.creationId, createdAt: group.snapshot.createdAt, origin: group.snapshot.origin,
      bindings: group.snapshot.bindings, blocks: group.snapshot.blocks }] : []))
  const documents = new Map(physical.documents.map(document => [document.documentId, document]))
  const graphDocuments = new Map(graph.documents.map(document => [document.documentId, document])), graphGroups = new Map(graph.groups.map(group => [group.id, group]))
  const identities = new Map(physical.identities.map(identity => [identity.id, identity]))
  const finalNamespaces = new Map(final.headingNamespaces.map(namespace => [namespace.document.id, namespace]))
  const finalHeadingIndexes = new Map(final.headingNamespaces.map(namespace => {
    const bySlug = new Map<string, typeof namespace.headings[number]>(), counts = new Map<string | null, number>()
    for (const heading of namespace.headings) { if (!bySlug.has(heading.slug)) bySlug.set(heading.slug, heading)
      counts.set(heading.blockId, (counts.get(heading.blockId) ?? 0) + 1) }
    return [namespace.document.id, { bySlug, counts }] as const
  }))
  type OldLocation = { blockId: string; instanceId: string | null; blockBirth: string | null; instanceBirth: string | null; type: string; content: string }
  type OldHeading = ReturnType<typeof getMarkdownHeadingTargets>[number]
  type OldNamespace = { bySlug: Map<string, OldHeading>; counts: Map<string | null, number>; locations: Map<string, OldLocation> }
  const oldNamespaces = new Map<string, OldNamespace>(), checked = new Map<string, boolean>()
  for (const item of affected) {
    const target = item.binding.target
    if (target.kind !== 'heading') continue
    const key = graph3Key(target.documentId, target.slug)
    if (checked.has(key)) continue
    checked.set(key, true)
    const document = documents.get(target.documentId)
    let old = oldNamespaces.get(target.documentId)
    if (!old && document) {
      const locations = new Map<string, OldLocation>()
      const originalHost = graphDocuments.get(document.documentId)!, referenced = new Set(originalHost.blocks
        .filter(block => block.type === 'synced-block').map(block => parseSyncedBlockPayload(block.content).groupId))
      const scopedGraph = { ...graph, documents: [originalHost], groups: [...referenced].map(id => graphGroups.get(id)!) }
      const blocks = [...expandSyncedGraphDocument(scopedGraph, document.documentId)].map(occurrence => {
        const id = graph3Key(occurrence.instanceId, occurrence.block.id)
        locations.set(id, { blockId: occurrence.block.id, instanceId: occurrence.instanceId,
          blockBirth: identities.get(occurrence.block.id)?.created_at ?? null,
          instanceBirth: occurrence.instanceId === null ? null : identities.get(occurrence.instanceId)?.created_at ?? null,
          type: occurrence.block.type, content: occurrence.block.content })
        return { ...occurrence.block, id, depth: occurrence.depth,
          parentBlockId: occurrence.parent === null ? null : graph3Key(occurrence.parent.instanceId, occurrence.parent.blockId) }
      })
      const bySlug = new Map<string, OldHeading>(), counts = new Map<string | null, number>()
      for (const heading of getMarkdownHeadingTargets(blocks, document.title)) { if (!bySlug.has(heading.slug)) bySlug.set(heading.slug, heading)
        counts.set(heading.blockId, (counts.get(heading.blockId) ?? 0) + 1) }
      old = { bySlug, counts, locations }; oldNamespaces.set(document.documentId, old)
    }
    const previous = old?.bySlug.get(target.slug), namespace = finalNamespaces.get(target.documentId)
    const next = finalHeadingIndexes.get(target.documentId)?.bySlug.get(target.slug)
    if (!previous) {
      if (next) conflict('canonical3-current-missing-heading-promoted-by-source', item.side, [item.rowKey], { target, actual: next.key })
      continue
    }
    if (!next || next.key !== previous.key || !document || namespace!.document.birth !== document.createdAt) {
      conflict('canonical3-current-heading-transition-unproved', item.side, [item.rowKey], { target, previous: previous.key, actual: next?.key ?? null }); continue
    }
    if (previous.blockId === null) continue
    const original = old!.locations.get(previous.blockId)!, actual = next.location
    const finalBlock = final.physicalBlock(original.blockId)
    const unchangedText = finalBlock?.block.type === original.type && finalBlock.block.content === original.content
    const individualHeading = /^heading-[1-6]$/.test(original.type) && !!finalBlock && /^heading-[1-6]$/.test(finalBlock.block.type)
      && old!.counts.get(previous.blockId) === 1 && finalHeadingIndexes.get(target.documentId)?.counts.get(next.blockId) === 1
    if (!actual || actual.blockId !== original.blockId || actual.instanceId !== original.instanceId || actual.blockBirth !== original.blockBirth
      || actual.instanceBirth !== original.instanceBirth || !unchangedText && !individualHeading)
      conflict('canonical3-current-heading-occurrence-replaced', item.side, [item.rowKey], { target, previous: previous.key, actual: next.key })
  }
}

function validateOrdinaryDestinations(projections: ReturnType<typeof deriveRootRestoreNavigationRewrite3>['projections'], final: StoredNavigation3Index, conflict: Conflict) {
  const wanted = new Set(projections.map(projection => keyOf(projection.after)))
  const destinations = new Map<string, { documentId: string; url: string; wiki: boolean }>()
  if (wanted.size) for (const scope of final.scopes()) for (const link of scope.destinations) {
    if (link.location.groupId !== null) continue
    const key = keyOf(link.key)
    if (wanted.has(key)) destinations.set(key, { documentId: scope.finalDocumentId, url: link.url, wiki: link.key.syntax === 'wiki' })
  }
  for (const projection of projections) {
    const observed = destinations.get(keyOf(projection.after))
    if (!observed) { conflict('canonical3-ordinary-final-range-lost', projection.side, [projection.rowKey], projection.after); continue }
    const target = projection.expectedTarget
    if (projection.actualTarget === null && target === null) continue // actual external/image source
    const actual = resolveFinalNavigation3(final, observed.documentId, observed.url, observed.wiki)
    const matches = target !== null && target.kind === actual.kind && 'documentId' in actual && actual.documentId === target.documentId
      && (target.kind !== 'block' || actual.kind === 'block' && actual.blockId === target.blockId)
      && (target.kind !== 'heading' || actual.kind === 'heading' && actual.headingKey === target.headingKey)
    const live = actual.kind === 'document' || actual.kind === 'block' || actual.kind === 'heading'
    if (target && !matches) conflict('canonical3-final-ordinary-target-changed', projection.side, [projection.rowKey], { expected: target, actual })
    else if (!target && live) conflict('canonical3-final-ordinary-unresolved-became-live', projection.side, [projection.rowKey], actual)
  }
}
function validateOrdinaryConsumers(priorScope: (scopeId: string) => readonly PriorOccurrence[] | undefined,
  final: StoredNavigation3Index, wires: readonly SyncedGroupWire[],
  projections: readonly { side: Side; binding: SyncedLinkBinding; rowKey: string; proofKind: string }[], conflict: Conflict) {
  const bindingByKey = new Map(projections.map(item => [keyOf(item.binding), item]))
  const originPaths = new Map(wires.map(wire => [wire.id, wire.origin.pathAtCreation]))
  for (const scope of final.scopes()) {
    const prior = priorScope(scope.scopeId)
    if (!prior) return graph3Conflict('canonical3-final-scope-added', scope.scopeId)
    const byOccurrence = new Map(scope.blocks.map(block => [block.occurrenceKey, block]))
    const expected = captureSyncedCreateSourceFacts(prior.map(block => ({ ...block.block,
      content: byOccurrence.get(block.occurrenceKey)?.block.content ?? graph3Conflict('canonical3-final-occurrence-lost', block.occurrenceKey) })))
    const uses = new Map(scope.uses.map(use => [use.blockId, use.definitions]))
    const unitGroups = new Map<string, FinalScope['units'][number][]>(), expectedGroups = new Map<string, typeof expected.units>()
    for (const unit of scope.units) { const list = unitGroups.get(unit.blockId) ?? []; list.push(unit); unitGroups.set(unit.blockId, list) }
    for (const unit of expected.units) { const list = expectedGroups.get(unit.blockId) ?? []; list.push(unit); expectedGroups.set(unit.blockId, list) }
    const effective = new Map(scope.effectiveDefinitions.map(item => [item.key, item.definition]))
    const linksByOwner = new Map<string, FinalScope['destinations'][number][]>(), checkedDefinitions = new Set<string>()
    for (const link of scope.destinations) { const list = linksByOwner.get(link.finalOccurrenceKey) ?? []; list.push(link); linksByOwner.set(link.finalOccurrenceKey, list) }
    for (const list of linksByOwner.values()) list.sort((a, b) => a.key.from - b.key.from || a.key.to - b.key.to)
    const ordinary = scope.blocks.filter(block => block.location.groupId === null)
    for (const block of ordinary) {
      if (!same([...(expected.uses.get(block.occurrenceKey) ?? [])].sort(), [...(uses.get(block.occurrenceKey) ?? [])].sort())
        || !same(expectedGroups.get(block.occurrenceKey) ?? [], unitGroups.get(block.occurrenceKey) ?? []))
        conflict('canonical3-final-ordinary-environment-changed', block.cell.sourceRef.side, [block.cell.rowKey], { scopeId: scope.scopeId })
      const pending = [...(uses.get(block.occurrenceKey) ?? [])], visited = new Set<string>()
      while (pending.length) {
        const key = pending.pop()!
        if (visited.has(key) || checkedDefinitions.has(key)) continue
        visited.add(key); checkedDefinitions.add(key)
        const definition = effective.get(key), owner = definition && byOccurrence.get(definition.blockId)
        if (!definition || !owner) return graph3Conflict('canonical3-definition-closure-missing', { scope: scope.scopeId, key })
        const original = expected.effective.get(key)
        if (!original || !same(original, definition)) conflict('canonical3-definition-source-changed', block.cell.sourceRef.side,
          [block.cell.rowKey, owner.cell.rowKey], { key, expected: original, actual: definition })
        // Conservative finite closure; duplicate labels elsewhere in this same
        // physical definition block can only add a conflict, never authorize it.
        for (const dependency of uses.get(owner.occurrenceKey) ?? []) pending.push(dependency)
        if (owner.location.groupId === null) continue
        const candidates = linksByOwner.get(owner.occurrenceKey) ?? []
        let low = 0, high = candidates.length
        while (low < high) { const middle = (low + high) >>> 1; if (candidates[middle].key.from < definition.from) low = middle + 1; else high = middle }
        const links: typeof candidates = []
        for (let i = low; i < candidates.length && candidates[i].key.from <= definition.to; i++) if (candidates[i].key.to <= definition.to) links.push(candidates[i])
        for (const link of links) {
          if (link.image || link.key.syntax !== 'wiki' && !resolveMarkdownDocumentPath(originPaths.get(owner.location.groupId)!, link.url)) continue
          const projected = bindingByKey.get(keyOf({ ...link.key, blockId: owner.location.blockId! }))
          if (!projected) return graph3Conflict('canonical3-consumer-binding-key-missing', link.key)
          const target = projected.binding.target, raw = resolveFinalNavigation3(final, scope.finalDocumentId, link.url, link.key.syntax === 'wiki')
          const live = raw.kind === 'document' || raw.kind === 'block' || raw.kind === 'heading'
          const missing = target.kind === 'unresolved-url' || 'state' in target && target.state === 'missing'
          const matches = target.kind === 'document' ? raw.kind === 'document' && raw.documentId === target.id
            : target.kind === 'block' ? raw.kind === 'block' && raw.blockId === target.id
              : target.kind === 'heading' ? raw.kind === 'heading' && raw.documentId === target.documentId && raw.slug === target.slug : !live
          // Current state is a captured hint, not present existence. The typed
          // closure above still checks actual birth/owner and heading identity.
          const retainedCurrentMatch = projected.side === 'current' && projected.proofKind === 'current-domain-preserved' && matches
          if (missing && live && !retainedCurrentMatch) conflict('canonical3-unproved-definition-target-became-live', block.cell.sourceRef.side,
            [block.cell.rowKey, owner.cell.rowKey], { key: link.key, typedTarget: target, rawTarget: raw })
          else if (!missing && !matches) conflict('canonical3-definition-binding-not-propagated-to-consumer', block.cell.sourceRef.side,
            [block.cell.rowKey, owner.cell.rowKey], { key: link.key, typedTarget: target, rawTarget: raw })
        }
      }
    }
  }
}
function assertFinalStorageBudget(tables: readonly Navigation3Table[]) {
  assertMerge3JsonBudget(tables)
  let count = 0, bytes = 0
  for (const table of tables) for (const row of table.rows) {
    if (++count > 100_000) return graph3Conflict('canonical3-final-row-budget', null)
    for (const cell of row.cells) bytes += cell[0] === 'text' || cell[0] === 'blob'
      ? cell[1].length / 4 * 3 - (cell[1].endsWith('==') ? 2 : cell[1].endsWith('=') ? 1 : 0) : 8
    if (bytes > 64 * 1024 * 1024) return graph3Conflict('canonical3-final-value-budget', null)
  }
}

/** Root-native measurement only. The SQL INT64 sort value is counted as its
 * exact decimal token, without rounding it into a fabricated public wire. The
 * later asset stage must check its actual rewritten portable bytes again. */
function measureNativeHostBudgets(final: Pick<Navigation3FinalIndex, 'documents'>, tables: readonly Navigation3Table[],
  physicalMembers: ReturnType<typeof indexFinalMembers>, wires: readonly SyncedGroupWire[]) {
  const documents = new Map<string, Entry>(), groups = new Map(wires.map(wire => [wire.id, wire]))
  for (const entry of projectEntries(tables, { documents: ['id', 'parent_id', 'sort_order'] })) documents.set(string(entry.value.id), entry)
  return final.documents.map(document => {
    const row = documents.get(document.id)!, sortOrder = row.value.sort_order
    if (typeof sortOrder !== 'bigint') return graph3Conflict('canonical3-host-sort-storage', document.id)
    let bytes = Buffer.byteLength(capsuleJson({ kind: 'document', id: document.id, parentId: row.value.parent_id,
      createdAt: document.birth, content: { title: document.title, summary: document.summary, blocks: [] } }))
      + Buffer.byteLength(',"sortOrder":' + sortOrder.toString()), count = 0
    if (bytes > 16 * 1024 * 1024) return graph3Conflict('canonical3-native-projection-budget', document.id)
    const add = (block: unknown) => { bytes += Buffer.byteLength(capsuleJson(block)) + (count++ ? 1 : 0)
      if (count > 100_000 || bytes > 16 * 1024 * 1024) return graph3Conflict('canonical3-native-projection-budget', document.id) }
    for (const { block } of physicalMembers('document', document.id)) {
      if (block.type !== 'synced-block') { add(block); continue }
      const group = groups.get(parseSyncedBlockPayload(block.content).groupId)
      if (!group) return graph3Conflict('canonical3-projection-missing-active-wire', block.id)
      for (const { createdAt: _birth, ...child } of group.blocks) add({ ...child, depth: block.depth + child.depth,
        parentBlockId: child.parentBlockId ?? block.parentBlockId })
    }
    return { documentId: document.id, blocks: count, bytes, representation: 'root-native-envelope-with-exact-int64' as const }
  })
}
