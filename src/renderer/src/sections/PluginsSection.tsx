import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  PluginDescriptor,
  PluginSettingDescriptor,
  PluginSettingValue,
  PluginV2Details,
  PluginV2InstallationSummary,
  SystemPluginInstallRequest
} from '@shared/contracts'
import type { UiText } from '../i18n'
import { AssistantConversation } from '../components/AssistantConversation'
import { PluginV2TechnicalDetails } from '../components/PluginV2TechnicalDetails'
import { trapFocusWithinDialog } from '../utils/dialogFocus'
import './plugins-section.css'

type PluginFilter = 'all' | 'running' | 'disabled' | 'attention'

type InventoryPlugin =
  | { key: string; kind: 'legacy'; plugin: PluginDescriptor }
  | { key: string; kind: 'v2'; plugin: PluginV2InstallationSummary }

type PluginsSectionProps = {
  ui: UiText
  aiEnabled: boolean
  hasApiKey: boolean
  pluginRoots: string[]
  plugins: PluginDescriptor[]
  pluginV2Installations: PluginV2InstallationSummary[]
  systemPluginInstallRequests: SystemPluginInstallRequest[]
  pluginBusyId: string | null
  pluginSettingBusyKey: string | null
  pluginSettingDrafts: Record<string, PluginSettingValue>
  pluginInventoryBusy: boolean
  onReloadPlugins: () => void
  onInstallPluginFromFolder: () => void
  onReloadPlugin: (plugin: PluginDescriptor) => void
  onSetPluginEnabled: (plugin: PluginDescriptor, enabled: boolean) => void
  onRemovePlugin: (plugin: PluginDescriptor) => void
  onSetPluginV2Enabled: (plugin: PluginV2InstallationSummary, enabled: boolean) => void
  onRemovePluginV2: (plugin: PluginV2InstallationSummary) => void
  onUpdatePluginSettingDraft: (pluginId: string, settingId: string, value: PluginSettingValue) => void
  onUpdatePluginSetting: (plugin: PluginDescriptor, setting: PluginSettingDescriptor, value: PluginSettingValue) => void
  onRecoverPluginV2Installation: (pluginId: string) => void
  onResolveSystemPluginInstallRequest: (
    requestId: string,
    pluginId: string,
    decision: 'confirm' | 'cancel',
    acknowledgeSystemAccess: boolean
  ) => void
}

function getPluginSettingDraftKey(pluginId: string, settingId: string): string {
  return `${pluginId}:${settingId}`
}

function getInventoryStatus(item: InventoryPlugin): 'running' | 'disabled' | 'attention' | 'stopped' | 'loading' {
  if (item.kind === 'legacy') {
    if (item.plugin.status === 'error') return 'attention'
    if (item.plugin.status === 'disabled') return 'disabled'
    return item.plugin.status
  }
  if (item.plugin.quarantined || item.plugin.lastError) return 'attention'
  if (!item.plugin.enabled) return 'disabled'
  return item.plugin.activeRunId ? 'running' : 'stopped'
}

