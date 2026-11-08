import type { EditorRecoveryDraftInput, EditorRecoveryExpected, EditorRecoveryOpened, EditorRecoveryPending, OpenEditorRecoveryDraftInput,
  EditorRecoveryReceipt, EditorRecoveryWorking } from '@shared/editor-recovery-drafts'
import { validateEditorRecoveryDraftInput } from '@shared/editor-recovery-drafts'
import { canonicalSyncedPortableJson } from '@shared/syncedBlockPortable'
import { readRecoverySources, recoveryData, subscribeRecoverySources, type RecoverySourceAddress } from './sourceSnapshots'

export type RecoveryContent = Omit<EditorRecoveryDraftInput, 'draftSessionId' | 'generation' | 'expectedPreviousGeneration' | 'sources'> & {
  rawPending?: RawRecoveryPending[]
  /** Private producer fact. Equal W bytes can still carry real authored frames
   * and copy intent. Never add this local accounting flag to the side DTO. */
  authoredWork?: boolean
}
export interface RawRecoveryPending {
  method: EditorRecoveryPending['method']; input: { clientOperationId: string }; submittedWorking: EditorRecoveryWorking
}
type Entry = { identity: object; address: RecoverySourceAddress; opening: () => Promise<EditorRecoveryOpened>;
  read: () => RecoveryContent | null; retained: RecoveryContent | null; detached: boolean;
  generation: number; fingerprint: string | null; head: EditorRecoveryExpected | null }
type Capture = { entry: Entry; draft: EditorRecoveryDraftInput; fingerprint: string; unedited: boolean }
async function requestHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
export async function recoveryPending(pending: readonly RawRecoveryPending[]): Promise<EditorRecoveryPending[]> {
  return Promise.all(pending.map(async item => {
    const input = recoveryData(item.input), inputJson = canonicalSyncedPortableJson(input)
    return { method: item.method, clientOperationId: item.input.clientOperationId,
      requestHash: await requestHash(canonicalSyncedPortableJson({ method: item.method, input })), inputJson,
      submittedWorking: recoveryData(item.submittedWorking) as EditorRecoveryWorking }
  }))
}
/** Retry only the original opening nonce. If Main allocated the owner before a
 * transport failure, its private memo returns that same sealed B/session. */
type WithoutOpeningNonce<T> = T extends unknown ? Omit<T, 'openRequestId'> & { openRequestId?: string } : never
export function recoveryOpening(input: WithoutOpeningNonce<OpenEditorRecoveryDraftInput>): () => Promise<EditorRecoveryOpened> {
  const request = { ...input, openRequestId: input.openRequestId ?? crypto.randomUUID() }
  let pending: Promise<EditorRecoveryOpened> | null = null
  return () => pending ??= Promise.resolve().then(() => window.knowbook.openEditorRecoveryDraft(request)).catch(error => { pending = null; throw error })
}

/** One window registry. Sources and dormant owners remain represented until
 * Main proves the exact latest generation is clean, or an explicit recovery
 * decision discards it. IPC success never means the business operation saved. */
