import type { Dispatch, SetStateAction } from 'react'
import type { DocumentDetail, HomeData } from '@shared/contracts'
import type { UiLanguage, UiText } from '../i18n'
import type { PageId } from './useAppShellState'
import { useAiDomain } from './useAiDomain'
import { usePluginsDomain } from './usePluginsDomain'
import { useSettingsDomain } from './useSettingsDomain'

type UseAppFeatureDomainsParams = {
  activePage: PageId
  handleBackup: () => Promise<void>
  handleRestoreBackup: () => Promise<void>
  homeData: HomeData
  isZh: boolean
  loading: boolean
  onHomeDataChange: Dispatch<SetStateAction<HomeData>>
  onMessage: (message: string | null) => void
  onOpenDocument: (documentId: string) => void
  onSelectedDocumentChange: Dispatch<SetStateAction<DocumentDetail | null>>
  onSetActivePage: Dispatch<SetStateAction<PageId>>
  onUiLanguageChange: (language: UiLanguage) => void
  selectedDocument: DocumentDetail | null
  selectedDocumentId: string | null
  setDraftSummary: Dispatch<SetStateAction<string>>
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
  onHomeDataChange,
  onMessage,
  onOpenDocument,
  onSelectedDocumentChange,
  onSetActivePage,
  onUiLanguageChange,
  selectedDocument,
  selectedDocumentId,
  setDraftSummary,
  ui,
  uiLanguage
}: UseAppFeatureDomainsParams) {
  const ai = useAiDomain({
    aiConfig: homeData.aiConfig,
    isZh,
    onDraftSummaryChange: setDraftSummary,
    onHomeDataChange,
    onMessage,
    onOpenDocument,
    onSelectedDocumentChange,
    selectedDocument,
    selectedDocumentId,
    ui
  })

  const plugins = usePluginsDomain({
    homeData,
    onDraftSummaryChange: setDraftSummary,
    onHomeDataChange,
    onMessage,
    onSelectedDocumentChange,
    selectedDocument,
    selectedDocumentId,
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
    onMessage: (message) => onMessage(message),
    onOpenDocument,
    onOpenPlugins: () => {
      onSetActivePage('plugins')
    },
    onRestoreBackup: () => {
      void handleRestoreBackup()
    },
    onSaveAiConfig: () => {
      void ai.saveAiConfig()
    },
    onUiLanguageChange,
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