import type { DocumentsFeatureState } from '../types/appDomains'
import type { AppShellState } from '../types/appShell'
import { useRef } from 'react'
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
  const activePageRef = useRef(shell.activePage)
  activePageRef.current = shell.activePage
  const ai = useAiDomain({
    aiConfig: shell.homeData.aiConfig,
    documentOptions: shell.homeData.documentCatalog,
    contextDocumentId: documents.selectedDocumentId,
    contextDocumentLoading: documents.detailLoading,
    isZh: shell.isZh,
    onDraftSummaryChange: documents.setDraftSummary,
    onHomeDataChange: shell.setHomeData,
    onMessage: shell.notify,
    onOpenDocument: documents.openDocumentInDocumentsPage,
    onSelectContextDocument: (id) => { void documents.selectDocumentContext(id, () => activePageRef.current === 'ai') },
    onOpenAiSettings: shell.openAiSettings,
    onSelectedDocumentChange: documents.setSelectedDocument,
    selectedDocument: !documents.detailLoading && documents.selectedDocument?.id === documents.selectedDocumentId ? documents.selectedDocument : null,
    selectedDocumentId: documents.selectedDocumentId,
    ui: shell.ui
  })

  const plugins = usePluginsDomain({
    homeData: shell.homeData,
    onDraftSummaryChange: documents.setDraftSummary,
    onHomeDataChange: shell.setHomeData,
    onMessage: shell.notify,
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
     aiRelatedNotesEnabledDraft: ai.aiRelatedNotesEnabledDraft,
     aiEndpoint: shell.homeData.aiConfig.baseUrl,
    aiModelDraft: ai.aiModelDraft,
    aiSaving: ai.aiSaving,
    aiClearingApiKey: ai.aiClearingApiKey,
    aiSaveError: ai.aiSaveError,
    isSettingsPage: shell.activePage === 'settings',
    isZh: shell.isZh,
    loading: shell.loading,
    onAiApiKeyChange: ai.setAiApiKeyDraft,
    onClearAiApiKey: () => {
      void ai.clearAiApiKey()
    },
    onAiAutoSummaryOnSaveChange: ai.setAiAutoSummaryOnSaveDraft,
    onAiBaseUrlChange: ai.setAiBaseUrlDraft,
     onAiEnabledChange: ai.setAiEnabledDraft,
     onAiModelChange: ai.setAiModelDraft,
     onAiRelatedNotesEnabledChange: ai.setAiRelatedNotesEnabledDraft,
    onBackupNow: () => {
      void handleBackup()
    },
    onMessage: shell.notify,
    onOpenDocument: documents.openDocumentInDocumentsPage,
    onOpenPlugins: () => {
      shell.setActivePage('plugins')
    },
    onRestoreBackup: () => {
      void handleRestoreBackup()
    },
    onSaveAiConfig: ai.saveAiConfig,
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
