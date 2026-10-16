// Pure finite create journal/value codec. No DB, lifecycle reader or host-journal import.
import type { DocumentDetail } from '../../shared/contracts'
import type { SyncedBindingKey, SyncedGroupSnapshot, SyncedGroupWire, SyncedInstanceGuard, SyncedLinkTarget, SyncedOriginV1 } from '../../shared/synced-blocks'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, parseSyncedBlockPayload, validateSyncedBindings, validateSyncedGroupWire, validateSyncedHostForest, validateSyncedOrigin } from '../../shared/syncedBlockValidation'
import { validateSyncedBindingKey, validateSyncedInstanceGuard, validateSyncedStructureInput } from '../../shared/syncedBlockInputs'
import { parseStrictJson } from '../../shared/strictJson'
import { resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { hasSyncedInsertWorkingStructure } from './synced-host-insert-plan'
import { captureSyncedCreateSourceFacts, createPhysicalKey, createRawHash, isHostCreateInput, planSyncedHostCreate, projectSyncedCreateLinks,
  type CreateAuxiliary, type CreateContent, type CreateShape, type HostCreateInput } from './synced-host-create-plan'

export interface CreateBirth { documentId: string; blockId: string; createdAt: string }
export interface CreateGroupDependency { groupId: string; creationId: string; createdAt: string; origin: SyncedOriginV1 }
export interface CreateSide { documentId: string; content: CreateContent }
export interface CreateCapturedBinding { key: SyncedBindingKey; url: string; target: SyncedLinkTarget }
export interface CreatePlanRecord { wire: SyncedGroupWire; wireHash: string; selectedIds: string[]; auxiliary: CreateAuxiliary[]; instanceCreatedAt: string; sourceBindings: CreateCapturedBinding[] }
export interface HostCreateJournal { input: HostCreateInput; persisted: Array<CreateSide & { updatedAt: string }>; births: CreateBirth[]; groups: CreateGroupDependency[]; before: CreateSide[]; after: CreateSide[]; create: CreatePlanRecord }
export interface CreateLifeBase { groupId: string; creationId: string; createdAt: string; origin: SyncedOriginV1; createHistoryId: string; stateVersion: number; exposure: 'never'; revision: string; topologyRevision: string; activationRevision: string; activationTopologyRevision: string; activationHash: string; activationInstances: SyncedInstanceGuard[] }
export type CreatedLifecycleSide = CreateLifeBase & ({ state: 'active' } | { state: 'retired-create'; wire: SyncedGroupWire; retiredAt: string })
export interface SyncedHostCreateApplied { status: 'applied'; operationId: string; historyToken: string; replayed: boolean; hosts: Array<{ documentId: string; logicalBefore: CreateContent; logicalBeforeHash: string; after: DocumentDetail }>; groups: SyncedGroupSnapshot[]; affectedInstanceIds: string[]; blockIdMap: []; createdLifecycle: CreatedLifecycleSide }
export interface CreateJournalRow { id: string; action_json: string; before_json: string; after_json: string; before_hash: string; after_hash: string; created_at: string }
const encode = canonicalSyncedPortableJson, equal = (a: unknown, b: unknown) => encode(a) === encode(b)
function bad(): never { throw new Error('create 原日志、身份、闭包或生命周期事实损坏，不能猜测或重建。') }
const opaque = (value: unknown): string => isSyncedBlockId(value) ? value : bad()
const uuid = (value: unknown): string => isSyncedUuid(value) ? value : bad()
const digest = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : bad()
const time = (value: unknown): string => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : bad()
const json = (value: string): unknown => parseStrictJson(value, { maxBytes: Math.max(1, Buffer.byteLength(value)), maxDepth: 32 })
function list<T>(value: unknown, read: (raw: unknown) => T, key: (item: T) => string): T[] {
  if (!Array.isArray(value)) return bad()
  const values = value.map(read); if (new Set(values.map(key)).size !== values.length) return bad(); return values
}
function content(value: unknown): CreateContent { assertSyncedShape(value, ['title', 'summary', 'blocks']); if (typeof value.title !== 'string' || typeof value.summary !== 'string') return bad(); return { title: value.title, summary: value.summary, blocks: validateSyncedHostForest(value.blocks) } }
const sides = (value: unknown): CreateSide[] => list(value, raw => { assertSyncedShape(raw, ['documentId', 'content']); return { documentId: opaque(raw.documentId), content: content(raw.content) } }, item => item.documentId)
function auxiliary(value: unknown): CreateAuxiliary {
  assertSyncedShape(value, ['id', 'createdAt', 'role', 'sourceBlockId', 'from', 'to', 'kind', 'label'])
  if (value.role !== 'group-definition' && value.role !== 'host-survivor-definition' || value.kind !== 'reference' && value.kind !== 'note'
    || typeof value.from !== 'number' || typeof value.to !== 'number' || !Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to) || value.from < 0 || value.to <= value.from || typeof value.label !== 'string') return bad()
  return { id: uuid(value.id), createdAt: time(value.createdAt), role: value.role, sourceBlockId: opaque(value.sourceBlockId), from: value.from, to: value.to, kind: value.kind, label: value.label }
}
export function validateCreatedLifecycleSide(value: unknown): CreatedLifecycleSide {
  assertSyncedShape(value, ['groupId', 'creationId', 'createdAt', 'origin', 'createHistoryId', 'stateVersion', 'exposure', 'revision', 'topologyRevision', 'activationRevision', 'activationTopologyRevision', 'activationHash', 'activationInstances', 'state'], value && typeof value === 'object' && 'state' in value && value.state === 'retired-create' ? ['wire', 'retiredAt'] : [])
  if (value.state !== 'active' && value.state !== 'retired-create' || value.exposure !== 'never' || typeof value.stateVersion !== 'number' || !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1) return bad()
  const activationInstances = list(value.activationInstances, validateSyncedInstanceGuard, item => item.instanceId)
  if (activationInstances.length !== 1) return bad()
  const base: CreateLifeBase = { groupId: uuid(value.groupId), creationId: uuid(value.creationId), createdAt: time(value.createdAt), origin: validateSyncedOrigin(value.origin), createHistoryId: uuid(value.createHistoryId), stateVersion: value.stateVersion, exposure: 'never', revision: uuid(value.revision), topologyRevision: uuid(value.topologyRevision), activationRevision: uuid(value.activationRevision), activationTopologyRevision: uuid(value.activationTopologyRevision), activationHash: digest(value.activationHash), activationInstances }
  if (base.revision !== base.activationRevision || base.topologyRevision !== base.activationTopologyRevision || activationInstances[0].instanceId !== base.origin.firstInstanceId || activationInstances[0].hostDocumentId !== base.origin.documentId) return bad()
  if (value.state === 'active') return { ...base, state: 'active' }
  if (!Object.hasOwn(value, 'wire') || !Object.hasOwn(value, 'retiredAt')) return bad()
  const wire = validateSyncedGroupWire(value.wire)
  if (wire.id !== base.groupId || wire.creationId !== base.creationId || wire.createdAt !== base.createdAt || !equal(wire.origin, base.origin) || createRawHash(wire) !== base.activationHash) return bad()
  return { ...base, state: 'retired-create', wire, retiredAt: time(value.retiredAt) }
}
export function decodeHostCreateJournal(row: Readonly<CreateJournalRow>): HostCreateJournal {
  try {
    uuid(row.id); time(row.created_at)
    const action = json(row.action_json); assertSyncedShape(action, ['kind', 'version', 'input', 'persisted', 'births', 'groups', 'create'])
    if (action.kind !== 'host-command' || action.version !== 2) return bad()
    const input = validateSyncedStructureInput(action.input)
    if (!isHostCreateInput(input) || input.hostsWorkingBefore.length !== 1 || input.hostsWorkingBefore[0].documentId !== input.action.documentId) return bad()
    const before = sides(json(row.before_json)), after = sides(json(row.after_json))
    if (before.length !== 1 || after.length !== 1 || before[0].documentId !== input.action.documentId || after[0].documentId !== input.action.documentId || !equal(before[0].content, input.hostsWorkingBefore[0].workingBefore) || digest(row.before_hash) !== createRawHash(before) || digest(row.after_hash) !== createRawHash(after)) return bad()
    const persisted = list(action.persisted, raw => { assertSyncedShape(raw, ['documentId', 'updatedAt', 'content']); return { documentId: opaque(raw.documentId), updatedAt: time(raw.updatedAt), content: content(raw.content) } }, item => item.documentId)
    if (persisted.length !== 1 || persisted[0].documentId !== input.action.documentId || persisted[0].updatedAt !== input.hostsWorkingBefore[0].expectedPersistedUpdatedAt || !hasSyncedInsertWorkingStructure(persisted[0].content, before[0].content)) return bad()
    const births = list(action.births, raw => { assertSyncedShape(raw, ['documentId', 'blockId', 'createdAt']); return { documentId: opaque(raw.documentId), blockId: opaque(raw.blockId), createdAt: time(raw.createdAt) } }, item => item.blockId)
    const create = action.create; assertSyncedShape(create, ['wire', 'wireHash', 'selectedIds', 'auxiliary', 'instanceCreatedAt', 'sourceBindings'])
    const wire = validateSyncedGroupWire(create.wire), auxiliaries = list(create.auxiliary, auxiliary, item => item.id)
    if (wire.id !== input.action.groupId || wire.origin.documentId !== input.action.documentId || wire.origin.firstInstanceId !== input.action.instanceId || createRawHash(wire) !== digest(create.wireHash) || !Array.isArray(create.selectedIds) || create.selectedIds.some(id => !isSyncedBlockId(id)) || new Set(create.selectedIds).size !== create.selectedIds.length) return bad()
    const instanceCreatedAt = time(create.instanceCreatedAt), existing = new Set(before[0].content.blocks.map(block => block.id))
    if (existing.has(input.action.instanceId) || auxiliaries.some(item => existing.has(item.id) || item.id === input.action.instanceId)) return bad()
    let allocations = 0
    const shape = planSyncedHostCreate(input, facts => {
      const item = auxiliaries[allocations++]; if (!item) return bad()
      const { id, createdAt, ...record } = item; if (!equal(record, facts)) return bad()
      return { id, createdAt }
    })
    if (allocations !== auxiliaries.length || !equal(shape.selectedIds, create.selectedIds) || !equal(shape.after, after[0].content)) return bad()
    const birthMap = new Map(births.map(item => [item.blockId, item])), needed = new Set([...before[0].content.blocks, ...after[0].content.blocks].map(block => block.id))
    if (births.length !== needed.size || births.some(item => item.documentId !== input.action.documentId || !needed.has(item.blockId)) || birthMap.get(input.action.instanceId)?.createdAt !== instanceCreatedAt) return bad()
    const auxMap = new Map(auxiliaries.map(item => [item.id, item]))
    const canonical = shape.canonical.map(block => ({ ...block, createdAt: auxMap.get(block.id)?.createdAt ?? birthMap.get(block.id)?.createdAt ?? bad() }))
    if (!equal(canonical, wire.blocks)) return bad()
    for (const item of auxiliaries) if (item.role === 'host-survivor-definition' && birthMap.get(item.id)?.createdAt !== item.createdAt) return bad()
    const sourceFacts = captureSyncedCreateSourceFacts(before[0].content.blocks), expectedSources = sourceFacts.links.filter(item => !item.image && (item.key.syntax === 'wiki' || resolveMarkdownDocumentPath(wire.origin.pathAtCreation, item.url)))
    const rawSources = list(create.sourceBindings, raw => {
      assertSyncedShape(raw, ['key', 'url', 'target']); const key = validateSyncedBindingKey(raw.key)
      if (typeof raw.url !== 'string') return bad()
      return { key, url: raw.url, target: raw.target }
    }, item => createPhysicalKey(item.key))
    // Validate the whole W binding batch once, including cross-item overlap.
    // Rejoin by the complete physical key, never by ordinal or URL.
    const checkedBindings = validateSyncedBindings(rawSources.map(item => ({ ...item.key, target: item.target })), before[0].content.blocks)
    const checkedByKey = new Map(checkedBindings.map(({ target, ...key }) => [createPhysicalKey(key), target]))
    const sourceBindings = rawSources.map(item => ({ ...item, target: checkedByKey.get(createPhysicalKey(item.key)) ?? bad() }))
    const sources = new Map(sourceBindings.map(item => [createPhysicalKey(item.key), item]))
    if (expectedSources.length !== sourceBindings.length || expectedSources.some(item => sources.get(createPhysicalKey(item.key))?.url !== item.url)) return bad()
    const mapped = projectSyncedCreateLinks(shape, sourceFacts.links).filter(item => item.destination.syntax === 'wiki' || resolveMarkdownDocumentPath(wire.origin.pathAtCreation, item.url))
    const expectedBindings = mapped.map(item => ({ ...item.destination, target: sources.get(createPhysicalKey(item.source))?.target ?? bad() }))
    if (!equal(expectedBindings, wire.bindings)) return bad()
    const groups = list(action.groups, raw => { assertSyncedShape(raw, ['groupId', 'creationId', 'createdAt', 'origin']); return { groupId: uuid(raw.groupId), creationId: uuid(raw.creationId), createdAt: time(raw.createdAt), origin: validateSyncedOrigin(raw.origin) } }, item => item.groupId)
    const required = new Set([...before, ...after].flatMap(side => side.content.blocks.filter(block => block.type === 'synced-block').map(block => parseSyncedBlockPayload(block.content).groupId)))
    if (groups.length !== required.size || groups.some(item => !required.has(item.groupId))) return bad()
    const own = groups.find(item => item.groupId === wire.id)
    if (!own || own.creationId !== wire.creationId || own.createdAt !== wire.createdAt || !equal(own.origin, wire.origin)) return bad()
    return { input, persisted, births, groups, before, after, create: { wire, wireHash: createRawHash(wire), selectedIds: shape.selectedIds, auxiliary: auxiliaries, instanceCreatedAt, sourceBindings } }
  } catch (cause) { throw new Error('create 完整日志损坏，未执行或裁剪。', { cause }) }
}
export function encodeHostCreateJournal(journal: HostCreateJournal): { action: string; before: string; after: string; beforeHash: string; afterHash: string } {
  return { action: encode({ kind: 'host-command', version: 2, input: journal.input, persisted: journal.persisted, births: journal.births, groups: journal.groups, create: journal.create }), before: encode(journal.before), after: encode(journal.after), beforeHash: createRawHash(journal.before), afterHash: createRawHash(journal.after) }
}
export function replaySyncedCreateShape(journal: HostCreateJournal): CreateShape {
  let index = 0
  const shape = planSyncedHostCreate(journal.input, () => { const item = journal.create.auxiliary[index++]; if (!item) return bad(); return { id: item.id, createdAt: item.createdAt } })
  if (index !== journal.create.auxiliary.length) return bad(); return shape
}
