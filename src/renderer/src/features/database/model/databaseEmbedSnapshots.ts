import type { DatabaseEmbedSnapshot } from '@shared/contracts'

export type EmbedSnapshotState = { status: 'pending' | 'ready' | 'error'; snapshot?: DatabaseEmbedSnapshot; error?: string; revision: number }
type Entry = { state: EmbedSnapshotState; epoch: number; publishedEpoch: number; listeners: Set<() => void>;
  request?: { epoch: number; promise: Promise<DatabaseEmbedSnapshot> } }
const entries = new Map<string, Entry>()
let unsubscribe: (() => void) | undefined
function entry(id: string): Entry {
  let item = entries.get(id)
  if (!item) { item = { state: { status: 'pending', revision: 0 }, epoch: 0, publishedEpoch: -1, listeners: new Set() }; entries.set(id, item) }
  return item
}
function publish(item: Entry, next: Omit<EmbedSnapshotState, 'revision'>) {
  item.publishedEpoch = item.epoch
  item.state = { ...next, revision: item.state.revision + 1 }
  for (const listener of item.listeners) listener()
}
export const databaseEmbedSnapshots = {
  state: (id: string) => entry(id).state,
  subscribe(id: string, listener: () => void) {
    const item = entry(id); item.listeners.add(listener)
    if (!unsubscribe && typeof window.knowbook.onWorkspaceMutated === 'function') unsubscribe = window.knowbook.onWorkspaceMutated(() => {
      for (const [sourceId, source] of entries) {
        source.epoch++
        if (source.listeners.size) void databaseEmbedSnapshots.refresh(sourceId).catch(() => {})
      }
    })
    if ((item.state.status === 'pending' || item.publishedEpoch !== item.epoch) && !item.request) void databaseEmbedSnapshots.refresh(id).catch(() => {})
    return () => {
      item.listeners.delete(listener)
      if (![...entries.values()].some(source => source.listeners.size)) { unsubscribe?.(); unsubscribe = undefined; entries.clear() }
    }
  },
  async refresh(id: string): Promise<DatabaseEmbedSnapshot> {
    const item = entry(id), epoch = item.epoch
    if (item.request) {
      const pending = item.request
      try { const result = await pending.promise; if (pending.epoch === item.epoch) return result }
      catch (error) { if (pending.epoch === item.epoch) throw error }
      return databaseEmbedSnapshots.refresh(id)
    }
    const promise = window.knowbook.getDatabaseEmbedSnapshot(id)
    const request = { epoch, promise }; item.request = request
    let result!: DatabaseEmbedSnapshot
    try {
      const snapshot = await promise
      result = snapshot
      if (item.epoch === epoch) publish(item, { status: 'ready', snapshot })
    } catch (error) {
      if (item.epoch === epoch) publish(item, { status: 'error', snapshot: item.state.snapshot,
        error: error instanceof Error ? error.message : 'Database refresh failed.' })
      throw error
    } finally { if (item.request === request) item.request = undefined }
    return item.epoch === epoch ? result : databaseEmbedSnapshots.refresh(id)
  },
  invalidate(id: string) { entry(id).epoch++; return databaseEmbedSnapshots.refresh(id) }
}
