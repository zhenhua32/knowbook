import type { AppUpdateState, RecentDocument, WebClipBridgeStatus, WorkspaceSummary } from '@shared/contracts'
import type { UiLanguage, UiText } from '../i18n'
import './management-sections.css'
import { lazy, Suspense, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
const WebDavSyncSettings = lazy(() => import('./WebDavSyncSettings'))

type SettingsCategory = 'general' | 'ai' | 'sync' | 'storage' | 'clipping' | 'updates' | 'appearance'

type DashboardSettingsSectionProps = {
  ui: UiText
  isZh: boolean
  isSettingsPage: boolean
  loading: boolean
  summary: WorkspaceSummary
  aiEndpoint: string
  recentDocuments: RecentDocument[]
  onOpenDocument: (documentId: string) => void
  uiLanguage: UiLanguage
  onUiLanguageChange: (language: UiLanguage) => void
  aiEnabledDraft: boolean
  onAiEnabledChange: (value: boolean) => void
  aiAutoSummaryOnSaveDraft: boolean
  onAiAutoSummaryOnSaveChange: (value: boolean) => void
  aiRelatedNotesEnabledDraft: boolean
  onAiRelatedNotesEnabledChange: (value: boolean) => void
  aiBaseUrlDraft: string
  onAiBaseUrlChange: (value: string) => void
  aiModelDraft: string
  onAiModelChange: (value: string) => void
  aiApiKeyDraft: string
  onAiApiKeyChange: (value: string) => void
  onClearAiApiKey: () => void
  aiSaving: boolean
  onSaveAiConfig: () => void
  onOpenPlugins: () => void
  onRestoreBackup: () => void
  onBackupNow: () => void
  appUpdateState: AppUpdateState | null
  appUpdateRefreshing: boolean
  onCheckForAppUpdates: () => void
  onInstallAppUpdate: () => void
  webClipBridgeStatus: WebClipBridgeStatus | null
  webClipBridgeEnabledDraft: boolean
  onWebClipBridgeEnabledChange: (value: boolean) => void
  webClipBridgePortDraft: string
  webClipBridgePortError: string | null
  onWebClipBridgePortChange: (value: string) => void
  webClipBridgeSaving: boolean
  webClipBridgeRegenerating: boolean
  webClipBridgeLoading: boolean
  webClipBridgeLoadError: string | null
  onReloadWebClipBridgeStatus: () => void
  onSaveWebClipBridgeSettings: () => void
  onRegenerateWebClipBridgeToken: () => void
  onCopyWebClipBridgeEndpoint: () => void
  onCopyWebClipBridgeToken: () => void
  appearanceContent?: ReactNode
  recoveryContent?: ReactNode
  requestedCategory?: SettingsCategory | null
  onCategoryRequestHandled?: () => void
}

function getAppUpdateStatusText(state: AppUpdateState | null, ui: UiText): string {
  if (!state) {
    return ui.common.loading
  }

  switch (state.status) {
    case 'idle':
      return ui.updateStatusIdle
    case 'checking':
      return ui.updateStatusChecking
    case 'available':
      return ui.updateStatusAvailable(state.availableVersion)
    case 'downloading':
      return ui.updateStatusDownloading(state.progressPercent)
    case 'downloaded':
      return ui.updateStatusDownloaded(state.downloadedVersion ?? state.availableVersion)
    case 'not-available':
      return ui.updateStatusNotAvailable
    case 'unsupported':
      return ui.updateStatusUnsupported
    case 'error':
      return ui.updateStatusError(state.error)
    default:
      return state.message
  }
}

export function DashboardSettingsSection({
  ui,
  isZh,
  isSettingsPage,
  loading,
  summary,
  aiEndpoint,
  recentDocuments,
  onOpenDocument,
  uiLanguage,
  onUiLanguageChange,
  aiEnabledDraft,
  onAiEnabledChange,
  aiAutoSummaryOnSaveDraft,
  onAiAutoSummaryOnSaveChange,
  aiRelatedNotesEnabledDraft,
  onAiRelatedNotesEnabledChange,
  aiBaseUrlDraft,
  onAiBaseUrlChange,
  aiModelDraft,
  onAiModelChange,
  aiApiKeyDraft,
  onAiApiKeyChange,
  onClearAiApiKey,
  aiSaving,
  onSaveAiConfig,
  onOpenPlugins,
  onRestoreBackup,
  onBackupNow,
  appUpdateState,
  appUpdateRefreshing,
  onCheckForAppUpdates,
  onInstallAppUpdate,
  webClipBridgeStatus,
  webClipBridgeEnabledDraft,
  onWebClipBridgeEnabledChange,
  webClipBridgePortDraft,
  webClipBridgePortError,
  onWebClipBridgePortChange,
  webClipBridgeSaving,
  webClipBridgeRegenerating,
  webClipBridgeLoading,
  webClipBridgeLoadError,
  onReloadWebClipBridgeStatus,
  onSaveWebClipBridgeSettings,
  onRegenerateWebClipBridgeToken,
  onCopyWebClipBridgeEndpoint,
  onCopyWebClipBridgeToken,
  appearanceContent,
  recoveryContent,
  requestedCategory,
  onCategoryRequestHandled
}: DashboardSettingsSectionProps) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('general')
  const [syncMounted, setSyncMounted] = useState(false)
  const tabsId = useId()
  const bridgePortErrorId = useId()
  const bridgeTokenHintId = useId()
  const tabRefs = useRef<Partial<Record<SettingsCategory, HTMLButtonElement>>>({})
  const categories: { id: SettingsCategory; label: string }[] = [
    { id: 'general', label: isZh ? '通用' : 'General' },
    { id: 'ai', label: 'AI' },
    { id: 'sync', label: isZh ? '同步' : 'Sync' },
    { id: 'storage', label: isZh ? '存储与恢复' : 'Storage & recovery' },
    { id: 'clipping', label: isZh ? '网页剪藏' : 'Web clipping' },
    { id: 'updates', label: isZh ? '更新' : 'Updates' },
    { id: 'appearance', label: isZh ? '外观' : 'Appearance' }
  ]
  const selectCategory = (category: SettingsCategory) => {
    if (category === 'sync') setSyncMounted(true)
    setActiveCategory(category)
  }
  useLayoutEffect(() => {
    if (!isSettingsPage || !requestedCategory) return
    if (requestedCategory === 'sync') setSyncMounted(true)
    setActiveCategory(requestedCategory)
    onCategoryRequestHandled?.()
  }, [isSettingsPage, requestedCategory, onCategoryRequestHandled])
  const navigateCategory = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % categories.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + categories.length) % categories.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = categories.length - 1
    else return
    event.preventDefault()
    const category = categories[nextIndex].id
    selectCategory(category)
    tabRefs.current[category]?.focus()
  }
  const panelProps = (category: SettingsCategory) => ({
    id: `${tabsId}-panel-${category}`,
    'aria-labelledby': `${tabsId}-tab-${category}`,
    role: 'tabpanel' as const,
    hidden: activeCategory !== category
  })
  return (
    <>
      {isSettingsPage ? (
        <header className="management-page-header settings-page-header">
          <div className="management-page-heading">
            <h2>{isZh ? '配置中心' : 'Settings'}</h2>
            <p className="management-page-description">
              {isZh ? '按类别调整偏好、连接与工作区设置。' : 'Manage preferences, connections, and your workspace by category.'}
            </p>
          </div>
        </header>
      ) : null}

      <section className={`detail-grid${isSettingsPage ? ' settings-layout' : ''}`}>
        {isSettingsPage ? (
          <nav className="settings-category-nav" aria-label={isZh ? '设置分类' : 'Settings categories'}>
            <div role="tablist" aria-label={isZh ? '设置分类' : 'Settings categories'} aria-orientation="vertical">
              {categories.map((category, index) => (
                <button
                  aria-controls={`${tabsId}-panel-${category.id}`}
                  aria-selected={activeCategory === category.id}
                  id={`${tabsId}-tab-${category.id}`}
                  key={category.id}
                  onClick={() => selectCategory(category.id)}
                  onKeyDown={(event) => navigateCategory(event, index)}
                  ref={(element) => { if (element) tabRefs.current[category.id] = element }}
                  role="tab"
                  tabIndex={activeCategory === category.id ? 0 : -1}
                  type="button"
                >{category.label}</button>
              ))}
            </div>
          </nav>
        ) : null}
        <article className={isSettingsPage ? 'settings-category-content' : 'panel large-panel'}>
          {!isSettingsPage ? <><div className="panel-head">
            <div>
              <p className="panel-label">{ui.storageLabel}</p>
              <h3>{ui.storageTitle}</h3>
            </div>
            {loading ? <span className="pill">{ui.common.loading}</span> : <span className="pill">{ui.common.ready}</span>}
          </div>
          <dl className="meta-grid">
            <div>
              <dt>{ui.databasePath}</dt>
              <dd>{summary.databasePath || ui.initializing}</dd>
            </div>
            <div>
              <dt>{ui.backupRoot}</dt>
              <dd>{summary.backupRoot || ui.initializing}</dd>
            </div>
            <div>
              <dt>{ui.lastBackup}</dt>
              <dd>{summary.lastBackupAt ? new Date(summary.lastBackupAt).toLocaleString(ui.locale) : ui.notYetExported}</dd>
            </div>
            <div>
              <dt>{ui.aiEndpoint}</dt>
              <dd>{aiEndpoint}</dd>
            </div>
          </dl></> : null}

          {isSettingsPage ? (
            <>
              <section className="panel settings-category-panel" {...panelProps('sync')}>
                {syncMounted ? <Suspense fallback={<p role="status">{ui.common.loading}</p>}><WebDavSyncSettings isZh={isZh} /></Suspense> : null}
              </section>
              <section className="panel settings-category-panel settings-group" {...panelProps('general')}>
                <div className="settings-group-heading">
                  <h3>{isZh ? '基础偏好' : 'General preferences'}</h3>
                  <p>{isZh ? '设置界面语言和基础交互偏好。' : 'Set the interface language and general preferences.'}</p>
                </div>
                <label className="editor-label">
                  {ui.languageSwitchLabel}
                  <select aria-label={ui.languageSwitchLabel} className="editor-input" onChange={(event) => onUiLanguageChange(event.target.value as UiLanguage)} value={uiLanguage}>
                    <option value="zh-CN">{ui.languageOptionZh}</option>
                    <option value="en-US">{ui.languageOptionEn}</option>
                  </select>
                </label>
              </section>

              <section className="panel settings-category-panel settings-group" {...panelProps('ai')}>
                <div className="settings-group-heading">
                  <h3>{isZh ? 'AI 能力' : 'AI capabilities'}</h3>
                  <p>{isZh ? '配置模型连接、自动摘要和相关笔记检索。' : 'Configure model access, automatic summaries, and related-note search.'}</p>
                </div>
                <div className="settings-toggle-list">
                  <label className="toggle-row">
                    <input checked={aiEnabledDraft} onChange={(event) => onAiEnabledChange(event.target.checked)} type="checkbox" />
                    <span>{ui.enableAiFeatures}</span>
                  </label>
                  <label className="toggle-row">
                    <input checked={aiAutoSummaryOnSaveDraft} onChange={(event) => onAiAutoSummaryOnSaveChange(event.target.checked)} type="checkbox" />
                    <span>{ui.autoSummaryWhenEmpty}</span>
                  </label>
                  <label className="toggle-row">
                    <input checked={aiRelatedNotesEnabledDraft} onChange={(event) => onAiRelatedNotesEnabledChange(event.target.checked)} type="checkbox" />
                    <span>{ui.relatedNotesOnAsk}</span>
                  </label>
                </div>
                <label className="editor-label">
                  {ui.baseUrl}
                  <input className="editor-input" onChange={(event) => onAiBaseUrlChange(event.target.value)} type="text" value={aiBaseUrlDraft} />
                </label>
                <label className="editor-label">
                  {ui.model}
                  <input className="editor-input" onChange={(event) => onAiModelChange(event.target.value)} type="text" value={aiModelDraft} />
                </label>
                <div className="editor-label">
                  <label htmlFor="ai-api-key">{ui.apiKeyLabel}</label>
                  <div className="settings-inline-field">
                    <input id="ai-api-key" className="editor-input" onChange={(event) => onAiApiKeyChange(event.target.value)} type="password" value={aiApiKeyDraft} />
                    <button className="secondary-button" disabled={aiSaving} onClick={onClearAiApiKey} type="button">{ui.clearAiApiKey}</button>
                  </div>
                </div>
                <div className="settings-actions">
                  <button className="primary-button" disabled={aiSaving} onClick={onSaveAiConfig} type="button">
                    {aiSaving ? ui.common.saving : ui.saveAiSettings}
                  </button>
                  <button className="secondary-button" onClick={onOpenPlugins} type="button">
                    {isZh ? '打开插件中心' : 'Open plugin center'}
                  </button>
                </div>
              </section>

              <section className="panel settings-category-panel" {...panelProps('clipping')}>
                <div>
                  <p className="panel-label">{ui.webClipBridgeLabel}</p>
                  <h3 className="settings-card-title">{ui.webClipBridgeTitle}</h3>
                  <p className="settings-card-description">{ui.webClipBridgeDescription}</p>
                </div>
                <label className="toggle-row">
                  <input checked={webClipBridgeEnabledDraft} disabled={!webClipBridgeStatus || webClipBridgeSaving} onChange={(event) => onWebClipBridgeEnabledChange(event.target.checked)} type="checkbox" />
                  <span>{ui.webClipBridgeEnabledLabel}</span>
                </label>
                <label className="editor-label">
                  {ui.webClipBridgePortLabel}
                  <input aria-describedby={webClipBridgePortError ? bridgePortErrorId : undefined} aria-invalid={Boolean(webClipBridgePortError)} className="editor-input" disabled={!webClipBridgeStatus || webClipBridgeSaving} inputMode="numeric" onChange={(event) => onWebClipBridgePortChange(event.target.value)} pattern="[0-9]*" type="text" value={webClipBridgeStatus ? webClipBridgePortDraft : ''} />
                </label>
                {webClipBridgePortError && <p className="settings-bridge-port-error" id={bridgePortErrorId} role="alert">{webClipBridgePortError}</p>}
                <label className="editor-label">
                  {ui.webClipBridgeTokenLabel}
                  <input className="editor-input" readOnly type="text" value={webClipBridgeStatus?.token ?? ''} />
                </label>
                <label className="editor-label">
                  {ui.webClipBridgeEndpointLabel}
                  <input className="editor-input" readOnly type="text" value={webClipBridgeStatus ? (webClipBridgeStatus.endpoint ?? ui.webClipBridgeUnavailable) : (webClipBridgeLoading ? ui.webClipBridgeLoading : ui.webClipBridgeLoadUnknown)} />
                </label>
                {webClipBridgeLoading && <p className="mini-hint" role="status">{ui.webClipBridgeLoading}</p>}
                {webClipBridgeLoadError && (
                  <div className="settings-bridge-read-error">
                    <p role="alert">{webClipBridgeLoadError}</p>
                    {webClipBridgeStatus && <p className="mini-hint">{ui.webClipBridgeStaleHint}</p>}
                    <button className="secondary-button" disabled={webClipBridgeLoading || webClipBridgeSaving} onClick={onReloadWebClipBridgeStatus} type="button">{ui.webClipBridgeReload}</button>
                  </div>
                )}
                <dl className="meta-grid">
                  <div>
                    <dt>{ui.webClipBridgeStatusLabel}</dt>
                    <dd>{webClipBridgeStatus ? (webClipBridgeStatus.running ? ui.webClipBridgeStatusRunning : ui.webClipBridgeStatusStopped) : ui.webClipBridgeLoadUnknown}</dd>
                  </div>
                  <div>
                    <dt>{ui.webClipBridgeErrorLabel}</dt>
                    <dd>{webClipBridgeStatus ? (webClipBridgeStatus.lastError ?? ui.common.none) : ui.webClipBridgeLoadUnknown}</dd>
                  </div>
                </dl>
                <p className="mini-hint">{ui.webClipBridgeHint}</p>
                <p className="mini-hint" id={bridgeTokenHintId}>{ui.webClipBridgeRegenerateHint}</p>
                {webClipBridgeRegenerating && <p className="mini-hint" role="status">{ui.webClipBridgeRegenerating}</p>}
                <div className="settings-actions">
                  <button className="primary-button" disabled={!webClipBridgeStatus || webClipBridgeSaving || Boolean(webClipBridgePortError)} onClick={onSaveWebClipBridgeSettings} type="button">
                    {webClipBridgeSaving && !webClipBridgeRegenerating ? ui.common.saving : ui.webClipBridgeSave}
                  </button>
                  <button aria-busy={webClipBridgeRegenerating} aria-describedby={bridgeTokenHintId} className="secondary-button" disabled={!webClipBridgeStatus || webClipBridgeSaving} onClick={onRegenerateWebClipBridgeToken} type="button">{ui.webClipBridgeRegenerateToken}</button>
                  <button className="secondary-button" disabled={!webClipBridgeStatus?.endpoint} onClick={onCopyWebClipBridgeEndpoint} type="button">{ui.webClipBridgeCopyEndpoint}</button>
                  <button className="secondary-button" disabled={!webClipBridgeStatus?.token} onClick={onCopyWebClipBridgeToken} type="button">{ui.webClipBridgeCopyToken}</button>
                </div>
              </section>

              <section className="panel settings-category-panel" {...panelProps('updates')}>
                <div>
                  <p className="panel-label">{ui.appUpdateLabel}</p>
                  <h3 className="settings-card-title">{ui.appUpdateTitle}</h3>
                  <p className="settings-card-description">{ui.appUpdateDescription}</p>
                </div>
                <dl className="meta-grid">
                  <div>
                    <dt>{ui.currentVersionLabel}</dt>
                    <dd>{appUpdateState?.currentVersion ?? ui.initializing}</dd>
                  </div>
                  <div>
                    <dt>{ui.availableVersionLabel}</dt>
                    <dd>{appUpdateState?.downloadedVersion ?? appUpdateState?.availableVersion ?? ui.common.none}</dd>
                  </div>
                  <div>
                    <dt>{ui.updateStatusField}</dt>
                    <dd>{getAppUpdateStatusText(appUpdateState, ui)}</dd>
                  </div>
                  <div>
                    <dt>{ui.lastCheckedLabel}</dt>
                    <dd>{appUpdateState?.checkedAt ? new Date(appUpdateState.checkedAt).toLocaleString(ui.locale) : ui.notCheckedYet}</dd>
                  </div>
                </dl>
                <div>
                  <strong>{ui.releaseNotesLabel}</strong>
                  <p className="settings-release-notes">{appUpdateState?.releaseNotes ?? ui.noReleaseNotes}</p>
                </div>
                <div className="settings-actions">
                  <button
                    className="secondary-button"
                    disabled={appUpdateRefreshing || appUpdateState?.status === 'checking' || appUpdateState?.updatesEnabled === false}
                    onClick={onCheckForAppUpdates}
                    type="button"
                  >
                    {appUpdateRefreshing || appUpdateState?.status === 'checking' ? ui.checkingForUpdates : ui.checkForUpdates}
                  </button>
                  <button className="primary-button" disabled={!appUpdateState?.canInstall} onClick={onInstallAppUpdate} type="button">{ui.installUpdateNow}</button>
                </div>
              </section>
              <section className="panel settings-category-panel settings-group" {...panelProps('storage')}>
                <div className="settings-group-heading">
                  <h3>{isZh ? '存储与恢复' : 'Storage & recovery'}</h3>
                  <p>{isZh ? '管理本地存储与备份，找回需要的内容。' : 'Manage local storage and backups, and recover your content.'}</p>
                </div>
                <dl className="meta-grid">
                  <div><dt>{ui.databasePath}</dt><dd>{summary.databasePath || ui.initializing}</dd></div>
                  <div><dt>{ui.backupRoot}</dt><dd>{summary.backupRoot || ui.initializing}</dd></div>
                  <div><dt>{ui.lastBackup}</dt><dd>{summary.lastBackupAt ? new Date(summary.lastBackupAt).toLocaleString(ui.locale) : ui.notYetExported}</dd></div>
                </dl>
                <div className="settings-actions">
                  <button className="primary-button" onClick={onBackupNow} type="button">{ui.runBackupNow}</button>
                  <button className="secondary-button" onClick={onRestoreBackup} type="button">{ui.restoreBackup}</button>
                </div>
                {recoveryContent}
              </section>
              <section className="panel settings-category-panel settings-group" {...panelProps('appearance')}>
                <div className="settings-group-heading">
                  <h3>{isZh ? '外观' : 'Appearance'}</h3>
                  <p>{isZh ? '调整主题与界面外观。更多选项可从插件中心添加。' : 'Customize your theme and appearance. Add more options from the plugin center.'}</p>
                </div>
                {appearanceContent}
                <div className="settings-actions">
                  <button className="secondary-button" onClick={onOpenPlugins} type="button">{isZh ? '打开插件中心' : 'Open plugin center'}</button>
                </div>
              </section>
            </>
          ) : null}
        </article>

        {!isSettingsPage ? (
          <article className="panel large-panel">
            <div className="panel-head">
              <div>
                <p className="panel-label">{ui.recentDocumentsLabel}</p>
                <h3>{ui.recentDocumentsTitle}</h3>
              </div>
            </div>
            <div className="document-list">
              {recentDocuments.map((document) => (
                <button className="document-row document-button" key={document.id} onClick={() => onOpenDocument(document.id)} type="button">
                  <div>
                    <strong>{document.title}</strong>
                    <p>{document.path}</p>
                  </div>
                  <div className="document-meta">
                    <span>{document.blockCount} {ui.docStatBlocks}</span>
                    <span>{new Date(document.updatedAt).toLocaleDateString(ui.locale)}</span>
                  </div>
                </button>
              ))}
            </div>
          </article>
        ) : null}
      </section>
    </>
  )
}
