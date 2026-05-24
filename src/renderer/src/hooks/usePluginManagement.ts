import { useCallback, useEffect, useState } from 'react'
import type {
  DocumentDetail,
  HomeData,
  PluginDescriptor,
  PluginDocumentAction,
  PluginSettingDescriptor,
  PluginSettingValue
} from '@shared/contracts'
import type { UiText } from '../i18n'

type UsePluginManagementParams = {
  plugins: PluginDescriptor[]
  selectedDocumentId: string | null
  selectedDocument: DocumentDetail | null
  ui: UiText
  onHomeDataChange: (homeData: HomeData) => void
  onSelectedDocumentChange: (detail: DocumentDetail | null) => void
  onDraftSummaryChange: (summary: string) => void
  onMessage: (message: string) => void
}

function getPluginSettingDraftKey(pluginId: string, settingId: string): string {
  return `${pluginId}:${settingId}`
}

function buildPluginSettingDrafts(plugins: PluginDescriptor[]): Record<string, PluginSettingValue> {
  return plugins.reduce<Record<string, PluginSettingValue>>((accumulator, plugin) => {
    for (const setting of plugin.settings) {
      accumulator[getPluginSettingDraftKey(plugin.id, setting.id)] = setting.value
    }

    return accumulator
  }, {})
}

