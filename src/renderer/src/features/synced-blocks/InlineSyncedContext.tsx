import { createContext, useContext, type ReactNode } from 'react'
import type { UiText } from '../../i18n'
import type { SyncedHostSourceCurrent } from './SyncedHostSourceDialog'
import type { CanonicalInlineRuntime } from './inlineRuntime'

export interface InlineHostView {
  documentId: string
  hostSession: object
  getCurrent: () => SyncedHostSourceCurrent | null
  runtime: CanonicalInlineRuntime
  ui: UiText
  isZh: boolean
  onOpenDocument: (id: string) => unknown
  onOpenBlock: (documentId: string, blockId: string) => unknown
  onOpenAnchor: (documentId: string, slug: string) => unknown
}
const InlineContext = createContext<InlineHostView | null>(null)
export function InlineSyncedProvider({ value, children }: { value: InlineHostView | null; children: ReactNode }) {
  return <InlineContext.Provider value={value}>{children}</InlineContext.Provider>
}
export const useInlineHostView = () => useContext(InlineContext)
