import { createContext, useCallback, useEffect, useId, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import type { MarkdownDocumentModel } from '@shared/markdownDocument'
import { footnoteReferenceKey } from '@shared/markdownDocument'
import type { MarkdownNode } from '@shared/markdownEngine'

export const MarkdownBlockNodesContext = createContext<MarkdownNode[] | undefined>(undefined)
export const MarkdownDocumentContext = createContext<{
  model?: MarkdownDocumentModel
  isZh: boolean
  footnoteId: (id: number, subId?: number) => string
  navigateFootnote: (id: number, subId?: number) => void
}>({ isZh: false, footnoteId: (id, subId) => `fn-${id}${subId === undefined ? '' : `-ref-${subId}`}`, navigateFootnote: () => {} })

export function MarkdownDocumentProvider({ model, documentId, isZh, containerRef, onRevealBlock, children }: {
  model?: MarkdownDocumentModel
  documentId: string
  isZh: boolean
  containerRef: RefObject<HTMLElement | null>
  onRevealBlock: (id: string) => void
  children: ReactNode
}) {
  const scope = useId()
  const frame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(frame.current), [documentId])
  const footnoteId = useCallback((id: number, subId?: number) => `${scope}-${documentId}-fn-${id}${subId === undefined ? '' : `-ref-${subId}`}`, [scope, documentId])
  const navigateFootnote = useCallback((id: number, subId?: number) => {
    cancelAnimationFrame(frame.current)
    if (subId !== undefined) {
      const index = model?.footnoteOrigins.get(footnoteReferenceKey(id, subId))
      const blockId = index === undefined ? undefined : model?.blockIds[index]
      if (blockId) onRevealBlock(blockId)
    }
    let attempts = 0
    const focus = () => {
      const target = document.getElementById(footnoteId(id, subId))
      if (target && containerRef.current?.contains(target)) {
        for (let parent = target.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement) parent.open = true
        }
        target.scrollIntoView({ block: 'center' })
        target.focus({ preventScroll: true })
      } else if (++attempts < 60) frame.current = requestAnimationFrame(focus)
    }
    frame.current = requestAnimationFrame(focus)
  }, [model, onRevealBlock, footnoteId, containerRef])
  const value = useMemo(() => ({ model, isZh, footnoteId, navigateFootnote }), [model, isZh, footnoteId, navigateFootnote])
  return <MarkdownDocumentContext.Provider value={value}>{children}</MarkdownDocumentContext.Provider>
}
