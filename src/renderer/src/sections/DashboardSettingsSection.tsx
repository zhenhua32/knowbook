import type { AppUpdateState, RecentDocument, WebClipBridgeStatus, WorkspaceSummary } from '@shared/contracts'
import type { UiLanguage, UiText } from '../i18n'
import './management-sections.css'
import { lazy, Suspense, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useAsyncActionFocus } from '../hooks/useAsyncActionFocus'
import { WebClipExtensionSetup } from '../components/WebClipExtensionSetup'
const WebDavSyncSettings = lazy(() => import('./WebDavSyncSettings'))

type SettingsCategory = 'general' | 'ai' | 'sync' | 'storage' | 'clipping' | 'updates' | 'appearance'

function revealCategoryTab(tab: HTMLButtonElement | undefined): void {
  const list = tab?.parentElement
  if (!tab || !list) return
  const bounds = list.getBoundingClientRect()
  const tabBounds = tab.getBoundingClientRect()
  const left = bounds.left + list.clientLeft
  const right = left + list.clientWidth
  if (tabBounds.left < left) list.scrollLeft += tabBounds.left - left
  else if (tabBounds.right > right) list.scrollLeft += tabBounds.right - right
}

function settingsScrollPadding(viewport: HTMLElement, layout: HTMLElement, nav?: HTMLElement | null): number {
  const padding = parseFloat(window.getComputedStyle(viewport).paddingTop) || 0
  return nav ? padding + nav.getBoundingClientRect().height + (parseFloat(window.getComputedStyle(layout).rowGap) || 0) : padding
}

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
  aiSaveError: string
  aiSettingsDirty: boolean
  onResetAiSettingsDraft: () => void
  aiClearingApiKey: boolean
  onSaveAiConfig: () => void | Promise<void>
  onOpenPlugins: () => void
  onRestoreBackup: () => void
  onBackupNow: () => void
  appUpdateState: AppUpdateState | null
  appUpdateRefreshing: boolean
  appUpdateLoading: boolean
  appUpdateLoadError: string | null
  appUpdateCheckError: string | null
  appUpdateCanCheck: boolean
  onReloadAppUpdateState: () => Promise<void>
  onCheckForAppUpdates: () => void | Promise<void>
  onInstallAppUpdate: () => void
  webClipBridgeStatus: WebClipBridgeStatus | null
  webClipBridgeEnabledDraft: boolean
  onWebClipBridgeEnabledChange: (value: boolean) => void
  webClipBridgePortDraft: string
  webClipBridgePortError: string | null
  onWebClipBridgePortChange: (value: string) => void
  webClipBridgeSaving: boolean
  webClipBridgeActionError: { kind: 'save' | 'regenerate'; message: string } | null
  webClipBridgeRegenerating: boolean
  webClipBridgeCopying: 'endpoint' | 'token' | null
  webClipBridgeLoading: boolean
  webClipBridgeLoadError: string | null
  onReloadWebClipBridgeStatus: () => void | Promise<void>
  onSaveWebClipBridgeSettings: () => void | Promise<void>
  onRegenerateWebClipBridgeToken: () => void | Promise<void>
  onCopyWebClipBridgeEndpoint: () => void | Promise<void>
  onCopyWebClipBridgeToken: () => void | Promise<void>
  appearanceContent?: ReactNode
  recoveryContent?: ReactNode
  requestedCategory?: SettingsCategory | null
  onCategoryRequestHandled?: () => void
}

