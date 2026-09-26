import type { AppNotificationHandle, AppNotificationInput } from '@shared/app-notification'

export interface AppNotification extends AppNotificationInput {
  id: number
}

export class AppNotificationStore {
  private nextId = 0
  private snapshot: readonly AppNotification[] = []
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): readonly AppNotification[] => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  show(input: AppNotificationInput): AppNotificationHandle {
    const id = ++this.nextId
    this.publish([...this.snapshot, { ...input, id }])
    return {
      update: (next) => {
        if (!this.snapshot.some((item) => item.id === id)) return
        this.publish(this.snapshot.map((item) => item.id === id ? { ...next, id } : item))
      },
      dismiss: () => this.dismiss(id)
    }
  }

  dismiss = (id: number): void => {
    const next = this.snapshot.filter((item) => item.id !== id)
    if (next.length !== this.snapshot.length) this.publish(next)
  }

  private publish(next: AppNotification[]): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

export const appNotifications = new AppNotificationStore()
