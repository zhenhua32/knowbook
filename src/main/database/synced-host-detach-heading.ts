import type Database from 'better-sqlite3'
import type { SyncedBindingKey, SyncedGroupWire } from '../../shared/synced-blocks'
import { hostEqual } from './synced-host-journal'
import { decodeHostCreateJournal } from './synced-host-create-codec'
import { createPhysicalKey, UnsupportedSyncedHostCreate } from './synced-host-create-plan'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { historicalOperationLocator, readHistoricalExactRows } from './synced-history-evidence-support'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { readSyncedHeadingCreateBirthOriginalOwned2, syncedHeadingCreateBirthOriginalSupportsOwned2 } from './synced-heading-create-birth-read2'
import { headingTitle3OriginalSupportsOwned, readHeadingTitle3GroupHeadOriginalOwned, readHeadingTitle3OriginalOperationOwned, type HeadingTitle3OriginalOperation } from './synced-heading-title3-read'
import { readSyncedHostHeadingsOwned2 } from './synced-heading-projection2'
import type { HeadingTitleCoveredKey3 } from './synced-heading-title-point3'
import type { HostDetachEvidence } from './synced-host-detach-evidence'

export interface DetachHeadingOriginal {
  kind: 'heading-create-birth' | 'heading-title-transition'
  operationId: string
  companionHash: string
}

export interface DetachHeadingProof {
  original: DetachHeadingOriginal
  headingKey: string
  blockId: string
}
export interface DetachLiveHeading {
  heading: DetachHeadingProof
  documentCreatedAt: string
  blockCreatedAt: string
}

type Birth = NonNullable<ReturnType<typeof readSyncedHeadingCreateBirthOriginalOwned2>>
export interface DetachHeadingSource {
  original: DetachHeadingOriginal
  wire: SyncedGroupWire
  revision: string
  covered: readonly HeadingTitleCoveredKey3[]
}

function unproved(): never { throw new UnsupportedSyncedHostCreate('semantic-binding') }

export function headingDetachBirthSource(original: Pick<Birth, 'row' | 'point' | 'companion' | 'envelope'>, groupId: string): DetachHeadingSource | null {
  const source = original.point.sources.find(item => item.wire.id === groupId)
  if (!source) return null
  return { original: { kind: 'heading-create-birth', operationId: original.row.client_operation_id, companionHash: original.envelope.companionHash },
    wire: source.wire, revision: source.revision, covered: original.companion.covered.map(item => {
      if (item.heading.location.kind !== 'ordinary') throw Error('解除同步的初始标题来源没有普通块身份。')
      return { birthOperationId: original.row.client_operation_id, birthKey: item.canonicalKey, key: item.canonicalKey,
        target: item.storedTarget, location: item.heading.location, headingKey: item.heading.key }
    }) }
}

export function headingDetachTitleSource(original: Pick<HeadingTitle3OriginalOperation, 'row' | 'companion' | 'materials'>, groupId: string): DetachHeadingSource | null {
  const member = original.materials.find(item => item.group.groupId === groupId)
  return member ? { original: { kind: 'heading-title-transition', operationId: original.row.client_operation_id, companionHash: original.companion.companionHash },
    wire: member.after, revision: member.group.afterRevision, covered: member.covered } : null
}

