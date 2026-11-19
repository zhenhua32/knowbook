import { capsuleJson, freezeCapsuleValue } from '../database/restore-knowledge-capsule-model'
import { graph3Value } from '../database/restore-knowledge-graph3-data'
import { readVerifiedRestoreKnowledgePriorInstall, type RestoreKnowledgePriorInstall } from '../database/restore-knowledge-install-proof'
import { merge3RowValues, prepareMerge3Table } from '../database/restore-knowledge-merge3-storage'
import type { Reference3Value } from '../database/restore-knowledge-reference3-read'
import { hasNoV3RetirementHistoricalReferences } from './v3-restore-source-dependencies'

const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
const invalid = (condition: string): never => { throw new Error('Invalid installed V3 source group evidence: ' + condition) }

/** Recover ownership from the original source and current SQL rows of an actual installation. */
async function readPriorV3SourceOwnedGroups(handle: RestoreKnowledgePriorInstall) {
  const prior = readVerifiedRestoreKnowledgePriorInstall(handle)
  const reference = await prior.readReferenceInputs()
  const { allocation, candidate } = reference
  const { source, current } = reference.data.inputs
  const archive = source.assetArchive
  if (!candidate.candidateConflictFree || !candidate.finalForestValidated || candidate.pendingLocalBody)
    return invalid('the installed plan is outside the checked source-only scope')
  if (archive.version !== 6 || !same({ snapshotId: archive.backupV3.snapshotId, inventoryHash: archive.backupV3.inventoryHash }, prior.sourceArchive))
    return invalid('the source archive belongs to another installed plan')

  const sourceContent = source.source.sourceContent, currentContent = current.source.sourceContent
  const settings = sourceContent.tables.find(table => table.name === 'app_settings')
  if (!settings) return invalid('the original source catalog settings are missing')
  const keyColumn = settings.columns.indexOf('key'), valueColumn = settings.columns.indexOf('value')
  if (keyColumn < 0 || valueColumn < 0) return invalid('the original catalog settings are incomplete')
  const catalog = settings.rows.find(row => graph3Value(row.cells[keyColumn], sourceContent.encoding) === 'database.defaultId')
  const catalogId = catalog && graph3Value(catalog.cells[valueColumn], sourceContent.encoding)
  if (typeof catalogId !== 'string') return invalid('the original source catalog identity is missing')
  const sourceTable = sourceContent.tables.find(table => table.name === 'synced_groups')
  const currentTable = currentContent.tables.find(table => table.name === 'synced_groups')
  const installedTable = candidate.tables.find(table => table.name === 'synced_groups')
  if (!sourceTable || !currentTable || !installedTable) return invalid('an original or installed group table is missing')
  const originalGroups = prepareMerge3Table({ sourceOriginal: sourceTable, sourceCandidate: sourceTable,
    currentOriginal: currentTable, sourceEncoding: sourceContent.encoding, currentEncoding: currentContent.encoding,
    source: { payload: allocation.sourcePayload, witness: allocation.sourceWitness, materialHash: source.materialHash },
    current: { payload: allocation.currentPayload, witness: allocation.currentWitness, materialHash: current.materialHash }
  })
  const originalsById = new Map(originalGroups.sourceRows.map(row => {
    const fields = merge3RowValues(originalGroups, row)
    return [fields.id, { ref: row.ref, fields }] as const
  }))
  const currentIds = new Set(originalGroups.currentRows.map(row => merge3RowValues(originalGroups, row).id))
  const sourceGroupFacts = new Map(source.knowledge.groups.map(group => [group.tuple.groupId, group]))
  const sourceActive = new Map(source.source.physical.groups.flatMap(group => group.snapshot ? [[group.groupId, group.snapshot] as const] : []))
  const installedWires = new Map(candidate.activeGroupWires.map(wire => [wire.id, wire]))
  const installedIds = new Map(installedTable.rows.map(row => {
    const fields = Object.fromEntries(installedTable.columns.map((column, index) => [column, graph3Value(row.cells[index], installedTable.encoding)]))
    return [fields.id, { row, fields }] as const
  }))

  const groups = [], claimed = new Set<string>()
  for (const slot of allocation.assignments) {
    if (slot.kind !== 'group' || !slot.physical || slot.ambiguous) continue
    const sourceSnapshot = sourceActive.get(slot.sourceId)
    if (!sourceSnapshot) continue
    const group = sourceGroupFacts.get(slot.sourceId), original = originalsById.get(slot.sourceId)
    const installed = installedIds.get(slot.targetId), wire = installedWires.get(slot.targetId)
    if (!group || !original || !installed || !wire || slot.targetCreationId === null || claimed.has(slot.targetId)
      || group.tuple.createdAt !== slot.birth || group.comparisonKey !== slot.incarnation
      || original.fields.creation_id !== group.tuple.creationId || original.fields.created_at !== group.tuple.createdAt
      || original.fields.origin_json !== group.originalOriginJson
      || wire.creationId !== slot.targetCreationId || wire.createdAt !== group.tuple.createdAt
      || installed.fields.creation_id !== wire.creationId || installed.fields.created_at !== wire.createdAt
      || typeof installed.fields.origin_json !== 'string' || !same(JSON.parse(installed.fields.origin_json), wire.origin)
      || installed.row.sourceRef.side !== 'source' || !same(installed.row.sourceRef, original.ref))
      return invalid('a qualified source group does not match its installed allocation')
    claimed.add(slot.targetId)
    if (installed.row.replaces !== null || currentIds.has(slot.targetId)) continue
    const sourceWire = { kind: 'synced-group' as const, id: sourceSnapshot.groupId, creationId: sourceSnapshot.creationId,
      createdAt: sourceSnapshot.createdAt, origin: sourceSnapshot.origin, blocks: sourceSnapshot.blocks, bindings: sourceSnapshot.bindings }
    groups.push({ source: group.tuple, installed: { groupId: wire.id, creationId: wire.creationId, createdAt: wire.createdAt, origin: wire.origin },
      sourceRef: original.ref, wire, sourceWire })
  }
  await reference.assertPlanManifests()
  await prior.assertOriginalProof()
  return { sourceArchive: prior.sourceArchive, catalogId, groups: freezeCapsuleValue(groups), originals: { source, current } }
}