function statusLabel(status: ReturnType<typeof getInventoryStatus>, isZh: boolean): string {
  const labels = {
    running: isZh ? '运行中' : 'Running',
    loading: isZh ? '启动中' : 'Starting',
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
  pluginRoots,
  plugins,
  pluginV2Installations,
  systemPluginInstallRequests,
  pluginBusyId,
  pluginSettingBusyKey,
  pluginSettingDrafts,
  pluginInventoryBusy,
  onReloadPlugins,
  onInstallPluginFromFolder,
  onReloadPlugin,
  onSetPluginEnabled,
  onRemovePlugin,
  onSetPluginV2Enabled,
  onRemovePluginV2,
  onUpdatePluginSettingDraft,
  onUpdatePluginSetting,
  onRecoverPluginV2Installation,
  onResolveSystemPluginInstallRequest
}: PluginsSectionProps) {
  const isZh = ui.language === 'zh-CN'
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PluginFilter>('all')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [customizingPlugin, setCustomizingPlugin] = useState<PluginV2InstallationSummary | null>(null)
  const [customizerDrafts, setCustomizerDrafts] = useState<Record<string, string>>({})
  const [systemAcknowledgements, setSystemAcknowledgements] = useState<Record<string, boolean>>({})
  const [pluginV2Details, setPluginV2Details] = useState<PluginV2Details | null>(null)
  const [pluginV2DetailsLoading, setPluginV2DetailsLoading] = useState(false)
  const [pluginV2DetailsError, setPluginV2DetailsError] = useState<string | null>(null)
  const [pluginV2DetailsReload, setPluginV2DetailsReload] = useState(0)
  const customizerDialogRef = useRef<HTMLElement>(null)
  const customizerReturnFocusRef = useRef<HTMLElement | null>(null)

  const inventory = useMemo<InventoryPlugin[]>(() => [
    ...plugins.map((plugin) => ({ key: `legacy:${plugin.id}`, kind: 'legacy' as const, plugin })),
    ...pluginV2Installations.map((plugin) => ({ key: `v2:${plugin.pluginId}`, kind: 'v2' as const, plugin }))
  ], [pluginV2Installations, plugins])

  const selected = inventory.find((item) => item.key === selectedKey) ?? inventory[0] ?? null
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredInventory = inventory.filter((item) => {
    const status = getInventoryStatus(item)
    const matchesFilter = filter === 'all'
      || (filter === 'attention' ? status === 'attention' : status === filter)
    const name = item.plugin.name.toLocaleLowerCase()
    const id = (item.kind === 'legacy' ? item.plugin.id : item.plugin.pluginId).toLocaleLowerCase()
    const description = item.plugin.description.toLocaleLowerCase()
    return matchesFilter && (!normalizedQuery || `${name} ${id} ${description}`.includes(normalizedQuery))
  })
  const runningCount = inventory.filter((item) => getInventoryStatus(item) === 'running').length
  const attentionCount = inventory.filter((item) => getInventoryStatus(item) === 'attention').length
  const aiCreatedCount = pluginV2Installations.filter((plugin) => plugin.source === 'dynamic').length

  useEffect(() => {
    if (selectedKey && !inventory.some((item) => item.key === selectedKey)) setSelectedKey(null)
  }, [inventory, selectedKey])

  const selectedV2DetailsKey = selected?.kind === 'v2'
    ? [
        selected.plugin.pluginId,
        selected.plugin.updatedAt,
        selected.plugin.currentRevisionId,
        selected.plugin.activeRunId,
        selected.plugin.revisionCount
      ].join(':')
    : null

  useEffect(() => {
    if (!selectedV2DetailsKey || selected?.kind !== 'v2') {
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
          <button className="secondary-button" disabled={pluginInventoryBusy} onClick={onReloadPlugins} type="button">
            <span aria-hidden="true">↻</span>
            {pluginInventoryBusy ? ui.common.reloading : ui.common.reload}
          </button>
          <button className="primary-button" disabled={pluginInventoryBusy} onClick={onInstallPluginFromFolder} type="button">
            <span aria-hidden="true">＋</span>
            {pluginInventoryBusy ? ui.common.working : ui.installFolder}
          </button>
        </div>
      </header>

      <div className="plugin-overview-grid" aria-label={isZh ? '插件概览' : 'Plugin overview'}>
        <div className="plugin-overview-card">
          <span>{isZh ? '已安装' : 'Installed'}</span>
          <strong>{inventory.length}</strong>
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
              <h4>{isZh ? '我的插件' : 'My plugins'}</h4>
              <p>{isZh ? '选择插件查看详情和生命周期操作' : 'Select a plugin to inspect and manage it'}</p>
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
                const pluginId = item.kind === 'legacy' ? item.plugin.id : item.plugin.pluginId
                const busy = pluginBusyId === pluginId || pluginInventoryBusy
                const canCustomize = item.kind === 'v2' && item.plugin.source !== 'builtin' && item.plugin.source !== 'system'
                return (
                  <div
                    aria-selected={isSelected}
                    className={`plugin-item plugin-inventory-item${isSelected ? ' selected' : ''}`}
                    key={item.key}
                    onClick={() => setSelectedKey(item.key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelectedKey(item.key)
                      }
                    }}
                    role="option"
                    tabIndex={0}
                  >
                    <div className="plugin-card-main">
                      <span className={`plugin-avatar plugin-avatar-${item.kind}`}>{pluginInitials(item.plugin.name)}</span>
                      <div className="plugin-card-copy">
                        <div className="plugin-card-title-row">
                          <strong>{item.plugin.name}</strong>
                          {item.kind === 'legacy' ? (
                            <span className="plugin-status plugin-status-legacy">Legacy v1</span>
                          ) : item.plugin.source === 'dynamic' ? (
                            <span className="plugin-ai-badge">✦ {isZh ? 'AI 创建' : 'AI created'}</span>
                          ) : null}
                        </div>
                        <p>{item.plugin.description || (isZh ? '暂无插件说明' : 'No description provided')}</p>
                        <div className="plugin-card-meta">
                          <span>{item.plugin.version}</span>
                          <span>·</span>
                          <span>{item.kind === 'legacy' ? ui.pluginSourceLabel(item.plugin.source) : sourceLabel(item.plugin.source, isZh)}</span>
                          {item.kind === 'v2' ? <><span>·</span><span>{item.plugin.revisionCount} revisions</span></> : null}
                        </div>
                      </div>
                      <div className="plugin-card-state">
                        <span className={`plugin-status plugin-status-${status === 'attention' ? 'error' : status}`}>
                          <i aria-hidden="true" />{statusLabel(status, isZh)}
                        </span>
                        <label className="plugin-switch plugin-toggle-row" onClick={(event) => event.stopPropagation()}>
                          <input
                            aria-label={isZh ? `启用 ${item.plugin.name}` : `Enable ${item.plugin.name}`}
                            checked={item.plugin.enabled}
                            disabled={busy || (item.kind === 'v2' && item.plugin.quarantined)}
                            onChange={(event) => {
                              if (item.kind === 'legacy') onSetPluginEnabled(item.plugin, event.target.checked)
                              else onSetPluginV2Enabled(item.plugin, event.target.checked)
                            }}
                            type="checkbox"
                          />
                          <span aria-hidden="true" />
                        </label>
                      </div>
                    </div>

                    <div className="plugin-item-actions" onClick={(event) => event.stopPropagation()}>
                      {canCustomize && item.kind === 'v2' ? (
                        <button className="plugin-ai-action" disabled={busy} onClick={() => openPluginCustomizer(item.plugin)} type="button">
                          <span aria-hidden="true">✦</span>{isZh ? '通过 AI 继续定制' : 'Customize with AI'}
                        </button>
                      ) : null}
                      {item.kind === 'legacy' ? (
                        <button className="plugin-text-action plugin-reload-button" disabled={busy} onClick={() => onReloadPlugin(item.plugin)} type="button">
                          {busy ? ui.common.working : item.plugin.status === 'error' ? ui.recover : ui.common.reload}
                        </button>
                      ) : null}
                      {item.kind === 'v2' && item.plugin.quarantined ? (
                        <button className="plugin-text-action" disabled={busy} onClick={() => onRecoverPluginV2Installation(item.plugin.pluginId)} type="button">
                          {isZh ? '解除隔离' : 'Clear quarantine'}
                        </button>
                      ) : null}
                      {item.kind === 'v2' && item.plugin.enabled && !item.plugin.activeRunId && !item.plugin.quarantined ? (
                        <button className="plugin-text-action" disabled={busy} onClick={() => onSetPluginV2Enabled(item.plugin, true)} type="button">
                          {isZh ? '重新启动' : 'Restart'}
                        </button>
                      ) : null}
                    </div>

                    {item.kind === 'legacy' && isSelected && item.plugin.settings.length > 0 ? (
                      <PluginSettings
                        plugin={item.plugin}
                        pluginBusyId={pluginBusyId}
                        pluginInventoryBusy={pluginInventoryBusy}
                        pluginSettingBusyKey={pluginSettingBusyKey}
                        pluginSettingDrafts={pluginSettingDrafts}
                        ui={ui}
                        onUpdatePluginSetting={onUpdatePluginSetting}
                        onUpdatePluginSettingDraft={onUpdatePluginSettingDraft}
                      />
                    ) : null}
                    {status === 'attention' ? (
                      <p className="plugin-error">{item.kind === 'legacy'
                        ? item.plugin.error
                        : errorDetail(item.plugin.quarantineReason ?? item.plugin.lastError)}</p>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="plugin-empty-state">
              <span aria-hidden="true">⌕</span>
              <strong>{isZh ? '没有匹配的插件' : 'No matching plugins'}</strong>
              <p>{isZh ? '试试其他关键词或筛选条件。' : 'Try another keyword or filter.'}</p>
            </div>
          )}
        </article>

        <aside className="panel plugin-inspector">
          {selected ? (
            selected.kind === 'v2' ? (
              <V2PluginInspector
                busy={pluginBusyId === selected.plugin.pluginId || pluginInventoryBusy}
                details={pluginV2Details?.pluginId === selected.plugin.pluginId ? pluginV2Details : null}
                detailsError={pluginV2DetailsError}
                detailsLoading={pluginV2DetailsLoading}
                isZh={isZh}
                onCustomize={() => openPluginCustomizer(selected.plugin)}
                onReloadDetails={() => setPluginV2DetailsReload((current) => current + 1)}
                onRecover={() => onRecoverPluginV2Installation(selected.plugin.pluginId)}
                onRemove={() => onRemovePluginV2(selected.plugin)}
                onSetEnabled={(enabled) => onSetPluginV2Enabled(selected.plugin, enabled)}
                plugin={selected.plugin}
              />
            ) : (
              <LegacyPluginInspector
                busy={pluginBusyId === selected.plugin.id || pluginInventoryBusy}
                isZh={isZh}
                onReload={() => onReloadPlugin(selected.plugin)}
                onRemove={() => onRemovePlugin(selected.plugin)}
                plugin={selected.plugin}
                source={ui.pluginSourceLabel(selected.plugin.source)}
              />
            )
          ) : (
            <div className="plugin-empty-state">
              <span aria-hidden="true">◇</span>
              <strong>{ui.noPluginsDiscovered}</strong>
            </div>
          )}
        </aside>
      </div>

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
                <code>{request.systemPermissions.join(' · ')}</code>
                {request.status === 'awaiting-confirmation' ? (
                  <>
                    <label className="toggle-row system-plugin-acknowledgement">
                      <input
                        checked={Boolean(systemAcknowledgements[request.id])}
                        onChange={(event) => setSystemAcknowledgements((current) => ({ ...current, [request.id]: event.target.checked }))}
                        type="checkbox"
                      />
                      <span>{isZh ? '我理解此插件将获得列出的系统权限，并需要重启。' : 'I understand this plugin receives the listed system permissions and requires a restart.'}</span>
                    </label>
                    <div className="plugin-item-actions">
                      <button className="danger-button" disabled={!systemAcknowledgements[request.id]} onClick={() => onResolveSystemPluginInstallRequest(request.id, request.pluginId, 'confirm', true)} type="button">
                        {isZh ? '确认系统安装' : 'Confirm system install'}
                      </button>
                      <button className="secondary-button" onClick={() => onResolveSystemPluginInstallRequest(request.id, request.pluginId, 'cancel', false)} type="button">
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

      {pluginRoots.length > 0 ? (
        <details className="plugin-roots-disclosure">
          <summary>{isZh ? '插件目录与开发者选项' : 'Plugin roots and developer options'}</summary>
          <div className="plugin-roots">
            {pluginRoots.map((root) => <code className="plugin-root-path" key={root}>{root}</code>)}
          </div>
        </details>
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

type PluginSettingsProps = {
  plugin: PluginDescriptor
  pluginBusyId: string | null
  pluginInventoryBusy: boolean
  pluginSettingBusyKey: string | null
  pluginSettingDrafts: Record<string, PluginSettingValue>
  ui: UiText
  onUpdatePluginSettingDraft: (pluginId: string, settingId: string, value: PluginSettingValue) => void
  onUpdatePluginSetting: (plugin: PluginDescriptor, setting: PluginSettingDescriptor, value: PluginSettingValue) => void
}

function PluginSettings({
  plugin,
  pluginBusyId,
  pluginInventoryBusy,
  pluginSettingBusyKey,
  pluginSettingDrafts,
  ui,
  onUpdatePluginSettingDraft,
  onUpdatePluginSetting
}: PluginSettingsProps) {
  return (
    <div className="plugin-settings-panel" onClick={(event) => event.stopPropagation()}>
      <div className="plugin-settings-heading"><strong>{ui.pluginSettingsLabel}</strong><span>{plugin.settings.length}</span></div>
      <div className="plugin-settings-list">
        {plugin.settings.map((setting) => {
          const draftKey = getPluginSettingDraftKey(plugin.id, setting.id)
          const draftValue = pluginSettingDrafts[draftKey] ?? setting.value
          const hasPendingChanges = draftValue !== setting.value
          const isSettingBusy = pluginSettingBusyKey === draftKey
          const disabled = pluginInventoryBusy || pluginBusyId === plugin.id || isSettingBusy
          return (
            <div className="plugin-setting-item" key={draftKey}>
              {setting.type === 'checkbox' ? (
                <label className="toggle-row plugin-setting-toggle">
                  <span>{setting.label}</span>
                  <input checked={Boolean(draftValue)} disabled={disabled} onChange={(event) => onUpdatePluginSettingDraft(plugin.id, setting.id, event.target.checked)} type="checkbox" />
                </label>
              ) : (
                <label className="editor-label plugin-setting-field">
                  {setting.label}
                  {setting.type === 'select' ? (
                    <select aria-label={setting.label} className="editor-input" disabled={disabled} onChange={(event) => onUpdatePluginSettingDraft(plugin.id, setting.id, event.target.value)} value={String(draftValue)}>
                      {(setting.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  ) : (
                    <input aria-label={setting.label} className="editor-input" disabled={disabled} onChange={(event) => onUpdatePluginSettingDraft(plugin.id, setting.id, event.target.value)} type="text" value={String(draftValue)} />
                  )}
                </label>
              )}
              {setting.description ? <p className="mini-hint plugin-setting-description">{setting.description}</p> : null}
              <div className="plugin-setting-actions">
                <span className="mini-hint plugin-setting-default">{ui.pluginSettingDefault(setting.defaultValue)}</span>
                <button className="secondary-button" disabled={disabled || !hasPendingChanges} onClick={() => onUpdatePluginSetting(plugin, setting, draftValue)} type="button">
                  {isSettingBusy ? ui.common.working : ui.savePluginSetting(setting.label)}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
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
        <div><span>{sourceLabel(plugin.source, isZh)}</span><h4>{plugin.name}</h4><code>{plugin.pluginId}</code></div>
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

function LegacyPluginInspector({
  plugin,
  busy,
  isZh,
  source,
  onReload,
  onRemove
}: {
  plugin: PluginDescriptor
  busy: boolean
  isZh: boolean
  source: string
  onReload: () => void
  onRemove: () => void
}) {
  return (
    <>
      <div className="plugin-inspector-head">
        <span className="plugin-avatar plugin-avatar-legacy">{pluginInitials(plugin.name)}</span>
        <div><span>Legacy v1 · {source}</span><h4>{plugin.name}</h4><code>{plugin.id}</code></div>
      </div>
      <p className="plugin-inspector-description">{plugin.description}</p>
      <div className="plugin-detail-grid">
        <div><span>{isZh ? '版本' : 'Version'}</span><strong>{plugin.version}</strong></div>
        <div><span>{isZh ? '配置项' : 'Settings'}</span><strong>{plugin.settings.length}</strong></div>
        <div><span>{isZh ? '作者' : 'Author'}</span><strong>{plugin.author ?? '—'}</strong></div>
        <div><span>{isZh ? '状态' : 'Status'}</span><strong>{statusLabel(getInventoryStatus({ key: '', kind: 'legacy', plugin }), isZh)}</strong></div>
      </div>
      <div className="plugin-inspector-actions">
        <button className="secondary-button" disabled={busy} onClick={onReload} type="button">{plugin.status === 'error' ? (isZh ? '尝试恢复' : 'Try recovery') : (isZh ? '重载插件' : 'Reload plugin')}</button>
        {plugin.source === 'user-data' ? <button className="danger-button plugin-remove-button" disabled={busy} onClick={onRemove} type="button">{isZh ? '卸载插件' : 'Uninstall plugin'}</button> : null}
      </div>
      <p className="plugin-inspector-note">{isZh ? 'Legacy v1 插件由本地文件夹加载；AI 对话定制仅适用于 Plugin Platform v2。' : 'Legacy v1 plugins load from local folders. AI customization is available for Plugin Platform v2.'}</p>
    </>
  )
}
