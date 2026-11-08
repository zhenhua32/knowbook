import type { SyncedBindingClaim, SyncedBindingKey, SyncedBindingSource, SyncedCanonicalEdit, SyncedGroupSaved, SyncedGroupSnapshot, SyncedInstanceGuard, SyncedUpdateGroupInput } from './synced-blocks'
import type { SyncedEditingBaselineResult } from './synced-editing-session'
import { editorRecoveryInvalid, validateEditorRecoveryRecord, type EditorRecoveryBase, type EditorRecoveryOriginal, type EditorRecoveryRecord, type EditorRecoveryWorking } from './editor-recovery-drafts'
import { isSyncedUuid, syncedCanonicalEdits, validateSyncedCanonicalEdit, validateSyncedCanonicalProjection, validateSyncedGroupSnapshot } from './syncedBlockValidation'
import { validateSyncedBindingClaims, validateSyncedBindingKey, validateSyncedUpdateGroupInput } from './syncedBlockInputs'
import { canonicalSyncedPortableJson as encode } from './syncedBlockPortable'
import { parseStrictJson } from './strictJson'

export interface CanonicalRecoveryFrame {
  before: SyncedCanonicalEdit[]; after: SyncedCanonicalEdit[]; bindingClaims?: SyncedBindingClaim[]
  instance: SyncedInstanceGuard; transactionId: string; sequence: number
}
export interface CanonicalRecoveryData {
  record: EditorRecoveryRecord; baseline: SyncedGroupSnapshot; frames: CanonicalRecoveryFrame[]
  redoFrames: CanonicalRecoveryFrame[]; cutServerRedo: boolean
}
export interface CanonicalRecoveryAcceptedFrame {
  transactionId: string
  input: SyncedUpdateGroupInput
  ack: SyncedGroupSaved
}
type GroupWorking = Extract<EditorRecoveryWorking, { kind: 'group' }>
export interface AttestedCanonicalRecoveryFloor {
  status: 'attested-original-floor'
  from: 'pending' | 'accepted'
  original: EditorRecoveryOriginal
  input: SyncedUpdateGroupInput
  acceptedStatus: 'saved' | 'noop'
  submitted: GroupWorking
  retainedWorking: GroupWorking
  floor: SyncedGroupSnapshot
  position: number
  writePermit: false
  sourceReplayComplete: false
  historicalKeyLineageComplete: false
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return editorRecoveryInvalid('closed canonical replay object required')
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
  if (required.some(key => !Object.hasOwn(descriptors, key)) || keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)
    || !descriptors[key].enumerable || !('value' in descriptors[key]))) return editorRecoveryInvalid('canonical replay fields differ')
  return value as Record<string, unknown>
}
const same = (a: unknown, b: unknown) => encode(a) === encode(b)
const identity = (value: unknown): string => typeof value === 'string' && value.trim() ? value : editorRecoveryInvalid('canonical replay identity missing')
const uuid = (value: unknown): string => isSyncedUuid(value) ? value : editorRecoveryInvalid('canonical replay UUID missing')
const keyId = ({ blockId, from, to, raw, syntax }: SyncedBindingKey) => encode([blockId, from, to, raw, syntax])
function list<T>(value: unknown, read: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) return editorRecoveryInvalid('dense canonical replay list required')
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
  if (keys.length !== value.length + 1 || keys.some(key => typeof key !== 'string' || key !== 'length'
    && (!/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) >= value.length))) return editorRecoveryInvalid('canonical replay array keys differ')
  const rows: T[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[index]
    if (!descriptor?.enumerable || !('value' in descriptor)) return editorRecoveryInvalid('sparse/accessor canonical replay list')
    rows.push(read(descriptor.value))
  }
  return rows
}
function source(value: unknown, snapshot: SyncedGroupSnapshot): SyncedBindingSource {
  const row = fields(value, ['ticketId', 'entries'])
  const expected = new Set(snapshot.bindings.map(keyId)), ids = new Set<string>()
  const entries = list(row.entries, value => {
    const entry = fields(value, ['entryId', 'key']), entryId = uuid(entry.entryId), key = validateSyncedBindingKey(entry.key)
    if (ids.has(entryId) || !expected.delete(keyId(key))) return editorRecoveryInvalid('canonical source does not cover original full binding keys')
    ids.add(entryId); return { entryId, key }
  })
  if (expected.size) return editorRecoveryInvalid('canonical source binding set is incomplete')
  return { ticketId: uuid(row.ticketId), entries }
}
function edits(value: unknown): SyncedCanonicalEdit[] {
  return validateSyncedCanonicalEdit(list(value, item => item))
}
/** Material for a Main-authored side-record digest. The complete alias map is
 * ordered by entry identity so a transport reorder cannot change its proof. */
