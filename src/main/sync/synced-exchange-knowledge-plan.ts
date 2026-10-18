import type { SyncedCanonicalWire, SyncedGroupWire, SyncedLinkTarget } from '../../shared/synced-blocks'
import { parseDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { parseSyncedBlockPayload, SyncedValidationError } from '../../shared/syncedBlockValidation'
import { validateBothSourceLinks } from './synced-exchange-both-model'
import { planSyncedBothFork } from './synced-exchange-fork'
import { planSyncedTombstoneExchange } from './synced-exchange-tombstone-plan'
import { deriveSyncedExchangeDependencyFacts } from './synced-exchange-plan'
import { mergeSyncedProtocol5Record, type SyncedRecordMergeChoice, type SyncedRecordMergeResult } from './synced-merge'
import { validateConflictPreviewComponent, type ConflictPreviewComponent, type ConflictPreviewRecord, type ExchangeMergeProvenance } from './synced-exchange-conflict-model'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson, SyncedPublicationError } from './synced-publication-model'
import { validateSyncedProtocol5Snapshot, validateSyncedProtocol5Record, type SyncedProtocol5Snapshot, type SyncedProtocol5Record } from './synced-protocol5-model'
import type { ExchangeComponent, ExchangeDeferredReason, ExchangeTransfer } from './synced-exchange-model'
import type { SyncedBothOwnerSourceLinks, SyncedBothForkProof, SyncedBothLinkProjection } from './synced-exchange-both-types'
import { knowledgeSourceHash, validateKnowledgeSource, validateKnowledgeComponentFence,
  type FixedDenial, type KnowledgeSource, type KnowledgeComponentFacts, type KnowledgeComponentFence, type KnowledgePlanInput,
  type KnowledgeConflictPlan, type KnowledgeForkPlan, type KnowledgeForkPlanInput, type KnowledgeLiveAcceptedSide } from './synced-exchange-knowledge-model'

