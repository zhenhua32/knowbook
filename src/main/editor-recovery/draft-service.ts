import { randomUUID } from 'node:crypto'
import { canonicalRecoveryHasUnsettledWork, decodeCanonicalRecoveryFollowupData, readCanonicalRecoveryClosedFrames } from '../../shared/editor-recovery-canonical'
import { readCanonicalRecoverySource } from '../../shared/editor-recovery-canonical-source'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { alreadySavedCanonicalRecoveryOwned, attestCanonicalRecoveryCompletionOwned, prepareCanonicalRecoveryCompletionOwned, prepareCanonicalRecoveryFollowupCompletionOwned,
  type PreparedCanonicalRecoveryCompletion } from './canonical-completion'
import { attestCanonicalRecoveryAcceptedFloorOwned } from './canonical-accepted-floor'
import type { SyncedInstanceGuard } from '../../shared/synced-blocks'
import { captureCanonicalOriginalAliasOwned, verifyCanonicalOriginalAlias } from './canonical-copy-original'
import type { KnowbookStore } from '../database/store'
import type { EditorCloseIpcEvent } from '../editor-close-barrier'
import { readSyncedBaselineMetadataCaptureOwned2 } from '../database/synced-binding-sources'
import { readSyncedMetadataCaptureRecordOwned2, reopenSyncedMetadataCaptureRecordOwned2, SYNCED_METADATA_BASELINE2_PREFIX } from '../database/synced-metadata-capture-record2'
import { isSyncedUuid, syncedCanonicalEdits } from '../../shared/syncedBlockValidation'
import { getSyncedGroupSnapshots } from '../database/synced-blocks-read'
import { hostEqual, hostHash, sameHostContent } from '../database/synced-host-journal'
import type { HostContent } from '../database/synced-host-document-read'
import { editorRecoveryInvalid, validateEditorRecoveryBase, validateEditorRecoveryBatch, validateEditorRecoveryExpected, validateOpenEditorRecoveryDraftInput,
  type EditorRecoveryBase, type EditorRecoveryDecision, type EditorRecoveryExpected, type EditorRecoveryOriginal,
  validateRetireEditorRecoveryDraftInput, validateEditorRecoveryWorking,
  validatePrepareEditorRecoveryGroupInput, validatePrepareEditorRecoveryGroupFloorInput, validateCompleteEditorRecoveryGroupInput,
  type PreparedEditorRecoveryGroup, type PreparedEditorRecoveryGroupFloor, type PreparedEditorRecoveryCrossMove,
  type ApplyEditorRecoveryCrossMoveResult, validatePrepareEditorRecoveryCrossMoveInput, validateApplyEditorRecoveryCrossMoveInput,
  validateParkEditorRecoveryDraftInput,
  type EditorRecoveryDraftInput, type EditorRecoveryReceipt, type EditorRecoveryRecord, type EditorRecoveryCandidate, type EditorRecoveryOpened, type EditorRecoveryWorking } from '../../shared/editor-recovery-drafts'
import { EditorRecoveryDraftStore } from './draft-store'
import { readHostRecoverySource } from '../../shared/editor-recovery-source'
import { attestEditorRecoveryPendingOwned } from './pending-original'
import { canCaptureCanonicalCrossMoveGroupOwned, prepareCanonicalCrossMoveTransferOwned, readCanonicalCrossMoveRecoveryOwned,
  readCanonicalCrossMoveRequest } from './canonical-cross-move-recovery'
import { captureHostSourcePinsOwned } from './host-source-pins'
import type { CrossMoveDraftCheck } from '../database/synced-cross-move-draft-guard'
import { validateSyncedRestoreHostInput, validateSyncedStructureInput } from '../../shared/syncedBlockInputs'
import { parseStrictJson } from '../../shared/strictJson'
import { captureCrossHostBatchJournal, captureCrossHostJournal4, captureCrossHostLinkJournal,
  CrossMoveJournalError, decodeCrossHostJournal4 } from '../database/synced-cross-host-journal4'
import { matchesCanonicalV4CrossMoveForest, readCanonicalBatchCrossMoveJournal, readCanonicalBatchInitiatingHost,
  readCanonicalLinkedCrossMoveJournal, readCanonicalStationaryInstances } from './canonical-cross-move-original4'
import { MoveRefused } from '../database/synced-host-cross-move-plan'
import type { SyncedEditingRequest, SyncedEditingResult } from '../../shared/synced-editing-session'

type OriginalRow = { client_operation_id: string; request_hash: string; result_json: string; created_at: string }
type Live = { sender: EditorCloseIpcEvent['sender']; frame: NonNullable<EditorCloseIpcEvent['senderFrame']>; base: { baseId: string; hash: string };
  groupSessionId?: string; alias?: { readOwnerId: string; hash: string }; receivedCrossMove?: true }
type Cold = { sender: EditorCloseIpcEvent['sender']; frame: NonNullable<EditorCloseIpcEvent['senderFrame']>; expected: EditorRecoveryExpected;
  crossMoveTransfer?: { requestHash: string; head: EditorRecoveryExpected; baselineHash: string };
  completion?: { sessionId: string; draftSessionId: string; owner: PreparedCanonicalRecoveryCompletion } & (
    { kind: 'baseline'; readOwnerId: string } | { kind: 'floor'; groupId: string; instance: SyncedInstanceGuard }
  ) }
/** Main/IPC request JSON omits undefined optional attrs. Preserve every defined
 * authored value (especially [] versus absent) without normalizing text. */
function definedFields<T extends object>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T }
/** Compare a complete W to current physical SQL only. The public document DTO
 * omits empty SQL tags; neither the saved draft nor its original hash changes.
 * A new block without an ID cannot already be the persisted current forest. */
function samePersistedWorking(left: EditorRecoveryWorking, right: EditorRecoveryWorking): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind !== 'host' || right.kind !== 'host') return JSON.stringify(left) === JSON.stringify(right)
  const host = (value: Extract<EditorRecoveryWorking, { kind: 'host' }>): HostContent | null => {
    const blocks: HostContent['blocks'] = []
    for (const block of value.blocks) {
      if (typeof block.id !== 'string') return null
      blocks.push({ ...block, id: block.id, parentBlockId: block.parentBlockId ?? null })
    }
    return { title: value.title, summary: value.summary, blocks }
  }
  const a = host(left), b = host(right)
  return a !== null && b !== null && sameHostContent(a, b)
}
export type { EditorRecoveryCandidate } from '../../shared/editor-recovery-drafts'

/** Actual Store + actual registered frame are fixed by Main, never by IPC.
 * The service preserves data and returns readonly candidates; it has no call
 * to any business writer, Apply, inverse, or automatic pending retry. */
