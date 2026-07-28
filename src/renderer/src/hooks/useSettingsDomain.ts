import type { ComponentProps } from 'react'
import type { RecentDocument, WorkspaceSummary } from '@shared/contracts'
import type { UiLanguage, UiText } from '../i18n'
import { DashboardSettingsSection } from '../sections/DashboardSettingsSection'
import { useSettingsState } from './useSettingsState'

type DashboardSettingsSectionProps = ComponentProps<typeof DashboardSettingsSection>

type UseSettingsDomainParams = {
  aiApiKeyDraft: string
  aiAutoSummaryOnSaveDraft: boolean
  aiBaseUrlDraft: string
  aiEnabledDraft: boolean
  aiRelatedNotesEnabledDraft: boolean
  aiEndpoint: string
  aiModelDraft: string
  aiSaving: boolean
  isSettingsPage: boolean
  isZh: boolean
  loading: boolean
  onAiApiKeyChange: (value: string) => void
  onClearAiApiKey: () => void
  onAiAutoSummaryOnSaveChange: (value: boolean) => void
  onAiBaseUrlChange: (value: string) => void
  onAiEnabledChange: (value: boolean) => void
  onAiModelChange: (value: string) => void
  onAiRelatedNotesEnabledChange: (value: boolean) => void
  onBackupNow: () => void
  onMessage: (message: string) => void
  onOpenDocument: (documentId: string) => void
  onOpenPlugins: () => void
  onRestoreBackup: () => void
  onSaveAiConfig: () => void
  onUiLanguageChange: (language: UiLanguage) => void
  recentDocuments: RecentDocument[]
  summary: WorkspaceSummary
  ui: UiText
  uiLanguage: UiLanguage
}

export function useSettingsDomain({
  aiApiKeyDraft,
  aiAutoSummaryOnSaveDraft,
  aiBaseUrlDraft,
  aiEnabledDraft,
  aiRelatedNotesEnabledDraft,
  aiEndpoint,
  aiModelDraft,
  aiSaving,
  isSettingsPage,
  isZh,
  loading,
  onAiApiKeyChange,
  onClearAiApiKey,
  onAiAutoSummaryOnSaveChange,
  onAiBaseUrlChange,
  onAiEnabledChange,
  onAiModelChange,
  onAiRelatedNotesEnabledChange,
  onBackupNow,
  onMessage,
  onOpenDocument,
  onOpenPlugins,
  onRestoreBackup,
  onSaveAiConfig,
  onUiLanguageChange,
  recentDocuments,
  summary,
  ui,
  uiLanguage
}: UseSettingsDomainParams) {
  const settingsState = useSettingsState({
    isSettingsPageActive: isSettingsPage,
    ui,
    onMessage
  })

  const sectionProps: DashboardSettingsSectionProps = {
    aiApiKeyDraft,
    aiAutoSummaryOnSaveDraft,
    aiBaseUrlDraft,
    aiEnabledDraft,
    aiRelatedNotesEnabledDraft,
    aiEndpoint,
    aiModelDraft,
    aiSaving,
    appUpdateRefreshing: settingsState.appUpdateRefreshing,
    appUpdateState: settingsState.appUpdateState,
    isSettingsPage,
    isZh,
    loading,
    onAiApiKeyChange,
    onClearAiApiKey,
    onAiAutoSummaryOnSaveChange,
    onAiBaseUrlChange,
    onAiEnabledChange,
    onAiRelatedNotesEnabledChange,
    onAiModelChange,
    onBackupNow,
    onCheckForAppUpdates: () => {
      void settingsState.checkForAppUpdates()
    },
    onInstallAppUpdate: () => {
      void settingsState.installAppUpdate()
    },
    onCopyWebClipBridgeEndpoint: () => {
      void settingsState.copyWebClipBridgeEndpoint()
    },
    onCopyWebClipBridgeToken: () => {
      void settingsState.copyWebClipBridgeToken()
    },
    onOpenDocument,
    onOpenPlugins,
    onRestoreBackup,
    onSaveAiConfig,
    onRegenerateWebClipBridgeToken: () => {
      void settingsState.saveWebClipBridgeSettings(true)
    },
    onSaveWebClipBridgeSettings: () => {
      void settingsState.saveWebClipBridgeSettings(false)
    },
    onUiLanguageChange,
    recentDocuments,
    summary,
    ui,
    uiLanguage,
    webClipBridgeEnabledDraft: settingsState.webClipBridgeEnabledDraft,
    webClipBridgePortDraft: settingsState.webClipBridgePortDraft,
    webClipBridgeSaving: settingsState.webClipBridgeSaving,
    webClipBridgeStatus: settingsState.webClipBridgeStatus,
    onWebClipBridgeEnabledChange: settingsState.setWebClipBridgeEnabledDraft,
    onWebClipBridgePortChange: settingsState.setWebClipBridgePortDraft
  }

  return {
    ...settingsState,
    sectionProps
  }
}
