import type { DocumentBlockDraft } from './contracts'
import { validateSyncedInstanceGuard } from './syncedBlockInputs'
import type { SyncedCanonicalEdit, SyncedInstanceGuard, SyncedInstancePosition } from './synced-blocks'
import type { MarkdownBlockFormat } from './markdownFormat'
import type { SyncedEditingBaselineResult } from './synced-editing-session'
import type { AttestedCanonicalRecoveryFloor, CanonicalRecoveryAcceptedFrame } from './editor-recovery-canonical'

/** Local uncommitted data only. No value in this module grants a business write. */
export type EditorRecoveryOwner =
  | { kind: 'host'; documentId: string; createdAt: string; updatedAt: string }
  | { kind: 'group'; groupId: string; creationId: string; createdAt: string; revision: string; topologyRevision: string; historyCursor: string }
export type EditorRecoveryWorking =
  | { kind: 'host'; title: string; summary: string; blocks: DocumentBlockDraft[] }
  | { kind: 'group'; blocks: SyncedCanonicalEdit[]; incoming: EditorRecoveryWorking | null }
export interface EditorRecoverySourceBuffer {
  sourceId: string; kind: 'ordinary-host' | 'synced-host' | 'canonical'
  openingSource: string; acceptedSource: string; source: string
  selection: { anchor: number; head: number }; composing: boolean; applying: boolean; importing: boolean
  replayJson?: string
  dirty?: boolean
}
export interface EditorRecoveryPending {
  method: 'updateSyncedBlockGroup' | 'restoreSyncedGroupOperation' | 'applySyncedHostStructure' | 'restoreSyncedHostOperation'
  clientOperationId: string; requestHash: string; inputJson: string; submittedWorking: EditorRecoveryWorking
}
export interface EditorRecoveryDraftInput {
  draftSessionId: string; generation: number; expectedPreviousGeneration: number
  working: EditorRecoveryWorking; sources: EditorRecoverySourceBuffer[]; pending: EditorRecoveryPending[]
  selection: { blockId: string | null; anchor: number; head: number } | null
  composing: boolean; importing: boolean
  replayJson?: string
  canonicalReadOwnerId?: string
}
/** Main derives these actual four columns from the live original owner.
 * A renderer never submits this packet as authority. */
export interface EditorRecoveryOriginal {
  kind: 'metadata2-baseline' | 'synced-operation'
  key: string; requestHash: string; resultJson: string; createdAt: string
}
/** Captured from Main's actual SQL opening. This is a read-only dependency
 * fence, separate from a synced_operations receipt or a Source write owner. */
export interface EditorRecoveryHostSourcePins {
  groups: Array<{
    groupId: string; creationId: string; createdAt: string; revision: string; topologyRevision: string; historyCursor: string
    instances: Array<SyncedInstancePosition & { createdAt: string }>
  }>
}
export interface EditorRecoveryBase {
  workspaceScope: string; recoveryEpoch: string; owner: EditorRecoveryOwner
  persistedWorking: EditorRecoveryWorking
  originals: EditorRecoveryOriginal[]
  hostSourcePins?: EditorRecoveryHostSourcePins
}
export type OpenEditorRecoveryDraftInput = ({ kind: 'host'; documentId: string; expectedUpdatedAt: string; source?: true }
  | { kind: 'group'; groupId: string; sessionId: string; readOwnerId: string }) & { openRequestId: string }
