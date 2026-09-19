import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft, DocumentDetail, HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'
import { toDraftBlock } from '../utils/draftBlockShape'
import { buildDraftMarkdownExport } from '../utils/documentMarkdown'
import { normalizeDraftBlocks, validateBlockTreeStructure } from '../utils/draftTreeNormalization'
import { getErrorMessage } from '../utils/errorMessage'
import { applyIncrementalDocumentUpdate } from '../utils/homeDataDocumentUpdate'
import {
  areDocumentDraftBlocksEqual,
  normalizeComparableDocumentTitle
} from '../utils/documentDraftComparison'

type DraftBlockUpdater = DocumentBlockDraft[] | ((previous: DocumentBlockDraft[]) => DocumentBlockDraft[])

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
  onMessage: (message: string) => void
}

export function useDocumentEditorState({
  selectedDocumentId,
  selectedDocument,
  isReadingMode = false,
  ui,
  onHomeDataChange,
  onSelectedDocumentChange,
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
  const editHistoryRef = useRef<DocumentBlockDraft[][]>([])
  const editHistoryPointerRef = useRef<number>(-1)
  // Reading mode can undo its task changes, but must not replay earlier source edits.
  const readingHistoryScopeRef = useRef<{ floor: number; ceiling: number } | null>(null)
  const isReadingModeRef = useRef(isReadingMode)
  const isRestoringHistoryRef = useRef<boolean>(false)
  const historyDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingHistorySnapshotRef = useRef<DocumentBlockDraft[] | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedDocumentIdRef = useRef(selectedDocumentId)
  const saveSequenceRef = useRef(0)
  const draftTitleRef = useRef(draftTitle)
  const draftSummaryRef = useRef(draftSummary)
  const draftBlocksRef = useRef(draftBlocksState)
  const [, setHistoryRevision] = useState(0)
  selectedDocumentIdRef.current = selectedDocumentId
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

    clearAutoSaveTimer()

    editHistoryRef.current = []
    editHistoryPointerRef.current = -1
    readingHistoryScopeRef.current = null
    isRestoringHistoryRef.current = false
  }, [clearAutoSaveTimer])

  const initializeHistoryState = useCallback((blocks: DocumentBlockDraft[]) => {
    const snapshot = cloneDraftBlocks(blocks)
    editHistoryRef.current = [snapshot]
    editHistoryPointerRef.current = 0
    readingHistoryScopeRef.current = isReadingModeRef.current ? { floor: 0, ceiling: 0 } : null
    isRestoringHistoryRef.current = false
    pendingHistorySnapshotRef.current = null
  }, [])

  useEffect(() => {
    let composingTarget: EventTarget | null = null
    const start = (event: CompositionEvent) => {
      if (!(event.target instanceof HTMLElement) || !event.target.closest('.block-editor-list, .document-summary-card')) return
      composingTarget = event.target
      clearAutoSaveTimer()
      setIsComposingDraft(true)
    }
    const end = (event: Event) => {
      if (event.target !== composingTarget) return
      composingTarget = null
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
  }, [normalizeDraftBlocks, selectedDocument, toDraftBlock])

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
  }, [normalizeDraftBlocks])

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
  }, [normalizeDraftBlocks])

  const getDraftBlocks = useCallback(() => draftBlocksRef.current, [])

  const updateBlockHighlight = useCallback((index: number, highlight: string | undefined) => {
    updateDraftBlock(index, {
      highlight
    })
  }, [updateDraftBlock])

  const resetEditorFromDocument = useCallback((detail: DocumentDetail | null, editing = Boolean(detail)) => {
    const initialBlocks = normalizeDraftBlocks(detail?.blocks.map(toDraftBlock) ?? [])

    setDraftTitle(detail?.title ?? '')
    setDraftSummary(detail?.summary ?? '')
    setDraftBlocksState(initialBlocks)
    setIsEditing(editing)
    setIsComposingDraft(false)
    setFailedSave(null)

    if (detail && editing) {
      initializeHistoryState(initialBlocks)
    } else {
      clearHistoryState()
    }
  }, [clearHistoryState, initializeHistoryState, normalizeDraftBlocks, toDraftBlock])

  const clearEditorSession = useCallback(() => {
    resetEditorFromDocument(null, false)
  }, [resetEditorFromDocument])

  const commitHistorySnapshot = useCallback((blocks: DocumentBlockDraft[]) => {
    const snapshot = cloneDraftBlocks(blocks)
    const history = editHistoryRef.current
    const pointer = editHistoryPointerRef.current
    if (areDraftBlockSnapshotsEqual(history[pointer], snapshot)) {
      return
    }

    const trimmed = history.slice(0, pointer + 1)
    trimmed.push(snapshot)
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
    if (pendingSnapshot) {
      commitHistorySnapshot(pendingSnapshot)
    }

    const pointer = editHistoryPointerRef.current
    if (pointer <= Math.max(0, readingHistoryScopeRef.current?.floor ?? 0)) {
      return
    }

    isRestoringHistoryRef.current = true
    const nextPointer = pointer - 1
    editHistoryPointerRef.current = nextPointer
    setDraftBlocks(cloneDraftBlocks(editHistoryRef.current[nextPointer]))
    setHistoryRevision((current) => current + 1)
    setTimeout(() => {
      isRestoringHistoryRef.current = false
    }, 0)
  }, [commitHistorySnapshot, setDraftBlocks])

  const redoEdit = useCallback(() => {
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
    setDraftBlocks(cloneDraftBlocks(history[nextPointer]))
    setHistoryRevision((current) => current + 1)
    setTimeout(() => {
      isRestoringHistoryRef.current = false
    }, 0)
  }, [setDraftBlocks])

  const persistDraft = useCallback(async (silentValidationFailure = false) => {
    if (!selectedDocumentId || !selectedDocument) {
      return false
    }

    const persistedDocumentId = selectedDocumentId
    const saveSequence = ++saveSequenceRef.current
    const failedSnapshot = { documentId: persistedDocumentId, title: draftTitle, summary: draftSummary, blocks: draftBlocksState }

    const normalizedDraftBlocks = normalizeDraftBlocks(draftBlocksState)
    const validation = validateBlockTreeStructure(normalizedDraftBlocks)
    if (!validation.valid) {
      setFailedSave(failedSnapshot)
      if (!silentValidationFailure) {
        console.error('Tree structure validation failed:', validation.errors)
        onMessage(ui.cannotSaveInvalidBlockTree(validation.errors))
      }

      return false
    }

    setIsSaving(true)
    setFailedSave(null)

    try {
      const updateResult = await window.knowbook.updateDocument(persistedDocumentId, {
        title: draftTitle,
        summary: draftSummary,
        blocks: normalizedDraftBlocks
      })

      const refreshedHome = updateResult.requiresFullRefresh
        ? await window.knowbook.getHomeData()
        : null
      const refreshedDetail = updateResult.document

      if (saveSequence === saveSequenceRef.current) {
        if (refreshedHome) {
          onHomeDataChange(refreshedHome)
        } else if (!updateResult.requiresFullRefresh) {
          onHomeDataChange((current) => applyIncrementalDocumentUpdate(current, updateResult))
        }
        if (selectedDocumentIdRef.current === persistedDocumentId) {
          onSelectedDocumentChange(refreshedDetail)
          if (refreshedDetail) {
            if (draftTitleRef.current === draftTitle) {
              setDraftTitle(refreshedDetail.title)
            }
            if (draftSummaryRef.current === draftSummary) {
              setDraftSummary(refreshedDetail.summary)
            }
            const currentNormalizedBlocks = normalizeDraftBlocks(draftBlocksRef.current)
            if (areDocumentDraftBlocksEqual(currentNormalizedBlocks, normalizedDraftBlocks)) {
              setDraftBlocksState(normalizeDraftBlocks(refreshedDetail.blocks.map(toDraftBlock)))
            }
          }
        }
      }
      return true
    } catch (error) {
      if (saveSequence === saveSequenceRef.current) setFailedSave(failedSnapshot)
      if (error instanceof Error && error.message === 'Document not found') {
        return false
      }

      onMessage(getErrorMessage(error, ui.documentSaveFailed))
      return false
    } finally {
      if (saveSequence === saveSequenceRef.current) {
        setIsSaving(false)
      }
    }
  }, [draftBlocksState, draftSummary, draftTitle, normalizeDraftBlocks, onHomeDataChange, onMessage, onSelectedDocumentChange, selectedDocument, selectedDocumentId, toDraftBlock, ui, validateBlockTreeStructure])

  const saveDocument = useCallback(async () => {
    clearAutoSaveTimer()

    await persistDraft(false)
  }, [clearAutoSaveTimer, persistDraft])

  const flushPendingChanges = useCallback(async (): Promise<boolean> => {
    clearAutoSaveTimer()
    if (!hasPendingDraftChanges) {
      return true
    }

    return persistDraft(false)
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
  }, [clearAutoSaveTimer, hasPendingDraftChanges, hasSaveError, isComposingDraft, isEditing, isSaving, persistDraft, selectedDocument, selectedDocumentId])

  useEffect(() => {
    return () => {
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
      onMessage(getErrorMessage(error, ui.markdownCopyFailed))
    }
  }, [getDraftMarkdownExport, onMessage, selectedDocumentId, triggerTransientFlash, ui.markdownCopyFailed])

  const saveDocumentAsMarkdown = useCallback(async () => {
    const snapshot = selectedDocumentId && getDraftMarkdownExport(selectedDocumentId)
    if (!snapshot) return
    try {
      const savedPath = await window.knowbook.saveMarkdownFile(snapshot.fileName, snapshot.markdown)
      if (savedPath) onMessage(ui.markdownExportedPath(savedPath))
    } catch (error) {
      onMessage(getErrorMessage(error, ui.markdownExportFailed))
    }
  }, [getDraftMarkdownExport, onMessage, selectedDocumentId, ui])

  return {
    canRedo: editHistoryPointerRef.current < Math.min(editHistoryRef.current.length - 1, readingHistoryScopeRef.current?.ceiling ?? Infinity),
    canUndo: editHistoryPointerRef.current > Math.max(0, readingHistoryScopeRef.current?.floor ?? 0),
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
    hasPendingDraftChanges,
    isEditing,
    isSaving,
    loadDocumentIntoEditor: resetEditorFromDocument,
    mdCopyFlash,
    pushToHistory,
    redoEdit,
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
