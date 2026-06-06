import { useCallback, useState } from 'react'
import { getBoardDropFieldValue, type BoardDropTarget } from '@shared/board'
import type {
  ClipWebPageInput,
  DocumentCatalogEntry,
  DocumentDatabaseColumn,
  DocumentDatabaseFieldValue,
  DocumentDetail,
  HomeData
} from '@shared/contracts'
import type { UiText } from '../i18n'
import { buildDocumentMarkdown, getDocumentMarkdownFileName } from '../utils/documentMarkdown'

type UseWorkspaceDocumentManagementParams = {
  catalogColumns: DocumentDatabaseColumn[]
  catalogDocuments: DocumentCatalogEntry[]
  moveTargetId: string
  selectedDocument: DocumentDetail | null
  selectedDocumentId: string | null
  ui: UiText
  onCancelPendingAutoSave: () => void
  onClearEditorSession: () => void
  onDetailLoadingChange: (loading: boolean) => void
  onHomeDataChange: (homeData: HomeData) => void
  onMessage: (message: string) => void
  onMoveTargetIdChange: (value: string) => void
  onSelectedDocumentChange: (detail: DocumentDetail | null) => void
  onSelectedDocumentIdChange: (documentId: string | null) => void
  onUpdateDocumentDatabaseValue: (documentId: string, columnId: string, value: DocumentDatabaseFieldValue) => Promise<void>
}

