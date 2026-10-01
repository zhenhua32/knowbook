import { Suspense, useCallback } from 'react'
import type { CreateDocumentFromTemplateInput, CreateDocumentResult, CreateQuickNoteInput } from '@shared/contracts'
import type { useDocumentCapture } from '../hooks/useDocumentCapture'
import type { DocumentsDomainState } from '../types/appDomains'
import type { AppShellState } from '../types/appShell'
import { lazyWithRetry } from '../utils/lazyWithRetry'
import { getErrorMessage } from '../utils/errorMessage'
import { ErrorBoundary } from './ErrorBoundary'
import QuickCaptureDialog from './QuickCaptureDialog'

const DocumentTemplateDialog = lazyWithRetry(() => import('./DocumentTemplateDialog'))
const SaveDocumentTemplateDialog = lazyWithRetry(() => import('./SaveDocumentTemplateDialog'))

export default function DocumentCaptureHost({ state, documents, shell }: {
  state: ReturnType<typeof useDocumentCapture>; documents: DocumentsDomainState; shell: AppShellState
}) {
  const { capture, closeCapture } = state
  const { isZh } = shell
  const documentTree = shell.homeData.documentTree
  const createAndOpen = useCallback(async (create: () => Promise<CreateDocumentResult>) => {
    if (!await documents.flushPendingChanges()) {
      throw new Error(isZh ? '当前文档保存失败，草稿仍保留。请处理后重试。' : 'The current document could not be saved. Your draft is preserved. Resolve the save error and retry.')
    }
    const { id } = await create()
    documents.setSelectedDocument(null)
    documents.clearEditorSession()
    documents.setDetailLoading(true)
    documents.setSelectedDocumentId(id)
    shell.setActivePage('documents')
    closeCapture()
    try {
      shell.setHomeData(await window.knowbook.getHomeData())
    } catch (error) {
      // Creation has committed. A refresh failure must not offer a duplicate submission.
      shell.notify(getErrorMessage(error, isZh ? '文档已创建，列表刷新失败。' : 'The document was created, but the list could not be refreshed.'), 'warning')
      shell.retryWorkspace()
    }
  }, [closeCapture, documents, shell, isZh])
  const createFromTemplate = useCallback((input: CreateDocumentFromTemplateInput) =>
    createAndOpen(() => window.knowbook.createDocumentFromTemplate(input)), [createAndOpen])
  const saveQuickNote = useCallback((input: CreateQuickNoteInput) =>
    createAndOpen(() => window.knowbook.createQuickNote(input)), [createAndOpen])
  const templateSaved = useCallback(() => {
    closeCapture()
    shell.notify(isZh ? '模板已保存，可从“从模板新建”使用。' : 'Template saved. Use it from New from template.', 'success')
  }, [closeCapture, shell, isZh])
  if (!capture) return null
  return <ErrorBoundary onNavigate={closeCapture} navigateLabel={isZh ? '关闭' : 'Close'}>
    <Suspense fallback={null}>
      {capture.kind === 'templates' && <DocumentTemplateDialog isZh={isZh} documentTree={documentTree}
        initialParentId={capture.parentId} onClose={closeCapture} onCreate={createFromTemplate} />}
      {capture.kind === 'quick' && <QuickCaptureDialog isZh={isZh} documentTree={documentTree}
        onClose={closeCapture} onSave={saveQuickNote} />}
      {capture.kind === 'saveTemplate' && <SaveDocumentTemplateDialog isZh={isZh} source={capture.source}
        onClose={closeCapture} onSaved={templateSaved} />}
    </Suspense>
  </ErrorBoundary>
}
