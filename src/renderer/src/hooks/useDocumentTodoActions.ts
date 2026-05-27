import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentDetail, HomeData } from '@shared/contracts'
import { toDraftBlock } from '../utils/draftBlockShape'

type UseDocumentTodoActionsParams = {
  selectedDocument: DocumentDetail | null
  setBackupMessage: (message: string | null) => void
  setHomeData: Dispatch<SetStateAction<HomeData>>
  setIsSaving: Dispatch<SetStateAction<boolean>>
  setSelectedDocument: Dispatch<SetStateAction<DocumentDetail | null>>
  todoUpdateFailedMessage: string
}

export function useDocumentTodoActions({
  selectedDocument,
  setBackupMessage,
  setHomeData,
  setIsSaving,
  setSelectedDocument,
  todoUpdateFailedMessage
}: UseDocumentTodoActionsParams) {
  const toggleTodoBlockChecked = useCallback(async (index: number, checked: boolean) => {
    if (!selectedDocument) {
      return
    }

    setIsSaving(true)

    try {
      const nextBlocks = selectedDocument.blocks.map((block, currentIndex) =>
        currentIndex === index
          ? {
              ...block,
              checked
            }
          : block
      )

      await window.knowbook.updateDocument(selectedDocument.id, {
        title: selectedDocument.title,
        summary: selectedDocument.summary,
        blocks: nextBlocks.map(toDraftBlock)
      })

      const [refreshedHome, refreshedDetail] = await Promise.all([
        window.knowbook.getHomeData(),
        window.knowbook.getDocumentDetail(selectedDocument.id)
      ])
      setHomeData(refreshedHome)
      setSelectedDocument(refreshedDetail)
    } catch (error) {
      const message = error instanceof Error ? error.message : todoUpdateFailedMessage
      setBackupMessage(message)
    } finally {
      setIsSaving(false)
    }
  }, [selectedDocument, setBackupMessage, setHomeData, setIsSaving, setSelectedDocument, todoUpdateFailedMessage])

  return {
    toggleTodoBlockChecked
  }
}