import type { DocumentDatabaseFieldValue } from '@shared/contracts'
import type { DatabaseValueCommitResult } from './databaseTextDrafts'

type ReadLease = { active: boolean }
type SavedAuthority = { confirmed: boolean; commitRequired?: boolean }

export type DatabaseMultiSelectCell = {
  choices: string[]
  confirmed: string[]
  observedValue: DocumentDatabaseFieldValue
  revision?: string
  schema: string
  valid: boolean
  status: 'saving' | 'saved' | 'failed'
  operation: symbol | null
  readOperation: symbol | null
  readLease: ReadLease | null
  authority: SavedAuthority | null
  message: 'save' | 'refresh' | ''
  action: 'refresh' | null
}

export function multiSelectChoices(value: DocumentDatabaseFieldValue): string[] {
  return Array.isArray(value) ? [...new Set(value)] : []
}

export function multiSelectSchema(options: string[]): string { return JSON.stringify(options) }
const equalChoices = (left: string[], right: string[]) => left.length === right.length && left.every((value, index) => value === right[index])

/** Array values and physical requests survive virtual rows and temporary page unmounts. */
export class DatabaseMultiSelectCellCache {
  private entries = new Map<string, DatabaseMultiSelectCell>()
  private listeners = new Map<string, Set<() => void>>()
  private writes = new Map<string, { token: symbol; orphan: DatabaseMultiSelectCell }>()
  private readFlights = new Map<string, Promise<void>>()
  private readLeases = new Map<string, ReadLease>()

