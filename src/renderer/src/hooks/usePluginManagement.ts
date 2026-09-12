import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  DocumentDetail,
  HomeData,
  PluginDocumentAction,
  PluginV2InstallationSummary,
  SystemPluginSummary
} from '@shared/contracts'
import type { UiText } from '../i18n'

type UsePluginManagementParams = {
  selectedDocumentId: string | null
  selectedDocument: DocumentDetail | null
  ui: UiText
  onHomeDataChange: Dispatch<SetStateAction<HomeData>>
  onSelectedDocumentChange: (detail: DocumentDetail | null) => void
  onDraftSummaryChange: (summary: string) => void
  onMessage: (message: string) => void
}

export function usePluginManagement({
  selectedDocumentId,
  selectedDocument,
  ui,
  onHomeDataChange,
  onSelectedDocumentChange,
  onDraftSummaryChange,
  onMessage
}: UsePluginManagementParams) {
  const [pluginBusyId, setPluginBusyId] = useState<string | null>(null)
  const [pluginActionBusyKey, setPluginActionBusyKey] = useState<string | null>(null)
  const [pluginInventoryBusy, setPluginInventoryBusy] = useState(false)

  const refreshPluginHomeData = useCallback(async () => {
    const refreshed = await window.knowbook.getPluginHomeData()
    onHomeDataChange((current) => ({ ...current, ...refreshed }))
    return refreshed
  }, [onHomeDataChange])

  const setPluginV2Enabled = useCallback(async (plugin: PluginV2InstallationSummary, enabled: boolean) => {
    setPluginBusyId(plugin.pluginId)
    try {
      await window.knowbook.setPluginV2Enabled({ pluginId: plugin.pluginId, enabled })
      await refreshPluginHomeData()
      onMessage(ui.language === 'zh-CN'
        ? `插件“${plugin.name}”已${enabled ? '启用' : '停用'}。`
        : `Plugin "${plugin.name}" was ${enabled ? 'enabled' : 'disabled'}.`)
    } catch (error) {
      await refreshPluginHomeData().catch(() => undefined)
      onMessage(error instanceof Error ? error.message : (ui.language === 'zh-CN' ? '插件状态更新失败。' : 'Plugin status update failed.'))
    } finally {
      setPluginBusyId(null)
    }
  }, [onMessage, refreshPluginHomeData, ui.language])

  const removePluginV2 = useCallback(async (plugin: PluginV2InstallationSummary) => {
    const accepted = window.confirm(ui.language === 'zh-CN'
      ? `确定卸载“${plugin.name}”吗？插件代码、历史版本、授权和本地状态都会被移除，此操作无法撤销。`
      : `Uninstall "${plugin.name}"? Its code, revision history, grants, and local state will be removed. This cannot be undone.`)
    if (!accepted) return

    setPluginBusyId(plugin.pluginId)
    try {
      await window.knowbook.removePluginV2({ pluginId: plugin.pluginId })
      await refreshPluginHomeData()
      onMessage(ui.language === 'zh-CN' ? `插件“${plugin.name}”已卸载。` : `Plugin "${plugin.name}" was uninstalled.`)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : (ui.language === 'zh-CN' ? '插件卸载失败。' : 'Plugin uninstall failed.'))
    } finally {
      setPluginBusyId(null)
    }
  }, [onMessage, refreshPluginHomeData, ui.language])

  const installSystemPluginFromFolder = useCallback(async () => {
    setPluginInventoryBusy(true)
    try {
      const request = await window.knowbook.chooseAndPrepareSystemPluginInstall()
      if (!request) return
      await refreshPluginHomeData()
      onMessage(ui.language === 'zh-CN'
        ? `已检查“${request.name}”并计算精确 artifact 哈希；请在安全队列中确认。`
        : `Inspected "${request.name}" and calculated its exact artifact hash. Review it in the security queue.`)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : (ui.language === 'zh-CN' ? '系统插件检查失败。' : 'System plugin inspection failed.'))
    } finally {
      setPluginInventoryBusy(false)
    }
  }, [onMessage, refreshPluginHomeData, ui.language])

  const setSystemPluginEnabled = useCallback(async (plugin: SystemPluginSummary, enabled: boolean) => {
    setPluginBusyId(plugin.pluginId)
    try {
      await window.knowbook.setSystemPluginEnabled({ pluginId: plugin.pluginId, enabled })
      await refreshPluginHomeData()
      onMessage(ui.language === 'zh-CN'
        ? `Full Trust 插件“${plugin.name}”已${enabled ? '标记为重启后启用' : '停用'}。`
        : `Full Trust plugin "${plugin.name}" was ${enabled ? 'scheduled to enable after restart' : 'disabled'}.`)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'System plugin status update failed.')
    } finally {
      setPluginBusyId(null)
    }
  }, [onMessage, refreshPluginHomeData, ui.language])

  const recoverSystemPlugin = useCallback(async (plugin: SystemPluginSummary) => {
    setPluginBusyId(plugin.pluginId)
    try {
      await window.knowbook.recoverSystemPlugin({ pluginId: plugin.pluginId })
      await refreshPluginHomeData()
      onMessage(ui.language === 'zh-CN' ? '已解除安全停用；插件将在重启后重新尝试启动。' : 'Safe-mode disable was cleared; startup will be retried after restart.')
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'System plugin recovery failed.')
    } finally {
      setPluginBusyId(null)
    }
  }, [onMessage, refreshPluginHomeData, ui.language])

  const uninstallSystemPlugin = useCallback(async (plugin: SystemPluginSummary, preserveData: boolean) => {
    setPluginBusyId(plugin.pluginId)
    try {
      await window.knowbook.uninstallSystemPlugin({ pluginId: plugin.pluginId, preserveData })
      await refreshPluginHomeData()
      onMessage(ui.language === 'zh-CN'
        ? `已停用并标记为重启后卸载；${preserveData ? '插件数据将保留供重新安装使用。' : '插件专属数据将一并删除。'}`
        : `Disabled and scheduled for uninstall after restart; plugin data will be ${preserveData ? 'retained for reinstall' : 'deleted'}.`)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'System plugin uninstall failed.')
    } finally {
      setPluginBusyId(null)
    }
  }, [onMessage, refreshPluginHomeData, ui.language])

  const rollbackSystemPlugin = useCallback(async (plugin: SystemPluginSummary, packageId: string) => {
    setPluginBusyId(plugin.pluginId)
    try {
      await window.knowbook.rollbackSystemPlugin({ pluginId: plugin.pluginId, packageId })
      await refreshPluginHomeData()
      onMessage(ui.language === 'zh-CN' ? '已选择回滚版本；重启后验证并激活。' : 'Rollback package selected; it will be verified and activated after restart.')
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'System plugin rollback failed.')
    } finally {
      setPluginBusyId(null)
    }
  }, [onMessage, refreshPluginHomeData, ui.language])

  const restartInSystemPluginSafeMode = useCallback(async () => {
    const accepted = window.confirm(ui.language === 'zh-CN'
      ? '立即重启并跳过所有 Full Trust 插件启动吗？v2 插件不受影响。'
      : 'Restart now and skip every Full Trust plugin for one boot? v2 plugins are unaffected.')
    if (!accepted) return
    await window.knowbook.restartInSystemPluginSafeMode()
  }, [ui.language])

  const startSystemPluginService = useCallback(async (plugin: SystemPluginSummary) => {
    setPluginBusyId(plugin.pluginId)
    try {
      await window.knowbook.startSystemPluginService({ pluginId: plugin.pluginId })
      await refreshPluginHomeData()
      onMessage(ui.language === 'zh-CN' ? '后台服务已启动。' : 'Background service started.')
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'System plugin service start failed.')
    } finally {
      setPluginBusyId(null)
    }
  }, [onMessage, refreshPluginHomeData, ui.language])

  const stopSystemPluginService = useCallback(async (plugin: SystemPluginSummary) => {
    setPluginBusyId(plugin.pluginId)
    try {
      await window.knowbook.stopSystemPluginService({ pluginId: plugin.pluginId })
      await refreshPluginHomeData()
      onMessage(ui.language === 'zh-CN' ? '后台服务已停止。' : 'Background service stopped.')
    } catch (error) {
      await refreshPluginHomeData().catch(() => undefined)
      onMessage(error instanceof Error ? error.message : 'System plugin service stop failed.')
    } finally {
      setPluginBusyId(null)
    }
  }, [onMessage, refreshPluginHomeData, ui.language])

  const requestSystemPluginOsPersistence = useCallback(async (plugin: SystemPluginSummary) => {
    setPluginBusyId(plugin.pluginId)
    try {
      await window.knowbook.requestSystemPluginOsPersistence({ pluginId: plugin.pluginId })
      await refreshPluginHomeData()
      onMessage(ui.language === 'zh-CN'
        ? '已生成独立的登录启动确认请求；尚未修改系统启动项。'
        : 'A separate login-startup review was created; no OS startup item has been changed yet.')
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'OS persistence request failed.')
    } finally {
      setPluginBusyId(null)
    }
  }, [onMessage, refreshPluginHomeData, ui.language])

  const resolveSystemPluginOsPersistence = useCallback(async (
    plugin: SystemPluginSummary,
    decision: 'confirm' | 'cancel',
    acknowledgeSystemStartup: boolean
  ) => {
    const record = plugin.osPersistence
    if (!record) return
    setPluginBusyId(plugin.pluginId)
    try {
      await window.knowbook.resolveSystemPluginOsPersistence({
        recordId: record.id,
        pluginId: plugin.pluginId,
        revisionHash: record.revisionHash,
        decision,
        acknowledgeSystemStartup
      })
      await refreshPluginHomeData()
      onMessage(decision === 'confirm'
        ? (ui.language === 'zh-CN' ? '系统登录启动项已登记并校验。' : 'The OS login-startup item was registered and verified.')
        : (ui.language === 'zh-CN' ? '登录启动请求已取消。' : 'The login-startup request was cancelled.'))
    } catch (error) {
      await refreshPluginHomeData().catch(() => undefined)
      onMessage(error instanceof Error ? error.message : 'OS persistence confirmation failed.')
    } finally {
      setPluginBusyId(null)
    }
  }, [onMessage, refreshPluginHomeData, ui.language])

  const removeSystemPluginOsPersistence = useCallback(async (plugin: SystemPluginSummary) => {
    const accepted = window.confirm(ui.language === 'zh-CN'
      ? `移除 ${plugin.name} 的宿主管理登录启动项吗？仅会删除与已记录命令精确匹配的启动项。`
      : `Remove the host-managed login-startup item for ${plugin.name}? Only an exact recorded target will be removed.`)
    if (!accepted) return
    setPluginBusyId(plugin.pluginId)
    try {
      await window.knowbook.removeSystemPluginOsPersistence({ pluginId: plugin.pluginId })
      await refreshPluginHomeData()
      onMessage(ui.language === 'zh-CN' ? '宿主管理的登录启动项已移除。' : 'The host-managed login-startup item was removed.')
    } catch (error) {
      await refreshPluginHomeData().catch(() => undefined)
      onMessage(error instanceof Error ? error.message : 'OS persistence removal failed.')
    } finally {
      setPluginBusyId(null)
    }
  }, [onMessage, refreshPluginHomeData, ui.language])

  const openSystemPluginDirectory = useCallback(async (
    plugin: SystemPluginSummary,
    target: 'data' | 'logs'
  ) => {
    try {
      if (target === 'data') {
        await window.knowbook.openSystemPluginDataDirectory({ pluginId: plugin.pluginId })
      } else {
        await window.knowbook.openSystemPluginLogDirectory({ pluginId: plugin.pluginId })
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'System plugin directory could not be opened.')
    }
  }, [onMessage])

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
        result.refreshDocument ? window.knowbook.getHomeData() : window.knowbook.getPluginHomeData(),
        result.refreshDocument ? window.knowbook.getDocumentDetail(selectedDocumentId) : Promise.resolve(selectedDocument)
      ])

      onHomeDataChange((current) => ({ ...current, ...refreshedHome }))
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
    pluginActionBusyKey,
    pluginInventoryBusy,
    installSystemPluginFromFolder,
    removePluginV2,
    setPluginV2Enabled,
    setSystemPluginEnabled,
    recoverSystemPlugin,
    uninstallSystemPlugin,
    rollbackSystemPlugin,
    startSystemPluginService,
    stopSystemPluginService,
    requestSystemPluginOsPersistence,
    resolveSystemPluginOsPersistence,
    removeSystemPluginOsPersistence,
    openSystemPluginDirectory,
    restartInSystemPluginSafeMode,
    runPluginDocumentAction
  }
}