export function usePluginManagement({
  plugins,
  selectedDocumentId,
  selectedDocument,
  ui,
  onHomeDataChange,
  onSelectedDocumentChange,
  onDraftSummaryChange,
  onMessage
}: UsePluginManagementParams) {
  const [pluginBusyId, setPluginBusyId] = useState<string | null>(null)
  const [pluginSettingBusyKey, setPluginSettingBusyKey] = useState<string | null>(null)
  const [pluginSettingDrafts, setPluginSettingDrafts] = useState<Record<string, PluginSettingValue>>({})
  const [pluginActionBusyKey, setPluginActionBusyKey] = useState<string | null>(null)
  const [pluginInventoryBusy, setPluginInventoryBusy] = useState(false)

  useEffect(() => {
    setPluginSettingDrafts(buildPluginSettingDrafts(plugins))
  }, [plugins])

  const updatePluginSettingDraft = useCallback((pluginId: string, settingId: string, value: PluginSettingValue) => {
    const draftKey = getPluginSettingDraftKey(pluginId, settingId)
    setPluginSettingDrafts((previous) => ({
      ...previous,
      [draftKey]: value
    }))
  }, [])

  const setPluginEnabled = useCallback(async (plugin: PluginDescriptor, enabled: boolean) => {
    setPluginBusyId(plugin.id)

    try {
      await window.knowbook.setPluginEnabled({ pluginId: plugin.id, enabled })
      const refreshed = await window.knowbook.getHomeData()
      onHomeDataChange(refreshed)
      onMessage(ui.pluginStatusUpdated(plugin.name, enabled))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.pluginStatusUpdateFailed
      onMessage(message)
    } finally {
      setPluginBusyId(null)
    }
  }, [onHomeDataChange, onMessage, ui])

  const reloadPlugins = useCallback(async () => {
    setPluginInventoryBusy(true)

    try {
      await window.knowbook.reloadPlugins()
      const refreshed = await window.knowbook.getHomeData()
      onHomeDataChange(refreshed)
      onMessage(ui.pluginsReloaded)
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.pluginsReloadFailed
      onMessage(message)
    } finally {
      setPluginInventoryBusy(false)
    }
  }, [onHomeDataChange, onMessage, ui])

  const installPluginFromFolder = useCallback(async () => {
    setPluginInventoryBusy(true)

    try {
      const result = await window.knowbook.installPluginFromFolder()
      if (!result) {
        return
      }

      const refreshed = await window.knowbook.getHomeData()
      onHomeDataChange(refreshed)

      if (result.operation === 'updated') {
        onMessage(ui.pluginUpdated(result.plugin.name, result.previousVersion ?? (ui.language === 'zh-CN' ? '未知' : 'unknown'), result.plugin.version))
      } else if (result.operation === 'reloaded') {
        onMessage(ui.pluginReloadedFromFolder(result.plugin.name))
      } else {
        onMessage(ui.pluginInstalled(result.plugin.name))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.pluginInstallFailed
      onMessage(message)
    } finally {
      setPluginInventoryBusy(false)
    }
  }, [onHomeDataChange, onMessage, ui])

  const removePlugin = useCallback(async (plugin: PluginDescriptor) => {
    const accepted = window.confirm(ui.confirmRemovePlugin(plugin.name))
    if (!accepted) {
      return
    }

    setPluginBusyId(plugin.id)

    try {
      await window.knowbook.removePlugin(plugin.id)
      const refreshed = await window.knowbook.getHomeData()
      onHomeDataChange(refreshed)
      onMessage(ui.pluginRemoved(plugin.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.pluginRemoveFailed
      onMessage(message)
    } finally {
      setPluginBusyId(null)
    }
  }, [onHomeDataChange, onMessage, ui])

  const updatePluginSetting = useCallback(async (plugin: PluginDescriptor, setting: PluginSettingDescriptor, value: PluginSettingValue) => {
    const busyKey = getPluginSettingDraftKey(plugin.id, setting.id)
    setPluginSettingBusyKey(busyKey)

    try {
      await window.knowbook.updatePluginSetting({
        pluginId: plugin.id,
        settingId: setting.id,
        value
      })
      const refreshed = await window.knowbook.getHomeData()
      onHomeDataChange(refreshed)
      onMessage(ui.pluginSettingSaved(plugin.name, setting.label))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.pluginSettingUpdateFailed
      onMessage(message)
    } finally {
      setPluginSettingBusyKey(null)
    }
  }, [onHomeDataChange, onMessage, ui])

  const reloadPlugin = useCallback(async (plugin: PluginDescriptor) => {
    setPluginBusyId(plugin.id)

    try {
      await window.knowbook.reloadPlugin(plugin.id)
      const refreshed = await window.knowbook.getHomeData()
      onHomeDataChange(refreshed)
      const refreshedPlugin = (refreshed.plugins ?? []).find((candidate) => candidate.id === plugin.id)

      if (!refreshedPlugin) {
        onMessage(ui.pluginMissingAfterReload(plugin.name))
      } else if (refreshedPlugin.status === 'error') {
        onMessage(ui.pluginStillHasErrorsAfterReload(refreshedPlugin.name, refreshedPlugin.error ?? (ui.language === 'zh-CN' ? '未知错误' : 'unknown error')))
      } else if (refreshedPlugin.status === 'disabled') {
        onMessage(ui.disabledPluginMetadataReloaded(refreshedPlugin.name))
      } else {
        onMessage(ui.pluginReloadedSingle(refreshedPlugin.name))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.pluginReloadFailed
      onMessage(message)
    } finally {
      setPluginBusyId(null)
    }
  }, [onHomeDataChange, onMessage, ui])

  const runPluginDocumentAction = useCallback(async (action: PluginDocumentAction) => {
    if (!selectedDocumentId) {
      return
    }

    const actionKey = `${action.pluginId}:${action.id}`
    setPluginActionBusyKey(actionKey)

    try {
      const result = await window.knowbook.runPluginDocumentAction({
        pluginId: action.pluginId,
        actionId: action.id,
        documentId: selectedDocumentId
      })

      const [refreshedHome, refreshedDetail] = await Promise.all([
        window.knowbook.getHomeData(),
        result.refreshDocument ? window.knowbook.getDocumentDetail(selectedDocumentId) : Promise.resolve(selectedDocument)
      ])

      onHomeDataChange(refreshedHome)
      if (result.refreshDocument) {
        onSelectedDocumentChange(refreshedDetail)
        onDraftSummaryChange(refreshedDetail?.summary ?? '')
      }
      onMessage(result.message)
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.pluginActionFailed
      onMessage(message)
    } finally {
      setPluginActionBusyKey(null)
    }
  }, [onDraftSummaryChange, onHomeDataChange, onMessage, onSelectedDocumentChange, selectedDocument, selectedDocumentId, ui])

  return {
    pluginBusyId,
    pluginSettingBusyKey,
    pluginSettingDrafts,
    pluginActionBusyKey,
    pluginInventoryBusy,
    updatePluginSettingDraft,
    setPluginEnabled,
    reloadPlugins,
    installPluginFromFolder,
    removePlugin,
    updatePluginSetting,
    reloadPlugin,
    runPluginDocumentAction
  }
}