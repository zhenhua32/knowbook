import type { DocumentDatabaseFieldValue } from '@shared/contracts'

export type DatabaseValueCommitResult =
  | { status: 'saved'; value: DocumentDatabaseFieldValue; refreshError?: string; refreshConfirmed?: true;
      refresh?: (isCurrent: () => boolean) => Promise<void | boolean> }
  | { status: 'failed'; message: string }

type SettledTextDraft = {
  raw: string
  status: 'failed' | 'saved'
  message: string
  action: 'retry' | 'refresh' | null
}

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
  settled?: SettledTextDraft
}

export function formatTextDraft(value: DocumentDatabaseFieldValue): string {
  return Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : ''
}

/** In-memory cell drafts outlive virtual rows and temporary workspace unmounts. */
export class DatabaseTextDraftCache {
  private entries = new Map<string, DatabaseTextDraft>()
  private listeners = new Map<string, Set<() => void>>()
  private readFlights = new Map<string, Promise<void>>()
  private currentReadLeases = new Map<string, { active: boolean }>()
  private savedAuthorities = new WeakMap<object, { confirmed: boolean; commitRequired?: boolean }>()

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
  private revokeRead(key: string, draft?: DatabaseTextDraft) {
    if (draft?.readLease) draft.readLease.active = false
    const lease = this.currentReadLeases.get(key)
    if (lease) lease.active = false
    this.currentReadLeases.delete(key)
  }
  private savedAuthority(draft?: DatabaseTextDraft) {
    return draft && (this.savedAuthorities.get(draft)
      ?? (draft.settled?.status === 'saved' ? this.savedAuthorities.get(draft.settled) : undefined))
  }
  private inheritSavedAuthority<T extends object>(source: object, target: T): T {
    const authority = this.savedAuthorities.get(source)
    if (authority) this.savedAuthorities.set(target, authority)
    return target
  }
  captureSavedRefresh(sourceId: string): ReadonlyMap<string, DatabaseTextDraft> {
    const snapshot = new Map<string, DatabaseTextDraft>()
    for (const [key, draft] of this.entries) {
      const settled = draft.status === 'saved' ? draft : draft.settled
      if (settled?.status === 'saved' && settled.action === 'refresh' && !draft.operation
        && (JSON.parse(key) as string[])[0] === sourceId) {
        if (!this.savedAuthorities.has(settled)) this.savedAuthorities.set(settled, { confirmed: false })
        if (draft.readOperation) this.savedAuthorities.get(settled)!.commitRequired = true
        snapshot.set(key, draft)
      }
    }
    return snapshot
  }
  confirmSavedRefresh(snapshot: ReadonlyMap<string, DatabaseTextDraft>) {
    for (const [key, captured] of snapshot) {
      const authority = this.savedAuthority(captured)
      if (!authority) continue
      authority.confirmed = true
      const current = this.get(key)
      if (!current || this.savedAuthority(current) !== authority || current.status !== 'saved' || current.action !== 'refresh'
        || current.operation || current.readOperation) continue
      // The same read can still have other guarded Page updates to publish.
      this.publish(key)
    }
  }
  sync(key: string, value: DocumentDatabaseFieldValue, revision?: string) {
    const draft = this.get(key)
    if (draft && (draft.status === 'saving' && draft.operation || draft.readOperation)) {
      if (revision !== draft.revision || formatTextDraft(value) !== formatTextDraft(draft.observedValue)) {
        this.publish(key, this.inheritSavedAuthority(draft, { ...draft, observedValue: value, revision }))
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
    this.revokeRead(key, draft)
    const settled: SettledTextDraft | undefined = draft?.status === 'failed' || draft?.status === 'saved'
      ? { raw: draft.raw, status: draft.status, message: draft.message, action: draft.action }
      : draft?.settled
    if (draft?.status === 'saved' && settled) this.inheritSavedAuthority(draft, settled)
    const edited: DatabaseTextDraft = { raw, baseline: draft ? draft.baseline : value, observedValue: draft ? draft.observedValue : value,
      revision: draft ? draft.revision : revision, status: 'dirty', message: '', action: null, operation: null,
      readOperation: null, readLease: null, settled }
    this.publish(key, draft ? this.inheritSavedAuthority(draft, edited) : edited)
  }
  restore(key: string, draft?: DatabaseTextDraft) {
    const current = this.get(key)
    if (current?.operation || draft?.operation) return
    this.revokeRead(key, current)
    // Escape must not revive a read that editing has already revoked.
    const authority = this.savedAuthority(draft)
    const restored: DatabaseTextDraft | undefined = draft && !(authority?.confirmed && draft.status === 'saved')
      ? { ...draft, readOperation: null, readLease: null,
          status: draft.status === 'refreshing' ? 'saved' : draft.status } : undefined
    if (restored && draft?.readOperation && current?.status === 'saved' && !current.readOperation
      && this.savedAuthority(current) === authority) {
      restored.message = current.message
      restored.action = current.action
    }
    if (restored && authority) {
      if (authority.confirmed && restored.status === 'dirty') {
        restored.settled = undefined
        restored.message = ''
        restored.action = null
      }
      this.savedAuthorities.set(restored, authority)
    }
    this.publish(key, restored)
  }
  async commit(key: string, value: DocumentDatabaseFieldValue,
    change: (value: DocumentDatabaseFieldValue) => void | Promise<void | DatabaseValueCommitResult>, fallback: string,
    observed?: { value: DocumentDatabaseFieldValue; revision?: string; explicitRetry?: boolean }, refreshFallback = fallback) {
    const draft = this.get(key)
    if (!draft || draft.operation || draft.status === 'saved') return
    this.revokeRead(key, draft)
    const submitted = observed ?? { value: draft.observedValue, revision: draft.revision }
    const settled = draft.status === 'failed' ? draft : draft.settled
    // Inspecting a failed value must not retry its write implicitly.
    if (!observed?.explicitRetry && settled?.status === 'failed'
      && canonicalText(settled.raw) === canonicalText(value)) {
      this.publish(key, { ...draft, status: 'failed', message: settled.message, action: 'retry', settled: undefined,
        readOperation: null, readLease: null })
      return
    }
    const newerProps = this.savedAuthority(draft)?.confirmed
      || submitted.revision !== undefined && submitted.revision !== draft.revision
      || canonicalText(submitted.value) !== canonicalText(draft.observedValue)
    const baseline = newerProps ? submitted.value : draft.baseline
    // Preserve a write ACK against lagging props, but honor a newer server value.
    if (!observed?.explicitRetry && canonicalText(value) === canonicalText(baseline)) {
      const feedback = !newerProps && settled?.status === 'saved'
        && canonicalText(settled.raw) === canonicalText(value) ? settled : undefined
      const acknowledged: DatabaseTextDraft = { ...draft, raw: formatTextDraft(value), baseline: value, status: 'saved',
        observedValue: newerProps ? submitted.value : draft.observedValue,
        revision: newerProps ? submitted.revision : draft.revision,
        message: feedback?.message ?? '', action: feedback?.action ?? null, settled: undefined,
        readOperation: null, readLease: null }
      if (feedback) this.inheritSavedAuthority(feedback, acknowledged)
      this.publish(key, acknowledged)
      return
    }
    const operation = Symbol()
    this.publish(key, { ...draft, observedValue: submitted.value,
      revision: submitted.revision, operation, readOperation: null, readLease: null,
      status: 'saving', message: '', action: draft.action === 'retry' ? 'retry' : null, settled: undefined })
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
      if (acknowledged.action === 'refresh') this.savedAuthorities.set(acknowledged, { confirmed: false })
      if (readLease) this.currentReadLeases.set(key, readLease)
      this.publish(key, acknowledged)
      if (refresh && readLease) void this.read(key, readLease, refresh, refreshFallback, acknowledged)
    }
  }
  async refresh(key: string, read: (isCurrent: () => boolean) => Promise<void | boolean>, fallback: string) {
    const draft = this.get(key)
    if (!draft || draft.operation || draft.readOperation || draft.action !== 'refresh') return
    this.revokeRead(key, draft)
    const readLease = { active: true }
    this.currentReadLeases.set(key, readLease)
    this.publish(key, this.inheritSavedAuthority(draft, { ...draft, readOperation: Symbol(), readLease, message: '' }))
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
      const authority = this.savedAuthority(current)
      if (authority?.confirmed) {
        this.publish(key)
        return
      }
      const waitingForCommit = confirmed && authority?.commitRequired
      if (waitingForCommit) message = started.message
      const seen = confirmed && !waitingForCommit ? started : current
      this.publish(key, this.inheritSavedAuthority(current, { ...current, readOperation: null,
        observedValue: seen.observedValue, revision: seen.revision, message,
        action: confirmed && !waitingForCommit ? null : 'refresh' as const }))
    })()
    this.readFlights.set(key, task)
    void task.then(() => { if (this.readFlights.get(key) === task) this.readFlights.delete(key) })
    return task
  }
  prune(sourceId: string, recordIds: Set<string>, fieldIds: Set<string>) {
    for (const key of new Set([...this.entries.keys(), ...this.currentReadLeases.keys()])) {
      const [source, record, field] = JSON.parse(key) as string[]
      if (source === sourceId && (!recordIds.has(record) || !fieldIds.has(field))) {
        this.revokeRead(key, this.get(key))
        this.publish(key)
      }
    }
  }
}

function canonicalText(value: DocumentDatabaseFieldValue): string | null {
  return formatTextDraft(value).trim() || null
}
