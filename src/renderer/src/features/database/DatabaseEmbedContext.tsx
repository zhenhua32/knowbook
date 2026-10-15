import { createContext, useContext } from 'react'
import type { DatabaseViewBlockPayloadV1 } from '@shared/databaseViewBlock'
import type { AppMessageHandler } from '../../notify'

export type DatabaseViewPickerRequest = {
  isCurrent: () => boolean
  onSelect: (payload: DatabaseViewBlockPayloadV1) => boolean
  onCancel?: () => void
  onComplete?: () => void
}
export type DatabaseEmbedContextValue = {
  documentId: string
  session: object
  locale: string
  isZh: boolean
  registry: Map<string, unknown>
  onMessage: AppMessageHandler
  onOpenDocument: (id: string, shouldContinue?: () => boolean) => void
  onEnterEditing: () => void
  commitContent: (blockId: string, expectedContent: string, nextContent: string) => boolean
  openPicker: (request: DatabaseViewPickerRequest) => void
}
const DatabaseEmbedContext = createContext<DatabaseEmbedContextValue | null>(null)
export const DatabaseEmbedProvider = DatabaseEmbedContext.Provider
export const useDatabaseEmbedContext = () => useContext(DatabaseEmbedContext)