export class EditorRecoveryCoordinator {
  private entries = new Map<object, Entry>()
  private parked = new Map<string, EditorRecoveryExpected>()
  private queue: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private frozen = false
  private lastError: unknown = null
  private pendingOriginal: Capture[] | null = null
  constructor() { subscribeRecoverySources(() => this.changed()) }
  register(identity: object, address: RecoverySourceAddress, opening: () => Promise<EditorRecoveryOpened>, read: () => RecoveryContent | null): void {
    if (this.entries.has(identity)) return
    // Catch now so a failed lazy opening cannot produce an unhandled rejection;
    // capture still awaits the original rejection and fails closed.
    void opening().catch(error => { this.lastError = error })
    const entry: Entry = { identity, address: { ...address }, opening, read, retained: null,
      detached: false, generation: 0, fingerprint: null, head: null }
    this.entries.set(identity, entry)
    try { const current = read(); if (current) entry.retained = recoveryData(current) as RecoveryContent }
    catch { /* The initial real controller read is still being published. */ }
    this.changed()
  }
  has(identity: object): boolean { return this.entries.has(identity) }
  observe(identity: object): void { const entry = this.entries.get(identity); if (entry) this.content(entry) }
  changed(): void {
    if (this.frozen) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.background().catch(error => { this.lastError = error }) }, 500)
  }
  freeze(): void { this.frozen = true; if (this.timer) clearTimeout(this.timer); this.timer = null }
  unfreeze(): void { this.frozen = false; this.changed() }
  private content(entry: Entry): RecoveryContent {
    const current = entry.detached ? null : entry.read()
    if (current) entry.retained = recoveryData(current) as RecoveryContent
    if (!entry.retained) throw new Error('An editor recovery producer is not ready')
    return entry.retained
  }
  private async capture(entry: Entry): Promise<Capture> {
    const opened = await entry.opening(), { rawPending, authoredWork, ...content } = this.content(entry)
    const pending = rawPending ? await recoveryPending(rawPending) : content.pending
    const body = recoveryData({ ...content, pending, sources: readRecoverySources(entry.address) }) as Omit<EditorRecoveryDraftInput, 'draftSessionId' | 'generation' | 'expectedPreviousGeneration'>
    const fingerprint = canonicalSyncedPortableJson(body), generation = fingerprint === entry.fingerprint ? entry.generation : entry.generation + 1
    const draft = validateEditorRecoveryDraftInput({ ...body, draftSessionId: opened.draftSessionId, generation,
      expectedPreviousGeneration: generation === entry.generation ? Math.max(0, generation - 1) : entry.generation })
    return { entry, draft, fingerprint, unedited: !authoredWork && !entry.head && !draft.sources.length && !draft.pending.length
      && !draft.composing && !draft.importing && canonicalSyncedPortableJson(draft.working) === canonicalSyncedPortableJson(opened.base.persistedWorking) }
  }
  private committed(captures: Awaited<ReturnType<EditorRecoveryCoordinator['capture']>>[], receipt: EditorRecoveryReceipt): void {
    const dormant = receipt.purpose === 'close' ? [...this.parked] : []
    if (receipt.records.length !== captures.length + dormant.length) throw new Error('The complete durable owner receipt differs')
    for (const [draftSessionId, expected] of dormant) {
      const item = receipt.records.find(value => value.draftSessionId === draftSessionId)
      if (!item || item.recordId !== expected.recordId || item.generation !== expected.generation || item.hash !== expected.hash) throw new Error('A dormant owner receipt differs')
    }
    for (const capture of captures) {
      const item = receipt.records.find(value => value.draftSessionId === capture.draft.draftSessionId)
      if (!item || item.generation !== capture.draft.generation) throw new Error('The exact owner generation was not acknowledged')
      capture.entry.generation = item.generation; capture.entry.fingerprint = capture.fingerprint
      capture.entry.head = { recordId: item.recordId, generation: item.generation, hash: item.hash }
    }
  }
  /** A transport error does not mean COMMIT failed. Settle this exact original
   * complete capture before reading any later C or assigning its next generation.
   * Side.write's same-generation branch independently compares the complete
   * original payload and returns its existing record ID/hash; no business call,
   * changed capture, new draft nonce or old close permit is retried here. */
  private async settleOriginal(): Promise<void> {
    const pending = this.pendingOriginal
    if (!pending) return
    const receipt = await window.knowbook.writeEditorRecoveryDrafts({ purpose: 'background', records: pending.map(item => item.draft) })
    this.committed(pending, receipt)
    if (this.pendingOriginal === pending) this.pendingOriginal = null
  }
  private async write(captures: Capture[], purpose: { purpose: 'background' } | { purpose: 'close'; requestId: string }): Promise<EditorRecoveryReceipt> {
    if (this.pendingOriginal) throw new Error('The original durable capture has not been settled')
    this.pendingOriginal = captures
    const receipt = await window.knowbook.writeEditorRecoveryDrafts({ ...purpose, records: captures.map(item => item.draft) })
    this.committed(captures, receipt)
    this.pendingOriginal = null
    return receipt
  }
  private async retire(entry: Entry): Promise<void> {
    const content = this.content(entry), sources = readRecoverySources(entry.address)
    if (!entry.detached || content.composing || content.importing || sources.some(source => source.composing || source.importing || source.applying)) return
    const opened = await entry.opening()
    const accepted = !content.authoredWork && !sources.length && !content.pending.length && !content.rawPending?.length
      && await window.knowbook.retireCleanEditorRecoveryDraft({ draftSessionId: opened.draftSessionId, expectedHead: entry.head, working: content.working })
    if (accepted) { if (this.entries.get(entry.identity) === entry) this.entries.delete(entry.identity); return }
    if (!entry.head) throw new Error('An unresolved dormant owner has no durable complete head')
    await window.knowbook.parkEditorRecoveryDraft({ draftSessionId: opened.draftSessionId, expectedHead: entry.head })
    this.parked.set(opened.draftSessionId, entry.head)
    if (this.entries.get(entry.identity) === entry) this.entries.delete(entry.identity)
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation)
    this.queue = pending.then(() => undefined, () => undefined)
    return pending
  }
  background(): Promise<void> {
    return this.serial(async () => {
      if (this.frozen) return
      await this.settleOriginal()
      const captured = await Promise.all([...this.entries.values()].map(entry => this.capture(entry)))
      const changed = captured.filter(item => item.fingerprint !== item.entry.fingerprint && !item.unedited)
      if (changed.length) await this.write(changed, { purpose: 'background' })
      for (const entry of [...this.entries.values()]) await this.retire(entry)
      this.lastError = null
    })
  }
  checkpointPendingHost(identity: object, operationId: string, shouldContinue: () => boolean): Promise<boolean> {
    return this.serial(async () => {
      await this.settleOriginal()
      const entry = this.entries.get(identity)
      const current = () => !this.frozen && shouldContinue() && entry && !entry.detached && this.entries.get(identity) === entry
      if (!entry || entry.address.kind !== 'host' || !current()) return false
      const captured = await this.capture(entry)
      if (!current() || captured.draft.composing || captured.draft.importing || captured.draft.sources.length
        || captured.draft.pending.length !== 1 || captured.draft.pending[0].clientOperationId !== operationId
        || captured.draft.pending[0].method !== 'applySyncedHostStructure') return false
      if (captured.fingerprint !== entry.fingerprint) await this.write([captured], { purpose: 'background' })
      if (!entry.head || !current()) return false
      return (await this.capture(entry)).fingerprint === captured.fingerprint && Boolean(current())
    })
  }
  detach(identity: object): void {
    const entry = this.entries.get(identity)
    if (!entry || entry.detached) return
    this.content(entry); entry.detached = true; this.changed()
  }
  /** A real Save can advance P before Source opens. First register the new
   * Main-sealed B, then retire/park the old complete producer. No Source has
   * been opened yet, so this never supplies a new baseline to an old Source. */
  renewHost(identity: object, input: Omit<Extract<OpenEditorRecoveryDraftInput, { kind: 'host' }>, 'openRequestId'>): Promise<void> {
    return this.serial(async () => {
      if (this.frozen) throw new Error('The editor is closing')
      await this.settleOriginal()
      const previous = this.entries.get(identity)
      if (!previous || previous.detached || previous.address.kind !== 'host' || previous.address.documentId !== input.documentId) throw new Error('The actual host recovery producer is unavailable')
      const content = this.content(previous)
      if (content.composing || content.importing || content.pending.length || content.rawPending?.length || readRecoverySources(previous.address).length) throw new Error('The previous Source/input owner is unfinished')
      const before = await previous.opening()
      if (before.base.owner.kind === 'host' && before.base.owner.updatedAt === input.expectedUpdatedAt
        && canonicalSyncedPortableJson(content.working) === canonicalSyncedPortableJson(before.base.persistedWorking)) return
      const captured = await this.capture(previous)
      if (!captured.unedited && captured.fingerprint !== previous.fingerprint) await this.write([captured], { purpose: 'background' })
      const opening = recoveryOpening(input), oldIdentity = Object.freeze({}), replacement: Entry = {
        identity, address: previous.address, opening, read: previous.read, retained: null, detached: false,
        generation: 0, fingerprint: null, head: null }
      previous.identity = oldIdentity; previous.detached = true
      this.entries.delete(identity); this.entries.set(oldIdentity, previous); this.entries.set(identity, replacement)
      // The placeholder is part of the private whole set before IPC can mint
      // the new owner. A lost response is retried by this same original nonce.
      await opening()
      await this.retire(previous)
      this.changed()
    })
  }
  /** Preserve the final complete saved side before the ordinary flushed ACK.
   * An earlier background A must not masquerade as an unsaved draft after the
   * genuine writer has accepted later C. Current live owners/watermarks remain
   * valid if Main cancels the close; cold list cleanup independently proves C
   * already equals current SQL before removing its head. */
  checkpointFlushed(shouldContinue: () => boolean): Promise<boolean> {
    return this.serial(async () => {
      await this.settleOriginal()
      if (!this.frozen || !shouldContinue()) return false
      const registry = [...this.entries.values()], captures = await Promise.all(registry.map(entry => this.capture(entry)))
      if (captures.some(item => item.draft.sources.length || item.draft.pending.length || item.draft.composing || item.draft.importing)) return false
      const changed = captures.filter(item => !item.unedited && item.fingerprint !== item.entry.fingerprint)
      if (changed.length) await this.write(changed, { purpose: 'background' })
      const after = await Promise.all(registry.map(entry => this.capture(entry)))
      return this.frozen && shouldContinue() && this.entries.size === registry.length
        && registry.every(entry => this.entries.get(entry.identity) === entry)
        && after.every((item, index) => item.fingerprint === captures[index].fingerprint)
    })
  }
  /** Runtime first freezes its genuine producer graph. Pending opening/ACK or
   * native IME cannot be converted to a successful close by a timer. */
  journalClose(requestId: string, shouldContinue: () => boolean): Promise<EditorRecoveryReceipt> {
    return this.serial(async () => {
      await this.settleOriginal()
      if (!this.frozen || !shouldContinue()) throw new Error('The original close is no longer frozen')
      const registry = [...this.entries.values()], captured = await Promise.all(registry.map(entry => this.capture(entry)))
      if (!captured.length && !this.parked.size || captured.some(item => item.draft.composing || item.draft.importing
        || item.draft.sources.some(source => source.composing || source.importing || source.applying))) throw new Error('Composition, import or Source application is unfinished')
      const sameRegistry = () => this.entries.size === registry.length && registry.every(entry => this.entries.get(entry.identity) === entry)
      if (!sameRegistry() || !shouldContinue()) throw new Error('The frozen owner set changed')
      const receipt = await this.write(captured, { purpose: 'close', requestId })
      const after = await Promise.all(registry.map(entry => this.capture(entry)))
      if (!sameRegistry() || !shouldContinue() || after.some((item, index) => item.fingerprint !== captured[index].fingerprint)
        || receipt.purpose !== 'close' || receipt.requestId !== requestId || receipt.closeGeneration === null) throw new Error('The close snapshot changed before acknowledgement')
      return receipt
    })
  }
  diagnostic(): unknown { return this.lastError }
}
let coordinator: EditorRecoveryCoordinator | null = null
export const getEditorRecoveryCoordinator = () => coordinator ??= new EditorRecoveryCoordinator()
