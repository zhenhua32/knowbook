import type { SyncedCanonicalWire, SyncedGroupWire } from '../../shared/synced-blocks'
import { isSyncedUuid, parseSyncedBlockPayload, SyncedValidationError } from '../../shared/syncedBlockValidation'
import { parseDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson, SyncedPublicationError } from './synced-publication-model'
import { syncedProtocol5RecordKey, validateSyncedProtocol5Record, validateSyncedProtocol5Snapshot,
  type SyncedProtocol5Record, type SyncedProtocol5Snapshot } from './synced-protocol5-model'
import { exchangeRecordKey, validateExchangeState, type ExchangeAcceptedSide, type ExchangeBaselineEntry, type ExchangeComponent,
  type ExchangeDeferredReason, type ExchangeState, type ExchangeTransfer, type DeferredExchangeComponent } from './synced-exchange-model'

export interface ExchangePlanIdentity {
  id: string; last_owner_kind: 'document' | 'group' | 'reserved'; last_owner_id: string
  state: 'live' | 'retained'; created_at: string | null
}
export interface ExchangePlanAuthority {
  catalogId: string; identities: readonly ExchangePlanIdentity[]; occupiedDocumentIds: readonly string[]
  historyComponents: readonly (readonly string[])[]; pinnedGroupIds: readonly string[]
  knownGroupIds?: readonly string[]; missingBaseKeys?: readonly string[]; deferredKeys?: readonly string[]
  /** Actual private per-key CAS/binding/host/history/pin capture; wire-only callers do not acquire write authority. */
  keyGuards?: readonly { key: string; fingerprint: string }[]
}
export interface ExchangePlanInput {
  operationId: string; local: SyncedProtocol5Snapshot; remote: SyncedProtocol5Snapshot
  /** Individually strict, exact original common-hash records; may be partial, never a fake full snapshot. */
  baseRecords: readonly SyncedProtocol5Snapshot['records'][number][]
  state: ExchangeState; localFingerprint: string; authority: ExchangePlanAuthority
}
export interface ExchangePlan {
  nextRemote: SyncedProtocol5Snapshot; localFinal: SyncedProtocol5Snapshot
  writes: string[]; incoming: string[]; accepted: string[]
  components: ExchangeComponent[]; deferred: DeferredExchangeComponent[]; transfers: ExchangeTransfer[]
  historyBoundaryKeys: string[]; acceptedSides: ExchangeAcceptedSide[]; nextBaseline: ExchangeBaselineEntry[]
  localFingerprint: string; beforeManifestHash: string; afterManifestHash: string; planHash: string
}
type Entry = SyncedProtocol5Snapshot['records'][number]
type Entries = Map<string, Entry>
type Physical = { id: string; key: string; kind: 'document' | 'group'; ownerId: string; createdAt: string | null }
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(publicationCompare)
const tombstone = (record: SyncedProtocol5Record): boolean => record.kind === 'deleted' || record.kind === 'synced-group-deleted'
const hashData = (value: unknown): string => publicationHash(publicationJson(value))
const tuple = (group: SyncedGroupWire): string => publicationJson([group.id, group.creationId, group.createdAt, group.origin])
function index(snapshot: SyncedProtocol5Snapshot): Entries {
  const validated = validateSyncedProtocol5Snapshot(snapshot.manifest, snapshot.records.map(item => ({ key: item.key, record: item.record })))
  const result = new Map(validated.records.map(item => [item.key, item]))
  if (snapshot.records.some(item => result.get(item.key)?.hash !== item.hash)) return publicationInvalid('exchange快照条目不是原准确hash。')
  return result
}
function physical(records: Entries): Map<string, Physical> {
  const result = new Map<string, Physical>()
  for (const { key, record } of records.values()) {
    if (record.kind !== 'document' && record.kind !== 'synced-group') continue
    const kind = record.kind === 'document' ? 'document' : 'group', blocks = record.kind === 'document' ? record.content.blocks : record.blocks
    for (const block of blocks) {
      if (result.has(block.id)) return publicationInvalid('exchange原side有重复物理身份。')
      result.set(block.id, { id: block.id, key, kind, ownerId: record.id, createdAt: kind === 'group' ? (block as SyncedCanonicalWire).createdAt : null })
    }
  }
  return result
}
function snapshot(records: Entries, workspaceId: string): SyncedProtocol5Snapshot {
  const values = [...records.values()].sort((a, b) => publicationCompare(a.key, b.key)), groups = new Map<string, string>(), instances: SyncedProtocol5Snapshot['manifest']['syncedInstances'] = []
  for (const item of values) if (item.record.kind === 'synced-group') groups.set(item.record.id, item.hash)
  for (const { record } of values) if (record.kind === 'document') for (const block of record.content.blocks) if (block.type === 'synced-block') {
    const groupId = parseSyncedBlockPayload(block.content).groupId, groupHash = groups.get(groupId)
    if (!groupHash) return publicationInvalid('exchange候选叶指向不存在的live组。')
    instances.push({ documentId: record.id, instanceId: block.id, groupId, groupHash })
  }
  instances.sort((a, b) => publicationCompare(a.documentId, b.documentId) || publicationCompare(a.instanceId, b.instanceId))
  return validateSyncedProtocol5Snapshot({ version: 5, workspaceId, entries: Object.fromEntries(values.map(item => [item.key, item.hash])), syncedInstances: instances }, values.map(({ key, record }) => ({ key, record })))
}
function pathsValid(records: Entries): boolean {
  const siblings = new Set<string>()
  for (const { record } of records.values()) if (record.kind === 'document') {
    const key = publicationJson([record.parentId, record.content.title.replace(/[A-Z]/g, value => value.toLowerCase())])
    if (siblings.has(key)) return false
    siblings.add(key)
  }
  return true
}