export function canonicalRecoveryOriginalAliasMaterial(base: EditorRecoveryBase, readOwnerId: string, bindingSource: SyncedBindingSource) {
  const original = base.originals[0]
  if (base.owner.kind !== 'group' || base.originals.length !== 1 || original.kind !== 'metadata2-baseline') {
    return editorRecoveryInvalid('canonical source alias lacks its exact original point')
  }
  return { kind: 'knowbook-editor-recovery-original-alias-v1', workspaceScope: base.workspaceScope, recoveryEpoch: base.recoveryEpoch,
    groupId: base.owner.groupId, originalKey: original.key, originalHash: original.requestHash, readOwnerId,
    ticketId: bindingSource.ticketId, entries: [...bindingSource.entries].sort((left, right) => left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0) }
}
export function canonicalRecoveryRecordedAliasMaterial(record: EditorRecoveryRecord) {
  if (!record.canonicalOriginalAliasHash || !record.draft.canonicalReadOwnerId || typeof record.draft.replayJson !== 'string') return null
  try {
    const json = record.draft.replayJson
    const packet = fields(parseStrictJson(json, { maxBytes: Math.max(1, new TextEncoder().encode(json).byteLength), maxDepth: 48 }),
      ['kind', 'version', 'snapshot', 'readSource', 'accepted', 'frames', 'redoFrames', 'serverRedo', 'cutServerRedo'])
    if (packet.kind !== 'knowbook-canonical-recovery-data' || packet.version !== 2) return null
    const read = fields(packet.readSource, ['workspaceScope', 'readOwnerId', 'snapshot', 'bindingSource'])
    if (read.workspaceScope !== record.base.workspaceScope || read.readOwnerId !== record.draft.canonicalReadOwnerId) return null
    return canonicalRecoveryOriginalAliasMaterial(record.base, record.draft.canonicalReadOwnerId,
      source(read.bindingSource, validateSyncedGroupSnapshot(read.snapshot)))
  } catch { return null }
}
function rangeFits(key: { blockId: string; from: number; to: number; raw: string }, blocks: readonly SyncedCanonicalEdit[]): boolean {
  const block = blocks.find(block => block.id === key.blockId)
  return !!block && key.to <= block.content.length && block.content.slice(key.from, key.to) === key.raw
}

/** Body equality is insufficient to retire canonical identity/history intent.
 * Unknown older packets remain retained until their complete adapter can prove
 * a clean side. This predicate only refuses retirement; it grants no owner. */
export function canonicalRecoveryHasUnsettledWork(record: EditorRecoveryRecord): boolean {
  if (record.draft.working.kind !== 'group') return false
  try {
    if (typeof record.draft.replayJson !== 'string') return true
    const json = record.draft.replayJson
    const packet = fields(parseStrictJson(json, { maxBytes: Math.max(1, new TextEncoder().encode(json).byteLength), maxDepth: 48 }),
      ['kind', 'version', 'snapshot', 'readSource', 'accepted', 'frames', 'redoFrames', 'serverRedo', 'cutServerRedo'])
    return packet.kind !== 'knowbook-canonical-recovery-data' || packet.version !== 2 || packet.accepted !== null || packet.cutServerRedo !== false
      || [packet.frames, packet.redoFrames, packet.serverRedo].some(value => list(value, item => item).length > 0)
  } catch { return true }
}

/** Closed first canonical recovery domain: original B is unchanged, no pending
 * business ACK or incoming/conflict side is adopted. Root Main independently
 * reopens its actual sealed old point before this decoder receives a new read
 * owner. Old ticket strings never survive as cold permissions: copy claims are
 * remapped only by complete original keys to that genuine new owner's tickets. */
