// Pure strict data codec. No SQL, registry, session or write permission is created.
import { createHash } from 'node:crypto'
import type { SyncedBindingKey, SyncedLinkTarget } from '../../shared/synced-blocks'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { assertSyncedShape, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { validateSyncedBindingKey } from '../../shared/syncedBlockInputs'
import { parseStrictJson } from '../../shared/strictJson'
import { decodeHostCreateJournal, replaySyncedCreateShape, type CreateJournalRow, type SyncedHostCreateApplied } from './synced-host-create-codec'
import { captureSyncedCreateSourceFacts, createPhysicalKey, createRawHash, projectSyncedCreateLinks } from './synced-host-create-plan'
import { validateHostCreateOperationAck } from './synced-host-operation-receipt'
import { sameHostContent } from './synced-host-journal'
import { projectSyncedHostHeadingFacts2, type SyncedHeadingHostFacts2, type SyncedProjectedHeading2 } from './synced-heading-projection2'
import type { decodeSyncedMetadataCaptureRecord2 } from './synced-metadata-capture-record2'

export const HEADING_CREATE_BIRTH2_PREFIX = 'synced.heading.create-birth.v1.'
export const HEADING_CREATE_BIRTH2_OPERATION_KIND = 'synced-host-create-heading-birth-operation'
export const HEADING_CREATE_BIRTH2_COMPANION_KIND = 'synced-heading-create-birth-companion'
export type HeadingCreateBirthSourcePoint2 = ReturnType<typeof decodeSyncedMetadataCaptureRecord2>
type StoredHeading = Extract<SyncedLinkTarget, { kind: 'heading' }>
export interface HeadingCreateBirthCovered2 {
  sourceKey: SyncedBindingKey
  canonicalKey: SyncedBindingKey
  storedTarget: StoredHeading
  namespaceHash: string
  heading: SyncedProjectedHeading2
}
export interface HeadingCreateBirthCompanion2 {
  kind: 'synced-heading-create-birth-companion'
  version: 1
  operationId: string
  requestHash: string
  historyToken: string
  journalHash: string
  workspaceScope: string
  recoveryEpoch: string
  createdAt: string
  groupWireHash: string
  resultHash: string
  sourcePoint: { key: string; recordHash: string }
  creationPins: Array<{ group_id: string; kind: 'host-history'; pin_id: string; created_at: string }>
  covered: HeadingCreateBirthCovered2[]
}
export interface HeadingCreateBirthEnvelope2 {
  kind: 'synced-host-create-heading-birth-operation'
  version: 1
  companionKey: string
  companionHash: string
  result: SyncedHostCreateApplied
}
export interface HeadingCreateBirthOperationRow2 { client_operation_id: string; request_hash: string; result_json: string; created_at: string }
export interface HeadingCreateBirthCompanionRow2 { key: string; value: string; updated_at: string }
const encode = canonicalSyncedPortableJson
const equal = (left: unknown, right: unknown) => encode(left) === encode(right)
const bad = (message: string): never => { throw new Error('Heading create birth original invalid: ' + message) }
const uuid = (value: unknown): string => isSyncedUuid(value) ? value : bad('UUID required')
const hash = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : bad('SHA256 required')
const time = (value: unknown): string => typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? value : bad('time required')
const domainHash = (domain: string, value: unknown) => createHash('sha256').update(domain + '\0' + encode(value)).digest('hex')
const json = (value: string): unknown => parseStrictJson(value, { maxBytes: Math.max(1, Buffer.byteLength(value)), maxDepth: 64 })
function list<T>(value: unknown, read: (raw: unknown) => T, key: (item: T) => string): T[] {
  if (!Array.isArray(value)) return bad('array required')
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return bad('sparse array')
  const values = value.map(read)
  if (new Set(values.map(key)).size !== values.length) return bad('duplicate identity')
  return values
}
/** The caller must obtain this whole seven-column row from its actual original
 * SQL source. A matching digest of an arbitrary DTO is never authority. */
export function hashSyncedHeadingCreateBirthJournal2(row: Readonly<CreateJournalRow>): string {
  assertSyncedShape(row, ['id', 'action_json', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'])
  uuid(row.id); time(row.created_at); hash(row.before_hash); hash(row.after_hash)
  if (typeof row.action_json !== 'string' || typeof row.before_json !== 'string' || typeof row.after_json !== 'string') return bad('exact journal TEXT required')
  return domainHash('knowbook.synced.heading.create-birth-journal.v1', row)
}
export function hashSyncedHeadingCreateBirthCompanion2(value: HeadingCreateBirthCompanion2): string {
  return domainHash('knowbook.synced.heading.create-birth.v1', value)
}
/** Both original inputs are DATA, not capabilities. The owned reader must read
 * the actual point/journal rows and their family/pin closure independently. */
export function validateSyncedHeadingCreateBirthCompanion2(value: unknown, rawResult: unknown,
  originalRow: Readonly<CreateJournalRow>, point: HeadingCreateBirthSourcePoint2): HeadingCreateBirthCompanion2 {
  assertSyncedShape(value, ['kind', 'version', 'operationId', 'requestHash', 'historyToken', 'journalHash', 'workspaceScope',
    'recoveryEpoch', 'createdAt', 'groupWireHash', 'resultHash', 'sourcePoint', 'creationPins', 'covered'])
  if (value.kind !== 'synced-heading-create-birth-companion' || value.version !== 1) return bad('companion domain/version')
  const operationId = uuid(value.operationId), result = validateHostCreateOperationAck(rawResult, operationId)
  const journal = decodeHostCreateJournal(originalRow), life = result.createdLifecycle
  if (life.state !== 'active' || result.historyToken !== originalRow.id || value.historyToken !== result.historyToken
    || operationId !== journal.input.clientOperationId || value.requestHash !== createRawHash({ method: 'applySyncedHostCommand', input: journal.input })
    || value.journalHash !== hashSyncedHeadingCreateBirthJournal2(originalRow) || value.createdAt !== originalRow.created_at
    || value.createdAt !== life.createdAt || !equal(result.hosts[0].logicalBefore, journal.before[0].content)
    || !sameHostContent({ title: result.hosts[0].after.title, summary: result.hosts[0].after.summary,
      blocks: result.hosts[0].after.blocks.map(({ sortOrder: _sortOrder, ...block }) => block) }, journal.after[0].content)) return bad('original create request/journal/ACK differs')
  const own = result.groups.find(group => group.groupId === life.groupId)
  if (!own) return bad('original created group absent')
  const wire = { kind: 'synced-group' as const, id: own.groupId, creationId: own.creationId, createdAt: own.createdAt,
    origin: own.origin, blocks: own.blocks, bindings: own.bindings }
  if (!equal(wire, journal.create.wire) || value.groupWireHash !== journal.create.wireHash || value.groupWireHash !== life.activationHash
    || value.resultHash !== createRawHash(result)) return bad('original whole group/ACK commitment differs')
  const creationPins = list(value.creationPins, raw => {
    assertSyncedShape(raw, ['group_id', 'kind', 'pin_id', 'created_at'])
    const groupId = uuid(raw.group_id)
    if (raw.kind !== 'host-history' || raw.pin_id !== originalRow.id || raw.created_at !== originalRow.created_at) return bad('initial actual create pin differs')
    return { group_id: groupId, kind: 'host-history' as const, pin_id: uuid(raw.pin_id), created_at: time(raw.created_at) }
  }, pin => pin.group_id)
  const dependencyIds = new Set(journal.groups.map(group => group.groupId))
  if (creationPins.length !== dependencyIds.size || creationPins.some(pin => !dependencyIds.has(pin.group_id))) return bad('initial create pin closure differs')
  const workspaceScope = uuid(value.workspaceScope), recoveryEpoch = uuid(value.recoveryEpoch)
  assertSyncedShape(value.sourcePoint, ['key', 'recordHash'])
  if (point.kind !== 'synced-metadata2-read-baseline-record' || point.version !== 2 || point.businessOperationCommitted !== false
    || point.writePermit !== false || point.historicalKeyLineageComplete !== false || point.workspaceScope !== workspaceScope
    || point.recoveryEpoch !== recoveryEpoch || !point.pointHash || value.sourcePoint.key !== 'synced.metadata2.read-baseline:' + point.pointHash
    || value.sourcePoint.recordHash !== point.recordHash || point.sources.length !== 1 || !equal(point.sources[0].wire, wire)
    || point.sources[0].revision !== own.revision || point.sources[0].topologyRevision !== own.topologyRevision) return bad('point is not the exact created source group')
  hash(value.sourcePoint.recordHash); hash(point.pointHash)
  const shape = replaySyncedCreateShape(journal), facts = captureSyncedCreateSourceFacts(journal.before[0].content.blocks)
  const projected = new Map(projectSyncedCreateLinks(shape, facts.links).map(item => [createPhysicalKey(item.destination), item]))
  const sourceBindings = new Map(journal.create.sourceBindings.map(item => [createPhysicalKey(item.key), item]))
  const actualBindings = new Map(wire.bindings.map(binding => [createPhysicalKey(binding), binding]))
  // Only these current facts are backed by this NEW immutable fresh-Key event.
  // Other headings, old keys and imported groups do not acquire evidence.
  const namespacesByDocument = new Map(point.capture.namespaces.map(namespace => [namespace.host.documentId, namespace]))
  if (namespacesByDocument.size !== point.capture.namespaces.length) return bad('duplicate original namespace')
  // Per validation only: one actual full parser pass per original namespace.
  // No result/authority/currentness survives this invocation.
  const parsedNamespaces = new Map<string, { headings: SyncedProjectedHeading2[]; bySlug: Map<string, SyncedProjectedHeading2[]> }>()
  const eligible = point.capture.targets.filter(target => {
    if (target.sourceGroupId !== wire.id || target.status !== 'current-heading' || target.storedTarget.kind !== 'heading'
      || target.storedTarget.state !== 'live' || target.heading.location.kind !== 'ordinary' || target.documentId === wire.origin.documentId) return false
    const namespace = namespacesByDocument.get(target.documentId)
    return Boolean(namespace && !namespace.instances.length && !namespace.host.blocks.some(block => block.type === 'synced-block'))
  })
  const eligibleByKey = new Map(eligible.map(target => [createPhysicalKey(target.key), target]))
  if (eligibleByKey.size !== eligible.length || !eligible.length) return bad('no closed external ordinary heading births')
  const covered = list(value.covered, raw => {
    assertSyncedShape(raw, ['sourceKey', 'canonicalKey', 'storedTarget', 'namespaceHash', 'heading'])
    const sourceKey = validateSyncedBindingKey(raw.sourceKey), canonicalKey = validateSyncedBindingKey(raw.canonicalKey)
    const identity = createPhysicalKey(canonicalKey), binding = actualBindings.get(identity), projection = projected.get(identity)
    const source = sourceBindings.get(createPhysicalKey(sourceKey)), target = eligibleByKey.get(identity)
    if (!binding || !projection || !source || !target || target.status !== 'current-heading' || !equal(projection.source, sourceKey)
      || !equal(binding.target, raw.storedTarget) || !equal(source.target, raw.storedTarget) || !equal(target.storedTarget, raw.storedTarget)
      || target.storedTarget.kind !== 'heading' || target.storedTarget.state !== 'live' || target.heading.location.kind !== 'ordinary'
      || target.documentId === wire.origin.documentId || raw.namespaceHash !== target.namespaceHash || !equal(raw.heading, target.heading)) return bad('covered exact Key/target/projected heading differs')
    const namespace = namespacesByDocument.get(target.documentId)
    if (!namespace || namespace.namespaceHash !== target.namespaceHash || namespace.host.createdAt !== target.documentCreatedAt
      || namespace.instances.length || namespace.host.blocks.some(block => block.type === 'synced-block')) return bad('covered namespace is not ordinary/external')
    let parsedNamespace = parsedNamespaces.get(target.documentId)
    if (!parsedNamespace) {
      const host: SyncedHeadingHostFacts2 = { ...namespace.host, births: new Map(namespace.host.births) }
      const headings = projectSyncedHostHeadingFacts2(host, new Map(), new Map()), bySlug = new Map<string, SyncedProjectedHeading2[]>()
      if (!equal(headings, namespace.headings)) return bad('full original ordinary namespace differs')
      for (const heading of headings) { const matches = bySlug.get(heading.slug) ?? []; matches.push(heading); bySlug.set(heading.slug, matches) }
      parsedNamespace = { headings, bySlug }; parsedNamespaces.set(target.documentId, parsedNamespace)
    }
    const matches = parsedNamespace.bySlug.get(target.storedTarget.slug) ?? []
    if (matches.length !== 1 || matches[0].location.kind !== 'ordinary' || !equal(matches[0], target.heading)) return bad('unique original heading differs')
    return { sourceKey, canonicalKey, storedTarget: target.storedTarget, namespaceHash: hash(raw.namespaceHash), heading: target.heading }
  }, item => createPhysicalKey(item.canonicalKey))
  if (covered.length !== eligible.length || covered.some(item => !eligibleByKey.has(createPhysicalKey(item.canonicalKey)))) return bad('covered birth set incomplete')
  return { kind: 'synced-heading-create-birth-companion', version: 1, operationId, requestHash: hash(value.requestHash),
    historyToken: uuid(value.historyToken), journalHash: hash(value.journalHash), workspaceScope, recoveryEpoch, createdAt: time(value.createdAt),
    groupWireHash: hash(value.groupWireHash), resultHash: hash(value.resultHash), sourcePoint: { key: value.sourcePoint.key as string,
      recordHash: value.sourcePoint.recordHash as string }, creationPins, covered }
}
function validateEnvelopeAndCompanion2(value: unknown, rawCompanion: unknown,
  originalRow: Readonly<CreateJournalRow>, point: HeadingCreateBirthSourcePoint2) {
  assertSyncedShape(value, ['kind', 'version', 'companionKey', 'companionHash', 'result'])
  if (value.kind !== 'synced-host-create-heading-birth-operation' || value.version !== 1) return bad('business envelope domain/version')
  assertSyncedShape(value.result, ['status', 'operationId', 'historyToken', 'replayed', 'hosts', 'groups', 'affectedInstanceIds', 'blockIdMap', 'createdLifecycle'])
  const result = validateHostCreateOperationAck(value.result, uuid(value.result.operationId))
  const companion = validateSyncedHeadingCreateBirthCompanion2(rawCompanion, result, originalRow, point)
  if (value.companionKey !== HEADING_CREATE_BIRTH2_PREFIX + result.operationId
    || value.companionHash !== hashSyncedHeadingCreateBirthCompanion2(companion)) return bad('business reverse companion commitment differs')
  const envelope: HeadingCreateBirthEnvelope2 = { kind: 'synced-host-create-heading-birth-operation', version: 1, companionKey: value.companionKey,
    companionHash: hash(value.companionHash), result }
  return { envelope, companion }
}
export function validateSyncedHeadingCreateBirthEnvelope2(value: unknown, rawCompanion: unknown,
  originalRow: Readonly<CreateJournalRow>, point: HeadingCreateBirthSourcePoint2): HeadingCreateBirthEnvelope2 {
  return validateEnvelopeAndCompanion2(value, rawCompanion, originalRow, point).envelope
}
export function decodeSyncedHeadingCreateBirthOperation2(operationRow: Readonly<HeadingCreateBirthOperationRow2>,
  companionRow: Readonly<HeadingCreateBirthCompanionRow2>, originalRow: Readonly<CreateJournalRow>, point: HeadingCreateBirthSourcePoint2) {
  assertSyncedShape(operationRow, ['client_operation_id', 'request_hash', 'result_json', 'created_at'])
  assertSyncedShape(companionRow, ['key', 'value', 'updated_at'])
  uuid(operationRow.client_operation_id); hash(operationRow.request_hash); time(operationRow.created_at); time(companionRow.updated_at)
  if (typeof operationRow.result_json !== 'string' || typeof companionRow.value !== 'string') return bad('actual original TEXT rows required')
  const { envelope, companion } = validateEnvelopeAndCompanion2(json(operationRow.result_json), json(companionRow.value), originalRow, point)
  if (operationRow.client_operation_id !== envelope.result.operationId || operationRow.request_hash !== companion.requestHash
    || operationRow.created_at !== companion.createdAt || companionRow.key !== envelope.companionKey || companionRow.updated_at !== companion.createdAt
    || companionRow.value !== encode(companion) || operationRow.result_json !== encode(envelope)) return bad('actual envelope/companion row binding differs')
  return { envelope, companion, result: envelope.result }
}
