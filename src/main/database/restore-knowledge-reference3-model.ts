import { createHmac } from 'node:crypto'
import type { SyncedBindingKey, SyncedLinkTarget, SyncedOriginV1 } from '../../shared/synced-blocks'
import { validateSyncedOrigin } from '../../shared/syncedBlockValidation'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_RAW_MAX_ROWS } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Key, graph3Rows, graph3Text, type Graph3Inputs } from './restore-knowledge-graph3-data'
import type { Identity3Assignment } from './restore-knowledge-identity3-model'
import { assertMerge3JsonBudget } from './restore-knowledge-merge3-storage'
import { knowledgeGroupComparisonKey, knowledgeHash, type KnowledgeCapturedBinding, type KnowledgeGroup, type KnowledgeRowRef } from './restore-knowledge-payload-model'
import { deriveRootRestoreProvenanceSources3 } from './restore-knowledge-provenance3-model'

export interface Reference3Kernel {
  readonly kind: 'root-restore-reference-kernel'
  readonly version: 1
  readonly policyVersion: 1
  readonly purposeVersion: 1
  readonly seed: string
  readonly preparedAt: string
}
export interface Reference3Choices {
  /** Only exact, already-existing current tuples may keep that namespace.
   * This is not a source document-birth proof. */
  readonly originPolicy: 'isolate-incoming' | 'preserve-exact-current-tuple'
  readonly anonymousValues: 'source' | 'current' | 'unresolved'
}
export type Reference3Side = 'source' | 'current'
export type Reference3Assignment = Omit<Identity3Assignment, 'reason'> & {
  readonly baseReason: Identity3Assignment['reason']
  reason: 'base-preserved' | 'origin-relocation-group-fork' | 'origin-relocation-canonical-fork'
    | 'origin-relocation-instance-fork' | 'complete-source-group-instance-fork'
}
export interface Reference3Purpose {
  readonly key: string
  readonly family: 'origin-document' | 'origin-first-instance' | 'binding-document' | 'binding-heading-document'
    | 'binding-block' | 'physical-group' | 'creation' | 'canonical-child' | 'host-instance' | 'execution-guard' | 'current-existing-missing-block'
  readonly namespace: 'document' | 'block' | 'group' | 'creation' | 'guard'
  readonly side: Reference3Side
  readonly sourceGroupId: string | null
  readonly sourceGroupSource: KnowledgeRowRef | null
  readonly comparisonKey: string | null
  readonly field: string
  readonly bindingKey: SyncedBindingKey | null
  readonly sourceId: string | null
  readonly targetId: string
  readonly knownBirth: null
  readonly proofKind: 'qualified-missing' | 'fresh-copy' | 'fresh-guard' | 'current-domain-denial'
  readonly supports: readonly KnowledgeRowRef[]
}
export interface Reference3ReservationRow {
  readonly id: string
  readonly last_owner_kind: 'reserved'
  readonly last_owner_id: string
  readonly state: 'retained'
  readonly created_at: null
  readonly purposeKey: string
  readonly derivedPurpose: true
}
export interface Reference3Origin {
  readonly side: Reference3Side
  readonly sourceGroupId: string
  readonly sourceGroupSource: KnowledgeRowRef
  readonly comparisonKey: string
  readonly targetGroupId: string
  readonly targetCreationId: string
  readonly originalOriginJson: string
  readonly originalOrigin: SyncedOriginV1
  readonly origin: SyncedOriginV1
  readonly originPolicy: 'retained-current' | 'remapped-source'
  readonly active: boolean
  readonly absencePreserved: boolean
  readonly documentProof: 'current-domain-preserved' | 'qualified-missing' | 'inactive-not-materialized'
  readonly firstInstanceProof: 'current-domain-preserved' | 'proved-historical-birth' | 'qualified-missing' | 'inactive-not-materialized'
  readonly firstInstanceSupports: readonly KnowledgeRowRef[]
  readonly firstInstanceKnownBirth: string | null
  /** Original proof is retained even if it cannot be projected into a target
   * retained/physical slot without another materialization mechanism. */
  readonly originalFirstInstanceKnownBirth: string | null
}
export interface Reference3BindingTarget {
  readonly side: Reference3Side
  readonly sourceGroupId: string
  readonly sourceGroupSource: KnowledgeRowRef
  readonly comparisonKey: string
  readonly key: SyncedBindingKey
  readonly originalTarget: SyncedLinkTarget
  readonly target: SyncedLinkTarget
  readonly proofKind: 'current-domain-preserved' | 'unresolved-url-preserved' | 'qualified-missing' | 'inactive-not-materialized'
  readonly originalHint: string | null
  readonly sourceCapture: KnowledgeCapturedBinding
  readonly occurrence: number
}
export interface Reference3LifecycleIntent {
  readonly sourceGroupId: string
  readonly sourceGroupSource: KnowledgeRowRef
  readonly targetGroupId: string
  readonly targetCreationId: string
  readonly mode: 'new-import-materialization' | 'existing-current-awaits-final-cut'
  readonly state: 'active'
  readonly exposure: 'unknown'
  readonly createHistoryId: null
  readonly activationRevision: string
  readonly activationTopologyRevision: string
  readonly activationHashRequiredFromFinalWire: true
  readonly activationInstancesRequireFinalClosure: true
  readonly originalLifecycleRetainedInK: true
  readonly actualSqlRowReady: false
}
export type Reference3Execution = Omit<Graph3Inputs['value']['execution'], 'groups'> & {
  readonly scope: 'source-physical-remap'
  readonly groups: readonly (Graph3Inputs['value']['execution']['groups'][number] & { readonly sourceActive: boolean })[]
  /** Makes all independent reservations exclusions for the existing database3
   * allocator, which conservatively scans execution UUIDs in this same run. */
  readonly referenceReservations: readonly { readonly purposeKey: string; readonly targetId: string }[]
  readonly finalCurrentRetainedCutComplete: false
}
export interface Reference3Allocation {
  readonly kind: 'root-restore-reference-allocation'
  readonly version: 1
  readonly policyVersion: 1
  readonly purposeVersion: 1
  readonly choices: Reference3Choices
  readonly referenceKernelHash: string
  readonly baseIdentityAllocationHash: string
  readonly provenanceSourceHash: string
  readonly sourceWitness: Graph3Inputs['value']['sourceWitness']
  readonly sourcePayload: string
  readonly currentWitness: Graph3Inputs['value']['sourceWitness']
  readonly currentPayload: string
  readonly conservationHash: string
  readonly sourceMaterialHash: string
  readonly currentMaterialHash: string
  readonly sourceCatalogId: string
  readonly targetCatalogId: string
  readonly assignments: readonly Reference3Assignment[]
  readonly execution: Reference3Execution
  readonly origins: readonly Reference3Origin[]
  readonly bindingTargets: readonly Reference3BindingTarget[]
  readonly purposes: readonly Reference3Purpose[]
  readonly forcedGroupForks: readonly { readonly sourceGroupId: string; readonly sourceGroupSource: KnowledgeRowRef;
    readonly comparisonKey: string; readonly targetGroupId: string; readonly targetCreationId: string;
    readonly reason: 'origin-historical-document-birth-unavailable' }[]
  readonly materialization: { readonly reservationRows: readonly Reference3ReservationRow[];
    readonly lifecycleIntents: readonly Reference3LifecycleIntent[]; readonly sqlApplied: false }
  readonly sourceReferencesAllocated: true
  readonly bindingsHistoricalBirthProofComplete: false
  readonly sourceHistoryReplayed: false
  readonly finalCurrentRetainedCutComplete: false
  readonly referenceRewriteComplete: false
  readonly semanticValidationComplete: false
  readonly acceptedCoverage: false
  readonly effective: false
  readonly permit: false
  readonly derivedReferenceAllocationHash: string
}
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const fail = (code: string, detail: unknown): never => graph3Conflict('reference3-' + code, detail)
const text = (value: unknown): string => typeof value === 'string' ? value : fail('expected-text', typeof value)
const uuidPattern = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi
const allocationDomain = 'knowbook.restore.reference3.allocation.v1'
const purposeDomain = 'knowbook.restore.reference3.purpose.v1'

