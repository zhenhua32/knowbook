import type { DocumentDatabaseFieldValue } from '@shared/contracts'

export type DatabaseValueCommitResult =
  | { status: 'saved'; value: DocumentDatabaseFieldValue; refreshError?: string; refreshConfirmed?: true;
      refresh?: (isCurrent: () => boolean) => Promise<void | boolean> }
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
  readOperation?: symbol | null
  readLease?: { active: boolean } | null
}

export function formatTextDraft(value: DocumentDatabaseFieldValue): string {
  return Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : ''
}

/** In-memory cell drafts outlive virtual rows and temporary workspace unmounts. */
export class DatabaseTextDraftCache {
  private entries = new Map<string, DatabaseTextDraft>()
  private listeners = new Map<string, Set<() => void>>()
  private readFlights = new Map<string, Promise<void>>()

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
  private revokeRead(draft?: DatabaseTextDraft) {
    if (draft?.readLease) draft.readLease.active = false
  }
  sync(key: string, value: DocumentDatabaseFieldValue, revision?: string) {
    const draft = this.get(key)
    if (draft && (draft.status === 'saving' && draft.operation || draft.readOperation)) {
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
    this.revokeRead(draft)
    this.publish(key, { raw, baseline: draft ? draft.baseline : value, observedValue: draft ? draft.observedValue : value,
      revision: draft ? draft.revision : revision, status: 'dirty', message: '', action: null, operation: null,
      readOperation: null, readLease: null })
  }
  restore(key: string, draft?: DatabaseTextDraft) {
    const current = this.get(key)
    if (current?.operation || draft?.operation) return
    this.revokeRead(current)
    // Escape must not revive a read that editing has already revoked.
    this.publish(key, draft ? { ...draft, readOperation: null, readLease: null,
      status: draft.status === 'refreshing' ? 'saved' : draft.status } : undefined)
  }
  async commit(key: string, value: DocumentDatabaseFieldValue,
    change: (value: DocumentDatabaseFieldValue) => void | Promise<void | DatabaseValueCommitResult>, fallback: string,
    observed?: { value: DocumentDatabaseFieldValue; revision?: string }, refreshFallback = fallback) {
    const draft = this.get(key)
    if (!draft || draft.operation || draft.status === 'saved') return
    this.revokeRead(draft)
    const submitted = observed ?? { value: draft.observedValue, revision: draft.revision }
    const operation = Symbol()
    this.publish(key, { ...draft, observedValue: submitted.value,
      revision: submitted.revision, operation, readOperation: null, readLease: null,
      status: 'saving', message: '', action: draft.action === 'retry' ? 'retry' : null })
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
      const refresh = result && result.status === 'saved' ? result.refresh : undefined
      const readOperation = refresh ? Symbol() : null
      const readLease = refresh ? { active: true } : null
      const acknowledged: DatabaseTextDraft = { ...current, observedValue: seen.value, revision: seen.revision,
        raw: formatTextDraft(saved), baseline: saved, operation: null, readOperation, readLease,
        status: 'saved', message, action: message || refresh ? 'refresh' : null }
      this.publish(key, acknowledged)
      if (refresh && readLease) void this.read(key, readLease, refresh, refreshFallback, acknowledged)
    }
  }
  async refresh(key: string, read: (isCurrent: () => boolean) => Promise<void | boolean>, fallback: string) {
    const draft = this.get(key)
    if (!draft || draft.operation || draft.readOperation || draft.action !== 'refresh') return
    this.revokeRead(draft)
    const readLease = { active: true }
    this.publish(key, { ...draft, readOperation: Symbol(), readLease, message: '' })
    await this.read(key, readLease, read, fallback, draft)
  }
  private read(key: string, lease: { active: boolean }, read: (isCurrent: () => boolean) => Promise<void | boolean>,
    fallback: string, started: DatabaseTextDraft) {
    const previous = this.readFlights.get(key)
    // Publication ownership outlives the progress flag: React may apply the
    // Page's guarded state updaters after this promise finishes.
    const isCurrent = () => lease.active
    const task = (async () => {
      if (previous) await previous
      if (!isCurrent()) return
      let message = started.message, confirmed = false
      try {
        confirmed = await read(isCurrent) !== false
        if (confirmed) message = ''
      } catch { message = fallback }
      const current = this.get(key)
      if (!lease.active || current?.readLease !== lease) return
      const seen = confirmed ? started : current
      this.publish(key, { ...current, readOperation: null, observedValue: seen.observedValue, revision: seen.revision,
        message, action: confirmed ? null : 'refresh' })
    })()
    this.readFlights.set(key, task)
    void task.then(() => { if (this.readFlights.get(key) === task) this.readFlights.delete(key) })
    return task
  }
  prune(sourceId: string, recordIds: Set<string>, fieldIds: Set<string>) {
    for (const key of this.entries.keys()) {
      const [source, record, field] = JSON.parse(key) as string[]
      if (source === sourceId && (!recordIds.has(record) || !fieldIds.has(field))) {
        this.revokeRead(this.get(key))
        this.publish(key)
      }
    }
  }
}