export function useWorkspaceDocumentManagement({
  catalogColumns,
  catalogDocuments,
  moveTargetId,
  selectedDocument,
  selectedDocumentId,
  ui,
  onCancelPendingAutoSave,
  onClearEditorSession,
  onDetailLoadingChange,
  onHomeDataChange,
  onMessage,
  onMoveTargetIdChange,
  onSelectedDocumentChange,
  onSelectedDocumentIdChange,
  onUpdateDocumentDatabaseValue
}: UseWorkspaceDocumentManagementParams) {
  const [draggingDocumentId, setDraggingDocumentId] = useState<string | null>(null)
  const [dragOverBoardColumnId, setDragOverBoardColumnId] = useState<string | null>(null)
  const [dragOverRoot, setDragOverRoot] = useState(false)

  const getDocumentDetailForAction = useCallback(async (documentId: string) => {
    const detail = await window.knowbook.getDocumentDetail(documentId)
    if (!detail) {
      throw new Error('Document not found')
    }

    return detail
  }, [])

  const refreshSelectionAfterDocumentMutation = useCallback(async (refreshedHome: HomeData, deletedDocumentId?: string) => {
    if (selectedDocumentId && selectedDocumentId !== deletedDocumentId) {
      const refreshedDetail = await window.knowbook.getDocumentDetail(selectedDocumentId)
      onSelectedDocumentChange(refreshedDetail)
      return
    }

    if (selectedDocumentId === deletedDocumentId) {
      const nextId = refreshedHome.initialDocumentId
      onMoveTargetIdChange('')
      onSelectedDocumentChange(null)
      onSelectedDocumentIdChange(nextId)
      onClearEditorSession()

      if (nextId) {
        onDetailLoadingChange(true)
      }
    }
  }, [onClearEditorSession, onDetailLoadingChange, onMoveTargetIdChange, onSelectedDocumentChange, onSelectedDocumentIdChange, selectedDocumentId])

  const endDrag = useCallback(() => {
    setDraggingDocumentId(null)
    setDragOverBoardColumnId(null)
    setDragOverRoot(false)
  }, [])

  const handleMoveDocument = useCallback(async (documentId: string, newParentId: string | null, successMessage?: string) => {
    try {
      await window.knowbook.moveDocument(documentId, newParentId)
      const refreshedHome = await window.knowbook.getHomeData()
      onHomeDataChange(refreshedHome)

      if (selectedDocumentId) {
        const refreshedDetail = await window.knowbook.getDocumentDetail(selectedDocumentId)
        onSelectedDocumentChange(refreshedDetail)
      }

      onMoveTargetIdChange('')
      if (successMessage) {
        onMessage(successMessage)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.moveFailed
      onMessage(message)
    } finally {
      endDrag()
    }
  }, [endDrag, onHomeDataChange, onMessage, onMoveTargetIdChange, onSelectedDocumentChange, selectedDocumentId, ui.moveFailed])

  const handleCreateDocument = useCallback(async (parentId: string | null) => {
    onCancelPendingAutoSave()
    const created = await window.knowbook.createDocument(parentId)
    const refreshed = await window.knowbook.getHomeData()
    onHomeDataChange(refreshed)
    onSelectedDocumentChange(null)
    onClearEditorSession()
    onDetailLoadingChange(true)
    onSelectedDocumentIdChange(created.id)
  }, [onCancelPendingAutoSave, onClearEditorSession, onDetailLoadingChange, onHomeDataChange, onSelectedDocumentChange, onSelectedDocumentIdChange])

  const handleClipWebPage = useCallback(async (input: ClipWebPageInput) => {
    try {
      onCancelPendingAutoSave()
      const clipped = await window.knowbook.clipWebPage(input)
      const refreshed = await window.knowbook.getHomeData()
      onHomeDataChange(refreshed)
      onSelectedDocumentChange(null)
      onClearEditorSession()
      onDetailLoadingChange(true)
      onMoveTargetIdChange('')
      onSelectedDocumentIdChange(clipped.documentId)
      onMessage(
        clipped.created
          ? (clipped.warnings.length > 0 ? ui.webClipImportedWithWarnings(clipped.title, clipped.warnings.length) : ui.webClipImported(clipped.title))
          : ui.webClipOpenedExisting(clipped.title)
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.webClipFailed
      onMessage(message)
      throw error
    }
  }, [onCancelPendingAutoSave, onClearEditorSession, onDetailLoadingChange, onHomeDataChange, onMessage, onMoveTargetIdChange, onSelectedDocumentChange, onSelectedDocumentIdChange, ui])

  const deleteDocumentById = useCallback(async (documentId: string, documentTitle: string) => {
    const accepted = window.confirm(ui.confirmDeleteDocument(documentTitle))
    if (!accepted) {
      return
    }

    if (selectedDocumentId === documentId) {
      onCancelPendingAutoSave()
    }

    await window.knowbook.deleteDocument(documentId)
    const refreshed = await window.knowbook.getHomeData()
    onHomeDataChange(refreshed)
    await refreshSelectionAfterDocumentMutation(refreshed, documentId)
  }, [onCancelPendingAutoSave, onHomeDataChange, refreshSelectionAfterDocumentMutation, selectedDocumentId, ui])

  const deleteSelectedDocument = useCallback(async () => {
    if (!selectedDocument) {
      return
    }

    await deleteDocumentById(selectedDocument.id, selectedDocument.title)
  }, [deleteDocumentById, selectedDocument])

  const copyDocumentMarkdown = useCallback(async (documentId: string) => {
    try {
      const detail = await getDocumentDetailForAction(documentId)
      await window.knowbook.writeClipboardText(buildDocumentMarkdown(detail))
      onMessage(ui.markdownCopied)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Document not found'
      onMessage(message)
    }
  }, [getDocumentDetailForAction, onMessage, ui.markdownCopied])

  const exportDocumentMarkdown = useCallback(async (documentId: string) => {
    try {
      const detail = await getDocumentDetailForAction(documentId)
      const savedPath = await window.knowbook.saveMarkdownFile(
        getDocumentMarkdownFileName(detail),
        buildDocumentMarkdown(detail)
      )

      if (savedPath) {
        onMessage(ui.markdownExportedPath(savedPath))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Document not found'
      onMessage(message)
    }
  }, [getDocumentDetailForAction, onMessage, ui])

  const moveSelectedDocument = useCallback(async () => {
    if (!selectedDocument || !moveTargetId) {
      return
    }

    const newParentId = moveTargetId === '__root__' ? null : moveTargetId
    await handleMoveDocument(selectedDocument.id, newParentId, ui.movedDocumentSuccess(selectedDocument.title))
  }, [handleMoveDocument, moveTargetId, selectedDocument, ui])

  const beginDrag = useCallback((documentId: string) => {
    setDraggingDocumentId(documentId)
  }, [])

  const dropOnDocument = useCallback(async (targetId: string) => {
    if (!draggingDocumentId || draggingDocumentId === targetId) {
      endDrag()
      return
    }

    await handleMoveDocument(draggingDocumentId, targetId)
  }, [draggingDocumentId, endDrag, handleMoveDocument])

  const dropToRoot = useCallback(async () => {
    if (!draggingDocumentId) {
      endDrag()
      return
    }

    await handleMoveDocument(draggingDocumentId, null)
  }, [draggingDocumentId, endDrag, handleMoveDocument])

  const dropOnBoardColumn = useCallback(async (parentId: string | null) => {
    if (!draggingDocumentId) {
      endDrag()
      return
    }

    const draggingDocument = catalogDocuments.find((document) => document.id === draggingDocumentId)
    if (draggingDocument && (draggingDocument.parentId ?? null) === parentId) {
      endDrag()
      return
    }

    await handleMoveDocument(draggingDocumentId, parentId)
  }, [catalogDocuments, draggingDocumentId, endDrag, handleMoveDocument])

  const dropOnBoardTarget = useCallback(async (target: BoardDropTarget) => {
    if (!draggingDocumentId) {
      endDrag()
      return
    }

    const draggingDocument = catalogDocuments.find((document) => document.id === draggingDocumentId)
    if (!draggingDocument) {
      endDrag()
      return
    }

    if (target.kind === 'parent') {
      await dropOnBoardColumn(target.parentId)
      return
    }

    const targetColumn = catalogColumns.find((column) => column.id === target.columnId)
    if (!targetColumn) {
      endDrag()
      return
    }

    const nextFieldValue = getBoardDropFieldValue(
      targetColumn,
      draggingDocument.fieldValues[target.columnId] ?? null,
      target.value
    )

    if (nextFieldValue === undefined) {
      endDrag()
      return
    }

    await onUpdateDocumentDatabaseValue(draggingDocumentId, target.columnId, nextFieldValue)
    endDrag()
  }, [catalogColumns, catalogDocuments, draggingDocumentId, dropOnBoardColumn, endDrag, onUpdateDocumentDatabaseValue])

  const handleRootDragOver = useCallback(() => {
    if (draggingDocumentId) {
      setDragOverRoot(true)
    }
  }, [draggingDocumentId])

  const handleRootDragLeave = useCallback(() => {
    setDragOverRoot(false)
  }, [])

  const handleTreeNodeDragOver = useCallback((documentId: string) => {
    if (draggingDocumentId && draggingDocumentId !== documentId) {
      setDragOverRoot(false)
    }
  }, [draggingDocumentId])

  const handleBoardColumnDragOver = useCallback((columnId: string) => {
    if (draggingDocumentId) {
      setDragOverBoardColumnId(columnId)
      setDragOverRoot(false)
    }
  }, [draggingDocumentId])

  return {
    beginDrag,
    copyDocumentMarkdown,
    deleteDocumentById,
    deleteSelectedDocument,
    dragOverBoardColumnId,
    dragOverRoot,
    draggingDocumentId,
    dropOnBoardTarget,
    dropOnDocument,
    dropToRoot,
    endDrag,
    exportDocumentMarkdown,
    handleBoardColumnDragOver,
    handleClipWebPage,
    handleCreateDocument,
    handleRootDragLeave,
    handleRootDragOver,
    handleTreeNodeDragOver,
    moveSelectedDocument
  }
}