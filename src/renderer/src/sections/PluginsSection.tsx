import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  PluginV2Details,
  PluginV2InstallationSummary,
  SystemPluginInstallRequest,
  SystemPluginSummary
} from '@shared/contracts'
import type { UiText } from '../i18n'
import { AssistantConversation } from '../components/AssistantConversation'
import { PluginV2TechnicalDetails } from '../components/PluginV2TechnicalDetails'
import { SystemPluginResources } from '../components/SystemPluginResources'
import { SystemPluginRuntimeStatus } from '../components/SystemPluginRuntimeStatus'
import { getSystemPluginFailureStages } from '@shared/system-plugin-state'
import { trapFocusWithinDialog } from '../utils/dialogFocus'
import './plugins-section.css'

type PluginFilter = 'all' | 'running' | 'disabled' | 'attention'

type InventoryPlugin = { key: string; plugin: PluginV2InstallationSummary }

type PluginsSectionProps = {
  ui: UiText
  aiEnabled: boolean
  hasApiKey: boolean
  pluginV2Installations: PluginV2InstallationSummary[]
  systemPluginInstallRequests: SystemPluginInstallRequest[]
  systemPlugins: SystemPluginSummary[]
  pluginBusyId: string | null
  pluginInventoryBusy: boolean
  onInstallSystemPluginFromFolder: () => void
  onSetPluginV2Enabled: (plugin: PluginV2InstallationSummary, enabled: boolean) => void
  onRemovePluginV2: (plugin: PluginV2InstallationSummary) => void
  onRecoverPluginV2Installation: (pluginId: string) => void
  onSetSystemPluginEnabled: (plugin: SystemPluginSummary, enabled: boolean) => void
  onRecoverSystemPlugin: (plugin: SystemPluginSummary) => void
  onUninstallSystemPlugin: (plugin: SystemPluginSummary, preserveData: boolean) => void
  onRollbackSystemPlugin: (plugin: SystemPluginSummary, packageId: string) => void
  onStartSystemPluginService: (plugin: SystemPluginSummary) => void
  onStopSystemPluginService: (plugin: SystemPluginSummary) => void
  onRequestSystemPluginOsPersistence: (plugin: SystemPluginSummary) => void
  onResolveSystemPluginOsPersistence: (
    plugin: SystemPluginSummary,
    decision: 'confirm' | 'cancel',
    acknowledgeSystemStartup: boolean
  ) => void
  onRemoveSystemPluginOsPersistence: (plugin: SystemPluginSummary) => void
  onOpenSystemPluginDirectory: (plugin: SystemPluginSummary, target: 'data' | 'logs') => void
  onRestartInSystemPluginSafeMode: () => void
  onResolveSystemPluginInstallRequest: (
    requestId: string,
    pluginId: string,
    artifactSha256: string,
    decision: 'confirm' | 'cancel',
    acknowledgeSystemAccess: boolean
  ) => void
}

function getInventoryStatus(item: InventoryPlugin): 'running' | 'disabled' | 'attention' | 'stopped' {
  if (item.plugin.quarantined || item.plugin.lastError) return 'attention'
  if (!item.plugin.enabled) return 'disabled'
  return item.plugin.activeRunId ? 'running' : 'stopped'
}

function statusLabel(status: ReturnType<typeof getInventoryStatus>, isZh: boolean): string {
  const labels = {
    running: isZh ? '运行中' : 'Running',
    disabled: isZh ? '已停用' : 'Disabled',
    attention: isZh ? '需要处理' : 'Needs attention',
    stopped: isZh ? '已停止' : 'Stopped'
  }
  return labels[status]
}

function sourceLabel(source: PluginV2InstallationSummary['source'], isZh: boolean): string {
  const labels: Record<PluginV2InstallationSummary['source'], [string, string]> = {
    builtin: ['内置', 'Built in'],
    dynamic: ['AI 创建', 'AI created'],
    marketplace: ['插件市场', 'Marketplace'],
    system: ['系统级', 'System'],
    legacy: ['已迁移', 'Migrated']
  }
  return isZh ? labels[source][0] : labels[source][1]
}

function pluginInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toLocaleUpperCase()
}

function compactRevision(revisionId: string | null): string {
  if (!revisionId) return '—'
  return revisionId.length > 22 ? `${revisionId.slice(0, 19)}…` : revisionId
}

function errorDetail(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return JSON.stringify(error)
}

