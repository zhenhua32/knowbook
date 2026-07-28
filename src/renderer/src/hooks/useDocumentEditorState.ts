import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentBlockDraft, DocumentDetail, HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'
import { toDraftBlock } from '../utils/draftBlockShape'
import { buildDocumentMarkdown, getDocumentMarkdownFileName } from '../utils/documentMarkdown'
import { normalizeDraftBlocks, validateBlockTreeStructure } from '../utils/draftTreeNormalization'

type DraftBlockUpdater = DocumentBlockDraft[] | ((previous: DocumentBlockDraft[]) => DocumentBlockDraft[])

type DraftBlockSnapshot = {
  id: string | undefined
  type: string
  content: string
  checked: boolean
  depth: number
  parentBlockId: string | null
  language: string | null
  highlight: string | null
  tags: string[]
}

function cloneDraftBlocks(blocks: DocumentBlockDraft[]): DocumentBlockDraft[] {
  return blocks.map((block) => ({
    ...block,
    tags: block.tags ? [...block.tags] : undefined
  }))
}

function areDraftBlockSnapshotsEqual(left: DocumentBlockDraft[] | undefined, right: DocumentBlockDraft[]): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right)
}

type UseDocumentEditorStateParams = {
  selectedDocumentId: string | null
  selectedDocument: DocumentDetail | null
  ui: UiText
  onHomeDataChange: (homeData: HomeData) => void
  onSelectedDocumentChange: (detail: DocumentDetail | null) => void
  onMessage: (message: string) => void
}

