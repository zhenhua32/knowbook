import type { AppNotificationHandle, AppNotificationInput } from '@shared/app-notification'

export interface AppNotification extends AppNotificationInput {
  id: number
  createdAt: number
  updatedAt: number
  read: boolean
}

export class AppNotificationStore {
  private nextId = 0
  private snapshot: readonly AppNotification[] = []
  private history: readonly AppNotification[] = []
  private readonly live = new Set<number>()
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): readonly AppNotification[] => this.snapshot
  getHistorySnapshot = (): readonly AppNotification[] => this.history

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  show(input: AppNotificationInput): AppNotificationHandle {
    const id = ++this.nextId
    const item = { ...input, id, createdAt: Date.now(), updatedAt: Date.now(), read: false }
    this.live.add(id)
    this.history = [...this.history, item]
    this.snapshot = [...this.snapshot, item].slice(-3)
    this.publish()
    return {
      update: (next) => {
        if (!this.live.has(id)) return
        const current = this.history.find((item) => item.id === id)!
        const updated = { ...next, id, createdAt: current.createdAt, updatedAt: Date.now(), read: false }
        this.history = [...this.history.filter((item) => item.id !== id), updated]
        this.snapshot = this.snapshot.map((item) => item.id === id ? updated : item)
        this.publish()
      },
      dismiss: () => this.dismiss(id)
    }
  }

  dismiss = (id: number): void => {
    if (!this.live.delete(id)) return
    this.snapshot = this.snapshot.filter((item) => item.id !== id)
    // A disposed plugin must not leave callable actions or an orphaned running task.
    this.history = this.history.filter((item) => item.id !== id || item.level !== 'progress')
      .map((item) => item.id === id ? { ...item, actions: undefined } : item)
    this.publish()
  }

  /** Hide a toast without cancelling the task or losing its eventual result. */
  hide = (id: number): void => {
    if (!this.snapshot.some((item) => item.id === id)) return
    this.snapshot = this.snapshot.filter((item) => item.id !== id)
    this.publish()
  }

  markAllRead = (): void => {
    if (this.history.every((item) => item.read) && this.snapshot.length === 0) return
    this.snapshot = []
    this.history = this.history.map((item) => ({ ...item, read: true }))
    this.publish()
  }

  clearCompleted = (): void => {
    this.history = this.history.filter((item) => item.level === 'progress')
    this.publish()
  }

  restoreHistory(items: readonly (AppNotificationInput & { createdAt: number; updatedAt: number; read: boolean })[]): void {
    // Restored records have no executable actions and never produce fresh toasts.
    this.history = [...items.map((item) => ({ ...item, id: ++this.nextId, actions: undefined })), ...this.history]
    this.publish()
  }

  private publish(): void {
    // Bound completed history while retaining running tasks.
    const completed = this.history.filter((item) => item.level !== 'progress').slice(-100)
    const ids = new Set([...completed, ...this.history.filter((item) => item.level === 'progress')].map((item) => item.id))
    this.history = this.history.filter((item) => ids.has(item.id))
    this.snapshot = this.snapshot.filter((item) => ids.has(item.id))
    for (const id of this.live) if (!ids.has(id)) this.live.delete(id)
    for (const listener of this.listeners) listener()
  }
}

export const appNotifications = new AppNotificationStore()
