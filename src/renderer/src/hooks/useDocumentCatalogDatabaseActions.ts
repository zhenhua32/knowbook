import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentCatalogEntry, DocumentDatabaseFieldValue } from '@shared/contracts'

type UseDocumentCatalogDatabaseActionsParams = {
  setBackupMessage: (message: string | null) => void
  setCatalogDocuments: Dispatch<SetStateAction<DocumentCatalogEntry[]>>
}

export function useDocumentCatalogDatabaseActions({
  setBackupMessage,
  setCatalogDocuments
}: UseDocumentCatalogDatabaseActionsParams) {
  const updateDocumentDatabaseValue = useCallback(async (documentId: string, columnId: string, value: DocumentDatabaseFieldValue) => {
    let previousFieldValue: DocumentDatabaseFieldValue | undefined

    setCatalogDocuments((previous) => {
      const nextState = setDocumentCatalogFieldValue(previous, documentId, columnId, value)
      previousFieldValue = nextState.previousValue
      return nextState.entries
    })
    try {
      await window.knowbook.updateDocumentDatabaseValue({ documentId, columnId, value })
    } catch (error) {
      setCatalogDocuments((previous) => restoreDocumentCatalogFieldValue(previous, documentId, columnId, previousFieldValue))
      const message = error instanceof Error ? error.message : 'Failed to update database value.'
      setBackupMessage(message)
    }
  }, [setBackupMessage, setCatalogDocuments])

  return {
    updateDocumentDatabaseValue
  }
}

function setDocumentCatalogFieldValue(
  entries: DocumentCatalogEntry[],
  documentId: string,
  columnId: string,
  value: DocumentDatabaseFieldValue
): { entries: DocumentCatalogEntry[]; previousValue: DocumentDatabaseFieldValue | undefined } {
  let previousValue: DocumentDatabaseFieldValue | undefined

  return {
    entries: entries.map((entry) => {
      if (entry.id !== documentId) {
        return entry
      }

      previousValue = entry.fieldValues[columnId]
      return {
        ...entry,
        fieldValues: {
          ...entry.fieldValues,
          [columnId]: value
        }
      }
    }),
    previousValue
  }
}

function restoreDocumentCatalogFieldValue(
  entries: DocumentCatalogEntry[],
  documentId: string,
  columnId: string,
  previousValue: DocumentDatabaseFieldValue | undefined
): DocumentCatalogEntry[] {
  return entries.map((entry) => {
    if (entry.id !== documentId) {
      return entry
    }

    const nextFieldValues = { ...entry.fieldValues }
    if (previousValue === undefined) {
      delete nextFieldValues[columnId]
    } else {
      nextFieldValues[columnId] = previousValue
    }

    return {
      ...entry,
      fieldValues: nextFieldValues
    }
  })
}
