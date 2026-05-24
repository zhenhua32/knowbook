import { useCallback, useState } from 'react'
import { getBoardDropFieldValue, type BoardDropTarget } from '@shared/board'
import type {
  DocumentCatalogEntry,
  DocumentDatabaseColumn,
  DocumentDatabaseFieldValue,
  DocumentDetail,
  HomeData
} from '@shared/contracts'
import type { UiText } from '../i18n'

type UseWorkspaceDocumentManagementParams = {
  catalogColumns: DocumentDatabaseColumn[]
  catalogDocuments: DocumentCatalogEntry[]
  moveTargetId: string
  selectedDocument: DocumentDetail | null
  selectedDocumentId: string | null
  ui: UiText
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
    const created = await window.knowbook.createDocument(parentId)
    const refreshed = await window.knowbook.getHomeData()
    onHomeDataChange(refreshed)
    onSelectedDocumentChange(null)
    onClearEditorSession()
    onDetailLoadingChange(true)
    onSelectedDocumentIdChange(created.id)
  }, [onClearEditorSession, onDetailLoadingChange, onHomeDataChange, onSelectedDocumentChange, onSelectedDocumentIdChange])

  const deleteSelectedDocument = useCallback(async () => {
    if (!selectedDocument) {
      return
    }

    const accepted = window.confirm(ui.confirmDeleteDocument(selectedDocument.title))
    if (!accepted) {
      return
    }

    await window.knowbook.deleteDocument(selectedDocument.id)
    const refreshed = await window.knowbook.getHomeData()
    onHomeDataChange(refreshed)

    const nextId = refreshed.initialDocumentId
    onSelectedDocumentChange(null)
    onSelectedDocumentIdChange(nextId)
    onClearEditorSession()

    if (nextId) {
      onDetailLoadingChange(true)
    }
  }, [onClearEditorSession, onDetailLoadingChange, onHomeDataChange, onSelectedDocumentChange, onSelectedDocumentIdChange, selectedDocument, ui])

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
    deleteSelectedDocument,
    dragOverBoardColumnId,
    dragOverRoot,
    draggingDocumentId,
    dropOnBoardTarget,
    dropOnDocument,
    dropToRoot,
    endDrag,
    handleBoardColumnDragOver,
    handleCreateDocument,
    handleRootDragLeave,
    handleRootDragOver,
    handleTreeNodeDragOver,
    moveSelectedDocument
  }
}