export function decodeCanonicalRecoveryData(value: unknown, reopened: SyncedEditingBaselineResult, originalAliasVerified = false): CanonicalRecoveryData {
  const record = validateEditorRecoveryRecord(value), owner = record.base.owner, working = record.draft.working, persisted = record.base.persistedWorking
  if (owner.kind !== 'group' || working.kind !== 'group' || persisted.kind !== 'group' || working.incoming !== null || persisted.incoming !== null
    || record.draft.pending.length || record.draft.composing || record.draft.importing || record.draft.sources.length
    || typeof record.draft.replayJson !== 'string' || reopened.status !== 'ready' || reopened.workspaceScope !== record.base.workspaceScope) {
    return editorRecoveryInvalid('canonical draft needs its pending/Source/conflict replay adapter')
  }
  const baseline = validateSyncedGroupSnapshot(reopened.snapshot)
  if (baseline.groupId !== owner.groupId || baseline.creationId !== owner.creationId || baseline.createdAt !== owner.createdAt
    || baseline.revision !== owner.revision || baseline.topologyRevision !== owner.topologyRevision || baseline.history.cursor !== owner.historyCursor
    || !same(syncedCanonicalEdits(baseline.blocks), persisted.blocks)) return editorRecoveryInvalid('new canonical read owner differs from the sealed original B')
  const packet = fields(parseStrictJson(record.draft.replayJson, { maxBytes: Math.max(1, new TextEncoder().encode(record.draft.replayJson).byteLength), maxDepth: 48 }),
    ['kind', 'version', 'snapshot', 'readSource', 'accepted', 'frames', 'redoFrames', 'serverRedo', 'cutServerRedo'])
  if (packet.kind !== 'knowbook-canonical-recovery-data' || packet.version !== 2 || packet.accepted !== null
    || typeof packet.cutServerRedo !== 'boolean' || list(packet.serverRedo, item => item).length
    || !same(validateSyncedGroupSnapshot(packet.snapshot), baseline)) return editorRecoveryInvalid('canonical replay requires its actual original ACK/floor adapter')
  let original: SyncedBindingSource | null = null
  if (packet.readSource !== null) {
    const read = fields(packet.readSource, ['workspaceScope', 'readOwnerId', 'snapshot', 'bindingSource'])
    if (read.workspaceScope !== record.base.workspaceScope || !isSyncedUuid(read.readOwnerId)
      || !same(validateSyncedGroupSnapshot(read.snapshot), baseline)) return editorRecoveryInvalid('canonical replay has no actual original read context')
    original = source(read.bindingSource, baseline)
  }
  const current = source(reopened.bindingSource, baseline)
  const originals = new Map(original?.entries.map(entry => [entry.entryId, entry.key]) ?? []), newByKey = new Map(current.entries.map(entry => [keyId(entry.key), entry.entryId]))
  const sequences = new Set<number>()
  let before = persisted.blocks, sequence = 0, checkingActive = true
  const readFrame = (raw: unknown): CanonicalRecoveryFrame => {
    const row = fields(raw, ['before', 'after', 'copySources', 'instance', 'transactionId', 'sequence'], ['bindingClaims'])
    const left = edits(row.before), after = edits(row.after)
    if (!same(left, before) || typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence < 1
      || checkingActive && row.sequence <= sequence || sequences.has(row.sequence)) return editorRecoveryInvalid('canonical replay frame chain differs from original B')
    sequences.add(row.sequence)
    validateSyncedCanonicalProjection(after, baseline.instances)
    const address = fields(row.instance, ['instanceId', 'hostDocumentId', 'bindingVersion'])
    const instance: SyncedInstanceGuard = { instanceId: uuid(address.instanceId), hostDocumentId: identity(address.hostDocumentId), bindingVersion: uuid(address.bindingVersion) }
    if (!baseline.instances.some(item => item.instanceId === instance.instanceId && item.hostDocumentId === instance.hostDocumentId && item.bindingVersion === instance.bindingVersion)) return editorRecoveryInvalid('canonical replay frame escaped its actual old instance set')
    const retained = new Set<string>()
    for (const value of list(row.copySources, value => value)) {
      const held = fields(value, ['ticketId', 'entryId']), ticketId = uuid(held.ticketId), entryId = uuid(held.entryId)
      if (!original || ticketId !== original.ticketId || !originals.has(entryId) || retained.has(entryId)) return editorRecoveryInvalid('canonical copy lease is outside the sealed original B')
      retained.add(entryId)
    }
    const usedSources = new Set<string>()
    let bindingClaims: SyncedBindingClaim[] | undefined
    if (Object.hasOwn(row, 'bindingClaims')) bindingClaims = validateSyncedBindingClaims(row.bindingClaims).map<SyncedBindingClaim>(claim => {
      if (!rangeFits(claim.destination, after) || claim.kind === 'continue' && !rangeFits(claim.source, left)
        || claim.kind === 'copy' && claim.source.kind === 'current' && !rangeFits(claim.source.key, left)) return editorRecoveryInvalid('canonical replay claims do not match their exact frame ranges')
      if (claim.kind !== 'copy' || claim.source.kind !== 'ticket') return claim
      if (!record.canonicalOriginalAliasHash || !originalAliasVerified) return editorRecoveryInvalid('the old copy alias has no sealed Main entry-to-Key proof')
      const old = originals.get(claim.source.entryId)
      if (!original || claim.source.ticketId !== original.ticketId || !old || !retained.has(claim.source.entryId)) return editorRecoveryInvalid('canonical copy claim has no actual original retained lease')
      usedSources.add(claim.source.entryId)
      const entryId = newByKey.get(keyId(old))
      if (!entryId) return editorRecoveryInvalid('new read owner cannot attest the exact original copy key')
      return { kind: 'copy', destination: claim.destination, source: { kind: 'ticket', ticketId: current.ticketId, entryId } }
    })
    if (retained.size !== usedSources.size) return editorRecoveryInvalid('canonical replay has unrelated retained copy capabilities')
    before = after; sequence = row.sequence
    return { before: left, after, instance, transactionId: identity(row.transactionId), sequence,
      ...(bindingClaims === undefined ? {} : { bindingClaims }) }
  }
  const frames = list(packet.frames, readFrame)
  if (!same(before, working.blocks)) return editorRecoveryInvalid('canonical complete W differs from its real private frame tail')
  checkingActive = false
  const redoFrames = list(packet.redoFrames, item => item).reverse().map(readFrame).reverse()
  if ((frames.length || redoFrames.length) && !packet.cutServerRedo) return editorRecoveryInvalid('authored local frames did not cut their old server Redo branch')
  return { record, baseline, frames, redoFrames, cutServerRedo: packet.cutServerRedo }
}

