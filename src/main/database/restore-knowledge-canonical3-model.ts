import type { SyncedBindingKey, SyncedCanonicalWire, SyncedGroupWire, SyncedLinkBinding } from '../../shared/synced-blocks'
import { validateSyncedGroupWire, validateSyncedOrigin, SyncedValidationError, parseSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { validateSyncedWorkspaceGraph, expandSyncedGraphDocument } from '../../shared/syncedBlockGraph'
import { projectSyncedGroupBudget } from '../../shared/syncedBlockPortable'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { escapeMarkdownDestination, parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { parseWikiReference } from '../../shared/markdownWiki'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { graph3Conflict, graph3Encode, graph3Key, graph3Rows, graph3Text, type Graph3Inputs } from './restore-knowledge-graph3-data'
import { assertMerge3JsonBudget, type MergedRow3 } from './restore-knowledge-merge3-storage'
import type { RootRestoreMergedContentChoices3 } from './restore-knowledge-merge3-read'
import { deriveRootRestoreNavigationRewrite3 } from './restore-knowledge-navigation3-rewrite-model'
import { buildMerge3NavigationFinalIndex3, resolveFinalNavigation3, type Navigation3FinalIndex, type Navigation3Table } from './restore-knowledge-navigation3-merge-context'
import { renderNavigation3Destination } from './restore-knowledge-navigation3-rewrite-cells'
import { deriveRootRestoreReferenceAllocation3, toReference3GraphInputs } from './restore-knowledge-reference3-model'
import { collectSyncedBindingOccurrences } from '../sync/synced-binding-occurrences'
import { captureSyncedCreateSourceFacts } from './synced-host-create-plan'
import { transformCanonical3Cell, rewriteCanonical3OriginJson, type Canonical3TextEdit } from './restore-knowledge-canonical3-cells'

type Allocation = ReturnType<typeof deriveRootRestoreReferenceAllocation3>
type Side = 'source' | 'current'
type Entry = { table: Navigation3Table; row: MergedRow3; value: Record<string, unknown> }
type FinalScope = Navigation3FinalIndex['scopes'][number]
export interface Canonical3Conflict { readonly code: string; readonly side: Side | null; readonly rowKeys: readonly string[]; readonly detail: unknown }
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const keyOf = (key: SyncedBindingKey) => graph3Key(key.blockId, key.from, key.to, key.raw, key.syntax)
const onlyKey = ({ blockId, from, to, raw, syntax }: SyncedBindingKey): SyncedBindingKey => ({ blockId, from, to, raw, syntax })
const string = (value: unknown) => typeof value === 'string' ? value : graph3Conflict('canonical3-text', typeof value)
const fieldKey = (table: string, rowKey: string, column: string) => graph3Key(table, rowKey, column)
const order = (a: Entry, b: Entry) => {
  const left = a.value.sort_order, right = b.value.sort_order
  if (typeof left !== 'bigint' || typeof right !== 'bigint') return graph3Conflict('canonical3-order-storage', null)
  return left < right ? -1 : left > right ? 1 : 0
}
function entries(tables: readonly Navigation3Table[]) {
  return tables.flatMap(table => table.rows.map(row => ({ table, row, value: Object.fromEntries(table.columns.map((column, index) => {
    const cell = row.cells[index]
    return [column, cell[0] === 'null' ? null : cell[0] === 'text' ? graph3Text(cell, table.encoding)
      : cell[0] === 'integer' ? BigInt(cell[1]) : cell[0] === 'real-ieee754-le' ? Buffer.from(cell[1], 'hex').readDoubleLE() : Buffer.from(cell[1], 'base64')]
  })) as Record<string, unknown> })))
}

/** Isolating an unknown block target can be expressed without guessing a
 * document path: retain its declared path/query/alias and address the reserved
 * block ID. Document/heading missing targets keep their original spelling. */
function missingBlockUrl(url: string, syntax: 'markdown' | 'wiki', id: string) {
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
  const derived = toReference3GraphInputs(data, allocation)
  const ordinary = deriveRootRestoreNavigationRewrite3(derived, choices)
  const before = buildMerge3NavigationFinalIndex3(derived, ordinary.tables)
  const originalRows = new Map<string, ReturnType<typeof graph3Rows>[number]>()
  const originalById = new Map<string, ReturnType<typeof graph3Rows>[number]>()
  for (const side of ['source', 'current'] as const) for (const name of ['synced_groups', 'synced_group_blocks'])
    for (const row of graph3Rows(data.inputs[side].source.sourceContent, name)) {
      originalRows.set(graph3Key(side, name, row.original.sourceRowId), row)
      originalById.set(graph3Key(side, name, row.value.id), row)
    }
  const selected = entries(ordinary.tables), groups = selected.filter(entry => entry.table.name === 'synced_groups')
  const groupBlocks = new Map<string, Entry[]>()
  for (const entry of selected) if (entry.table.name === 'synced_group_blocks') {
    const id = string(entry.value.group_id), list = groupBlocks.get(id) ?? []; list.push(entry); groupBlocks.set(id, list)
  }
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
  const changes = new Map<string, string>(), conflicts: Canonical3Conflict[] = []
  const conflict = (code: string, side: Side | null, rowKeys: readonly string[], detail: unknown) => conflicts.push({ code, side, rowKeys, detail })
  const edits: Array<{ side: Side; table: 'synced_group_blocks'; rowKey: string; column: 'content'; key: SyncedBindingKey; after: string }> = []
  const bindingProjections: Array<{ side: Side; groupId: string; rowKey: string; original: SyncedLinkBinding; binding: SyncedLinkBinding;
    proofKind: string; sourceGroupSource: unknown; originalHint: unknown }> = []
  const originProjections: Array<{ side: Side; groupId: string; rowKey: string; before: string; after: string; retainedFromCurrent: boolean }> = []
  const inactive: Array<{ side: Side; sourceGroupId: string; targetGroupId: string; rowKey: string }> = []
  const currentDocs = new Map(data.inputs.current.source.physical.documents.map(document => [document.documentId, document]))
  const finalDocs = new Map(before.documents.map(document => [document.id, document]))
  const finalPhysical = new Map(before.physicalBlocks.map(block => [block.id, block]))

  for (const entry of groups) {
    const ref = entry.row.sourceRef, side = ref.side, original = originalRows.get(graph3Key(side, 'synced_groups', ref.sourceRowId))
    if (!original) return graph3Conflict('canonical3-original-group-row', ref)
    const sourceId = string(original.value.id), groupId = string(entry.value.id)
    const knowledge = knowledgeGroups.get(side)!.get(sourceId), fact = facts.get(side)!.get(sourceId)
    const origin = origins.get(graph3Key(side, sourceId))
    if (!knowledge || !fact || !origin || !same(origin.sourceGroupSource, knowledge.source) || origin.comparisonKey !== knowledge.comparisonKey
      || origin.targetGroupId !== groupId || origin.targetCreationId !== entry.value.creation_id
      || origin.originalOriginJson !== original.value.origin_json) return graph3Conflict('canonical3-origin-source-join', { ref, origin })
    const originalOrigin = validateSyncedOrigin(JSON.parse(string(original.value.origin_json)))
    if (origin.origin.pathAtCreation !== originalOrigin.pathAtCreation) return graph3Conflict('canonical3-origin-path-changed', origin)
    let nextOrigin = rewriteCanonical3OriginJson(string(original.value.origin_json), origin.origin).text
    if (origin.originPolicy === 'retained-current') {
      const retained = originalById.get(graph3Key('current', 'synced_groups', groupId)), currentKnowledge = knowledgeGroups.get('current')!.get(groupId)
      if (!retained || !currentKnowledge || currentKnowledge.comparisonKey !== knowledge.comparisonKey
        || !same(validateSyncedOrigin(JSON.parse(string(retained.value.origin_json))), origin.origin))
        return graph3Conflict('canonical3-retained-current-origin-tuple', groupId)
      nextOrigin = string(retained.value.origin_json)
    }
    if (nextOrigin !== entry.value.origin_json) changes.set(fieldKey(entry.table.name, entry.row.key, 'origin_json'), nextOrigin)
    originProjections.push({ side, groupId, rowKey: entry.row.key, before: string(entry.value.origin_json), after: nextOrigin,
      retainedFromCurrent: origin.originPolicy === 'retained-current' })
    if (fact.snapshot === null) {
      inactive.push({ side, sourceGroupId: sourceId, targetGroupId: groupId, rowKey: entry.row.key })
      if (side === 'source') conflict('inactive-source-materialization-policy-pending', side, [entry.row.key], { sourceId, groupId })
      continue
    }
    const snapshot = fact.snapshot, oldBindings = snapshot.bindings, parsed = collectSyncedBindingOccurrences(snapshot.origin, snapshot.blocks)
    const parsedKeys = new Map(parsed.map(item => [keyOf(item), item]))
    if (parsedKeys.size !== parsed.length || parsed.length !== oldBindings.length) return graph3Conflict('canonical3-original-parser-closure', sourceId)
    const grammar = new Map(collectDocumentMarkdownLinks(snapshot.blocks).map(link => [graph3Key(link.blockId, link.start, link.end), link]))
    const bindingsByBlock = new Map<string, SyncedLinkBinding[]>()
    for (const binding of oldBindings) { const list = bindingsByBlock.get(binding.blockId) ?? []; list.push(binding); bindingsByBlock.set(binding.blockId, list) }
    const canonicalRows = groupBlocks.get(groupId) ?? [], originalToFinal = new Map<string, Entry>()
    for (const block of canonicalRows) {
      if (block.row.sourceRef.side !== side) return graph3Conflict('canonical3-mixed-group-forest-source', block.row.sourceRef)
      const originalBlock = originalRows.get(graph3Key(side, 'synced_group_blocks', block.row.sourceRef.sourceRowId))
      if (!originalBlock || originalBlock.value.group_id !== sourceId) return graph3Conflict('canonical3-canonical-row-source', block.row.sourceRef)
      originalToFinal.set(string(originalBlock.value.id), block)
    }
    if (originalToFinal.size !== snapshot.blocks.length) return graph3Conflict('canonical3-whole-canonical-forest', sourceId)
    const cellEdits = new Map<string, Canonical3TextEdit[]>(), effective = new Map<string, Allocation['bindingTargets'][number]>()
    for (const binding of oldBindings) {
      const parsedLink = parsedKeys.get(keyOf(binding)), target = targets.get(graph3Key(side, sourceId, keyOf(binding)))
      const block = originalToFinal.get(binding.blockId)
      if (!parsedLink || !block || !target || !same(target.sourceGroupSource, knowledge.source) || target.comparisonKey !== knowledge.comparisonKey
        || !same(target.originalTarget, binding.target) || target.sourceCapture.provenance !== 'current-stored'
        || !same(target.sourceCapture.source, knowledge.source) || !same(target.sourceCapture.binding, binding))
        return graph3Conflict('canonical3-binding-source-join', { binding, target })
      effective.set(keyOf(binding), target)
      const role = grammar.get(graph3Key(binding.blockId, binding.from, binding.to))
      if (!role || role.url !== parsedLink.url) return graph3Conflict('canonical3-binding-grammar-source', binding)
      let replacement = binding.raw
      if (side === 'source' && target.proofKind === 'qualified-missing' && target.target.kind === 'block') {
        const url = missingBlockUrl(parsedLink.url, binding.syntax, target.target.id)
        replacement = role.kind === 'wiki' ? binding.raw.includes('\\|') ? url.replace(/\|/g, '\\|') : url
          : escapeMarkdownDestination(url, role.syntax)
      } else if (side === 'current' && target.proofKind === 'current-domain-preserved') {
        if (!same(target.target, binding.target)) return graph3Conflict('canonical3-current-target-reinterpreted', binding)
        const targetDocId = binding.target.kind === 'document' ? binding.target.id : binding.target.kind === 'heading' ? binding.target.documentId
          : binding.target.kind === 'block' ? finalPhysical.get(binding.target.id)?.documentId : null
        const old = targetDocId ? currentDocs.get(targetDocId) : undefined, final = targetDocId ? finalDocs.get(targetDocId) : undefined
        if (old && final && old.createdAt === final.birth && old.path !== final.path) {
          const desired = binding.target.kind === 'document' ? { kind: 'document' as const, documentId: final.id, documentPath: final.path }
            : binding.target.kind === 'block' ? { kind: 'block' as const, documentId: final.id, documentPath: final.path, blockId: binding.target.id }
              : binding.target.kind === 'heading' ? { kind: 'heading' as const, documentId: final.id, documentPath: final.path, slug: binding.target.slug } : null
          if (desired) {
            const rendered = renderNavigation3Destination({ key: binding, url: parsedLink.url,
              grammar: { kind: role.kind, syntax: role.kind === 'wiki' ? 'wiki' : role.syntax ?? null } },
            { documentId: origin.origin.documentId, path: origin.origin.pathAtCreation }, desired)
            if ('reason' in rendered) conflict('canonical3-current-path-rewrite-unrepresentable', side, [block.row.key], { binding, reason: rendered.reason })
            else replacement = rendered.replacement
          }
        }
      }
      if (replacement !== binding.raw) {
        const list = cellEdits.get(binding.blockId) ?? []; list.push({ key: onlyKey(binding), after: replacement }); cellEdits.set(binding.blockId, list)
      }
    }
    const transformed = new Map<string, ReturnType<typeof transformCanonical3Cell>>()
    for (const block of snapshot.blocks) {
      const selectedBlock = originalToFinal.get(block.id)!, ownBindings = bindingsByBlock.get(block.id) ?? []
      if (ownBindings.length && selectedBlock.value.content !== block.content) return graph3Conflict('canonical3-content-already-rewritten', block.id)
      const transformedCell = transformCanonical3Cell(string(selectedBlock.value.content), ownBindings.map(onlyKey), cellEdits.get(block.id) ?? [], selectedBlock.table.encoding)
      transformed.set(block.id, transformedCell)
      if (transformedCell.text !== selectedBlock.value.content) changes.set(fieldKey('synced_group_blocks', selectedBlock.row.key, 'content'), transformedCell.text)
      for (const edit of transformedCell.edits) edits.push({ side, table: 'synced_group_blocks', rowKey: selectedBlock.row.key, column: 'content', ...edit })
    }
    const bindings: SyncedLinkBinding[] = oldBindings.map(binding => {
      const target = effective.get(keyOf(binding))!, block = originalToFinal.get(binding.blockId)!
      const projected = transformed.get(binding.blockId)!.project(onlyKey(binding))
      const next = { ...projected, blockId: string(block.value.id), target: target.target }
      bindingProjections.push({ side, groupId, rowKey: block.row.key, original: binding, binding: next, proofKind: target.proofKind,
        sourceGroupSource: target.sourceGroupSource, originalHint: target.originalHint })
      return next
    })
    if (!same(bindings, JSON.parse(string(entry.value.bindings_json)))) changes.set(fieldKey('synced_groups', entry.row.key, 'bindings_json'), capsuleJson(bindings))
  }
  const tables = ordinary.tables.map(table => ({ ...table, rows: table.rows.map(row => ({ ...row, cells: row.cells.map((cell, index) => {
    const changed = changes.get(fieldKey(table.name, row.key, table.columns[index]))
    return changed === undefined ? cell : graph3Encode(changed, table.encoding)
  }) })) }))
  assertFinalStorageBudget(tables)
  const final = buildMerge3NavigationFinalIndex3(derived, tables), finalEntries = entries(tables)
  const finalEntryByKey = new Map(finalEntries.map(entry => [entry.row.key, entry]))
  const physicalByGroup = new Map<string, typeof final.physicalBlocks[number][]>(), physicalByDocument = new Map<string, typeof final.physicalBlocks[number][]>()
  for (const block of final.physicalBlocks) {
    const lookup = block.groupId === null ? physicalByDocument : physicalByGroup, owner = block.groupId ?? block.documentId!
    const list = lookup.get(owner) ?? []; list.push(block); lookup.set(owner, list)
  }
  const sortPhysical = (a: typeof final.physicalBlocks[number], b: typeof final.physicalBlocks[number]) => order(finalEntryByKey.get(a.rowKey)!, finalEntryByKey.get(b.rowKey)!)
  const afterGroups = new Map(finalEntries.filter(entry => entry.table.name === 'synced_groups').map(entry => [string(entry.value.id), entry]))
  const inactiveRows = new Set(inactive.map(item => item.rowKey))
  const active = new Set(groups.filter(entry => !inactiveRows.has(entry.row.key)).map(entry => string(entry.value.id)))
  const wires: SyncedGroupWire[] = []
  for (const id of active) {
    const entry = afterGroups.get(id)!, blocks = (physicalByGroup.get(id) ?? []).sort(sortPhysical)
      .map(block => ({ ...block.block, createdAt: block.birth })) as SyncedCanonicalWire[]
    const wire = validateSyncedGroupWire({ kind: 'synced-group', id, creationId: entry.value.creation_id, createdAt: entry.value.created_at,
      origin: JSON.parse(string(entry.value.origin_json)), bindings: JSON.parse(string(entry.value.bindings_json)), blocks })
    const parsed = collectSyncedBindingOccurrences(wire.origin, wire.blocks), actual = new Set(parsed.map(keyOf))
    if (actual.size !== parsed.length || parsed.length !== wire.bindings.length || wire.bindings.some(binding => !actual.has(keyOf(binding))))
      return graph3Conflict('canonical3-final-parser-closure', id)
    projectSyncedGroupBudget(wire); wires.push(wire)
  }
  const ledgerOverlay = buildLedgerOverlay(data, final, allocation, conflict)
  validateTypedTargets(data, final, wires, ledgerOverlay, allocation, bindingProjections, conflict)
  let forestValidated = true
  try { validateSyncedWorkspaceGraph(final.documents.map(document => ({ documentId: document.id,
    blocks: (physicalByDocument.get(document.id) ?? []).sort(sortPhysical).map(block => block.block) })), wires) }
  catch (error) { if (!(error instanceof SyncedValidationError)) throw error; forestValidated = false; conflict('canonical3-final-forest', null, [], { code: error.code }) }
  validateOrdinaryDestinations(ordinary.projections, final, conflict)
  validateOrdinaryConsumers(before, final, wires, bindingProjections, conflict)
  const projectedBudgets = measureNativeHostBudgets(final, finalEntries, wires)
  const body = { kind: 'root-restore-canonical-reference-candidate' as const, version: 3 as const,
    baseIdentityAllocationHash: allocation.baseIdentityAllocationHash, derivedReferenceAllocationHash: allocation.derivedReferenceAllocationHash,
    sourceMaterialHash: ordinary.sourceMaterialHash, currentMaterialHash: ordinary.currentMaterialHash,
    ordinaryNavigationRewriteHash: ordinary.navigationRewriteHash, tables, canonicalEdits: edits, originProjections, bindingProjections,
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
  return freezeCapsuleValue({ ...body, canonicalCandidateHash: capsuleBytesHash('knowbook.restore.canonical3.candidate.v1\0' + capsuleJson(body)) })
}

type Ledger = { id: string; last_owner_kind: 'document' | 'group' | 'reserved'; last_owner_id: string; state: 'live' | 'retained'; created_at: string | null }
type Conflict = (code: string, side: Side | null, rowKeys: readonly string[], detail: unknown) => void
function buildLedgerOverlay(data: Graph3Inputs, final: Navigation3FinalIndex, allocation: Allocation, conflict: Conflict) {
  const physical = new Map(final.physicalBlocks.map(block => [block.id, block])), rows = new Map<string, Ledger>()
  for (const row of graph3Rows(data.inputs.current.source.sourceContent, 'block_identities')) {
    const value = row.value, id = string(value.id)
    rows.set(id, { id, last_owner_kind: value.last_owner_kind as Ledger['last_owner_kind'], last_owner_id: string(value.last_owner_id),
      state: physical.has(id) ? 'live' : 'retained', created_at: value.created_at === null ? null : string(value.created_at) })
  }
  for (const block of final.physicalBlocks) {
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
function validateTypedTargets(data: Graph3Inputs, final: Navigation3FinalIndex, wires: readonly SyncedGroupWire[], ledger: readonly Ledger[], allocation: Allocation,
  projections: readonly { side: Side; binding: SyncedLinkBinding; rowKey: string; proofKind: string }[], conflict: Conflict) {
  const ids = new Map(ledger.map(row => [row.id, row])), docs = new Map(final.documents.map(document => [document.id, document]))
  const blocks = new Map(final.physicalBlocks.map(block => [block.id, block]))
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
function validateCurrentHeadingSemantics(data: Graph3Inputs, final: Navigation3FinalIndex,
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
  const finalBlocks = new Map(final.physicalBlocks.map(block => [block.id, block]))
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
    const finalBlock = finalBlocks.get(original.blockId)
    const unchangedText = finalBlock?.block.type === original.type && finalBlock.block.content === original.content
    const individualHeading = /^heading-[1-6]$/.test(original.type) && !!finalBlock && /^heading-[1-6]$/.test(finalBlock.block.type)
      && old!.counts.get(previous.blockId) === 1 && finalHeadingIndexes.get(target.documentId)?.counts.get(next.blockId) === 1
    if (!actual || actual.blockId !== original.blockId || actual.instanceId !== original.instanceId || actual.blockBirth !== original.blockBirth
      || actual.instanceBirth !== original.instanceBirth || !unchangedText && !individualHeading)
      conflict('canonical3-current-heading-occurrence-replaced', item.side, [item.rowKey], { target, previous: previous.key, actual: next.key })
  }
}

function validateOrdinaryDestinations(projections: ReturnType<typeof deriveRootRestoreNavigationRewrite3>['projections'], final: Navigation3FinalIndex, conflict: Conflict) {
  const destinations = new Map(final.scopes.flatMap(scope => scope.destinations.filter(link => link.location.groupId === null)
    .map(link => [keyOf(link.key), { scope, link }] as const)))
  for (const projection of projections) {
    const observed = destinations.get(keyOf(projection.after))
    if (!observed) { conflict('canonical3-ordinary-final-range-lost', projection.side, [projection.rowKey], projection.after); continue }
    const target = projection.expectedTarget
    if (projection.actualTarget === null && target === null) continue // actual external/image source
    const actual = resolveFinalNavigation3(final, observed.scope.finalDocumentId, observed.link.url, observed.link.key.syntax === 'wiki')
    const matches = target !== null && target.kind === actual.kind && 'documentId' in actual && actual.documentId === target.documentId
      && (target.kind !== 'block' || actual.kind === 'block' && actual.blockId === target.blockId)
      && (target.kind !== 'heading' || actual.kind === 'heading' && actual.headingKey === target.headingKey)
    const live = actual.kind === 'document' || actual.kind === 'block' || actual.kind === 'heading'
    if (target && !matches) conflict('canonical3-final-ordinary-target-changed', projection.side, [projection.rowKey], { expected: target, actual })
    else if (!target && live) conflict('canonical3-final-ordinary-unresolved-became-live', projection.side, [projection.rowKey], actual)
  }
}
function validateOrdinaryConsumers(before: Navigation3FinalIndex, final: Navigation3FinalIndex, wires: readonly SyncedGroupWire[],
  projections: readonly { side: Side; binding: SyncedLinkBinding; rowKey: string; proofKind: string }[], conflict: Conflict) {
  const oldScopes = new Map(before.scopes.map(scope => [scope.scopeId, scope]))
  const bindingByKey = new Map(projections.map(item => [keyOf(item.binding), item]))
  const originPaths = new Map(wires.map(wire => [wire.id, wire.origin.pathAtCreation]))
  for (const scope of final.scopes) {
    const prior = oldScopes.get(scope.scopeId)
    if (!prior) return graph3Conflict('canonical3-final-scope-added', scope.scopeId)
    const byOccurrence = new Map(scope.blocks.map(block => [block.occurrenceKey, block]))
    const expected = captureSyncedCreateSourceFacts(prior.blocks.map(block => ({ ...block.block,
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
function measureNativeHostBudgets(final: Navigation3FinalIndex, all: readonly Entry[], wires: readonly SyncedGroupWire[]) {
  const documents = new Map(all.filter(entry => entry.table.name === 'documents').map(entry => [string(entry.value.id), entry]))
  const hosts = new Map<string, Entry[]>(), groups = new Map(wires.map(wire => [wire.id, wire]))
  for (const entry of all) if (entry.table.name === 'blocks') { const id = string(entry.value.document_id), list = hosts.get(id) ?? []; list.push(entry); hosts.set(id, list) }
  const physical = new Map(final.physicalBlocks.map(block => [block.id, block]))
  return final.documents.map(document => {
    const row = documents.get(document.id)!, sortOrder = row.value.sort_order
    if (typeof sortOrder !== 'bigint') return graph3Conflict('canonical3-host-sort-storage', document.id)
    let bytes = Buffer.byteLength(capsuleJson({ kind: 'document', id: document.id, parentId: row.value.parent_id,
      createdAt: document.birth, content: { title: document.title, summary: document.summary, blocks: [] } }))
      + Buffer.byteLength(',"sortOrder":' + sortOrder.toString()), count = 0
    if (bytes > 16 * 1024 * 1024) return graph3Conflict('canonical3-native-projection-budget', document.id)
    const add = (block: unknown) => { bytes += Buffer.byteLength(capsuleJson(block)) + (count++ ? 1 : 0)
      if (count > 100_000 || bytes > 16 * 1024 * 1024) return graph3Conflict('canonical3-native-projection-budget', document.id) }
    for (const entry of (hosts.get(document.id) ?? []).sort(order)) {
      const block = physical.get(string(entry.value.id))!.block
      if (block.type !== 'synced-block') { add(block); continue }
      const group = groups.get(parseSyncedBlockPayload(block.content).groupId)
      if (!group) return graph3Conflict('canonical3-projection-missing-active-wire', block.id)
      for (const { createdAt: _birth, ...child } of group.blocks) add({ ...child, depth: block.depth + child.depth,
        parentBlockId: child.parentBlockId ?? block.parentBlockId })
    }
    return { documentId: document.id, blocks: count, bytes, representation: 'root-native-envelope-with-exact-int64' as const }
  })
}