function getAppUpdateStatusText(state: AppUpdateState | null, ui: UiText): string {
  if (!state) {
    return ui.appUpdateStatusUnavailable
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
  aiSaveError,
  aiSettingsDirty,
  onResetAiSettingsDraft,
  aiClearingApiKey,
  onSaveAiConfig,
  onOpenPlugins,
  onRestoreBackup,
  onBackupNow,
  appUpdateState,
  appUpdateRefreshing,
  appUpdateLoading,
  appUpdateLoadError,
  appUpdateCheckError,
  appUpdateCanCheck,
  onReloadAppUpdateState,
  onCheckForAppUpdates,
  onInstallAppUpdate,
  webClipBridgeStatus,
  webClipBridgeEnabledDraft,
  onWebClipBridgeEnabledChange,
  webClipBridgePortDraft,
  webClipBridgePortError,
  onWebClipBridgePortChange,
  webClipBridgeSaving,
  webClipBridgeActionError,
  webClipBridgeRegenerating,
  webClipBridgeCopying,
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
  const [compactNavigation, setCompactNavigation] = useState(false)
  const [syncMounted, setSyncMounted] = useState(false)
  const [visibleBridgeToken, setVisibleBridgeToken] = useState<string | null>(null)
  const tabsId = useId()
  const bridgePortErrorId = useId()
  const bridgeTokenHintId = useId()
  const bridgeTokenInputId = useId()
  const bridgeToken = webClipBridgeStatus?.token ?? ''
  const bridgeTokenVisible = Boolean(bridgeToken && visibleBridgeToken === bridgeToken && isSettingsPage && activeCategory === 'clipping')
  const aiPanelRef = useRef<HTMLElement>(null)
  const bridgePanelRef = useRef<HTMLElement>(null)
  const updatesPanelRef = useRef<HTMLElement>(null)
  const bridgePortRef = useRef<HTMLInputElement>(null)
  const runAiAction = useAsyncActionFocus(aiPanelRef)
  const runBridgeAction = useAsyncActionFocus(bridgePanelRef)
  const runUpdateAction = useAsyncActionFocus(updatesPanelRef)
  const updateCheckBusy = appUpdateRefreshing || (appUpdateState?.status === 'checking' && !appUpdateCanCheck)
  const staleCheckFeedback = appUpdateCheckError && (appUpdateState?.status === 'not-available' || appUpdateState?.status === 'idle')
  const updateStatusText = updateCheckBusy ? ui.updateStatusChecking : staleCheckFeedback ? ui.appUpdateCheckFailed
    : !appUpdateState && appUpdateLoading ? ui.common.loading : getAppUpdateStatusText(appUpdateState, ui)
  const tabListRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<HTMLElement>(null)
  const previousCategoryRef = useRef(activeCategory)
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
    const query = window.matchMedia?.('(max-width: 820px)')
    if (!query) return undefined
    const updateNavigation = () => setCompactNavigation(query.matches)
    updateNavigation()
    query.addEventListener('change', updateNavigation)
    return () => query.removeEventListener('change', updateNavigation)
  }, [])
  useLayoutEffect(() => {
    if (!isSettingsPage || !compactNavigation || !tabListRef.current) return undefined
    const list = tabListRef.current
    const viewport = list.closest<HTMLElement>('.content.page-settings')
    const previousPadding = viewport?.style.scrollPaddingTop
    // A request can reveal the current category without changing activeCategory.
    const revealActiveCategory = () => {
      revealCategoryTab(tabRefs.current[activeCategory])
      if (viewport && layoutRef.current) {
        viewport.style.scrollPaddingTop = `${settingsScrollPadding(viewport, layoutRef.current, list.parentElement)}px`
      }
    }
    revealActiveCategory()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(revealActiveCategory)
    observer?.observe(list)
    return () => {
      observer?.disconnect()
      if (viewport && previousPadding !== undefined) viewport.style.scrollPaddingTop = previousPadding
    }
  }, [activeCategory, compactNavigation, isSettingsPage, requestedCategory])
  useLayoutEffect(() => {
    setVisibleBridgeToken(null)
  }, [bridgeToken, activeCategory, isSettingsPage])
  useLayoutEffect(() => {
    if (!isSettingsPage || !requestedCategory) return
    setVisibleBridgeToken(null)
    if (requestedCategory === 'sync') setSyncMounted(true)
    setActiveCategory(requestedCategory)
    onCategoryRequestHandled?.()
  }, [isSettingsPage, requestedCategory, onCategoryRequestHandled])
  useLayoutEffect(() => {
    const previousCategory = previousCategoryRef.current
    previousCategoryRef.current = activeCategory
    // Resizing, saving, and revisiting the same category leave its reading position alone.
    if (!isSettingsPage || previousCategory === activeCategory) return
    const layout = layoutRef.current
    const viewport = layout?.closest<HTMLElement>('.content.page-settings')
    const panel = layout?.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')
    if (!layout || !viewport || !panel) return
    const viewportBounds = viewport.getBoundingClientRect()
    const top = viewportBounds.top + viewport.clientTop
      + settingsScrollPadding(viewport, layout, compactNavigation ? tabListRef.current?.parentElement : null)
    const panelTop = panel.getBoundingClientRect().top
    if (panelTop < top - 1 || panelTop > viewportBounds.bottom - 1) {
      viewport.scrollTop = Math.max(0, viewport.scrollTop + panelTop - top)
    }
  }, [activeCategory, compactNavigation, isSettingsPage])
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
    tabRefs.current[category]?.focus({ preventScroll: true })
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

      <section ref={layoutRef} className={`detail-grid${isSettingsPage ? ' settings-layout' : ''}`}>
        {isSettingsPage ? (
          <nav className="settings-category-nav" aria-label={isZh ? '设置分类' : 'Settings categories'}>
            <div ref={tabListRef} role="tablist" aria-label={isZh ? '设置分类' : 'Settings categories'} aria-orientation={compactNavigation ? 'horizontal' : 'vertical'}>
              {categories.map((category, index) => (
                <button
                  aria-controls={`${tabsId}-panel-${category.id}`}
                  aria-selected={activeCategory === category.id}
                  id={`${tabsId}-tab-${category.id}`}
                  key={category.id}
                  onClick={() => selectCategory(category.id)}
                  onFocus={(event) => { if (compactNavigation) revealCategoryTab(event.currentTarget) }}
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

              <section ref={aiPanelRef} className="panel settings-category-panel settings-group settings-ai-panel" {...panelProps('ai')}>
                <div className="settings-group-heading">
                  <h3>{isZh ? 'AI 能力' : 'AI capabilities'}</h3>
                  <p>{isZh ? '配置模型连接、自动摘要和相关笔记检索。' : 'Configure model access, automatic summaries, and related-note search.'}</p>
                </div>
                <div className="settings-editable-form">
                <fieldset className="settings-form-fields" aria-busy={aiSaving} disabled={aiSaving}>
                <div className="settings-toggle-list">
                  <label className="toggle-row">
                    <input checked={aiEnabledDraft} disabled={aiSaving} onChange={(event) => onAiEnabledChange(event.target.checked)} type="checkbox" />
                    <span>{ui.enableAiFeatures}</span>
                  </label>
                  <label className="toggle-row">
                    <input checked={aiAutoSummaryOnSaveDraft} disabled={aiSaving} onChange={(event) => onAiAutoSummaryOnSaveChange(event.target.checked)} type="checkbox" />
                    <span>{ui.autoSummaryWhenEmpty}</span>
                  </label>
                  <label className="toggle-row">
                    <input checked={aiRelatedNotesEnabledDraft} disabled={aiSaving} onChange={(event) => onAiRelatedNotesEnabledChange(event.target.checked)} type="checkbox" />
                    <span>{ui.relatedNotesOnAsk}</span>
                  </label>
                </div>
                <label className="editor-label">
                  {ui.baseUrl}
                  <input className="editor-input" disabled={aiSaving} onChange={(event) => onAiBaseUrlChange(event.target.value)} type="text" value={aiBaseUrlDraft} />
                </label>
                <label className="editor-label">
                  {ui.model}
                  <input className="editor-input" disabled={aiSaving} onChange={(event) => onAiModelChange(event.target.value)} type="text" value={aiModelDraft} />
                </label>
                <div className="editor-label">
                  <label htmlFor="ai-api-key">{ui.apiKeyLabel}</label>
                  <div className="settings-inline-field">
                    <input autoComplete="new-password" id="ai-api-key" className="editor-input" disabled={aiSaving} onChange={(event) => onAiApiKeyChange(event.target.value)} type="password" value={aiApiKeyDraft} />
                    <button aria-busy={aiClearingApiKey} className="secondary-button" disabled={aiSaving} onClick={onClearAiApiKey} type="button">{aiClearingApiKey ? (isZh ? '正在清除…' : 'Clearing…') : ui.clearAiApiKey}</button>
                  </div>
                </div>
                </fieldset>
                <div className={`settings-form-actions${aiSaving ? ' is-working' : ''}${aiSaveError ? ' has-error' : ''}`}>
                <div className="settings-action-feedback">
                  {!aiSaving && <p className="mini-hint" role="status">{aiSettingsDirty
                    ? (isZh ? '有未保存的修改，保存后生效。' : 'Unsaved changes. Save to apply.')
                    : (isZh ? '没有未保存的修改。' : 'No unsaved changes.')}</p>}
                  {aiSaveError && <p className="settings-ai-save-error" role="alert">{aiSaveError}</p>}
                  {aiSaving && <p className="mini-hint" role="status">{aiClearingApiKey ? (isZh ? '正在清除已保存的 API Key…' : 'Clearing the saved API key…') : (isZh ? '正在保存 AI 设置…' : 'Saving AI settings…')}</p>}
                </div>
                <div className="settings-actions">
                  <button aria-busy={aiSaving && !aiClearingApiKey} className="primary-button" disabled={aiSaving} onClick={event => runAiAction(event.currentTarget, onSaveAiConfig)} type="button">
                    {aiSaving && !aiClearingApiKey ? ui.common.saving : ui.saveAiSettings}
                  </button>
                  <button className="secondary-button settings-discard-button" disabled={aiSaving} aria-disabled={!aiSettingsDirty || aiSaving}
                    onClick={() => { if (aiSettingsDirty) onResetAiSettingsDraft() }} type="button">
                    {isZh ? '撤销未保存修改' : 'Discard unsaved changes'}
                  </button>
                  <button className="secondary-button" onClick={onOpenPlugins} type="button">
                    {isZh ? '打开插件中心' : 'Open plugin center'}
                  </button>
                </div>
                </div>
                </div>
              </section>

              <section ref={bridgePanelRef} className="panel settings-category-panel settings-bridge-panel" {...panelProps('clipping')}>
                <div>
                  <p className="panel-label">{ui.webClipBridgeLabel}</p>
                  <h3 className="settings-card-title">{ui.webClipBridgeTitle}</h3>
                  <p className="settings-card-description">{ui.webClipBridgeDescription}</p>
                </div>
                <div className="settings-editable-form">
                <fieldset className="settings-form-fields" aria-busy={webClipBridgeSaving} disabled={!webClipBridgeStatus || webClipBridgeSaving}>
                <label className="toggle-row">
                  <input checked={webClipBridgeEnabledDraft} disabled={!webClipBridgeStatus || webClipBridgeSaving} onChange={(event) => onWebClipBridgeEnabledChange(event.target.checked)} type="checkbox" />
                  <span>{ui.webClipBridgeEnabledLabel}</span>
                </label>
                <label className="editor-label">
                  {ui.webClipBridgePortLabel}
                  <input ref={bridgePortRef} aria-describedby={webClipBridgePortError ? bridgePortErrorId : undefined} aria-invalid={Boolean(webClipBridgePortError)} className="editor-input" disabled={!webClipBridgeStatus || webClipBridgeSaving} inputMode="numeric" onChange={(event) => onWebClipBridgePortChange(event.target.value)} pattern="[0-9]*" type="text" value={webClipBridgeStatus ? webClipBridgePortDraft : ''} />
                </label>
                {webClipBridgePortError && <p className="settings-bridge-port-error" id={bridgePortErrorId} role="alert">{webClipBridgePortError}</p>}
                </fieldset>
                <div className={`settings-form-actions${webClipBridgeSaving ? ' is-working' : ''}${webClipBridgeActionError ? ' has-error' : ''}`}>
                  <p className="mini-hint" id={bridgeTokenHintId}>{ui.webClipBridgeRegenerateHint}</p>
                  <div className="settings-action-feedback">
                    {webClipBridgeActionError && <p className="settings-bridge-action-error" data-action-kind={webClipBridgeActionError.kind} role="alert">{webClipBridgeActionError.message}</p>}
                    {webClipBridgeSaving && <p className="mini-hint" role="status">{webClipBridgeRegenerating ? ui.webClipBridgeRegenerating : ui.webClipBridgeSaving}</p>}
                  </div>
                  <div className="settings-actions">
                    <button aria-busy={webClipBridgeSaving && !webClipBridgeRegenerating} className="primary-button" disabled={!webClipBridgeStatus || webClipBridgeSaving || Boolean(webClipBridgePortError)} onClick={event => runBridgeAction(event.currentTarget, onSaveWebClipBridgeSettings)} type="button">
                      {webClipBridgeSaving && !webClipBridgeRegenerating ? ui.common.saving : ui.webClipBridgeSave}
                    </button>
                    <button aria-busy={webClipBridgeRegenerating} aria-describedby={bridgeTokenHintId} className="secondary-button" disabled={!webClipBridgeStatus || webClipBridgeSaving} onClick={event => runBridgeAction(event.currentTarget, onRegenerateWebClipBridgeToken)} type="button">{ui.webClipBridgeRegenerateToken}</button>
                  </div>
                </div>
                </div>
                <div className="settings-bridge-copy-actions">
                  <div className="settings-bridge-copy-field" data-copy-kind="token">
                    <label className="editor-label" htmlFor={bridgeTokenInputId}>
                      {ui.webClipBridgeTokenLabel}
                      <input autoComplete="off" className="editor-input" id={bridgeTokenInputId} readOnly type={bridgeTokenVisible ? 'text' : 'password'} value={bridgeToken} />
                    </label>
                    <div className="settings-actions">
                      <button aria-controls={bridgeTokenInputId} className="secondary-button settings-bridge-token-visibility" disabled={!bridgeToken} onClick={() => setVisibleBridgeToken(bridgeTokenVisible ? null : bridgeToken)} type="button">{bridgeTokenVisible ? ui.webClipBridgeHideToken : ui.webClipBridgeShowToken}</button>
                      <button aria-busy={webClipBridgeCopying === 'token'} className="secondary-button settings-bridge-copy-button" disabled={webClipBridgeSaving || Boolean(webClipBridgeCopying) || !bridgeToken} onClick={event => runBridgeAction(event.currentTarget, onCopyWebClipBridgeToken)} type="button">{webClipBridgeCopying === 'token' ? ui.webClipBridgeCopying : ui.webClipBridgeCopyToken}</button>
                    </div>
                    <div className="settings-action-feedback settings-bridge-copy-feedback">
                      {webClipBridgeCopying === 'token' && <p className="mini-hint" role="status">{ui.webClipBridgeCopyingToken}</p>}
                    </div>
                  </div>
                  <div className="settings-bridge-copy-field" data-copy-kind="endpoint">
                    <label className="editor-label">
                      {ui.webClipBridgeEndpointLabel}
                      <input className="editor-input" readOnly type="text" value={webClipBridgeStatus ? (webClipBridgeStatus.endpoint ?? ui.webClipBridgeUnavailable) : (webClipBridgeLoading ? ui.webClipBridgeLoading : ui.webClipBridgeLoadUnknown)} />
                    </label>
                    <div className="settings-actions">
                      <button aria-busy={webClipBridgeCopying === 'endpoint'} className="secondary-button settings-bridge-copy-button" disabled={webClipBridgeSaving || Boolean(webClipBridgeCopying) || !webClipBridgeStatus?.endpoint} onClick={event => runBridgeAction(event.currentTarget, onCopyWebClipBridgeEndpoint)} type="button">{webClipBridgeCopying === 'endpoint' ? ui.webClipBridgeCopying : ui.webClipBridgeCopyEndpoint}</button>
                    </div>
                    <div className="settings-action-feedback settings-bridge-copy-feedback">
                      {webClipBridgeCopying === 'endpoint' && <p className="mini-hint" role="status">{ui.webClipBridgeCopyingEndpoint}</p>}
                    </div>
                  </div>
                </div>
                {webClipBridgeLoading && <p className="mini-hint" role="status">{ui.webClipBridgeLoading}</p>}
                {webClipBridgeLoadError && (
                  <div className="settings-bridge-read-error">
                    <p role="alert">{webClipBridgeLoadError}</p>
                    {webClipBridgeStatus && <p className="mini-hint">{ui.webClipBridgeStaleHint}</p>}
                    <button className="secondary-button" disabled={webClipBridgeLoading || webClipBridgeSaving} onClick={event => runBridgeAction(event.currentTarget, onReloadWebClipBridgeStatus, () => bridgePortRef.current)} type="button">{ui.webClipBridgeReload}</button>
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
                <div className="settings-bridge-setup">
                  <h4>{ui.webClipBridgeSetupTitle}</h4>
                  <WebClipExtensionSetup isZh={isZh} active={isSettingsPage && activeCategory === 'clipping'} />
                  <ol>
                    <li>{ui.webClipBridgeSetupEnable}</li>
                    <li>{ui.webClipBridgeSetupExtension}</li>
                    <li>{ui.webClipBridgeSetupClip}</li>
                  </ol>
                  <p className="mini-hint">{ui.webClipBridgeHint}</p>
                </div>
              </section>

              <section ref={updatesPanelRef} className="panel settings-category-panel settings-updates-panel" {...panelProps('updates')}>
                <div>
                  <p className="panel-label">{ui.appUpdateLabel}</p>
                  <h3 className="settings-card-title">{ui.appUpdateTitle}</h3>
                  <p className="settings-card-description">{ui.appUpdateDescription}</p>
                </div>
                <dl className="meta-grid">
                  <div>
                    <dt>{ui.currentVersionLabel}</dt>
                    <dd>{appUpdateState?.currentVersion ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>{ui.availableVersionLabel}</dt>
                    <dd>{appUpdateState ? appUpdateState.downloadedVersion ?? appUpdateState.availableVersion ?? ui.common.none : '—'}</dd>
                  </div>
                  <div>
                    <dt>{ui.updateStatusField}</dt>
                    <dd>{updateStatusText}</dd>
                  </div>
                  <div>
                    <dt>{ui.lastCheckedLabel}</dt>
                    <dd>{appUpdateState ? appUpdateState.checkedAt ? new Date(appUpdateState.checkedAt).toLocaleString(ui.locale) : ui.notCheckedYet : '—'}</dd>
                  </div>
                </dl>
                <div>
                  <strong>{ui.releaseNotesLabel}</strong>
                  <p className="settings-release-notes">{appUpdateState?.releaseNotes ?? ui.noReleaseNotes}</p>
                </div>
                <div className="settings-update-actions">
                <div className="settings-bridge-read-error settings-update-feedback">
                  {appUpdateCheckError && <p className="settings-update-check-error" role="alert">{appUpdateCheckError}</p>}
                  {appUpdateLoading && <p className="mini-hint" role="status">{ui.common.loading}</p>}
                  {appUpdateLoadError && <p className="settings-update-read-error" role="alert">{appUpdateLoadError}</p>}
                  {appUpdateLoadError && appUpdateState && <p className="mini-hint">{ui.appUpdateLastKnownStatus}</p>}
                  {updateCheckBusy && !appUpdateCheckError && <p role="status">{ui.checkingForUpdates}</p>}
                </div>
                <div className="settings-actions">
                  <button aria-busy={appUpdateLoading} className="secondary-button" disabled={appUpdateLoading || appUpdateRefreshing}
                    onClick={event => runUpdateAction(event.currentTarget, onReloadAppUpdateState)} type="button">{ui.appUpdateReload}</button>
                  <button
                    aria-busy={updateCheckBusy}
                    className="secondary-button"
                    disabled={!appUpdateCanCheck}
                    onClick={event => runUpdateAction(event.currentTarget, onCheckForAppUpdates)}
                    type="button"
                  >
                    {updateCheckBusy ? ui.checkingForUpdates : ui.checkForUpdates}
                  </button>
                  <button className="primary-button" disabled={!appUpdateState?.canInstall || Boolean(appUpdateLoadError) || appUpdateRefreshing} onClick={onInstallAppUpdate} type="button">{ui.installUpdateNow}</button>
                </div>
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