type Entry = SyncedProtocol5Snapshot['records'][number]
type Entries = Map<string, Entry>
type Physical = { key: string; kind: 'document' | 'group'; ownerId: string; birth: string | null }
type Detail = KnowledgeComponentFacts & { defaults: Entries; merges: Map<string, SyncedRecordMergeResult>; hard: ExchangeDeferredReason | null }
const hash = (value: unknown): string => publicationHash(publicationJson(value))
const same = (left: unknown, right: unknown): boolean => publicationJson(left) === publicationJson(right)
const sort = (values: Iterable<string>): string[] => [...new Set(values)].sort(publicationCompare)
const index = (value: SyncedProtocol5Snapshot): Entries => new Map(value.records.map(row => [row.key, row]))
const isDeleted = (record: SyncedProtocol5Record): boolean => record.kind === 'deleted' || record.kind === 'synced-group-deleted'
const tuple = (record: SyncedGroupWire): string => publicationJson([record.id, record.creationId, record.createdAt, record.origin])
function snapshot(values: Entries, workspaceId: string): SyncedProtocol5Snapshot {
  const rows = [...values.values()].sort((a, b) => publicationCompare(a.key, b.key)), groups = new Map(rows.flatMap(row => row.record.kind === 'synced-group' ? [[row.record.id, row.hash] as const] : []))
  const syncedInstances: SyncedProtocol5Snapshot['manifest']['syncedInstances'] = []
  for (const { record } of rows) if (record.kind === 'document') for (const child of record.content.blocks) if (child.type === 'synced-block') {
    const groupId = parseSyncedBlockPayload(child.content).groupId, groupHash = groups.get(groupId)
    if (!groupHash) return publicationInvalid('knowledge候选live实例缺准确live组。')
    syncedInstances.push({ documentId: record.id, instanceId: child.id, groupId, groupHash })
  }
  syncedInstances.sort((a, b) => publicationCompare(a.documentId, b.documentId) || publicationCompare(a.instanceId, b.instanceId))
  return validateSyncedProtocol5Snapshot({ version: 5, workspaceId, entries: Object.fromEntries(rows.map(row => [row.key, row.hash])), syncedInstances }, rows.map(({ key, record }) => ({ key, record })))
}
const liveView = (values: Entries): Entries => new Map([...values].filter(([, row]) => !isDeleted(row.record)))
function physical(values: Entries): Map<string, Physical> {
  const result = new Map<string, Physical>()
  for (const { key, record } of values.values()) if (record.kind === 'document' || record.kind === 'synced-group') {
    for (const child of record.kind === 'document' ? record.content.blocks : record.blocks) {
      if (result.has(child.id)) return publicationInvalid('knowledge图物理身份重复。')
      result.set(child.id, { key, kind: record.kind === 'document' ? 'document' : 'group', ownerId: record.id,
        birth: record.kind === 'synced-group' ? (child as SyncedCanonicalWire).createdAt : null })
    }
  }
  return result
}
function pathsValid(values: Entries): boolean {
  const names = new Set<string>()
  for (const { record } of values.values()) if (record.kind === 'document') {
    const key = publicationJson([record.parentId, record.content.title.replace(/[A-Z]/g, value => value.toLowerCase())])
    if (record.content.title !== record.content.title.trim() || names.has(key)) return false
    names.add(key)
  }
  return true
}
function buildSource(input: KnowledgePlanInput): KnowledgeSource {
  const source = validateKnowledgeSource({ domain: 'synced-exchange.knowledge-selection.v1', databasePath: input.state.databasePath,
    targetFingerprint: input.state.targetFingerprint, workspaceScope: input.state.workspaceScope, recoveryEpoch: input.state.recoveryEpoch,
    sourceStateHash: hash(input.state), localPhysicalManifestHash: hash(input.localPhysical.manifest), localKnowledgeManifestHash: hash(input.localKnowledge.manifest),
    deleted: input.authority.deletionProofReferences, absentBaseline: input.state.baseline.filter(row => row.local.kind === 'absent') })
  const facts = new Map(input.authority.deletedFacts.map(row => [row.key, row])), knowledge = index(input.localKnowledge)
  if (source.deleted.length !== facts.size) return publicationInvalid('knowledge原proof refs不是全局事实闭集。')
  for (const ref of source.deleted) {
    const fact = facts.get(ref.key), record = knowledge.get(ref.key)
    if (!fact || !record || !isDeleted(record.record) || record.hash !== ref.tombstoneHash || fact.tombstoneHash !== ref.tombstoneHash
      || fact.deletionOperationId !== ref.deletionOperationId || fact.intentHash !== ref.intentHash) return publicationInvalid('knowledge原proof引用与实际denial知识不闭合。')
  }
  return source
}
function sourceTarget(target: SyncedLinkTarget, owners: Map<string, Physical>, identities: ReadonlyMap<string, KnowledgePlanInput['authority']['identities'][number]>): string | null {
  if (target.kind === 'document') return 'doc:' + target.id
  if (target.kind === 'heading') return 'doc:' + target.documentId
  if (target.kind !== 'block') return null
  const actual = owners.get(target.id)
  if (actual) return actual.key
  const identity = identities.get(target.id)
  return identity?.last_owner_kind === 'group' ? 'group:' + identity.last_owner_id : identity?.last_owner_kind === 'document' ? 'doc:' + identity.last_owner_id : null
}
function analyze(input: KnowledgePlanInput, sourceLinks: SyncedBothOwnerSourceLinks[]) {
  // The original strict planner validates every physical/knowledge/R/B source before a candidate-only failure can defer.
  const automatic = planSyncedTombstoneExchange(input), source = buildSource(input), local = index(input.localKnowledge), remote = index(input.remote), original = new Map(input.baseRecords.map(row => [row.key, row]))
  const baseline = new Map(input.state.baseline.map(row => [row.key, row])), refs = new Map(source.deleted.map(row => [row.key, row]))
  for (const row of baseline.values()) if (!original.has(row.key)) {
    const expected = row.commonHash ?? row.remoteHash, found = [local.get(row.key), remote.get(row.key)].find(value => value?.hash === expected)
    if (found) original.set(row.key, found)
  }
  const keys = sort([...local.keys(), ...remote.keys(), ...baseline.keys()]), graph = new Map(keys.map(key => [key, new Set<string>()]))
  const edge = (a: string, b: string): void => { if (a !== b && graph.has(a) && graph.has(b)) { graph.get(a)!.add(b); graph.get(b)!.add(a) } }
  for (const component of automatic.components) for (let i = 1; i < component.keys.length; i++) edge(component.keys[0], component.keys[i])
  const links = validateBothSourceLinks(sourceLinks), owners = physical(local), identityIndex = new Map(input.authority.identities.map(row => [row.id, row]))
  for (const owner of links) {
    if (local.get(owner.ownerKey)?.hash !== owner.recordHash || !owner.complete || isDeleted(local.get(owner.ownerKey)!.record)) return publicationInvalid('knowledge typed来源不属于当前真实live owner。')
    for (const item of owner.links) { const target = sourceTarget(item.target, owners, identityIndex); if (target) edge(owner.ownerKey, target) }
  }
  const parts: string[][] = [], seen = new Set<string>()
  for (const key of keys) if (!seen.has(key)) {
    const pending = [key]; seen.add(key)
    for (let i = 0; i < pending.length; i++) for (const neighbor of graph.get(pending[i])!) if (!seen.has(neighbor)) { seen.add(neighbor); pending.push(neighbor) }
    parts.push(pending.sort(publicationCompare))
  }
  const guards = new Map((input.authority.keyGuards ?? []).map(row => [row.key, row.fingerprint]))
  const automaticByKey = new Map(automatic.components.flatMap(row => row.keys.map(key => [key, row] as const))), linksByOwner = new Map(links.map(row => [row.ownerKey, row]))
  const details: Detail[] = []
  for (const part of parts) {
    const fixedDenials: FixedDenial[] = [], mutableKeys: string[] = [], records: ConflictPreviewRecord[] = [], conflictedKeys: string[] = [], defaults: Entries = new Map(), merges = new Map<string, SyncedRecordMergeResult>()
    let hard: ExchangeDeferredReason | null = part.some(key => input.authority.deferredKeys?.includes(key)) ? 'dependency' : null, reason: ExchangeDeferredReason | null = null
    for (const key of part) {
      const l = local.get(key), r = remote.get(key), b = baseline.get(key), old = original.get(key), ref = refs.get(key)
      if (l && isDeleted(l.record) && r?.hash === l.hash && b?.local.kind === 'absent' && ref
        && b.local.tombstoneHash === ref.tombstoneHash && b.local.deletionOperationId === ref.deletionOperationId && b.local.intentHash === ref.intentHash) {
        fixedDenials.push({ ...ref, baselineHash: hash(b) }); defaults.set(key, l)
        records.push({ key, baseHash: b.commonHash, localHash: l.hash, remoteHash: r.hash, merge: null }); continue
      }
      mutableKeys.push(key)
      if ([l, r, old].some(row => row && isDeleted(row.record)) || b?.local.kind === 'absent') hard ??= b ? 'tombstone' : 'baseline-missing'
      if (b && !l) hard ??= 'local-removal'
      if (b && !r) hard ??= 'tombstone'
      if (b && (!old || input.authority.missingBaseKeys?.includes(key)) && l?.hash !== r?.hash) hard ??= 'baseline-missing'
      const groups = [l, r, old].flatMap(row => row?.record.kind === 'synced-group' ? [row.record] : [])
      if (new Set(groups.map(tuple)).size > 1) hard ??= 'incarnation'
      const changedBoth = l && r && l.hash !== r.hash && !(b && (r.hash === b.remoteHash || b.local.kind === 'live' && l.hash === b.local.hash))
      let merged: SyncedRecordMergeResult | null = null
      if (changedBoth) {
        conflictedKeys.push(key)
        if (old && b?.commonHash === old.hash && !isDeleted(old.record) && !isDeleted(l.record) && !isDeleted(r.record)) merged = mergeSyncedProtocol5Record(old.record, l.record, r.record)
        if (merged) merges.set(key, merged)
      }
      records.push({ key, baseHash: b?.commonHash ?? null, localHash: l?.hash ?? null, remoteHash: r?.hash ?? null,
        merge: merged ? { conflicts: merged.conflicts, unresolved: merged.unresolved, resultHash: merged.unresolved.length ? null : hash(merged.record) } : null })
      if (l?.hash === r?.hash && l) defaults.set(key, l)
      else if (b && r?.hash === b.remoteHash && l) defaults.set(key, l)
      else if (b?.local.kind === 'live' && l?.hash === b.local.hash && r) defaults.set(key, r)
      else if (!b && l && !r && !isDeleted(l.record)) defaults.set(key, l)
      else if (!b && r && !l && !isDeleted(r.record)) defaults.set(key, r)
      else if (merged && !merged.unresolved.length) defaults.set(key, { key, record: validateSyncedProtocol5Record(merged.record, key), hash: hash(merged.record) })
      else reason ??= b ? 'diverged' : 'baseline-missing'
    }
    const component: ExchangeComponent = { keys: part, localSignature: hash(part.map(key => [key, local.get(key)?.hash ?? null])), remoteSignature: hash(part.map(key => [key, remote.get(key)?.hash ?? null])),
      dependencySignature: hash({ domain: 'knowledge-component.v1', edges: part.map(key => [key, sort(graph.get(key)!)]), fixedDenials,
        baseline: part.map(key => [key, baseline.get(key) ?? null]), guards: part.map(key => [key, guards.get(key) ?? null]),
        priorComponents: [...new Set(part.flatMap(key => { const row = automaticByKey.get(key); return row ? [row] : [] }))],
        typedSources: part.flatMap(key => { const row = linksByOwner.get(key); return row ? [row] : [] }) }) }
    const componentId = hash({ component, records: records.map(({ key, baseHash, localHash, remoteHash }) => ({ key, baseHash, localHash, remoteHash })) })
    const fence = validateKnowledgeComponentFence({ ...component, componentId, mutableKeys, fixedDenialKeys: fixedDenials.map(row => row.key), fixedDenials })
    let selectedOriginal: SyncedProtocol5Snapshot | null = null
    if (!hard) {
      const retained = new Map(remote)
      for (const key of part) { const chosen = conflictedKeys.includes(key) ? remote.get(key) : defaults.get(key); if (chosen) retained.set(key, chosen) }
      try { selectedOriginal = snapshot(retained, input.remote.manifest.workspaceId) }
      catch (cause) { if (!(cause instanceof SyncedPublicationError) && !(cause instanceof SyncedValidationError)) throw cause; reason ??= 'dependency' }
    }
    details.push({ component: { ...component, componentId }, fence, componentFence: fence, mutableKeys, fixedDenialKeys: fence.fixedDenialKeys, records,
      conflictedKeys, selectedOriginal, reason: hard ?? reason, hard, defaults, merges })
  }
  return { automatic, source, local, remote, original, baseline, graph, details, links }
}

