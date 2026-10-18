import type { SyncedCanonicalWire, SyncedGroupWire, SyncedLinkTarget } from '../../shared/synced-blocks'
import { parseSyncedBlockPayload, SyncedValidationError } from '../../shared/syncedBlockValidation'
import { planSyncedBothFork } from './synced-exchange-fork'
import { planSyncedExchange, deriveSyncedExchangeDependencyFacts, type ExchangePlanInput, type ExchangePlan } from './synced-exchange-plan'
import type { ExchangeComponent, ExchangeTransfer, ExchangeDeferredReason } from './synced-exchange-model'
import type * as T from './synced-exchange-both-types'
import type { BothPrivateSelection } from './synced-exchange-both-model'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson, SyncedPublicationError } from './synced-publication-model'
import { validateSyncedProtocol5Snapshot, type SyncedProtocol5Snapshot } from './synced-protocol5-model'

type Entry = SyncedProtocol5Snapshot['records'][number]
type Entries = Map<string, Entry>
export interface BothComponentFacts {
  component: T.SyncedBothSourceComponent; records: T.SyncedExchangeBothRecordSource[]
  conflictedKeys: string[]; selectedOriginal: SyncedProtocol5Snapshot | null; reason: ExchangeDeferredReason | null
}
export interface BothExchangePlan extends Omit<ExchangePlan, 'plannerVersion'> {
  plannerVersion: 'forks-v1'; forks: T.SyncedBothForkProof[]; projections: T.SyncedBothLinkProjection[]
}
const hash = (value: unknown): string => publicationHash(publicationJson(value))
const sort = (value: Iterable<string>): string[] => [...new Set(value)].sort(publicationCompare)
const entries = (snapshot: SyncedProtocol5Snapshot): Entries => new Map(snapshot.records.map(row => [row.key, row]))
function snapshot(values: Entries, workspaceId: string): SyncedProtocol5Snapshot {
  const rows = [...values.values()].sort((a, b) => publicationCompare(a.key, b.key)), groups = new Map(rows.flatMap(row => row.record.kind === 'synced-group' ? [[row.record.id, row.hash] as const] : []))
  const siblings = new Set<string>()
  for (const { record } of rows) if (record.kind === 'document') {
    const title = record.content.title, key = publicationJson([record.parentId, title.replace(/[A-Z]/g, letter => letter.toLowerCase())])
    if (title !== title.trim() || siblings.has(key)) return publicationInvalid('both候选标题/path不属于实际SQL可执行规则。')
    siblings.add(key)
  }
  const syncedInstances: SyncedProtocol5Snapshot['manifest']['syncedInstances'] = []
  for (const { record } of rows) if (record.kind === 'document') for (const block of record.content.blocks) if (block.type === 'synced-block') {
    const groupId = parseSyncedBlockPayload(block.content).groupId, groupHash = groups.get(groupId)
    if (!groupHash) return publicationInvalid('both候选引用缺少live组。')
    syncedInstances.push({ documentId: record.id, instanceId: block.id, groupId, groupHash })
  }
  syncedInstances.sort((a, b) => publicationCompare(a.documentId, b.documentId) || publicationCompare(a.instanceId, b.instanceId))
  return validateSyncedProtocol5Snapshot({ version: 5, workspaceId, entries: Object.fromEntries(rows.map(row => [row.key, row.hash])), syncedInstances }, rows.map(({ key, record }) => ({ key, record })))
}
function physical(snapshot: SyncedProtocol5Snapshot): Map<string, { key: string; kind: 'document' | 'group'; ownerId: string; birth: string | null }> {
  const result = new Map<string, { key: string; kind: 'document' | 'group'; ownerId: string; birth: string | null }>()
  for (const { key, record } of snapshot.records) {
    if (record.kind !== 'document' && record.kind !== 'synced-group') continue
    for (const block of record.kind === 'document' ? record.content.blocks : record.blocks) {
      if (result.has(block.id)) return publicationInvalid('both图有重复物理ID。')
      result.set(block.id, { key, kind: record.kind === 'document' ? 'document' : 'group', ownerId: record.id, birth: record.kind === 'synced-group' ? (block as SyncedCanonicalWire).createdAt : null })
    }
  }
  return result
}
function targetKey(target: SyncedLinkTarget, owners: ReturnType<typeof physical>, identities: ReadonlyMap<string, ExchangePlanInput['authority']['identities'][number]>): string | null {
  if (target.kind === 'document') return 'doc:' + target.id
  if (target.kind === 'heading') return 'doc:' + target.documentId
  if (target.kind !== 'block') return null
  const actual = owners.get(target.id)
  if (actual) return actual.key
  const retained = identities.get(target.id)
  return retained?.last_owner_kind === 'document' ? 'doc:' + retained.last_owner_id : retained?.last_owner_kind === 'group' ? 'group:' + retained.last_owner_id : null
}
/** Actual plain-source targets add dependencies; private facts never enter caller inputs. */
export function deriveBothComponents(input: ExchangePlanInput, sourceLinks: T.SyncedBothOwnerSourceLinks[]): BothComponentFacts[] {
  const normal = planSyncedExchange({ ...input, conflictSelections: [] }), local = entries(input.local), remote = entries(input.remote), baseline = new Map(input.state.baseline.map(row => [row.key, row]))
  const nodes = new Set([...local.keys(), ...remote.keys(), ...baseline.keys()]), graph = new Map([...nodes].map(key => [key, new Set<string>()]))
  const connect = (a: string, b: string): void => { if (a !== b && graph.has(a) && graph.has(b)) { graph.get(a)!.add(b); graph.get(b)!.add(a) } }
  for (const component of normal.components) for (let index = 1; index < component.keys.length; index++) connect(component.keys[0], component.keys[index])
  const owners = physical(input.local), identities = new Map(input.authority.identities.map(row => [row.id, row]))
  for (const owner of sourceLinks) for (const link of owner.links) { const target = targetKey(link.target, owners, identities); if (target) connect(owner.ownerKey, target) }
  const visited = new Set<string>(), guards = new Map(input.authority.keyGuards?.map(row => [row.key, row.fingerprint]) ?? [])
  const normalByKey = new Map(normal.components.flatMap(row => row.keys.map(key => [key, row] as const))), reasonByKey = new Map(normal.deferred.flatMap(row => row.keys.map(key => [key, row.reason] as const)))
  const sourceByOwner = new Map(sourceLinks.map(row => [row.ownerKey, row]))
  const result: BothComponentFacts[] = []
  for (const start of sort(nodes)) {
    if (visited.has(start)) continue
    const pending = [start], keys: string[] = []
    while (pending.length) { const key = pending.pop()!; if (visited.has(key)) continue; visited.add(key); keys.push(key); pending.push(...graph.get(key)!) }
    keys.sort(publicationCompare)
    const keySet = new Set(keys), records = keys.map(key => ({ key, baseHash: baseline.get(key)?.commonHash ?? null, localHash: local.get(key)?.hash ?? null, remoteHash: remote.get(key)?.hash ?? null }))
    const conflictedKeys = keys.filter(key => {
      const l = local.get(key), r = remote.get(key), b = baseline.get(key)
      return Boolean(l && r && l.hash !== r.hash && !(b && (l.hash === b.localHash || r.hash === b.remoteHash)))
    })
    const component: T.SyncedBothSourceComponent = {
      keys, localSignature: hash(keys.map(key => [key, local.get(key)?.hash ?? null])), remoteSignature: hash(keys.map(key => [key, remote.get(key)?.hash ?? null])),
      dependencySignature: hash({ keys, old: [...new Set(keys.map(key => normalByKey.get(key)).filter(row => row !== undefined))], guards: keys.map(key => [key, guards.get(key) ?? null]),
        sources: keys.flatMap(key => sourceByOwner.has(key) ? [sourceByOwner.get(key)!] : []), baseline: keys.flatMap(key => baseline.has(key) ? [baseline.get(key)!] : []) }), componentId: ''
    }
    component.componentId = hash({ component: { keys: component.keys, localSignature: component.localSignature, remoteSignature: component.remoteSignature, dependencySignature: component.dependencySignature }, records })
    let reason: ExchangeDeferredReason | null = keys.map(key => reasonByKey.get(key)).find(reason => reason !== undefined && reason !== 'diverged') ?? null
    const selected = new Map(remote)
    for (const key of keys) {
      const l = local.get(key), r = remote.get(key), b = baseline.get(key)
      let choice: Entry | undefined
      if (l?.hash === r?.hash) choice = l
      else if (b && r?.hash === b.remoteHash) choice = l
      else if (b && (l?.hash ?? null) === b.localHash) choice = r
      else if (!b && l && !r) choice = l
      else choice = r
      if (choice) selected.set(key, choice)
      else selected.delete(key)
    }
    let selectedOriginal: SyncedProtocol5Snapshot | null = null
    if (conflictedKeys.length && !reason) try { selectedOriginal = snapshot(selected, input.remote.manifest.workspaceId) }
    catch (cause) { if (cause instanceof SyncedPublicationError || cause instanceof SyncedValidationError) reason ??= 'dependency'; else throw cause }
    result.push({ component, records, conflictedKeys, selectedOriginal, reason })
  }
  return result
}
function transfersFor(input: ExchangePlanInput, after: SyncedProtocol5Snapshot, accepted: Set<string>): { transfers: ExchangeTransfer[]; reason: ExchangeDeferredReason | null } {
  const before = physical(input.local), next = physical(after), ledger = new Map(input.authority.identities.map(row => [row.id, row])), transfers: ExchangeTransfer[] = []
  const local = entries(input.local), occupied = new Set(input.authority.occupiedDocumentIds), known = new Set(input.authority.knownGroupIds ?? [])
  for (const { key, record } of after.records) if (accepted.has(key)) {
    if (record.kind === 'document' && !local.has(key) && occupied.has(record.id)) return { transfers, reason: 'owner-source' }
    if (record.kind === 'synced-group') {
      const old = local.get(key)?.record
      if (old?.kind === 'synced-group' && publicationJson([old.creationId, old.createdAt, old.origin]) !== publicationJson([record.creationId, record.createdAt, record.origin])) return { transfers, reason: 'incarnation' }
      if (!old && known.has(record.id)) return { transfers, reason: 'incarnation' }
    }
  }
  for (const [id, row] of next) if (accepted.has(row.key)) {
    const original = before.get(id), identity = ledger.get(id)
    if (!original) { if (identity) return { transfers, reason: identity.created_at === null ? 'unknown-birth' : 'owner-source' }; continue }
    if (!identity || identity.state !== 'live' || identity.last_owner_kind !== original.kind || identity.last_owner_id !== original.ownerId || identity.created_at === null) return { transfers, reason: 'unknown-birth' }
    if (original.kind === 'group' && original.birth !== identity.created_at) return publicationInvalid('both当前canonical birth与实际ledger不一致。')
    const birth = row.kind === 'group' ? row.birth : identity.created_at
    if (birth === null) return { transfers, reason: 'unknown-birth' }
    if (row.key !== original.key && !accepted.has(original.key)) return { transfers, reason: 'owner-source' }
    if (birth !== identity.created_at && !(original.kind === 'document' && row.kind === 'group') && !(row.key === original.key && row.kind === 'group')) return { transfers, reason: 'unknown-birth' }
    if (row.key !== original.key || birth !== identity.created_at) transfers.push({ id, fromKind: original.kind, fromId: original.ownerId, fromCreatedAt: identity.created_at, toKind: row.kind, toId: row.ownerId, toCreatedAt: birth })
  }
  return { transfers: transfers.sort((a, b) => publicationCompare(a.id, b.id)), reason: null }
}
export function planSyncedBothExchange(input: ExchangePlanInput, selections: BothPrivateSelection[], currentLinks: T.SyncedBothOwnerSourceLinks[]): BothExchangePlan {
  const facts = deriveBothComponents(input, currentLinks), oldSelected = new Set(selections.flatMap(row => row.component.keys))
  const selectedKeys = sort(facts.filter(row => row.component.keys.some(key => oldSelected.has(key))).flatMap(row => row.component.keys)), selectedSet = new Set(selectedKeys)
  const normal = planSyncedExchange({ ...input, authority: { ...input.authority, deferredKeys: sort([...(input.authority.deferredKeys ?? []), ...selectedKeys]) }, conflictSelections: [] })
  let localFinal = normal.localFinal, nextRemote = normal.nextRemote
  const accepted = new Set(normal.accepted), forks: T.SyncedBothForkProof[] = [], projections: T.SyncedBothLinkProjection[] = []
  const deferred = normal.deferred.filter(row => !row.keys.some(key => selectedSet.has(key))), normalAccepted = new Set(normal.accepted)
  const acceptedParts: ExchangeComponent[] = normal.components.filter(row => row.keys.some(key => normalAccepted.has(key)) && !row.keys.some(key => selectedSet.has(key)))
  const currentByKey = new Map(facts.flatMap(row => row.component.keys.map(key => [key, row] as const)))
  const processed = new Set<string>()
  for (const selection of selections) {
    const actual = currentByKey.get(selection.component.keys[0]), same = actual && actual.component.componentId === selection.component.componentId
    const component = actual?.component ?? selection.component
    if (processed.has(component.componentId)) continue
    processed.add(component.componentId)
    let reason: ExchangeDeferredReason | null = !same || !actual ? 'dependency' : actual.reason
    if (!reason && actual?.selectedOriginal) {
      const result = planSyncedBothFork({ local: input.local, remote: input.remote, selectedOriginal: actual.selectedOriginal, conflictedKeys: actual.conflictedKeys,
        component, sourceLinks: currentLinks, retainedLocal: localFinal, retainedRemote: nextRemote, decision: selection.decision, allocation: selection.allocation })
      if (result.status === 'planned') {
        const keys = sort([...component.keys, ...result.fork.results.map(row => row.key)]), candidateAccepted = new Set([...accepted, ...keys])
        const ownership = transfersFor(input, result.localFinal, candidateAccepted)
        if (!ownership.reason) { localFinal = result.localFinal; nextRemote = result.nextRemote; keys.forEach(key => accepted.add(key)); forks.push(result.fork); projections.push(...result.projections)
          acceptedParts.push({ keys, localSignature: component.localSignature, remoteSignature: component.remoteSignature, dependencySignature: component.dependencySignature }); continue }
        reason = ownership.reason
      } else reason = result.reason === 'semantic-binding' || result.reason === 'budget' ? 'dependency' : result.reason
    }
    deferred.push({ keys: component.keys, localSignature: component.localSignature, remoteSignature: component.remoteSignature, dependencySignature: component.dependencySignature, reason: reason ?? 'dependency' })
  }
  const l = entries(input.local), r = entries(input.remote), afterL = entries(localFinal), afterR = entries(nextRemote)
  const acceptedKeys = sort(accepted), writes = acceptedKeys.filter(key => r.get(key)?.hash !== afterR.get(key)?.hash), incoming = acceptedKeys.filter(key => l.get(key)?.hash !== afterL.get(key)?.hash)
  const dependencyFacts = new Map(deriveSyncedExchangeDependencyFacts(nextRemote).map(row => [row.key, row])), finalOwners = physical(nextRemote)
  const edges = new Map([...dependencyFacts].map(([key, row]) => [key, new Set(row.dependencyKeys)]))
  const identities = new Map(input.authority.identities.map(row => [row.id, row]))
  for (const row of projections) { const target = targetKey(row.target, finalOwners, identities)
    if (target && target !== row.destinationOwnerKey && edges.has(target) && edges.has(row.destinationOwnerKey)) { edges.get(target)!.add(row.destinationOwnerKey); edges.get(row.destinationOwnerKey)!.add(target) } }
  const sides = acceptedKeys.map(key => {
    const left = afterL.get(key), right = afterR.get(key), fact = dependencyFacts.get(key)
    if (!left || !right || left.hash !== right.hash || !fact) return publicationInvalid('both accepted图两侧不闭合。')
    const dependencyKeys = sort(edges.get(key) ?? [])
    return { key, beforeLocalHash: l.get(key)?.hash ?? null, beforeRemoteHash: r.get(key)?.hash ?? null, afterHash: left.hash, dependencyKeys,
      dependencySignature: hash({ wire: fact.dependencySignature, dependencies: dependencyKeys.map(id => [id, afterR.get(id)?.hash ?? null]), forks: forks.filter(row => row.results.some(item => item.key === key)) }) }
  })
  const baseline = new Map(input.state.baseline.map(row => [row.key, row]))
  for (const side of sides) baseline.set(side.key, { key: side.key, localHash: side.afterHash, remoteHash: side.afterHash, commonHash: side.afterHash,
    dependencyKeys: side.dependencyKeys, dependencySignature: side.dependencySignature, acceptedOperationId: input.operationId })
  const ownership = transfersFor(input, localFinal, accepted)
  if (ownership.reason) return publicationInvalid('both最终wholegraph身份授权与逐组件验证不一致。')
  const components: ExchangeComponent[] = [...acceptedParts, ...deferred].map(({ keys, localSignature, remoteSignature, dependencySignature }) => ({ keys, localSignature, remoteSignature, dependencySignature }))
    .sort((a, b) => publicationCompare(publicationJson(a.keys), publicationJson(b.keys)))
  forks.sort((a, b) => publicationCompare(a.componentId, b.componentId))
  const result: BothExchangePlan = { nextRemote, localFinal, writes, incoming, accepted: acceptedKeys, components, deferred: deferred.sort((a, b) => publicationCompare(publicationJson(a.keys), publicationJson(b.keys))),
    transfers: ownership.transfers, historyBoundaryKeys: incoming, acceptedSides: sides, nextBaseline: [...baseline.values()].sort((a, b) => publicationCompare(a.key, b.key)), localFingerprint: input.localFingerprint,
    beforeManifestHash: hash(input.remote.manifest), afterManifestHash: hash(nextRemote.manifest), plannerVersion: 'forks-v1', merges: normal.merges ?? [], forks, projections, planHash: '' }
  const sharedHashes=new WeakMap<object,string>()
  const sharedHash=(value:object):string=>{let digest=sharedHashes.get(value);if(digest===undefined){digest=hash(value);sharedHashes.set(value,digest)}return digest}
  const selectedFacts=selections.map(({preview,decision,component,allocation,poolAllocation,sourceLinks,conflictedKeys})=>({preview,decision,component,
    allocationHash:sharedHash(allocation),poolAllocationHash:sharedHash(poolAllocation),sourceLinksHash:sharedHash(sourceLinks),conflictedKeys}))
  result.planHash = hash({ ...result, nextRemote: { manifest: nextRemote.manifest, records: nextRemote.records }, localFinal: { manifest: localFinal.manifest, records: localFinal.records },
    source: input.state.source, sourceState: input.state, authority: input.authority, selections:selectedFacts })
  return result
}
