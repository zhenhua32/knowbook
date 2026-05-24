import type { PluginDescriptor, PluginSettingDescriptor, PluginSettingValue } from '@shared/contracts'
import type { UiText } from '../i18n'

type PluginsSectionProps = {
  ui: UiText
  pluginRoots: string[]
  plugins: PluginDescriptor[]
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
}

function getPluginSettingDraftKey(pluginId: string, settingId: string): string {
  return `${pluginId}:${settingId}`
}

export function PluginsSection({
  ui,
  pluginRoots,
  plugins,
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
  onUpdatePluginSetting
}: PluginsSectionProps) {
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
      </article>
    </section>
  )
}