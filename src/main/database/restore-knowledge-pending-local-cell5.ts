import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { graph3Conflict, graph3Encode, graph3Key, graph3Rows, type Graph3Inputs } from './restore-knowledge-graph3-data'
import { withStoredMerge3NavigationFinalIndex3, type Navigation3FinalIndex, type Navigation3FinalScope,
  type Navigation3Table, type StoredNavigation3Index } from './restore-knowledge-navigation3-merge-context'
import type { ScopedNavigation3Rewrite } from './restore-knowledge-navigation3-rewrite-model'
import { projectNavigation3TableRows, type Navigation3TableSource } from './restore-knowledge-navigation3-tables'
import type { MergedRow3 } from './restore-knowledge-merge3-storage'
import type { SelectedPendingLocalBody5 } from './restore-knowledge-pending-local-selection5'
import { withStoredRestoreScopes } from './restore-knowledge-stored-scopes'
import { projectWorkingAssetBodyCells5, workingAssetCellPosition5 } from './restore-knowledge-working-asset-cells5'

const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
const fail = (reason: string): never => graph3Conflict('pending-local-cell-' + reason, null)
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
export const pendingLocalCellTextHash5 = (text: string) => hash('knowbook.restore.pending-local-cell-text.v1', text)
const assetRange = (value: { from: number; to: number; raw: string }, uri: string) => graph3Key(value.from, value.to, value.raw, uri)
const linkKey = ({ key, url, image, grammar, location }: Navigation3FinalScope['destinations'][number]) => graph3Key(key, url, image, grammar, location)
type PriorNavigation = Pick<Navigation3FinalScope, 'effectiveDefinitions' | 'uses'> & { readonly linkKeys: ReadonlySet<string> }

function assertNavigationClosure5(previous: PriorNavigation, next: Navigation3FinalScope, occurrence: string,
  selected: SelectedPendingLocalBody5) {
  const nextLinks = new Set(next.destinations.map(linkKey))
  for (const key of previous.linkKeys) if (!nextLinks.has(key)) return fail('navigation-would-change')
  const assets = new Set(selected.assets.map(asset => assetRange(asset, asset.uri)))
  for (const link of next.destinations) if (!previous.linkKeys.has(linkKey(link))) {
    if (link.finalOccurrenceKey !== occurrence || !assets.has(assetRange(link.key, link.url))) return fail('new-navigation-destination')
  }

  const definitions = new Map(next.effectiveDefinitions.map(value => [value.key, value.definition]))
  const previousDefinitions = new Set(previous.effectiveDefinitions.map(value => value.key)), newDefinitions = new Set<string>()
  for (const { key, definition } of previous.effectiveDefinitions) {
    const retained = definitions.get(key)
    if (!retained || !same(retained, definition)) return fail('effective-definition-would-change')
  }
  for (const { key, definition } of next.effectiveDefinitions) if (!previousDefinitions.has(key)) {
    if (definition.blockId !== occurrence) return fail('new-definition-outside-selected-cell')
    newDefinitions.add(key)
  }
  const previousUses = new Map(previous.uses.map(value => [value.blockId, value.definitions]))
  const nextUses = new Map(next.uses.map(value => [value.blockId, value.definitions]))
  for (const [block, keys] of previousUses) if (keys.some(key => !nextUses.get(block)?.includes(key)))
    return fail('definition-use-would-disappear')
  for (const [block, keys] of nextUses) if (keys.some(key => !previousUses.get(block)?.includes(key) && !newDefinitions.has(key)))
    return fail('definition-use-would-rebind')

  const parsed = projectWorkingAssetBodyCells5(next.blocks.map(value => value.block), 'base')
  for (const asset of selected.assets) {
    const actual = parsed.byCellPosition.get(workingAssetCellPosition5(occurrence, asset))
    if (!actual || actual.raw !== asset.raw || actual.kind !== asset.kind || actual.syntax !== asset.syntax)
      return fail('final-asset-range')
  }
  const observedAssets = [...parsed.byCellPosition.values()].filter(value => value.blockId === occurrence)
  if (observedAssets.length !== selected.assets.length || assets.size !== selected.assets.length) return fail('final-asset-closure')
}

/** The sourceRef is copied from the existing checked business row. This
 * function only substitutes its content cell after validating exact identity. */
