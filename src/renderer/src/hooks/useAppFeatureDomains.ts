import type { HomeData } from '@shared/contracts'
import type { useAppShellState } from './useAppShellState'
import type { useDocumentsDomainState } from './useDocumentsDomainState'
import { useAiDomain } from './useAiDomain'
import { usePluginsDomain } from './usePluginsDomain'
import { useSettingsDomain } from './useSettingsDomain'

type AppShellState = ReturnType<typeof useAppShellState>

type DocumentsFeatureState = Pick<ReturnType<typeof useDocumentsDomainState>,
  'openDocumentInDocumentsPage'
  | 'selectedDocument'
  | 'selectedDocumentId'
  | 'setDraftSummary'
  | 'setSelectedDocument'
>

type UseAppFeatureDomainsParams = {
  handleBackup: () => Promise<void>
  handleRestoreBackup: () => Promise<void>
  documents: DocumentsFeatureState
  shell: AppShellState
}

export function useAppFeatureDomains({
  handleBackup,
  handleRestoreBackup,
  documents,
  shell
}: UseAppFeatureDomainsParams) {
  const ai = useAiDomain({
    aiConfig: shell.homeData.aiConfig,
    isZh: shell.isZh,
    onDraftSummaryChange: documents.setDraftSummary,
    onHomeDataChange: shell.setHomeData,
    onMessage: shell.setBackupMessage,
    onOpenDocument: documents.openDocumentInDocumentsPage,
    onSelectedDocumentChange: documents.setSelectedDocument,
    selectedDocument: documents.selectedDocument,
    selectedDocumentId: documents.selectedDocumentId,
    ui: shell.ui
  })

  const plugins = usePluginsDomain({
    homeData: shell.homeData,
    onDraftSummaryChange: documents.setDraftSummary,
    onHomeDataChange: shell.setHomeData,
    onMessage: shell.setBackupMessage,
    onSelectedDocumentChange: documents.setSelectedDocument,
    selectedDocument: documents.selectedDocument,
    selectedDocumentId: documents.selectedDocumentId,
    ui: shell.ui
  })

  const {
    sectionProps: settingsSectionProps
  } = useSettingsDomain({
    aiApiKeyDraft: ai.aiApiKeyDraft,
    aiAutoSummaryOnSaveDraft: ai.aiAutoSummaryOnSaveDraft,
    aiBaseUrlDraft: ai.aiBaseUrlDraft,
    aiEmbeddingApiKeyDraft: ai.aiEmbeddingApiKeyDraft,
    aiEmbeddingBaseUrlDraft: ai.aiEmbeddingBaseUrlDraft,
    aiEmbeddingModelDraft: ai.aiEmbeddingModelDraft,
    aiEnabledDraft: ai.aiEnabledDraft,
    aiEndpoint: shell.homeData.aiConfig.baseUrl,
    aiModelDraft: ai.aiModelDraft,
    aiSaving: ai.aiSaving,
    isSettingsPage: shell.activePage === 'settings',
    isZh: shell.isZh,
    loading: shell.loading,
    onAiApiKeyChange: ai.setAiApiKeyDraft,
    onAiAutoSummaryOnSaveChange: ai.setAiAutoSummaryOnSaveDraft,
    onAiBaseUrlChange: ai.setAiBaseUrlDraft,
    onAiEmbeddingApiKeyChange: ai.setAiEmbeddingApiKeyDraft,
    onAiEmbeddingBaseUrlChange: ai.setAiEmbeddingBaseUrlDraft,
    onAiEmbeddingModelChange: ai.setAiEmbeddingModelDraft,
    onAiEnabledChange: ai.setAiEnabledDraft,
    onAiModelChange: ai.setAiModelDraft,
    onBackupNow: () => {
      void handleBackup()
    },
    onMessage: (message) => shell.setBackupMessage(message),
    onOpenDocument: documents.openDocumentInDocumentsPage,
    onOpenPlugins: () => {
      shell.setActivePage('plugins')
    },
    onRestoreBackup: () => {
      void handleRestoreBackup()
    },
    onSaveAiConfig: () => {
      void ai.saveAiConfig()
    },
    onUiLanguageChange: shell.setUiLanguage,
    recentDocuments: shell.homeData.recentDocuments,
    summary: shell.homeData.summary,
    ui: shell.ui,
    uiLanguage: shell.uiLanguage
  })

  return {
    ai,
    plugins,
    settingsSectionProps
  }
}