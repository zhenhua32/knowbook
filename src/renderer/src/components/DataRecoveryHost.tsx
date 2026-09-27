import DataRecoveryDialog, { type DataRecoveryTarget } from './DataRecoveryDialog'
import type { DocumentsDomainState } from '../types/appDomains'
import type { AppShellState } from '../types/appShell'

export default function DataRecoveryHost({ target, onClose, documents, shell, reloadDatabase }: {
  target: DataRecoveryTarget
  onClose: () => void
  documents: DocumentsDomainState
  shell: AppShellState
  reloadDatabase: () => void
}) {
  const refresh = async (documentId?: string) => {
    documents.cancelPendingAutoSave()
    documents.clearEditorSession()
    documents.setSelectedDocument(null)
    const home = await window.knowbook.getHomeData()
    shell.setHomeData(home)
    reloadDatabase()
    const selectedId = documentId ?? documents.selectedDocumentId
    const nextId = home.documentCatalog.some((document) => document.id === selectedId) ? selectedId : home.initialDocumentId
    documents.setSelectedDocumentId(nextId)
    documents.retryDocumentLoad()
    if (documentId) shell.setActivePage('documents')
  }
  return <DataRecoveryDialog target={target} isZh={shell.isZh} onClose={onClose}
    beforeRestore={documents.flushPendingChanges} onRestored={refresh} />
}
