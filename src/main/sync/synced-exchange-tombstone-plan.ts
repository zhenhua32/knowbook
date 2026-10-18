import type { SyncedCanonicalWire, SyncedGroupWire } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, parseSyncedBlockPayload, SyncedValidationError } from '../../shared/syncedBlockValidation'
import { parseDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { assertExchangeData, exchangeRecordKey, type ExchangeState, type ExchangeTransfer, type ExchangeComponent } from './synced-exchange-model'
import { planSyncedExchange } from './synced-exchange-plan'
import { mergeSyncedProtocol5Record } from './synced-merge'
import type { ExchangeMergeProvenance } from './synced-exchange-conflict-model'
import { publicationCompare, publicationHash, publicationJson, publicationInvalid, SyncedPublicationError } from './synced-publication-model'
import { validateSyncedProtocol5Record, validateSyncedProtocol5Snapshot, type SyncedProtocol5Record, type SyncedProtocol5Snapshot } from './synced-protocol5-model'
import type { TombstoneAcceptedSide, TombstoneDeletionIntent, TombstoneDeferredComponent,
  TombstoneExchangePlan, TombstoneIdentityEffect, TombstoneLocalOutcome, TombstonePlanInput } from './synced-exchange-tombstone-types'

type Entry = SyncedProtocol5Snapshot['records'][number]
type Entries = Map<string, Entry>
type Physical = { key: string; kind: 'document' | 'group'; ownerId: string; birth: string | null }
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(publicationCompare)
const hash = (value: unknown): string => publicationHash(publicationJson(value))
const same = (left: unknown, right: unknown): boolean => publicationJson(left) === publicationJson(right)
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const deleted = (record: SyncedProtocol5Record): boolean => record.kind === 'deleted' || record.kind === 'synced-group-deleted'
const localHash = (outcome: TombstoneLocalOutcome): string => outcome.kind === 'live' ? outcome.hash : outcome.tombstoneHash
const tuple = (record: SyncedGroupWire): unknown => [record.id, record.creationId, record.createdAt, record.origin]
function unique<T>(values: readonly T[], key: (value: T) => string, message: string): Map<string, T> {
  const result = new Map<string, T>()
  for (const value of values) { const id = key(value); if (result.has(id)) return publicationInvalid(message); result.set(id, value) }
  return result
}
function index(value: SyncedProtocol5Snapshot): Entries {
  const checked = validateSyncedProtocol5Snapshot(value.manifest, value.records.map(row => ({ key: row.key, record: row.record })))
  const result = new Map(checked.records.map(row => [row.key, row]))
  if (value.records.some(row => row.hash !== result.get(row.key)?.hash)) return publicationInvalid('tombstone snapshot准确hash不符。')
  return result
}
function physical(records: Entries): Map<string, Physical> {
  const result = new Map<string, Physical>()
  for (const { key, record } of records.values()) if (record.kind === 'document' || record.kind === 'synced-group') {
    for (const child of record.kind === 'document' ? record.content.blocks : record.blocks) {
      if (result.has(child.id)) return publicationInvalid('tombstone原side物理身份重复。')
      result.set(child.id, { key, kind: record.kind === 'document' ? 'document' : 'group', ownerId: record.id,
        birth: record.kind === 'synced-group' ? (child as SyncedCanonicalWire).createdAt : null })
    }
  }
  return result
}
function snapshot(records: Entries, workspaceId: string): SyncedProtocol5Snapshot {
  const rows = [...records.values()].sort((a, b) => publicationCompare(a.key, b.key)), groups = new Map(rows.flatMap(row => row.record.kind === 'synced-group' ? [[row.record.id, row.hash] as const] : []))
  const syncedInstances: SyncedProtocol5Snapshot['manifest']['syncedInstances'] = []
  for (const { record } of rows) if (record.kind === 'document') for (const child of record.content.blocks) if (child.type === 'synced-block') {
    const groupId = parseSyncedBlockPayload(child.content).groupId, groupHash = groups.get(groupId)
    if (!groupHash) return publicationInvalid('tombstone候选仍有live ref指向已删或缺失组。')
    syncedInstances.push({ documentId: record.id, instanceId: child.id, groupId, groupHash })
  }
  syncedInstances.sort((a, b) => publicationCompare(a.documentId, b.documentId) || publicationCompare(a.instanceId, b.instanceId))
  return validateSyncedProtocol5Snapshot({ version: 5, workspaceId, entries: Object.fromEntries(rows.map(row => [row.key, row.hash])), syncedInstances }, rows.map(({ key, record }) => ({ key, record })))
}
function live(records: Entries): Entries { return new Map([...records].filter(([, row]) => !deleted(row.record))) }
function pathsValid(records: Entries): boolean {
  const siblings = new Set<string>()
  for (const { record } of records.values()) if (record.kind === 'document') {
    const title = record.content.title, key = publicationJson([record.parentId, title.replace(/[A-Z]/g, character => character.toLowerCase())])
    if (title !== title.trim() || siblings.has(key)) return false
    siblings.add(key)
  }
  return true
}
function validateInput(input: TombstonePlanInput) {
  assertExchangeData(input.state); assertExchangeData(input.authority)
  if (!isSyncedUuid(input.operationId) || !isHash(input.localFingerprint)) return publicationInvalid('tombstone operation/fingerprint无效。')
  const state = input.state
  assertSyncedShape(state, ['kind', 'version', 'databasePath', 'targetFingerprint', 'workspaceScope', 'recoveryEpoch', 'remoteWorkspaceId', 'generation', 'currentOperationId', 'source', 'baseline', 'deferred', 'lastSyncAt'])
  if (state.kind !== 'synced-exchange-state' || state.version !== 2 || !isSyncedUuid(state.workspaceScope) || !isSyncedUuid(state.recoveryEpoch)
    || !isSyncedUuid(state.remoteWorkspaceId) || !isSyncedUuid(state.generation) || state.currentOperationId !== null && !isSyncedUuid(state.currentOperationId)) return publicationInvalid('tombstone state2来源无效。')
  const local = index(input.localKnowledge), physicalLocal = index(input.localPhysical), remote = index(input.remote)
  if (state.workspaceScope !== input.localKnowledge.manifest.workspaceId || state.workspaceScope !== input.localPhysical.manifest.workspaceId
    || state.remoteWorkspaceId !== input.remote.manifest.workspaceId) return publicationInvalid('tombstone两workspace不符。')
  if ([...physicalLocal.values()].some(row => deleted(row.record))) return publicationInvalid('tombstone physical不得伪含删除wire。')
  const facts = unique(input.authority.deletedFacts, row => exchangeRecordKey(row.key), 'tombstone durable事实重复。')
  for (const row of facts.values()) {
    assertSyncedShape(row, ['key', 'tombstoneHash', 'deletionOperationId', 'intentHash'])
    const actual = local.get(row.key)
    if (!isHash(row.tombstoneHash) || !isHash(row.intentHash) || !isSyncedUuid(row.deletionOperationId) || !actual || !deleted(actual.record)) return publicationInvalid('tombstone durable事实无效。')
    if (local.get(row.key)?.hash !== row.tombstoneHash || physicalLocal.has(row.key)) return publicationInvalid('tombstone durable事实与真实absence/知识不闭合。')
  }
  for (const [key, row] of local) {
    if (deleted(row.record)) { if (!facts.has(key)) return publicationInvalid('tombstone本机知识缺真实durable来源。') }
    else if (physicalLocal.get(key)?.hash !== row.hash) return publicationInvalid('tombstone知识与physical live正文不符。')
  }
  if ([...physicalLocal.keys()].some(key => !local.has(key))) return publicationInvalid('tombstone知识漏真实physical记录。')
  const baseline = unique(state.baseline, row => exchangeRecordKey(row.key), 'tombstone baseline重复。')
  for (const row of baseline.values()) {
    assertSyncedShape(row, ['key', 'local', 'remoteHash', 'commonHash', 'dependencyKeys', 'dependencySignature', 'acceptedOperationId'])
    if (!isHash(row.remoteHash) || row.commonHash !== null && !isHash(row.commonHash) || !isHash(row.dependencySignature) || !isSyncedUuid(row.acceptedOperationId)
      || !Array.isArray(row.dependencyKeys) || !same(row.dependencyKeys, sorted(row.dependencyKeys)) || row.dependencyKeys.includes(row.key)) return publicationInvalid('tombstone baseline字段无效。')
    for (const key of row.dependencyKeys) if (!baseline.has(exchangeRecordKey(key))) return publicationInvalid('tombstone原baseline依赖缺对应key。')
    if (row.local.kind === 'live') { assertSyncedShape(row.local, ['kind', 'hash']); if (!isHash(row.local.hash)) return publicationInvalid('tombstone live baseline hash无效。') }
    else {
      assertSyncedShape(row.local, ['kind', 'tombstoneHash', 'deletionOperationId', 'intentHash'])
      if (row.local.kind !== 'absent' || !isHash(row.local.tombstoneHash) || !isHash(row.local.intentHash) || !isSyncedUuid(row.local.deletionOperationId)) return publicationInvalid('tombstone absent baseline来源无效。')
      const fact = facts.get(row.key)
      if (!fact || fact.tombstoneHash !== row.local.tombstoneHash || fact.deletionOperationId !== row.local.deletionOperationId || fact.intentHash !== row.local.intentHash) return publicationInvalid('tombstone absent baseline未关联真实durable删除事实。')
    }
  }
  const base: Entries = new Map(), missing = new Set(input.authority.missingBaseKeys ?? [])
  for (const row of input.baseRecords) {
    const record = validateSyncedProtocol5Record(row.record, row.key), original = baseline.get(row.key), digest = hash(record)
    if (base.has(row.key) || digest !== row.hash || !original || digest !== (original.commonHash ?? original.remoteHash)) return publicationInvalid('tombstone原B不属于真实baseline hash。')
    base.set(row.key, { key: row.key, hash: digest, record })
  }
  for (const row of baseline.values()) if (!base.has(row.key)) {
    const expected = row.commonHash ?? row.remoteHash, found = [local.get(row.key), remote.get(row.key)].find(value => value?.hash === expected)
    if (found) base.set(row.key, found); else missing.add(row.key)
  }
  const identities = unique(input.authority.identities, row => row.id, 'tombstone真实identity重复。')
  const pins = unique(input.authority.pins, row => publicationJson([row.groupId, row.kind, row.pinId]), 'tombstone真实pin重复。')
  for (const row of pins.values()) { assertSyncedShape(row, ['groupId', 'kind', 'pinId', 'sourceHash'])
    if (!isSyncedUuid(row.groupId) || typeof row.kind !== 'string' || !row.kind.length || !isSyncedBlockId(row.pinId) || !isHash(row.sourceHash)) return publicationInvalid('tombstone真实pin来源无效。') }
  return { state, local, physicalLocal, remote, facts, baseline, base, missing, identities, pins }
}

/** Same-target complete graph planning only; actual remote/spool provenance, proof mint and owned SQL remain private runtime work. */
export function planSyncedTombstoneExchange(input: TombstonePlanInput): TombstoneExchangePlan {
  const data = validateInput(input), { state, local, physicalLocal, remote, facts, baseline, base, missing, identities, pins } = data
  const keys = sorted([...local.keys(), ...remote.keys(), ...baseline.keys()]), graph = new Map(keys.map(key => [key, new Set<string>()]))
  const edge = (left: string, right: string): void => { if (left !== right && graph.has(left) && graph.has(right)) { graph.get(left)!.add(right); graph.get(right)!.add(left) } }
  for (const row of baseline.values()) for (const key of row.dependencyKeys) edge(row.key, key)
  for (const row of input.authority.historyComponents) for (let index = 1; index < row.length; index++) edge(row[0], row[index])
  const owners = new Map<string, Set<string>>(), sidePhysical = [physical(local), physical(remote), physical(base)]
  for (const side of sidePhysical) for (const [id, owner] of side) { const set = owners.get(id) ?? new Set<string>(); set.add(owner.key); owners.set(id, set) }
  for (const identity of identities.values()) if (owners.has(identity.id) && identity.last_owner_kind !== 'reserved') owners.get(identity.id)!.add((identity.last_owner_kind === 'group' ? 'group:' : 'doc:') + identity.last_owner_id)
  for (const set of owners.values()) { const list = [...set]; for (let index = 1; index < list.length; index++) edge(list[0], list[index]) }
  const siblingOwners = new Map<string, string[]>()
  for (const side of [local, remote, base]) {
    const catalog = side.get('databases')?.record
    for (const { key, record } of side.values()) {
      if (record.kind === 'document') {
        if (record.parentId !== null) edge(key, 'doc:' + record.parentId)
        const name = publicationJson([record.parentId, record.content.title.replace(/[A-Z]/g, value => value.toLowerCase())]), siblings = siblingOwners.get(name) ?? []
        for (const sibling of siblings) edge(key, sibling); siblings.push(key); siblingOwners.set(name, siblings)
        for (const child of record.content.blocks) if (child.type === 'synced-block') edge(key, 'group:' + parseSyncedBlockPayload(child.content).groupId)
      } else if (record.kind === 'synced-group') {
        edge(key, 'doc:' + record.origin.documentId)
        for (const owner of owners.get(record.origin.firstInstanceId) ?? []) edge(key, owner)
        for (const binding of record.bindings) {
          if (binding.target.kind === 'document') edge(key, 'doc:' + binding.target.id)
          else if (binding.target.kind === 'heading') edge(key, 'doc:' + binding.target.documentId)
          else if (binding.target.kind === 'block') for (const owner of owners.get(binding.target.id) ?? []) edge(key, owner)
        }
      }
      const blocks = record.kind === 'document' ? record.content.blocks : record.kind === 'synced-group' ? record.blocks : []
      for (const child of blocks) if (child.type === 'database-view') { parseDatabaseViewPayload(child.content); edge(key, 'databases') }
    }
    if (catalog?.kind === 'databases') {
      const entityDocs = new Map(catalog.tables.database_entities.map(row => [row.id, row.document_id]))
      for (const rows of Object.values(catalog.tables)) for (const row of rows) {
        if (typeof row.document_id === 'string') edge('databases', 'doc:' + row.document_id)
        if (typeof row.entity_id === 'string') { const doc = entityDocs.get(row.entity_id); if (typeof doc === 'string') edge('databases', 'doc:' + doc) }
      }
    }
  }
  const parts: string[][] = [], seen = new Set<string>()
  for (const key of keys) if (!seen.has(key)) { const pending = [key], part: string[] = []; seen.add(key)
    for (let index = 0; index < pending.length; index++) { const next = pending[index]; part.push(next); for (const neighbor of graph.get(next)!) if (!seen.has(neighbor)) { seen.add(neighbor); pending.push(neighbor) } }
    parts.push(part.sort(publicationCompare))
  }
  const specialParts = parts.filter(part => part.some(key => [local.get(key), remote.get(key), base.get(key)].some(row => row && deleted(row.record)) || baseline.get(key)?.local.kind === 'absent'))
  const special = new Set(specialParts.flat()), normalBaseline = state.baseline.filter(row => !special.has(row.key))
  const normalState: ExchangeState = { ...state, version: 1, baseline: normalBaseline.map(row => {
    if (row.local.kind !== 'live') return publicationInvalid('tombstone absent状态不得伪装旧live算法。')
    return { key: row.key, localHash: row.local.hash, remoteHash: row.remoteHash, commonHash: row.commonHash, dependencyKeys: row.dependencyKeys, dependencySignature: row.dependencySignature, acceptedOperationId: row.acceptedOperationId }
  }), deferred: state.deferred }
  const normal = planSyncedExchange({ operationId: input.operationId, local: input.localPhysical, remote: snapshot(live(remote), state.remoteWorkspaceId),
    baseRecords: [...base.values()].filter(row => !special.has(row.key)), state: normalState, localFingerprint: input.localFingerprint,
    authority: { ...input.authority, deferredKeys: sorted([...(input.authority.deferredKeys ?? []), ...special]) } })
  const nextRemote = new Map(remote), localFinal = new Map(local), accepted = new Set(normal.accepted), transfers: ExchangeTransfer[] = [...normal.transfers]
  const normalLocal = new Map(normal.localFinal.records.map(row => [row.key, row])), normalRemote = new Map(normal.nextRemote.records.map(row => [row.key, row]))
  for (const key of normal.accepted) { const left = normalLocal.get(key), right = normalRemote.get(key); if (!left || !right) return publicationInvalid('tombstone普通接受记录缺失。'); localFinal.set(key, left); nextRemote.set(key, right) }
  const deferred: TombstoneDeferredComponent[] = normal.deferred.filter(row => !row.keys.some(key => special.has(key)))
  const components: ExchangeComponent[] = normal.components.filter(row => !row.keys.some(key => special.has(key)))
  const deletions: TombstoneDeletionIntent[] = [], acceptedIntents = new Map<string, TombstoneDeletionIntent>()
  const guards = unique(input.authority.keyGuards ?? [], row => exchangeRecordKey(row.key), 'tombstone原key guard重复。')
  const pinned = new Set([...input.authority.pinnedGroupIds, ...[...pins.values()].map(row => row.groupId)])
  const localOwners = physical(physicalLocal), occupied = new Set(input.authority.occupiedDocumentIds), knownGroups = new Set(input.authority.knownGroupIds ?? [])
  const identityByOwner = new Map<string, Array<TombstonePlanInput['authority']['identities'][number]>>(), pinsByGroup = new Map<string, Array<TombstonePlanInput['authority']['pins'][number]>>()
  for (const row of identities.values()) { const key = (row.last_owner_kind === 'group' ? 'group:' : 'doc:') + row.last_owner_id, rows = identityByOwner.get(key) ?? []; rows.push(row); identityByOwner.set(key, rows) }
  for (const rows of identityByOwner.values()) rows.sort((a, b) => publicationCompare(a.id, b.id))
  for (const row of pins.values()) { const rows = pinsByGroup.get('group:' + row.groupId) ?? []; rows.push(row); pinsByGroup.set('group:' + row.groupId, rows) }
  const signature = (part: string[], entries: Entries): string => hash(part.map(key => [key, entries.get(key)?.hash ?? null]))
  const merges: ExchangeMergeProvenance[] = [...normal.merges ?? []]
  const component = (part: string[]): ExchangeComponent => ({ keys: part, localSignature: signature(part, local), remoteSignature: signature(part, remote),
    dependencySignature: hash({ edges: part.map(key => [key, sorted(graph.get(key)!)]), base: part.map(key => [key, baseline.get(key) ?? null]), guards: part.map(key => [key, guards.get(key)?.fingerprint ?? null]),
      identities: part.flatMap(key => identityByOwner.get(key) ?? []), pins: part.flatMap(key => pinsByGroup.get(key) ?? []) }) })
  for (const part of specialParts) {
    const captured = component(part); components.push(captured)
    let reason: TombstoneDeferredComponent['reason'] | null = part.some(key => input.authority.deferredKeys?.includes(key)) ? 'dependency' : null
    const choices: Entries = new Map(), intents: TombstoneDeletionIntent[] = [], componentMerges: ExchangeMergeProvenance[] = []
    for (const key of part) {
      if (reason) break
      const left = local.get(key), right = remote.get(key), previous = baseline.get(key)
      if (!right && previous) { reason = 'tombstone'; break }
      if (!left && previous) { reason = 'local-removal'; break }
      if (left && deleted(left.record) && right && !deleted(right.record)) { reason = 'tombstone'; break }
      if (left?.hash === right?.hash) { if (left) choices.set(key, left); continue }
      if (previous && missing.has(key)) { reason = 'baseline-missing'; break }
      if (previous && right?.hash === previous.remoteHash && left) choices.set(key, left)
      else if (previous && left?.hash === localHash(previous.local) && right) choices.set(key, right)
      else if (!previous && left && !right && !deleted(left.record)) choices.set(key, left)
      else if (!previous && right && !left && !deleted(right.record)) choices.set(key, right)
      else {
        const original = base.get(key)
        const merged = left && right && original && previous?.commonHash === original.hash && !deleted(left.record) && !deleted(right.record) && !deleted(original.record)
          ? mergeSyncedProtocol5Record(original.record, left.record, right.record) : null
        if (!merged || merged.unresolved.length || !left || !right || !original) { reason = previous ? 'diverged' : 'baseline-missing'; break }
        const record = validateSyncedProtocol5Record(merged.record, key), digest = hash(record)
        choices.set(key, { key, hash: digest, record }); componentMerges.push({ key, baseHash: original.hash, localHash: left.hash, remoteHash: right.hash, resultHash: digest })
      }
    }
    for (const [key, choice] of choices) {
      if (reason || !deleted(choice.record)) continue
      if (facts.has(key)) { if (choice.hash !== facts.get(key)!.tombstoneHash) reason = 'tombstone'; continue }
      const before = physicalLocal.get(key), original = base.get(key)
      if (!before || !original || deleted(original.record)) { reason = 'baseline-missing'; break }
      if (before.hash !== original.hash) { reason = 'diverged'; break }
      if (before.record.kind !== 'document' && before.record.kind !== 'synced-group') return publicationInvalid('tombstone删除前身不是live doc/group。')
      if (choice.record.kind === 'synced-group-deleted') {
        if (before.record.kind !== 'synced-group' || original.record.kind !== 'synced-group' || choice.record.id !== before.record.id || choice.record.creationId !== before.record.creationId
          || !same(tuple(before.record), tuple(original.record))) { reason = 'incarnation'; break }
        if (choice.record.previousHash !== original.hash) { reason = 'tombstone'; break }
        if (pinned.has(before.record.id)) { reason = 'history-pin'; break }
      } else if (choice.record.kind !== 'deleted' || before.record.kind !== 'document') { reason = 'incarnation'; break }
      const ids = before.record.kind === 'document' ? before.record.content.blocks : before.record.blocks, previousIdentities: TombstoneIdentityEffect[] = []
      for (const child of ids) { const identity = identities.get(child.id), expected = localOwners.get(child.id)
        if (!identity || !expected || identity.state !== 'live' || identity.last_owner_kind !== expected.kind || identity.last_owner_id !== expected.ownerId || identity.created_at === null) { reason = 'unknown-birth'; break }
        if (expected.birth !== null && identity.created_at !== expected.birth) return publicationInvalid('tombstone当前canonical birth与ledger不符。')
        previousIdentities.push({ before: { ...identity }, after: { kind: 'retained' } })
      }
      if (reason) break
      previousIdentities.sort((a, b) => publicationCompare(a.before.id, b.before.id))
      const intent = { kind: before.record.kind === 'document' ? 'document' as const : 'group' as const, key, baseLiveHash: original.hash,
        tombstoneHash: choice.hash, before: before.record, identities: previousIdentities }
      intents.push({ ...intent, intentHash: hash({ domain: 'synced-deletion-intent.v1', operationId: input.operationId, workspaceScope: state.workspaceScope,
        recoveryEpoch: state.recoveryEpoch, targetFingerprint: state.targetFingerprint, remoteWorkspaceId: state.remoteWorkspaceId, ...intent }) })
    }
    const trialRemote = new Map(nextRemote), trialLocal = new Map(localFinal)
    for (const [key, choice] of choices) { trialRemote.set(key, choice); trialLocal.set(key, choice) }
    if (!reason && input.authority.catalogId !== 'catalog') for (const { key, record } of choices.values()) {
      if (record.kind === 'databases' && remote.get(key)?.hash === choices.get(key)?.hash && record.tables.databases.some(row => row.id === input.authority.catalogId)) { reason = 'catalog'; break }
      const blocks = record.kind === 'document' ? record.content.blocks : record.kind === 'synced-group' ? record.blocks : []
      if (blocks.some(child => child.type === 'database-view' && parseDatabaseViewPayload(child.content).databaseId === input.authority.catalogId)) { reason = 'catalog'; break }
    }
    const deletedGroups = new Set(intents.filter(row => row.kind === 'group').map(row => row.before.id))
    if (!reason) for (const intent of intents) if (intent.before.kind === 'document') for (const child of intent.before.content.blocks) if (child.type === 'synced-block' && deletedGroups.has(parseSyncedBlockPayload(child.content).groupId)) { reason = 'history-pin'; break }
    let nextOwners = new Map<string, Physical>()
    if (!reason) { const ids = new Set<string>()
      for (const { record } of choices.values()) { const blocks = record.kind === 'document' ? record.content.blocks : record.kind === 'synced-group' ? record.blocks : []
        for (const child of blocks) { if (ids.has(child.id)) { reason = 'owner-source'; break } ids.add(child.id) }
        if (reason) break
      }
    }
    if (!reason) {
      try { nextOwners = physical(trialLocal)
        if (!pathsValid(trialLocal) || !pathsValid(trialRemote)) reason = 'path'
        else { snapshot(trialLocal, state.workspaceScope); snapshot(trialRemote, state.remoteWorkspaceId) }
      } catch (cause) { if (!(cause instanceof SyncedPublicationError) && !(cause instanceof SyncedValidationError)) throw cause; reason = part.includes('databases') ? 'catalog' : 'dependency' }
    }
    const componentTransfers: ExchangeTransfer[] = []
    if (!reason) for (const { key, record } of choices.values()) if (record.kind === 'synced-group') {
      for (const side of [physicalLocal, base]) { const previous = side.get(key)?.record
        if (previous?.kind === 'synced-group' && !same(tuple(previous), tuple(record))) { reason = 'incarnation'; break }
      }
      if (!physicalLocal.has(key) && knownGroups.has(record.id)) reason = 'incarnation'
      if (reason) break
    }
    if (!reason) for (const [id, next] of nextOwners) if (choices.has(next.key)) {
      const old = localOwners.get(id), identity = identities.get(id)
      const record = trialLocal.get(next.key)!.record
      if (record.kind === 'document' && !physicalLocal.has(next.key) && occupied.has(record.id) || record.kind === 'synced-group' && !physicalLocal.has(next.key) && knownGroups.has(record.id)) { reason = 'owner-source'; break }
      if (!old) { if (identity) { reason = identity.created_at === null ? 'unknown-birth' : 'owner-source'; break } continue }
      if (!identity || identity.state !== 'live' || identity.last_owner_kind !== old.kind || identity.last_owner_id !== old.ownerId || identity.created_at === null) { reason = 'unknown-birth'; break }
      const birth = next.kind === 'group' ? next.birth : identity.created_at
      if (birth === null || old.key !== next.key && !choices.has(old.key)) { reason = 'owner-source'; break }
      if (birth !== identity.created_at && !(old.kind === 'document' && next.kind === 'group') && !(old.key === next.key && next.kind === 'group')) { reason = 'unknown-birth'; break }
      if (old.key !== next.key || birth !== identity.created_at) componentTransfers.push({ id, fromKind: old.kind, fromId: old.ownerId, fromCreatedAt: identity.created_at, toKind: next.kind, toId: next.ownerId, toCreatedAt: birth })
    }
    if (reason) { deferred.push({ ...captured, reason }); continue }
    const transferById = new Map(componentTransfers.map(row => [row.id, row]))
    for (const intent of intents) {
      for (const effect of intent.identities) {
        const next = nextOwners.get(effect.before.id)
        if (!next) { effect.after = { kind: 'retained' }; continue }
        const transfer = transferById.get(effect.before.id)
        if (!transfer || transfer.fromKind !== effect.before.last_owner_kind || transfer.fromId !== effect.before.last_owner_id
          || transfer.fromCreatedAt !== effect.before.created_at || transfer.toKind !== next.kind || transfer.toId !== next.ownerId
          || next.kind === 'group' && transfer.toCreatedAt !== next.birth) return publicationInvalid('tombstone删除来源的最终转域缺真实plan transfer闭合。')
        effect.after = { kind: 'transferred', ownerKind: transfer.toKind, ownerId: transfer.toId, createdAt: transfer.toCreatedAt }
      }
      const { intentHash: _oldHash, ...body } = intent
      intent.intentHash = hash({ domain: 'synced-deletion-intent.v1', operationId: input.operationId, workspaceScope: state.workspaceScope,
        recoveryEpoch: state.recoveryEpoch, targetFingerprint: state.targetFingerprint, remoteWorkspaceId: state.remoteWorkspaceId, ...body })
    }
    for (const [key, choice] of choices) { nextRemote.set(key, choice); localFinal.set(key, choice); accepted.add(key) }
    for (const intent of intents) { deletions.push(intent); acceptedIntents.set(intent.key, intent) }
    transfers.push(...componentTransfers)
    merges.push(...componentMerges)
  }
  const next = snapshot(nextRemote, state.remoteWorkspaceId), finalKnowledge = snapshot(localFinal, state.workspaceScope), finalPhysical = snapshot(live(localFinal), state.workspaceScope)
  const acceptedKeys = sorted(accepted), acceptedSet = new Set(acceptedKeys), writes = acceptedKeys.filter(key => remote.get(key)?.hash !== nextRemote.get(key)?.hash)
  const incoming = acceptedKeys.filter(key => physicalLocal.get(key)?.hash !== (deleted(localFinal.get(key)!.record) ? undefined : localFinal.get(key)?.hash))
  const sides: TombstoneAcceptedSide[] = acceptedKeys.map(key => {
    const row = localFinal.get(key)!, existing = facts.get(key), intent = acceptedIntents.get(key)
    let outcome: TombstoneLocalOutcome
    if (!deleted(row.record)) outcome = { kind: 'live', hash: row.hash }
    else if (intent) outcome = { kind: 'absent', tombstoneHash: row.hash, deletionOperationId: input.operationId, intentHash: intent.intentHash }
    else if (existing) outcome = { kind: 'absent', tombstoneHash: row.hash, deletionOperationId: existing.deletionOperationId, intentHash: existing.intentHash }
    else return publicationInvalid('tombstone接受absence缺准确原删除来源。')
    const dependencyKeys = sorted(graph.get(key) ?? [])
    if (nextRemote.get(key)?.hash !== row.hash) return publicationInvalid('tombstone接受两侧知识不等。')
    return { key, beforeLocalHash: physicalLocal.get(key)?.hash ?? null, beforeRemoteHash: remote.get(key)?.hash ?? null, local: outcome,
      remoteHash: row.hash, commonHash: row.hash, dependencyKeys, dependencySignature: hash({ key, dependencies: dependencyKeys.map(id => [id, nextRemote.get(id)?.hash ?? null]), local: outcome }) }
  })
  const updates = new Map(baseline)
  for (const side of sides) updates.set(side.key, { key: side.key, local: side.local, remoteHash: side.remoteHash, commonHash: side.commonHash,
    dependencyKeys: side.dependencyKeys, dependencySignature: side.dependencySignature, acceptedOperationId: input.operationId })
  const historyBoundaryKeys = sorted(incoming.filter(key => key.startsWith('doc:') || key.startsWith('group:')))
  const historyGraph = new Map<string, Set<string>>()
  for (const members of input.authority.historyComponents) for (const key of members) { const list = historyGraph.get(key) ?? new Set<string>()
    if (members.length) { list.add(members[0]); const root = historyGraph.get(members[0]) ?? new Set<string>(); root.add(key); historyGraph.set(members[0], root) }
    historyGraph.set(key, list)
  }
  const historySeen = new Set(historyBoundaryKeys)
  for (let index = 0; index < historyBoundaryKeys.length; index++) for (const key of historyGraph.get(historyBoundaryKeys[index]) ?? [])
    if (acceptedSet.has(key) && !historySeen.has(key)) { historySeen.add(key); historyBoundaryKeys.push(key) }
  components.sort((a, b) => publicationCompare(publicationJson(a.keys), publicationJson(b.keys))); deferred.sort((a, b) => publicationCompare(publicationJson(a.keys), publicationJson(b.keys)))
  deletions.sort((a, b) => publicationCompare(a.key, b.key)); transfers.sort((a, b) => publicationCompare(a.id, b.id))
  const result: TombstoneExchangePlan = { plannerVersion: 'tombstones-v1', nextRemote: next, localKnowledgeFinal: finalKnowledge, localPhysicalFinal: finalPhysical,
    writes, incoming, accepted: acceptedKeys, components, deferred, transfers, historyBoundaryKeys: sorted(historyBoundaryKeys), acceptedSides: sides,
    nextBaseline: [...updates.values()].sort((a, b) => publicationCompare(a.key, b.key)), deletions, merges: merges.sort((a, b) => publicationCompare(a.key, b.key)), localFingerprint: input.localFingerprint,
    beforeManifestHash: hash(input.remote.manifest), afterManifestHash: hash(next.manifest), planHash: '' }
  result.planHash = hash({ ...result, sourceState: state, authority: input.authority })
  return result
}
