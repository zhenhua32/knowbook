import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import type { DocumentsDomainState } from '../types/appDomains'
import type { AppShellState } from '../types/appShell'
import { DOCUMENT_CAPTURE_EVENTS } from '../documentCapture'

export type DocumentCaptureState =
  | { kind: 'templates'; parentId: string | null }
  | { kind: 'quick' }
  | { kind: 'saveTemplate'; source: { title: string; summary: string; blocks: DocumentBlockDraft[] } }

export function useDocumentCapture(documents: DocumentsDomainState, shell: AppShellState) {
  const [capture, setCapture] = useState<DocumentCaptureState | null>(null)
  const current = useRef({ documents, shell, capture })
  current.current = { documents, shell, capture }
  const closeCapture = useCallback(() => setCapture(null), [])

  useEffect(() => {
    const open = (event: Event) => {
      const { documents: docs, shell: app, capture: active } = current.current
      if (!app.workspaceReady || active || document.querySelector('dialog[open]')) return
      if (event.type === DOCUMENT_CAPTURE_EVENTS.quick) {
        setCapture({ kind: 'quick' })
      } else if (event.type === DOCUMENT_CAPTURE_EVENTS.templates) {
        const parentId = (event as CustomEvent<{ parentId?: string | null }>).detail?.parentId
        setCapture({ kind: 'templates', parentId: typeof parentId === 'string' ? parentId : null })
      } else if (docs.selectedDocument?.id === docs.selectedDocumentId && !docs.detailLoading && !docs.documentLoadError) {
        // Capture the editor's draft, including changes not yet acknowledged by SQLite.
        setCapture({ kind: 'saveTemplate', source: structuredClone({
          title: docs.draftTitle,
          summary: docs.draftSummary,
          blocks: docs.draftBlocks
        }) })
      }
    }
    const events = Object.values(DOCUMENT_CAPTURE_EVENTS)
    events.forEach((event) => window.addEventListener(event, open))
    return () => events.forEach((event) => window.removeEventListener(event, open))
  }, [])

  return { capture, closeCapture }
}
