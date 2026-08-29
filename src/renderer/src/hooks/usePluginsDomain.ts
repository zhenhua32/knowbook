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
  const pluginV2Installations = homeData.pluginV2Installations ?? []
  const systemPluginInstallRequests = homeData.systemPluginInstallRequests ?? []

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
    onRemovePluginV2: (plugin) => {
      void pluginState.removePluginV2(plugin)
    },
    onSetPluginEnabled: (plugin, enabled) => {
      void pluginState.setPluginEnabled(plugin, enabled)
    },
    onSetPluginV2Enabled: (plugin, enabled) => {
      void pluginState.setPluginV2Enabled(plugin, enabled)
    },
    onUpdatePluginSetting: (plugin, setting, value) => {
      void pluginState.updatePluginSetting(plugin, setting, value)
    },
    onUpdatePluginSettingDraft: pluginState.updatePluginSettingDraft,
    pluginBusyId: pluginState.pluginBusyId,
    pluginInventoryBusy: pluginState.pluginInventoryBusy,
    pluginRoots,
    pluginV2Installations,
    systemPluginInstallRequests,
    onRecoverPluginV2Installation: (pluginId) => {
      void window.knowbook.recoverPluginV2Installation({ pluginId }).then(async () => {
        const refreshed = await window.knowbook.getPluginHomeData()
        onHomeDataChange((current) => ({ ...current, ...refreshed }))
        onMessage('插件隔离状态已解除；重新激活仍需新的审批。')
      }).catch((error: unknown) => {
        onMessage(error instanceof Error ? error.message : 'Plugin recovery failed.')
      })
    },
    onResolveSystemPluginInstallRequest: (requestId, pluginId, decision, acknowledgeSystemAccess) => {
      void window.knowbook.resolveSystemPluginInstallRequest({
        requestId,
        pluginId,
        decision,
        acknowledgeSystemAccess
      }).then(async () => {
        const refreshed = await window.knowbook.getPluginHomeData()
        onHomeDataChange((current) => ({ ...current, ...refreshed }))
        onMessage(decision === 'confirm'
          ? '系统插件已确认，将在应用重启后的系统安装阶段处理；当前进程未加载任何原生代码。'
          : '系统插件安装请求已取消。')
      }).catch((error: unknown) => {
        onMessage(error instanceof Error ? error.message : 'System plugin confirmation failed.')
      })
    },
    pluginSettingBusyKey: pluginState.pluginSettingBusyKey,
    pluginSettingDrafts: pluginState.pluginSettingDrafts,
    plugins,
    aiEnabled: homeData.aiConfig.enabled,
    hasApiKey: homeData.aiConfig.hasApiKey,
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