/** Rebuild only the local frames after a real saved A. The current group
 * already contains A. Old ticket copies in A were resolved by its actual
 * writer. The continuation uses current keys and has no historical alias. */
export function decodeCanonicalRecoveryFollowupData(value: unknown, floor: AttestedCanonicalRecoveryFloor): CanonicalRecoveryData {
  const record = validateEditorRecoveryRecord(value), { base, draft } = record, owner = base.owner, working = draft.working
  const baseline = validateSyncedGroupSnapshot(floor.floor), input = validateSyncedUpdateGroupInput(floor.input)
  const accepted = syncedCanonicalEdits(baseline.blocks)
  if (owner.kind !== 'group' || base.persistedWorking.kind !== 'group' || base.persistedWorking.incoming !== null
    || working.kind !== 'group' || working.incoming !== null || draft.sources.length || draft.composing || draft.importing
    || typeof draft.replayJson !== 'string' || floor.status !== 'attested-original-floor' || floor.acceptedStatus !== 'saved'
    || floor.writePermit !== false || floor.sourceReplayComplete !== false || floor.historicalKeyLineageComplete !== false
    || floor.original.kind !== 'synced-operation' || floor.original.key !== input.clientOperationId
    || baseline.groupId !== owner.groupId || baseline.creationId !== owner.creationId || baseline.createdAt !== owner.createdAt
    || baseline.topologyRevision !== owner.topologyRevision || baseline.revision === owner.revision || baseline.history.cursor === owner.historyCursor
    || input.groupId !== owner.groupId || input.expectedRevision !== owner.revision || input.expectedTopologyRevision !== owner.topologyRevision
    || !same(input.blocks, accepted) || !same(floor.submitted, { kind: 'group', blocks: accepted, incoming: null })
    || !same(floor.retainedWorking, working)) return editorRecoveryInvalid('canonical continuation has no exact accepted A or has additional Source/conflict input')
  const json = draft.replayJson, packet = fields(parseStrictJson(json, { maxBytes: Math.max(1, new TextEncoder().encode(json).byteLength), maxDepth: 48 }),
    ['kind', 'version', 'snapshot', 'readSource', 'accepted', 'frames', 'redoFrames', 'serverRedo', 'cutServerRedo'])
  if (packet.kind !== 'knowbook-canonical-recovery-data' || packet.version !== 2 || packet.cutServerRedo !== true
    || list(packet.serverRedo, item => item).length) return editorRecoveryInvalid('canonical continuation frame branch is unavailable')
  const captured = validateSyncedGroupSnapshot(packet.snapshot), framesRaw = list(packet.frames, item => item)
  const readFrame = (raw: unknown) => {
    const row = fields(raw, ['before', 'after', 'copySources', 'instance', 'transactionId', 'sequence'], ['bindingClaims'])
    const address = fields(row.instance, ['instanceId', 'hostDocumentId', 'bindingVersion'])
    const instance = { instanceId: uuid(address.instanceId), hostDocumentId: identity(address.hostDocumentId), bindingVersion: uuid(address.bindingVersion) }
    if (!baseline.instances.some(item => item.instanceId === instance.instanceId && item.hostDocumentId === instance.hostDocumentId && item.bindingVersion === instance.bindingVersion)
      || typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return editorRecoveryInvalid('canonical continuation frame escaped its actual occurrence/sequence')
    const bindingClaims = Object.hasOwn(row, 'bindingClaims') ? validateSyncedBindingClaims(row.bindingClaims) : undefined
    return { before: edits(row.before), after: edits(row.after), sequence: row.sequence, transactionId: identity(row.transactionId), instance, bindingClaims,
      copies: list(row.copySources, raw => { const copy = fields(raw, ['ticketId', 'entryId']); return encode([uuid(copy.ticketId), uuid(copy.entryId)]) }) }
  }
  const sequences = new Set<number>()
  let sequence = 0
  if (floor.from === 'pending') {
    const pending = draft.pending[0]
    if (draft.pending.length !== 1 || pending.method !== 'updateSyncedBlockGroup' || pending.clientOperationId !== input.clientOperationId
      || !same(validateSyncedUpdateGroupInput(parseStrictJson(pending.inputJson,
        { maxBytes: Math.max(1, new TextEncoder().encode(pending.inputJson).byteLength), maxDepth: 48 })), input)
      || !same(pending.submittedWorking, floor.submitted) || packet.accepted !== null || !framesRaw.length
      || captured.groupId !== owner.groupId || captured.creationId !== owner.creationId || captured.createdAt !== owner.createdAt
      || captured.revision !== owner.revision || captured.topologyRevision !== owner.topologyRevision || captured.history.cursor !== owner.historyCursor
      || !same(captured.instances, baseline.instances) || !same(captured.origin, baseline.origin)
      || !same(syncedCanonicalEdits(captured.blocks), base.persistedWorking.blocks)) return editorRecoveryInvalid('pending A does not identify the exact first submitted frame')
    const first = readFrame(framesRaw.shift())
    const used = new Set(first.bindingClaims?.flatMap(claim => claim.kind === 'copy' && claim.source.kind === 'ticket'
      ? [encode([claim.source.ticketId, claim.source.entryId])] : []) ?? [])
    if (!same(first.before, base.persistedWorking.blocks) || !same(first.after, accepted) || !same(first.instance, input.expectedInstanceBinding)
      || !same(first.bindingClaims, input.bindingClaims) || new Set(first.copies).size !== used.size || first.copies.length !== used.size
      || first.copies.some(key => !used.has(key))) return editorRecoveryInvalid('pending A is not the captured original submission')
    sequence = first.sequence; sequences.add(first.sequence)
  } else {
    const saved = fields(packet.accepted, ['method', 'input', 'ack']), ack = fields(saved.ack, ['status', 'operationId', 'snapshot', 'replayed'])
    if (floor.from !== 'accepted' || draft.pending.length || saved.method !== 'updateSyncedBlockGroup' || !same(validateSyncedUpdateGroupInput(saved.input), input)
      || ack.status !== 'saved' || ack.operationId !== input.clientOperationId || typeof ack.replayed !== 'boolean'
      || !same(validateSyncedGroupSnapshot(ack.snapshot), baseline) || !same(captured, baseline)) return editorRecoveryInvalid('accepted A does not match the exact saved original')
  }
  let previous = accepted
  const continuation = (raw: unknown, active: boolean): CanonicalRecoveryFrame => {
    const { copies, ...frame } = readFrame(raw)
    if (!same(previous, frame.before) || sequences.has(frame.sequence) || active && frame.sequence <= sequence || copies.length
      || frame.bindingClaims?.some(claim => !rangeFits(claim.destination, frame.after)
        || claim.kind === 'continue' && !rangeFits(claim.source, frame.before)
        || claim.kind === 'copy' && (claim.source.kind === 'ticket' || !rangeFits(claim.source.key, frame.before)))) {
      return editorRecoveryInvalid('canonical continuation differs from its exact frame chain or still uses a historical copy alias')
    }
    validateSyncedCanonicalProjection(frame.after, baseline.instances)
    previous = frame.after; sequence = frame.sequence; sequences.add(frame.sequence)
    return frame
  }
  const frames = framesRaw.map(item => continuation(item, true))
  if (!same(previous, working.blocks)) return editorRecoveryInvalid('canonical continuation does not cover the complete retained W')
  const redoFrames = list(packet.redoFrames, item => item).reverse().map(item => continuation(item, false)).reverse()
  if (!frames.length && !redoFrames.length) return editorRecoveryInvalid('no later canonical work remains after saved A')
  return { record, baseline, frames, redoFrames, cutServerRedo: true }
}
