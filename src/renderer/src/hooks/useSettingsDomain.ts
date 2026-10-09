import type { AppMessageHandler } from '../notify'
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
  aiClearingApiKey: boolean
  aiSaveError: string
  aiSettingsDirty: boolean
  onResetAiSettingsDraft: () => void
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
  onMessage: AppMessageHandler
  onOpenDocument: (documentId: string) => void
  onOpenPlugins: () => void
  onRestoreBackup: () => void
  onSaveAiConfig: () => void | Promise<void>
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
  aiClearingApiKey,
  aiSaveError,
  aiSettingsDirty,
  onResetAiSettingsDraft,
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
    aiClearingApiKey,
    aiSaveError,
    aiSettingsDirty,
    onResetAiSettingsDraft,
    appUpdateRefreshing: settingsState.appUpdateRefreshing,
    appUpdateState: settingsState.appUpdateState,
    appUpdateLoading: settingsState.appUpdateLoading,
    appUpdateLoadError: settingsState.appUpdateLoadError,
    appUpdateCheckError: settingsState.appUpdateCheckError,
    appUpdateCanCheck: settingsState.appUpdateCanCheck,
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
    onCheckForAppUpdates: settingsState.checkForAppUpdates,
    onReloadAppUpdateState: settingsState.reloadAppUpdateState,
    onInstallAppUpdate: () => {
      void settingsState.installAppUpdate()
    },
    onCopyWebClipBridgeEndpoint: settingsState.copyWebClipBridgeEndpoint,
    onCopyWebClipBridgeToken: settingsState.copyWebClipBridgeToken,
    onOpenDocument,
    onOpenPlugins,
    onRestoreBackup,
    onSaveAiConfig,
    onRegenerateWebClipBridgeToken: () => settingsState.saveWebClipBridgeSettings(true),
    onSaveWebClipBridgeSettings: () => settingsState.saveWebClipBridgeSettings(false),
    onReloadWebClipBridgeStatus: settingsState.reloadWebClipBridgeStatus,
    onUiLanguageChange,
    recentDocuments,
    summary,
    ui,
    uiLanguage,
    webClipBridgeEnabledDraft: settingsState.webClipBridgeEnabledDraft,
    webClipBridgePortDraft: settingsState.webClipBridgePortDraft,
    webClipBridgePortError: settingsState.webClipBridgePortError,
    webClipBridgeSaving: settingsState.webClipBridgeSaving,
    webClipBridgeRegenerating: settingsState.webClipBridgeRegenerating,
    webClipBridgeCopying: settingsState.webClipBridgeCopying,
    webClipBridgeActionError: settingsState.webClipBridgeActionError,
    webClipBridgeLoading: settingsState.webClipBridgeLoading,
    webClipBridgeLoadError: settingsState.webClipBridgeLoadError,
    webClipBridgeStatus: settingsState.webClipBridgeStatus,
    onWebClipBridgeEnabledChange: settingsState.setWebClipBridgeEnabledDraft,
    onWebClipBridgePortChange: settingsState.setWebClipBridgePortDraft
  }

  return {
    ...settingsState,
    sectionProps
  }
}