export interface EditorRecoveryRecord {
  kind: 'knowbook-editor-recovery-draft'; version: 1
  recordId: string; capturedAt: string; base: EditorRecoveryBase; draft: EditorRecoveryDraftInput
  writePermit: false; businessOperationCommitted: false
  canonicalOriginalAliasHash?: string
}
export interface EditorRecoveryReceipt {
  kind: 'knowbook-editor-recovery-receipt'; version: 1
  receiptId: string; purpose: 'background' | 'close'; requestId: string | null; closeGeneration: number | null
  records: Array<{ recordId: string; draftSessionId: string; generation: number; hash: string }>
}
export interface EditorRecoveryRecordSummary {
  recordId: string; draftSessionId: string; generation: number; hash: string
  capturedAt: string; owner: EditorRecoveryOwner; workspaceScope: string; recoveryEpoch: string
  displayTitle: string
}
export type EditorRecoveryDecision = 'restore-draft' | 'keep' | 'discard'
export interface EditorRecoveryExpected { recordId: string; generation: number; hash: string }
export interface LegacyEditorRecoverySummary extends EditorRecoveryExpected {
  kind: 'document' | 'group' | 'source'; targetId: string; updatedAt: string
}
export interface LegacyEditorRecoveryPage { records: LegacyEditorRecoverySummary[]; next: string | null }
export interface EditorRecoveryOpened { draftSessionId: string; generation: 0; base: EditorRecoveryBase; writePermit: false }
export interface EditorRecoveryCandidate {
  status: 'candidate'; recoveryOwnerId: string; record: EditorRecoveryRecord
  mode: 'editable-ordinary-draft' | 'editable-source-draft' | 'view-only'; reasons: string[]
  canonicalFollowupAvailable?: true
  canonicalHostDocumentId?: string
  pending: Array<{ clientOperationId: string; status: 'unknown' | 'committed-attested' | 'idempotency-mismatch' | 'unverifiable' }>
  writePermit: false; historicalKeyLineageComplete: false
  hostSourcePins?: 'unchanged' | 'changed' | 'unverifiable'
}
export interface EditorRecoveryPageInput { afterSessionId?: string; limit: number }
export interface EditorRecoveryPage { records: EditorRecoveryRecordSummary[]; next: string | null }
export type WriteEditorRecoveryDraftsInput = { purpose: 'background'; records: EditorRecoveryDraftInput[] }
  | { purpose: 'close'; requestId: string; records: EditorRecoveryDraftInput[] }
export interface DecideEditorRecoveryDraftInput { recoveryOwnerId: string; decision: EditorRecoveryDecision }
export interface RetireEditorRecoveryDraftInput { draftSessionId: string; expectedHead: EditorRecoveryExpected | null; working: EditorRecoveryWorking }
export interface ParkEditorRecoveryDraftInput { draftSessionId: string; expectedHead: EditorRecoveryExpected }
export interface PrepareEditorRecoveryGroupInput { recoveryOwnerId: string; sessionId: string }
export interface PreparedEditorRecoveryGroup { record: EditorRecoveryRecord; baseline: SyncedEditingBaselineResult; writePermit: false; historicalKeyLineageComplete: false; canonicalOriginalAliasVerified?: true }
export interface PrepareEditorRecoveryGroupFloorInput extends PrepareEditorRecoveryGroupInput { instance: SyncedInstanceGuard }
export interface PreparedEditorRecoveryGroupFloor { record: EditorRecoveryRecord; floor: AttestedCanonicalRecoveryFloor; writePermit: false; historicalKeyLineageComplete: false }
export interface CompleteEditorRecoveryGroupInput extends PrepareEditorRecoveryGroupInput {
  readOwnerId?: string
  accepted: CanonicalRecoveryAcceptedFrame[]
}

