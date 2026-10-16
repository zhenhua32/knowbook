import type { SyncedBindingClaim } from '@shared/synced-blocks'

// Leaf resource bookkeeping only. No Markdown, Main port or caller callbacks.
export interface CopyDomain { readonly kind: 'source-copy-domain' }
export interface DomainIssuer { readonly kind: 'source-copy-domain-issuer' }
export interface Consumer { readonly kind: 'source-copy-consumer' }
export interface ConsumerIssuer { readonly kind: 'source-copy-consumer-issuer' }
export interface WitnessLease { readonly kind: 'source-copy-witness' }
export interface PreparedBatch { readonly kind: 'source-copy-prepared' }
export interface ApplyReservation { readonly kind: 'source-copy-reservation' }
export interface FramePlan { readonly kind: 'source-copy-plan' }
export interface FrameLease { readonly kind: 'source-copy-frame' }
export interface PendingLease { readonly kind: 'source-copy-pending' }
type Claims = readonly Readonly<SyncedBindingClaim>[]
type Domain = { pins: number; waiters: Array<() => void> }
type Source = Readonly<{ domain: CopyDomain; ticketId: string; entryId: string }>
type Owner = { consumer: Consumer; closed: boolean; witnesses: Set<WitnessLease>; batches: Set<PreparedBatch>; plans: Set<FramePlan> }
type Holding = { sources: readonly Source[]; live: boolean }
type Batch = Holding & { owner: Owner; preparation: object; claims: readonly string[]; reservation: ApplyReservation | null; accepted: boolean }
type Plan = Holding & { incoming: ApplyReservation | null; old: FrameLease | null; action: 'push' | 'replace-tail' | 'pop-tail' }
const domains = new WeakMap<CopyDomain, Domain>(), issuers = new WeakMap<DomainIssuer, CopyDomain>()
const consumers = new WeakMap<ConsumerIssuer, Owner>(), consumerDomains = new WeakMap<Consumer, CopyDomain>()
const witnesses = new WeakMap<WitnessLease, Holding & { owner: Owner }>(), batches = new WeakMap<PreparedBatch, Batch>()
const reservations = new WeakMap<ApplyReservation, { batch: PreparedBatch; live: boolean }>(), plans = new WeakMap<FramePlan, Plan>()
const frames = new WeakMap<FrameLease, Holding>(), pending = new WeakMap<PendingLease, Holding & { version: object; input: object; operationId: string }>()
const atom = (value: string) => `${value.length}:${value}`
const sourceId = (value: { ticketId: string; entryId: string }) => atom(value.ticketId) + atom(value.entryId)
function ticketClaims(claims: Claims): string[] {
  return claims.flatMap(claim => claim.kind === 'copy' && claim.source.kind === 'ticket' ? [sourceId(claim.source)
    + atom(claim.destination.blockId) + atom(String(claim.destination.from)) + atom(String(claim.destination.to))
    + atom(claim.destination.raw) + atom(claim.destination.syntax)] : [])
}
function sourcesFor(claims: Claims, pool: readonly Source[], requireAll: boolean): readonly Source[] | null {
  const indexed = new Map(pool.map(source => [sourceId(source), source])), result = new Map<string, Source>()
  for (const claim of claims) if (claim.kind === 'copy' && claim.source.kind === 'ticket') {
    const id = sourceId(claim.source), source = indexed.get(id)
    if (!source) { if (requireAll) return null; continue }
    result.set(id, source)
  }
  return Object.freeze([...result.values()])
}
function pin(sources: readonly Source[]): void { for (const domain of new Set(sources.map(source => source.domain))) domains.get(domain)!.pins++ }
function drop(holding: Holding | undefined): void {
  if (!holding?.live) return
  holding.live = false
  for (const domain of new Set(holding.sources.map(source => source.domain))) {
    const state = domains.get(domain)!
    if (--state.pins === 0) for (const resolve of state.waiters.splice(0)) resolve()
  }
}
export function createDomain(): { domain: CopyDomain; issuer: DomainIssuer } {
  const domain: CopyDomain = Object.freeze({ kind: 'source-copy-domain' }), issuer: DomainIssuer = Object.freeze({ kind: 'source-copy-domain-issuer' })
  domains.set(domain, { pins: 0, waiters: [] }); issuers.set(issuer, domain)
  return { domain, issuer }
}
export function createConsumer(issuer: DomainIssuer): { consumer: Consumer; issuer: ConsumerIssuer } {
  const domain = issuers.get(issuer)
  if (!domain) throw new Error('Unknown source copy domain issuer.')
  const consumer: Consumer = Object.freeze({ kind: 'source-copy-consumer' }), key: ConsumerIssuer = Object.freeze({ kind: 'source-copy-consumer-issuer' })
  consumers.set(key, { consumer, closed: false, witnesses: new Set(), batches: new Set(), plans: new Set() }); consumerDomains.set(consumer, domain)
  return { consumer, issuer: key }
}
export function issueWitness(issuer: ConsumerIssuer, source: { ticketId: string; entryId: string }): WitnessLease | null {
  const owner = consumers.get(issuer), domain = owner && consumerDomains.get(owner.consumer)
  if (!owner || owner.closed || !domain) return null
  const value: WitnessLease = Object.freeze({ kind: 'source-copy-witness' })
  const sources = Object.freeze([Object.freeze({ domain, ticketId: source.ticketId, entryId: source.entryId })])
  pin(sources); witnesses.set(value, { owner, sources, live: true }); owner.witnesses.add(value)
  return value
}
export function sealPreparedBatch(preparation: object, values: readonly WitnessLease[], claims: Claims): PreparedBatch | null {
  const records = values.map(value => witnesses.get(value)), owner = records[0]?.owner
  if (!owner || owner.closed || records.some(record => !record?.live || record.owner !== owner)) return null
  const sources = sourcesFor(claims, records.flatMap(record => record!.sources), true)
  if (!sources?.length) return null
  const value: PreparedBatch = Object.freeze({ kind: 'source-copy-prepared' })
  pin(sources); batches.set(value, { owner, preparation, sources, live: true, claims: Object.freeze(ticketClaims(claims)), reservation: null, accepted: false }); owner.batches.add(value)
  return value
}
export function reserveApply(domain: CopyDomain, value: PreparedBatch, preparation: object, claims: Claims): ApplyReservation | null {
  const batch = batches.get(value), actual = ticketClaims(claims)
  if (!domains.has(domain) || !batch?.live || batch.owner.closed || batch.preparation !== preparation || batch.reservation
    || batch.sources.some(source => source.domain !== domain) || actual.length !== batch.claims.length
    || actual.some((claim, index) => claim !== batch.claims[index])) return null
  const reservation: ApplyReservation = Object.freeze({ kind: 'source-copy-reservation' })
  reservations.set(reservation, { batch: value, live: true }); batch.reservation = reservation
  return reservation
}
export function planFrameUpdate(input: { action: 'push' | 'replace-tail' | 'pop-tail'; old: FrameLease | null;
  incoming: ApplyReservation | null; finalClaims: Claims }): FramePlan | null {
  const old = input.old && frames.get(input.old), reserved = input.incoming && reservations.get(input.incoming)
  const batch = reserved && batches.get(reserved.batch)
  if (input.old && !old?.live || input.incoming && (!reserved?.live || !batch?.live || batch.owner.closed)) return null
  // Existing public/legacy tickets keep their old lifetime. They do not mint
  // owned provenance here; Source's incoming owned claims require full pool
  // coverage in sealPreparedBatch, and composed owned claims inherit old.
  const sources = input.action === 'pop-tail' ? Object.freeze([]) : sourcesFor(input.finalClaims,
    [...(old?.sources ?? []), ...(batch?.sources ?? [])], false)!
  const value: FramePlan = Object.freeze({ kind: 'source-copy-plan' })
  pin(sources); plans.set(value, { action: input.action, old: input.old, incoming: input.incoming, sources, live: true })
  batch?.owner.plans.add(value)
  return value
}
export function cancelPlan(value: FramePlan): void {
  const plan = plans.get(value)
  if (!plan?.live) return
  drop(plan)
  const reservation = plan.incoming && reservations.get(plan.incoming), batch = reservation && batches.get(reservation.batch)
  if (reservation) reservation.live = false
  if (batch) { batch.reservation = null; batch.owner.plans.delete(value) }
}
export function commitFramePlan(value: FramePlan): { status: 'committed'; lease: FrameLease | null } | { status: 'refused' } {
  const plan = plans.get(value), reservation = plan?.incoming && reservations.get(plan.incoming), batch = reservation && batches.get(reservation.batch)
  if (!plan?.live || plan.old && !frames.get(plan.old)?.live || plan.incoming && (!reservation?.live || !batch?.live || batch.owner.closed)) return { status: 'refused' }
  let lease: FrameLease | null = null
  if (plan.sources.length) {
    lease = Object.freeze({ kind: 'source-copy-frame' }); frames.set(lease, { sources: Object.freeze([...plan.sources]), live: true })
    // The plan's pin moves to the actual frame; no callback/refcount gap.
  }
  plan.live = false
  if (plan.old) dropFrame(plan.old)
  if (reservation && batch) {
    reservation.live = false; batch.owner.plans.delete(value); batch.reservation = null
    batch.accepted = true
    discardPrepared(reservation.batch)
  }
  return { status: 'committed', lease }
}
export function pinPending(value: FrameLease, identity: { version: object; input: object; operationId: string }): PendingLease | null {
  const frame = frames.get(value)
  if (!frame?.live) return null
  const lease: PendingLease = Object.freeze({ kind: 'source-copy-pending' }), sources = Object.freeze([...frame.sources])
  pin(sources); pending.set(lease, { ...identity, sources, live: true }); return lease
}
export function pendingMatches(value: PendingLease, identity: { version: object; input: object; operationId: string }): boolean {
  const lease = pending.get(value)
  return !!lease?.live && lease.version === identity.version && lease.input === identity.input && lease.operationId === identity.operationId
}
export function dropWitness(value: WitnessLease): void { const state = witnesses.get(value); drop(state); state?.owner.witnesses.delete(value) }
export function readWitnessSource(value: WitnessLease): Readonly<{ ticketId: string; entryId: string }> | null {
  const state = witnesses.get(value)
  return state?.live && !state.owner.closed ? Object.freeze({ ticketId: state.sources[0].ticketId, entryId: state.sources[0].entryId }) : null
}
export function preparedBatchLive(value: PreparedBatch): boolean { const state = batches.get(value); return !!state?.live && !state.owner.closed }
export function preparedBatchAccepted(value: PreparedBatch): boolean { return batches.get(value)?.accepted ?? false }
export function cancelReservation(value: ApplyReservation): void {
  const state = reservations.get(value), batch = state && batches.get(state.batch)
  if (state) state.live = false
  if (batch?.reservation === value) batch.reservation = null
}
export function discardPrepared(value: PreparedBatch): void {
  const state = batches.get(value)
  if (state?.reservation) { const reservation = reservations.get(state.reservation); if (reservation) reservation.live = false; state.reservation = null }
  drop(state); state?.owner.batches.delete(value)
}
export function dropFrame(value: FrameLease): void { drop(frames.get(value)) }
export function dropPending(value: PendingLease): void { drop(pending.get(value)) }
export function revokeConsumer(issuer: ConsumerIssuer): void {
  const owner = consumers.get(issuer)
  if (!owner || owner.closed) return
  owner.closed = true
  for (const value of [...owner.plans]) cancelPlan(value)
  for (const value of [...owner.batches]) discardPrepared(value)
  for (const value of [...owner.witnesses]) dropWitness(value)
}
export function domainDrained(issuer: DomainIssuer): boolean { const domain = issuers.get(issuer); return !!domain && domains.get(domain)!.pins === 0 }
export function whenDomainDrained(issuer: DomainIssuer): Promise<void> {
  const domain = issuers.get(issuer), state = domain && domains.get(domain)
  return !state || !state.pins ? Promise.resolve() : new Promise(resolve => state.waiters.push(resolve))
}
