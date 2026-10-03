import type { DocumentDatabaseFieldValue } from '@shared/contracts'

export type DatabaseValueCommitResult =
  | { status: 'saved'; value: DocumentDatabaseFieldValue; refreshError?: string; refreshConfirmed?: true }
  | { status: 'failed'; message: string }

export type DatabaseTextDraft = {
  raw: string
  baseline: DocumentDatabaseFieldValue
  observedValue: DocumentDatabaseFieldValue
  revision?: string
  status: 'dirty' | 'saving' | 'failed' | 'saved' | 'refreshing'
  message: string
  action: 'retry' | 'refresh' | null
  operation: symbol | null
}

export function formatTextDraft(value: DocumentDatabaseFieldValue): string {
  return Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : ''
}

/** In-memory cell drafts outlive virtual rows and temporary workspace unmounts. */
export class DatabaseTextDraftCache {
  private entries = new Map<string, DatabaseTextDraft>()
  private listeners = new Map<string, Set<() => void>>()

  get(key: string) { return this.entries.get(key) }
  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key) }
  }
  private publish(key: string, draft?: DatabaseTextDraft) {
    if (draft) this.entries.set(key, draft)
    else this.entries.delete(key)
    this.listeners.get(key)?.forEach(listener => listener())
  }
  sync(key: string, value: DocumentDatabaseFieldValue, revision?: string) {
    const draft = this.get(key)
    if (draft?.status === 'saving' && draft.operation) {
      if (revision !== draft.revision || formatTextDraft(value) !== formatTextDraft(draft.observedValue)) {
        this.publish(key, { ...draft, observedValue: value, revision })
      }
      return
    }
    if (draft?.action === 'refresh' && (revision === undefined || revision === draft.revision)) return
    // A successful write is authoritative until props acknowledge that value.
    if (draft?.status === 'saved' && (formatTextDraft(value) === formatTextDraft(draft.baseline)
      || revision !== undefined && revision !== draft.revision
      || revision === undefined && formatTextDraft(value) !== formatTextDraft(draft.observedValue))) this.publish(key)
  }
  edit(key: string, value: DocumentDatabaseFieldValue, raw: string, revision?: string) {
    const draft = this.get(key)
    if (draft?.operation) return
    this.publish(key, { raw, baseline: draft ? draft.baseline : value, observedValue: draft ? draft.observedValue : value,
      revision: draft ? draft.revision : revision, status: 'dirty', message: '', action: null, operation: null })
  }
  restore(key: string, draft?: DatabaseTextDraft) {
    if (!this.get(key)?.operation && !draft?.operation) this.publish(key, draft)
  }
  async commit(key: string, value: DocumentDatabaseFieldValue,
    change: (value: DocumentDatabaseFieldValue) => void | Promise<void | DatabaseValueCommitResult>, fallback: string,
    observed?: { value: DocumentDatabaseFieldValue; revision?: string }) {
    const draft = this.get(key)
    if (!draft || draft.operation || draft.status === 'saved') return
    const submitted = observed ?? { value: draft.observedValue, revision: draft.revision }
    const operation = Symbol()
    this.publish(key, { ...draft, observedValue: submitted.value,
      revision: submitted.revision, operation, status: 'saving', message: '', action: draft.action === 'retry' ? 'retry' : null })
    let result: void | DatabaseValueCommitResult
    try { result = await change(value) }
    catch { result = { status: 'failed', message: fallback } }
    const current = this.get(key)
    if (current?.operation !== operation) return
    if (result && result.status === 'failed') {
      this.publish(key, { ...current, operation: null, status: 'failed', message: result.message || fallback, action: 'retry' })
    } else {
      const saved = result && result.status === 'saved' ? result.value : value
      const message = result && result.status === 'saved' ? result.refreshError ?? '' : ''
      const seen = result && result.status === 'saved' && result.refreshConfirmed
        ? submitted : { value: current.observedValue, revision: current.revision }
      this.publish(key, { ...current, observedValue: seen.value, revision: seen.revision, raw: formatTextDraft(saved),
        baseline: saved, operation: null, status: 'saved', message, action: message ? 'refresh' : null })
    }
  }
  async refresh(key: string, read: () => Promise<void>, fallback: string) {
    const draft = this.get(key)
    if (!draft || draft.operation || draft.action !== 'refresh') return
    const operation = Symbol()
    this.publish(key, { ...draft, operation, status: 'refreshing', message: '' })
    let message = ''
    try { await read() }
    catch { message = fallback }
    const current = this.get(key)
    if (current?.operation === operation) this.publish(key, { ...current, operation: null, status: 'saved', message, action: message ? 'refresh' : null })
  }
  prune(sourceId: string, recordIds: Set<string>, fieldIds: Set<string>) {
    for (const key of this.entries.keys()) {
      const [source, record, field] = JSON.parse(key) as string[]
      if (source === sourceId && (!recordIds.has(record) || !fieldIds.has(field))) this.publish(key)
    }
  }
}
