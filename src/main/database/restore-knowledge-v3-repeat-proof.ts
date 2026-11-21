import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { graph3Conflict, graph3Key, graph3Value } from './restore-knowledge-graph3-data'
import { capsule2RawTableRows, scopedCapsule2TableIdLookup, type Capsule2Encoding } from './restore-knowledge-capsule2-raw-model'
import type { RawRestoreSqlCell } from './restore-knowledge-sql-cell'
import type { Identity3Assignment, Identity3Inputs } from './restore-knowledge-identity3-model'
import type { Reference3Allocation } from './restore-knowledge-reference3-model'
import type { ScopedColdRootRestoreReferenceInputs5 } from './restore-knowledge-reference3-read'
import type { ReferenceOriginalRows5 } from './restore-knowledge-reference-original-rows5'
import type { Merge3OriginalRowRef } from './restore-knowledge-merge3-storage'

type PriorEntry = Identity3Inputs['current']['priorCoverageRequirements']['entries'][number]
type InstalledAssignment = { readonly key: string; readonly targetId: string; readonly targetCreationId: string | null }
export interface ExactV3RepeatProof {
  readonly operationId: string
  readonly proofHash: string
  readonly assignments: readonly InstalledAssignment[]
  readonly bindings: readonly Reference3Allocation['bindingTargets'][number][]
}

const physicalTables = { database: 'databases', document: 'documents', group: 'synced_groups',
  column: 'document_database_columns', view: 'database_saved_views', entity: 'database_entities' } as const
const equal = (left: unknown, right: unknown): boolean => capsuleJson(left) === capsuleJson(right)
const fail = (reason: string): never => { throw new Error('V3 重复恢复的已安装身份不同：' + reason) }
const text = (value: unknown): string => typeof value === 'string' ? value : fail('缺实际 SQL 身份 TEXT')
const identityColumns = new Set(['created_at', 'creation_id', 'origin_json', 'group_id', 'document_id', 'database_id', 'type', 'host_document_id'])

function identityReader(columns: readonly string[], encoding: Capsule2Encoding, key: string) {
  const keyIndex = columns.indexOf(key)
  const selected = [...columns.entries()].filter(([, column]) => identityColumns.has(column))
  return (cells: readonly RawRestoreSqlCell[]) => {
    const id = text(keyIndex === -1 ? undefined : graph3Value(cells[keyIndex], encoding))
    const value: Record<string, unknown> = {}
    for (const [index, column] of selected) value[column] = graph3Value(cells[index], encoding)
    return { id, value }
  }
}

function tableFor(assignment: Identity3Assignment | Reference3Allocation['assignments'][number]) {
  return assignment.kind === 'block' ? assignment.ownerKind === 'group' ? 'synced_group_blocks' : 'blocks' : physicalTables[assignment.kind]
}

/** Capture only the repeated install's identity evidence. Old original rows
 * are selected from the same cold reference read, after its graph is released. */
export function projectV3RepeatReference5(prior: ScopedColdRootRestoreReferenceInputs5,
  rows: Readonly<{ source: ReferenceOriginalRows5; current: ReferenceOriginalRows5 }>) {
  const archive = prior.data.inputs.source.assetArchive
  const assignments = prior.allocation.assignments.filter(assignment => assignment.physical && !assignment.ambiguous)
  const targets = new Set(assignments.map(assignment => graph3Key(tableFor(assignment), assignment.targetId)))
  const targetTables = new Set<string>(assignments.map(tableFor))
  const installedRows = new Map<string, { value: Record<string, unknown>; ref: Merge3OriginalRowRef }>()
  for (const table of prior.candidate.tables) {
    if (!targetTables.has(table.name) || !table.columns.includes('id')) continue
    const readIdentity = identityReader(table.columns, table.encoding, 'id')
    for (const row of table.rows) {
      const { id, value } = readIdentity(row.cells)
      const key = graph3Key(table.name, id)
      if (targets.has(key)) installedRows.set(key, { value, ref: row.sourceRef })
    }
  }
  const backup = archive.version === 6 ? { snapshotId: archive.backupV3.snapshotId, inventoryHash: archive.backupV3.inventoryHash } : undefined
  return { archive: backup, oldSource: rows.source,
    currentWorkspaceScope: rows.current.workspaceScope, candidateConflictFree: prior.candidate.candidateConflictFree,
    assignments, installedRows, bindings: prior.allocation.bindingTargets.filter(item => item.side === 'source'),
    referenceManifestHash: prior.referenceManifestHash, assertPlanManifests: prior.assertPlanManifests }
}

/** Derive data for this plan invocation after the fixed installed owner has
 * authenticated the earlier root and Reference3 manifest. Current SQL always
 * supplies the actual target birth, owner, tuple and ledger. */
