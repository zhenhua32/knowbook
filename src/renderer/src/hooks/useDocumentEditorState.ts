import { useCallback, useEffect, useRef, useState } from 'react'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import type { DocumentBlockDraft, DocumentDetail, HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'
import { toDraftBlock } from '../utils/draftBlockShape'
import { normalizeDraftBlocks, validateBlockTreeStructure } from '../utils/draftTreeNormalization'

type DraftBlockUpdater = DocumentBlockDraft[] | ((previous: DocumentBlockDraft[]) => DocumentBlockDraft[])

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
  const [autoSaveFlash, setAutoSaveFlash] = useState(false)
  const [mdCopyFlash, setMdCopyFlash] = useState(false)
  const editHistoryRef = useRef<DocumentBlockDraft[][]>([])
  const editHistoryPointerRef = useRef<number>(-1)
  const isRestoringHistoryRef = useRef<boolean>(false)
  const historyDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearHistoryState = useCallback(() => {
    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
      historyDebounceTimerRef.current = null
    }

    editHistoryRef.current = []
    editHistoryPointerRef.current = -1
    isRestoringHistoryRef.current = false
  }, [])

  const initializeHistoryState = useCallback((blocks: DocumentBlockDraft[]) => {
    const snapshot = blocks.map((block) => ({ ...block }))
    editHistoryRef.current = [snapshot]
    editHistoryPointerRef.current = 0
    isRestoringHistoryRef.current = false
  }, [])

  const triggerTransientFlash = useCallback((setter: (value: boolean) => void) => {
    setter(true)
    setTimeout(() => setter(false), 2000)
  }, [])

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

  const pushToHistory = useCallback((blocks: DocumentBlockDraft[]) => {
    if (isRestoringHistoryRef.current) {
      return
    }

    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
      historyDebounceTimerRef.current = null
    }

    const history = editHistoryRef.current
    const pointer = editHistoryPointerRef.current
    const trimmed = history.slice(0, pointer + 1)
    trimmed.push(blocks.map((block) => ({ ...block })))
    editHistoryRef.current = trimmed.slice(-80)
    editHistoryPointerRef.current = editHistoryRef.current.length - 1
  }, [])

  const scheduleHistorySnapshot = useCallback((blocks: DocumentBlockDraft[]) => {
    if (isRestoringHistoryRef.current) {
      return
    }

    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
    }

    historyDebounceTimerRef.current = setTimeout(() => {
      historyDebounceTimerRef.current = null
      const history = editHistoryRef.current
      const pointer = editHistoryPointerRef.current
      const trimmed = history.slice(0, pointer + 1)
      trimmed.push(blocks.map((block) => ({ ...block })))
      editHistoryRef.current = trimmed.slice(-80)
      editHistoryPointerRef.current = editHistoryRef.current.length - 1
    }, 600)
  }, [])

  const undoEdit = useCallback(() => {
    const pointer = editHistoryPointerRef.current
    if (pointer <= 0) {
      return
    }

    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
      historyDebounceTimerRef.current = null
    }

    isRestoringHistoryRef.current = true
    const nextPointer = pointer - 1
    editHistoryPointerRef.current = nextPointer
    setDraftBlocks(editHistoryRef.current[nextPointer].map((block) => ({ ...block })))
    setTimeout(() => {
      isRestoringHistoryRef.current = false
    }, 0)
  }, [setDraftBlocks])

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
    setDraftBlocks(history[nextPointer].map((block) => ({ ...block })))
    setTimeout(() => {
      isRestoringHistoryRef.current = false
    }, 0)
  }, [setDraftBlocks])

  const persistDraft = useCallback(async (silentValidationFailure = false) => {
    if (!selectedDocumentId || !selectedDocument) {
      return false
    }

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
      await window.knowbook.updateDocument(selectedDocumentId, {
        title: draftTitle,
        summary: draftSummary,
        blocks: normalizedDraftBlocks
      })

      const [refreshedHome, refreshedDetail] = await Promise.all([
        window.knowbook.getHomeData(),
        window.knowbook.getDocumentDetail(selectedDocumentId)
      ])

      onHomeDataChange(refreshedHome)
      onSelectedDocumentChange(refreshedDetail)
      triggerTransientFlash(setAutoSaveFlash)
      return true
    } finally {
      setIsSaving(false)
    }
  }, [draftBlocksState, draftSummary, draftTitle, normalizeDraftBlocks, onHomeDataChange, onMessage, onSelectedDocumentChange, selectedDocument, selectedDocumentId, triggerTransientFlash, ui, validateBlockTreeStructure])

  const saveDocument = useCallback(async () => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }

    await persistDraft(false)
  }, [persistDraft])

  useEffect(() => {
    if (isEditing && !isRestoringHistoryRef.current) {
      scheduleHistorySnapshot(draftBlocksState)
    }
  }, [draftBlocksState, isEditing, scheduleHistorySnapshot])

  useEffect(() => {
    if (!isEditing || isSaving || !selectedDocumentId || !selectedDocument) {
      return
    }

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }

    autoSaveTimerRef.current = setTimeout(() => {
      void persistDraft(true)
    }, 800)

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
      }
    }
  }, [draftBlocksState, draftSummary, draftTitle, isEditing, isSaving, persistDraft, selectedDocument, selectedDocumentId])

  useEffect(() => {
    return () => {
      if (historyDebounceTimerRef.current) {
        clearTimeout(historyDebounceTimerRef.current)
      }
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
      }
    }
  }, [])

  const buildDocumentMarkdown = useCallback((document: Pick<DocumentDetail, 'title' | 'blocks'>) => {
    const body = serializeBlocksToMarkdown(document.blocks)
    return body.trim() === '' ? `# ${document.title}\n` : `# ${document.title}\n\n${body}`
  }, [])

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

    const baseName = selectedDocument.path.split('/').filter(Boolean).at(-1) || selectedDocument.title || 'document'
    const savedPath = await window.knowbook.saveMarkdownFile(`${baseName}.md`, buildDocumentMarkdown(selectedDocument))

    if (savedPath) {
      onMessage(ui.markdownExportedPath(savedPath))
    }
  }, [buildDocumentMarkdown, onMessage, selectedDocument, ui])

  return {
    autoSaveFlash,
    canRedo: editHistoryPointerRef.current < editHistoryRef.current.length - 1,
    canUndo: editHistoryPointerRef.current > 0,
    clearEditorSession,
    copyDocumentAsMarkdown,
    draftBlocks: draftBlocksState,
    draftSummary,
    draftTitle,
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