export class EditorRecoveryDraftService {
  private readonly live = new Map<string, Live>()
  private readonly dormant = new Map<string, Live & { expected: EditorRecoveryExpected }>()
  private readonly openings = new Map<string, { sender: Live['sender']; frame: Live['frame']; inputJson: string; draftSessionId: string }>()
  private readonly cold = new Map<string, Cold>()
  private readonly completedCrossMoves = new Map<string, Pick<Live, 'sender' | 'frame'> & { sessionId: string; hostHead: EditorRecoveryExpected }>()
  constructor(private readonly side: EditorRecoveryDraftStore, private readonly store: KnowbookStore,
    private readonly admission: (event: EditorCloseIpcEvent) => void) {}
  private frame(event: EditorCloseIpcEvent) {
    this.admission(event)
    if (!event.senderFrame || event.senderFrame.detached) return editorRecoveryInvalid('actual current Main frame required')
    return event.senderFrame
  }
  private sameFrame(event: EditorCloseIpcEvent, entry: { sender: Live['sender']; frame: Live['frame'] }): void {
    const frame = this.frame(event)
    if (entry.sender !== event.sender || entry.frame !== frame) return editorRecoveryInvalid('not the original recovery owner frame')
  }
  private workspaceOwned(): { workspaceScope: string; recoveryEpoch: string } {
    const db = this.store.getUnsafeDatabaseHandle()
    if (!db.inTransaction) return editorRecoveryInvalid('actual workspace snapshot required')
    const row = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as { workspace_scope: string; recovery_epoch: string } | undefined
    if (!row || !isSyncedUuid(row.workspace_scope) || !isSyncedUuid(row.recovery_epoch)) return editorRecoveryInvalid('actual workspace boundary missing')
    return { workspaceScope: row.workspace_scope, recoveryEpoch: row.recovery_epoch }
  }
  currentBoundary(event: EditorCloseIpcEvent): { workspaceScope: string; recoveryEpoch: string } {
    this.frame(event)
    const db = this.store.getUnsafeDatabaseHandle()
    if (db.inTransaction) return editorRecoveryInvalid('close boundary requires own Main snapshot')
    return db.transaction(() => this.workspaceOwned())()
  }
  liveDraftSessionIds(event: EditorCloseIpcEvent): string[] {
    const frame = this.frame(event)
    return [...this.live, ...this.dormant].filter(([, entry]) => entry.sender === event.sender && entry.frame === frame).map(([id]) => id).sort()
  }
  activeDraftSessionIds(event: EditorCloseIpcEvent): string[] {
    const frame = this.frame(event)
    return [...this.live].filter(([, entry]) => entry.sender === event.sender && entry.frame === frame).map(([id]) => id).sort()
  }
  /** Third-page link rewrites never consume a preserved editor draft. For an
   * inverse initiated in that page itself, permit only its exact pending W=P. */
  crossMoveDraftCheck(event: EditorCloseIpcEvent): CrossMoveDraftCheck {
    const frame = this.frame(event)
    return (documentId, current, operation) => {
      if (this.side.legacy?.hasHostDraft(documentId)) return false
      const db = this.store.getUnsafeDatabaseHandle(), boundary = this.workspaceOwned()
      const actual = db.prepare('SELECT created_at FROM documents WHERE id=?').get(documentId) as { created_at: string } | undefined
      if (!actual) return false
      const apply = operation && 'apply' in operation ? operation : undefined
      const request = operation && ('apply' in operation ? operation.apply : operation)
      const method = apply ? 'applySyncedHostStructure' : 'restoreSyncedHostOperation'
      const working = apply?.working ?? current
      const target = (base: EditorRecoveryRecord['base']) => base.owner.kind === 'host' && base.owner.documentId === documentId
      const approved = new Set<string>()
      if (this.side.someHead(record => {
        if (!target(record.base)) return false
        const { draft } = record, owner = this.live.get(draft.draftSessionId), pending = draft.pending[0]
        if (!request || !owner || owner.frame !== frame || owner.sender !== event.sender || draft.pending.length !== 1
          || record.base.owner.kind !== 'host' || record.base.owner.createdAt !== actual.created_at
          || record.base.workspaceScope !== boundary.workspaceScope || record.base.recoveryEpoch !== boundary.recoveryEpoch
          || pending.method !== method || pending.clientOperationId !== request.clientOperationId
          || draft.sources.length || draft.composing || draft.importing
          || !samePersistedWorking(draft.working, { kind: 'host', ...working })
          || !samePersistedWorking(pending.submittedWorking, { kind: 'host', ...working })
          || apply && !samePersistedWorking(record.base.persistedWorking, { kind: 'host', ...current })) return true
        const invocation = parseStrictJson(pending.inputJson, { maxBytes: Math.max(1, Buffer.byteLength(pending.inputJson)), maxDepth: 32 })
        if (hostHash({ method: pending.method, input: invocation }) !== pending.requestHash
          || !hostEqual(apply ? validateSyncedStructureInput(invocation) : validateSyncedRestoreHostInput(invocation), request)) return true
        approved.add(draft.draftSessionId)
        return false
      })) return false
      return (!apply || sameHostContent(current, working) || approved.size > 0)
        && ![...this.live, ...this.dormant].some(([id, entry]) => !approved.has(id) && target(this.side.readBase(entry.base)))
    }
  }
  assertCloseBoundary(event: EditorCloseIpcEvent, boundary: { workspaceScope: string; recoveryEpoch: string }): void {
    const frame = this.frame(event), owners = [...this.live.values(), ...this.dormant.values()].filter(entry => entry.sender === event.sender && entry.frame === frame)
    // An old workspace's durable W remains viewable, but it cannot stand in for
    // an actual recovery producer opened in the replacement workspace.
    if (owners.length && !owners.some(entry => {
      const base = this.side.readBase(entry.base)
      return base.workspaceScope === boundary.workspaceScope && base.recoveryEpoch === boundary.recoveryEpoch
    })) return editorRecoveryInvalid('current workspace has no actual editor recovery owner; old workspace drafts do not cover it')
  }
  park(event: EditorCloseIpcEvent, value: unknown): void {
    const input = validateParkEditorRecoveryDraftInput(value), owner = this.live.get(input.draftSessionId)
    if (!owner) return editorRecoveryInvalid('not a live recovery producer')
    this.sameFrame(event, owner)
    const head = this.side.head(input.draftSessionId)
    if (!head || JSON.stringify(head.expected) !== JSON.stringify(input.expectedHead)) return editorRecoveryInvalid('dormant owner must bind its exact latest durable generation/hash')
    this.dormant.set(input.draftSessionId, { ...owner, expected: head.expected }); this.live.delete(input.draftSessionId)
  }
  open(event: EditorCloseIpcEvent, value: unknown): EditorRecoveryOpened {
    const frame = this.frame(event), input = validateOpenEditorRecoveryDraftInput(value), db = this.store.getUnsafeDatabaseHandle()
    const replay = this.openings.get(input.openRequestId)
    if (replay) {
      this.sameFrame(event, replay)
      if (replay.inputJson !== JSON.stringify(input)) return editorRecoveryInvalid('original opening nonce has different complete input')
      const owner = this.live.get(replay.draftSessionId) ?? this.dormant.get(replay.draftSessionId)
      if (!owner) return editorRecoveryInvalid('original opening owner was explicitly retired')
      return { draftSessionId: replay.draftSessionId, generation: 0, base: this.side.readBase(owner.base), writePermit: false }
    }
    if (db.inTransaction) return editorRecoveryInvalid('live recovery capture requires own Main snapshot')
    let base: EditorRecoveryBase
    if (input.kind === 'host') {
      // Read actual host birth/CAS in this snapshot. Opening a side-store owner
      // must not replace the real runtime's sender-bound Source/editing session.
      // This packet grants no semantic Source authority or business write.
      base = db.transaction(() => {
        const boundary = this.workspaceOwned(), detail = this.store.getDocumentDetail(input.documentId)
        const fact = db.prepare('SELECT created_at,updated_at FROM documents WHERE id=?').get(input.documentId) as { created_at: string; updated_at: string } | undefined
        if (!detail || !fact || detail.updatedAt !== fact.updated_at || fact.updated_at !== input.expectedUpdatedAt) return editorRecoveryInvalid('opened host birth/CAS/epoch changed during capture')
        const blocks = detail.blocks.map(({ sortOrder: _order, ...block }) => definedFields(block))
        const hostSourcePins = input.source ? captureHostSourcePinsOwned(db, detail.id, blocks) : undefined
        return validateEditorRecoveryBase({ ...boundary, owner: { kind: 'host', documentId: detail.id, createdAt: fact.created_at, updatedAt: fact.updated_at },
          persistedWorking: { kind: 'host', title: detail.title, summary: detail.summary, blocks }, originals: [],
          ...(hostSourcePins ? { hostSourcePins } : {}) })
      })()
    } else {
      // The source must ALREADY belong to this frame's genuine initial read.
      // Calling captureBaseline here would falsely replace the old source.
      const owned = this.store.invokeSyncedEditingSession(frame, { sessionId: input.sessionId, method: 'validateOwner', input: { readOwnerId: input.readOwnerId } })
      if (owned.status !== 'ready') return editorRecoveryInvalid('original source owner unavailable')
      base = db.transaction(() => {
        const boundary = this.workspaceOwned(), point = readSyncedBaselineMetadataCaptureOwned2(db, input.readOwnerId)
        if (point.status !== 'captured' || point.record.kind !== 'synced-metadata2-read-baseline-record' || !point.record.pointHash) return editorRecoveryInvalid('original initial source point unavailable')
        const source = point.record.sources.find(item => item.wire.id === input.groupId), history = point.record.groupHistories.find(item => item.groupId === input.groupId)
        if (!source || !history || point.record.workspaceScope !== boundary.workspaceScope || point.record.recoveryEpoch !== boundary.recoveryEpoch) return editorRecoveryInvalid('original source group/epoch differs')
        const key = SYNCED_METADATA_BASELINE2_PREFIX + point.record.pointHash
        const row = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(key) as OriginalRow | undefined
        if (!row || row.request_hash !== point.record.recordHash) return editorRecoveryInvalid('actual original four-column row missing')
        const original: EditorRecoveryOriginal = { kind: 'metadata2-baseline', key: row.client_operation_id, requestHash: row.request_hash, resultJson: row.result_json, createdAt: row.created_at }
        return validateEditorRecoveryBase({ ...boundary, owner: { kind: 'group', groupId: source.wire.id, creationId: source.wire.creationId, createdAt: source.wire.createdAt,
          revision: source.revision, topologyRevision: source.topologyRevision, historyCursor: history.history.cursor },
          persistedWorking: { kind: 'group', blocks: syncedCanonicalEdits(source.wire.blocks), incoming: null }, originals: [original] })
      })()
    }
    const pointer = this.side.sealBase(base), draftSessionId = randomUUID()
    this.live.set(draftSessionId, { sender: event.sender, frame, base: pointer, ...(input.kind === 'group' ? { groupSessionId: input.sessionId } : {}) })
    this.openings.set(input.openRequestId, { sender: event.sender, frame, inputJson: JSON.stringify(input), draftSessionId })
    return { draftSessionId, generation: 0, base, writePermit: false }
  }
  write(event: EditorCloseIpcEvent, value: unknown, purpose: { kind: 'background' } | { kind: 'close'; requestId: string; closeGeneration: number }): EditorRecoveryReceipt {
    this.frame(event)
    const drafts = validateEditorRecoveryBatch(value)
    const captures: Array<Parameters<EditorRecoveryDraftStore['write']>[0][number]> = drafts.map(draft => {
      const owner = this.live.get(draft.draftSessionId)
      if (!owner) return editorRecoveryInvalid('not a live recovery draft owner')
      this.sameFrame(event, owner)
      // This is its ORIGINAL already-sealed Main base, even if current SQL has
      // since conflicted. Reading today cannot silently change historical B.
      return { base: owner.base, draft, canonicalOriginalAliasHash: this.captureAlias(event, owner, draft),
        crossMoveGroupHead: this.captureCrossMoveGroupHead(owner, draft, drafts) }
    })
    if (purpose.kind === 'close') for (const [id, owner] of this.dormant) {
      if (owner.sender !== event.sender || owner.frame !== event.senderFrame) continue
      const head = this.side.head(id)
      if (!head || JSON.stringify(head.expected) !== JSON.stringify(owner.expected)) return editorRecoveryInvalid('dormant recovery generation/hash changed')
      captures.push({ base: owner.base, draft: head.record.draft })
    }
    const receipt = this.side.write(captures, purpose)
    this.collect([receipt.receiptId])
    return receipt
  }
  private captureCrossMoveGroupHead(hostOwner: Live, draft: EditorRecoveryDraftInput, batch: readonly EditorRecoveryDraftInput[]) {
    if (draft.pending.length !== 1 || draft.pending[0].method !== 'applySyncedHostStructure') return undefined
    const db = this.store.getUnsafeDatabaseHandle()
    if (db.inTransaction) return undefined
    try {
      const host = this.side.readBase(hostOwner.base), move = readCanonicalCrossMoveRequest(host, draft)
      if (!move) return undefined
      return db.transaction(() => {
        const boundary = this.workspaceOwned()
        if (host.workspaceScope !== boundary.workspaceScope || host.recoveryEpoch !== boundary.recoveryEpoch) return undefined
        const matching = []
        for (const [draftSessionId, groupOwner] of this.live) {
          if (groupOwner.sender !== hostOwner.sender || groupOwner.frame !== hostOwner.frame || !groupOwner.groupSessionId) continue
          const head = this.side.head(draftSessionId), capture = batch.find(item => item.draftSessionId === draftSessionId)
          if (!head || capture && capture.generation !== head.expected.generation
            || !canCaptureCanonicalCrossMoveGroupOwned(db, host, move, head.record)) continue
          matching.push({ draftSessionId, ...head.expected })
        }
        return matching.length === 1 ? matching[0] : undefined
      })()
    } catch { return undefined } // An unproved relation must never prevent retaining the real pending host input.
  }
  private captureAlias(event: EditorCloseIpcEvent, owner: Live, draft: EditorRecoveryDraftInput): string | undefined {
    const readOwnerId = draft.canonicalReadOwnerId, sessionId = owner.groupSessionId
    if (!readOwnerId || !sessionId) return undefined
    // The exact alias was independently captured from this live Main frame.
    // It is immutable, so subsequent generations need only its compact digest.
    if (owner.alias?.readOwnerId === readOwnerId) return owner.alias.hash
    try {
      const ready = this.store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'validateOwner', input: { readOwnerId } })
      if (ready.status !== 'ready') return undefined
      const db = this.store.getUnsafeDatabaseHandle(), base = this.side.readBase(owner.base)
      if (db.inTransaction) return undefined
      const hash = db.transaction(() => captureCanonicalOriginalAliasOwned(db, base, readOwnerId))()
      if (hash) owner.alias = { readOwnerId, hash }
      return hash
    } catch { return undefined } // The raw draft remains durable without a copy recovery permit.
  }
  private collect(receiptIds: readonly string[] = []): void {
    try { this.side.collectGarbage([...new Set([...this.live.values(), ...this.dormant.values()].map(owner => owner.base.baseId))], receiptIds) }
    catch (error) { console.warn('Obsolete editor draft cleanup deferred; durable current heads are retained.', error) }
  }
  /** A renderer cannot erase its own dirty producer merely by unregistering.
   * Main verifies the complete latest journal W and exact head CAS, then checks
   * current canonical SQL in its own snapshot before releasing the live owner. */
  retireClean(event: EditorCloseIpcEvent, value: unknown): boolean {
    this.frame(event)
    const input = validateRetireEditorRecoveryDraftInput(value), owner = this.live.get(input.draftSessionId)
    if (!owner) return editorRecoveryInvalid('not a live recovery draft owner')
    this.sameFrame(event, owner)
    const head = this.side.head(input.draftSessionId), base = this.side.readBase(owner.base)
    if (JSON.stringify(head?.expected ?? null) !== JSON.stringify(input.expectedHead)) return editorRecoveryInvalid('clean release does not bind the latest durable generation/hash')
    if (head && (JSON.stringify(head.record.draft.working) !== JSON.stringify(input.working) || head.record.draft.sources.length
      || head.record.draft.pending.length || head.record.draft.composing || head.record.draft.importing)) return false
    if (head && canonicalRecoveryHasUnsettledWork(head.record)) return false
    const db = this.store.getUnsafeDatabaseHandle()
    if (db.inTransaction) return editorRecoveryInvalid('clean release requires its own actual Main snapshot')
    const clean = db.transaction(() => {
      const boundary = this.workspaceOwned()
      if (boundary.workspaceScope !== base.workspaceScope || boundary.recoveryEpoch !== base.recoveryEpoch) return false
      let current: EditorRecoveryWorking | null = null
      if (base.owner.kind === 'host') {
        const row = db.prepare('SELECT created_at FROM documents WHERE id=?').get(base.owner.documentId) as { created_at: string } | undefined
        const detail = row?.created_at === base.owner.createdAt && this.store.getDocumentDetail(base.owner.documentId)
        if (detail) current = validateEditorRecoveryWorking({ kind: 'host', title: detail.title, summary: detail.summary,
          blocks: detail.blocks.map(({ sortOrder: _sortOrder, ...block }) => definedFields(block)) })
      } else {
        const item = getSyncedGroupSnapshots(db, { groupIds: [base.owner.groupId] }).items[0]
        if (item?.status === 'ready' && item.snapshot.creationId === base.owner.creationId && item.snapshot.createdAt === base.owner.createdAt
          && item.snapshot.revision === base.owner.revision && item.snapshot.topologyRevision === base.owner.topologyRevision && item.snapshot.history.cursor === base.owner.historyCursor)
          current = validateEditorRecoveryWorking({ kind: 'group', blocks: syncedCanonicalEdits(item.snapshot.blocks), incoming: null })
      }
      return current !== null && samePersistedWorking(current, input.working)
    })()
    if (!clean) return false
    if (head) this.side.decide(head.expected, 'discard')
    this.live.delete(input.draftSessionId)
    // Keep a lightweight retired nonce marker until the actual frame releases.
    // It holds no B/W and prevents a delayed retry from minting a new owner.
    this.collect()
    return true
  }
  private alreadySavedOrdinary(record: EditorRecoveryRecord): boolean {
    const { base, draft } = record
    if (base.owner.kind !== 'host' || base.persistedWorking.kind !== 'host' || draft.working.kind !== 'host' || draft.sources.length || draft.pending.length || draft.composing || draft.importing
      || [...base.persistedWorking.blocks, ...draft.working.blocks].some(block => block.type === 'synced-block')) return false
    const db = this.store.getUnsafeDatabaseHandle()
    if (db.inTransaction) return editorRecoveryInvalid('saved draft classification requires own actual Main snapshot')
    return db.transaction(() => {
      const boundary = this.workspaceOwned(), owner = base.owner
      if (owner.kind !== 'host' || draft.working.kind !== 'host' || boundary.workspaceScope !== base.workspaceScope || boundary.recoveryEpoch !== base.recoveryEpoch) return false
      const row = db.prepare('SELECT created_at FROM documents WHERE id=?').get(owner.documentId) as { created_at: string } | undefined
      const current = row?.created_at === owner.createdAt && this.store.getDocumentDetail(owner.documentId)
      if (!current) return false
      const working = validateEditorRecoveryWorking({ kind: 'host', title: current.title, summary: current.summary,
        blocks: current.blocks.map(({ sortOrder: _sortOrder, ...block }) => definedFields(block)) })
      return samePersistedWorking(working, draft.working)
    })()
  }
  private alreadySavedCanonical(record: EditorRecoveryRecord): boolean {
    if (record.base.owner.kind !== 'group' || this.live.has(record.draft.draftSessionId) || this.dormant.has(record.draft.draftSessionId)) return false
    const db = this.store.getUnsafeDatabaseHandle()
    if (db.inTransaction) return editorRecoveryInvalid('saved shared body classification requires its own actual Main snapshot')
    return db.transaction(() => alreadySavedCanonicalRecoveryOwned(db, record))()
  }
  list(event: EditorCloseIpcEvent, input: { afterSessionId?: string; limit: number }) {
    this.frame(event)
    const receiving = [...this.live, ...this.dormant].filter(([, owner]) => owner.receivedCrossMove).map(([id]) => id)
    const excludeSessionIds = [...new Set([...this.liveDraftSessionIds(event), ...receiving])], records: ReturnType<EditorRecoveryDraftStore['list']>['records'] = []
    let afterSessionId = input.afterSessionId, next: string | null = null
    do {
      const page = this.side.list({ ...(afterSessionId ? { afterSessionId } : {}), limit: input.limit - records.length, excludeSessionIds })
      for (const item of page.records) {
        const expected = { recordId: item.recordId, generation: item.generation, hash: item.hash }, record = this.side.read(expected)
        // Current producers, including private parked heads, never appear in
        // this cold decision surface. A completed old frame may leave a clean
        // checkpoint. The canonical domain also requires its exact original
        // stored request, ACK and history row before the same side-head CAS.
        if (this.alreadySavedOrdinary(record) || this.alreadySavedCanonical(record)) this.side.decide(expected, 'discard')
        else records.push(item)
      }
      next = page.next; afterSessionId = page.next ?? undefined
    } while (next && records.length < input.limit)
    // GC is deferred to normal write/frame release. Reading an unrelated old
    // draft must not retire the live close attempt's actual receipt.
    return { records, next }
  }
  private examine(record: EditorRecoveryRecord, includeCanonicalHost = false, crossMoveGroup?: EditorRecoveryRecord): Pick<EditorRecoveryCandidate,
    'mode' | 'reasons' | 'pending' | 'canonicalFollowupAvailable' | 'canonicalSourceAvailable' | 'canonicalHostDocumentId'
    | 'canonicalCrossMoveRecovery' | 'hostSourcePins'> {
    const db = this.store.getUnsafeDatabaseHandle()
    if (db.inTransaction) return editorRecoveryInvalid('cold candidate requires own actual Main snapshot')
    return db.transaction(() => {
      const boundary = this.workspaceOwned(), reasons: string[] = []
      const originalPins = record.base.hostSourcePins
      let hostSourcePins: EditorRecoveryCandidate['hostSourcePins'] = originalPins ? 'changed' : undefined
      let canonicalHostDocumentId: string | undefined
      if (boundary.workspaceScope !== record.base.workspaceScope || boundary.recoveryEpoch !== record.base.recoveryEpoch) reasons.push('workspace-epoch-changed')
      const owner = record.base.owner
      if (owner.kind === 'host') {
        const current = db.prepare('SELECT created_at,updated_at FROM documents WHERE id=?').get(owner.documentId) as { created_at: string; updated_at: string } | undefined
        if (!current || current.created_at !== owner.createdAt) reasons.push('host-birth-changed-or-missing')
        else if (current.updated_at !== owner.updatedAt) reasons.push('base-version-changed')
        else {
          const detail = this.store.getDocumentDetail(owner.documentId)
          const currentWorking = detail && validateEditorRecoveryBase({ ...record.base, persistedWorking: { kind: 'host', title: detail.title, summary: detail.summary,
            blocks: detail.blocks.map(({ sortOrder: _order, ...block }) => definedFields(block)) } }).persistedWorking
          if (JSON.stringify(currentWorking) !== JSON.stringify(record.base.persistedWorking)) reasons.push('base-content-changed')
          else if (originalPins && !reasons.length && currentWorking?.kind === 'host') {
            try {
              const actual = captureHostSourcePinsOwned(db, owner.documentId, currentWorking.blocks)
              hostSourcePins = JSON.stringify(actual) === JSON.stringify(originalPins) ? 'unchanged' : 'changed'
            } catch { hostSourcePins = 'unverifiable' }
          }
        }
      } else {
        const current = db.prepare('SELECT creation_id,created_at,revision,topology_revision,history_cursor FROM synced_groups WHERE id=?').get(owner.groupId) as {
          creation_id: string; created_at: string; revision: string; topology_revision: string; history_cursor: string
        } | undefined
        if (!current || current.creation_id !== owner.creationId || current.created_at !== owner.createdAt) reasons.push('group-birth-changed-or-missing')
        else {
          if (includeCanonicalHost && !reasons.length) {
            try {
              const [item] = getSyncedGroupSnapshots(db, { groupIds: [owner.groupId] }).items
              if (item?.status === 'ready') canonicalHostDocumentId = item.snapshot.instances[0]?.hostDocumentId
            } catch { /* Preserve the draft for review when its live location cannot be verified. */ }
          }
          if (current.revision !== owner.revision || current.topology_revision !== owner.topologyRevision || current.history_cursor !== owner.historyCursor) reasons.push('base-version-changed')
        }
      }
      for (const original of record.base.originals) {
        const row = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(original.key) as OriginalRow | undefined
        if (!row || row.request_hash !== original.requestHash || row.result_json !== original.resultJson || row.created_at !== original.createdAt) { reasons.push('original-unavailable-or-changed'); continue }
        if (original.kind === 'metadata2-baseline') {
          // A new cold READ owner is derived from the sealed original key and
          // independently reread actual row/pins, never from a new capture.
          try {
            const cold = reopenSyncedMetadataCaptureRecordOwned2(db, original.key), actual = readSyncedMetadataCaptureRecordOwned2(db, cold)
            if (actual.recordHash !== original.requestHash || actual.workspaceScope !== record.base.workspaceScope || actual.recoveryEpoch !== record.base.recoveryEpoch) reasons.push('original-domain-changed')
          } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('Metadata2 captured original invalid:')) throw error
            reasons.push('original-unverifiable')
          }
        }
      }
      let pending: EditorRecoveryCandidate['pending']
      try { pending = attestEditorRecoveryPendingOwned(db, record).map(item => ({ clientOperationId: item.clientOperationId, status: item.status })) }
      catch { pending = record.draft.pending.map(item => ({ clientOperationId: item.clientOperationId, status: 'unverifiable' })) }
      if (pending.length) reasons.push('pending-needs-original-request-attestation')
      let hostSource = false
      if (record.draft.sources.length) {
        try { readHostRecoverySource(record); hostSource = !originalPins || hostSourcePins === 'unchanged' }
        catch { reasons.push('source-snapshot-rehydration-required') }
      }
      const hasReferences = record.draft.working.kind === 'group' || record.draft.working.blocks.some(block => block.type === 'synced-block')
        || record.draft.sources.some(source => source.kind === 'canonical' || source.kind !== 'ordinary-host' && !hostSource)
      if (!hostSource && (hasReferences || originalPins)) reasons.push('cold-semantic-source-replay-required')
      let canonicalSourceAvailable: true | undefined
      if (owner.kind === 'group' && record.draft.sources.length && record.base.originals.length === 1
        && record.base.originals[0].kind === 'metadata2-baseline'
        && reasons.every(reason => reason === 'source-snapshot-rehydration-required' || reason === 'cold-semantic-source-replay-required')) {
        try {
          const { accepted } = readCanonicalRecoverySource(record)
          const [actual] = getSyncedGroupSnapshots(db, { groupIds: [owner.groupId] }).items
          if (actual?.status === 'ready'
            && canonicalSyncedPortableJson(accepted.initialBlocks) === canonicalSyncedPortableJson(syncedCanonicalEdits(actual.snapshot.blocks))) {
            canonicalSourceAvailable = true
          }
        } catch { /* An incomplete or stale source remains available for review. */ }
      }
      let canonicalFollowupAvailable: true | undefined
      if (owner.kind === 'group' && !record.draft.sources.length && reasons.includes('base-version-changed')) {
        const floor = attestCanonicalRecoveryAcceptedFloorOwned(db, record)
        if (floor) {
          try { decodeCanonicalRecoveryFollowupData(record, floor); canonicalFollowupAvailable = true }
          catch { /* Preserve the readonly candidate when the later branch is incomplete. */ }
        }
      }
      let canonicalCrossMoveRecovery: EditorRecoveryCandidate['canonicalCrossMoveRecovery']
      if (crossMoveGroup) {
        try { canonicalCrossMoveRecovery = readCanonicalCrossMoveRecoveryOwned(db, record, crossMoveGroup) }
        catch { /* The two original drafts stay available for review. */ }
      }
      return { mode: reasons.length ? 'view-only' as const : hostSource ? 'editable-source-draft' as const : 'editable-ordinary-draft' as const, reasons, pending,
        ...(canonicalFollowupAvailable ? { canonicalFollowupAvailable } : {}),
        ...(canonicalSourceAvailable ? { canonicalSourceAvailable } : {}),
        ...(canonicalHostDocumentId ? { canonicalHostDocumentId } : {}),
        ...(canonicalCrossMoveRecovery ? { canonicalCrossMoveRecovery } : {}),
        ...(hostSourcePins ? { hostSourcePins } : {}) }
    })()
  }
  read(event: EditorCloseIpcEvent, input: unknown): EditorRecoveryCandidate {
    const frame = this.frame(event), expected = validateEditorRecoveryExpected(input), record = this.side.read(expected), recoveryOwnerId = randomUUID()
    let crossMoveGroup: EditorRecoveryRecord | undefined
    if (record.crossMoveGroupHead) {
      try { crossMoveGroup = this.side.readCurrentCrossMoveGroup(expected) }
      catch { /* The host pending request remains available for review. */ }
    }
    const state = this.examine(record, true, crossMoveGroup)
    this.cold.set(recoveryOwnerId, { sender: event.sender, frame, expected })
    return { status: 'candidate', recoveryOwnerId, record, ...state, writePermit: false, historicalKeyLineageComplete: false }
  }
  /** The caller chooses only its actual new editing session. The old key/hash
   * and group are fixed by this genuine cold owner and reread side head. No
   * renderer original-key DTO or freshly captured baseline is accepted. */
  prepareGroup(event: EditorCloseIpcEvent, value: unknown): PreparedEditorRecoveryGroup {
    const input = validatePrepareEditorRecoveryGroupInput(value), cold = this.cold.get(input.recoveryOwnerId)
    if (!cold) return editorRecoveryInvalid('not an actual new cold recovery owner')
    this.sameFrame(event, cold)
    const record = this.side.read(cold.expected), head = this.side.head(record.draft.draftSessionId)
    if (!head || JSON.stringify(head.expected) !== JSON.stringify(cold.expected)) return editorRecoveryInvalid('old cold owner cannot prepare a newer durable recovery generation')
    const producer = this.live.get(record.draft.draftSessionId) ?? this.dormant.get(record.draft.draftSessionId)
    if (producer?.receivedCrossMove) return editorRecoveryInvalid('the transferred draft already belongs to its receiving producer')
    const examined = this.examine(record), owner = record.base.owner
    if (owner.kind !== 'group' || record.draft.working.kind !== 'group' || record.draft.pending.length
      || record.draft.composing || record.draft.importing || record.draft.sources.some(source => source.composing || source.importing || source.applying)
      || examined.reasons.some(reason => !['source-snapshot-rehydration-required', 'cold-semantic-source-replay-required'].includes(reason))) {
      return editorRecoveryInvalid('cold source requires original ACK/conflict reconciliation before a new read owner')
    }
    const original = record.base.originals.filter(item => item.kind === 'metadata2-baseline')
    if (original.length !== 1) return editorRecoveryInvalid('one actual sealed baseline original required')
    const baseline = this.store.reopenSyncedRecoveryBaseline(event.senderFrame!, { sessionId: input.sessionId, groupId: owner.groupId,
      originalKey: original[0].key, originalRecordHash: original[0].requestHash })
    cold.completion = undefined
    if (baseline.status === 'ready' && record.draft.replayJson !== undefined) {
      const db = this.store.getUnsafeDatabaseHandle()
      try {
        const owner = db.transaction(() => prepareCanonicalRecoveryCompletionOwned(db, record, baseline))()
        cold.completion = { kind: 'baseline', owner, sessionId: input.sessionId, readOwnerId: baseline.readOwnerId, draftSessionId: record.draft.draftSessionId }
      } catch { /* The genuine baseline can still serve a read. Retirement requires the complete original branch. */ }
    }
    return { record, baseline, writePermit: false, historicalKeyLineageComplete: false,
      ...(verifyCanonicalOriginalAlias(record) ? { canonicalOriginalAliasVerified: true } : {}) }
  }
  prepareGroupFloor(event: EditorCloseIpcEvent, value: unknown): PreparedEditorRecoveryGroupFloor {
    const input = validatePrepareEditorRecoveryGroupFloorInput(value), cold = this.cold.get(input.recoveryOwnerId)
    if (!cold) return editorRecoveryInvalid('not an actual new cold recovery owner')
    this.sameFrame(event, cold)
    const record = this.side.read(cold.expected), draftSessionId = record.draft.draftSessionId, head = this.side.head(draftSessionId), base = record.base.owner
    if (!head || JSON.stringify(head.expected) !== JSON.stringify(cold.expected) || base.kind !== 'group'
      || this.live.has(draftSessionId) || this.dormant.has(draftSessionId)) {
      return editorRecoveryInvalid('cold group follow-up must come from the current detached side head')
    }
    const occurrence = { sessionId: input.sessionId, groupId: base.groupId, instance: input.instance }
    const { floor, owner } = this.store.readSyncedRecoveryGroup(event.senderFrame!, occurrence, db => {
      const floor = attestCanonicalRecoveryAcceptedFloorOwned(db, record)
      if (!floor) return editorRecoveryInvalid('original accepted operation is not the current group floor')
      const owner = prepareCanonicalRecoveryFollowupCompletionOwned(db, record, floor)
      return { floor, owner }
    })
    cold.completion = { kind: 'floor', owner, draftSessionId, ...occurrence }
    return { record, floor, writePermit: false, historicalKeyLineageComplete: false }
  }
  /** This transfers a local durable draft. The new canonical Save/Undo/Redo
   * still use the actual editing session and ordinary revision fences. */
  prepareGroupCrossMove(event: EditorCloseIpcEvent, value: unknown): PreparedEditorRecoveryCrossMove {
    const input = validatePrepareEditorRecoveryCrossMoveInput(value), cold = this.cold.get(input.recoveryOwnerId)
    if (!cold) return editorRecoveryInvalid('the original host recovery visit is unavailable')
    this.sameFrame(event, cold)
    const target = this.live.get(input.targetDraftSessionId)
    if (!target || target.groupSessionId !== input.sessionId) return editorRecoveryInvalid('the receiving producer does not belong to the actual new editing session')
    this.sameFrame(event, target)
    const base = this.side.readBase(target.base), groupOwner = base.owner, requestHash = hostHash(input)
    if (groupOwner.kind !== 'group') return editorRecoveryInvalid('a cross-host draft needs its actual receiving group producer')
    const occurrence = { sessionId: input.sessionId, groupId: groupOwner.groupId, instance: input.instance }
    if (cold.crossMoveTransfer) {
      const settled = cold.crossMoveTransfer, head = this.side.head(input.targetDraftSessionId)
      if (settled.requestHash !== requestHash || !head || !hostEqual(head.expected, settled.head)) return editorRecoveryInvalid('the committed transfer receipt or receiving generation changed')
      const baseline = this.store.readSyncedRecoveryGroup(event.senderFrame!, occurrence, db => {
        const [actual] = getSyncedGroupSnapshots(db, { groupIds: [groupOwner.groupId] }).items
        if (actual?.status !== 'ready' || hostHash(actual.snapshot) !== settled.baselineHash) return editorRecoveryInvalid('the receiving group changed after the transfer')
        return actual.snapshot
      })
      return { record: head.record, head: head.expected, baseline, writePermit: false }
    }
    const host = this.side.read(cold.expected), group = this.side.readCurrentCrossMoveGroup(cold.expected)
    if (!group || [host, group].some(record => this.live.has(record.draft.draftSessionId) || this.dormant.has(record.draft.draftSessionId))) {
      return editorRecoveryInvalid('the original paired heads must still be current and detached')
    }
    const { baseline, head } = this.store.readSyncedRecoveryGroup(event.senderFrame!, occurrence, db => {
      const plan = prepareCanonicalCrossMoveTransferOwned(db, host, group, { base, draftSessionId: input.targetDraftSessionId,
        instance: input.instance, proofHash: input.proofHash })
      const { canonicalOriginalAliasHash: _oldAlias, ...record } = group
      readCanonicalRecoveryClosedFrames({ ...record, base, draft: plan.draft }, plan.snapshot, base.workspaceScope)
      const [{ draftSessionId: _session, ...head }] = this.side.transferCrossMoveGroup(cold.expected, target.base, plan.draft, plan.retireBatchHost).records
      return { baseline: plan.snapshot, head }
    })
    cold.crossMoveTransfer = { requestHash, head, baselineHash: hostHash(baseline) }
    target.receivedCrossMove = true
    return { record: this.side.read(head), head, baseline, writePermit: false }
  }
  /** Hot moves carry only a durable head address. The actual fenced writer
   * receives the immutable original invocation from Main's own side store. */
  applyHotCrossMove(event: EditorCloseIpcEvent, value: unknown,
    dispatch: (input: SyncedEditingRequest<'applySyncedHostStructure'>) => SyncedEditingResult<'applySyncedHostStructure'>): ApplyEditorRecoveryCrossMoveResult {
    const frame = this.frame(event), { sessionId, hostHead } = validateApplyEditorRecoveryCrossMoveInput(value)
    const host = this.side.read(hostHead), group = this.side.readCurrentCrossMoveGroup(hostHead)
    if (!group) return { status: 'rejected' }
    const move = readCanonicalCrossMoveRequest(host.base, host.draft)
    if (!move) return { status: 'rejected' }
    const hostId = host.draft.draftSessionId, groupId = group.draft.draftSessionId
    const prior = this.completedCrossMoves.get(hostId), db = this.store.getUnsafeDatabaseHandle()
    const committed = () => db.transaction(() => {
      const [row] = attestEditorRecoveryPendingOwned(db, host)
      if (row?.status !== 'committed-attested' || !('hosts' in row.result)) return null
      return readCanonicalCrossMoveRecoveryOwned(db, host, group) ? row.result : null
    })()
    if (prior) {
      this.sameFrame(event, prior)
      if (prior.sessionId !== sessionId || !hostEqual(prior.hostHead, hostHead)) return { status: 'rejected' }
      const result = committed()
      return result ? { status: 'moved', result } : { status: 'rejected' }
    }
    const hostOwner = this.live.get(hostId), groupOwner = this.live.get(groupId)
    if (!hostOwner || !groupOwner || groupOwner.groupSessionId !== sessionId) return { status: 'rejected' }
    this.sameFrame(event, hostOwner); this.sameFrame(event, groupOwner)
    const alreadyCommitted = committed()
    if (!alreadyCommitted) {
      const admissible = this.store.readSyncedRecoveryGroup(frame, { sessionId, groupId: move.groupId, instance: move.binding }, db => {
        try {
          const now = new Date().toISOString(), dependencyIds = move.dependencyDocumentIds
          const batch = move.kind === 'batch' ? readCanonicalBatchCrossMoveJournal(captureCrossHostBatchJournal(db, move.input, now)) : undefined
          const linked = move.kind === 'single' && dependencyIds.length
            ? readCanonicalLinkedCrossMoveJournal(captureCrossHostLinkJournal(db, move.input, now)) : undefined
          const single = move.kind === 'single' ? linked?.original ?? decodeCrossHostJournal4(captureCrossHostJournal4(db, move.input, now)) : undefined
          const original = batch?.original ?? single
          if (!original || !hostEqual(original.crossMove.outsideIncoming, dependencyIds)) return false
          if (batch && !readCanonicalBatchInitiatingHost(batch.original, host)) return false
          const v4 = !linked && single
          const stationary = single ? readCanonicalStationaryInstances(single, move.groupId, move.binding.instanceId) : undefined
          if ((v4 && !matchesCanonicalV4CrossMoveForest(v4, move.binding.instanceId)) || (single && !stationary)) return false
          if (linked || batch) {
            const checkDraft = this.crossMoveDraftCheck(event)
            const outside = new Set(dependencyIds)
            if (original.persisted.some(page => outside.has(page.documentId) && !checkDraft(page.documentId, page.content))) return false
          }
          if (linked || batch || stationary?.length) {
            const groups = new Set(original.groups.filter(item => batch || stationary?.length || item.groupId !== move.groupId).map(item => item.groupId))
            if (groups.size && this.side.someHead(record => record.base.workspaceScope === host.base.workspaceScope
              && record.base.recoveryEpoch === host.base.recoveryEpoch && record.base.owner.kind === 'group' && groups.has(record.base.owner.groupId)
              && record.recordId !== group.recordId && !alreadySavedCanonicalRecoveryOwned(db, record))) return false
          }
          const target = original.after.find(page => page.documentId === move.targetDocumentId)
          const leaf = target?.content.blocks.find(block => block.id === move.binding.instanceId)
          if (leaf?.type !== 'synced-block') return false
          const parent = target?.content.blocks.find(block => block.id === leaf.parentBlockId)
          return canCaptureCanonicalCrossMoveGroupOwned(db, host.base, move, group,
            { depth: leaf.depth, parentBlockId: leaf.parentBlockId, parentType: parent?.type ?? null }, stationary?.map(item => item.position))
        } catch (error) {
          if (error instanceof CrossMoveJournalError || error instanceof MoveRefused) return false
          throw error
        }
      })
      if (!admissible) return { status: 'rejected' }
      const applied = dispatch({ sessionId, method: 'applySyncedHostStructure', input: move.input })
      if (applied.status !== 'applied') return { status: 'rejected' }
    }
    const result = alreadyCommitted ?? committed()
    if (!result) return editorRecoveryInvalid('retained cross-host move lacks its exact committed original')
    this.live.delete(hostId); this.live.delete(groupId)
    this.completedCrossMoves.set(hostId, { sender: event.sender, frame, sessionId, hostHead })
    if (this.completedCrossMoves.size > 256) this.completedCrossMoves.delete(this.completedCrossMoves.keys().next().value!)
    return { status: 'moved', result }
  }
  /** The actual explicit Save has already used the normal business writer.
   * Only its complete accepted original branch can retire this old cold head. */
  completeGroup(event: EditorCloseIpcEvent, value: unknown): boolean {
    const input = validateCompleteEditorRecoveryGroupInput(value), cold = this.cold.get(input.recoveryOwnerId)
    if (!cold) return false
    this.sameFrame(event, cold)
    const completion = cold.completion
    if (!completion || completion.sessionId !== input.sessionId
      || this.live.has(completion.draftSessionId) || this.dormant.has(completion.draftSessionId)) return false
    const head = this.side.head(completion.draftSessionId)
    if (!head || JSON.stringify(head.expected) !== JSON.stringify(cold.expected)) return false
    const attest = (db: ReturnType<KnowbookStore['getUnsafeDatabaseHandle']>) =>
      attestCanonicalRecoveryCompletionOwned(db, completion.owner, head.record, input.accepted)
    let saved: boolean
    if (completion.kind === 'floor') {
      if (input.readOwnerId !== undefined) return false
      saved = this.store.readSyncedRecoveryGroup(event.senderFrame!, { sessionId: input.sessionId, groupId: completion.groupId, instance: completion.instance }, attest)
    } else {
      if (completion.readOwnerId !== input.readOwnerId) return false
      const ready = this.store.invokeSyncedEditingSession(event.senderFrame!, { sessionId: input.sessionId, method: 'validateOwner', input: { readOwnerId: completion.readOwnerId } })
      if (ready.status !== 'ready') return false
      const db = this.store.getUnsafeDatabaseHandle()
      if (db.inTransaction) return editorRecoveryInvalid('canonical completion requires its own actual Main snapshot')
      saved = db.transaction(() => attest(db))()
    }
    if (!saved) return false
    this.side.decide(cold.expected, 'discard')
    this.cold.delete(input.recoveryOwnerId)
    // Leave collection to normal write/frame release so an unrelated current
    // close receipt remains valid until its actual acknowledgement.
    return true
  }
  decide(event: EditorCloseIpcEvent, recoveryOwnerId: string, decision: EditorRecoveryDecision): EditorRecoveryRecord | null {
    const owner = this.cold.get(recoveryOwnerId)
    if (!owner) return editorRecoveryInvalid('not an actual new cold recovery owner')
    this.sameFrame(event, owner)
    const record = this.side.read(owner.expected), state = this.examine(record)
    const producer = this.live.get(record.draft.draftSessionId) ?? this.dormant.get(record.draft.draftSessionId)
    if (decision === 'discard' && (producer?.receivedCrossMove || producer?.sender === event.sender && producer.frame === event.senderFrame)) {
      return editorRecoveryInvalid('a cold discard cannot retire an actual live or dormant editor producer')
    }
    if (decision === 'restore-draft' && state.mode === 'view-only' && !state.canonicalSourceAvailable) {
      return editorRecoveryInvalid('candidate requires explicit review; no current database overwrite or fresh-baseline substitution')
    }
    this.side.decide(owner.expected, decision)
    if (decision === 'discard') {
      const live = this.live.get(record.draft.draftSessionId)
      if (live && live.sender === event.sender && live.frame === event.senderFrame) this.live.delete(record.draft.draftSessionId)
      const dormant = this.dormant.get(record.draft.draftSessionId)
      if (dormant && dormant.sender === event.sender && dormant.frame === event.senderFrame) this.dormant.delete(record.draft.draftSessionId)
      this.collect()
    }
    if (decision !== 'keep') this.cold.delete(recoveryOwnerId)
    // Even the positive case returns a local draft only. Save/Apply is a later
    // explicit user action through the ordinary current CAS/fenced writer.
    return decision === 'restore-draft' ? record : null
  }
  releaseSender(sender: EditorCloseIpcEvent['sender']): void {
    for (const [id, value] of this.live) if (value.sender === sender) this.live.delete(id)
    for (const [id, value] of this.dormant) if (value.sender === sender) this.dormant.delete(id)
    for (const [id, value] of this.cold) if (value.sender === sender) this.cold.delete(id)
    for (const [id, value] of this.openings) if (value.sender === sender) this.openings.delete(id)
    for (const [id, value] of this.completedCrossMoves) if (value.sender === sender) this.completedCrossMoves.delete(id)
    this.collect()
  }
  dispose(): void { this.live.clear(); this.dormant.clear(); this.cold.clear(); this.openings.clear(); this.completedCrossMoves.clear() }
}
