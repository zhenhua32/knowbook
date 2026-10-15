import { Suspense, useEffect, useRef, useState } from 'react'
import { lazyWithRetry as lazy } from '../utils/lazyWithRetry'
import type { DocumentsDomainState } from '../types/appDomains'
import type { UiText } from '../i18n'
import type { DatabaseEmbedContextValue, DatabaseViewPickerRequest } from '../features/database/DatabaseEmbedContext'
import { planDatabaseViewInsertion } from '../utils/databaseViewInsertion'

const Picker = lazy(() => import('../components/DocumentDatabaseViewPicker'))
type Opening = { request: DatabaseViewPickerRequest; owner: object; opener: HTMLElement | null }
export function useDocumentDatabaseViewInsertion(documents: DocumentsDomainState, ui: UiText, isZh: boolean) {
  const live = useRef(documents); live.current = documents
  const target = documents.getRenameTarget(), key = `${target?.documentId ?? ''}:${target?.session ?? ''}`
  const scope = useRef({ key, session: {}, registry: new Map<string, unknown>() })
  if (scope.current.key !== key) scope.current = { key, session: {}, registry: new Map() }
  const owner = scope.current
  const [opening, setOpening] = useState<Opening | null>(null)
  const openingRef = useRef(opening); openingRef.current = opening
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => () => {
    const previous = openingRef.current
    if (previous?.owner === owner) { openingRef.current = null; previous.request.onCancel?.() }
  }, [owner])
  const current = () => mounted.current && scope.current === owner && live.current.selectedDocumentId === target?.documentId
  const openPicker = (request: DatabaseViewPickerRequest) => {
    if (current() && request.isCurrent()) setOpening({ request, owner, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null })
  }
  const context: DatabaseEmbedContextValue = {
    documentId: target?.documentId ?? '', session: owner.session, registry: owner.registry,
    locale: ui.locale, isZh, onMessage: (message, kind) => live.current.notifyBlockAction(message, kind),
    onOpenDocument: (id, shouldContinue) => {
      const allowed = () => current() && shouldContinue?.() !== false
      if (allowed()) void live.current.openDocumentInDocumentsPage(id, allowed)
    }, onEnterEditing: () => { if (current()) live.current.setIsReadingMode(false) },
    openPicker,
    commitContent: (id, expected, nextContent) => {
      const state = live.current, before = state.getDraftBlocks(), index = before.findIndex(block => block.id === id)
      if (!current() || state.isReadingMode || state.isBlockMoveBusy || index < 0
        || before[index].type !== 'database-view' || before[index].content !== expected) return false
      if (expected === nextContent) return true
      const next = before.map((block, at) => at === index ? { ...block, content: nextContent } : block)
      state.pushToHistory(before); state.setDraftBlocks(next); state.pushToHistory(next)
      return true
    }
  }
  const insert = (anchorId?: string, fromSlash = false) => {
    const state = live.current, before = state.getDraftBlocks()
    const id = anchorId ?? before[state.activeBlockIndex ?? before.length - 1]?.id
    const action = id ? state.getBlockActionTarget([id]) : null
    if (id && !action || !current() || state.isReadingMode) return
    const accepts = () => current() && (action ? live.current.isBlockActionTargetCurrent(action) : live.current.getDraftBlocks().length === 0)
    const slash = fromSlash && state.activeSlashContext ? { start: state.activeSlashContext.start, cursor: state.activeCursorPosition } : undefined
    let insertedId: string | undefined
    openPicker({ isCurrent: accepts,
      onSelect: payload => {
        if (!accepts()) return false
        const initial = action?.blocks ?? before
        const planned = planDatabaseViewInsertion(initial, id, payload, slash)
        if (!planned) return false
        const latest = live.current
        latest.pushToHistory(initial, action?.bookmark); latest.clearBlockSelection(); latest.setDraftBlocks(planned.blocks)
        latest.pushToHistory(planned.blocks, action?.bookmark); insertedId = planned.id
        return true
      }, onComplete: () => {
        if (!current() || !insertedId || !document.hasFocus() || document.activeElement !== document.body) return
        document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(insertedId)}"] [data-editor-island="database-view"] button`)?.focus({ preventScroll: true })
      } })
  }
  const visible = opening?.owner === owner ? opening : null
  const picker = visible ? <Suspense fallback={null}><Picker isZh={isZh} onCancel={() => {
    openingRef.current = null; setOpening(null); visible.request.onCancel?.()
    if (!visible.request.onCancel && current() && document.hasFocus() && visible.opener?.isConnected) {
      requestAnimationFrame(() => { if (current() && document.activeElement === document.body) visible.opener?.focus({ preventScroll: true }) })
    }
  }} onSelect={payload => {
    if (!current() || !visible.request.isCurrent() || !visible.request.onSelect(payload)) return false
    openingRef.current = null; setOpening(null)
    requestAnimationFrame(() => { if (mounted.current && scope.current === owner) visible.request.onComplete?.() })
    return true
  }} /></Suspense> : null
  return { context, picker, insert }
}