export function normalizeReference3Choices(input?: Reference3Choices): Reference3Choices {
  const raw = input === undefined ? { originPolicy: 'isolate-incoming', anonymousValues: 'unresolved' }
    : capsuleRecord(input, ['originPolicy','anonymousValues'])
  if (raw.originPolicy !== 'isolate-incoming' && raw.originPolicy !== 'preserve-exact-current-tuple')
    return fail('unsupported-origin-policy', raw.originPolicy)
  if (raw.anonymousValues !== 'source' && raw.anonymousValues !== 'current' && raw.anonymousValues !== 'unresolved')
    return fail('unsupported-anonymous-value-choice', raw.anonymousValues)
  return Object.freeze({ originPolicy: raw.originPolicy, anonymousValues: raw.anonymousValues })
}
export function validateReference3Kernel(input: Reference3Kernel): Reference3Kernel {
  const raw = capsuleRecord(input, ['kind','version','policyVersion','purposeVersion','seed','preparedAt'])
  if (raw.kind !== 'root-restore-reference-kernel' || raw.version !== 1 || raw.policyVersion !== 1 || raw.purposeVersion !== 1
    || typeof raw.seed !== 'string' || !/^[0-9a-f]{64}$/.test(raw.seed) || typeof raw.preparedAt !== 'string'
    || !Number.isFinite(Date.parse(raw.preparedAt)) || new Date(raw.preparedAt).toISOString() !== raw.preparedAt)
    return fail('unsupported-or-invalid-kernel', null)
  return Object.freeze(raw as unknown as Reference3Kernel)
}
function bindingKey(binding: SyncedBindingKey): SyncedBindingKey {
  return { blockId: binding.blockId, from: binding.from, to: binding.to, raw: binding.raw, syntax: binding.syntax }
}

/** Pure planning only. Unknown reference demands live in their own qualified
 * purposes, never in identity3 facts/occupancy. Only real source physical
 * assignments may change; all old incarnation/birth facts remain evidence. */