export function useDocumentEditorState({
  selectedDocumentId,
  selectedDocument,
  ui,
  onHomeDataChange,
  onSelectedDocumentChange,
  onMessage
}: UseDocumentEditorStateParams) {
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSummary, setDraftSummary] = useState('')
  const [draftBlocksState, setDraftBlocksState] = useState<DocumentBlockDraft[]>([])
  const [mdCopyFlash, setMdCopyFlash] = useState(false)
  const editHistoryRef = useRef<DocumentBlockDraft[][]>([])
  const editHistoryPointerRef = useRef<number>(-1)
  const isRestoringHistoryRef = useRef<boolean>(false)
  const historyDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingHistorySnapshotRef = useRef<DocumentBlockDraft[] | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedDocumentIdRef = useRef(selectedDocumentId)
  const saveSequenceRef = useRef(0)
  const [, setHistoryRevision] = useState(0)
  selectedDocumentIdRef.current = selectedDocumentId

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
    isRestoringHistoryRef.current = false
  }, [clearAutoSaveTimer])

  const initializeHistoryState = useCallback((blocks: DocumentBlockDraft[]) => {
    const snapshot = cloneDraftBlocks(blocks)
    editHistoryRef.current = [snapshot]
    editHistoryPointerRef.current = 0
    isRestoringHistoryRef.current = false
    pendingHistorySnapshotRef.current = null
  }, [])

  const triggerTransientFlash = useCallback((setter: (value: boolean) => void) => {
    setter(true)
    setTimeout(() => setter(false), 2000)
  }, [])

  const createComparableBlockSnapshot = useCallback((blocks: DocumentBlockDraft[]): DraftBlockSnapshot[] => (
    normalizeDraftBlocks(blocks).map((block) => ({
      id: block.id,
      type: block.type,
      content: block.content,
      checked: Boolean(block.checked),
      depth: block.depth,
      parentBlockId: block.parentBlockId ?? null,
      language: block.language ?? null,
      highlight: block.highlight ?? null,
      tags: [...(block.tags ?? [])].sort()
    }))
  ), [normalizeDraftBlocks])

  const normalizeComparableTitle = useCallback((title: string) => title.trim() || 'Untitled', [])

  const draftSnapshot = useMemo(() => JSON.stringify({
    title: normalizeComparableTitle(draftTitle),
    summary: draftSummary.trim(),
    blocks: createComparableBlockSnapshot(draftBlocksState)
  }), [createComparableBlockSnapshot, draftBlocksState, draftSummary, draftTitle, normalizeComparableTitle])

  const selectedDocumentSnapshot = useMemo(() => {
    if (!selectedDocument) {
      return null
    }

    return JSON.stringify({
      title: normalizeComparableTitle(selectedDocument.title),
      summary: selectedDocument.summary.trim(),
      blocks: createComparableBlockSnapshot(selectedDocument.blocks.map(toDraftBlock))
    })
  }, [createComparableBlockSnapshot, normalizeComparableTitle, selectedDocument, toDraftBlock])

  const hasPendingDraftChanges = Boolean(selectedDocumentId && selectedDocument && draftSnapshot !== selectedDocumentSnapshot)

  const setDraftBlocks = useCallback((next: DraftBlockUpdater) => {
    setDraftBlocksState((previous) => {
      const resolved = typeof next === 'function' ? next(previous) : next
      return normalizeDraftBlocks(resolved)
    })
  }, [normalizeDraftBlocks])

  const updateDraftBlock = useCallback((index: number, patch: Partial<DocumentBlockDraft>) => {
    setDraftBlocks((previous) =>
      previous.map((block, currentIndex) =>
        currentIndex === index
          ? {
              ...block,
              ...patch
            }
          : block
      )
    )
  }, [setDraftBlocks])

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
    if (pointer <= 0) {
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
    if (pointer >= history.length - 1) {
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

    const normalizedDraftBlocks = normalizeDraftBlocks(draftBlocksState)
    const validation = validateBlockTreeStructure(normalizedDraftBlocks)
    if (!validation.valid) {
      if (!silentValidationFailure) {
        console.error('Tree structure validation failed:', validation.errors)
        onMessage(ui.cannotSaveInvalidBlockTree(validation.errors))
      }

      return false
    }

    setIsSaving(true)

    try {
      await window.knowbook.updateDocument(persistedDocumentId, {
        title: draftTitle,
        summary: draftSummary,
        blocks: normalizedDraftBlocks
      })

      const [refreshedHome, refreshedDetail] = await Promise.all([
        window.knowbook.getHomeData(),
        window.knowbook.getDocumentDetail(persistedDocumentId)
      ])

      if (saveSequence === saveSequenceRef.current) {
        onHomeDataChange(refreshedHome)
        if (selectedDocumentIdRef.current === persistedDocumentId) {
          onSelectedDocumentChange(refreshedDetail)
          setDraftSummary(refreshedDetail?.summary ?? '')
        }
      }
      return true
    } catch (error) {
      if (error instanceof Error && error.message === 'Document not found') {
        return false
      }

      throw error
    } finally {
      if (saveSequence === saveSequenceRef.current) {
        setIsSaving(false)
      }
    }
  }, [draftBlocksState, draftSummary, draftTitle, normalizeDraftBlocks, onHomeDataChange, onMessage, onSelectedDocumentChange, selectedDocument, selectedDocumentId, triggerTransientFlash, ui, validateBlockTreeStructure])

  const saveDocument = useCallback(async () => {
    clearAutoSaveTimer()

    await persistDraft(false)
  }, [clearAutoSaveTimer, persistDraft])

  const flushPendingChanges = useCallback(async (): Promise<boolean> => {
    clearAutoSaveTimer()
    if (!hasPendingDraftChanges) {
      return true
    }

    try {
      return await persistDraft(false)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Failed to save document.')
      return false
    }
  }, [clearAutoSaveTimer, hasPendingDraftChanges, onMessage, persistDraft])

  useEffect(() => {
    if (isEditing && !isRestoringHistoryRef.current) {
      scheduleHistorySnapshot(draftBlocksState)
    }
  }, [draftBlocksState, isEditing, scheduleHistorySnapshot])

  useEffect(() => {
    if (!isEditing || isSaving || !hasPendingDraftChanges || !selectedDocumentId || !selectedDocument) {
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
  }, [clearAutoSaveTimer, hasPendingDraftChanges, isEditing, isSaving, persistDraft, selectedDocument, selectedDocumentId])

  useEffect(() => {
    return () => {
      if (historyDebounceTimerRef.current) {
        clearTimeout(historyDebounceTimerRef.current)
      }
      clearAutoSaveTimer()
    }
  }, [clearAutoSaveTimer])

  const copyDocumentAsMarkdown = useCallback(async () => {
    if (!selectedDocument) {
      return
    }

    const markdown = buildDocumentMarkdown(selectedDocument)
    await window.knowbook.writeClipboardText(markdown)
    triggerTransientFlash(setMdCopyFlash)
  }, [buildDocumentMarkdown, selectedDocument, triggerTransientFlash])

  const saveDocumentAsMarkdown = useCallback(async () => {
    if (!selectedDocument) {
      return
    }

    const savedPath = await window.knowbook.saveMarkdownFile(getDocumentMarkdownFileName(selectedDocument), buildDocumentMarkdown(selectedDocument))

    if (savedPath) {
      onMessage(ui.markdownExportedPath(savedPath))
    }
  }, [onMessage, selectedDocument, ui])

  return {
    canRedo: editHistoryPointerRef.current < editHistoryRef.current.length - 1,
    canUndo: editHistoryPointerRef.current > 0,
    cancelPendingAutoSave: clearAutoSaveTimer,
    clearEditorSession,
    copyDocumentAsMarkdown,
    draftBlocks: draftBlocksState,
    draftSummary,
    draftTitle,
    flushPendingChanges,
    hasPendingDraftChanges,
    isEditing,
    isSaving,
    loadDocumentIntoEditor: resetEditorFromDocument,
    mdCopyFlash,
    pushToHistory,
    redoEdit,
    saveDocument,
    saveDocumentAsMarkdown,
    setDraftBlocks,
    setDraftSummary,
    setDraftTitle,
    setIsSaving,
    updateBlockHighlight,
    updateDraftBlock,
    undoEdit
  }
}
