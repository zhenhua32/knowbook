import type { AppMessageHandler } from '../notify'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft, DocumentDetail, HomeData } from '@shared/contracts'
import type { BlockMoveCompletionContext } from '../utils/blockMoveActions'
import type { UiText } from '../i18n'
import { toDraftBlock } from '../utils/draftBlockShape'
import { buildDraftMarkdownExport } from '../utils/documentMarkdown'
import { normalizeDraftBlocks, validateBlockTreeStructure } from '../utils/draftTreeNormalization'
import { prepareDraftBlockTypeChange } from '../utils/draftTreeTextEditing'
import { getErrorMessage } from '../utils/errorMessage'
import { captureAsyncHistoryFocusPermission, captureEditorHistoryBookmark, restoreEditorHistoryBookmark, type EditorHistoryBookmark } from '../utils/editorHistoryFocus'
import { isIndependentEditorIsland } from '../utils/editorIsland'
import type { SyncedStructureApplied } from '@shared/synced-blocks'
import type { SyncedHostSourceCurrent } from '../features/synced-blocks/SyncedHostSourceDialog'
import { canonicalInlineInputLocked, canApplyCanonicalHostDraftChange, flushCanonicalInlinePendingChanges, hasCanonicalHostSavePending } from '../features/synced-blocks/inlineBridge'
import {
  areDocumentDraftBlocksEqual,
  normalizeComparableDocumentTitle
} from '../utils/documentDraftComparison'

