import type { EditorRecoveryDraftInput, EditorRecoveryWorkspace } from '@shared/editor-recovery-drafts'

type Version = { recordId: string; generation: number; hash: string }
type Entry = { input: EditorRecoveryDraftInput; version?: Version }
type CloseRequest = { requestId: string; closeGeneration: number }

export type EditorRecoveryCapture = {
  owner: object
  draft?: { kind: EditorRecoveryDraftInput['kind']; targetId: string; data: unknown }
}

/** The renderer records intentions; only Main can issue a durable receipt.
 * A capture without a draft keeps the last checkpoint during native IME. */
export class EditorRecoveryJournal {
  private readonly entries = new Map<object, Entry>()
  private readonly localSessions = new Set<string>()
  private workspace: Promise<EditorRecoveryWorkspace> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private tail = Promise.resolve()
  private closeGeneration = 0

  constructor(private readonly capture: () => EditorRecoveryCapture[], private readonly failed: (error: unknown) => void) {}

  start() {
    if (typeof window.knowbook?.getEditorRecoveryWorkspace !== 'function' || this.workspace) return
    this.workspace = window.knowbook.getEditorRecoveryWorkspace()
    void this.workspace.catch(error => this.failed(error))
  }

  ownsSession(draftSessionId: string) { return this.localSessions.has(draftSessionId) }

  schedule() {
    if (this.timer || !this.workspace) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.enqueue(async () => { await this.persist(this.capture()) }).catch(error => this.failed(error))
    }, 250)
  }

  pause() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  settle(isCurrent: () => boolean) {
    return this.enqueue(async () => { if (this.workspace && isCurrent()) await this.persist([]) })
  }

  close(requestId: string, isCurrent: () => boolean) {
    return this.enqueue(async () => {
      if (!this.workspace || !isCurrent()) return null
      const captured = this.capture()
      if (captured.some(item => !item.draft)) return null
      const close = { requestId, closeGeneration: ++this.closeGeneration }
      const signature = await this.signature(captured)
      if (!isCurrent()) return null
      const receipt = await this.persist(captured, close)
      const current = this.capture()
      if (!receipt || receipt.requestId !== requestId || receipt.closeGeneration !== close.closeGeneration
        || !isCurrent() || captured.some((item, index) => current[index]?.owner !== item.owner)
        || signature !== await this.signature(current) || !isCurrent()) return null
      return { requestId, status: 'draft-journaled' as const, receiptId: receipt.receiptId, closeGeneration: close.closeGeneration }
    })
  }

  private async signature(captured: EditorRecoveryCapture[]) {
    return JSON.stringify(await Promise.all(captured.map(async ({ draft }) => draft && { ...draft, data: await draft.data })))
  }

  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    const result = this.tail.then(write)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private async persist(captured: EditorRecoveryCapture[], close?: CloseRequest) {
    const active = new Set(captured.map(item => item.owner)), writes: Entry[] = []
    for (const { owner, draft } of captured) {
      if (!draft) continue
      const { kind, targetId, data } = draft, payload = JSON.stringify(await data)
      const prior = this.entries.get(owner)
      if (prior?.input.payload === payload && prior.input.kind === kind && prior.input.targetId === targetId) {
        if (close || prior.version?.generation !== prior.input.generation) writes.push(prior)
        continue
      }
      if (prior && (prior.input.kind !== kind || prior.input.targetId !== targetId)) throw new Error('The recovery draft owner changed.')
      const input = { kind, targetId, payload, draftSessionId: prior?.input.draftSessionId ?? crypto.randomUUID(),
        generation: (prior?.input.generation ?? 0) + 1 }
      const entry = { input, version: prior?.version }
      this.entries.set(owner, entry)
      this.localSessions.add(input.draftSessionId)
      writes.push(entry)
    }
    let receipt: Awaited<ReturnType<typeof window.knowbook.writeEditorRecoveryDrafts>> | undefined
    if (writes.length) {
      const workspace = await this.workspace!
      receipt = await window.knowbook.writeEditorRecoveryDrafts({ workspace, records: writes.map(entry => entry.input), ...(close ? { close } : {}) })
      const versions = new Map(receipt.records.map(item => [item.draftSessionId, item]))
      if (versions.size !== writes.length || writes.some(entry => versions.get(entry.input.draftSessionId)?.generation !== entry.input.generation)) {
        throw new Error('The durable recovery receipt did not cover the full draft.')
      }
      for (const entry of writes) {
        const { recordId, generation, hash } = versions.get(entry.input.draftSessionId)!
        entry.version = { recordId, generation, hash }
      }
    }
    for (const [owner, entry] of this.entries) {
      if (active.has(owner)) continue
      if (entry.version) await window.knowbook.discardEditorRecoveryDraft(entry.version)
      this.entries.delete(owner)
      this.localSessions.delete(entry.input.draftSessionId)
    }
    return receipt
  }
}
