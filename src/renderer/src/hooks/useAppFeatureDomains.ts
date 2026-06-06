import type { DocumentsFeatureState } from '../types/appDomains'
import type { AppShellState } from '../types/appShell'
import { useAiDomain } from './useAiDomain'
import { usePluginsDomain } from './usePluginsDomain'
import { useSettingsDomain } from './useSettingsDomain'

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