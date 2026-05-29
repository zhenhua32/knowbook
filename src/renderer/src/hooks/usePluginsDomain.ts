import type { ComponentProps, Dispatch, SetStateAction } from 'react'
import type { DocumentDetail, HomeData } from '@shared/contracts'
import type { UiText } from '../i18n'
import { PluginsSection } from '../sections/PluginsSection'
import { usePluginManagement } from './usePluginManagement'

type PluginsSectionProps = ComponentProps<typeof PluginsSection>

type UsePluginsDomainParams = {
  homeData: HomeData
  onDraftSummaryChange: Dispatch<SetStateAction<string>>
  onHomeDataChange: Dispatch<SetStateAction<HomeData>>
  onMessage: (message: string | null) => void
  onSelectedDocumentChange: Dispatch<SetStateAction<DocumentDetail | null>>
  selectedDocument: DocumentDetail | null
  selectedDocumentId: string | null
  ui: UiText
}

export function usePluginsDomain({
  homeData,
  onDraftSummaryChange,
  onHomeDataChange,
  onMessage,
  onSelectedDocumentChange,
  selectedDocument,
  selectedDocumentId,
  ui
}: UsePluginsDomainParams) {
  const plugins = homeData.plugins ?? []
  const pluginDashboardCards = homeData.pluginDashboardCards ?? []
  const pluginDocumentActions = homeData.pluginDocumentActions ?? []
  const pluginRoots = homeData.pluginHost?.roots ?? []

  const pluginState = usePluginManagement({
    plugins,
    selectedDocumentId,
    selectedDocument,
    ui,
    onHomeDataChange,
    onSelectedDocumentChange,
    onDraftSummaryChange,
    onMessage
  })

  const sectionProps: PluginsSectionProps = {
    onInstallPluginFromFolder: () => {
      void pluginState.installPluginFromFolder()
    },
    onReloadPlugin: (plugin) => {
      void pluginState.reloadPlugin(plugin)
    },
    onReloadPlugins: () => {
      void pluginState.reloadPlugins()
    },
    onRemovePlugin: (plugin) => {
      void pluginState.removePlugin(plugin)
    },
    onSetPluginEnabled: (plugin, enabled) => {
      void pluginState.setPluginEnabled(plugin, enabled)
    },
    onUpdatePluginSetting: (plugin, setting, value) => {
      void pluginState.updatePluginSetting(plugin, setting, value)
    },
    onUpdatePluginSettingDraft: pluginState.updatePluginSettingDraft,
    pluginBusyId: pluginState.pluginBusyId,
    pluginInventoryBusy: pluginState.pluginInventoryBusy,
    pluginRoots,
    pluginSettingBusyKey: pluginState.pluginSettingBusyKey,
    pluginSettingDrafts: pluginState.pluginSettingDrafts,
    plugins,
    ui
  }

  return {
    ...pluginState,
    pluginDashboardCards,
    pluginDocumentActions,
    plugins,
    sectionProps
  }
}