export function deriveExactV3RepeatProof(input: Identity3Inputs, prior: ReturnType<typeof projectV3RepeatReference5>, entry: PriorEntry): ExactV3RepeatProof | undefined {
  const sourceArchive = input.source.assetArchive, priorArchive = prior.archive
  if (sourceArchive.version !== 6 || !priorArchive || sourceArchive.backupV3.snapshotId !== priorArchive.snapshotId) return
  if (sourceArchive.backupV3.inventoryHash !== priorArchive.inventoryHash) return fail('同一 snapshotId 的实际清单哈希不同')
  const source = input.source.source.sourceContent, current = input.current.source.sourceContent
  if (!prior.candidateConflictFree || current.workspaceScope !== prior.currentWorkspaceScope)
    return fail('先前已安装候选与本次工作区不同')
  type RowIndex = Map<string, { get(id: string): Record<string, unknown> | undefined }>
  const currentRows: RowIndex = new Map(), sourceRows: RowIndex = new Map()
  const get = (tables: typeof currentRows, content: typeof current, table: string) => {
    let rows = tables.get(table)
    if (!rows) {
      const raw = content.tables.find(entry => entry.name === table)
      if (!raw) return graph3Conflict('missing-source-table', table)
      const readIdentity = identityReader(raw.columns, content.encoding, table === 'synced_instances' ? 'instance_id' : 'id')
      const stored = scopedCapsule2TableIdLookup(raw)
      if (stored) {
        rows = { get(id) { const row = stored(id); return row && readIdentity(row.cells).value } }
      } else {
        const indexed = new Map<string, Record<string, unknown>>()
        for (const row of capsule2RawTableRows(raw)) {
          const { id, value } = readIdentity(row.cells)
          indexed.set(id, value)
        }
        rows = indexed
      }
      tables.set(table, rows)
    }
    return rows
  }
  const oldReaders = new Map(prior.oldSource.tables.map(table => [table.name,
    { table, read: identityReader(table.columns, prior.oldSource.encoding, 'id') }]))
  const before = new Map(prior.assignments.map(assignment => [graph3Key(assignment.kind, assignment.sourceId), assignment]))
  const ledger = new Map(input.current.knowledge.identities.map(identity => [identity.id, identity]))
  const currentGroups = new Map(input.current.source.physical.groups.map(group => [group.groupId, group]))
  const assignments: InstalledAssignment[] = []
  for (const assignment of before.values()) {
    const { kind, targetId, sourceId, targetCreationId } = assignment, table = tableFor(assignment)
    const reader = oldReaders.get(table) ?? graph3Conflict('missing-source-table', table)
    const originalRow = reader.table.byId(sourceId), old = originalRow && reader.read(originalRow.cells).value
    const own = get(sourceRows, source, table).get(sourceId), actual = get(currentRows, current, table).get(targetId)
    const installed = prior.installedRows.get(graph3Key(table, targetId))
    if (!own || !old || !actual || !installed || installed.ref.side !== 'source'
      || own.created_at !== old.created_at || actual.created_at !== installed.value.created_at) return fail(table + ' / ' + sourceId)
    if (kind === 'group' && (!currentGroups.get(targetId)?.snapshot || actual.creation_id !== targetCreationId
      || actual.origin_json !== installed.value.origin_json || actual.created_at !== own.created_at)) return fail('同步组原 tuple / ' + sourceId)
    const ownerColumn = assignment.ownerKind === 'group' ? 'group_id' : assignment.ownerKind === 'document' ? 'document_id'
      : assignment.ownerKind === 'database' ? 'database_id' : null
    if (ownerColumn && (own[ownerColumn] !== assignment.ownerId || actual[ownerColumn] !== installed.value[ownerColumn]
      || actual[ownerColumn] !== before.get(graph3Key(assignment.ownerKind, assignment.ownerId))?.targetId))
      return fail('当前 owner / ' + sourceId)
    if (kind === 'column' && (actual.type !== own.type || actual.type !== installed.value.type)) return fail('列类型 / ' + sourceId)
    if (kind === 'block') {
      const identity = ledger.get(targetId)
      if (!identity || identity.state !== 'live' || identity.ownerKind !== assignment.ownerKind
        || identity.ownerId !== actual[ownerColumn!] || identity.createdAt !== actual.created_at || own.created_at !== actual.created_at)
        return fail('稳定块 owner/birth / ' + sourceId)
      const original = get(sourceRows, source, 'synced_instances').get(sourceId), target = get(currentRows, current, 'synced_instances').get(targetId)
      if (Boolean(original) !== Boolean(target) || original && target
        && (target.group_id !== before.get(graph3Key('group', original.group_id))?.targetId || target.host_document_id !== actual.document_id))
        return fail('同步实例目标 / ' + sourceId)
    }
    if (kind === 'document' && own.created_at !== actual.created_at) return fail('文档 birth / ' + sourceId)
    assignments.push({ key: assignment.key, targetId, targetCreationId })
  }
  const bindings = prior.bindings
  const proofHash = capsuleBytesHash('knowbook.restore.v3.exact-installed-identities.v1\0' + capsuleJson({
    entry, referenceManifestHash: prior.referenceManifestHash, currentMaterialHash: input.current.materialHash,
    snapshotId: sourceArchive.backupV3.snapshotId, inventoryHash: sourceArchive.backupV3.inventoryHash, assignments, bindings
  }))
  return freezeCapsuleValue({ operationId: entry.operationId, proofHash, assignments, bindings })
}
