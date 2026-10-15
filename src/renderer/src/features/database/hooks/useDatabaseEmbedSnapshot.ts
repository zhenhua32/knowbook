import { useCallback, useSyncExternalStore } from 'react'
import { databaseEmbedSnapshots } from '../model/databaseEmbedSnapshots'

export function useDatabaseEmbedSnapshot(databaseId: string) {
  const subscribe = useCallback((listener: () => void) => databaseEmbedSnapshots.subscribe(databaseId, listener), [databaseId])
  const read = useCallback(() => databaseEmbedSnapshots.state(databaseId), [databaseId])
  return useSyncExternalStore(subscribe, read, read)
}