/** Complete outer component facts. Fixed denials are still present; leaf callers must use mutableKeys only. */
export function deriveKnowledgeBothComponents(input: KnowledgePlanInput, sourceLinks: SyncedBothOwnerSourceLinks[] = []): KnowledgeComponentFacts[] {
  return analyze(input, sourceLinks).details.map(({ defaults: _defaults, merges: _merges, hard, ...fact }) => ({ ...fact,
    reason: hard ?? (fact.reason === 'diverged' && fact.selectedOriginal ? null : fact.reason) }))
}

function ownership(input: KnowledgePlanInput, after: Entries, accepted: Set<string>): { reason: ExchangeDeferredReason | null; transfers: ExchangeTransfer[] } {
  const before = physical(index(input.localPhysical)), identities = new Map(input.authority.identities.map(row => [row.id, row])), local = index(input.localPhysical)
  const transfers: ExchangeTransfer[] = [], occupied = new Set(input.authority.occupiedDocumentIds), knownGroups = new Set(input.authority.knownGroupIds ?? [])
  const ids = new Set<string>()
  for (const { record } of after.values()) if (record.kind === 'document' || record.kind === 'synced-group') for (const child of record.kind === 'document' ? record.content.blocks : record.blocks) {
    if (ids.has(child.id)) return { reason: 'owner-source', transfers }; ids.add(child.id)
  }
  const next = physical(after)
  for (const { key, record } of after.values()) if (accepted.has(key)) {
    if (isDeleted(record)) return { reason: 'tombstone', transfers }
    if (record.kind === 'document' && !local.has(key) && occupied.has(record.id)) return { reason: 'owner-source', transfers }
    if (record.kind === 'synced-group') {
      const old = local.get(key)?.record
      if (old?.kind === 'synced-group' && tuple(old) !== tuple(record) || !old && knownGroups.has(record.id)) return { reason: 'incarnation', transfers }
    }
  }
  for (const [id, nextOwner] of next) if (accepted.has(nextOwner.key)) {
    const old = before.get(id), identity = identities.get(id)
    if (!old) { if (identity) return { reason: identity.created_at === null ? 'unknown-birth' : 'owner-source', transfers }; continue }
    if (!identity || identity.state !== 'live' || identity.last_owner_kind !== old.kind || identity.last_owner_id !== old.ownerId || identity.created_at === null) return { reason: 'unknown-birth', transfers }
    if (old.kind === 'group' && old.birth !== identity.created_at) return publicationInvalid('knowledge原canonical birth与实际ledger不一致。')
    const nextBirth = nextOwner.kind === 'group' ? nextOwner.birth : identity.created_at
    if (nextBirth === null || old.key !== nextOwner.key && !accepted.has(old.key)) return { reason: 'owner-source', transfers }
    if (nextBirth !== identity.created_at && !(old.kind === 'document' && nextOwner.kind === 'group') && !(old.key === nextOwner.key && nextOwner.kind === 'group')) return { reason: 'unknown-birth', transfers }
    if (old.key !== nextOwner.key || nextBirth !== identity.created_at) transfers.push({ id, fromKind: old.kind, fromId: old.ownerId, fromCreatedAt: identity.created_at,
      toKind: nextOwner.kind, toId: nextOwner.ownerId, toCreatedAt: nextBirth })
  }
  return { reason: null, transfers: transfers.sort((a, b) => publicationCompare(a.id, b.id)) }
}
function candidate(input: KnowledgePlanInput, local: Entries, remote: Entries, accepted: Set<string>): ExchangeDeferredReason | null {
  if (!pathsValid(local) || !pathsValid(remote)) return 'path'
  if (input.authority.catalogId !== 'catalog') for (const key of accepted) {
    const row = local.get(key), record = row?.record
    if (record?.kind === 'databases' && record.tables.databases.some(value => value.id === input.authority.catalogId)) return 'catalog'
    const blocks = record?.kind === 'document' ? record.content.blocks : record?.kind === 'synced-group' ? record.blocks : []
    if (blocks.some(child => child.type === 'database-view' && parseDatabaseViewPayload(child.content).databaseId === input.authority.catalogId)) return 'catalog'
  }
  const owned = ownership(input, local, accepted)
  if (owned.reason) return owned.reason
  try { snapshot(local, input.localPhysical.manifest.workspaceId); snapshot(remote, input.remote.manifest.workspaceId); return null }
  catch (cause) { if (!(cause instanceof SyncedPublicationError) && !(cause instanceof SyncedValidationError)) throw cause; return accepted.has('databases') ? 'catalog' : 'dependency' }
}

