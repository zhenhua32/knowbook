import { captureSyncedCreateSourceFacts } from './synced-host-create-plan'
import { parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { parseWikiReference, wikiDocumentPaths } from '../../shared/markdownWiki'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_VALUE_BYTES } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Encode, graph3Key, type Graph3Inputs } from './restore-knowledge-graph3-data'
import { deriveRootRestoreMergedContent3 } from './restore-knowledge-merge3-model'
import type { RootRestoreMergedContentChoices3 } from './restore-knowledge-merge3-read'
import { assertMerge3JsonBudget, type Merge3OriginalRowRef } from './restore-knowledge-merge3-storage'
import { buildMerge3NavigationFinalIndex3, deriveRootRestoreNavigationMergeContext3, resolveFinalNavigation3,
  type Navigation3Cell, type Navigation3ContextScope, type Navigation3FinalIndex, type Navigation3Table } from './restore-knowledge-navigation3-merge-context'
import { applyNavigation3TextEdits, createNavigation3RangeProjection, renderNavigation3Destination,
  type Navigation3FinalTarget, type Navigation3TextEdit } from './restore-knowledge-navigation3-rewrite-cells'

type Destination = Navigation3ContextScope['destinations'][number]
export interface Navigation3RewriteConflict { code: string; side: 'source' | 'current'; scopeId: string; rowKeys: readonly string[]; detail: unknown }
type Edit = Navigation3TextEdit & { side: 'source' | 'current'; table: Navigation3Cell['table']; rowKey: string;
  column: Navigation3Cell['column']; sourceRef: Merge3OriginalRowRef; target: Navigation3FinalTarget }
const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
const fieldKey = (cell: Navigation3Cell) => graph3Key(cell.table, cell.rowKey, cell.column)
const exactKey = (key: Destination['key']) => graph3Key(key.blockId, key.from, key.to, key.raw, key.syntax)
function targetMatches(expected: Navigation3FinalTarget, actual: ReturnType<typeof resolveFinalNavigation3>): boolean {
  if (actual.kind !== expected.kind || !('documentId' in actual) || actual.documentId !== expected.documentId) return false
  return expected.kind === 'block' ? actual.blockId === expected.blockId
    : expected.kind === 'heading' ? actual.headingKey === expected.headingKey : true
}

/** Actual declared SQL text-cell changes over merge3's complete twelve tables.
 * The old side's resolution is fixed first. A current occupant of an old source
 * path is never consulted to choose the destination identity. */
