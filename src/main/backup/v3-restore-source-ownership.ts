import { capsuleJson, freezeCapsuleValue } from '../database/restore-knowledge-capsule-model'
import { root3SupplementOriginalRowHash3 } from '../database/restore-knowledge-assets3-context'
import { graph3Value } from '../database/restore-knowledge-graph3-data'
import { readVerifiedRestoreKnowledgePriorInstall, type RestoreKnowledgePriorInstall } from '../database/restore-knowledge-install-proof'
import type { ColdRootRestoreReferenceInputs5, Reference3Value } from '../database/restore-knowledge-reference3-read'
import type { ReferenceOriginalRows5 } from '../database/restore-knowledge-reference-original-rows5'
import type { SyncedGroupWire } from '../../shared/synced-blocks'
import { hasNoV3RetirementHistoricalReferences } from './v3-restore-source-dependencies'

const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
const invalid = (condition: string): never => { throw new Error('Invalid installed V3 source group evidence: ' + condition) }

type Edge = { predecessor: { snapshotId: string; archiveHash: string; catalogId: string } }
type Original = Parameters<typeof hasNoV3RetirementHistoricalReferences>[0]

function projectHistoricalOriginals(reference: ColdRootRestoreReferenceInputs5,
  rows: Readonly<{ source: ReferenceOriginalRows5; current: ReferenceOriginalRows5 }>) {
  const { source, current } = reference.data.inputs
  const selected = (packet: typeof source, sourceContent: ReferenceOriginalRows5): Original => ({
    source: { sourceContent, physical: packet.source.physical }, knowledge: packet.knowledge })
  return { source: selected(source, rows.source), current: selected(current, rows.current), assertPlanManifests: reference.assertPlanManifests }
}

function projectSourceOwnedReference(reference: ColdRootRestoreReferenceInputs5,
  rows: Parameters<typeof projectHistoricalOriginals>[1]) {
  const { source } = reference.data.inputs, { candidate } = reference
  const backup = source.assetArchive.version === 6 ? source.assetArchive.backupV3 : undefined
  const archive = backup && { snapshotId: backup.snapshotId, inventoryHash: backup.inventoryHash }
  return { originals: projectHistoricalOriginals(reference, rows), rows, allocation: reference.allocation, archive,
    sourceMaterialHash: source.materialHash, sourceGroupFacts: source.knowledge.groups,
    allowed: candidate.candidateConflictFree && candidate.finalForestValidated && !candidate.pendingLocalBody,
    installedTable: candidate.tables.find(table => table.name === 'synced_groups'), installedWires: candidate.activeGroupWires }
}

/** Recover ownership and scan dependencies while the old originals are still
 * open. No previous raw SQL payload survives into the next historical read. */
async function readPriorV3SourceOwnedGroups(handle: RestoreKnowledgePriorInstall, edge: Edge,
  current: ReadonlyMap<string, SyncedGroupWire>, sourceGroupIds: ReadonlySet<string>) {
  const prior = readVerifiedRestoreKnowledgePriorInstall(handle)
  return prior.withReferenceOriginalRows(projectSourceOwnedReference, async reference => {
    const groups = readSourceOwnedGroups(prior.sourceArchive, reference)
    await reference.originals.assertPlanManifests()
    await prior.assertOriginalProof()
    const missing = groups.catalogId === edge.predecessor.catalogId
      ? groups.values.filter(group => !sourceGroupIds.has(group.source.groupId) && same(current.get(group.wire.id) ?? null, group.wire)) : []
    if (!missing.length) return { groups: missing, historiesClear: true }
    const sourceWires = missing.map(group => group.sourceWire), installedWires = missing.map(group => group.wire)
    const historiesClear = hasNoV3RetirementHistoricalReferences(reference.originals.source, sourceWires, new Set(sourceWires.map(group => group.id)))
      && hasNoV3RetirementHistoricalReferences(reference.originals.current, installedWires, new Set(installedWires.map(group => group.id)))
    return { groups: freezeCapsuleValue(missing), historiesClear }
  })
}

