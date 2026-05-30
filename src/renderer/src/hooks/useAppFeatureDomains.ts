import type { HomeData } from '@shared/contracts'
import type { UiLanguage, UiText } from '../i18n'
import type { useAppShellState } from './useAppShellState'
import type { useDocumentsDomainState } from './useDocumentsDomainState'
import type { PageId } from './useAppShellState'
import { useAiDomain } from './useAiDomain'
import { usePluginsDomain } from './usePluginsDomain'
import { useSettingsDomain } from './useSettingsDomain'

type ShellFeatureState = Pick<ReturnType<typeof useAppShellState>,
  'setActivePage'
  | 'setBackupMessage'
  | 'setHomeData'
  | 'setUiLanguage'
>

type DocumentsFeatureState = Pick<ReturnType<typeof useDocumentsDomainState>,
  'openDocumentInDocumentsPage'
  | 'selectedDocument'
  | 'selectedDocumentId'
  | 'setDraftSummary'
  | 'setSelectedDocument'
>

type UseAppFeatureDomainsParams = {
  activePage: PageId
  handleBackup: () => Promise<void>
  handleRestoreBackup: () => Promise<void>
  homeData: HomeData
  isZh: boolean
  loading: boolean
  documents: DocumentsFeatureState
  shell: ShellFeatureState
  ui: UiText
  uiLanguage: UiLanguage
}

export function useAppFeatureDomains({
  activePage,
  handleBackup,
  handleRestoreBackup,
  homeData,
  isZh,
  loading,
  documents,
  shell,
  ui,
  uiLanguage
}: UseAppFeatureDomainsParams) {
  const ai = useAiDomain({
    aiConfig: homeData.aiConfig,
    isZh,
    onDraftSummaryChange: documents.setDraftSummary,
    onHomeDataChange: shell.setHomeData,
    onMessage: shell.setBackupMessage,
    onOpenDocument: documents.openDocumentInDocumentsPage,
    onSelectedDocumentChange: documents.setSelectedDocument,
    selectedDocument: documents.selectedDocument,
    selectedDocumentId: documents.selectedDocumentId,
    ui
  })

  const plugins = usePluginsDomain({
    homeData,
    onDraftSummaryChange: documents.setDraftSummary,
    onHomeDataChange: shell.setHomeData,
    onMessage: shell.setBackupMessage,
    onSelectedDocumentChange: documents.setSelectedDocument,
    selectedDocument: documents.selectedDocument,
    selectedDocumentId: documents.selectedDocumentId,
    ui
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
    aiEndpoint: homeData.aiConfig.baseUrl,
    aiModelDraft: ai.aiModelDraft,
    aiSaving: ai.aiSaving,
    isSettingsPage: activePage === 'settings',
    isZh,
    loading,
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
    recentDocuments: homeData.recentDocuments,
    summary: homeData.summary,
    ui,
    uiLanguage
  })

  return {
    ai,
    plugins,
    settingsSectionProps
  }
}