export function deriveRootRestoreNavigationRewrite3(data: Graph3Inputs, choices?: RootRestoreMergedContentChoices3) {
  const merged = deriveRootRestoreMergedContent3(data, choices)
  const context = deriveRootRestoreNavigationMergeContext3(data, merged)
  const conflicts: Navigation3RewriteConflict[] = [], unresolved: Array<{ side: 'source' | 'current'; scopeId: string;
    rowKey: string; key: Destination['key']; sourceRef: Merge3OriginalRowRef; reason: string; target: Destination['target'] }> = []
  const editsByCell = new Map<string, Edit[]>(), cells = new Map<string, Navigation3Cell>()
  const editsByRange = new Map<string, Edit>()
  const finalDocuments = new Map(context.final.documents.map(document => [document.id, document]))
  const observations: Array<{ scope: Navigation3ContextScope; link: Destination; target: Navigation3FinalTarget | null }> = []
  const conflict = (code: string, scope: Navigation3ContextScope, rowKeys: readonly string[], detail: unknown) =>
    conflicts.push({ code, side: scope.side, scopeId: scope.scopeId, rowKeys, detail })
  const defer = (scope: Navigation3ContextScope, link: Destination, reason: string) => {
    unresolved.push({ side: scope.side, scopeId: scope.scopeId, rowKey: link.cell!.rowKey, key: link.key,
      sourceRef: link.cell!.sourceRef, reason, target: link.target })
  }
  for (const scope of context.scopes) {
    if (scope.finalDocumentId === null) continue
    const host = finalDocuments.get(scope.finalDocumentId)
      ?? graph3Conflict('navigation-final-host-missing', scope.scopeId)
    const originals = new Map(scope.blocks.map(block => [block.occurrenceKey, block]))
    for (const link of scope.destinations) {
      if (!link.cell || link.finalOccurrenceKey === null) continue
      const cell = link.cell, key = fieldKey(cell), old = originals.get(link.key.blockId)
      if (!old || old.block.content.slice(link.key.from, link.key.to) !== link.key.raw
        || !old.cell || !same(old.cell.sourceRef, cell.sourceRef)) return graph3Conflict('navigation-original-cell-provenance', link.key)
      // Upstream structure changes may change a synced ref payload, but never
      // ordinary destinations or canonical text before this explicit transform.
      if (old.block.content !== cell.text) return graph3Conflict('navigation-original-cell-already-rewritten', cell.rowKey)
      const previous = cells.get(key)
      if (previous && !same(previous, cell)) return graph3Conflict('navigation-conflicting-cell-occurrences', cell.rowKey)
      cells.set(key, cell)
      if (link.target.kind === 'captured-binding' || link.location.groupId !== null) {
        if (link.target.kind !== 'opaque') defer(scope, link, 'captured-canonical-binding-awaits-qualified-target-proof')
        continue
      }
      const target = link.finalTarget
      if (target.kind === 'opaque') { observations.push({ scope, link, target: null }); continue }
      if (target.kind === 'unresolved' || target.kind === 'captured-binding') {
        defer(scope, link, target.kind === 'unresolved' ? target.reason : 'captured-binding-awaits-target-proof')
        observations.push({ scope, link, target: null }); continue
      }
      const rendered = renderNavigation3Destination(link, { documentId: host.id, path: host.path }, target)
      if ('reason' in rendered) { defer(scope, link, rendered.reason); observations.push({ scope, link, target }); continue }
      const resolved = resolveFinalNavigation3(context.final, host.id, rendered.url, link.key.syntax === 'wiki')
      if (!targetMatches(target, resolved)) {
        conflict('rendered-navigation-does-not-name-proven-target', scope, [cell.rowKey], { key: link.key, expected: target, actual: resolved })
        observations.push({ scope, link, target }); continue
      }
      observations.push({ scope, link, target })
      if (rendered.replacement === link.key.raw) continue
      const edit: Edit = { side: scope.side, table: cell.table, rowKey: cell.rowKey, column: cell.column,
        sourceRef: cell.sourceRef, from: link.key.from, to: link.key.to, before: link.key.raw, after: rendered.replacement, target }
      const list = editsByCell.get(key) ?? []
      const rangeKey = graph3Key(key, edit.from, edit.to), duplicate = editsByRange.get(rangeKey)
      if (duplicate && !same(duplicate, edit)) conflict('navigation-one-cell-needs-incompatible-edits', scope, [cell.rowKey], { previous: duplicate, next: edit })
      else if (!duplicate) { list.push(edit); editsByRange.set(rangeKey, edit) }
      editsByCell.set(key, list)
    }
  }
  const changedText = new Map<string, string>(), edits: Edit[] = []
  let valueBytes = storageValueBytes(merged.tables)
  for (const [key, list] of editsByCell) {
    const cell = cells.get(key)!, ordered = [...list].sort((a, b) => a.from - b.from || a.to - b.to)
    const text = applyNavigation3TextEdits(cell.text, ordered)
    const encoding = cell.encoding === 'UTF-8' ? 'utf8' : 'utf16le'
    valueBytes += Buffer.byteLength(text, encoding) - Buffer.byteLength(cell.text, encoding)
    changedText.set(key, text); for (const edit of ordered) edits.push(edit)
  }
  if (valueBytes > CAPSULE2_RAW_MAX_VALUE_BYTES) return graph3Conflict('navigation-final-storage-value-budget', null)
  const tables = merged.tables.map(table => ({ ...table, rows: table.rows.map(row => {
    const column = table.name === 'documents' ? 'summary' : table.name === 'blocks' || table.name === 'synced_group_blocks' ? 'content' : null
    const changed = column === null ? undefined : changedText.get(graph3Key(table.name, row.key, column))
    if (changed === undefined || column === null) return row
    const index = table.columns.indexOf(column)
    if (index < 0) return graph3Conflict('navigation-final-column-missing', column)
    return { ...row, cells: row.cells.map((cell, i) => i === index ? graph3Encode(changed, table.encoding) : cell) }
  }) }))
  assertMerge3JsonBudget(tables)
  const final = buildMerge3NavigationFinalIndex3(data, tables)
  const rangeProjections = new Map([...editsByCell].map(([key, list]) => [key, createNavigation3RangeProjection(list)]))
  const unchangedRange = createNavigation3RangeProjection([])
  const finalScopes = new Map(final.scopes.map(scope => [graph3Key(scope.field, scope.finalDocumentId), scope]))
  const finalDestinations = new Map(final.scopes.map(scope => [scope.scopeId, new Map(scope.destinations.map(link => [exactKey(link.key), link]))]))
  const projections: Array<{ side: 'source' | 'current'; scopeId: string; rowKey: string; before: Destination['key'];
    after: Destination['key']; expectedTarget: Navigation3FinalTarget | null; actualTarget: ReturnType<typeof resolveFinalNavigation3> | null }> = []
  for (const { scope, link, target } of observations) {
    const cell = link.cell!, destinationScope = finalScopes.get(graph3Key(scope.field, scope.finalDocumentId))
    if (!destinationScope) return graph3Conflict('navigation-final-scope-missing', scope.scopeId)
    const text = changedText.get(fieldKey(cell)) ?? cell.text
    const range = (rangeProjections.get(fieldKey(cell)) ?? unchangedRange)(link.key.from, link.key.to)
    if (!range) return graph3Conflict('navigation-final-range-overlap', link.key)
    const key = { ...link.key, blockId: link.finalOccurrenceKey!, ...range, raw: text.slice(range.from, range.to) }
    const actual = finalDestinations.get(destinationScope.scopeId)!.get(exactKey(key))
    if (!actual || !same(actual.grammar, link.grammar) || actual.image !== link.image) {
      conflict('navigation-final-grammar-or-range-changed', scope, [cell.rowKey], { before: link.key, after: key }); continue
    }
    const resolved = link.target.kind === 'opaque' ? null
      : resolveFinalNavigation3(final, destinationScope.finalDocumentId, actual.url, key.syntax === 'wiki')
    projections.push({ side: scope.side, scopeId: scope.scopeId, rowKey: cell.rowKey, before: link.key, after: key, expectedTarget: target, actualTarget: resolved })
    if (target && resolved && !targetMatches(target, resolved))
      conflict('navigation-final-target-identity-changed', scope, [cell.rowKey], { before: link.key, expected: target, actual: resolved })
    else if (!target && resolved && ['document', 'block', 'heading'].includes(resolved.kind))
      conflict('unresolved-navigation-became-live', scope, [cell.rowKey], { before: link.key, actual: resolved })
    const originalPath = key.syntax === 'wiki' ? parseWikiReference(link.url).path : parseLocalMarkdownUrl(link.url)?.path
    const relativeUnknown = Boolean(originalPath && (key.syntax === 'wiki' ? /^\.\.?\//.test(originalPath) : !originalPath.startsWith('/')))
    if (link.target.kind === 'unresolved' && relativeUnknown) {
      const before = key.syntax === 'wiki' ? wikiDocumentPaths(parseWikiReference(link.url).path, scope.path)
        : resolveMarkdownDocumentPath(scope.path, link.url)
      const after = key.syntax === 'wiki' ? wikiDocumentPaths(parseWikiReference(actual.url).path, destinationScope.path)
        : resolveMarkdownDocumentPath(destinationScope.path, actual.url)
      if (!same(before, after)) conflict('unresolved-navigation-path-context-changed', scope, [cell.rowKey], { before, after, key: link.key })
    }
  }
  validateDefinitionEnvironments(context.scopes, final, changedText, conflict)
  const body = { kind: 'root-restore-navigation-text-candidate' as const, version: 3 as const,
    scope: 'source-and-current-ordinary-body-and-summary' as const,
    mergedContentHash: merged.mergedContentHash, navigationContextHash: context.contextHash,
    sourceNavigationInputHash: context.source.navigationInputHash, currentNavigationInputHash: context.current.navigationInputHash,
    conservationHash: merged.conservationHash, identityAllocationHash: merged.identityAllocationHash,
    sourceMaterialHash: merged.sourceMaterialHash, currentMaterialHash: merged.currentMaterialHash, choices: merged.choices,
    targetEncoding: merged.targetEncoding, tables, edits, projections, unresolved,
    finalSyntaxIndexHash: final.indexHash, finalHeadingNamespaces: final.headingNamespaces,
    conflicts: [...merged.conflicts, ...conflicts], candidateConflictFree: merged.conflicts.length === 0 && conflicts.length === 0,
    ordinaryNavigationCellsRewritten: true as const, completeFinalScopesReparsed: true as const,
    canonicalBindingsRewritten: false as const, templateNavigationRewritten: false as const,
    originalRouteRowsRewritten: false as const, documentLinkCountsRecomputed: false as const,
    referenceRewriteComplete: false as const, semanticValidationComplete: false as const,
    sourcePolicyReplayed: false as const, sourceHistoryReplayed: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  assertMerge3JsonBudget(body)
  return freezeCapsuleValue({ ...body, navigationRewriteHash: capsuleBytesHash('knowbook.restore.navigation3.rewritten-cells.v1\0' + capsuleJson(body)) })
}

function storageValueBytes(tables: readonly Navigation3Table[]) {
  let bytes = 0
  for (const table of tables) for (const row of table.rows) for (const cell of row.cells) {
    bytes += cell[0] === 'text' || cell[0] === 'blob' ? cell[1].length / 4 * 3 - (cell[1].endsWith('==') ? 2 : cell[1].endsWith('=') ? 1 : 0) : 8
    if (bytes > CAPSULE2_RAW_MAX_VALUE_BYTES) return graph3Conflict('navigation-original-storage-value-budget', null)
  }
  return bytes
}

function validateDefinitionEnvironments(scopes: readonly Navigation3ContextScope[], final: Navigation3FinalIndex,
  changed: ReadonlyMap<string, string>,
  conflict: (code: string, scope: Navigation3ContextScope, rowKeys: readonly string[], detail: unknown) => void) {
  const finalScopes = new Map(final.scopes.map(scope => [graph3Key(scope.field, scope.finalDocumentId), scope]))
  for (const scope of scopes) {
    const ordinary = scope.blocks.filter(block => block.cell && block.finalOccurrenceKey !== null && block.location.groupId === null)
    if (!ordinary.length || scope.finalDocumentId === null) continue
    const actual = finalScopes.get(graph3Key(scope.field, scope.finalDocumentId))!
    // Reparse the complete OLD environment with just the declared destination
    // edits. This permits changed hrefs while retaining semantic units/uses.
    const expected = captureSyncedCreateSourceFacts(scope.blocks.map(entry => ({ ...entry.block,
      content: entry.cell ? changed.get(fieldKey(entry.cell)) ?? entry.block.content : entry.block.content })))
    const originals = new Map(scope.blocks.map(block => [block.occurrenceKey, block]))
    const actualUses = new Map(actual.uses.map(use => [use.blockId, use.definitions]))
    const actualEffective = new Map(actual.effectiveDefinitions.map(item => [item.key, item.definition]))
    const expectedUnits = new Map<string, typeof expected.units>(), actualUnits = new Map<string, typeof actual.units>()
    for (const unit of expected.units) { const list = expectedUnits.get(unit.blockId) ?? []; list.push(unit); expectedUnits.set(unit.blockId, list) }
    for (const unit of actual.units) { const list = actualUnits.get(unit.blockId) ?? []; list.push(unit); actualUnits.set(unit.blockId, list) }
    const pending: string[] = [], visited = new Set<string>()
    for (const block of ordinary) {
      const wantedUses = [...(expected.uses.get(block.occurrenceKey) ?? [])].sort()
      const gotUses = [...(actualUses.get(block.finalOccurrenceKey!) ?? [])].sort()
      if (!same(wantedUses, gotUses)) conflict('definition-environment-changed', scope, [block.cell!.rowKey], { occurrence: block.occurrenceKey, expected: wantedUses, actual: gotUses })
      const wantedUnits = (expectedUnits.get(block.occurrenceKey) ?? []).map(unit => ({ ...unit, blockId: block.finalOccurrenceKey }))
      if (!same(wantedUnits, actualUnits.get(block.finalOccurrenceKey!) ?? []))
        conflict('ordinary-navigation-semantic-unit-changed', scope, [block.cell!.rowKey], { occurrence: block.occurrenceKey })
      for (const key of wantedUses) pending.push(key)
    }
    while (pending.length) {
      const key = pending.pop()!
      if (visited.has(key)) continue
      visited.add(key)
      const expectedDefinition = expected.effective.get(key), observed = actualEffective.get(key)
      const originalDefinition = expectedDefinition && originals.get(expectedDefinition.blockId)
      if (!expectedDefinition || !observed || !originalDefinition?.cell || originalDefinition.finalOccurrenceKey === null
        || observed.blockId !== originalDefinition.finalOccurrenceKey || observed.kind !== expectedDefinition.kind
        || observed.label !== expectedDefinition.label || observed.from !== expectedDefinition.from || observed.to !== expectedDefinition.to) {
        conflict('definition-environment-changed', scope, ordinary.map(block => block.cell!.rowKey), { definitionKey: key }); continue
      }
      const dependencies = [...(expected.uses.get(expectedDefinition.blockId) ?? [])].sort()
      if (!same(dependencies, [...(actualUses.get(observed.blockId) ?? [])].sort()))
        conflict('definition-environment-changed', scope, [originalDefinition.cell.rowKey], { definitionKey: key, reason: 'reachable-definition-uses' })
      const expectedBody = (expectedUnits.get(expectedDefinition.blockId) ?? [])
        .filter(unit => unit.to > expectedDefinition.from && unit.from < expectedDefinition.to)
        .map(unit => ({ ...unit, blockId: observed.blockId }))
      const actualBody = (actualUnits.get(observed.blockId) ?? []).filter(unit => unit.to > observed.from && unit.from < observed.to)
      if (!same(expectedBody, actualBody))
        conflict('definition-environment-changed', scope, [originalDefinition.cell.rowKey], { definitionKey: key, reason: 'reachable-definition-semantic-units' })
      for (const dependency of expected.uses.get(expectedDefinition.blockId) ?? []) pending.push(dependency)
    }
  }
}