type DraftBlockUpdater = DocumentBlockDraft[] | ((previous: DocumentBlockDraft[]) => DocumentBlockDraft[])
type DraftWriterModule = Pick<typeof import('../utils/documentDraftWriter'), 'completeDocumentDraftWrite'>
const loadDocumentDraftWriter = (): Promise<DraftWriterModule> => import('../utils/documentDraftWriter')
type MoveTransition = { operationId: string; versions: Record<string, string> }
type EditSnapshot = { blocks: DocumentBlockDraft[]; bookmark: EditorHistoryBookmark | null; move?: MoveTransition }
export type DocumentBlockActionTarget = Readonly<{
  documentId: string; session: number; blockIds: readonly string[]
  blocks: DocumentBlockDraft[]; bookmark: EditorHistoryBookmark | null
}>

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
    tags: block.tags ? [...block.tags] : undefined,
    markdownFormat: block.markdownFormat ? { ...block.markdownFormat } : undefined
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
}: UseDocumentEditorStateParams, loadWriter: () => Promise<DraftWriterModule> = loadDocumentDraftWriter) {
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isBlockMoveBusy, setIsBlockMoveBusy] = useState(false)
  const blockMoveBusyRef = useRef(false)
  const pairedHistoryFocusRef = useRef(false)
  const restoreMoveRef = useRef<(move: MoveTransition, state: 'applied' | 'undone') => Promise<boolean>>(async () => false)
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
  const checkpointedDraftBlocksRef = useRef<DocumentBlockDraft[] | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedDocumentIdRef = useRef(selectedDocumentId)
  const selectedDocumentRef = useRef(selectedDocument)
  const renderedDocumentRef = useRef(selectedDocument)
  const editorSessionRef = useRef(0)
  const syncedHostSessionRef = useRef<object>({})
  const syncedHostSequenceRef = useRef({ raw: '', sequence: 0 })
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
    checkpointedDraftBlocksRef.current = null
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
    checkpointedDraftBlocksRef.current = null
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
    if (blockMoveBusyRef.current) return
    setDraftBlocksState((previous) => {
      if (blockMoveBusyRef.current) return previous
      const resolved = typeof next === 'function' ? next(previous) : next
      if (!canApplyCanonicalHostDraftChange(previous, resolved)) return previous
      return normalizeDraftBlocks(resolved)
    })
  }, [])

  const updateDraftBlock = useCallback((index: number, patch: Partial<DocumentBlockDraft>) => {
    if (blockMoveBusyRef.current) return
    setDraftBlocksState((previous) => {
      if (blockMoveBusyRef.current) return previous
      const currentBlock = previous[index]
      if (!currentBlock) {
        return previous
      }

      const nextBlock = { ...currentBlock, ...patch }
      // Toolbar and context-menu type changes share the same parent-removal
      // semantics as keyboard edits. A paragraph/heading cannot own list items.
      const sourceBlocks = 'type' in patch
        ? prepareDraftBlockTypeChange(previous, index, nextBlock.type.trim() || 'paragraph') : previous
      const nextBlocks = sourceBlocks.map((block, currentIndex) => currentIndex === index ? { ...block, ...patch,
        ...('type' in patch ? { depth: block.depth, parentBlockId: block.parentBlockId } : {}) } : block)
      const changesTreeShape = (
        ('id' in patch && patch.id !== currentBlock.id)
        || ('type' in patch && patch.type !== currentBlock.type)
        || ('depth' in patch && patch.depth !== currentBlock.depth)
        || ('parentBlockId' in patch && patch.parentBlockId !== currentBlock.parentBlockId)
      )

      if (!canApplyCanonicalHostDraftChange(previous, nextBlocks)) return previous
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
    syncedHostSessionRef.current = Object.freeze({})
    syncedHostSequenceRef.current = { raw: '', sequence: 0 }
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

  const commitHistorySnapshot = useCallback((blocks: DocumentBlockDraft[], bookmarkOverride?: EditorHistoryBookmark | null) => {
    const snapshot = cloneDraftBlocks(blocks)
    const history = editHistoryRef.current
    const pointer = editHistoryPointerRef.current
    const bookmark = bookmarkOverride ?? captureEditorHistoryBookmark(blocks) ?? lastEditorBookmarkRef.current
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

  const pushToHistory = useCallback((blocks: DocumentBlockDraft[], bookmarkOverride?: EditorHistoryBookmark | null) => {
    if (isRestoringHistoryRef.current) {
      return
    }

    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
      historyDebounceTimerRef.current = null
    }
    pendingHistorySnapshotRef.current = null
    commitHistorySnapshot(blocks, bookmarkOverride)
    checkpointedDraftBlocksRef.current = blocks
  }, [commitHistorySnapshot])

  const scheduleHistorySnapshot = useCallback((blocks: DocumentBlockDraft[]) => {
    // A child layout may have already closed a programmatic edit after
    // restoring its selection. Do not reopen that same draft as pending typing.
    if (isRestoringHistoryRef.current || blocks === checkpointedDraftBlocksRef.current) {
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
    let composingTarget: EventTarget | null = null
    const start = (event: CompositionEvent) => {
      if (isIndependentEditorIsland(event.target)) return
      if (!(event.target instanceof HTMLElement) || !event.target.closest('.block-editor-list, .document-summary-card')) return
      const bookmark = captureEditorHistoryBookmark(draftBlocksRef.current, event.target)
      if (bookmark) {
        lastEditorBookmarkRef.current = bookmark
        // IME beforeinput events arrive after composition has started. Capture
        // the selection here, before it is replaced by candidate text, while
        // retaining any still-pending typing in the same transaction.
        if (!pendingHistorySnapshotRef.current || areDraftBlockSnapshotsEqual(
          editHistoryRef.current[editHistoryPointerRef.current]?.blocks, draftBlocksRef.current
        )) checkpointDraft()
      }
      if (historyDebounceTimerRef.current) {
        clearTimeout(historyDebounceTimerRef.current)
        historyDebounceTimerRef.current = null
      }
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
    const eventTypes = ['compositionstart', 'compositionend', 'blur'] as const
    const listener = (event: Event) => event.type === 'compositionstart' ? start(event as CompositionEvent) : end(event)
    for (const type of eventTypes) document.addEventListener(type, listener, true)
    return () => {
      for (const type of eventTypes) document.removeEventListener(type, listener, true)
    }
  }, [checkpointDraft, clearAutoSaveTimer])

  useEffect(() => {
    const capture = (event: Event) => {
      const bookmark = captureEditorHistoryBookmark(draftBlocksRef.current, event.type === 'selectionchange' ? document.activeElement : event.target)
      if (!bookmark) return
      const previous = lastEditorBookmarkRef.current
      lastEditorBookmarkRef.current = bookmark
      if (event.type === 'selectionchange' || composingDraftRef.current || isRestoringHistoryRef.current) return
      if (event.type === 'beforeinput') {
        // Focus precedes placing a caret with the mouse. Capture the actual
        // selection before the first keystroke, without splitting later typing.
        if (!pendingHistorySnapshotRef.current) checkpointDraft()
        return
      }
      if (event.type === 'focusin') {
        const sameBlock = bookmark.blockId ? bookmark.blockId === previous?.blockId : bookmark.index === previous?.index
        const sameCell = bookmark.cell?.row === previous?.cell?.row && bookmark.cell?.column === previous?.cell?.column
        // Moving to another editor ends the previous typing transaction even
        // when the 600 ms idle timer has not fired. It also records the new
        // editor's selection in the checkpoint that its next edit will undo to.
        if (!sameBlock || !sameCell) checkpointDraft()
      } else {
        const next = (event as FocusEvent).relatedTarget
        const row = (event.target as HTMLElement).closest('.block-editor-row')
        // Toolbar focus belongs to the same edit; leaving the block (including
        // entering title/summary inputs with native undo) ends its transaction.
        if (!(next instanceof HTMLElement) || !row?.contains(next)) checkpointDraft()
      }
    }
    const eventTypes = ['focusin', 'focusout', 'selectionchange', 'beforeinput'] as const
    for (const type of eventTypes) document.addEventListener(type, capture, type === 'beforeinput')
    return () => {
      for (const type of eventTypes) document.removeEventListener(type, capture, type === 'beforeinput')
    }
  }, [checkpointDraft])

  useEffect(() => {
    if (editHistoryPointerRef.current >= 0) checkpointDraft()
    const pointer = editHistoryPointerRef.current
    readingHistoryScopeRef.current = isReadingMode ? { floor: pointer, ceiling: pointer } : null
    setHistoryRevision((current) => current + 1)
  }, [checkpointDraft, isReadingMode])

  const undoEdit = useCallback(async () => {
    if (blockMoveBusyRef.current) return
    const session = editorSessionRef.current, raw = JSON.stringify(draftBlocksRef.current)
    if (canonicalInlineInputLocked() || !await flushCanonicalInlinePendingChanges()
      || session !== editorSessionRef.current || raw !== JSON.stringify(draftBlocksRef.current)) return
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

    const move = editHistoryRef.current[pointer].move
    if (move && !await restoreMoveRef.current(move, 'undone')) return
    isRestoringHistoryRef.current = true
    const nextPointer = pointer - 1
    editHistoryPointerRef.current = nextPointer
    const snapshot = editHistoryRef.current[nextPointer]
    pendingHistoryFocusRef.current = move && !pairedHistoryFocusRef.current ? null : snapshot.bookmark ?? lastEditorBookmarkRef.current
    setDraftBlocks(cloneDraftBlocks(snapshot.blocks))
    setHistoryRevision((current) => current + 1)
    setTimeout(() => {
      isRestoringHistoryRef.current = false
    }, 0)
  }, [commitHistorySnapshot, setDraftBlocks])

  const redoEdit = useCallback(async () => {
    if (blockMoveBusyRef.current) return
    const session = editorSessionRef.current, raw = JSON.stringify(draftBlocksRef.current)
    if (canonicalInlineInputLocked() || !await flushCanonicalInlinePendingChanges()
      || session !== editorSessionRef.current || raw !== JSON.stringify(draftBlocksRef.current)) return
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

    const move = history[pointer + 1].move
    if (move && !await restoreMoveRef.current(move, 'applied')) return
    isRestoringHistoryRef.current = true
    const nextPointer = pointer + 1
    editHistoryPointerRef.current = nextPointer
    const snapshot = history[nextPointer]
    pendingHistoryFocusRef.current = move && !pairedHistoryFocusRef.current ? null : snapshot.bookmark ?? lastEditorBookmarkRef.current
    setDraftBlocks(cloneDraftBlocks(snapshot.blocks))
    setHistoryRevision((current) => current + 1)
    setTimeout(() => {
      isRestoringHistoryRef.current = false
    }, 0)
  }, [commitHistorySnapshot, setDraftBlocks])

  const getSyncedHostEditorState = useCallback((): SyncedHostSourceCurrent | null => {
    const documentId = selectedDocumentIdRef.current, detail = selectedDocumentRef.current, blocks = draftBlocksRef.current
    if (!mountedRef.current || !documentId || detail?.id !== documentId || blocks.some(block => typeof block.id !== 'string' || !block.id)) return null
    const raw = JSON.stringify([draftTitleRef.current, draftSummaryRef.current, blocks]), sequence = syncedHostSequenceRef.current
    if (sequence.raw !== raw) { sequence.raw = raw; sequence.sequence++ }
    return { hostSession: syncedHostSessionRef.current, editSequence: sequence.sequence, host: { documentId,
      expectedPersistedUpdatedAt: detail.updatedAt, workingBefore: { title: draftTitleRef.current, summary: draftSummaryRef.current,
        blocks: blocks.map(block => ({ ...block, id: block.id!, parentBlockId: block.parentBlockId ?? null })) } } }
  }, [])
  const persistDraft = useCallback(async (silentValidationFailure = false, flushLatest = false, intent?: TitleIntent): Promise<boolean> => {
    const documentId = selectedDocumentIdRef.current
    const session = editorSessionRef.current
    const isCurrentSession = () => mountedRef.current && selectedDocumentIdRef.current === documentId
      && editorSessionRef.current === session
    if (!documentId || !isCurrentSession()
      || (intent && (intent.target.documentId !== documentId || intent.target.session !== session))) return false
    if (!await flushCanonicalInlinePendingChanges({ shouldContinue: isCurrentSession }) || !isCurrentSession()) return false

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
      if (!hasChanges && !hasCanonicalHostSavePending()) {
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
          const requiresSyncedWriter = hasCanonicalHostSavePending() || [...normalizedBlocks, ...detail.blocks].some(block => block.type === 'synced-block')
          const syncedHost = requiresSyncedWriter ? getSyncedHostEditorState() : null
          const { completeDocumentDraftWrite } = await loadWriter()
          return await completeDocumentDraftWrite({ documentId, title, summary, normalizedBlocks, detail, baseTitle,
            renaming: Boolean(intent), saveFailed: ui.documentSaveFailed, requiresSyncedWriter, syncedHost,
            isCurrentSession, mountedRef, selectedDocumentRef, draftTitleRef, draftSummaryRef, draftBlocksRef,
            editHistoryRef, onSelectedDocumentChange, setDraftTitle, setDraftSummary, setDraftBlocksState, onHomeDataChange })
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
  }, [getSyncedHostEditorState, loadWriter, onHomeDataChange, onMessage, onSelectedDocumentChange, ui])

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
    if (composingDraftRef.current || blockMoveBusyRef.current) return Promise.resolve({ status: 'busy' })
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
    if (blockMoveBusyRef.current) return
    clearAutoSaveTimer()

    await persistDraft(false, true)
  }, [clearAutoSaveTimer, persistDraft])

  const flushPendingChanges = useCallback(async (): Promise<boolean> => {
    if (blockMoveBusyRef.current) return false
    const session = editorSessionRef.current
    if (!await flushCanonicalInlinePendingChanges({ shouldContinue: () => mountedRef.current && editorSessionRef.current === session })) return false
    clearAutoSaveTimer()
    if (!hasPendingDraftChanges && !pendingSaveRef.current && !hasCanonicalHostSavePending()) return true
    return persistDraft(false, true)
  }, [clearAutoSaveTimer, hasPendingDraftChanges, persistDraft])

  const adoptSyncedHostStructureResult = useCallback((before: SyncedHostSourceCurrent, result: SyncedStructureApplied): boolean => {
    const current = getSyncedHostEditorState(), row = result.hosts.find(row => row.documentId === before.host.documentId)
    if (!current || current.hostSession !== before.hostSession || current.editSequence !== before.editSequence
      || JSON.stringify(current.host) !== JSON.stringify(before.host) || !row || row.after.id !== before.host.documentId
      || result.hosts.length !== 1 || row.logicalBefore.title !== before.host.workingBefore.title
      || row.logicalBefore.summary !== before.host.workingBefore.summary
      || !areDocumentDraftBlocksEqual(row.logicalBefore.blocks, before.host.workingBefore.blocks)) return false
    clearAutoSaveTimer()
    const detail = row.after, blocks = normalizeDraftBlocks(detail.blocks.map(toDraftBlock))
    selectedDocumentRef.current = detail; draftTitleRef.current = detail.title; draftSummaryRef.current = detail.summary; draftBlocksRef.current = blocks
    onSelectedDocumentChange(detail); setDraftTitle(detail.title); setDraftSummary(detail.summary); setDraftBlocksState(blocks)
    // Main owns this structural history. Do not replay its reference changes
    // through an ordinary local snapshot save on a later Undo.
    initializeHistoryState(blocks); setFailedSave(null); setHistoryRevision(value => value + 1)
    void window.knowbook.getHomeData().then(home => { if (mountedRef.current) onHomeDataChange(home) }).catch(error => console.warn('Failed to refresh after shared host source acknowledgement', error))
    return true
  }, [clearAutoSaveTimer, getSyncedHostEditorState, initializeHistoryState, onHomeDataChange, onSelectedDocumentChange])

  const applyOrdinaryMarkdownSource = useCallback((before: SyncedHostSourceCurrent, after: {
    documentId: string; title: string; summary: string; blocks: DocumentBlockDraft[]
  }): boolean => {
    const current = getSyncedHostEditorState(), persisted = selectedDocumentRef.current
    if (canonicalInlineInputLocked() || !current || current.hostSession !== before.hostSession || current.editSequence !== before.editSequence
      || current.host.documentId !== after.documentId || after.documentId !== before.host.documentId
      || after.title !== before.host.workingBefore.title || after.summary !== before.host.workingBefore.summary
      || [...current.host.workingBefore.blocks, ...after.blocks, ...(persisted?.blocks ?? [])].some(block => block.type === 'synced-block')
      || !areDocumentDraftBlocksEqual(current.host.workingBefore.blocks, before.host.workingBefore.blocks)) return false
    const blocks = normalizeDraftBlocks(after.blocks)
    if (!validateBlockTreeStructure(blocks).valid) return false
    checkpointDraft(); draftBlocksRef.current = blocks; setDraftBlocksState(blocks)
    return true
  }, [checkpointDraft, getSyncedHostEditorState])

  const getBlockActionTarget = useCallback((blockIds: readonly string[]): DocumentBlockActionTarget | null => {
    const documentId = selectedDocumentIdRef.current, blocks = draftBlocksRef.current
    if (!documentId || selectedDocumentRef.current?.id !== documentId || blockMoveBusyRef.current
      || composingDraftRef.current || !blockIds.length) return null
    const existingIds = new Set(blocks.map(block => block.id))
    if (blockIds.some(id => !existingIds.has(id))) return null
    return { documentId, session: editorSessionRef.current, blockIds: [...new Set(blockIds)], blocks: cloneDraftBlocks(blocks),
      bookmark: captureEditorHistoryBookmark(blocks) ?? lastEditorBookmarkRef.current }
  }, [])

  const isBlockActionTargetCurrent = useCallback((target: DocumentBlockActionTarget) => (
    mountedRef.current && target.documentId === selectedDocumentIdRef.current
      && target.documentId === selectedDocumentRef.current?.id && target.session === editorSessionRef.current
      && areDocumentDraftBlocksEqual(target.blocks, draftBlocksRef.current)
  ), [])

  const getBlockMoveContext = useCallback((isCurrent: () => boolean): BlockMoveCompletionContext => ({
    isCurrent, mounted: mountedRef, busy: blockMoveBusyRef, selectedId: selectedDocumentIdRef,
    selected: selectedDocumentRef, blocks: draftBlocksRef, title: draftTitleRef, summary: draftSummaryRef,
    checkpointed: checkpointedDraftBlocksRef, history: editHistoryRef, pointer: editHistoryPointerRef,
    setBlocks: setDraftBlocksState, setTitle: setDraftTitle, setSummary: setDraftSummary, clearFailure: setFailedSave,
    onDocument: onSelectedDocumentChange, onHome: onHomeDataChange, onRevision: setHistoryRevision
  }), [onHomeDataChange, onSelectedDocumentChange])

  const moveDraftBlocksToDocument = useCallback(async (target: DocumentBlockActionTarget, toDocumentId: string): Promise<boolean> => {
    if (blockMoveBusyRef.current || composingDraftRef.current || !isBlockActionTargetCurrent(target)
      || target.documentId === toDocumentId) return false
    blockMoveBusyRef.current = true
    setIsBlockMoveBusy(true)
    clearAutoSaveTimer()
    checkpointDraft()
    const isCurrent = () => mountedRef.current && selectedDocumentIdRef.current === target.documentId
      && editorSessionRef.current === target.session
    try {
      if (!await persistDraft(false, true) || !isCurrent()) return false
      const source = selectedDocumentRef.current!
      const destination = await window.knowbook.getDocumentDetail(toDocumentId)
      if (!isCurrent() || !destination) return false
      const input = { fromDocumentId: source.id, toDocumentId, blockIds: [...target.blockIds],
        expectedFromUpdatedAt: source.updatedAt, expectedToUpdatedAt: destination.updatedAt }
      const { completeDocumentBlockMove } = await import('../utils/blockMoveActions')
      return await completeDocumentBlockMove(input, target.bookmark, getBlockMoveContext(isCurrent))
    } catch (error) {
      if (isCurrent()) onMessage(getErrorMessage(error, '移动失败，请重新打开文档后重试。'), 'error')
      return false
    } finally { blockMoveBusyRef.current = false; if (mountedRef.current) setIsBlockMoveBusy(false) }
  }, [checkpointDraft, clearAutoSaveTimer, getBlockMoveContext, isBlockActionTargetCurrent, onMessage, persistDraft])

  restoreMoveRef.current = async (move, state) => {
    if (blockMoveBusyRef.current || composingDraftRef.current) return false
    const documentId = selectedDocumentIdRef.current, session = editorSessionRef.current
    const focusPermission = captureAsyncHistoryFocusPermission()
    const isCurrent = () => mountedRef.current && selectedDocumentIdRef.current === documentId && editorSessionRef.current === session
    blockMoveBusyRef.current = true
    setIsBlockMoveBusy(true)
    clearAutoSaveTimer()
    try {
      if (!await persistDraft(false, true) || !isCurrent()) return false
      const input = { operationId: move.operationId, expectedUpdatedAtByDocument: { ...move.versions } }
      const { completeDocumentBlockMoveRestore } = await import('../utils/blockMoveActions')
      return await completeDocumentBlockMoveRestore(input, state, getBlockMoveContext(isCurrent))
    } catch (error) {
      if (isCurrent()) onMessage(getErrorMessage(error, '撤销移动失败；不会覆盖后续编辑。'), 'error')
      return false
    } finally {
      pairedHistoryFocusRef.current = focusPermission.canRestore()
      focusPermission.dispose()
      blockMoveBusyRef.current = false
      if (mountedRef.current) setIsBlockMoveBusy(false)
    }
  }

  useEffect(() => {
    if (!isEditing || isReadingModeRef.current || !selectedDocumentId || selectedDocument?.id !== selectedDocumentId
      || typeof window.knowbook.getDocumentBlockMoveHistory !== 'function') return
    const documentId = selectedDocumentId, session = editorSessionRef.current
    let cancelled = false
    void window.knowbook.getDocumentBlockMoveHistory(documentId).then(async entry => {
      if (!entry || cancelled) return
      const { acceptDocumentBlockMoveHistory } = await import('../utils/blockMoveActions')
      acceptDocumentBlockMoveHistory(entry, getBlockMoveContext(() => !cancelled && mountedRef.current
        && selectedDocumentIdRef.current === documentId && editorSessionRef.current === session))
    }).catch(error => console.warn('Failed to read paired block move history.', error))
    return () => { cancelled = true }
  }, [isEditing, selectedDocument?.id, selectedDocument?.updatedAt, selectedDocumentId])

  useLayoutEffect(() => {
    // A second beforeinput can arrive before passive effects run. Publish the
    // pending typing snapshot as soon as its controlled value is committed.
    if (isEditing && !isComposingDraft && !isRestoringHistoryRef.current) {
      scheduleHistorySnapshot(draftBlocksState)
    }
  }, [draftBlocksState, isComposingDraft, isEditing, scheduleHistorySnapshot])

  useEffect(() => {
    if (!isEditing || isComposingDraft || isSaving || isBlockMoveBusy || hasSaveError || !hasPendingDraftChanges || !selectedDocumentId || !selectedDocument) {
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
  }, [clearAutoSaveTimer, draftBlocksState, draftSummary, draftTitle, hasPendingDraftChanges, hasSaveError, isBlockMoveBusy, isComposingDraft, isEditing, isSaving, persistDraft, selectedDocument, selectedDocumentId])

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

  const guardedSetDraftTitle: Dispatch<SetStateAction<string>> = useCallback(value => {
    if (!canonicalInlineInputLocked() && !blockMoveBusyRef.current) setDraftTitle(value)
  }, [])
  const guardedSetDraftSummary: Dispatch<SetStateAction<string>> = useCallback(value => {
    if (!canonicalInlineInputLocked() && !blockMoveBusyRef.current) setDraftSummary(value)
  }, [])

  const getDraftMarkdownExport = useCallback((documentId: string) => {
    if (selectedDocument?.id !== documentId || selectedDocumentIdRef.current !== documentId) return null
    return buildDraftMarkdownExport({ title: draftTitleRef.current, blocks: draftBlocksRef.current })
  }, [selectedDocument?.id])

  const copyDocumentAsMarkdown = useCallback(async () => {
    try {
      const snapshot = selectedDocumentId && getDraftMarkdownExport(selectedDocumentId)
      if (!snapshot) return
      await window.knowbook.writeClipboardText(snapshot.markdown)
      triggerTransientFlash(setMdCopyFlash)
    } catch (error) {
      onMessage(getErrorMessage(error, ui.markdownCopyFailed), 'error')
    }
  }, [getDraftMarkdownExport, onMessage, selectedDocumentId, triggerTransientFlash, ui.markdownCopyFailed])

  const saveDocumentAsMarkdown = useCallback(async () => {
    try {
      const snapshot = selectedDocumentId && getDraftMarkdownExport(selectedDocumentId)
      if (!snapshot) return
      const savedPath = await window.knowbook.saveMarkdownFile(snapshot.fileName, snapshot.markdown)
      if (savedPath) onMessage(ui.markdownExportedPath(savedPath))
    } catch (error) {
      onMessage(getErrorMessage(error, ui.markdownExportFailed), 'error')
    }
  }, [getDraftMarkdownExport, onMessage, selectedDocumentId, ui])

  return {
    canRedo: !isBlockMoveBusy && areDraftBlockSnapshotsEqual(editHistoryRef.current[editHistoryPointerRef.current]?.blocks, draftBlocksState)
      && editHistoryPointerRef.current < Math.min(editHistoryRef.current.length - 1, readingHistoryScopeRef.current?.ceiling ?? Infinity),
    canUndo: !isBlockMoveBusy && editHistoryPointerRef.current >= 0 && (!areDraftBlockSnapshotsEqual(editHistoryRef.current[editHistoryPointerRef.current]?.blocks, draftBlocksState)
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
    getSyncedHostEditorState,
    adoptSyncedHostStructureResult,
    applyOrdinaryMarkdownSource,
    isSyncedHostComposing: () => composingDraftRef.current,
    getDraftMarkdownExport,
    getRenameTarget,
    hasPendingDraftChanges,
    isEditing,
    isSaving: isSaving || isBlockMoveBusy,
    isBlockMoveBusy,
    getBlockActionTarget,
    isBlockActionTargetCurrent,
    moveDraftBlocksToDocument,
    loadDocumentIntoEditor: resetEditorFromDocument,
    mdCopyFlash,
    pushToHistory,
    redoEdit: () => { void redoEdit() },
    renameTitle,
    saveDocument,
    saveDocumentAsMarkdown,
    saveStatus,
    setDraftBlocks,
    setDraftSummary: guardedSetDraftSummary,
    setDraftTitle: guardedSetDraftTitle,
    setIsSaving,
    updateBlockHighlight,
    updateDraftBlock,
    undoEdit: () => { void undoEdit() }
  }
}