export interface ExchangeDependencyFact { key: string; dependencyKeys: string[]; dependencySignature: string }
/** Exact original source topology. Only a complete strict snapshot can mint these data facts. */
export function deriveSyncedExchangeDependencyFacts(input: SyncedProtocol5Snapshot): ExchangeDependencyFact[] {
  const records = index(input), owners = physical(records), adjacent = new Map([...records.keys()].map(key => [key, new Set<string>()]))
  const edge = (left: string, right: string): void => {
    if (left === right || !records.has(left) || !records.has(right)) return
    adjacent.get(left)!.add(right); adjacent.get(right)!.add(left)
  }
  const catalog = records.get('databases')?.record
  for (const { key, record } of records.values()) {
    if (record.kind === 'document') {
      if (record.parentId !== null) edge(key, 'doc:' + record.parentId)
      for (const block of record.content.blocks) if (block.type === 'synced-block') edge(key, 'group:' + parseSyncedBlockPayload(block.content).groupId)
    } else if (record.kind === 'synced-group') {
      edge(key, 'doc:' + record.origin.documentId)
      const originOwner = owners.get(record.origin.firstInstanceId); if (originOwner) edge(key, originOwner.key)
      for (const binding of record.bindings) {
        if (binding.target.kind === 'block') { const owner = owners.get(binding.target.id); if (owner) edge(key, owner.key) }
        else if (binding.target.kind === 'document') edge(key, 'doc:' + binding.target.id)
        else if (binding.target.kind === 'heading') edge(key, 'doc:' + binding.target.documentId)
      }
    }
    const blocks = record.kind === 'document' ? record.content.blocks : record.kind === 'synced-group' ? record.blocks : []
    // Configuration strings remain opaque; only actual typed view source fields enter the graph.
    for (const block of blocks) if (block.type === 'database-view') edge(key, 'databases')
  }
  if (catalog?.kind === 'databases') {
    const entityDocuments = new Map(catalog.tables.database_entities.map(row => [row.id, row.document_id]))
    for (const rows of Object.values(catalog.tables)) for (const row of rows) {
      if (typeof row.document_id === 'string') edge('databases', 'doc:' + row.document_id)
      if (typeof row.entity_id === 'string') { const documentId = entityDocuments.get(row.entity_id); if (typeof documentId === 'string') edge('databases', 'doc:' + documentId) }
    }
  }
  return [...records.keys()].sort(publicationCompare).map(key => {
    const dependencyKeys = sorted(adjacent.get(key)!)
    // Exact wire hashes cover stable owner/block identities, canonical births, Origin and typed bindings.
    const dependencySignature = hashData({ kind: 'synced-exchange-dependencies', version: 1, key,
      hash: records.get(key)!.hash, dependencies: dependencyKeys.map(dependency => [dependency, records.get(dependency)!.hash]) })
    return { key, dependencyKeys, dependencySignature }
  })
}
export function deriveSyncedExchangeDependencies(input: SyncedProtocol5Snapshot): Map<string, string[]> {
  return new Map(deriveSyncedExchangeDependencyFacts(input).map(row => [row.key, row.dependencyKeys]))
}

