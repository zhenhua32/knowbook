import type { EditorCloseAcknowledgement } from '../../shared/editor-close'
import { editorRecoveryInvalid, validateEditorRecoveryBatch, type EditorRecoveryReceipt } from '../../shared/editor-recovery-drafts'
import type { EditorCloseBarrier, EditorCloseIpcEvent, EditorCloseRecoveryCapture } from '../editor-close-barrier'
import { EditorRecoveryDraftStore } from './draft-store'
import { EditorRecoveryDraftService } from './draft-service'

type Bound = { sender: EditorCloseIpcEvent['sender']; capture: EditorCloseRecoveryCapture; boundary: { workspaceScope: string; recoveryEpoch: string } }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Main-only link between actual close capture, full live owner closure, and
 * the side-store COMMIT receipt. Renderer receives only the receipt ID/value. */
export class EditorRecoveryCloseReceipts {
  private readonly receipts = new Map<string, Bound>()
  constructor(private readonly side: EditorRecoveryDraftStore, private readonly service: EditorRecoveryDraftService,
    private readonly barrier: Pick<EditorCloseBarrier, 'captureRecovery' | 'readRecoveryCapture'>) {}
  private prune(event: EditorCloseIpcEvent): void {
    for (const [id, bound] of this.receipts) if (bound.sender === event.sender && !this.barrier.readRecoveryCapture(event, bound.capture)) this.receipts.delete(id)
  }
  seal(event: EditorCloseIpcEvent, requestId: string, value: unknown): EditorRecoveryReceipt {
    this.prune(event)
    const capture = this.barrier.captureRecovery(event, requestId)
    if (!capture) return editorRecoveryInvalid('not the actual current waiting close/frame/generation')
    const request = this.barrier.readRecoveryCapture(event, capture)
    if (!request) return editorRecoveryInvalid('actual close capture expired')
    const drafts = validateEditorRecoveryBatch(value), ids = drafts.map(draft => draft.draftSessionId).sort()
    if (!same(ids, this.service.activeDraftSessionIds(event))) return editorRecoveryInvalid('whole-window active draft owner closure is incomplete')
    if (drafts.some(draft => draft.composing || draft.importing || draft.sources.some(source => source.composing || source.importing || source.applying)))
      return editorRecoveryInvalid('IME, import or Source Apply still owns active input; preserve window')
    const boundary = this.service.currentBoundary(event)
    this.service.assertCloseBoundary(event, boundary)
    const receipt = this.service.write(event, { records: drafts }, { kind: 'close', requestId: request.requestId, closeGeneration: request.closeGeneration })
    if (!same(this.barrier.readRecoveryCapture(event, capture), request) || !same(this.service.currentBoundary(event), boundary))
      return editorRecoveryInvalid('close/frame/epoch changed after actual draft COMMIT; data is retained but no close permit is published')
    for (const [id, bound] of this.receipts) if (bound.sender === event.sender) this.receipts.delete(id)
    this.receipts.set(receipt.receiptId, { sender: event.sender, capture, boundary })
    return receipt
  }
  verify(event: EditorCloseIpcEvent, value: Extract<EditorCloseAcknowledgement, { status: 'draft-journaled' }>): boolean {
    this.prune(event)
    const bound = this.receipts.get(value.receiptId)
    if (!bound || bound.sender !== event.sender) return false
    const capture = this.barrier.readRecoveryCapture(event, bound.capture)
    if (!capture || capture.requestId !== value.requestId || capture.closeGeneration !== value.closeGeneration) return false
    if (!same(bound.boundary, this.service.currentBoundary(event))) return false
    this.service.assertCloseBoundary(event, bound.boundary)
    const receipt = this.side.readReceipt(value.receiptId, true)
    if (receipt.purpose !== 'close' || receipt.requestId !== capture.requestId || receipt.closeGeneration !== capture.closeGeneration
      || !same(receipt.records.map(item => item.draftSessionId).sort(), this.service.liveDraftSessionIds(event))) return false
    for (const item of receipt.records) {
      const draft = this.side.read(item).draft
      if (draft.composing || draft.importing || draft.sources.some(source => source.composing || source.importing || source.applying)) return false
    }
    // A new SQL snapshot after the side-store read catches a real intervening
    // workspace replacement; matching old words/paths never substitutes.
    return same(bound.boundary, this.service.currentBoundary(event)) && same(capture, this.barrier.readRecoveryCapture(event, bound.capture))
  }
  releaseSender(sender: EditorCloseIpcEvent['sender']): void { for (const [id, value] of this.receipts) if (value.sender === sender) this.receipts.delete(id) }
}