export const EDITOR_RECOVERY_CHANNELS = Object.freeze({
  open: 'knowbook:open-editor-recovery-draft', write: 'knowbook:write-editor-recovery-drafts',
  list: 'knowbook:list-editor-recovery-drafts', read: 'knowbook:read-editor-recovery-draft', decide: 'knowbook:decide-editor-recovery-draft',
  listLegacy: 'knowbook:list-legacy-editor-recovery-drafts', readLegacy: 'knowbook:read-legacy-editor-recovery-draft',
  retire: 'knowbook:retire-clean-editor-recovery-draft', prepareGroup: 'knowbook:prepare-editor-recovery-group',
  prepareGroupFloor: 'knowbook:prepare-editor-recovery-group-floor', completeGroup: 'knowbook:complete-editor-recovery-group', park: 'knowbook:park-editor-recovery-draft'
})

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const hashPattern = /^[a-f0-9]{64}$/
export function editorRecoveryInvalid(message: string): never { throw new Error('Editor recovery draft invalid: ' + message) }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return editorRecoveryInvalid('plain closed object required')
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
  if (required.some(key => !Object.hasOwn(descriptors, key))
    || keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) return editorRecoveryInvalid('closed fields differ')
  for (const key of keys) if (!descriptors[key as string].enumerable || !('value' in descriptors[key as string])) return editorRecoveryInvalid('accessor/non-enumerable field')
  return value as Record<string, unknown>
}
function text(value: unknown): string { return typeof value === 'string' ? value : editorRecoveryInvalid('text required') }
function opaque(value: unknown): string { const result = text(value); return result.trim() ? result : editorRecoveryInvalid('identity required') }
function uuid(value: unknown): string { return typeof value === 'string' && uuidPattern.test(value) ? value : editorRecoveryInvalid('UUID required') }
function hash(value: unknown): string { return typeof value === 'string' && hashPattern.test(value) ? value : editorRecoveryInvalid('SHA256 required') }
function time(value: unknown): string { const result = text(value); return Number.isFinite(Date.parse(result)) ? result : editorRecoveryInvalid('timestamp required') }
function integer(value: unknown, minimum = 0): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : editorRecoveryInvalid('integer required') }
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : editorRecoveryInvalid('boolean required') }
function list<T>(value: unknown, read: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) return editorRecoveryInvalid('dense array required')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || key !== 'length'
    && (!/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) >= value.length))) return editorRecoveryInvalid('array own keys differ')
  const result: T[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[index]
    if (!descriptor?.enumerable || !('value' in descriptor)) return editorRecoveryInvalid('sparse/accessor array')
    result.push(read(descriptor.value))
  }
  return result
}
function unique<T>(rows: T[], key: (item: T) => string): T[] {
  if (new Set(rows.map(key)).size !== rows.length) return editorRecoveryInvalid('duplicate identity')
  return rows
}
/** Opaque authored attrs remain exact data. No Markdown normalization or final
 * projection validation is performed while preserving a possibly invalid W. */