export function deriveRootRestoreReferenceAllocation3(data: Graph3Inputs, inputKernel: Reference3Kernel,
  inputChoices?: Reference3Choices): Reference3Allocation {
  const kernel = validateReference3Kernel(inputKernel), choices = normalizeReference3Choices(inputChoices)
  const provenance = deriveRootRestoreProvenanceSources3(data)
  const roots = (side: Reference3Side) => {
    const rows = data.inputs.knowledge.constraints.payloads.filter(p => !p.witness.domain.length && p.witness.side === side)
    if (rows.length !== 1 || rows[0].input.knowledge.sourceMaterialHash !== data.inputs[side].materialHash)
      return fail('root-witness-material', side)
    return rows[0]
  }
  const sourcePayload = roots('source'), currentPayload = roots('current')
  const source = data.inputs.source.knowledge, current = data.inputs.current.knowledge
  const sourcePhysical = new Map(data.inputs.source.source.physical.groups.map(g => [g.groupId, g]))
  const currentPhysical = new Map(data.inputs.current.source.physical.groups.map(g => [g.groupId, g]))
  const sources = new Map(source.groups.map(g => [g.tuple.groupId, g]))
  const currents = new Map(current.groups.map(g => [g.tuple.groupId, g]))
  const originalHeaders = new Map<Reference3Side, Map<string, Record<string, unknown>>>()
  for (const side of ['source', 'current'] as const) {
    const content = data.inputs[side].source.sourceContent
    const rawTable = content.tables.find(t => t.name === 'synced_groups') ?? fail('missing-raw-header-table', side)
    const rows = graph3Rows(content, 'synced_groups'), rawById = new Map(rows.map(r => [text(r.value.id), r]))
    const indexed = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const id = text(row.value.id)
      if (indexed.has(id)) return fail('duplicate-original-header', { side, id })
      indexed.set(id, row.value)
    }
    const knowledge = data.inputs[side].knowledge
    const evidenceTable = knowledge.originals.find(t => t.table === 'synced_groups') ?? fail('missing-header-evidence-table', side)
    const evidence = new Map(evidenceTable.rows.map(r => [graph3Key({ table: r.table, key: r.key, occurrence: r.occurrence, rowHash: r.rowHash }), r]))
    if (evidence.size !== evidenceTable.rows.length || evidenceTable.rows.length !== rows.length || knowledge.encoding !== content.encoding
      || evidenceTable.fullColumnsHash !== capsuleBytesHash(capsuleJson(rawTable.columns))) return fail('complete-header-evidence-shape', side)
    for (const group of knowledge.groups) {
      const row = indexed.get(group.tuple.groupId), actual = rawById.get(group.tuple.groupId), original = evidence.get(graph3Key(group.source))
      if (!row || row.creation_id !== group.tuple.creationId || row.created_at !== group.tuple.createdAt
        || row.origin_json !== group.originalOriginJson || knowledgeGroupComparisonKey(group.tuple) !== group.comparisonKey
        || !same(validateSyncedOrigin(JSON.parse(text(row.origin_json))), group.tuple.origin))
        return fail('original-group-tuple', { side, source: group.source })
      if (!actual || !original || group.source.table !== 'synced_groups' || group.source.occurrence !== 0
        || !same(group.source.key, rawTable.primaryKey.map(column => actual.original.cells[rawTable.columns.indexOf(column)]))
        || group.source.rowHash !== knowledgeHash('knowbook.knowledge.sql-row.v1', { encoding: content.encoding,
          table: 'synced_groups', columns: rawTable.columns, cells: actual.original.cells })
        || !same(original.cells, evidenceTable.columns.map(column => actual.original.cells[rawTable.columns.indexOf(column)])))
        return fail('complete-header-evidence-row', { side, source: group.source })
    }
    if (indexed.size !== knowledge.groups.length) return fail('original-group-header-closure', side)
    originalHeaders.set(side, indexed)
    const physical = side === 'source' ? sourcePhysical : currentPhysical
    if (physical.size !== indexed.size) return fail('physical-group-header-closure', side)
    for (const group of knowledge.groups) {
      const fact = physical.get(group.tuple.groupId)
      if (!fact || (fact.snapshot !== null) !== (fact.absence === null)) return fail('physical-group-activity', { side, source: group.source })
    }
  }
  const used = new Set<string>(), retainedTimes = new Set<string>()
  const retainId = (value: string) => { used.add(value); for (const m of value.matchAll(uuidPattern)) used.add(m[0].toLowerCase()) }
  let newestDocument = Math.max(Date.parse(kernel.preparedAt), Date.parse(data.value.execution.documentUpdatedAt))
  const scan = (value: string) => {
    for (const match of value.matchAll(uuidPattern)) used.add(match[0].toLowerCase())
    for (const match of value.matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g)) retainedTimes.add(match[0])
  }
  for (const payload of data.inputs.knowledge.constraints.payloads) {
    const projection = payload.input.knowledge.projection
    for (const item of projection.occupancy) retainId(item.id)
    for (const table of projection.originals) for (const row of table.rows) for (let i = 0; i < row.cells.length; i++) {
      const cell = row.cells[i]
      if (cell[0] !== 'text') continue
      const value = graph3Text(cell, projection.encoding); scan(value)
      if (table.table === 'documents' && table.columns[i] === 'updated_at' && Number.isFinite(Date.parse(value)))
        newestDocument = Math.max(newestDocument, Date.parse(value))
    }
  }
  for (const side of ['source', 'current'] as const) {
    const content = data.inputs[side].source.sourceContent
    for (const table of content.tables) for (const row of table.rows) for (const cell of row.cells)
      if (cell[0] === 'text') scan(graph3Text(cell, content.encoding))
  }
  for (const assignment of data.value.assignments) { retainId(assignment.targetId); if (assignment.targetCreationId) retainId(assignment.targetCreationId) }
  scan(capsuleJson(data.value.execution))
  const purposes: Reference3Purpose[] = [], purposeByKey = new Map<string, Reference3Purpose>(), purposeByTarget = new Map<string, Reference3Purpose>()
  let purposeBytes = 0
  function allocate(family: Reference3Purpose['family'], namespace: Reference3Purpose['namespace'], group: KnowledgeGroup | null,
    field: string, sourceId: string | null, key: SyncedBindingKey | null, proofKind: Reference3Purpose['proofKind'],
    supports: readonly KnowledgeRowRef[] = []): string {
    const parts = [purposeDomain, sourcePayload.witness, sourcePayload.key, data.inputs.source.materialHash,
      group?.source ?? null, group?.comparisonKey ?? null, family, field, key, sourceId]
    assertMerge3JsonBudget(parts)
    const purposeKey = graph3Key(...parts)
    if (purposeByKey.has(purposeKey)) return fail('duplicate-qualified-purpose', purposeKey)
    let targetId: string | null = null
    for (let attempt = 0; attempt < 64; attempt++) {
      const bytes = createHmac('sha256', Buffer.from(kernel.seed, 'hex')).update(graph3Key('knowbook.restore.reference3.uuid.v1',
        data.value.allocationHash, choices, purposeKey, attempt)).digest().subarray(0, 16)
      bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128
      const hex = bytes.toString('hex'), candidate = [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')
      if (used.has(candidate)) continue
      used.add(candidate); targetId = candidate; break
    }
    if (!targetId) return fail('finite-purpose-collision-budget', purposeKey)
    const purpose: Reference3Purpose = { key: purposeKey, family, namespace, side: 'source', sourceGroupId: group?.tuple.groupId ?? null,
      sourceGroupSource: group?.source ?? null, comparisonKey: group?.comparisonKey ?? null, field, bindingKey: key,
      sourceId, targetId, knownBirth: null, proofKind, supports }
    assertMerge3JsonBudget(purpose)
    purposeBytes += Buffer.byteLength(capsuleJson(purpose))
    if (purposeBytes > CAPSULE2_RAW_MAX_JSON_BYTES)
      return fail('purpose-output-budget', null)
    purposes.push(purpose); purposeByKey.set(purposeKey, purpose); purposeByTarget.set(targetId, purpose)
    return targetId
  }
  const assignments = data.value.assignments.map<Reference3Assignment>(a => ({ ...a, baseReason: a.reason, reason: 'base-preserved' }))
  const physicalSlots = new Map<string, Reference3Assignment[]>()
  for (const a of assignments) if (a.physical) {
    const key = graph3Key(a.kind, a.sourceId), rows = physicalSlots.get(key) ?? []
    rows.push(a); physicalSlots.set(key, rows)
  }
  const groupSlot = (group: KnowledgeGroup) => {
    const rows = (physicalSlots.get(graph3Key('group', group.tuple.groupId)) ?? []).filter(a => !a.ambiguous
      && a.birth === group.tuple.createdAt && a.incarnation === group.comparisonKey && a.targetCreationId !== null)
    return rows.length === 1 ? rows[0] : fail('physical-group-assignment', group.source)
  }
  const retainedOriginGroups = new Set<string>(), forkedGroups = new Set<string>(), originForkedGroups = new Set<string>()
  const forcedGroupForks: Array<Reference3Allocation['forcedGroupForks'][number]> = []
  for (const group of source.groups) {
    const physical = sourcePhysical.get(group.tuple.groupId)
    if (!physical || (physical.snapshot !== null) !== (physical.absence === null)) return fail('source-activity-closure', group.source)
    const slot = groupSlot(group)
    if (!physical.snapshot) continue // Inactive source stays absent, never fresh-copied from a retirement wire.
    const old = currents.get(slot.targetId), oldPhysical = currentPhysical.get(slot.targetId)
    const keepExisting = choices.originPolicy === 'preserve-exact-current-tuple' && !!old && old.comparisonKey === group.comparisonKey
      && !!oldPhysical?.snapshot && slot.targetCreationId === old.tuple.creationId
    if (keepExisting) retainedOriginGroups.add(group.tuple.groupId)
    else {
      slot.targetId = allocate('physical-group', 'group', group, 'physical-group', group.tuple.groupId, null, 'fresh-copy', [group.source])
      slot.targetCreationId = allocate('creation', 'creation', group, 'creation', group.tuple.creationId, null, 'fresh-copy', [group.source])
      slot.reason = 'origin-relocation-group-fork'; slot.requiresExplicitForkDecision = true
      originForkedGroups.add(group.tuple.groupId)
      forcedGroupForks.push({ sourceGroupId: group.tuple.groupId, sourceGroupSource: group.source, comparisonKey: group.comparisonKey,
        targetGroupId: slot.targetId, targetCreationId: slot.targetCreationId, reason: 'origin-historical-document-birth-unavailable' })
    }
    if (slot.targetId !== group.tuple.groupId || slot.targetCreationId !== group.tuple.creationId) forkedGroups.add(group.tuple.groupId)
  }
  const instanceGroups = new Map(source.instances.map(i => [i.instanceId, i.groupId]))
  for (const slot of assignments) {
    if (!slot.physical || slot.kind !== 'block') continue
    if (slot.ownerKind === 'group' && slot.ownerId !== null && forkedGroups.has(slot.ownerId)) {
      const group = sources.get(slot.ownerId) ?? fail('canonical-owner-group', slot.key)
      slot.targetId = allocate('canonical-child', 'block', group, 'canonical-child:' + slot.key, slot.sourceId, null, 'fresh-copy', [group.source])
      slot.reason = 'origin-relocation-canonical-fork'
    }
    const instanceGroup = instanceGroups.get(slot.sourceId)
    if (instanceGroup && forkedGroups.has(instanceGroup)) {
      const group = sources.get(instanceGroup) ?? fail('instance-owner-group', slot.key)
      if (slot.ownerKind !== 'document') return fail('instance-is-not-host-block', slot.key)
      slot.targetId = allocate('host-instance', 'block', group, 'host-instance:' + slot.key, slot.sourceId, null, 'fresh-copy', [group.source])
      slot.reason = originForkedGroups.has(instanceGroup)
        ? 'origin-relocation-instance-fork' : 'complete-source-group-instance-fork'
    }
  }
  const mappedPhysical = (kind: 'document' | 'block', id: string) => {
    const rows = (physicalSlots.get(graph3Key(kind, id)) ?? []).filter(a => !a.ambiguous)
    return rows.length === 1 ? rows[0] : fail('physical-source-target', { kind, id })
  }
  // Detect invalid duplicate targets; shared block/instance roles are one slot.
  const physicalTargets = new Set<string>()
  for (const slot of assignments) if (slot.physical) {
    const key = graph3Key(slot.kind, slot.targetId)
    if (physicalTargets.has(key)) return fail('duplicate-effective-physical-target', key)
    physicalTargets.add(key)
  }
  const reservations: Reference3ReservationRow[] = []
  const reservationIds = new Set<string>()
  const keepReservation = (purpose: Reference3Purpose) => {
    if (reservationIds.has(purpose.targetId)) return fail('duplicate-reservation-row', purpose.targetId)
    if (reservations.length >= CAPSULE2_RAW_MAX_ROWS) return fail('reservation-row-budget', null)
    reservationIds.add(purpose.targetId)
    reservations.push({ id: purpose.targetId, last_owner_kind: 'reserved', last_owner_id: 'knowbook.restore.reference3.reservation.v1.' + capsuleBytesHash(purpose.key),
      state: 'retained', created_at: null, purposeKey: purpose.key, derivedPurpose: true })
  }
  const reserve = (id: string) => {
    const purpose = purposeByTarget.get(id)
    if (!purpose || purpose.namespace !== 'block' || purpose.proofKind !== 'qualified-missing') return fail('reservation-purpose', id)
    keepReservation(purpose)
  }
  const origins: Reference3Origin[] = []
  const originProofs = new Map(provenance.origins.map(p => [graph3Key(p.groupSource, p.comparisonKey), p]))
  const assignmentsByBlock = new Map<string, Reference3Assignment[]>()
  for (const assignment of assignments) if (assignment.kind === 'block') {
    const rows = assignmentsByBlock.get(assignment.sourceId) ?? []; rows.push(assignment); assignmentsByBlock.set(assignment.sourceId, rows)
  }
  const currentIdentities = new Map(current.identities.map(identity => [identity.id, identity]))
  for (const side of ['source', 'current'] as const) for (const group of data.inputs[side].knowledge.groups) {
    const active = (side === 'source' ? sourcePhysical : currentPhysical).get(group.tuple.groupId)?.snapshot !== null
    const sourceGroupId = group.tuple.groupId, slot = side === 'source' ? groupSlot(group) : null
    const targetGroupId = slot?.targetId ?? sourceGroupId, targetCreationId = slot?.targetCreationId ?? group.tuple.creationId
    if (!targetCreationId) return fail('missing-target-creation', group.source)
    let origin = group.tuple.origin, documentProof: Reference3Origin['documentProof'] = 'current-domain-preserved'
    let firstInstanceProof: Reference3Origin['firstInstanceProof'] = 'current-domain-preserved'
    let firstInstanceKnownBirth: string | null = null, originalFirstInstanceKnownBirth: string | null = null
    let firstInstanceSupports: readonly KnowledgeRowRef[] = []
    const retained = side === 'current' || retainedOriginGroups.has(sourceGroupId)
    if (side === 'source' && !active) {
      documentProof = 'inactive-not-materialized'; firstInstanceProof = 'inactive-not-materialized'
    } else if (!retained) {
      const proof = originProofs.get(graph3Key(group.source, group.comparisonKey)) ?? fail('missing-source-origin-proof', group.source)
      const documentId = allocate('origin-document', 'document', group, 'origin.documentId', origin.documentId, null, 'qualified-missing', proof.document.supports)
      let firstInstanceId: string | null = null
      firstInstanceSupports = proof.firstInstance.supports
      originalFirstInstanceKnownBirth = proof.firstInstance.knownBirth
      if (proof.firstInstance.status === 'proved-birth' && proof.firstInstance.knownBirth !== null) {
        // The independent historical proof selects an exact existing allocation
        // fact. A unique knownBirth or an assignment's physical flag is not proof.
        const candidates = (assignmentsByBlock.get(origin.firstInstanceId) ?? []).filter(a => !a.ambiguous
          && a.birth === proof.firstInstance.knownBirth && (a.physical || currentIdentities.get(a.targetId)?.createdAt === proof.firstInstance.knownBirth)
          && a.facts.some(index => {
            const fact = source.occupancy[index]
            return !!fact && (fact.namespace === 'block' || fact.namespace === 'instance') && fact.id === a.sourceId
              && fact.knownBirth === proof.firstInstance.knownBirth && (fact.kind === 'physical' || fact.kind === 'ledger')
          }))
        if (candidates.length === 1) {
          firstInstanceId = candidates[0].targetId; firstInstanceProof = 'proved-historical-birth'
          firstInstanceKnownBirth = proof.firstInstance.knownBirth
        }
      }
      if (firstInstanceId === null) {
        firstInstanceId = allocate('origin-first-instance', 'block', group, 'origin.firstInstanceId', origin.firstInstanceId,
          null, 'qualified-missing', proof.firstInstance.supports)
        reserve(firstInstanceId); firstInstanceProof = 'qualified-missing'
      }
      origin = { version: 1, documentId, pathAtCreation: origin.pathAtCreation, firstInstanceId }
      documentProof = 'qualified-missing'
    }
    origins.push({ side, sourceGroupId, sourceGroupSource: group.source, comparisonKey: group.comparisonKey, targetGroupId, targetCreationId,
      originalOriginJson: group.originalOriginJson, originalOrigin: group.tuple.origin, origin,
      originPolicy: retained ? 'retained-current' : 'remapped-source', active, absencePreserved: !active,
      documentProof, firstInstanceProof, firstInstanceSupports, firstInstanceKnownBirth, originalFirstInstanceKnownBirth })
  }
  const bindingTargets: Reference3BindingTarget[] = []
  for (const side of ['source', 'current'] as const) {
    const knowledge = data.inputs[side].knowledge
    const captures = new Map<string, Array<{ capture: KnowledgeCapturedBinding; occurrence: number }>>()
    for (let occurrence = 0; occurrence < knowledge.bindings.length; occurrence++) {
      const capture = knowledge.bindings[occurrence]
      if (capture.provenance !== 'current-stored') continue
      const key = graph3Key(capture.source), rows = captures.get(key) ?? []
      rows.push({ capture, occurrence }); captures.set(key, rows)
    }
    for (const group of knowledge.groups) {
      const entries = captures.get(graph3Key(group.source)) ?? []
      const raw = originalHeaders.get(side)!.get(group.tuple.groupId)!
      if (!same(entries.map(e => e.capture.binding), JSON.parse(text(raw.bindings_json)))) return fail('stored-capture-exact-row-closure', { side, source: group.source })
      const active = (side === 'source' ? sourcePhysical : currentPhysical).get(group.tuple.groupId)?.snapshot !== null
      for (const { capture, occurrence } of entries) {
        const key = bindingKey(capture.binding), originalTarget = capture.binding.target
        let target = originalTarget, proofKind: Reference3BindingTarget['proofKind'] = side === 'current'
          ? 'current-domain-preserved' : !active ? 'inactive-not-materialized' : 'qualified-missing'
        const originalHint = originalTarget.kind === 'block' ? originalTarget.documentId : null
        if (side === 'source' && active) {
          if (originalTarget.kind === 'unresolved-url') proofKind = 'unresolved-url-preserved'
          else if (originalTarget.kind === 'document') target = { kind: 'document', state: 'missing',
            id: allocate('binding-document', 'document', group, 'binding.target', originalTarget.id, key, 'qualified-missing', [capture.source]) }
          else if (originalTarget.kind === 'heading') target = { kind: 'heading', slug: originalTarget.slug, state: 'missing',
            documentId: allocate('binding-heading-document', 'document', group, 'binding.target.documentId', originalTarget.documentId, key, 'qualified-missing', [capture.source]) }
          else {
            const id = allocate('binding-block', 'block', group, 'binding.target', originalTarget.id, key, 'qualified-missing', [capture.source])
            // documentId is an old hint, not capture-time owner proof. Keep the
            // original hint in evidence; never leak the source UUID into current.
            target = { kind: 'block', id, documentId: null, state: 'missing' }; reserve(id)
          }
        }
        bindingTargets.push({ side, sourceGroupId: group.tuple.groupId, sourceGroupSource: group.source, comparisonKey: group.comparisonKey,
          key, originalTarget, target, proofKind, originalHint, sourceCapture: capture, occurrence })
      }
      captures.delete(graph3Key(group.source))
    }
    if (captures.size) return fail('unowned-current-stored-capture', side)
  }
  // Keeping a native current Origin may require a denial-only ledger row even
  // though the core Origin shape validator does not demand it. This does NOT
  // rename the old ID or establish a historical birth. Shared references to
  // the same already-existing current-domain ID support ONE reserved SQL row.
  const currentPhysicalIds = new Set<string>()
  for (const name of ['blocks', 'synced_group_blocks'] as const)
    for (const row of graph3Rows(data.inputs.current.source.sourceContent, name)) currentPhysicalIds.add(text(row.value.id))
  const sourcePhysicalTargetIds = new Set(assignments.filter(a => a.kind === 'block' && a.physical).map(a => a.targetId))
  const currentMissingOrigins = new Map<string, KnowledgeRowRef[]>()
  for (const group of current.groups) {
    if (!currentPhysical.get(group.tuple.groupId)!.snapshot) continue
    const id = group.tuple.origin.firstInstanceId
    if (currentPhysicalIds.has(id) || currentIdentities.has(id)) continue
    if (sourcePhysicalTargetIds.has(id)) return fail('existing-current-missing-origin-would-become-physical', group.source)
    const supports = currentMissingOrigins.get(id) ?? []; supports.push(group.source); currentMissingOrigins.set(id, supports)
  }
  for (const [id, supports] of currentMissingOrigins) {
    supports.sort((a, b) => { const x = graph3Key(a), y = graph3Key(b); return x < y ? -1 : x > y ? 1 : 0 })
    const parts = [purposeDomain, currentPayload.witness, currentPayload.key, data.inputs.current.materialHash,
      'existing-current-block-domain', id, supports]
    assertMerge3JsonBudget(parts)
    const key = graph3Key(...parts)
    const purpose: Reference3Purpose = { key, family: 'current-existing-missing-block', namespace: 'block', side: 'current',
      sourceGroupId: null, sourceGroupSource: null, comparisonKey: null, field: 'current.existing-missing-origin-first-instance',
      bindingKey: null, sourceId: id, targetId: id, knownBirth: null, proofKind: 'current-domain-denial', supports }
    if (purposeByKey.has(key) || purposeByTarget.has(id)) return fail('duplicate-current-denial-purpose', key)
    assertMerge3JsonBudget(purpose)
    purposeBytes += Buffer.byteLength(capsuleJson(purpose))
    if (purposeBytes > CAPSULE2_RAW_MAX_JSON_BYTES) return fail('purpose-output-budget', null)
    purposes.push(purpose); purposeByKey.set(key, purpose); purposeByTarget.set(id, purpose); keepReservation(purpose)
  }
  if (!Number.isFinite(newestDocument) || newestDocument >= 8_640_000_000_000_000) return fail('finite-document-cas-time', null)
  let documentUpdatedAt = new Date(newestDocument + 1).toISOString()
  while (retainedTimes.has(documentUpdatedAt)) {
    newestDocument++
    if (newestDocument >= 8_640_000_000_000_000) return fail('finite-document-cas-time', null)
    documentUpdatedAt = new Date(newestDocument + 1).toISOString()
  }
  const freshGuard = (field: string, group: KnowledgeGroup | null = null) => allocate('execution-guard', 'guard', group, field, null, null, 'fresh-guard')
  const executionGroups = source.groups.map(group => ({ sourceGroupId: group.tuple.groupId, targetGroupId: groupSlot(group).targetId,
    physicalHeader: true, revision: freshGuard('revision', group), topologyRevision: freshGuard('topologyRevision', group),
    historyCursor: freshGuard('historyCursor', group), historyPosition: 0 as const, sourceLifecycle: group.lifecycle,
    sourceActive: sourcePhysical.get(group.tuple.groupId)!.snapshot !== null, activationAuthorized: false as const }))
  const instances = source.instances.map(instance => ({ sourceInstanceId: instance.instanceId,
    targetInstanceId: mappedPhysical('block', instance.instanceId).targetId, bindingVersion: freshGuard('instance.bindingVersion:' + instance.instanceId) }))
  const hosts = data.inputs.source.source.physical.documents.map(document => ({ sourceDocumentId: document.documentId,
    targetDocumentId: mappedPhysical('document', document.documentId).targetId, historyCursor: freshGuard('host.historyCursor:' + document.documentId), historyPosition: 0 as const }))
  const recoveryEpoch = freshGuard('workspace.recoveryEpoch')
  const execution: Reference3Execution = { scope: 'source-physical-remap', workspaceScope: data.value.execution.workspaceScope,
    recoveryEpoch, documentUpdatedAt, groups: executionGroups, instances, hosts,
    referenceReservations: purposes.map(p => ({ purposeKey: p.key, targetId: p.targetId })),
    sourceOperationsReplayAllowed: false, transactionCutStillRequired: true, finalCurrentRetainedCutComplete: false }
  const lifecycleIntents = executionGroups.filter(g => g.sourceActive).map<Reference3LifecycleIntent>(g => {
    const original = sources.get(g.sourceGroupId)!, slot = groupSlot(original)
    return { sourceGroupId: g.sourceGroupId, sourceGroupSource: original.source, targetGroupId: slot.targetId,
      targetCreationId: slot.targetCreationId!, mode: slot.targetId === original.tuple.groupId && slot.targetCreationId === original.tuple.creationId
        ? 'existing-current-awaits-final-cut' : 'new-import-materialization', state: 'active', exposure: 'unknown', createHistoryId: null,
      activationRevision: g.revision, activationTopologyRevision: g.topologyRevision,
      activationHashRequiredFromFinalWire: true, activationInstancesRequireFinalClosure: true,
      originalLifecycleRetainedInK: true, actualSqlRowReady: false }
  })
  const body = { kind: 'root-restore-reference-allocation' as const, version: 1 as const, policyVersion: 1 as const, purposeVersion: 1 as const,
    choices, referenceKernelHash: hash('knowbook.restore.reference3.kernel.v1', kernel), baseIdentityAllocationHash: data.value.allocationHash,
    provenanceSourceHash: provenance.provenanceSourceHash,
    sourceWitness: sourcePayload.witness, sourcePayload: sourcePayload.key, currentWitness: currentPayload.witness, currentPayload: currentPayload.key,
    conservationHash: data.inputs.knowledge.conservationHash, sourceMaterialHash: data.inputs.source.materialHash,
    currentMaterialHash: data.inputs.current.materialHash, sourceCatalogId: data.value.sourceCatalogId, targetCatalogId: data.value.targetCatalogId,
    assignments, execution, origins, bindingTargets, purposes, forcedGroupForks,
    materialization: { reservationRows: reservations, lifecycleIntents, sqlApplied: false as const }, sourceReferencesAllocated: true as const,
    bindingsHistoricalBirthProofComplete: false as const, sourceHistoryReplayed: false as const, finalCurrentRetainedCutComplete: false as const,
    referenceRewriteComplete: false as const, semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  assertMerge3JsonBudget(body)
  const value = { ...body, derivedReferenceAllocationHash: hash(allocationDomain, body) }
  assertMerge3JsonBudget(value)
  return freezeCapsuleValue(value)
}

/** Main-private pure compatibility view only. It retains genuine inputs and the
 * original base kernel, but its actual value.kind/version/hash are explicitly
 * the NEW allocation domain. This view cannot mint either Main owner. */
export function toReference3GraphInputs(data: Graph3Inputs, allocation: Reference3Allocation): Graph3Inputs {
  assertMerge3JsonBudget(allocation)
  const { derivedReferenceAllocationHash, ...body } = allocation
  if (allocation.kind !== 'root-restore-reference-allocation' || allocation.version !== 1
    || allocation.policyVersion !== 1 || allocation.purposeVersion !== 1 || hash(allocationDomain, body) !== derivedReferenceAllocationHash
    || allocation.baseIdentityAllocationHash !== data.value.allocationHash || allocation.conservationHash !== data.inputs.knowledge.conservationHash
    || allocation.sourceMaterialHash !== data.inputs.source.materialHash || allocation.currentMaterialHash !== data.inputs.current.materialHash)
    return fail('derived-view-binding', null)
  const originalByKey = new Map(data.value.assignments.map(a => [a.key, a]))
  if (allocation.assignments.length !== originalByKey.size) return fail('derived-view-assignment-closure', null)
  for (const assignment of allocation.assignments) {
    const original = originalByKey.get(assignment.key)
    if (!original) return fail('derived-view-unknown-base-slot', assignment.key)
    const { targetId: _target, targetCreationId: _creation, reason: _reason, requiresExplicitForkDecision: _fork, ...originalFacts } = original
    const { targetId: _newTarget, targetCreationId: _newCreation, reason: _newReason, baseReason: _baseReason,
      requiresExplicitForkDecision: _newFork, ...derivedFacts } = assignment
    if (!same(originalFacts, derivedFacts) || !original.physical && (assignment.targetId !== original.targetId || assignment.targetCreationId !== original.targetCreationId))
      return fail('derived-view-mutated-original-facts', assignment.key)
    originalByKey.delete(assignment.key)
  }
  if (originalByKey.size) return fail('derived-view-missing-base-slot', null)
  return Object.freeze({ inputs: data.inputs, kernel: data.kernel, value: Object.freeze({ ...data.value,
    kind: allocation.kind, version: allocation.version, assignments: allocation.assignments, execution: allocation.execution,
    baseIdentityAllocationHash: data.value.allocationHash, derivedReferenceAllocationHash,
    allocationHash: derivedReferenceAllocationHash }) }) as unknown as Graph3Inputs
}
