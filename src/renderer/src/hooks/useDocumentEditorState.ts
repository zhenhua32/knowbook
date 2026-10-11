import type { AppMessageHandler } from '../notify'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft, DocumentDetail, HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'
import { toDraftBlock } from '../utils/draftBlockShape'
import { buildDraftMarkdownExport } from '../utils/documentMarkdown'
import { normalizeDraftBlocks, validateBlockTreeStructure } from '../utils/draftTreeNormalization'
import { getErrorMessage } from '../utils/errorMessage'
import { applyIncrementalDocumentUpdate } from '../utils/homeDataDocumentUpdate'
import { captureEditorHistoryBookmark, restoreEditorHistoryBookmark, type EditorHistoryBookmark } from '../utils/editorHistoryFocus'
import {
  areDocumentDraftBlocksEqual,
  normalizeComparableDocumentTitle
} from '../utils/documentDraftComparison'

type DraftBlockUpdater = DocumentBlockDraft[] | ((previous: DocumentBlockDraft[]) => DocumentBlockDraft[])
type EditSnapshot = { blocks: DocumentBlockDraft[]; bookmark: EditorHistoryBookmark | null }

export type DocumentRenameTarget = Readonly<{ documentId: string; session: number; title: string }>
export type RenameTitleResult =
  | { status: 'saved'; title: string }
  | { status: 'failed'; message: string }
  | { status: 'stale' }
  | { status: 'busy' }
type TitleIntent = { target: DocumentRenameTarget; title: string; onFailure: (message: string) => void }

function cloneDraftBlocks(blocks: DocumentBlockDraft[]): DocumentBlockDraft[] {
  return blocks.map((block) => ({
    ...block,
    tags: block.tags ? [...block.tags] : undefined
  }))
}

function areDraftBlockSnapshotsEqual(left: DocumentBlockDraft[] | undefined, right: DocumentBlockDraft[]): boolean {
  // Hydration after saving can reorder fields or normalize absent values.
  // Those acknowledgements must not count as edits that truncate redo.
  return left !== undefined && areDocumentDraftBlocksEqual(left, right)
}

type UseDocumentEditorStateParams = {
  selectedDocumentId: string | null
  selectedDocument: DocumentDetail | null
  isReadingMode?: boolean
  ui: UiText
  onHomeDataChange: Dispatch<SetStateAction<HomeData>>
  onSelectedDocumentChange: (detail: DocumentDetail | null) => void
  onRevealHistoryBlock?: (id: string) => void
  onMessage: AppMessageHandler
}