function readSourceOwnedGroups(sourceArchive: { snapshotId: string; inventoryHash: string },
  reference: ReturnType<typeof projectSourceOwnedReference>) {
  const { allocation, archive, installedTable } = reference
  if (!reference.allowed)
    return invalid('the installed plan is outside the checked source-only scope')
  if (!archive || !same({ snapshotId: archive.snapshotId, inventoryHash: archive.inventoryHash }, sourceArchive))
    return invalid('the source archive belongs to another installed plan')

  const sourceContent = reference.rows.source, currentContent = reference.rows.current
  const settings = sourceContent.tables.find(table => table.name === 'app_settings')
  if (!settings) return invalid('the original source catalog settings are missing')
  const keyColumn = settings.columns.indexOf('key'), valueColumn = settings.columns.indexOf('value')
  if (keyColumn < 0 || valueColumn < 0) return invalid('the original catalog settings are incomplete')
  let catalogId: unknown
  for (const row of settings.rows) if (graph3Value(row.cells[keyColumn], sourceContent.encoding) === 'database.defaultId') {
    catalogId = graph3Value(row.cells[valueColumn], sourceContent.encoding)
    break
  }
  if (typeof catalogId !== 'string') return invalid('the original source catalog identity is missing')
  const sourceTable = sourceContent.tables.find(table => table.name === 'synced_groups')
  const currentTable = currentContent.tables.find(table => table.name === 'synced_groups')
  if (!sourceTable || !currentTable || !installedTable) return invalid('an original or installed group table is missing')
  const sourceGroupFacts = new Map(reference.sourceGroupFacts.map(group => [group.tuple.groupId, group]))
  const sourceActive = new Map(reference.originals.source.source.physical.groups.flatMap(group => group.snapshot ? [[group.groupId, group.snapshot] as const] : []))
  const installedWires = new Map(reference.installedWires.map(wire => [wire.id, wire]))
  const installedIds = new Map(installedTable.rows.map(row => {
    const fields = Object.fromEntries(installedTable.columns.map((column, index) => [column, graph3Value(row.cells[index], installedTable.encoding)]))
    return [fields.id, { row, fields }] as const
  }))

  const groups = [], claimed = new Set<string>()
  for (const slot of allocation.assignments) {
    if (slot.kind !== 'group' || !slot.physical || slot.ambiguous) continue
    const sourceSnapshot = sourceActive.get(slot.sourceId)
    if (!sourceSnapshot) continue
    const group = sourceGroupFacts.get(slot.sourceId), original = sourceTable.byId(slot.sourceId)
    const installed = installedIds.get(slot.targetId), wire = installedWires.get(slot.targetId)
    if (!original) return invalid('a qualified source group does not match its installed allocation')
    const get = (column: string) => graph3Value(original.cells[sourceTable.columns.indexOf(column)], sourceContent.encoding)
    const originalRef = { side: 'source' as const, table: 'synced_groups' as const, sourceRowId: original.sourceRowId,
      payload: allocation.sourcePayload, witness: allocation.sourceWitness, materialHash: reference.sourceMaterialHash,
      originalRowHash: root3SupplementOriginalRowHash3(sourceContent, { original, table: sourceTable }) }
    if (!group || !installed || !wire || slot.targetCreationId === null || claimed.has(slot.targetId)
      || group.tuple.createdAt !== slot.birth || group.comparisonKey !== slot.incarnation
      || get('creation_id') !== group.tuple.creationId || get('created_at') !== group.tuple.createdAt
      || get('origin_json') !== group.originalOriginJson
      || wire.creationId !== slot.targetCreationId || wire.createdAt !== group.tuple.createdAt
      || installed.fields.creation_id !== wire.creationId || installed.fields.created_at !== wire.createdAt
      || typeof installed.fields.origin_json !== 'string' || !same(JSON.parse(installed.fields.origin_json), wire.origin)
      || installed.row.sourceRef.side !== 'source' || !same(installed.row.sourceRef, originalRef))
      return invalid('a qualified source group does not match its installed allocation')
    claimed.add(slot.targetId)
    if (installed.row.replaces !== null || currentTable.byId(slot.targetId)) continue
    const sourceWire = { kind: 'synced-group' as const, id: sourceSnapshot.groupId, creationId: sourceSnapshot.creationId,
      createdAt: sourceSnapshot.createdAt, origin: sourceSnapshot.origin, blocks: sourceSnapshot.blocks, bindings: sourceSnapshot.bindings }
    groups.push({ source: group.tuple, installed: { groupId: wire.id, creationId: wire.creationId, createdAt: wire.createdAt, origin: wire.origin },
      wire, sourceWire })
  }
  return { catalogId, values: groups }
}

/** A matched group is a possible subject of a separate dependency and deletion proof. */
export async function readV3SourceOwnedMissingGroups(edge: Edge, prior: readonly RestoreKnowledgePriorInstall[],
  reference: Reference3Value, sourceGroupIds: ReadonlySet<string>) {
  const originalArchives = prior.filter(handle => {
    const { sourceArchive } = readVerifiedRestoreKnowledgePriorInstall(handle)
    return sourceArchive.snapshotId === edge.predecessor.snapshotId && sourceArchive.inventoryHash === edge.predecessor.archiveHash
  })
  if (originalArchives.length !== 1) return []
  const current = new Map(reference.candidate.activeGroupWires.map(wire => [wire.id, wire]))
  const original = await readPriorV3SourceOwnedGroups(originalArchives[0], edge, current, sourceGroupIds)
  const missing = original.groups
  if (!missing.length) return []
  const wires = missing.flatMap(group => [group.wire, group.sourceWire])
  let historiesClear = original.historiesClear
  for (const handle of prior) {
    if (!historiesClear) break
    if (handle === originalArchives[0]) continue
    const installed = readVerifiedRestoreKnowledgePriorInstall(handle)
    historiesClear = await installed.withReferenceOriginalRows(projectHistoricalOriginals, async originals => {
      if (!hasNoV3RetirementHistoricalReferences(originals.source, wires)
        || !hasNoV3RetirementHistoricalReferences(originals.current, wires)) return false
      await originals.assertPlanManifests()
      return true
    })
  }
  return missing.map(group => ({ groupId: group.installed.groupId, createdAt: group.installed.createdAt,
      sourceGroupId: group.source.groupId, sourceCreationId: group.source.creationId, sourceSnapshotId: edge.predecessor.snapshotId,
      noHistoricalReferences: historiesClear, wire: group.wire, sourceWire: group.sourceWire }))
}
