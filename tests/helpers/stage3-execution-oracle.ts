// Test-only oracle. Expected cells come from the independently captured source
// and current SQL and genuine allocation, never the stage's execution report.
import assert from 'node:assert/strict'
import { capsuleBytesHash, capsuleJson } from '../../src/main/database/restore-knowledge-capsule-model'
import { graph3Text } from '../../src/main/database/restore-knowledge-graph3-data'
import type { Capsule2Encoding, Capsule2RawContent, Capsule2RawSqlRow } from '../../src/main/database/restore-knowledge-capsule2-raw-model'
import type { RawRestoreSqlCell } from '../../src/main/database/restore-knowledge-sql-cell'
import type { prepareRootRestoreReferencePlan3 } from '../../src/main/database/restore-knowledge-reference3-read'

type Reference = Awaited<ReturnType<typeof prepareRootRestoreReferencePlan3>>['value']
type Table = Reference['candidate']['tables'][number]
type OriginalRef = Table['rows'][number]['sourceRef']
type Packet = { readonly materialHash: string; readonly source: { readonly sourceContent: Capsule2RawContent } }
type Change = { table: 'synced_groups' | 'synced_instances'; targetRowId: string; targetId: string; sourceId: string;
  sourceRef: OriginalRef; currentSourceRef: OriginalRef | null; proofKind: 'new-incoming-allocation' | 'current-boundary-preserved';
  cells: Array<{ column: string; before: RawRestoreSqlCell; after: RawRestoreSqlCell; allocationField: string | null }> }
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const rowOrder = (a: { sourceRowId: string }, b: { sourceRowId: string }) => BigInt(a.sourceRowId) < BigInt(b.sourceRowId) ? -1 : BigInt(a.sourceRowId) > BigInt(b.sourceRowId) ? 1 : 0
function textCell(value: string, encoding: Capsule2Encoding): RawRestoreSqlCell {
  const bytes = Buffer.from(value, encoding === 'UTF-8' ? 'utf8' : 'utf16le')
  if (encoding === 'UTF-16be') bytes.swap16()
  return ['text', bytes.toString('base64')]
}
function readText(columns: readonly string[], row: { cells: readonly RawRestoreSqlCell[] }, field: string, encoding: Capsule2Encoding) {
  const index = columns.indexOf(field)
  assert.ok(index >= 0); assert.equal(row.cells[index][0], 'text')
  return graph3Text(row.cells[index], encoding)
}
export function stage3RawTablesForHash(tables: readonly Table[]) {
  return tables.map(table => ({ name: table.name, role: 'content' as const, columns: table.columns, primaryKey: table.primaryKey,
    rows: table.rows.map(row => ({ sourceRowId: row.targetRowId, cells: row.cells })).sort(rowOrder) }))
}
export function expectedStage3Execution(reference: Reference, source: Packet, current: Packet) {
  assert.equal(source.materialHash, reference.allocation.sourceMaterialHash)
  assert.equal(current.materialHash, reference.allocation.currentMaterialHash)
  const sourceContent = source.source.sourceContent, currentContent = current.source.sourceContent, changes: Change[] = []
  const tables = reference.candidate.tables.map(table => {
    if (table.name !== 'synced_groups' && table.name !== 'synced_instances') return table
    const name = table.name, idField = name === 'synced_groups' ? 'id' : 'instance_id'
    const currentTable = currentContent.tables.find(item => item.name === name)!, sourceTable = sourceContent.tables.find(item => item.name === name)!
    assert.ok(currentTable); assert.ok(sourceTable)
    const currentById = new Map(currentTable.rows.map(row => [readText(currentTable.columns, row, idField, currentContent.encoding), row]))
    const sourceByRow = new Map(sourceTable.rows.map(row => [row.sourceRowId, row]))
    return { ...table, rows: table.rows.map(row => {
      const targetId = readText(table.columns, row, idField, table.encoding), prior = currentById.get(targetId)
      const original: Capsule2RawSqlRow | undefined = row.sourceRef.side === 'source' ? sourceByRow.get(row.sourceRef.sourceRowId) : prior
      assert.ok(original); assert.equal(row.sourceRef.table, name)
      const sourceId = row.sourceRef.side === 'source' ? readText(sourceTable.columns, original, idField, sourceContent.encoding)
        : readText(currentTable.columns, original, idField, currentContent.encoding)
      const required: Array<{ column: string; after: RawRestoreSqlCell; allocationField: string | null }> = []
      let currentSourceRef: OriginalRef | null = null
      if (prior) {
        currentSourceRef = { side: 'current', table: name, sourceRowId: prior.sourceRowId,
          payload: reference.allocation.currentPayload, materialHash: current.materialHash, witness: reference.allocation.currentWitness,
          originalRowHash: hash('knowbook.restore.merge3.original-row.v1', { table: name, columns: currentTable.columns,
            primaryKey: currentTable.primaryKey, encoding: currentContent.encoding, sourceRowId: prior.sourceRowId, cells: prior.cells }) }
        for (const column of name === 'synced_groups' ? ['revision', 'topology_revision', 'history_cursor', 'history_position'] : ['binding_version']) {
          const index = currentTable.columns.indexOf(column)
          assert.ok(index >= 0)
          required.push({ column, after: prior.cells[index], allocationField: null })
        }
      } else {
        assert.equal(row.sourceRef.side, 'source', 'Only a real incoming source occurrence can obtain fresh execution guards')
        if (name === 'synced_groups') {
          const allocations = reference.allocation.execution.groups.filter(item => item.targetGroupId === targetId && item.sourceGroupId === sourceId)
          assert.equal(allocations.length, 1)
          const allocated = allocations[0], intent = reference.allocation.materialization.lifecycleIntents.find(item => item.targetGroupId === targetId)!
          assert.ok(intent); assert.equal(intent.mode, 'new-import-materialization'); assert.equal(intent.sourceGroupId, sourceId)
          assert.equal(intent.targetCreationId, readText(table.columns, row, 'creation_id', table.encoding))
          assert.equal(allocated.sourceActive, true); assert.equal(allocated.historyPosition, 0)
          assert.equal(intent.activationRevision, allocated.revision); assert.equal(intent.activationTopologyRevision, allocated.topologyRevision)
          required.push({ column: 'revision', after: textCell(allocated.revision, table.encoding), allocationField: 'execution.groups.revision' },
            { column: 'topology_revision', after: textCell(allocated.topologyRevision, table.encoding), allocationField: 'execution.groups.topologyRevision' },
            { column: 'history_cursor', after: textCell(allocated.historyCursor, table.encoding), allocationField: 'execution.groups.historyCursor' },
            { column: 'history_position', after: ['integer', '0'], allocationField: 'execution.groups.historyPosition' })
        } else {
          const allocations = reference.allocation.execution.instances.filter(item => item.targetInstanceId === targetId && item.sourceInstanceId === sourceId)
          assert.equal(allocations.length, 1)
          const oldGroup = readText(sourceTable.columns, original, 'group_id', sourceContent.encoding)
          const group = reference.allocation.execution.groups.find(item => item.sourceGroupId === oldGroup)!
          assert.ok(group); assert.equal(group.targetGroupId, readText(table.columns, row, 'group_id', table.encoding))
          required.push({ column: 'binding_version', after: textCell(allocations[0].bindingVersion, table.encoding), allocationField: 'execution.instances.bindingVersion' })
        }
      }
      const cells = [...row.cells], actualChanges: Change['cells'] = []
      for (const item of required) {
        const index = table.columns.indexOf(item.column)
        assert.ok(index >= 0)
        if (capsuleJson(cells[index]) !== capsuleJson(item.after)) actualChanges.push({ column: item.column, before: cells[index], after: item.after, allocationField: item.allocationField })
        cells[index] = item.after
      }
      if (actualChanges.length) changes.push({ table: name, targetRowId: row.targetRowId, targetId, sourceId, sourceRef: row.sourceRef,
        currentSourceRef, proofKind: prior ? 'current-boundary-preserved' : 'new-incoming-allocation', cells: actualChanges })
      return { ...row, cells }
    }) }
  })
  const order = new Map(reference.candidate.tables.map((table, index) => [table.name, index]))
  changes.sort((a, b) => order.get(a.table)! - order.get(b.table)! || rowOrder({ sourceRowId: a.targetRowId }, { sourceRowId: b.targetRowId }))
  const sourceCandidate12TablesHash = hash('knowbook.restore.stage3.planned-content.v1', stage3RawTablesForHash(reference.candidate.tables))
  const physical12TablesHash = hash('knowbook.restore.stage3.planned-content.v1', stage3RawTablesForHash(tables))
  const transition = { scope: 'new-incoming-allocation-and-current-boundary-preservation',
    canonicalCandidateHash: reference.candidate.canonicalCandidateHash, checkedCanonicalCandidateHash: reference.candidate.checkedCanonicalCandidateHash,
    sourceCandidate12TablesHash, physical12TablesHash, derivedReferenceAllocationHash: reference.allocation.derivedReferenceAllocationHash,
    executionChanges: changes, currentExecutionBoundariesPreserved: true, workspaceEpochAndDocumentCasAndHostCutPending: true,
    finalCurrentRetainedCutComplete: false }
  return { tables, executionChanges: changes, sourceCandidate12TablesHash, physical12TablesHash,
    stageExecutionHash: hash('knowbook.restore.stage3.execution-transition.v1', transition) }
}