export function useDocumentEditorState({
  selectedDocumentId,
  selectedDocument,
  isReadingMode = false,
  ui,
  onHomeDataChange,
  onSelectedDocumentChange,
  onRevealHistoryBlock,
  onMessage
}: UseDocumentEditorStateParams) {
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isComposingDraft, setIsComposingDraft] = useState(false)
  const [failedSave, setFailedSave] = useState<{
    documentId: string; title: string; summary: string; blocks: DocumentBlockDraft[]
  } | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSummary, setDraftSummary] = useState('')
  const [draftBlocksState, setDraftBlocksState] = useState<DocumentBlockDraft[]>([])
  const [mdCopyFlash, setMdCopyFlash] = useState(false)
  const editHistoryRef = useRef<EditSnapshot[]>([])
  const lastEditorBookmarkRef = useRef<EditorHistoryBookmark | null>(null)
  const pendingHistoryFocusRef = useRef<EditorHistoryBookmark | null>(null)
  const editHistoryPointerRef = useRef<number>(-1)
  // Reading mode can undo its task changes, but must not replay earlier source edits.
  const readingHistoryScopeRef = useRef<{ floor: number; ceiling: number } | null>(null)
  const isReadingModeRef = useRef(isReadingMode)
  const isRestoringHistoryRef = useRef<boolean>(false)
  const historyDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingHistorySnapshotRef = useRef<DocumentBlockDraft[] | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedDocumentIdRef = useRef(selectedDocumentId)
  const selectedDocumentRef = useRef(selectedDocument)
  const renderedDocumentRef = useRef(selectedDocument)
  const editorSessionRef = useRef(0)
  const composingDraftRef = useRef(false)
  const pendingSaveRef = useRef<{ documentId: string; session: number; promise: Promise<boolean> } | null>(null)
  const pendingRenameRef = useRef<{ target: DocumentRenameTarget; title: string; promise: Promise<RenameTitleResult> } | null>(null)
  const mountedRef = useRef(true)
  const draftTitleRef = useRef(draftTitle)
  const draftSummaryRef = useRef(draftSummary)
  const draftBlocksRef = useRef(draftBlocksState)
  const [, setHistoryRevision] = useState(0)
  selectedDocumentIdRef.current = selectedDocumentId
  // A successful write advances the revision immediately, before React renders
  // its acknowledgement. Queued saves must keep that revision in the meantime.
  if (renderedDocumentRef.current !== selectedDocument) {
    renderedDocumentRef.current = selectedDocument
    selectedDocumentRef.current = selectedDocument
  }
  composingDraftRef.current = isComposingDraft
  draftTitleRef.current = draftTitle
  draftSummaryRef.current = draftSummary
  draftBlocksRef.current = draftBlocksState
  isReadingModeRef.current = isReadingMode

  const clearAutoSaveTimer = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
  }, [])

  const clearHistoryState = useCallback(() => {
    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
      historyDebounceTimerRef.current = null
    }
    pendingHistorySnapshotRef.current = null
    lastEditorBookmarkRef.current = null
    pendingHistoryFocusRef.current = null

    clearAutoSaveTimer()

    editHistoryRef.current = []
    editHistoryPointerRef.current = -1
    readingHistoryScopeRef.current = null
    isRestoringHistoryRef.current = false
  }, [clearAutoSaveTimer])

  const initializeHistoryState = useCallback((blocks: DocumentBlockDraft[]) => {
    const snapshot = cloneDraftBlocks(blocks)
    editHistoryRef.current = [{ blocks: snapshot, bookmark: null }]
    lastEditorBookmarkRef.current = null
    pendingHistoryFocusRef.current = null
    editHistoryPointerRef.current = 0
    readingHistoryScopeRef.current = isReadingModeRef.current ? { floor: 0, ceiling: 0 } : null
    isRestoringHistoryRef.current = false
    pendingHistorySnapshotRef.current = null
  }, [])

  useEffect(() => {
    const capture = (event: Event) => {
      const bookmark = captureEditorHistoryBookmark(draftBlocksRef.current, event.type === 'selectionchange' ? document.activeElement : event.target)
      if (bookmark) lastEditorBookmarkRef.current = bookmark
    }
    document.addEventListener('focusin', capture)
    document.addEventListener('focusout', capture)
    document.addEventListener('selectionchange', capture)
    return () => {
      document.removeEventListener('focusin', capture)
      document.removeEventListener('focusout', capture)
      document.removeEventListener('selectionchange', capture)
    }
  }, [])

  useLayoutEffect(() => {
    const bookmark = pendingHistoryFocusRef.current
    if (!bookmark) return
    if (isReadingMode || restoreEditorHistoryBookmark(bookmark, draftBlocksState)) {
      pendingHistoryFocusRef.current = null
      return
    }
    const target = draftBlocksState.find(block => block.id === bookmark.blockId)
      ?? draftBlocksState[Math.min(bookmark.index, draftBlocksState.length - 1)]
    if (target?.id) onRevealHistoryBlock?.(target.id)
    const frame = requestAnimationFrame(() => {
      if (pendingHistoryFocusRef.current !== bookmark) return
      pendingHistoryFocusRef.current = null
      restoreEditorHistoryBookmark(bookmark, draftBlocksState)
    })
    return () => cancelAnimationFrame(frame)
  }, [draftBlocksState, isReadingMode, onRevealHistoryBlock])

  useEffect(() => {
    let composingTarget: EventTarget | null = null
    const start = (event: CompositionEvent) => {
      if (!(event.target instanceof HTMLElement) || !event.target.closest('.block-editor-list, .document-summary-card')) return
      composingTarget = event.target
      composingDraftRef.current = true
      clearAutoSaveTimer()
      setIsComposingDraft(true)
    }
    const end = (event: Event) => {
      if (event.target !== composingTarget) return
      composingTarget = null
      composingDraftRef.current = false
      setIsComposingDraft(false)
    }
    document.addEventListener('compositionstart', start, true)
    document.addEventListener('compositionend', end, true)
    document.addEventListener('blur', end, true)
    return () => {
      document.removeEventListener('compositionstart', start, true)
      document.removeEventListener('compositionend', end, true)
      document.removeEventListener('blur', end, true)
    }
  }, [clearAutoSaveTimer])

  const triggerTransientFlash = useCallback((setter: (value: boolean) => void) => {
    setter(true)
    setTimeout(() => setter(false), 2000)
  }, [])

  const selectedDocumentDraft = useMemo(() => {
    if (!selectedDocument) {
      return null
    }

    return {
      title: normalizeComparableDocumentTitle(selectedDocument.title),
      summary: selectedDocument.summary.trim(),
      blocks: normalizeDraftBlocks(selectedDocument.blocks.map(toDraftBlock))
    }
  }, [selectedDocument])

  const hasPendingDraftChanges = useMemo(() => Boolean(
    selectedDocumentId
      && selectedDocumentDraft
      && (
        normalizeComparableDocumentTitle(draftTitle) !== selectedDocumentDraft.title
        || draftSummary.trim() !== selectedDocumentDraft.summary
        || !areDocumentDraftBlocksEqual(draftBlocksState, selectedDocumentDraft.blocks)
      )
  ), [draftBlocksState, draftSummary, draftTitle, selectedDocumentDraft, selectedDocumentId])

  const hasSaveError = failedSave?.documentId === selectedDocumentId
    && failedSave?.title === draftTitle && failedSave?.summary === draftSummary && failedSave?.blocks === draftBlocksState
  const saveStatus: 'saved' | 'pending' | 'saving' | 'error' = isSaving
    ? 'saving' : hasPendingDraftChanges ? (hasSaveError ? 'error' : 'pending') : 'saved'

  const setDraftBlocks = useCallback((next: DraftBlockUpdater) => {
    setDraftBlocksState((previous) => {
      const resolved = typeof next === 'function' ? next(previous) : next
      return normalizeDraftBlocks(resolved)
    })
  }, [])

  const updateDraftBlock = useCallback((index: number, patch: Partial<DocumentBlockDraft>) => {
    setDraftBlocksState((previous) => {
      const currentBlock = previous[index]
      if (!currentBlock) {
        return previous
      }

      const nextBlock = { ...currentBlock, ...patch }
      const nextBlocks = previous.map((block, currentIndex) => currentIndex === index ? nextBlock : block)
      const changesTreeShape = (
        ('id' in patch && patch.id !== currentBlock.id)
        || ('type' in patch && patch.type !== currentBlock.type)
        || ('depth' in patch && patch.depth !== currentBlock.depth)
        || ('parentBlockId' in patch && patch.parentBlockId !== currentBlock.parentBlockId)
      )

      return changesTreeShape ? normalizeDraftBlocks(nextBlocks) : nextBlocks
    })
  }, [])

  const getDraftBlocks = useCallback(() => draftBlocksRef.current, [])

  const updateBlockHighlight = useCallback((index: number, highlight: string | undefined) => {
    updateDraftBlock(index, {
      highlight
    })
  }, [updateDraftBlock])

  const resetEditorFromDocument = useCallback((detail: DocumentDetail | null, editing = Boolean(detail)) => {
    const initialBlocks = normalizeDraftBlocks(detail?.blocks.map(toDraftBlock) ?? [])
    editorSessionRef.current += 1
    selectedDocumentRef.current = detail
    composingDraftRef.current = false

    setDraftTitle(detail?.title ?? '')
    setDraftSummary(detail?.summary ?? '')
    setDraftBlocksState(initialBlocks)
    setIsEditing(editing)
    setIsComposingDraft(false)
    setIsSaving(false)
    setFailedSave(null)

    if (detail && editing) {
      initializeHistoryState(initialBlocks)
    } else {
      clearHistoryState()
    }
  }, [clearHistoryState, initializeHistoryState])

  const clearEditorSession = useCallback(() => {
    resetEditorFromDocument(null, false)
  }, [resetEditorFromDocument])

  const commitHistorySnapshot = useCallback((blocks: DocumentBlockDraft[]) => {
    const snapshot = cloneDraftBlocks(blocks)
    const history = editHistoryRef.current
    const pointer = editHistoryPointerRef.current
    const bookmark = captureEditorHistoryBookmark(blocks) ?? lastEditorBookmarkRef.current
    if (areDraftBlockSnapshotsEqual(history[pointer]?.blocks, snapshot)) {
      if (bookmark) history[pointer].bookmark = bookmark
      return
    }

    const trimmed = history.slice(0, pointer + 1)
    trimmed.push({ blocks: snapshot, bookmark })
    editHistoryRef.current = trimmed.slice(-80)
    editHistoryPointerRef.current = editHistoryRef.current.length - 1
    const scope = readingHistoryScopeRef.current
    if (scope) {
      scope.floor = Math.max(0, scope.floor - Math.max(0, trimmed.length - 80))
      scope.ceiling = editHistoryPointerRef.current
    }
    setHistoryRevision((current) => current + 1)
  }, [])

  const pushToHistory = useCallback((blocks: DocumentBlockDraft[]) => {
    if (isRestoringHistoryRef.current) {
      return
    }

    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
      historyDebounceTimerRef.current = null
    }
    pendingHistorySnapshotRef.current = null
    commitHistorySnapshot(blocks)
  }, [commitHistorySnapshot])

  const scheduleHistorySnapshot = useCallback((blocks: DocumentBlockDraft[]) => {
    if (isRestoringHistoryRef.current) {
      return
    }

    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
    }

    pendingHistorySnapshotRef.current = cloneDraftBlocks(blocks)
    historyDebounceTimerRef.current = setTimeout(() => {
      historyDebounceTimerRef.current = null
      if (!mountedRef.current) return
      const pendingSnapshot = pendingHistorySnapshotRef.current
      pendingHistorySnapshotRef.current = null
      if (pendingSnapshot) {
        commitHistorySnapshot(pendingSnapshot)
      }
    }, 600)
  }, [commitHistorySnapshot])

  const checkpointDraft = useCallback(() => pushToHistory(draftBlocksRef.current), [pushToHistory])

  useEffect(() => {
    if (editHistoryPointerRef.current >= 0) checkpointDraft()
    const pointer = editHistoryPointerRef.current
    readingHistoryScopeRef.current = isReadingMode ? { floor: pointer, ceiling: pointer } : null
    setHistoryRevision((current) => current + 1)
  }, [checkpointDraft, isReadingMode])

  const undoEdit = useCallback(() => {
    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
      historyDebounceTimerRef.current = null
    }
    const pendingSnapshot = pendingHistorySnapshotRef.current
    pendingHistorySnapshotRef.current = null
    commitHistorySnapshot(pendingSnapshot ?? draftBlocksRef.current)

    const pointer = editHistoryPointerRef.current
    if (pointer <= Math.max(0, readingHistoryScopeRef.current?.floor ?? 0)) {
      return
    }

    isRestoringHistoryRef.current = true
    const nextPointer = pointer - 1
    editHistoryPointerRef.current = nextPointer
    const snapshot = editHistoryRef.current[nextPointer]
    pendingHistoryFocusRef.current = snapshot.bookmark ?? lastEditorBookmarkRef.current
    setDraftBlocks(cloneDraftBlocks(snapshot.blocks))
    setHistoryRevision((current) => current + 1)
    setTimeout(() => {
      isRestoringHistoryRef.current = false
    }, 0)
  }, [commitHistorySnapshot, setDraftBlocks])

  const redoEdit = useCallback(() => {
    // A new edit must retire the old redo branch even before the debounce ends.
    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
      historyDebounceTimerRef.current = null
    }
    const pendingSnapshot = pendingHistorySnapshotRef.current
    pendingHistorySnapshotRef.current = null
    commitHistorySnapshot(pendingSnapshot ?? draftBlocksRef.current)
    const history = editHistoryRef.current
    const pointer = editHistoryPointerRef.current
    if (pointer >= Math.min(history.length - 1, readingHistoryScopeRef.current?.ceiling ?? Infinity)) {
      return
    }

    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
      historyDebounceTimerRef.current = null
    }

    isRestoringHistoryRef.current = true
    const nextPointer = pointer + 1
    editHistoryPointerRef.current = nextPointer
    const snapshot = history[nextPointer]
    pendingHistoryFocusRef.current = snapshot.bookmark ?? lastEditorBookmarkRef.current
    setDraftBlocks(cloneDraftBlocks(snapshot.blocks))
    setHistoryRevision((current) => current + 1)
    setTimeout(() => {
      isRestoringHistoryRef.current = false
    }, 0)
  }, [commitHistorySnapshot, setDraftBlocks])

  const persistDraft = useCallback(async (silentValidationFailure = false, flushLatest = false, intent?: TitleIntent): Promise<boolean> => {
    const documentId = selectedDocumentIdRef.current
    const session = editorSessionRef.current
    const isCurrentSession = () => mountedRef.current && selectedDocumentIdRef.current === documentId
      && editorSessionRef.current === session
    if (!documentId || !isCurrentSession()
      || (intent && (intent.target.documentId !== documentId || intent.target.session !== session))) return false

    do {
      // Autosave, Save, and navigation share one writer. A waiter checks the
      // latest draft after acknowledgement instead of resending an old revision.
      while (pendingSaveRef.current) {
        const pending = pendingSaveRef.current
        const succeeded = await pending.promise
        if (!isCurrentSession()) return false
        if (!succeeded && pending.documentId === documentId && pending.session === session) {
          intent?.onFailure(ui.documentSaveFailed)
          return false
        }
      }
      const detail = selectedDocumentRef.current
      if (!isCurrentSession() || !detail || detail.id !== documentId || composingDraftRef.current) return false
      const baseTitle = draftTitleRef.current
      const title = intent?.title ?? baseTitle
      const summary = draftSummaryRef.current
      const blocks = draftBlocksRef.current
      const normalizedBlocks = normalizeDraftBlocks(blocks)
      const hasChanges = normalizeComparableDocumentTitle(title) !== normalizeComparableDocumentTitle(detail.title)
        || summary.trim() !== detail.summary.trim()
        || !areDocumentDraftBlocksEqual(normalizedBlocks, normalizeDraftBlocks(detail.blocks.map(toDraftBlock)))
      if (!hasChanges) {
        if (intent && draftTitleRef.current === baseTitle) {
          draftTitleRef.current = detail.title
          setDraftTitle(detail.title)
        }
        return true
      }

      // A rename candidate belongs to its dialog until acknowledged. Failed
      // saves must still describe the actual shared draft and pause its timer.
      const failedSnapshot = { documentId, title: baseTitle, summary, blocks }
      const validation = validateBlockTreeStructure(normalizedBlocks)
      if (!validation.valid) {
        setFailedSave(failedSnapshot)
        intent?.onFailure(ui.cannotSaveInvalidBlockTree(validation.errors))
        if (!silentValidationFailure) {
          console.error('Tree structure validation failed:', validation.errors)
          onMessage(ui.cannotSaveInvalidBlockTree(validation.errors), 'error')
        }
        return false
      }

      setIsSaving(true)
      setFailedSave(null)
      const promise = (async (): Promise<boolean> => {
        try {
          const updateResult = await window.knowbook.updateDocument(documentId, {
            expectedUpdatedAt: detail.updatedAt, title, summary, blocks: normalizedBlocks
          })
          const refreshedDetail = updateResult.document
          if (intent && (!refreshedDetail || refreshedDetail.id !== documentId)) {
            throw new Error(ui.documentSaveFailed)
          }
          if (isCurrentSession()) {
            selectedDocumentRef.current = refreshedDetail
            onSelectedDocumentChange(refreshedDetail)
            if (refreshedDetail) {
              if (draftTitleRef.current === baseTitle) {
                draftTitleRef.current = refreshedDetail.title
                setDraftTitle(refreshedDetail.title)
              }
              if (draftSummaryRef.current === summary) {
                draftSummaryRef.current = refreshedDetail.summary
                setDraftSummary(refreshedDetail.summary)
              }
              if (areDocumentDraftBlocksEqual(normalizeDraftBlocks(draftBlocksRef.current), normalizedBlocks)) {
                const refreshedBlocks = normalizeDraftBlocks(refreshedDetail.blocks.map(toDraftBlock))
                draftBlocksRef.current = refreshedBlocks
                setDraftBlocksState(refreshedBlocks)
              }
            }
          }
          if (mountedRef.current) {
            if (updateResult.requiresFullRefresh) {
              // The document has already committed. A failed workspace refresh
              // must not discard its new revision or cause a conflicting retry.
              try {
                const home = await window.knowbook.getHomeData()
                if (mountedRef.current) onHomeDataChange(home)
              } catch (error) {
                console.warn('Failed to refresh workspace after saving the document.', error)
              }
            } else {
              onHomeDataChange((current) => applyIncrementalDocumentUpdate(current, updateResult))
            }
          }
          return isCurrentSession()
        } catch (error) {
          if (isCurrentSession()) {
            setFailedSave(failedSnapshot)
            intent?.onFailure(getErrorMessage(error, ui.documentSaveFailed))
            if (!(error instanceof Error && error.message === 'Document not found')) {
              onMessage(getErrorMessage(error, ui.documentSaveFailed), 'error')
            }
          }
          return false
        }
      })()
      const pending = { documentId, session, promise }
      pendingSaveRef.current = pending
      const succeeded = await promise
      if (pendingSaveRef.current === pending) {
        pendingSaveRef.current = null
        if (isCurrentSession()) setIsSaving(false)
      }
      if (!succeeded) return false
    } while (flushLatest)
    return true
  }, [onHomeDataChange, onMessage, onSelectedDocumentChange, ui])

  const getRenameTarget = useCallback((): DocumentRenameTarget | null => {
    const documentId = selectedDocumentIdRef.current
    if (!mountedRef.current || !documentId || selectedDocumentRef.current?.id !== documentId) return null
    return { documentId, session: editorSessionRef.current, title: draftTitleRef.current }
  }, [])

  const renameTitle = useCallback((target: DocumentRenameTarget, name: string): Promise<RenameTitleResult> => {
    const isCurrent = () => mountedRef.current && selectedDocumentIdRef.current === target.documentId
      && selectedDocumentRef.current?.id === target.documentId && editorSessionRef.current === target.session
    if (!isCurrent()) return Promise.resolve({ status: 'stale' })
    const title = normalizeComparableDocumentTitle(name)
    const pending = pendingRenameRef.current
    if (pending && pending.target.documentId === target.documentId && pending.target.session === target.session) {
      return pending.title === title ? pending.promise : Promise.resolve({ status: 'busy' })
    }
    if (composingDraftRef.current) return Promise.resolve({ status: 'busy' })
    // Confirming the opening name must not flush unrelated edits or cancel
    // their existing autosave debounce.
    if (title === normalizeComparableDocumentTitle(target.title)
      || title === normalizeComparableDocumentTitle(draftTitleRef.current)) {
      return Promise.resolve({ status: 'saved', title: draftTitleRef.current })
    }
    clearAutoSaveTimer()
    const operation = { target, title, promise: Promise.resolve({ status: 'stale' } as RenameTitleResult) }
    operation.promise = Promise.resolve().then(async (): Promise<RenameTitleResult> => {
      if (!isCurrent()) return { status: 'stale' }
      let message = ui.documentSaveFailed
      const saved = await persistDraft(false, false, { target, title, onFailure: failure => { message = failure } })
      if (!isCurrent()) return { status: 'stale' }
      return saved ? { status: 'saved', title: selectedDocumentRef.current!.title } : { status: 'failed', message }
    }).finally(() => {
      if (pendingRenameRef.current === operation) pendingRenameRef.current = null
    })
    pendingRenameRef.current = operation
    return operation.promise
  }, [clearAutoSaveTimer, persistDraft, ui.documentSaveFailed])

  const saveDocument = useCallback(async () => {
    clearAutoSaveTimer()

    await persistDraft(false, true)
  }, [clearAutoSaveTimer, persistDraft])

  const flushPendingChanges = useCallback(async (): Promise<boolean> => {
    clearAutoSaveTimer()
    if (!hasPendingDraftChanges && !pendingSaveRef.current) return true
    return persistDraft(false, true)
  }, [clearAutoSaveTimer, hasPendingDraftChanges, persistDraft])

  useEffect(() => {
    if (isEditing && !isComposingDraft && !isRestoringHistoryRef.current) {
      scheduleHistorySnapshot(draftBlocksState)
    }
  }, [draftBlocksState, isComposingDraft, isEditing, scheduleHistorySnapshot])

  useEffect(() => {
    if (!isEditing || isComposingDraft || isSaving || hasSaveError || !hasPendingDraftChanges || !selectedDocumentId || !selectedDocument) {
      return
    }

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }

    autoSaveTimerRef.current = setTimeout(() => {
      void persistDraft(true)
    }, 800)

    return () => {
      clearAutoSaveTimer()
    }
  }, [clearAutoSaveTimer, draftBlocksState, draftSummary, draftTitle, hasPendingDraftChanges, hasSaveError, isComposingDraft, isEditing, isSaving, persistDraft, selectedDocument, selectedDocumentId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (historyDebounceTimerRef.current) {
        clearTimeout(historyDebounceTimerRef.current)
      }
      clearAutoSaveTimer()
    }
  }, [clearAutoSaveTimer])

  const getDraftMarkdownExport = useCallback((documentId: string) => {
    if (selectedDocument?.id !== documentId || selectedDocumentIdRef.current !== documentId) return null
    return buildDraftMarkdownExport({ title: draftTitleRef.current, blocks: draftBlocksRef.current })
  }, [selectedDocument?.id])

  const copyDocumentAsMarkdown = useCallback(async () => {
    const snapshot = selectedDocumentId && getDraftMarkdownExport(selectedDocumentId)
    if (!snapshot) return
    try {
      await window.knowbook.writeClipboardText(snapshot.markdown)
      triggerTransientFlash(setMdCopyFlash)
    } catch (error) {
      onMessage(getErrorMessage(error, ui.markdownCopyFailed), 'error')
    }
  }, [getDraftMarkdownExport, onMessage, selectedDocumentId, triggerTransientFlash, ui.markdownCopyFailed])

  const saveDocumentAsMarkdown = useCallback(async () => {
    const snapshot = selectedDocumentId && getDraftMarkdownExport(selectedDocumentId)
    if (!snapshot) return
    try {
      const savedPath = await window.knowbook.saveMarkdownFile(snapshot.fileName, snapshot.markdown)
      if (savedPath) onMessage(ui.markdownExportedPath(savedPath))
    } catch (error) {
      onMessage(getErrorMessage(error, ui.markdownExportFailed), 'error')
    }
  }, [getDraftMarkdownExport, onMessage, selectedDocumentId, ui])

  return {
    canRedo: areDraftBlockSnapshotsEqual(editHistoryRef.current[editHistoryPointerRef.current]?.blocks, draftBlocksState)
      && editHistoryPointerRef.current < Math.min(editHistoryRef.current.length - 1, readingHistoryScopeRef.current?.ceiling ?? Infinity),
    canUndo: editHistoryPointerRef.current >= 0 && (!areDraftBlockSnapshotsEqual(editHistoryRef.current[editHistoryPointerRef.current]?.blocks, draftBlocksState)
      || editHistoryPointerRef.current > Math.max(0, readingHistoryScopeRef.current?.floor ?? 0)),
    checkpointDraft,
    cancelPendingAutoSave: clearAutoSaveTimer,
    clearEditorSession,
    copyDocumentAsMarkdown,
    draftBlocks: draftBlocksState,
    draftSummary,
    draftTitle,
    flushPendingChanges,
    getDraftBlocks,
    getDraftMarkdownExport,
    getRenameTarget,
    hasPendingDraftChanges,
    isEditing,
    isSaving,
    loadDocumentIntoEditor: resetEditorFromDocument,
    mdCopyFlash,
    pushToHistory,
    redoEdit,
    renameTitle,
    saveDocument,
    saveDocumentAsMarkdown,
    saveStatus,
    setDraftBlocks,
    setDraftSummary,
    setDraftTitle,
    setIsSaving,
    updateBlockHighlight,
    updateDraftBlock,
    undoEdit
  }
}
