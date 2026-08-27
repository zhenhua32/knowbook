import { useState } from 'react'
import type {
  PluginDescriptor,
  PluginSettingDescriptor,
  PluginSettingValue,
  PluginV2InstallationSummary,
  SystemPluginInstallRequest
} from '@shared/contracts'
import type { UiText } from '../i18n'

type PluginsSectionProps = {
  ui: UiText
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

export function PluginsSection({
  ui,
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
  onUpdatePluginSettingDraft,
  onUpdatePluginSetting,
  onRecoverPluginV2Installation,
  onResolveSystemPluginInstallRequest
}: PluginsSectionProps) {
  const [systemAcknowledgements, setSystemAcknowledgements] = useState<Record<string, boolean>>({})
  return (
    <section className="detail-grid">
      <article className="panel large-panel">
        <div className="panel-head">
          <div>
            <p className="panel-label">{ui.pluginsLabel}</p>
            <h3>{ui.pluginsTitle}</h3>
          </div>
          <div className="plugin-toolbar">
            <button className="secondary-button" disabled={pluginInventoryBusy} onClick={onReloadPlugins} type="button">
              {pluginInventoryBusy ? ui.common.reloading : ui.common.reload}
            </button>
            <button className="secondary-button" disabled={pluginInventoryBusy} onClick={onInstallPluginFromFolder} type="button">
              {pluginInventoryBusy ? ui.common.working : ui.installFolder}
            </button>
          </div>
        </div>
        {pluginRoots.length > 0 ? (
          <div className="plugin-roots">
            {pluginRoots.map((root) => (
              <code className="plugin-root-path" key={root}>{root}</code>
            ))}
          </div>
        ) : null}
        {plugins.length > 0 ? (
          <div className="plugin-list">
            {plugins.map((plugin) => {
              const statusLabel = ui.pluginStatusLabel(plugin.status)

              return (
                <div className="plugin-item" key={plugin.id}>
                  <div className="plugin-item-head">
                    <div>
                      <strong>{plugin.name}</strong>
                      <span className="plugin-status plugin-status-legacy">Legacy v1</span>
                      <p className="mini-hint">{plugin.description}</p>
                    </div>
                    <span className={`plugin-status plugin-status-${plugin.status}`}>{statusLabel}</span>
                  </div>
                  <div className="plugin-item-meta">
                    <span>{plugin.version}</span>
                    <span>{ui.pluginSourceLabel(plugin.source)}</span>
                    {plugin.author ? <span>{plugin.author}</span> : null}
                  </div>
                  {plugin.error ? <p className="plugin-error">{plugin.error}</p> : null}
                  <div className="plugin-item-actions">
                    <button
                      className="secondary-button plugin-reload-button"
                      disabled={pluginBusyId === plugin.id || pluginInventoryBusy}
                      onClick={() => onReloadPlugin(plugin)}
                      type="button"
                    >
                      {pluginBusyId === plugin.id ? ui.common.working : plugin.status === 'error' ? ui.recover : ui.common.reload}
                    </button>
                    <label className="toggle-row plugin-toggle-row">
                      <input
                        checked={plugin.enabled}
                        disabled={pluginBusyId === plugin.id || pluginInventoryBusy}
                        onChange={(event) => {
                          onSetPluginEnabled(plugin, event.target.checked)
                        }}
                        type="checkbox"
                      />
                      <span>{ui.pluginToggleLabel(pluginBusyId === plugin.id, plugin.enabled)}</span>
                    </label>
                    {plugin.source === 'user-data' ? (
                      <button
                        className="danger-button plugin-remove-button"
                        disabled={pluginBusyId === plugin.id || pluginInventoryBusy}
                        onClick={() => onRemovePlugin(plugin)}
                        type="button"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                  {plugin.settings.length > 0 ? (
                    <div className="plugin-settings-panel">
                      <p className="panel-label plugin-settings-label">{ui.pluginSettingsLabel}</p>
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
                                  <input
                                    checked={Boolean(draftValue)}
                                    disabled={disabled}
                                    onChange={(event) => {
                                      onUpdatePluginSettingDraft(plugin.id, setting.id, event.target.checked)
                                    }}
                                    type="checkbox"
                                  />
                                  <span>{setting.label}</span>
                                </label>
                              ) : (
                                <label className="editor-label plugin-setting-field">
                                  {setting.label}
                                  {setting.type === 'select' ? (
                                    <select
                                      aria-label={setting.label}
                                      className="editor-input"
                                      disabled={disabled}
                                      onChange={(event) => {
                                        onUpdatePluginSettingDraft(plugin.id, setting.id, event.target.value)
                                      }}
                                      value={String(draftValue)}
                                    >
                                      {(setting.options ?? []).map((option) => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      aria-label={setting.label}
                                      className="editor-input"
                                      disabled={disabled}
                                      onChange={(event) => {
                                        onUpdatePluginSettingDraft(plugin.id, setting.id, event.target.value)
                                      }}
                                      type="text"
                                      value={String(draftValue)}
                                    />
                                  )}
                                </label>
                              )}
                              {setting.description ? <p className="mini-hint plugin-setting-description">{setting.description}</p> : null}
                              <div className="plugin-setting-actions">
                                <span className="mini-hint plugin-setting-default">{ui.pluginSettingDefault(setting.defaultValue)}</span>
                                <button
                                  className="secondary-button"
                                  disabled={disabled || !hasPendingChanges}
                                  onClick={() => {
                                    onUpdatePluginSetting(plugin, setting, draftValue)
                                  }}
                                  type="button"
                                >
                                  {isSettingBusy ? ui.common.working : ui.savePluginSetting(setting.label)}
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : (
                    <p className="mini-hint plugin-settings-empty">{ui.noPluginSettings}</p>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <p className="mini-hint">{ui.noPluginsDiscovered}</p>
        )}
        {pluginV2Installations.length > 0 ? (
          <div className="plugin-list plugin-v2-list">
            {pluginV2Installations.map((plugin) => (
              <div className="plugin-item" key={`v2:${plugin.pluginId}`}>
                <div className="plugin-item-head">
                  <div>
                    <strong>{plugin.name}</strong>
                    <p className="mini-hint">Plugin Platform v2 · {plugin.source}</p>
                  </div>
                  <span className={`plugin-status ${plugin.quarantined ? 'plugin-status-error' : 'plugin-status-running'}`}>
                    {plugin.quarantined ? 'Quarantined' : plugin.activeRunId ? 'Running' : 'Stopped'}
                  </span>
                </div>
                <div className="plugin-item-meta">
                  <span>{plugin.currentRevisionId ?? 'No active revision'}</span>
                  <span>{plugin.violationCount} violations</span>
                </div>
                {plugin.quarantineReason ? <p className="plugin-error">{JSON.stringify(plugin.quarantineReason)}</p> : null}
                {plugin.quarantined ? (
                  <button
                    className="secondary-button"
                    onClick={() => onRecoverPluginV2Installation(plugin.pluginId)}
                    type="button"
                  >
                    Clear quarantine
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {systemPluginInstallRequests.length > 0 ? (
          <div className="plugin-list system-plugin-request-list">
            {systemPluginInstallRequests.map((request) => (
              <div className="plugin-item system-plugin-request" key={`system:${request.id}`}>
                <div className="plugin-item-head">
                  <div>
                    <strong>{request.name}</strong>
                    <p className="mini-hint">高级系统插件 · {request.publisher} · {request.version}</p>
                  </div>
                  <span className={`plugin-status ${request.status === 'awaiting-confirmation' ? 'plugin-status-error' : 'plugin-status-stopped'}`}>
                    {request.status}
                  </span>
                </div>
                <p>{request.reason}</p>
                <div className="plugin-item-meta">
                  <span>SHA-256 {request.artifactSha256.slice(0, 16)}…</span>
                  <span>Requested by {request.requestedBy}</span>
                  <span>Restart required</span>
                </div>
                <code>{request.systemPermissions.join(' · ')}</code>
                {request.status === 'awaiting-confirmation' ? (
                  <>
                    <label className="toggle-row system-plugin-acknowledgement">
                      <input
                        checked={Boolean(systemAcknowledgements[request.id])}
                        onChange={(event) => setSystemAcknowledgements((current) => ({
                          ...current,
                          [request.id]: event.target.checked
                        }))}
                        type="checkbox"
                      />
                      <span>我理解此插件将获得列出的系统权限，不能即时热加载，并需要重启。</span>
                    </label>
                    <div className="plugin-item-actions">
                      <button
                        className="danger-button"
                        disabled={!systemAcknowledgements[request.id]}
                        onClick={() => onResolveSystemPluginInstallRequest(request.id, request.pluginId, 'confirm', true)}
                        type="button"
                      >
                        确认系统安装
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => onResolveSystemPluginInstallRequest(request.id, request.pluginId, 'cancel', false)}
                        type="button"
                      >
                        取消
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </article>
    </section>
  )
}