function formatUpdatedAt(value: string, isZh: boolean): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(isZh ? 'zh-CN' : 'en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

export function PluginsSection({
  ui,
  aiEnabled,
  hasApiKey,
  pluginV2Installations,
  systemPluginInstallRequests,
  systemPlugins,
  pluginBusyId,
  pluginInventoryBusy,
  onInstallSystemPluginFromFolder,
  onSetPluginV2Enabled,
  onRemovePluginV2,
  onRecoverPluginV2Installation,
  onSetSystemPluginEnabled,
  onRecoverSystemPlugin,
  onUninstallSystemPlugin,
  onRollbackSystemPlugin,
  onStartSystemPluginService,
  onStopSystemPluginService,
  onRequestSystemPluginOsPersistence,
  onResolveSystemPluginOsPersistence,
  onRemoveSystemPluginOsPersistence,
  onOpenSystemPluginDirectory,
  onRestartInSystemPluginSafeMode,
  onResolveSystemPluginInstallRequest
}: PluginsSectionProps) {
  const isZh = ui.language === 'zh-CN'
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PluginFilter>('all')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [customizingPlugin, setCustomizingPlugin] = useState<PluginV2InstallationSummary | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<SystemPluginSummary | null>(null)
  const [preserveUninstallData, setPreserveUninstallData] = useState(true)
  const uninstallDialogRef = useRef<HTMLElement>(null)
  const uninstallReturnFocusRef = useRef<HTMLElement | null>(null)
  const [customizerDrafts, setCustomizerDrafts] = useState<Record<string, string>>({})
  const [systemAcknowledgements, setSystemAcknowledgements] = useState<Record<string, boolean>>({})
  const [systemPluginIdConfirmations, setSystemPluginIdConfirmations] = useState<Record<string, string>>({})
  const [osPersistenceAcknowledgements, setOsPersistenceAcknowledgements] = useState<Record<string, boolean>>({})
  const [osPersistenceIdConfirmations, setOsPersistenceIdConfirmations] = useState<Record<string, string>>({})
  const [pluginV2Details, setPluginV2Details] = useState<PluginV2Details | null>(null)
  const [pluginV2DetailsLoading, setPluginV2DetailsLoading] = useState(false)
  const [pluginV2DetailsError, setPluginV2DetailsError] = useState<string | null>(null)
  const [pluginV2DetailsReload, setPluginV2DetailsReload] = useState(0)
  const customizerDialogRef = useRef<HTMLElement>(null)
  const customizerReturnFocusRef = useRef<HTMLElement | null>(null)

  const inventory = useMemo<InventoryPlugin[]>(() => pluginV2Installations.map((plugin) => ({
    key: plugin.pluginId,
    plugin
  })), [pluginV2Installations])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredInventory = inventory.filter((item) => {
    const status = getInventoryStatus(item)
    const matchesFilter = filter === 'all'
      || (filter === 'attention' ? status === 'attention' : status === filter)
    const name = item.plugin.name.toLocaleLowerCase()
    const id = item.plugin.pluginId.toLocaleLowerCase()
    const description = item.plugin.description.toLocaleLowerCase()
    return matchesFilter && (!normalizedQuery || `${name} ${id} ${description}`.includes(normalizedQuery))
  })
  const selected = filteredInventory.find((item) => item.key === selectedKey) ?? null
  const runningCount = inventory.filter((item) => getInventoryStatus(item) === 'running').length
    + systemPlugins.filter((plugin) => plugin.status === 'active' && !plugin.safeModeDisabled && !plugin.lastError).length
  const attentionCount = inventory.filter((item) => getInventoryStatus(item) === 'attention').length
    + systemPlugins.filter((plugin) => plugin.safeModeDisabled || plugin.lastError || plugin.status === 'failed').length
  const aiCreatedCount = pluginV2Installations.filter((plugin) => plugin.source === 'dynamic').length

  useEffect(() => {
    if (selectedKey && !selected) setSelectedKey(null)
  }, [selected, selectedKey])

  const selectedV2DetailsKey = selected
    ? [
        selected.plugin.pluginId,
        selected.plugin.updatedAt,
        selected.plugin.currentRevisionId,
        selected.plugin.activeRunId,
        selected.plugin.revisionCount
      ].join(':')
    : null

  useEffect(() => {
    if (!selectedV2DetailsKey || !selected) {
      setPluginV2Details(null)
      setPluginV2DetailsError(null)
      setPluginV2DetailsLoading(false)
      return undefined
    }
    const pluginId = selected.plugin.pluginId
    let cancelled = false
    setPluginV2DetailsLoading(true)
    setPluginV2DetailsError(null)
    void window.knowbook.getPluginV2Details({ pluginId }).then((details) => {
      if (!cancelled) setPluginV2Details(details)
    }).catch((error: unknown) => {
      if (!cancelled) {
        setPluginV2Details(null)
        setPluginV2DetailsError(error instanceof Error ? error.message : 'Plugin details could not be loaded.')
      }
    }).finally(() => {
      if (!cancelled) setPluginV2DetailsLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [pluginV2DetailsReload, selectedV2DetailsKey])

  const customizingPluginId = customizingPlugin?.pluginId ?? null
  const customizerDraft = customizingPlugin
    ? customizerDrafts[customizingPlugin.pluginId] ?? pluginCustomizationDraft(customizingPlugin, isZh)
    : ''

  useEffect(() => {
    if (!customizingPluginId) return undefined
    const dialog = customizerDialogRef.current
    if (!dialog) return undefined
    const returnFocus = customizerReturnFocusRef.current
    const focusFrame = window.requestAnimationFrame(() => {
      const textarea = dialog.querySelector<HTMLTextAreaElement>('.assistant-composer textarea:not(:disabled)')
      const initialFocus = textarea ?? dialog.querySelector<HTMLElement>('.plugin-customizer-close') ?? dialog
      initialFocus.focus()
      if (textarea) textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    })
    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setCustomizingPlugin(null)
        return
      }
      trapFocusWithinDialog(event, dialog)
    }
    window.addEventListener('keydown', handleDialogKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', handleDialogKeyDown)
      window.requestAnimationFrame(() => {
        if (returnFocus?.isConnected) returnFocus.focus()
      })
    }
  }, [customizingPluginId])

  const openPluginCustomizer = (plugin: PluginV2InstallationSummary) => {
    customizerReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setCustomizingPlugin(plugin)
  }

  useEffect(() => {
    if (!uninstallTarget) return undefined
    const dialog = uninstallDialogRef.current
    if (!dialog) return undefined
    const returnFocus = uninstallReturnFocusRef.current
    dialog.querySelector<HTMLElement>('[data-uninstall-cancel]')?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setUninstallTarget(null); return }
      trapFocusWithinDialog(event, dialog)
    }
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('keydown', keydown)
      if (returnFocus?.isConnected) returnFocus.focus()
    }
  }, [uninstallTarget])

  return (
    <section className="plugins-page">
      <header className="plugin-page-hero">
        <div className="plugin-page-heading">
          <span className="plugin-page-kicker">{isZh ? '扩展与自动化' : 'Extensions & automations'}</span>
          <h3>{ui.pluginsTitle}</h3>
          <p>{isZh
            ? '集中管理插件的运行状态、版本与权限，并随时让 AI 在现有插件上继续迭代。'
            : 'Manage runtime status, versions, and permissions, then keep iterating on existing plugins with AI.'}</p>
        </div>
        <div className="plugin-toolbar">
          <button className="danger-button" disabled={pluginInventoryBusy} onClick={onInstallSystemPluginFromFolder} type="button">
            <span aria-hidden="true">⚠</span>
            {isZh ? '安装 Full Trust' : 'Install Full Trust'}
          </button>
        </div>
      </header>

      <div className="plugin-overview-grid" aria-label={isZh ? '插件概览' : 'Plugin overview'}>
        <div className="plugin-overview-card">
          <span>{isZh ? '已安装' : 'Installed'}</span>
          <strong>{inventory.length + systemPlugins.length}</strong>
          <small>{isZh ? '工作区扩展' : 'workspace extensions'}</small>
        </div>
        <div className="plugin-overview-card plugin-overview-running">
          <span>{isZh ? '正在运行' : 'Active now'}</span>
          <strong>{runningCount}</strong>
          <small>{isZh ? '运行实例健康' : 'healthy runtimes'}</small>
        </div>
        <div className="plugin-overview-card plugin-overview-ai">
          <span>{isZh ? 'AI 创建' : 'AI created'}</span>
          <strong>{aiCreatedCount}</strong>
          <small>{isZh ? '可继续对话定制' : 'ready to customize'}</small>
        </div>
        <div className={`plugin-overview-card ${attentionCount > 0 ? 'plugin-overview-attention' : ''}`}>
          <span>{isZh ? '需要处理' : 'Needs attention'}</span>
          <strong>{attentionCount}</strong>
          <small>{isZh ? '错误或安全隔离' : 'errors or quarantine'}</small>
        </div>
      </div>

      <div className="plugin-management-layout">
        <article className="panel plugin-inventory-panel">
          <div className="plugin-inventory-head">
            <div>
              <h4>{isZh ? '工作区插件' : 'Workspace plugins'}</h4>
              <p>{isZh ? '内置与 AI 创建的插件统一显示，展开查看详情。' : 'Built-in and AI-created plugins share this list. Expand a plugin to view its details.'}</p>
            </div>
            <label className="plugin-search">
              <span aria-hidden="true">⌕</span>
              <input
                aria-label={isZh ? '搜索插件' : 'Search plugins'}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={isZh ? '搜索名称或 ID' : 'Search name or ID'}
                type="search"
                value={query}
              />
            </label>
          </div>
          <div className="plugin-filter-tabs" role="tablist" aria-label={isZh ? '插件筛选' : 'Plugin filters'}>
            {(['all', 'running', 'disabled', 'attention'] as const).map((item) => {
              const labels: Record<PluginFilter, string> = {
                all: isZh ? '全部' : 'All',
                running: isZh ? '运行中' : 'Running',
                disabled: isZh ? '已停用' : 'Disabled',
                attention: isZh ? '需处理' : 'Attention'
              }
              return (
                <button
                  aria-selected={filter === item}
                  className={filter === item ? 'active' : ''}
                  key={item}
                  onClick={() => setFilter(item)}
                  role="tab"
                  type="button"
                >
                  {labels[item]}
                </button>
              )
            })}
          </div>

          {filteredInventory.length > 0 ? (
            <div className="plugin-list">
              {filteredInventory.map((item) => {
                const isSelected = selected?.key === item.key
                const status = getInventoryStatus(item)
                const pluginId = item.plugin.pluginId
                const detailsId = `plugin-details-${encodeURIComponent(pluginId)}`
                const busy = pluginBusyId === pluginId || pluginInventoryBusy
                const canCustomize = item.plugin.source !== 'builtin' && item.plugin.source !== 'system'
                return (
                  <div
                    className={`plugin-item plugin-inventory-item${isSelected ? ' selected' : ''}`}
                    key={item.key}
                  >
                    <div className="plugin-card-main">
                      <span className="plugin-avatar plugin-avatar-v2">{pluginInitials(item.plugin.name)}</span>
                      <div className="plugin-card-copy">
                        <div className="plugin-card-title-row">
                          <strong>{item.plugin.name}</strong>
                          {item.plugin.source === 'dynamic' ? (
                            <span className="plugin-ai-badge">✦ {isZh ? 'AI 创建' : 'AI created'}</span>
                          ) : null}
                        </div>
                        <p>{item.plugin.description || (isZh ? '暂无插件说明' : 'No description provided')}</p>
                        <div className="plugin-card-meta">
                          <span>{item.plugin.version}</span>
                          <span>·</span>
                          <span>{isZh ? '来源：' : 'Source: '}{sourceLabel(item.plugin.source, isZh)}</span>
                          <span>·</span><span>{item.plugin.revisionCount} revisions</span>
                        </div>
                      </div>
                      <div className="plugin-card-state">
                        <span className={`plugin-status plugin-status-${status === 'attention' ? 'error' : status}`}>
                          <i aria-hidden="true" />{statusLabel(status, isZh)}
                        </span>
                        <label className="plugin-switch plugin-toggle-row">
                          <input
                            aria-label={isZh ? `启用 ${item.plugin.name}` : `Enable ${item.plugin.name}`}
                            checked={item.plugin.enabled}
                            disabled={busy || item.plugin.quarantined}
                            onChange={(event) => onSetPluginV2Enabled(item.plugin, event.target.checked)}
                            type="checkbox"
                          />
                          <span aria-hidden="true" />
                        </label>
                        <button
                          aria-controls={detailsId}
                          aria-expanded={isSelected}
                          aria-label={isZh
                            ? `${isSelected ? '收起' : '查看'} ${item.plugin.name} 详情`
                            : `${isSelected ? 'Hide' : 'View'} details for ${item.plugin.name}`}
                          className="plugin-details-toggle"
                          onClick={() => setSelectedKey(isSelected ? null : item.key)}
                          type="button"
                        >
                          {isZh ? (isSelected ? '收起' : '详情') : (isSelected ? 'Hide' : 'Details')}
                          <span className="plugin-details-chevron" aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    <div className="plugin-item-actions">
                      {canCustomize ? (
                        <button className="plugin-ai-action" disabled={busy} onClick={() => openPluginCustomizer(item.plugin)} type="button">
                          <span aria-hidden="true">✦</span>{isZh ? '通过 AI 继续定制' : 'Customize with AI'}
                        </button>
                      ) : null}
                      {item.plugin.quarantined ? (
                        <button className="plugin-text-action" disabled={busy} onClick={() => onRecoverPluginV2Installation(item.plugin.pluginId)} type="button">
                          {isZh ? '解除隔离' : 'Clear quarantine'}
                        </button>
                      ) : null}
                      {item.plugin.enabled && !item.plugin.activeRunId && !item.plugin.quarantined ? (
                        <button className="plugin-text-action" disabled={busy} onClick={() => onSetPluginV2Enabled(item.plugin, true)} type="button">
                          {isZh ? '重新启动' : 'Restart'}
                        </button>
                      ) : null}
                    </div>

                    {status === 'attention' ? (
                      <p className="plugin-error">{errorDetail(item.plugin.quarantineReason ?? item.plugin.lastError)}</p>
                    ) : null}
                    {isSelected ? (
                      <section className="plugin-inspector plugin-inline-details" id={detailsId} aria-label={isZh ? `${item.plugin.name} 详情` : `Details for ${item.plugin.name}`}>
                        <V2PluginInspector
                          busy={busy}
                          details={pluginV2Details?.pluginId === pluginId ? pluginV2Details : null}
                          detailsError={pluginV2DetailsError}
                          detailsLoading={pluginV2DetailsLoading}
                          isZh={isZh}
                          onCustomize={() => openPluginCustomizer(item.plugin)}
                          onReloadDetails={() => setPluginV2DetailsReload((current) => current + 1)}
                          onRecover={() => onRecoverPluginV2Installation(pluginId)}
                          onRemove={() => onRemovePluginV2(item.plugin)}
                          onSetEnabled={(enabled) => onSetPluginV2Enabled(item.plugin, enabled)}
                          plugin={item.plugin}
                        />
                      </section>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="plugin-empty-state">
              <span aria-hidden="true">⌕</span>
              <strong>{inventory.length === 0 ? ui.noDynamicPlugins : (isZh ? '没有匹配的插件' : 'No matching plugins')}</strong>
              {inventory.length > 0 ? <p>{isZh ? '试试其他关键词或筛选条件。' : 'Try another keyword or filter.'}</p> : null}
            </div>
          )}
        </article>
      </div>

      {systemPlugins.length > 0 ? (
        <section className="panel plugin-security-requests">
          <div className="plugin-section-title">
            <div><span>System Plugin v3</span><h4>{isZh ? '已安装的 Full Trust 插件' : 'Installed Full Trust plugins'}</h4></div>
            <div className="plugin-item-actions">
              <button className="secondary-button" onClick={onRestartInSystemPluginSafeMode} type="button">{isZh ? '安全模式重启' : 'Restart in safe mode'}</button>
              <strong>{systemPlugins.length}</strong>
            </div>
          </div>
          <div className="system-plugin-request-list">
            {systemPlugins.map((plugin) => {
              const busy = pluginBusyId === plugin.pluginId || pluginInventoryBusy
              const failureStages = getSystemPluginFailureStages(plugin.lastError)
              const serviceRun = plugin.recentRuns.find((run) => (
                run.component === 'service' || run.component === 'detached'
              ))
              const mainRun = plugin.recentRuns.find((run) => run.component === 'main')
              const mainRunPackage = plugin.availablePackages.find((candidate) => candidate.packageId === mainRun?.packageId)
              const serviceRunning = serviceRun?.status === 'starting'
                || serviceRun?.status === 'ready'
                || serviceRun?.status === 'stopping'
              const osPersistence = plugin.osPersistence
              // The database record id survives removal and a new request.
              // A fresh review must start with empty acknowledgement controls.
              const osPersistenceReviewKey = osPersistence
                ? JSON.stringify([osPersistence.id, osPersistence.revisionHash, osPersistence.updatedAt])
                : ''
              const canRequestOsPersistence = plugin.status === 'active'
                && serviceRun?.component === 'detached'
                && plugin.riskDeclarations.includes('os-persistence')
                && (!osPersistence
                  || osPersistence.status === 'removed'
                  || osPersistence.status === 'cancelled')
              const rollbackTarget = plugin.availablePackages.find((candidate) => (
                candidate.status === 'ready'
                && candidate.artifactSha256 !== plugin.currentArtifactSha256
                && candidate.artifactSha256 !== plugin.pendingArtifactSha256
              ))
              return (
                <div className="system-plugin-request" key={`full-trust:${plugin.pluginId}`}>
                  <div className="plugin-item-head">
                    <div><strong>{plugin.name}</strong><p>{plugin.publisher} · {plugin.pluginId}</p></div>
                    <span className={`plugin-status ${plugin.safeModeDisabled || plugin.lastError ? 'plugin-status-error' : plugin.enabled ? 'plugin-status-running' : 'plugin-status-disabled'}`}>{plugin.status}</span>
                  </div>
                  {plugin.description ? <p>{plugin.description}</p> : null}
                  <code>{isZh ? '当前' : 'Current'}: {plugin.currentVersion ?? '—'} · {plugin.currentArtifactSha256 ?? '—'}</code>
                  {plugin.pendingVersion ? <code>{isZh ? '待生效' : 'Pending'}: {plugin.pendingVersion} · {plugin.pendingArtifactSha256}</code> : null}
                  <code>{plugin.riskDeclarations.join(' · ')}</code>
                  {plugin.backupPath ? <code>{isZh ? '安全备份' : 'Safety backup'}: {plugin.backupPath}</code> : null}
                  {plugin.status === 'uninstall-pending' ? <p>{plugin.preserveDataOnUninstall
                    ? (isZh ? '重启后卸载，保留插件专属数据。' : 'Uninstall after restart; private data will be retained.')
                    : (isZh ? '重启后卸载并删除插件专属数据。' : 'Uninstall after restart and delete private data.')}</p> : null}
                  {plugin.lastRun ? <code>{isZh ? '最近运行' : 'Last run'}: {plugin.lastRun.component} · {plugin.lastRun.status} · PID {plugin.lastRun.pid ?? '—'}</code> : null}
                  <SystemPluginRuntimeStatus plugin={plugin} isZh={isZh} />
                  {mainRun?.logPath ? (
                    <div className="plugin-inspector-note" data-testid="system-plugin-main-log">
                      <strong>{isZh ? '主进程运行日志' : 'Main process run log'}</strong>
                      <code>{isZh ? '日志所属修订' : 'Log revision'}: {mainRunPackage ? `sha256:${mainRunPackage.artifactSha256}` : mainRun.packageId}</code>
                      <code>{mainRun.logPath}</code>
                    </div>
                  ) : null}
                  <SystemPluginResources resources={plugin.managedResources} isZh={isZh} />
                  {serviceRun ? (
                    <div className="plugin-inspector-note">
                      <strong>{serviceRun.component === 'detached' ? 'Detached service' : 'App-lifetime service'} · {serviceRun.status}</strong>
                      <code>PID {serviceRun.pid ?? '—'} · {isZh ? '重启' : 'restarts'} {serviceRun.restartCount}</code>
                      <code>{isZh ? '心跳' : 'heartbeat'}: {serviceRun.lastHeartbeatAt ?? '—'} · {isZh ? '退出' : 'exit'}: {serviceRun.exitCode ?? serviceRun.exitSignal ?? '—'}</code>
                      {serviceRun.logPath ? <code>{serviceRun.logPath}</code> : null}
                    </div>
                  ) : null}
                  {osPersistence ? (
                    <div className="plugin-inspector-note">
                      <strong>{isZh ? '系统登录启动' : 'OS login startup'} · {osPersistence.status}</strong>
                      <code>{osPersistence.method} · {osPersistence.serviceId}</code>
                      <code>{osPersistence.command.executable} {osPersistence.command.args.join(' ')}</code>
                      <code>{isZh ? '修订' : 'Revision'}: {osPersistence.revisionHash}</code>
                      {osPersistence.error ? <p className="plugin-error">{errorDetail(osPersistence.error)}</p> : null}
                      {osPersistence.status === 'awaiting-confirmation' ? (
                        <>
                          <label className="toggle-row system-plugin-acknowledgement">
                            <input
                              checked={Boolean(osPersistenceAcknowledgements[osPersistenceReviewKey])}
                              onChange={(event) => setOsPersistenceAcknowledgements((current) => ({
                                ...current,
                                [osPersistenceReviewKey]: event.target.checked
                              }))}
                              type="checkbox"
                            />
                            <span>{isZh
                              ? '我已核对上方精确可执行文件、参数和 service id，并同意 KnowBook 在系统登录时启动以恢复该 detached 服务。此确认独立于插件安装确认。'
                              : 'I reviewed the exact executable, arguments, and service id, and allow KnowBook to start at login to restore this detached service. This is separate from plugin installation approval.'}</span>
                          </label>
                          <label className="plugin-field">
                            <span>{isZh ? `再次输入插件 ID：${plugin.pluginId}` : `Type the plugin ID again: ${plugin.pluginId}`}</span>
                            <input
                              autoComplete="off"
                              onChange={(event) => setOsPersistenceIdConfirmations((current) => ({
                                ...current,
                                [osPersistenceReviewKey]: event.target.value
                              }))}
                              spellCheck={false}
                              value={osPersistenceIdConfirmations[osPersistenceReviewKey] ?? ''}
                            />
                          </label>
                          <div className="plugin-item-actions">
                            <button
                              className="danger-button"
                              disabled={busy
                                || !osPersistenceAcknowledgements[osPersistenceReviewKey]
                                || osPersistenceIdConfirmations[osPersistenceReviewKey] !== plugin.pluginId}
                              onClick={() => onResolveSystemPluginOsPersistence(plugin, 'confirm', true)}
                              type="button"
                            >
                              {isZh ? '确认登录启动' : 'Confirm login startup'}
                            </button>
                            <button
                              className="secondary-button"
                              disabled={busy}
                              onClick={() => onResolveSystemPluginOsPersistence(plugin, 'cancel', false)}
                              type="button"
                            >
                              {isZh ? '取消请求' : 'Cancel request'}
                            </button>
                          </div>
                        </>
                      ) : (
                        osPersistence.status !== 'removed' && osPersistence.status !== 'cancelled'
                          ? (
                              <button
                                className="secondary-button"
                                disabled={busy}
                                onClick={() => onRemoveSystemPluginOsPersistence(plugin)}
                                type="button"
                              >
                                {isZh ? '移除登录启动项' : 'Remove login startup'}
                              </button>
                            )
                          : null
                      )}
                    </div>
                  ) : null}
                  {plugin.dependencyJobs.map((job) => (
                    <div className="plugin-inspector-note" key={job.id}>
                      <strong>{job.kind} · {job.status}</strong>
                      <code>{job.command.join(' ')}</code>
                      {job.logPath ? <code>{job.logPath}</code> : null}
                    </div>
                  ))}
                  {plugin.restartRequired ? <p className="plugin-inspector-note">{isZh ? '需要重启 KnowBook 才能完成此状态变更。' : 'Restart KnowBook to complete this state change.'}</p> : null}
                  {plugin.lastError ? <p className="plugin-error">{errorDetail(plugin.lastError)}</p> : null}
                  {failureStages.length > 0 ? <code>{isZh ? '失败阶段' : 'Failure stage'}: {failureStages.join(' · ')}</code> : null}
                  <div className="plugin-item-actions">
                    {serviceRun && plugin.status === 'active' ? (
                      serviceRunning
                        ? <button className="secondary-button" disabled={busy} onClick={() => onStopSystemPluginService(plugin)} type="button">{isZh ? '停止后台服务' : 'Stop service'}</button>
                        : <button className="secondary-button" disabled={busy} onClick={() => onStartSystemPluginService(plugin)} type="button">{isZh ? '启动后台服务' : 'Start service'}</button>
                    ) : null}
                    {canRequestOsPersistence ? (
                      <button className="secondary-button" disabled={busy} onClick={() => onRequestSystemPluginOsPersistence(plugin)} type="button">
                        {isZh ? '申请登录启动' : 'Request login startup'}
                      </button>
                    ) : null}
                    <button className="secondary-button" disabled={busy} onClick={() => onOpenSystemPluginDirectory(plugin, 'data')} type="button">{isZh ? '打开数据目录' : 'Open data'}</button>
                    <button className="secondary-button" disabled={busy} onClick={() => onOpenSystemPluginDirectory(plugin, 'logs')} type="button">{isZh ? '打开日志目录' : 'Open logs'}</button>
                    <button className="secondary-button" disabled={busy || plugin.status === 'uninstall-pending'} onClick={() => onSetSystemPluginEnabled(plugin, !plugin.enabled)} type="button">
                      {plugin.enabled ? (isZh ? '停用' : 'Disable') : (isZh ? '启用（重启后）' : 'Enable after restart')}
                    </button>
                    {plugin.safeModeDisabled ? <button className="secondary-button" disabled={busy} onClick={() => onRecoverSystemPlugin(plugin)} type="button">{isZh ? '解除安全停用' : 'Recover'}</button> : null}
                    {rollbackTarget ? <button className="secondary-button" disabled={busy} onClick={() => onRollbackSystemPlugin(plugin, rollbackTarget.packageId)} type="button">{isZh ? `回滚到 ${rollbackTarget.version}` : `Roll back to ${rollbackTarget.version}`}</button> : null}
                    <button className="danger-button" disabled={busy || plugin.status === 'uninstall-pending'} onClick={() => {
                      uninstallReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
                      setPreserveUninstallData(true)
                      setUninstallTarget(plugin)
                    }} type="button">{isZh ? '卸载' : 'Uninstall'}</button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      {systemPluginInstallRequests.length > 0 ? (
        <section className="panel plugin-security-requests">
          <div className="plugin-section-title">
            <div><span>{isZh ? '安全队列' : 'Security queue'}</span><h4>{isZh ? '系统插件请求' : 'System plugin requests'}</h4></div>
            <strong>{systemPluginInstallRequests.filter((request) => request.status === 'awaiting-confirmation').length}</strong>
          </div>
          <div className="system-plugin-request-list">
            {systemPluginInstallRequests.map((request) => (
              <div className="system-plugin-request" key={`system:${request.id}`}>
                <div className="plugin-item-head">
                  <div><strong>{request.name}</strong><p>{request.publisher} · {request.version}</p></div>
                  <span className={`plugin-status ${request.status === 'awaiting-confirmation' ? 'plugin-status-error' : 'plugin-status-disabled'}`}>{request.status}</span>
                </div>
                <p>{request.reason}</p>
                <code>SHA-256: {request.artifactSha256}</code>
                <code>{request.systemPermissions.join(' · ')}</code>
                {request.dependencyPlan ? <code>{isZh ? '依赖计划' : 'Dependency plan'}: {JSON.stringify(request.dependencyPlan)}</code> : null}
                {request.error ? <p className="plugin-error">{errorDetail(request.error)}</p> : null}
                {request.status === 'awaiting-confirmation' ? (
                  <>
                    <label className="toggle-row system-plugin-acknowledgement">
                      <input
                        checked={Boolean(systemAcknowledgements[request.id])}
                        onChange={(event) => setSystemAcknowledgements((current) => ({ ...current, [request.id]: event.target.checked }))}
                        type="checkbox"
                      />
                      <span>{isZh ? '我核对了上方精确 SHA-256，并理解 Full Trust 可读取密钥、泄露数据、损坏数据库、执行任意代码或导致主进程崩溃；此风险声明不是安全边界。' : 'I verified the exact SHA-256 and understand Full Trust can read secrets, exfiltrate data, corrupt the database, execute arbitrary code, or crash the main process; this disclosure is not a security boundary.'}</span>
                    </label>
                    <label className="plugin-field">
                      <span>{isZh ? `输入完整插件 ID 以确认：${request.pluginId}` : `Type the exact plugin ID to confirm: ${request.pluginId}`}</span>
                      <input
                        autoComplete="off"
                        onChange={(event) => setSystemPluginIdConfirmations((current) => ({ ...current, [request.id]: event.target.value }))}
                        spellCheck={false}
                        value={systemPluginIdConfirmations[request.id] ?? ''}
                      />
                    </label>
                    <div className="plugin-item-actions">
                      <button className="danger-button" disabled={!systemAcknowledgements[request.id] || systemPluginIdConfirmations[request.id] !== request.pluginId} onClick={() => onResolveSystemPluginInstallRequest(request.id, request.pluginId, request.artifactSha256, 'confirm', true)} type="button">
                        {isZh ? '确认系统安装' : 'Confirm system install'}
                      </button>
                      <button className="secondary-button" onClick={() => onResolveSystemPluginInstallRequest(request.id, request.pluginId, request.artifactSha256, 'cancel', false)} type="button">
                        {isZh ? '取消' : 'Cancel'}
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {uninstallTarget ? (
        <div className="plugin-customizer-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setUninstallTarget(null)
        }}>
          <aside className="plugin-customizer system-plugin-request system-plugin-uninstall-dialog" role="dialog" aria-modal="true"
            aria-labelledby="system-plugin-uninstall-title" ref={uninstallDialogRef} tabIndex={-1}>
            <h3 id="system-plugin-uninstall-title">{isZh ? `卸载“${uninstallTarget.name}”` : `Uninstall "${uninstallTarget.name}"`}</h3>
            <p>{isZh ? '插件将立即停用，代码和日志在重启后清理。请选择如何处理插件专属数据。' : 'The plugin stops immediately; code and logs are removed after restart. Choose what happens to its private data.'}</p>
            <code>{uninstallTarget.dataPath}</code>
            <label><input type="radio" name="system-plugin-uninstall-data" checked={preserveUninstallData} onChange={() => setPreserveUninstallData(true)} />{isZh ? '保留数据，重新安装时继续使用' : 'Keep data for a future reinstall'}</label>
            <label><input type="radio" name="system-plugin-uninstall-data" checked={!preserveUninstallData} onChange={() => setPreserveUninstallData(false)} />{isZh ? '同时删除插件专属数据' : 'Also delete plugin data'}</label>
            <p>{isZh ? '知识库文档、任意设置及插件写到其他目录的文件不会自动撤销；数据库安全备份会保留。' : 'Workspace documents, arbitrary settings and files written elsewhere are not reverted. Database safety backups are retained.'}</p>
            <div className="plugin-toolbar">
              <button className="secondary-button" data-uninstall-cancel onClick={() => setUninstallTarget(null)} type="button">{isZh ? '取消' : 'Cancel'}</button>
              <button className="danger-button" onClick={() => {
                onUninstallSystemPlugin(uninstallTarget, preserveUninstallData)
                setUninstallTarget(null)
              }} type="button">{isZh ? '确认卸载' : 'Confirm uninstall'}</button>
            </div>
          </aside>
        </div>
      ) : null}

      {customizingPlugin ? (
        <div className="plugin-customizer-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setCustomizingPlugin(null)
        }}>
          <aside
            aria-label={isZh ? 'AI 插件定制' : 'AI plugin customization'}
            aria-modal="true"
            className="plugin-customizer"
            ref={customizerDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <div className="plugin-customizer-title">
                <span className="plugin-avatar plugin-avatar-v2">{pluginInitials(customizingPlugin.name)}</span>
                <div><span>✦ {isZh ? 'AI 插件工作台' : 'AI plugin workbench'}</span><h3>{customizingPlugin.name}</h3></div>
              </div>
              <button aria-label={isZh ? '关闭' : 'Close'} className="plugin-customizer-close" onClick={() => setCustomizingPlugin(null)} type="button">×</button>
            </header>
            <div className="plugin-customizer-context">
              <span>{customizingPlugin.pluginId}</span>
              <span>{isZh ? `当前 ${customizingPlugin.version}` : `Current ${customizingPlugin.version}`}</span>
              <span>{customizingPlugin.revisionCount} revisions</span>
            </div>
            <p className="plugin-customizer-intro">{isZh
              ? '描述你想增加、删除或调整的行为。助手会先检查现有实现，再生成并验证新 revision；应用前会清楚展示变更与权限差异。'
              : 'Describe what to add, remove, or adjust. The assistant inspects the current implementation, creates and validates a new revision, and shows the change and permission diff before applying it.'}</p>
            <AssistantConversation
              activeDocumentId={null}
              aiEnabled={aiEnabled}
              hasApiKey={hasApiKey}
              initialDraft={customizerDraft}
              isZh={isZh}
              key={customizingPlugin.pluginId}
              newSessionTitle={isZh ? `定制 · ${customizingPlugin.name}` : `Customize · ${customizingPlugin.name}`}
              onDraftChange={(draft) => {
                setCustomizerDrafts((current) => current[customizingPlugin.pluginId] === draft
                  ? current
                  : { ...current, [customizingPlugin.pluginId]: draft })
              }}
            />
          </aside>
        </div>
      ) : null}
    </section>
  )
}

function pluginCustomizationDraft(plugin: PluginV2InstallationSummary, isZh: boolean): string {
  return isZh
    ? `请检查并继续定制插件“${plugin.name}”（ID: ${plugin.pluginId}）。先使用 plugins.inspect 查看当前 revision 和诊断，保留未明确要求改动的现有行为，然后根据我的要求创建并验证新的 revision；激活前请清楚展示变更与权限差异。我的定制要求是：`
    : `Inspect and continue customizing plugin "${plugin.name}" (ID: ${plugin.pluginId}). Use plugins.inspect to review the current revision and diagnostics, preserve behavior I do not explicitly change, then create and validate a new revision. Show the change and permission diff before activation. My customization request is: `
}

function V2PluginInspector({
  plugin,
  busy,
  details,
  detailsError,
  detailsLoading,
  isZh,
  onCustomize,
  onReloadDetails,
  onRecover,
  onRemove,
  onSetEnabled
}: {
  plugin: PluginV2InstallationSummary
  busy: boolean
  details: PluginV2Details | null
  detailsError: string | null
  detailsLoading: boolean
  isZh: boolean
  onCustomize: () => void
  onReloadDetails: () => void
  onRecover: () => void
  onRemove: () => void
  onSetEnabled: (enabled: boolean) => void
}) {
  const canCustomize = plugin.source !== 'builtin' && plugin.source !== 'system'
  const canRemove = plugin.source !== 'builtin' && plugin.source !== 'system'
  return (
    <>
      <div className="plugin-inspector-head">
        <span className="plugin-avatar plugin-avatar-v2">{pluginInitials(plugin.name)}</span>
        <div><span>{isZh ? '插件详情 · 来源：' : 'Plugin details · Source: '}{sourceLabel(plugin.source, isZh)}</span><h4>{plugin.name}</h4><code>{plugin.pluginId}</code></div>
      </div>
      <p className="plugin-inspector-description">{plugin.description || (isZh ? '暂无插件说明。' : 'No description provided.')}</p>
      {canCustomize ? (
        <button className="primary-button plugin-inspector-ai" disabled={busy} onClick={onCustomize} type="button">
          <span aria-hidden="true">✦</span>{isZh ? '通过 AI 继续定制' : 'Continue with AI'}
        </button>
      ) : null}
      <div className="plugin-detail-grid">
        <div><span>{isZh ? '版本' : 'Version'}</span><strong>{plugin.version}</strong></div>
        <div><span>Revision</span><strong>{plugin.revisionCount}</strong></div>
        <div><span>{isZh ? '违规记录' : 'Violations'}</span><strong>{plugin.violationCount}</strong></div>
        <div><span>{isZh ? '最近更新' : 'Updated'}</span><strong>{formatUpdatedAt(plugin.updatedAt, isZh)}</strong></div>
      </div>
      <div className="plugin-lifecycle-card">
        <div className="plugin-lifecycle-head"><strong>{isZh ? '生命周期' : 'Lifecycle'}</strong><span>{plugin.enabled ? (isZh ? '已安装' : 'Installed') : (isZh ? '已停用' : 'Disabled')}</span></div>
        <ol>
          <li className="complete"><i /><div><strong>{isZh ? '已安装到工作区' : 'Installed in workspace'}</strong><span>{sourceLabel(plugin.source, isZh)}</span></div></li>
          <li className={plugin.currentRevisionId ? 'complete' : ''}><i /><div><strong>{isZh ? '当前 revision' : 'Current revision'}</strong><code>{compactRevision(plugin.currentRevisionId)}</code></div></li>
          <li className={plugin.activeRunId ? 'active' : plugin.quarantined || plugin.lastError ? 'error' : ''}><i /><div><strong>{plugin.activeRunId ? (isZh ? '运行实例健康' : 'Runtime healthy') : (isZh ? '当前没有运行实例' : 'No active runtime')}</strong><span>{plugin.quarantined ? (isZh ? '安全隔离中' : 'Security quarantine') : plugin.enabled ? (isZh ? '可重新启动' : 'Ready to restart') : (isZh ? '已由你停用' : 'Disabled by you')}</span></div></li>
        </ol>
      </div>
      <PluginV2TechnicalDetails
        details={details}
        error={detailsError}
        isZh={isZh}
        loading={detailsLoading}
        onReload={onReloadDetails}
      />
      {plugin.quarantined || plugin.lastError ? <p className="plugin-inspector-error">{errorDetail(plugin.quarantineReason ?? plugin.lastError)}</p> : null}
      <div className="plugin-inspector-actions">
        {plugin.quarantined ? <button className="secondary-button" disabled={busy} onClick={onRecover} type="button">{isZh ? '解除安全隔离' : 'Clear quarantine'}</button> : null}
        <button className="secondary-button" disabled={busy || plugin.quarantined} onClick={() => onSetEnabled(!plugin.enabled)} type="button">{plugin.enabled ? (isZh ? '停用插件' : 'Disable plugin') : (isZh ? '启用插件' : 'Enable plugin')}</button>
        {canRemove ? <button className="danger-button" disabled={busy} onClick={onRemove} type="button">{isZh ? '卸载插件' : 'Uninstall plugin'}</button> : null}
      </div>
      {!canRemove ? <p className="plugin-inspector-note">{isZh ? '内置或系统插件可以停用，但不能在这里卸载。' : 'Built-in and system plugins can be disabled, but not uninstalled here.'}</p> : null}
    </>
  )
}