function run(input: KnowledgePlanInput, forkInput: KnowledgeForkPlanInput | null): KnowledgeConflictPlan | KnowledgeForkPlan {
  const data = analyze(input, forkInput?.sourceLinks ?? []), { local, remote, original, details, source } = data
  const physicalBefore = index(input.localPhysical)
  let finalLocal = new Map(local), nextRemote = new Map(remote)
  const accepted = new Set<string>(), deferred: KnowledgeConflictPlan['deferred'] = [], previews: ConflictPreviewComponent[] = []
  const forks: SyncedBothForkProof[] = [], projections: SyncedBothLinkProjection[] = [], mergeProvenance: ExchangeMergeProvenance[] = []
  const conflictSelections = input.conflictSelections ?? [], bothSelections = forkInput?.bothSelections ?? []
  if (new Set(conflictSelections.map(row => row.decision.componentId)).size !== conflictSelections.length || new Set(bothSelections.map(row => row.decision.componentId)).size !== bothSelections.length) return publicationInvalid('knowledge selector重复。')
  const consumedConflicts = new Set<string>(), consumedBoth = new Set<string>()
  const priority = (detail: Detail): number => bothSelections.some(row => row.component.keys.some(key => detail.component.keys.includes(key))) ? 2
    : conflictSelections.some(row => row.preview.keys.some(key => detail.component.keys.includes(key))) ? 1 : 0
  // Settle original automatic live components first. Explicit choices then validate
  // against both retained complete graphs; fork candidates are applied last.
  const processing = [...details].sort((a, b) => priority(a) - priority(b))
  const automaticBlocked = new Map(data.automatic.deferred.flatMap(row => row.keys.map(key => [key, row.reason] as const)))
  for (const detail of processing) {
    const { component, fence, mutableKeys } = detail, part = component.keys, selected = conflictSelections.find(row => row.preview.keys.some(key => part.includes(key)))
    const both = bothSelections.find(row => row.component.keys.some(key => part.includes(key)))
    const relatedConflicts = conflictSelections.filter(row => row.preview.keys.some(key => part.includes(key))), relatedBoth = bothSelections.filter(row => row.component.keys.some(key => part.includes(key)))
    let reason: ExchangeDeferredReason | null = detail.reason
    const valid = (choices: Entries): boolean => {
      if (detail.hard || choices.size !== part.length || mutableKeys.some(key => !choices.has(key) || isDeleted(choices.get(key)!.record))) return false
      for (const key of fence.fixedDenialKeys) if (choices.get(key)?.hash !== local.get(key)?.hash) return false
      const trialL = new Map(finalLocal), trialR = new Map(nextRemote)
      for (const [key, row] of choices) { trialL.set(key, row); trialR.set(key, row) }
      return candidate(input, trialL, trialR, new Set([...accepted, ...mutableKeys])) === null
    }
    const eligible: Array<'local' | 'remote' | 'merge'> = []
    if (detail.conflictedKeys.length) {
      for (const side of ['local', 'remote'] as const) { const values = side === 'local' ? local : remote, choices = new Map(part.flatMap(key => values.has(key) ? [[key, values.get(key)!] as const] : [])); if (valid(choices)) eligible.push(side) }
      const trial = new Map(detail.defaults); let mergeable = true
      for (const key of detail.conflictedKeys) {
        const result = detail.merges.get(key), l = local.get(key), r = remote.get(key), b = original.get(key)
        if (!result || !l || !r || !b) { mergeable = false; continue }
        const choices: Record<string, SyncedRecordMergeChoice> = Object.create(null) as Record<string, SyncedRecordMergeChoice>
        for (const part of result.unresolved) choices[part.id] = { choice: 'local' }
        const complete = result.unresolved.length ? mergeSyncedProtocol5Record(b.record, l.record, r.record, choices) : result
        if (!complete || complete.unresolved.length) { mergeable = false; continue }
        trial.set(key, { key, record: complete.record, hash: hash(complete.record) })
      }
      if (mergeable && valid(trial)) eligible.push('merge')
    }
    const preview = validateConflictPreviewComponent({ ...component, reason: reason ?? 'diverged', choices: eligible, records: detail.records })
    if (detail.conflictedKeys.length || reason) previews.push(preview)
    let choices = new Map(detail.defaults), usedMerge = new Set(detail.conflictedKeys.filter(key => detail.merges.has(key) && !detail.merges.get(key)!.unresolved.length))
    if (selected) {
      consumedConflicts.add(selected.decision.componentId)
      if (relatedConflicts.length !== 1 || selected.decision.componentId !== component.componentId || !same(selected.preview, preview)) reason = 'dependency'
      else {
        if (!eligible.includes(selected.decision.choice)) return publicationInvalid('knowledge决定不属于真实原live候选闭集。')
        reason = detail.hard; choices.clear(); usedMerge.clear()
        for (const key of fence.fixedDenialKeys) choices.set(key, local.get(key)!)
        if (selected.decision.choice === 'local' || selected.decision.choice === 'remote') {
          const values = selected.decision.choice === 'local' ? local : remote
          for (const key of mutableKeys) { const row = values.get(key); if (!row || isDeleted(row.record)) return publicationInvalid('knowledge整侧选择缺真实live记录。'); choices.set(key, row) }
        } else if (selected.decision.choice === 'merge') {
          const required = detail.records.filter(row => row.merge && row.merge.unresolved.length).map(row => row.key)
          if (!same(required, selected.decision.records.map(row => row.key))) return publicationInvalid('knowledge merge选择未精确覆盖原unresolved。')
          const selectors = new Map(selected.decision.records.map(row => [row.key, row.parts]))
          for (const key of mutableKeys) {
            if (!detail.conflictedKeys.includes(key)) { const row = detail.defaults.get(key); if (row) choices.set(key, row); continue }
            const result = detail.merges.get(key)!, originalRecord = original.get(key)!, l = local.get(key)!, r = remote.get(key)!
            const unresolved = [...result.unresolved].sort((a, b) => publicationCompare(a.id, b.id)), provided = selectors.get(key) ?? []
            if (!same(unresolved.map(row => row.id), provided.map(row => row.id))) return publicationInvalid('knowledge merge part选择缺失/冗余。')
            const values: Record<string, SyncedRecordMergeChoice> = Object.create(null) as Record<string, SyncedRecordMergeChoice>
            for (const [index, row] of provided.entries()) { if (row.value.choice === 'custom' && !unresolved[index].canEditText) return publicationInvalid('knowledge原part不允许custom。'); values[row.id] = row.value }
            const complete = provided.length ? mergeSyncedProtocol5Record(originalRecord.record, l.record, r.record, values) : result
            if (!complete || complete.unresolved.length) return publicationInvalid('knowledge未解决merge不能入候选。')
            choices.set(key, { key, record: complete.record, hash: hash(complete.record) }); usedMerge.add(key)
          }
        }
      }
    }
    if (both) {
      consumedBoth.add(both.decision.componentId)
      if (relatedBoth.length !== 1 || both.component.componentId !== component.componentId || !same(both.component, component) || !same(both.conflictedKeys, detail.conflictedKeys)
        || both.preview.componentId !== component.componentId || both.preview.reason !== null || !both.preview.choices.includes('both')
        || !same(both.preview.keys, component.keys) || both.preview.localSignature !== component.localSignature || both.preview.remoteSignature !== component.remoteSignature || both.preview.dependencySignature !== component.dependencySignature) reason = 'dependency'
      else if (!detail.hard && detail.selectedOriginal && detail.conflictedKeys.length) {
        const fork = planSyncedBothFork({ local: input.localKnowledge, remote: input.remote, selectedOriginal: detail.selectedOriginal,
          conflictedKeys: detail.conflictedKeys, component: { ...component, keys: mutableKeys }, sourceLinks: data.links,
          retainedLocal: snapshot(finalLocal, input.localKnowledge.manifest.workspaceId), retainedRemote: snapshot(nextRemote, input.remote.manifest.workspaceId), decision: both.decision, allocation: both.allocation })
        if (fork.status === 'planned') {
          const trialL = index(fork.localFinal), trialR = index(fork.nextRemote), keys = sort([...mutableKeys, ...fork.fork.results.map(row => row.key)])
          reason = candidate(input, trialL, trialR, new Set([...accepted, ...keys]))
          if (!reason && fence.fixedDenialKeys.some(key => trialL.get(key)?.hash !== local.get(key)?.hash || trialR.get(key)?.hash !== remote.get(key)?.hash)) return publicationInvalid('knowledge fork改写了固定denial。')
          if (!reason) { finalLocal = trialL; nextRemote = trialR; keys.forEach(key => accepted.add(key)); forks.push(fork.fork); projections.push(...fork.projections); continue }
        } else reason = fork.reason === 'semantic-binding' || fork.reason === 'budget' ? 'dependency' : fork.reason
      } else reason = detail.hard ?? 'dependency'
    }
    if (!selected && !both && !reason) for (const key of part) { const blocked = automaticBlocked.get(key); if (blocked) { reason = blocked; break } }
    if (!reason && (selected || both || detail.conflictedKeys.length) && !valid(choices)) reason = 'dependency'
    if (!reason && (choices.size !== part.length || mutableKeys.some(key => !choices.has(key) || isDeleted(choices.get(key)!.record)))) reason = 'dependency'
    if (reason) { deferred.push({ keys: component.keys, localSignature: component.localSignature, remoteSignature: component.remoteSignature, dependencySignature: component.dependencySignature, reason }); continue }
    for (const key of mutableKeys) { const row = choices.get(key); if (!row || isDeleted(row.record)) return publicationInvalid('knowledge可执行选择缺live正文。'); finalLocal.set(key, row); nextRemote.set(key, row); accepted.add(key) }
    for (const key of usedMerge) { const l = local.get(key), r = remote.get(key), b = original.get(key), result = choices.get(key); if (l && r && b && result) mergeProvenance.push({ key, baseHash: b.hash, localHash: l.hash, remoteHash: r.hash, resultHash: result.hash }) }
  }
  if (consumedConflicts.size !== conflictSelections.length || consumedBoth.size !== bothSelections.length) return publicationInvalid('knowledge selector没有对应完整原组件。')
  const known = snapshot(finalLocal, input.localKnowledge.manifest.workspaceId), next = snapshot(nextRemote, input.remote.manifest.workspaceId), physicalFinal = snapshot(liveView(finalLocal), input.localPhysical.manifest.workspaceId)
  const acceptedKeys = sort(accepted), writes = acceptedKeys.filter(key => remote.get(key)?.hash !== nextRemote.get(key)?.hash), incoming = acceptedKeys.filter(key => local.get(key)?.hash !== finalLocal.get(key)?.hash)
  const facts = new Map(deriveSyncedExchangeDependencyFacts(known).map(row => [row.key, row])), sides: KnowledgeLiveAcceptedSide[] = []
  const detailByKey = new Map(details.flatMap(row => row.component.keys.map(key => [key, row] as const))), detailById = new Map(details.map(row => [row.component.componentId, row]))
  for (const fork of forks) { const detail = detailById.get(fork.componentId); if (detail) for (const result of fork.results) detailByKey.set(result.key, detail) }
  for (const key of acceptedKeys) {
    const row = finalLocal.get(key)!, peer = nextRemote.get(key)
    if (isDeleted(row.record) || !peer || peer.hash !== row.hash) return publicationInvalid('knowledge accepted只允许两侧相同live正文。')
    const outer = detailByKey.get(key)
    const dependencyKeys = sort([...(facts.get(key)?.dependencyKeys ?? []), ...(outer?.component.keys.filter(value => value !== key) ?? [])])
    sides.push({ key, beforeLocalHash: physicalBefore.get(key)?.hash ?? null, beforeRemoteHash: remote.get(key)?.hash ?? null,
      local: { kind: 'live', hash: row.hash }, remoteHash: row.hash, commonHash: row.hash, dependencyKeys,
      dependencySignature: hash({ domain: 'knowledge-accepted.v1', key, dependencies: dependencyKeys.map(id => [id, nextRemote.get(id)?.hash ?? null]), fixedDenials: outer?.fence.fixedDenials ?? [], forks: forks.filter(fork => fork.results.some(result => result.key === key)) }) })
  }
  const updates = new Map(input.state.baseline.map(row => [row.key, row]))
  for (const side of sides) updates.set(side.key, { key: side.key, local: side.local, remoteHash: side.remoteHash, commonHash: side.commonHash,
    dependencyKeys: side.dependencyKeys, dependencySignature: side.dependencySignature, acceptedOperationId: input.operationId })
  for (const old of source.absentBaseline) if (!same(updates.get(old.key), old)) return publicationInvalid('knowledge手动操作改写了旧absent baseline来源。')
  const owned = ownership(input, finalLocal, accepted)
  if (owned.reason) return publicationInvalid('knowledge最终身份许可与逐组件验证不一致。')
  const history = new Set(incoming)
  for (let changed = true; changed;) { changed = false; for (const group of input.authority.historyComponents) if (group.some(key => history.has(key))) for (const key of group) if (accepted.has(key) && !history.has(key)) { history.add(key); changed = true } }
  const result: KnowledgeConflictPlan = { plannerVersion: 'knowledge-conflicts-v1', knowledgeSource: source, knowledgeHash: knowledgeSourceHash(source), componentFences: details.map(row => row.fence),
    nextRemote: next, localKnowledgeFinal: known, localPhysicalFinal: physicalFinal, accepted: acceptedKeys, writes, incoming,
    components: details.map(row => ({ keys: sort([...row.component.keys, ...forks.filter(fork => fork.componentId === row.component.componentId).flatMap(fork => fork.results.map(result => result.key))]), localSignature: row.component.localSignature, remoteSignature: row.component.remoteSignature, dependencySignature: row.component.dependencySignature })),
    deferred, transfers: owned.transfers, historyBoundaryKeys: sort(history), acceptedSides: sides, nextBaseline: [...updates.values()].sort((a, b) => publicationCompare(a.key, b.key)),
    merges: mergeProvenance.sort((a, b) => publicationCompare(a.key, b.key)), conflictPreviews: previews.sort((a, b) => publicationCompare(a.componentId, b.componentId)),
    localFingerprint: input.localFingerprint, beforeManifestHash: hash(input.remote.manifest), afterManifestHash: hash(next.manifest), planHash: '' }
  const output: KnowledgeConflictPlan | KnowledgeForkPlan = forkInput ? { ...result, plannerVersion: 'knowledge-forks-v1', forks, projections } : result
  output.planHash = hash({ ...output, nextRemote: { manifest: next.manifest, records: next.records }, localKnowledgeFinal: { manifest: known.manifest, records: known.records }, localPhysicalFinal: { manifest: physicalFinal.manifest, records: physicalFinal.records },
    state: input.state, authority: input.authority, conflictSelections, bothSelections: bothSelections.map(({ component, decision, allocation, poolAllocation, sourceLinks, conflictedKeys }) => ({ component, decision, allocationHash: hash(allocation), poolAllocationHash: hash(poolAllocation), sourceLinksHash: hash(sourceLinks), conflictedKeys })) })
  return output
}
export function planSyncedKnowledgeConflicts(input: KnowledgePlanInput): KnowledgeConflictPlan { return run(input, null) as KnowledgeConflictPlan }
export function planSyncedKnowledgeForks(input: KnowledgePlanInput, selections: KnowledgeForkPlanInput['bothSelections'] = [], sourceLinks: SyncedBothOwnerSourceLinks[] = []): KnowledgeForkPlan {
  return run(input, { ...input, bothSelections: selections, sourceLinks }) as KnowledgeForkPlan
}
