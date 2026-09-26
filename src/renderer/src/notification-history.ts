import type { AppNotification, AppNotificationStore } from './app-notifications'

const STORAGE_KEY = 'knowbook.notification-history.v1'
type HistoryRecord = Pick<AppNotification, 'title' | 'message' | 'level' | 'createdAt' | 'updatedAt' | 'read'>
const hydrated = new WeakSet<AppNotificationStore>()

export function connectNotificationHistory(store: AppNotificationStore, storage: Pick<Storage, 'getItem' | 'setItem'>): () => void {
  try {
    if (!hydrated.has(store)) {
      hydrated.add(store)
      const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]')
      const records: HistoryRecord[] = []
      if (Array.isArray(value)) for (const item of value.slice(-100)) {
        if (!item || typeof item.title !== 'string' || !['info', 'success', 'warning', 'error'].includes(item.level)
          || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt)
          || Math.abs(item.createdAt) > 8.64e15 || Math.abs(item.updatedAt) > 8.64e15) continue
        records.push({ title: item.title.slice(0, 500), message: typeof item.message === 'string' ? item.message.slice(0, 8000) : undefined,
          level: item.level, createdAt: item.createdAt, updatedAt: item.updatedAt, read: item.read === true })
      }
      store.restoreHistory(records)
    }
  } catch { /* A corrupt or unavailable cache must not prevent opening the app. */ }
  const save = () => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(store.getHistorySnapshot().filter((item) => item.level !== 'progress')
        .map(({ title, message, level, createdAt, updatedAt, read }) => ({
          title: title.slice(0, 500), message: message?.slice(0, 8000), level: level ?? 'info', createdAt, updatedAt, read
        }))))
    } catch { /* Notifications remain available in memory if storage is full. */ }
  }
  save()
  return store.subscribe(save)
}
