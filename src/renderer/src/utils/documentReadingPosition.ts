export const READING_POSITIONS_KEY = 'knowbook.documents.readingPositions.v1'
const MAX_POSITIONS = 100

export type DocumentReadingPosition = {
  blockId: string | null
  offset: number
  scrollTop: number
  updatedAt: number
}

type PositionStorage = Pick<Storage, 'getItem' | 'setItem'>

function readPositions(storage: PositionStorage): Array<[string, DocumentReadingPosition]> {
  const parsed: unknown = JSON.parse(storage.getItem(READING_POSITIONS_KEY) ?? '[]')
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is [string, DocumentReadingPosition] => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return false
    const position = entry[1]
    return position && (position.blockId === null || typeof position.blockId === 'string')
      && Number.isFinite(position.offset) && Number.isFinite(position.scrollTop) && position.scrollTop >= 0
      && Number.isFinite(position.updatedAt)
  }).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_POSITIONS)
}

export function readDocumentPosition(documentId: string, storage?: PositionStorage): DocumentReadingPosition | null {
  try {
    return readPositions(storage ?? window.localStorage).find(([id]) => id === documentId)?.[1] ?? null
  } catch {
    return null
  }
}

export function saveDocumentPosition(documentId: string, position: DocumentReadingPosition, storage?: PositionStorage): void {
  try {
    const target = storage ?? window.localStorage
    let previous: Array<[string, DocumentReadingPosition]> = []
    try { previous = readPositions(target) } catch { /* Replace damaged preferences. */ }
    target.setItem(READING_POSITIONS_KEY, JSON.stringify([
      [documentId, position], ...previous.filter(([id]) => id !== documentId)
    ].slice(0, MAX_POSITIONS)))
  } catch {
    // Storage may be unavailable or full; reading must remain usable.
  }
}
