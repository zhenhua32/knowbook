const writes = new Map<string, Promise<void>>()

/** Drafts belong to each editor; physical writes to the same source cell are ordered. */
export async function coordinateDatabaseCellWrite(sourceId: string, recordId: string, fieldId: string, write: () => Promise<void>): Promise<void> {
  return coordinateDatabaseCellWrites(sourceId, [{ recordId, fieldId }], write)
}

/** Reserve the complete set synchronously, then perform its original atomic IPC.
 * No task holds one reservation while trying to acquire another. */
export async function coordinateDatabaseCellWrites(sourceId: string, cells: Array<{ recordId: string; fieldId: string }>, write: () => Promise<void>): Promise<void> {
  const keys = [...new Set(cells.map(cell => JSON.stringify([sourceId, cell.recordId, cell.fieldId])))].sort()
  const previous = [...new Set(keys.map(key => writes.get(key)).filter((request): request is Promise<void> => Boolean(request)))]
  const request = Promise.all(previous.map(request => request.catch(() => {}))).then(write)
  for (const key of keys) writes.set(key, request)
  try { await request } finally { for (const key of keys) if (writes.get(key) === request) writes.delete(key) }
}