export function withSelectedPendingLocalBody5<Selection>(data: Graph3Inputs, ordinary: ScopedNavigation3Rewrite, selected: SelectedPendingLocalBody5,
  read: (index: StoredNavigation3Index, tables: readonly Navigation3TableSource[]) => Selection) {
  const blocks = ordinary.tables.find(table => table.name === 'blocks') ?? fail('missing-business-table')
  const column = blocks.columns.indexOf('content')
  let match: MergedRow3 | undefined
  for (const row of blocks.rows) if (row.sourceRef.side === 'source' && row.sourceRef.sourceRowId === selected.sourceRowId) {
    if (match) return fail('selected-row')
    match = row
  }
  const target = match
  if (!target || column < 0 || target.sourceRef.table !== 'blocks'
    || target.sourceRef.materialHash !== selected.sourceMaterialHash || !same(target.cells[column], graph3Encode(selected.before, blocks.encoding))
    || ordinary.edits.some(edit => edit.table === 'blocks' && edit.rowKey === target.key)) return fail('selected-row')
  type NavigationRow = Navigation3FinalIndex['headingNamespaces'][number] | Navigation3FinalIndex['routes'][number]
  return withStoredRestoreScopes((append: (id: string, row: NavigationRow) => void) =>
    withStoredMerge3NavigationFinalIndex3(data, ordinary.tables, prior => {
      const physical = prior.physicalLocations.find(block => block.rowKey === target.key)
      const document = physical && prior.documents.find(row => row.id === physical.documentId)
      const originalDocument = graph3Rows(data.inputs.source.source.sourceContent, 'documents').find(row => row.value.id === selected.documentId)
      if (!physical || physical.groupId !== null || physical.birth !== selected.blockBirth || !document || document.birth !== selected.documentBirth
        || !originalDocument || document.sourceRef.side !== 'source' || document.sourceRef.materialHash !== selected.sourceMaterialHash
        || document.sourceRef.sourceRowId !== originalDocument.original.sourceRowId) return fail('selected-identity')

      const scopeId = graph3Key('body', document.id), scope = prior.scope(scopeId)
      const navigation = scope && { linkKeys: new Set(scope.destinations.map(linkKey)), effectiveDefinitions: scope.effectiveDefinitions, uses: scope.uses }
      for (const [ordinal, row] of prior.headingNamespaces.entries()) append(`heading:${ordinal}`, row)
      for (const [ordinal, row] of prior.routes.entries()) append(`route:${ordinal}`, row)
      return { blockId: physical.id, blockBirth: physical.birth, documentId: document.id, scopeId, navigation,
        indexHash: prior.indexHash, headings: prior.headingNamespaces.length, routes: prior.routes.length }
    }), (prior, evidence) => {
    const tables = ordinary.tables.map(table => table === blocks ? projectNavigation3TableRows(table, row => row.key === target.key ? {
      ...row, cells: row.cells.map((cell, index) => index === column ? graph3Encode(selected.after, table.encoding) : cell)
    } : row) : table)
    return withStoredMerge3NavigationFinalIndex3(data, tables, final => {
      const nextScope = final.scope(prior.scopeId), occurrence = nextScope?.blocks.find(block => block.cell.rowKey === target.key)?.occurrenceKey
      if (!prior.navigation || !nextScope || !occurrence || prior.headings !== final.headingNamespaces.length || prior.routes !== final.routes.length)
        return fail('final-heading-or-route')
      const rows = evidence.iterateEncoded()
      try {
        for (const expected of [final.headingNamespaces, final.routes]) for (const item of expected) {
          const next = rows.next()
          if (next.done || next.value !== capsuleJson(item)) return fail('final-heading-or-route')
        }
        if (!rows.next().done) return fail('final-heading-or-route')
      } finally { rows.return?.() }
      assertNavigationClosure5(prior.navigation, nextScope, occurrence, selected)

      const body = { kind: 'pending-working-content' as const, version: 1 as const,
        choiceHash: hash('knowbook.restore.pending-local-choice.v1', selected.locator), sourceRef: target.sourceRef,
        targetRowId: target.targetRowId, column: 'content' as const, blockId: prior.blockId, documentId: prior.documentId,
        originalBlockId: selected.blockId, originalDocumentId: selected.documentId, scopeSource: selected.scopeSource,
        contextHash: selected.locator.contextHash, resultHash: selected.locator.localFinalHash, blockBirth: prior.blockBirth,
        beforeHash: pendingLocalCellTextHash5(selected.before), afterHash: pendingLocalCellTextHash5(selected.after),
        assets: selected.assets, beforeSyntaxHash: prior.indexHash, afterSyntaxHash: final.indexHash }
      const proof = freezeCapsuleValue({ ...body, proofHash: hash('knowbook.restore.pending-local-cell-proof.v1', body) })
      return { selection: read(final, tables), proof }
    })
  })
}

export function assertPendingLocalCandidateCellOnly5(previous: readonly Navigation3Table[], next: readonly Navigation3Table[],
  proof: ReturnType<typeof withSelectedPendingLocalBody5>['proof']) {
  if (previous.length !== 12 || next.length !== previous.length) return fail('business-table-closure')
  let changed = false
  for (const [tableIndex, oldTable] of previous.entries()) {
    const { rows: oldRows, ...oldShape } = oldTable, { rows: newRows, ...newShape } = next[tableIndex]
    if (!same(oldShape, newShape) || oldRows.length !== newRows.length) return fail('business-table-shape')
    for (const [rowIndex, oldRow] of oldRows.entries()) {
      const { cells: oldCells, ...oldAddress } = oldRow, { cells: newCells, ...newAddress } = newRows[rowIndex]
      if (!same(oldAddress, newAddress) || oldCells.length !== newCells.length) return fail('business-row-address')
      for (const [cellIndex, before] of oldCells.entries()) {
        const after = newCells[cellIndex]
        if (before[0] === after[0] && before[1] === after[1]) continue
        if (changed || oldTable.name !== 'blocks' || oldTable.columns[cellIndex] !== proof.column
          || oldRow.targetRowId !== proof.targetRowId || !same(oldRow.sourceRef, proof.sourceRef)) return fail('extra-business-cell-diff')
        changed = true
      }
    }
  }
  if (!changed) return fail('missing-business-cell-diff')
}