  get(key: string) { return this.entries.get(key) ?? this.writes.get(key)?.orphan }
  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key) }
  }
  private publish(key: string, cell?: DatabaseMultiSelectCell) {
    if (cell) this.entries.set(key, cell)
    else this.entries.delete(key)
    this.listeners.get(key)?.forEach(listener => listener())
  }
  private revokeRead(key: string) {
    const lease = this.readLeases.get(key)
    if (lease) lease.active = false
    this.readLeases.delete(key)
  }
  private invalidate(key: string) {
    this.revokeRead(key)
    this.publish(key)
  }

  sync(key: string, value: DocumentDatabaseFieldValue, revision: string | undefined, schema: string) {
    const cell = this.entries.get(key)
    if (!cell) return
    if (cell.schema !== schema) { this.invalidate(key); return }
    const stored = multiSelectChoices(value)
    const valueChanged = !equalChoices(stored, multiSelectChoices(cell.observedValue))
    const changed = valueChanged || revision !== cell.revision
    if (cell.operation) {
      if (changed) this.publish(key, { ...cell, observedValue: value, revision,
        ...(valueChanged ? { confirmed: stored } : {}) })
      return
    }
    // In-flight reads retain their ACK overlay until actual Page publication.
    if (cell.readOperation) return
    if (cell.action === 'refresh') {
      if (changed) this.publish(key, { ...cell, observedValue: value, revision,
        ...(valueChanged ? { choices: stored, confirmed: stored } : {}) })
      // New stored choices do not acknowledge a failed full-workspace read.
      return
    }
    if (cell.status === 'saved' && (equalChoices(stored, cell.choices) || changed)) this.publish(key)
    else if (cell.status === 'failed' && changed) this.publish(key, { ...cell, choices: stored, confirmed: stored, observedValue: value, revision })
  }

  commit(key: string, choices: string[], value: DocumentDatabaseFieldValue, revision: string | undefined, schema: string,
    change: (value: DocumentDatabaseFieldValue) => void | Promise<void | DatabaseValueCommitResult>) {
    if (this.writes.has(key)) return
    const previous = this.entries.get(key)
    const confirmed = previous?.valid && previous.schema === schema ? previous.confirmed : multiSelectChoices(value)
    const next = [...new Set(choices)]
    if (equalChoices(next, confirmed)) return
    this.revokeRead(key)
    const operation = Symbol('multi-select-write')
    const pending: DatabaseMultiSelectCell = { choices: next, confirmed, observedValue: value, revision, schema,
      valid: true, status: 'saving', operation, readOperation: null, readLease: null,
      authority: null, message: '', action: null }
    // Pruning can revoke a UI owner, but cannot make its accepted write disappear.
    this.writes.set(key, { token: operation, orphan: { ...pending, valid: false } })
    this.publish(key, pending)
    const settle = (result: void | DatabaseValueCommitResult) => {
      if (this.writes.get(key)?.token !== operation) return
      this.writes.delete(key)
      const current = this.entries.get(key)
      if (!current || current.operation !== operation) { this.listeners.get(key)?.forEach(listener => listener()); return }
      if (result?.status === 'failed') {
        this.publish(key, { ...current, choices: current.confirmed, operation: null, status: 'failed', message: 'save' })
        return
      }
      const saved = result?.status === 'saved' ? multiSelectChoices(result.value) : next
      const refresh = result?.status === 'saved' ? result.refresh : undefined
      const readLease = refresh ? { active: true } : null
      const acknowledged: DatabaseMultiSelectCell = { ...current, choices: saved, confirmed: saved,
        operation: null, status: 'saved', readOperation: refresh ? Symbol('multi-select-read') : null,
        readLease, authority: { confirmed: false },
        message: result?.status === 'saved' && result.refreshError ? 'refresh' : '',
        action: refresh || result?.status === 'saved' && result.refreshError ? 'refresh' : null }
      if (readLease) this.readLeases.set(key, readLease)
      this.publish(key, acknowledged)
      if (refresh && readLease) void this.read(key, readLease, refresh, acknowledged)
    }
    try {
      const result = change(next.length ? next : null)
      if (result && typeof result.then === 'function') void result.then(settle, () => settle({ status: 'failed', message: '' }))
      else settle(undefined)
    } catch { settle({ status: 'failed', message: '' }) }
  }

  async refresh(key: string, read: (isCurrent: () => boolean) => Promise<void | boolean>) {
    const cell = this.entries.get(key)
    if (!cell || this.writes.has(key) || cell.readOperation || cell.action !== 'refresh') return
    this.revokeRead(key)
    const lease = { active: true }
    this.readLeases.set(key, lease)
    const started = { ...cell, readLease: lease, readOperation: Symbol('multi-select-read'), message: '' as const }
    this.publish(key, started)
    await this.read(key, lease, read, cell)
  }
  private read(key: string, lease: ReadLease, read: (isCurrent: () => boolean) => Promise<void | boolean>, started: DatabaseMultiSelectCell) {
    const previous = this.readFlights.get(key)
    const isCurrent = () => lease.active
    const task = (async () => {
      if (previous) await previous
      if (!isCurrent()) return
      let accepted = false, message = started.message
      try { accepted = await read(isCurrent) !== false; if (accepted) message = '' }
      catch { message = 'refresh' }
      const current = this.entries.get(key)
      if (!lease.active || current?.readLease !== lease) return
      if (current.authority?.confirmed) { this.publish(key); return }
      const waiting = accepted && current.authority?.commitRequired
      this.publish(key, { ...current, readOperation: null,
        message: waiting ? started.message : message, action: accepted && !waiting ? null : 'refresh' })
    })()
    this.readFlights.set(key, task)
    void task.then(() => { if (this.readFlights.get(key) === task) this.readFlights.delete(key) })
    return task
  }

  captureSavedRefresh(sourceId: string): ReadonlyMap<string, DatabaseMultiSelectCell> {
    const snapshot = new Map<string, DatabaseMultiSelectCell>()
    for (const [key, cell] of this.entries) if (cell.status === 'saved' && cell.action === 'refresh' && !cell.operation
      && (JSON.parse(key) as string[])[0] === sourceId) {
      if (cell.readOperation && cell.authority) cell.authority.commitRequired = true
      snapshot.set(key, cell)
    }
    return snapshot
  }
  confirmSavedRefresh(snapshot: ReadonlyMap<string, DatabaseMultiSelectCell>) {
    for (const [key, captured] of snapshot) {
      if (!captured.authority) continue
      captured.authority.confirmed = true
      const current = this.entries.get(key)
      if (current?.authority === captured.authority && current.status === 'saved' && !current.operation) {
        // Retire UI progress without revoking the same GET's delayed metadata updates.
        this.publish(key)
      }
    }
  }
  prune(sourceId: string, recordIds: Set<string>, schemas: Map<string, string>) {
    for (const key of new Set([...this.entries.keys(), ...this.writes.keys(), ...this.readLeases.keys()])) {
      const [source, record, field] = JSON.parse(key) as string[]
      const cell = this.get(key)
      if (source === sourceId && (!recordIds.has(record) || !schemas.has(field) || cell && cell.schema !== schemas.get(field))) this.invalidate(key)
    }
  }
}