/** Pure data planning, not a grant. Actual capture/receipt provenance and IMMEDIATE guards stay effectful/private. */
export function planSyncedExchange(input: ExchangePlanInput): ExchangePlan {
  if (!isSyncedUuid(input.operationId) || !digest(input.localFingerprint)) return publicationInvalid('exchange原操作/fingerprint无效。')
  const state = validateExchangeState(input.state), local = index(input.local), remote = index(input.remote)
  if (input.local.records.some(item => tombstone(item.record))) return publicationInvalid('本机持久snapshot不得伪成tombstone。')
  if (state.workspaceScope !== input.local.manifest.workspaceId || state.remoteWorkspaceId !== input.remote.manifest.workspaceId) return publicationInvalid('exchange原两workspace scope不符。')
  const baseline = new Map(state.baseline.map(row => [row.key, row])), base: Entries = new Map(), missingBase = new Set(input.authority.missingBaseKeys ?? [])
  for (const item of input.baseRecords) {
    if (base.has(item.key)) return publicationInvalid('exchange原B对象重复。')
    const record = validateSyncedProtocol5Record(item.record, item.key), hash = hashData(record), saved = baseline.get(item.key)
    if (hash !== item.hash || !saved || hash !== (saved.commonHash ?? saved.remoteHash)) return publicationInvalid('exchange B对象与原per-key共同来源不符。')
    base.set(item.key, { key: item.key, hash, record })
  }
  for (const row of state.baseline) if (!base.has(row.key)) {
    const expected = row.commonHash ?? row.remoteHash, actual = [local.get(row.key), remote.get(row.key)].find(item => item?.hash === expected)
    if (actual) base.set(row.key, actual)
    else missingBase.add(row.key)
  }
  const keys = sorted([...local.keys(), ...remote.keys(), ...baseline.keys()]), nodes = new Set(keys), adjacent = new Map(keys.map(key => [key, new Set<string>()]))
  function edge(left: string, right: string): void {
    if (left === right || !nodes.has(left) || !nodes.has(right)) return
    adjacent.get(left)!.add(right); adjacent.get(right)!.add(left)
  }
  // Exact historical dependency facts persist even when an old object can no longer be downloaded.
  for (const row of state.baseline) for (const dependency of row.dependencyKeys) {
    if (!baseline.has(dependency)) return publicationInvalid('exchange原baseline依赖没有对应原key。')
    edge(row.key, dependency)
  }
  for (const component of input.authority.historyComponents) for (let i = 1; i < component.length; i++) edge(component[0], component[i])
  const sides = [local, remote, base], physicalSides = sides.map(physical), owners = new Map<string, Set<string>>()
  for (const side of physicalSides) for (const item of side.values()) { const set = owners.get(item.id) ?? new Set<string>(); set.add(item.key); owners.set(item.id, set) }
  for (const identity of input.authority.identities) { const set = owners.get(identity.id); if (set) set.add((identity.last_owner_kind === 'group' ? 'group:' : 'doc:') + identity.last_owner_id) }
  for (const set of owners.values()) { const values = [...set]; for (let i = 1; i < values.length; i++) edge(values[0], values[i]) }
  const pathOwners = new Map<string, string[]>()
  for (const side of sides) for (const { key, record } of side.values()) {
    if (record.kind === 'document') {
      if (record.parentId !== null) edge(key, 'doc:' + record.parentId)
      const signature = publicationJson([record.parentId, record.content.title.replace(/[A-Z]/g, value => value.toLowerCase())]), siblings = pathOwners.get(signature) ?? []
      for (const sibling of siblings) edge(key, sibling)
      siblings.push(key); pathOwners.set(signature, siblings)
      for (const block of record.content.blocks) if (block.type === 'synced-block') edge(key, 'group:' + parseSyncedBlockPayload(block.content).groupId)
    } else if (record.kind === 'synced-group') {
      edge(key, 'doc:' + record.origin.documentId)
      for (const owner of owners.get(record.origin.firstInstanceId) ?? []) edge(key, owner)
      for (const binding of record.bindings) {
        if (binding.target.kind === 'block') for (const owner of owners.get(binding.target.id) ?? []) edge(key, owner)
        else if (binding.target.kind === 'document') edge(key, 'doc:' + binding.target.id)
        else if (binding.target.kind === 'heading') edge(key, 'doc:' + binding.target.documentId)
      }
    }
  }
  // Catalog is one atomic record. Connect changed rows and affected typed sources, not every unchanged doc.
  const catalogSides = sides.map(side => side.get('databases')).filter((item): item is Entry & { record: Extract<SyncedProtocol5Record, { kind: 'databases' }> } => item?.record.kind === 'databases')
  const entitySides = catalogSides.map(({ record }) => new Map(record.tables.database_entities.map(row => [row.id, row])))
  if (new Set(catalogSides.map(item => item.hash)).size > 1) {
    const rowVersions = new Map<string, Set<string>>(), rows = new Map<string, Array<Record<string, string | number | null>>>(), affectedDatabases = new Set<string>()
    for (const { record } of catalogSides) for (const [table, values] of Object.entries(record.tables)) for (const row of values) {
      const identity = publicationJson([table, row.id ?? row.document_id ?? row.entity_id, row.column_id ?? null]), versions = rowVersions.get(identity) ?? new Set<string>(), list = rows.get(identity) ?? []
      versions.add(publicationJson(row)); rowVersions.set(identity, versions); list.push(row); rows.set(identity, list)
    }
    for (const [identity, list] of rows) if (rowVersions.get(identity)!.size > 1 || list.length !== catalogSides.length) for (const row of list) {
      if (typeof row.document_id === 'string') edge('databases', 'doc:' + row.document_id)
      if (typeof row.database_id === 'string') affectedDatabases.add(row.database_id)
      if (typeof row.id === 'string' && identity.startsWith('["databases"')) affectedDatabases.add(row.id)
      if (typeof row.entity_id === 'string') for (const entities of entitySides) {
        const entity = entities.get(row.entity_id)
        if (typeof entity?.document_id === 'string') edge('databases', 'doc:' + entity.document_id)
      }
    }
    for (const side of sides) for (const { key, record } of side.values()) {
      const blocks = record.kind === 'document' ? record.content.blocks : record.kind === 'synced-group' ? record.blocks : []
      for (const block of blocks) if (block.type === 'database-view' && affectedDatabases.has(parseDatabaseViewPayload(block.content).databaseId)) edge(key, 'databases')
    }
  }
  const partitions: string[][] = [], visited = new Set<string>()
  for (const key of keys) if (!visited.has(key)) {
    const pending = [key], part: string[] = []; visited.add(key)
    for (let offset = 0; offset < pending.length; offset++) { const next = pending[offset]; part.push(next); for (const dependency of adjacent.get(next)!) if (!visited.has(dependency)) { visited.add(dependency); pending.push(dependency) } }
    partitions.push(part.sort(publicationCompare))
  }
  partitions.sort((a, b) => publicationCompare(publicationJson(a), publicationJson(b)))
  const identityMap = new Map(input.authority.identities.map(row => [row.id, row]))
  if (identityMap.size !== input.authority.identities.length) return publicationInvalid('exchange本机identity重复。')
  const keyGuards = new Map((input.authority.keyGuards ?? []).map(row => [row.key, row.fingerprint]))
  if (keyGuards.size !== (input.authority.keyGuards?.length ?? 0) || [...keyGuards.values()].some(fingerprint => !digest(fingerprint))) return publicationInvalid('exchange真实per-key guard重复或无效。')
  for (const key of keyGuards.keys()) exchangeRecordKey(key)
  const identityOwners = new Map<string, ExchangePlanIdentity[]>()
  for (const row of input.authority.identities) { const key = (row.last_owner_kind === 'group' ? 'group:' : 'doc:') + row.last_owner_id, rows = identityOwners.get(key) ?? []; rows.push(row); identityOwners.set(key, rows) }
  const identityDigests = new Map([...identityOwners].map(([key, rows]) => [key, hashData(rows.sort((a, b) => publicationCompare(a.id, b.id)))]))
  const occupiedDocs = new Set(input.authority.occupiedDocumentIds), knownGroups = new Set(input.authority.knownGroupIds ?? [])
  const localPhysical = physicalSides[0], nextRemote = new Map(remote), localFinal = new Map(local), deferred: DeferredExchangeComponent[] = [], components: ExchangeComponent[] = [], selectedParts: Array<{ component: ExchangeComponent; choices: Entries }> = []
  function signature(part: string[], side: Entries): string { return hashData(part.map(key => [key, side.get(key)?.hash ?? null])) }
  function dependencies(key: string): string[] { return sorted(adjacent.get(key) ?? []) }
  function dependencySignature(part: string[]): string {
    return hashData({ edges: part.map(key => [key, dependencies(key)]), identities: part.map(key => [key, identityDigests.get(key) ?? null]), guards: part.map(key => [key, keyGuards.get(key) ?? null]), baseline: part.map(key => { const row = baseline.get(key); return [key, row?.commonHash ?? row?.remoteHash ?? null] }) })
  }
  function transferPlan(part: string[], choices: Entries): { transfers: ExchangeTransfer[]; reason: ExchangeDeferredReason | null } {
    const transfers: ExchangeTransfer[] = [], chosenIds = new Set<string>()
    // Original L/R/B sides remain strict. Mixing valid choices may collide only in this component.
    for (const { record } of choices.values()) {
      const blocks = record.kind === 'document' ? record.content.blocks : record.kind === 'synced-group' ? record.blocks : []
      for (const block of blocks) {
        if (chosenIds.has(block.id)) return { transfers, reason: 'owner-source' }
        chosenIds.add(block.id)
      }
    }
    const after = physical(choices)
    for (const { key, record } of choices.values()) if (record.kind === 'document' && !local.has(key) && occupiedDocs.has(record.id)) return { transfers, reason: 'owner-source' }
    for (const { key, record } of choices.values()) if (record.kind === 'synced-group') {
      for (const side of [local, base]) { const old = side.get(key)?.record; if (old?.kind === 'synced-group' && tuple(old) !== tuple(record)) return { transfers, reason: 'incarnation' } }
      if (!local.has(key) && knownGroups.has(record.id)) return { transfers, reason: 'incarnation' }
    }
    for (const row of after.values()) {
      const old = localPhysical.get(row.id), ledger = identityMap.get(row.id)
      if (!old) { if (ledger) return { transfers, reason: ledger.created_at === null ? 'unknown-birth' : 'owner-source' }; continue }
      if (!ledger || ledger.state !== 'live' || ledger.last_owner_kind !== old.kind || ledger.last_owner_id !== old.ownerId || ledger.created_at === null) return { transfers, reason: 'unknown-birth' }
      if (old.kind === 'group' && old.createdAt !== ledger.created_at) return publicationInvalid('exchange当前canonical物理birth与ledger不符。')
      if (row.key === old.key) {
        if (row.kind === 'group' && row.createdAt !== ledger.created_at) {
          if (row.createdAt === null) return { transfers, reason: 'unknown-birth' }
          transfers.push({ id: row.id, fromKind: old.kind, fromId: old.ownerId, fromCreatedAt: ledger.created_at, toKind: row.kind, toId: row.ownerId, toCreatedAt: row.createdAt })
        }
        continue
      }
      if (!part.includes(old.key) || !choices.has(old.key)) return { transfers, reason: 'owner-source' }
      const targetBirth = row.kind === 'group' ? row.createdAt : ledger.created_at
      if (targetBirth === null) return { transfers, reason: 'unknown-birth' }
      // The explicit doc->canonical wire selection is the only birth replacement exception.
      if (targetBirth !== ledger.created_at && !(old.kind === 'document' && row.kind === 'group')) return { transfers, reason: 'unknown-birth' }
      transfers.push({ id: row.id, fromKind: old.kind, fromId: old.ownerId, fromCreatedAt: ledger.created_at, toKind: row.kind, toId: row.ownerId, toCreatedAt: targetBirth })
    }
    return { transfers, reason: null }
  }
  function catalogCollision(choices: Entries): boolean {
    if (input.authority.catalogId === 'catalog') return false
    for (const { key, record } of choices.values()) {
      if (record.kind === 'databases' && remote.get(key)?.hash === choices.get(key)?.hash && record.tables.databases.some(row => row.id === input.authority.catalogId)) return true
      const blocks = record.kind === 'document' ? record.content.blocks : record.kind === 'synced-group' ? record.blocks : []
      for (const block of blocks) if (block.type === 'database-view' && parseDatabaseViewPayload(block.content).databaseId === input.authority.catalogId) return true
    }
    return false
  }
  for (const part of partitions) {
    const component: ExchangeComponent = { keys: part, localSignature: signature(part, local), remoteSignature: signature(part, remote), dependencySignature: dependencySignature(part) }, choices: Entries = new Map()
    components.push(component)
    let reason: ExchangeDeferredReason | null = part.some(key => input.authority.deferredKeys?.includes(key)) ? 'dependency' : null
    for (const key of part) {
      if (reason) break
      const l = local.get(key), r = remote.get(key), b = baseline.get(key)
      if ([l, r, base.get(key)].some(item => item && tombstone(item.record))) { reason = 'tombstone'; break }
      if (b && !l) { reason = 'local-removal'; break }
      if (b && !r) { reason = 'tombstone'; break }
      if (l?.hash === r?.hash) { if (l) choices.set(key, l); continue }
      if (b && missingBase.has(key)) { reason = 'baseline-missing'; break }
      if (b && r?.hash === b.remoteHash && l) choices.set(key, l)
      else if (b && (l?.hash ?? null) === b.localHash && r) choices.set(key, r)
      else if (!b && l && !r) choices.set(key, l)
      else if (!b && r && !l) choices.set(key, r)
      else { reason = b ? 'diverged' : 'baseline-missing'; break }
    }
    if (!reason && catalogCollision(choices)) reason = 'catalog'
    if (!reason) reason = transferPlan(part, choices).reason
    if (reason) { deferred.push({ ...component, reason }); continue }
    selectedParts.push({ component, choices })
    for (const key of part) { const choice = choices.get(key); if (choice) { nextRemote.set(key, choice); localFinal.set(key, choice) } }
  }
  // Regular path validates both complete final graphs once. A failed mixed constraint is never half-applied.
  let next: SyncedProtocol5Snapshot, final: SyncedProtocol5Snapshot
  try {
    if (!pathsValid(nextRemote) || !pathsValid(localFinal)) return publicationInvalid('exchange混合候选路径冲突。')
    next = snapshot(nextRemote, input.remote.manifest.workspaceId); final = snapshot(localFinal, input.local.manifest.workspaceId)
  } catch (cause) {
    if (!(cause instanceof SyncedPublicationError) && !(cause instanceof SyncedValidationError)) throw cause
    // Identify failing components against a valid retained graph; independent components still settle.
    const pending = [...selectedParts]; selectedParts.length = 0; nextRemote.clear(); localFinal.clear()
    for (const [key, value] of remote) nextRemote.set(key, value)
    for (const [key, value] of local) localFinal.set(key, value)
    for (const item of pending) {
      const trialRemote = new Map(nextRemote), trialLocal = new Map(localFinal)
      for (const [key, value] of item.choices) { trialRemote.set(key, value); trialLocal.set(key, value) }
      try {
        if (!pathsValid(trialRemote) || !pathsValid(trialLocal)) return publicationInvalid('exchange该分量混合路径冲突。')
        snapshot(trialRemote, input.remote.manifest.workspaceId); snapshot(trialLocal, input.local.manifest.workspaceId)
        for (const [key, value] of item.choices) { nextRemote.set(key, value); localFinal.set(key, value) }
        selectedParts.push(item)
      } catch (error) {
        if (!(error instanceof SyncedPublicationError) && !(error instanceof SyncedValidationError)) throw error
        deferred.push({ ...item.component, reason: !pathsValid(trialRemote) || !pathsValid(trialLocal) ? 'path' : item.component.keys.includes('databases') ? 'catalog' : 'dependency' })
      }
    }
    next = snapshot(nextRemote, input.remote.manifest.workspaceId); final = snapshot(localFinal, input.local.manifest.workspaceId)
  }
  const accepted = sorted(selectedParts.flatMap(row => row.component.keys)), acceptedSet = new Set(accepted), writes = accepted.filter(key => nextRemote.get(key)?.hash !== remote.get(key)?.hash), incoming = accepted.filter(key => localFinal.get(key)?.hash !== local.get(key)?.hash)
  const transfers = selectedParts.flatMap(row => transferPlan(row.component.keys, row.choices).transfers).sort((a, b) => publicationCompare(a.id, b.id))
  const finalDependencyFacts = new Map(deriveSyncedExchangeDependencyFacts(final).map(row => [row.key, row]))
  const acceptedSides: ExchangeAcceptedSide[] = accepted.map(key => {
    const fact = finalDependencyFacts.get(key)!
    return { key, beforeLocalHash: local.get(key)?.hash ?? null, beforeRemoteHash: remote.get(key)?.hash ?? null,
      afterHash: nextRemote.get(key)!.hash, dependencyKeys: fact.dependencyKeys, dependencySignature: fact.dependencySignature }
  })
  const updates = new Map(state.baseline.map(row => [row.key, row]))
  for (const row of acceptedSides) updates.set(row.key, { key: row.key, localHash: row.afterHash, remoteHash: row.afterHash, commonHash: row.afterHash, dependencyKeys: row.dependencyKeys, dependencySignature: row.dependencySignature, acceptedOperationId: input.operationId })
  const historyBoundaryKeys = sorted(incoming.filter(key => key.startsWith('doc:') || key.startsWith('group:')))
  const historyAdjacency = new Map<string, Set<string>>()
  for (const history of input.authority.historyComponents) for (const key of history) {
    const neighbors = historyAdjacency.get(key) ?? new Set<string>()
    if (history.length) { neighbors.add(history[0]); const root = historyAdjacency.get(history[0]) ?? new Set<string>(); root.add(key); historyAdjacency.set(history[0], root) }
    historyAdjacency.set(key, neighbors)
  }
  const historySeen = new Set(historyBoundaryKeys)
  for (let offset = 0; offset < historyBoundaryKeys.length; offset++) for (const key of historyAdjacency.get(historyBoundaryKeys[offset]) ?? []) if (acceptedSet.has(key) && !historySeen.has(key)) { historySeen.add(key); historyBoundaryKeys.push(key) }
  const result = { nextRemote: next, localFinal: final, writes, incoming, accepted, components, deferred: deferred.sort((a, b) => publicationCompare(publicationJson(a.keys), publicationJson(b.keys))), transfers, historyBoundaryKeys: sorted(historyBoundaryKeys), acceptedSides, nextBaseline: [...updates.values()].sort((a, b) => publicationCompare(a.key, b.key)), localFingerprint: input.localFingerprint, beforeManifestHash: hashData(input.remote.manifest), afterManifestHash: hashData(next.manifest) }
  return { ...result, planHash: hashData({ kind: 'synced-exchange-plan', version: 1, operationId: input.operationId, workspaceScope: state.workspaceScope, recoveryEpoch: state.recoveryEpoch, localFingerprint: input.localFingerprint, beforeManifestHash: result.beforeManifestHash, afterManifestHash: result.afterManifestHash, nextEntries: next.manifest.entries, finalEntries: final.manifest.entries, acceptedSides, deferred: result.deferred, transfers, historyBoundaryKeys: result.historyBoundaryKeys }) }
}