function format(value: unknown): Record<string, string | number | boolean> {
  const row = object(value, [], ['listMarker', 'listLoose', 'codeInfo', 'emptyCode', 'calloutKind', 'calloutIcon', 'calloutTone', 'toggleDefaultOpen', 'columnWeight'])
  const output: Record<string, string | number | boolean> = {}
  for (const [key, item] of Object.entries(row)) {
    if (typeof item !== 'string' && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item))) return editorRecoveryInvalid('invalid format scalar')
    output[key] = item
  }
  return output
}
function block(value: unknown): DocumentBlockDraft {
  const row = object(value, ['type', 'content', 'checked', 'depth'], ['id', 'parentBlockId', 'tags', 'language', 'highlight', 'listStart', 'markdownFormat'])
  const result: DocumentBlockDraft = { type: text(row.type), content: text(row.content), checked: bool(row.checked), depth: integer(row.depth) }
  if (Object.hasOwn(row, 'id')) result.id = opaque(row.id)
  if (Object.hasOwn(row, 'parentBlockId')) result.parentBlockId = row.parentBlockId === null ? null : opaque(row.parentBlockId)
  if (Object.hasOwn(row, 'tags')) result.tags = list(row.tags, text)
  if (Object.hasOwn(row, 'language')) result.language = text(row.language)
  if (Object.hasOwn(row, 'highlight')) result.highlight = text(row.highlight)
  if (Object.hasOwn(row, 'listStart')) result.listStart = integer(row.listStart, 1)
  if (Object.hasOwn(row, 'markdownFormat')) result.markdownFormat = format(row.markdownFormat) as MarkdownBlockFormat
  return result
}
function working(value: unknown, allowIncoming = true): EditorRecoveryWorking {
  const preliminary = object(value, ['kind', 'blocks'], ['title', 'summary', 'incoming'])
  if (preliminary.kind === 'host') {
    const row = object(value, ['kind', 'title', 'summary', 'blocks'])
    return { kind: 'host', title: text(row.title), summary: text(row.summary), blocks: list(row.blocks, block) }
  }
  if (preliminary.kind !== 'group') return editorRecoveryInvalid('unknown working kind')
  const row = object(value, ['kind', 'blocks', 'incoming'])
  const blocks = list(row.blocks, item => {
    const result = block(item)
    if (!result.id || !Object.hasOwn(result, 'parentBlockId') || result.type === 'synced-block') return editorRecoveryInvalid('canonical identity/owner invalid')
    return result as SyncedCanonicalEdit
  })
  if (row.incoming !== null) {
    if (!allowIncoming) return editorRecoveryInvalid('recursive incoming side')
    const incoming = working(row.incoming, false)
    if (incoming.kind !== 'group' || incoming.incoming !== null) return editorRecoveryInvalid('incoming must be a single complete group side')
    return { kind: 'group', blocks, incoming }
  }
  return { kind: 'group', blocks, incoming: null }
}
export function validateEditorRecoveryWorking(value: unknown): EditorRecoveryWorking { return working(value) }
function source(value: unknown): EditorRecoverySourceBuffer {
  const row = object(value, ['sourceId', 'kind', 'openingSource', 'acceptedSource', 'source', 'selection', 'composing', 'applying', 'importing'], ['replayJson', 'dirty'])
  if (row.kind !== 'ordinary-host' && row.kind !== 'synced-host' && row.kind !== 'canonical') return editorRecoveryInvalid('source kind invalid')
  const selection = object(row.selection, ['anchor', 'head']), raw = text(row.source)
  const anchor = integer(selection.anchor), head = integer(selection.head)
  if (anchor > raw.length || head > raw.length) return editorRecoveryInvalid('Source selection outside exact UTF16 buffer')
  return { sourceId: uuid(row.sourceId), kind: row.kind, openingSource: text(row.openingSource), acceptedSource: text(row.acceptedSource), source: raw,
    selection: { anchor, head }, composing: bool(row.composing), applying: bool(row.applying), importing: bool(row.importing),
    ...(Object.hasOwn(row, 'replayJson') ? { replayJson: text(row.replayJson) } : {}), ...(Object.hasOwn(row, 'dirty') ? { dirty: bool(row.dirty) } : {}) }
}
function pending(value: unknown): EditorRecoveryPending {
  const row = object(value, ['method', 'clientOperationId', 'requestHash', 'inputJson', 'submittedWorking'])
  if (typeof row.method !== 'string' || !['updateSyncedBlockGroup', 'restoreSyncedGroupOperation', 'applySyncedHostStructure', 'restoreSyncedHostOperation'].includes(row.method)) return editorRecoveryInvalid('pending method invalid')
  return { method: row.method as EditorRecoveryPending['method'], clientOperationId: uuid(row.clientOperationId), requestHash: hash(row.requestHash), inputJson: text(row.inputJson), submittedWorking: working(row.submittedWorking) }
}
export function validateEditorRecoveryDraftInput(value: unknown): EditorRecoveryDraftInput {
  const row = object(value, ['draftSessionId', 'generation', 'expectedPreviousGeneration', 'working', 'sources', 'pending', 'selection', 'composing', 'importing'], ['replayJson', 'canonicalReadOwnerId'])
  let selection: EditorRecoveryDraftInput['selection'] = null
  if (row.selection !== null) { const item = object(row.selection, ['blockId', 'anchor', 'head']); selection = {
    blockId: item.blockId === null ? null : opaque(item.blockId), anchor: integer(item.anchor), head: integer(item.head) } }
  const generation = integer(row.generation, 1), expectedPreviousGeneration = integer(row.expectedPreviousGeneration)
  if (generation !== expectedPreviousGeneration + 1) return editorRecoveryInvalid('generation is not the exact next capture')
  const work = working(row.working), hasAlias = Object.hasOwn(row, 'canonicalReadOwnerId')
  if (hasAlias && work.kind !== 'group') return editorRecoveryInvalid('canonical source owner hint has a foreign draft domain')
  return { draftSessionId: uuid(row.draftSessionId), generation, expectedPreviousGeneration, working: work,
    sources: unique(list(row.sources, source), item => item.sourceId), pending: unique(list(row.pending, pending), item => item.clientOperationId), selection,
    composing: bool(row.composing), importing: bool(row.importing), ...(Object.hasOwn(row, 'replayJson') ? { replayJson: text(row.replayJson) } : {}),
    ...(hasAlias ? { canonicalReadOwnerId: uuid(row.canonicalReadOwnerId) } : {}) }
}
export function validateOpenEditorRecoveryDraftInput(value: unknown): OpenEditorRecoveryDraftInput {
  const row = object(value, ['kind', 'openRequestId'], ['documentId', 'expectedUpdatedAt', 'source', 'groupId', 'sessionId', 'readOwnerId'])
  const request = { openRequestId: uuid(row.openRequestId) }
  if (row.kind === 'host') {
    object(row, ['kind', 'documentId', 'expectedUpdatedAt', 'openRequestId'], ['source'])
    if (Object.hasOwn(row, 'source') && row.source !== true) return editorRecoveryInvalid('host Source opening marker invalid')
    return { kind: 'host', documentId: opaque(row.documentId), expectedUpdatedAt: time(row.expectedUpdatedAt),
      ...(row.source === true ? { source: true as const } : {}), ...request }
  }
  object(row, ['kind', 'groupId', 'sessionId', 'readOwnerId', 'openRequestId'])
  if (row.kind !== 'group') return editorRecoveryInvalid('unknown draft owner kind')
  return { kind: 'group', groupId: uuid(row.groupId), sessionId: uuid(row.sessionId), readOwnerId: uuid(row.readOwnerId), ...request }
}
export function validateEditorRecoveryExpected(value: unknown): EditorRecoveryExpected {
  const row = object(value, ['recordId', 'generation', 'hash'])
  return { recordId: uuid(row.recordId), generation: integer(row.generation, 1), hash: hash(row.hash) }
}
export function validateEditorRecoveryBatch(value: unknown): EditorRecoveryDraftInput[] {
  const row = object(value, ['records'])
  return unique(list(row.records, validateEditorRecoveryDraftInput), item => item.draftSessionId)
}
export function validateEditorRecoveryWriteInput(value: unknown): WriteEditorRecoveryDraftsInput {
  const row = object(value, ['purpose', 'records'], ['requestId'])
  const records = unique(list(row.records, validateEditorRecoveryDraftInput), item => item.draftSessionId)
  if (row.purpose === 'background') { object(row, ['purpose', 'records']); return { purpose: 'background', records } }
  object(row, ['purpose', 'records', 'requestId'])
  if (row.purpose !== 'close') return editorRecoveryInvalid('unknown journal purpose')
  return { purpose: 'close', requestId: uuid(row.requestId), records }
}
export function validateEditorRecoveryPageInput(value: unknown): EditorRecoveryPageInput {
  const row = object(value, ['limit'], ['afterSessionId']), limit = integer(row.limit, 1)
  if (limit > 100) return editorRecoveryInvalid('page limit exceeds 100')
  return { limit, ...(Object.hasOwn(row, 'afterSessionId') ? { afterSessionId: uuid(row.afterSessionId) } : {}) }
}
export function validateEditorRecoveryDecisionInput(value: unknown): DecideEditorRecoveryDraftInput {
  const row = object(value, ['recoveryOwnerId', 'decision'])
  if (row.decision !== 'restore-draft' && row.decision !== 'keep' && row.decision !== 'discard') return editorRecoveryInvalid('unknown draft decision')
  return { recoveryOwnerId: uuid(row.recoveryOwnerId), decision: row.decision }
}
export function validateRetireEditorRecoveryDraftInput(value: unknown): RetireEditorRecoveryDraftInput {
  const row = object(value, ['draftSessionId', 'expectedHead', 'working'])
  return { draftSessionId: uuid(row.draftSessionId), expectedHead: row.expectedHead === null ? null : validateEditorRecoveryExpected(row.expectedHead), working: working(row.working) }
}
export function validatePrepareEditorRecoveryGroupInput(value: unknown): PrepareEditorRecoveryGroupInput {
  const row = object(value, ['recoveryOwnerId', 'sessionId'])
  return { recoveryOwnerId: uuid(row.recoveryOwnerId), sessionId: uuid(row.sessionId) }
}
export function validatePrepareEditorRecoveryGroupFloorInput(value: unknown): PrepareEditorRecoveryGroupFloorInput {
  const row = object(value, ['recoveryOwnerId', 'sessionId', 'instance'])
  return { recoveryOwnerId: uuid(row.recoveryOwnerId), sessionId: uuid(row.sessionId), instance: validateSyncedInstanceGuard(row.instance) }
}
export function validateCompleteEditorRecoveryGroupInput(value: unknown): Omit<CompleteEditorRecoveryGroupInput, 'accepted'> & { accepted: unknown[] } {
  const row = object(value, ['recoveryOwnerId', 'sessionId', 'accepted'], ['readOwnerId'])
  return { recoveryOwnerId: uuid(row.recoveryOwnerId), sessionId: uuid(row.sessionId), accepted: list(row.accepted, item => item),
    ...('readOwnerId' in row ? { readOwnerId: uuid(row.readOwnerId) } : {}) }
}
export function validateParkEditorRecoveryDraftInput(value: unknown): ParkEditorRecoveryDraftInput {
  const row = object(value, ['draftSessionId', 'expectedHead'])
  return { draftSessionId: uuid(row.draftSessionId), expectedHead: validateEditorRecoveryExpected(row.expectedHead) }
}
function readHostSourcePins(value: unknown, documentId: string): EditorRecoveryHostSourcePins {
  const row = object(value, ['groups'])
  const groups = unique(list(row.groups, value => {
    const group = object(value, ['groupId', 'creationId', 'createdAt', 'revision', 'topologyRevision', 'historyCursor', 'instances'])
    const instances = list(group.instances, value => {
      const item = object(value, ['instanceId', 'hostDocumentId', 'bindingVersion', 'parentBlockId', 'depth', 'parentType', 'createdAt'])
      if (item.hostDocumentId !== documentId) return editorRecoveryInvalid('host Source instance belongs to another host')
      return { instanceId: uuid(item.instanceId), hostDocumentId: documentId, bindingVersion: uuid(item.bindingVersion),
        parentBlockId: item.parentBlockId === null ? null : opaque(item.parentBlockId), depth: integer(item.depth),
        parentType: item.parentType === null ? null : opaque(item.parentType), createdAt: time(item.createdAt) }
    })
    if (!instances.length) return editorRecoveryInvalid('host Source group has no original host instance')
    return { groupId: uuid(group.groupId), creationId: uuid(group.creationId), createdAt: time(group.createdAt), revision: uuid(group.revision),
      topologyRevision: uuid(group.topologyRevision), historyCursor: uuid(group.historyCursor), instances }
  }), item => item.groupId)
  if (!groups.length) return editorRecoveryInvalid('host Source pins have no original group')
  unique(groups.flatMap(group => group.instances), instance => instance.instanceId)
  return { groups }
}
export function validateEditorRecoveryBase(value: unknown): EditorRecoveryBase {
  const row = object(value, ['workspaceScope', 'recoveryEpoch', 'owner', 'persistedWorking', 'originals'], ['hostSourcePins'])
  const rawOwner = object(row.owner, ['kind'], ['documentId', 'groupId', 'creationId', 'createdAt', 'updatedAt', 'revision', 'topologyRevision', 'historyCursor'])
  let owner: EditorRecoveryOwner
  if (rawOwner.kind === 'host') { const item = object(rawOwner, ['kind', 'documentId', 'createdAt', 'updatedAt']); owner = {
    kind: 'host', documentId: opaque(item.documentId), createdAt: time(item.createdAt), updatedAt: time(item.updatedAt) }
  } else { const item = object(rawOwner, ['kind', 'groupId', 'creationId', 'createdAt', 'revision', 'topologyRevision', 'historyCursor'])
    if (item.kind !== 'group') return editorRecoveryInvalid('base owner kind invalid')
    owner = { kind: 'group', groupId: uuid(item.groupId), creationId: uuid(item.creationId), createdAt: time(item.createdAt), revision: uuid(item.revision), topologyRevision: uuid(item.topologyRevision), historyCursor: uuid(item.historyCursor) }
  }
  const originals = unique(list(row.originals, value => { const item = object(value, ['kind', 'key', 'requestHash', 'resultJson', 'createdAt'])
    if (item.kind !== 'metadata2-baseline' && item.kind !== 'synced-operation') return editorRecoveryInvalid('original kind invalid')
    return { kind: item.kind, key: opaque(item.key), requestHash: hash(item.requestHash), resultJson: text(item.resultJson), createdAt: time(item.createdAt) } as EditorRecoveryOriginal
  }), item => item.key)
  const persistedWorking = working(row.persistedWorking)
  if (persistedWorking.kind !== owner.kind) return editorRecoveryInvalid('persisted base working domain differs')
  const base = { workspaceScope: uuid(row.workspaceScope), recoveryEpoch: uuid(row.recoveryEpoch), owner, persistedWorking, originals }
  if (!Object.hasOwn(row, 'hostSourcePins')) return base
  if (owner.kind !== 'host') return editorRecoveryInvalid('host Source pins require a host opening')
  return { ...base, hostSourcePins: readHostSourcePins(row.hostSourcePins, owner.documentId) }
}
export function validateEditorRecoveryRecord(value: unknown): EditorRecoveryRecord {
  const row = object(value, ['kind', 'version', 'recordId', 'capturedAt', 'base', 'draft', 'writePermit', 'businessOperationCommitted'], ['canonicalOriginalAliasHash'])
  if (row.kind !== 'knowbook-editor-recovery-draft' || row.version !== 1 || row.writePermit !== false || row.businessOperationCommitted !== false) return editorRecoveryInvalid('record version/permissions invalid')
  const base = validateEditorRecoveryBase(row.base), draft = validateEditorRecoveryDraftInput(row.draft)
  if (base.owner.kind !== draft.working.kind) return editorRecoveryInvalid('working/base owner domain differs')
  const hasAlias = Object.hasOwn(row, 'canonicalOriginalAliasHash')
  if (hasAlias && (base.owner.kind !== 'group' || !draft.canonicalReadOwnerId)) return editorRecoveryInvalid('canonical original alias proof has no actual source hint')
  return { kind: row.kind, version: 1, recordId: uuid(row.recordId), capturedAt: time(row.capturedAt), base, draft, writePermit: false, businessOperationCommitted: false,
    ...(hasAlias ? { canonicalOriginalAliasHash: hash(row.canonicalOriginalAliasHash) } : {}) }
}
export function validateEditorRecoveryReceipt(value: unknown): EditorRecoveryReceipt {
  const row = object(value, ['kind', 'version', 'receiptId', 'purpose', 'requestId', 'closeGeneration', 'records'])
  if (row.kind !== 'knowbook-editor-recovery-receipt' || row.version !== 1 || row.purpose !== 'background' && row.purpose !== 'close') return editorRecoveryInvalid('receipt version/domain invalid')
  if (row.purpose === 'background' && (row.requestId !== null || row.closeGeneration !== null)) return editorRecoveryInvalid('background receipt cannot authorize close')
  const requestId = row.requestId === null ? null : uuid(row.requestId), closeGeneration = row.closeGeneration === null ? null : integer(row.closeGeneration, 1)
  if (row.purpose === 'close' && (requestId === null || closeGeneration === null)) return editorRecoveryInvalid('close binding missing')
  const records = unique(list(row.records, value => { const item = object(value, ['recordId', 'draftSessionId', 'generation', 'hash']); return {
    recordId: uuid(item.recordId), draftSessionId: uuid(item.draftSessionId), generation: integer(item.generation, 1), hash: hash(item.hash) }
  }), item => item.draftSessionId)
  return { kind: row.kind, version: 1, receiptId: uuid(row.receiptId), purpose: row.purpose, requestId, closeGeneration, records }
}

/** Canonical encoding preserves all supported author data, including CRLF,
 * NUL and lone UTF16 surrogates (JSON's required escapes), without trimming. */
export function editorRecoveryRecordJson(value: EditorRecoveryRecord): string { return JSON.stringify(validateEditorRecoveryRecord(value)) }