function currentOriginal(db: Database.Database, groupId: string): DetachHeadingSource | null {
  const state = readSyncedGroupLifecycles(db, [groupId]).get(groupId)
  if (!state || state.state !== 'active' || !state.createHistoryId) return null
  const head = readHeadingTitle3GroupHeadOriginalOwned(db, groupId)
  if (head) {
    const original = readHeadingTitle3OriginalOperationOwned(db, head.head.operationId)
    return original ? headingDetachTitleSource(original, groupId) : null
  }
  const journal = readHistoricalExactRows<SyncedHostHistoryBranchRow>(db, 'synced_host_history',
    ['id', 'action_json', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'], 'id=?', [state.createHistoryId])[0]
  if (!journal) throw Error('解除同步的初始宿主日志缺失。')
  const original = readSyncedHeadingCreateBirthOriginalOwned2(db, decodeHostCreateJournal(journal).input.clientOperationId)
  return original ? headingDetachBirthSource(original, groupId) : null
}

/** Structure-only attaches/detaches may change topology. Source content and
 * revision must still match the authenticated heading edge byte for byte. */
export function planDetachedHeadingProofs(db: Database.Database, wire: SyncedGroupWire, hostId: string) {
  const keys = wire.bindings.filter(binding => binding.target.kind === 'heading')
  const proofs = new Map<string, DetachLiveHeading>()
  if (!keys.length) return proofs
  const current = db.prepare('SELECT revision FROM synced_groups WHERE id=?').get(wire.id) as { revision: string } | undefined
  const source = currentOriginal(db, wire.id)
  if (!source || current?.revision !== source.revision || !hostEqual(source.wire, wire)) return unproved()
  const covered = new Map(source.covered.map(item => [createPhysicalKey(item.key), item]))
  const documents = new Map<string, NonNullable<ReturnType<typeof readSyncedHostHeadingsOwned2>>>()
  for (const binding of keys) {
    const { target, ...key } = binding
    if (target.kind !== 'heading' || target.state !== 'live' || target.documentId === hostId) return unproved()
    const proof = covered.get(createPhysicalKey(key))
    if (!proof || !hostEqual(proof.target, target)) return unproved()
    let actual = documents.get(target.documentId)
    if (!actual) {
      if (db.prepare('SELECT 1 FROM synced_instances WHERE host_document_id=? LIMIT 1').get(target.documentId)) return unproved()
      actual = readSyncedHostHeadingsOwned2(db, target.documentId) ?? unproved()
      documents.set(target.documentId, actual)
    }
    const matches = actual.headings.filter(item => item.slug === target.slug)
    if (matches.length !== 1 || matches[0].key !== proof.headingKey || !hostEqual(matches[0].location, proof.location)) return unproved()
    proofs.set(createPhysicalKey(key), { heading: { original: source.original, headingKey: proof.headingKey, blockId: proof.location.blockId },
      documentCreatedAt: proof.location.documentCreatedAt, blockCreatedAt: proof.location.blockCreatedAt })
  }
  return proofs
}

export function assertDetachHeadingSource(evidence: HostDetachEvidence, source: DetachHeadingSource | null, key: SyncedBindingKey,
  copy: HostDetachEvidence['projection']['links'][number]['resolved']) {
  const proof = copy.heading
  if (!proof || copy.target.kind !== 'heading' || !source || !hostEqual(proof.original, source.original)
    || !hostEqual(source.wire, evidence.wire) || source.revision !== evidence.revision) throw Error('解除同步标题来源与已认证的原操作不符。')
  const exact = source.covered.find(item => hostEqual(item.key, key))
  if (!exact || !hostEqual(exact.target, copy.target) || proof.headingKey !== exact.headingKey || proof.blockId !== exact.location.blockId
    || copy.documentCreatedAt !== exact.location.documentCreatedAt || copy.blockCreatedAt !== exact.location.blockCreatedAt)
    throw Error('解除同步的标题出生凭证不符。')
}

export function readDetachHeadingSqlSupports(db: Database.Database, evidence: HostDetachEvidence) {
  const links = evidence.projection.links.filter(link => link.resolved.heading)
  if (!links.length) return []
  const origin = links[0].resolved.heading!.original
  const checked = origin.kind === 'heading-create-birth'
    ? syncedHeadingCreateBirthOriginalSupportsOwned2(db, origin.operationId) : headingTitle3OriginalSupportsOwned(db, origin.operationId)
  const source = 'point' in checked.original ? headingDetachBirthSource(checked.original, evidence.wire.id)
    : headingDetachTitleSource(checked.original, evidence.wire.id)
  for (const link of links) assertDetachHeadingSource(evidence, source, link.source, link.resolved)
  return [historicalOperationLocator(checked.original.row), ...checked.supports]
}