type Edge = { predecessor: { snapshotId: string; archiveHash: string; catalogId: string } }

/** A matched group is a possible subject of a separate dependency and deletion proof. */
export async function readV3SourceOwnedMissingGroups(edge: Edge, prior: readonly RestoreKnowledgePriorInstall[],
  reference: Reference3Value, sourceGroupIds: ReadonlySet<string>) {
  const originalArchives = prior.filter(handle => {
    const { sourceArchive } = readVerifiedRestoreKnowledgePriorInstall(handle)
    return sourceArchive.snapshotId === edge.predecessor.snapshotId && sourceArchive.inventoryHash === edge.predecessor.archiveHash
  })
  if (originalArchives.length !== 1) return []
  const original = await readPriorV3SourceOwnedGroups(originalArchives[0])
  if (original.catalogId !== edge.predecessor.catalogId) return []
  const current = new Map(reference.candidate.activeGroupWires.map(wire => [wire.id, wire]))
  const missing = original.groups.filter(group => !sourceGroupIds.has(group.source.groupId) && same(current.get(group.wire.id) ?? null, group.wire))
  if (!missing.length) return []
  const wires = missing.flatMap(group => [group.wire, group.sourceWire])
  const sourceWires = missing.map(group => group.sourceWire), installedWires = missing.map(group => group.wire)
  let historiesClear = hasNoV3RetirementHistoricalReferences(original.originals.source, sourceWires, new Set(sourceWires.map(group => group.id)))
    && hasNoV3RetirementHistoricalReferences(original.originals.current, installedWires, new Set(installedWires.map(group => group.id)))
  for (const handle of prior) {
    if (!historiesClear) break
    if (handle === originalArchives[0]) continue
    const { readReferenceInputs } = readVerifiedRestoreKnowledgePriorInstall(handle)
    const inputs = await readReferenceInputs()
    if (!hasNoV3RetirementHistoricalReferences(inputs.data.inputs.source, wires)
      || !hasNoV3RetirementHistoricalReferences(inputs.data.inputs.current, wires)) {
      historiesClear = false
      break
    }
    await inputs.assertPlanManifests()
  }
  return missing.map(group => ({ groupId: group.installed.groupId, createdAt: group.installed.createdAt,
      sourceGroupId: group.source.groupId, sourceCreationId: group.source.creationId, sourceSnapshotId: original.sourceArchive.snapshotId,
      noHistoricalReferences: historiesClear, wire: group.wire, sourceWire: group.sourceWire }))
}
