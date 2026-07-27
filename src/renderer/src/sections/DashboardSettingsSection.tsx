import type { AppUpdateState, RecentDocument, WebClipBridgeStatus, WorkspaceSummary } from '@shared/contracts'
import type { UiLanguage, UiText } from '../i18n'

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
  onWebClipBridgePortChange: (value: string) => void
  webClipBridgeSaving: boolean
  onSaveWebClipBridgeSettings: () => void
  onRegenerateWebClipBridgeToken: () => void
  onCopyWebClipBridgeEndpoint: () => void
  onCopyWebClipBridgeToken: () => void
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
  onWebClipBridgePortChange,
  webClipBridgeSaving,
  onSaveWebClipBridgeSettings,
  onRegenerateWebClipBridgeToken,
  onCopyWebClipBridgeEndpoint,
  onCopyWebClipBridgeToken
}: DashboardSettingsSectionProps) {
  return (
    <section className="detail-grid">
      <article className="panel large-panel">
        <div className="panel-head">
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
        </dl>
        {isSettingsPage ? (
          <div className="editor-fields settings-editor-fields">
            <label className="editor-label">
              {ui.languageSwitchLabel}
              <select className="editor-input" onChange={(event) => onUiLanguageChange(event.target.value as UiLanguage)} value={uiLanguage}>
                <option value="zh-CN">{ui.languageOptionZh}</option>
                <option value="en-US">{ui.languageOptionEn}</option>
              </select>
            </label>
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
             <label className="editor-label">
              {ui.baseUrl}
              <input className="editor-input" onChange={(event) => onAiBaseUrlChange(event.target.value)} type="text" value={aiBaseUrlDraft} />
            </label>
            <label className="editor-label">
              {ui.model}
              <input className="editor-input" onChange={(event) => onAiModelChange(event.target.value)} type="text" value={aiModelDraft} />
            </label>
            <label className="editor-label">
              {ui.apiKeyLabel}
              <input className="editor-input" onChange={(event) => onAiApiKeyChange(event.target.value)} type="password" value={aiApiKeyDraft} />
            </label>
            <button className="secondary-button" disabled={aiSaving} onClick={onSaveAiConfig} type="button">
              {aiSaving ? ui.common.saving : ui.saveAiSettings}
            </button>
            <button className="secondary-button" onClick={onOpenPlugins} type="button">
              {isZh ? '打开插件中心' : 'Open plugin center'}
            </button>
            <button className="secondary-button" onClick={onRestoreBackup} type="button">
              {ui.restoreBackup}
            </button>
            <button className="primary-button" onClick={onBackupNow} type="button">
              {ui.runBackupNow}
            </button>
            <div className="settings-card">
              <div>
                <p className="panel-label">{ui.webClipBridgeLabel}</p>
                <h3 className="settings-card-title">{ui.webClipBridgeTitle}</h3>
                <p className="settings-card-description">{ui.webClipBridgeDescription}</p>
              </div>
              <label className="toggle-row">
                <input checked={webClipBridgeEnabledDraft} onChange={(event) => onWebClipBridgeEnabledChange(event.target.checked)} type="checkbox" />
                <span>{ui.webClipBridgeEnabledLabel}</span>
              </label>
              <label className="editor-label">
                {ui.webClipBridgePortLabel}
                <input className="editor-input" onChange={(event) => onWebClipBridgePortChange(event.target.value)} type="number" value={webClipBridgePortDraft} />
              </label>
              <label className="editor-label">
                {ui.webClipBridgeTokenLabel}
                <input className="editor-input" readOnly type="text" value={webClipBridgeStatus?.token ?? ''} />
              </label>
              <label className="editor-label">
                {ui.webClipBridgeEndpointLabel}
                <input className="editor-input" readOnly type="text" value={webClipBridgeStatus?.endpoint ?? ui.webClipBridgeUnavailable} />
              </label>
              <dl className="meta-grid">
                <div>
                  <dt>{ui.webClipBridgeStatusLabel}</dt>
                  <dd>{webClipBridgeStatus?.running ? ui.webClipBridgeStatusRunning : ui.webClipBridgeStatusStopped}</dd>
                </div>
                <div>
                  <dt>{ui.webClipBridgeErrorLabel}</dt>
                  <dd>{webClipBridgeStatus?.lastError ?? ui.common.none}</dd>
                </div>
              </dl>
              <p className="mini-hint">{ui.webClipBridgeHint}</p>
              <div className="settings-actions">
                <button className="secondary-button" disabled={webClipBridgeSaving} onClick={onSaveWebClipBridgeSettings} type="button">
                  {webClipBridgeSaving ? ui.common.saving : ui.webClipBridgeSave}
                </button>
                <button className="secondary-button" disabled={webClipBridgeSaving} onClick={onRegenerateWebClipBridgeToken} type="button">
                  {ui.webClipBridgeRegenerateToken}
                </button>
                <button className="secondary-button" disabled={!webClipBridgeStatus?.endpoint} onClick={onCopyWebClipBridgeEndpoint} type="button">
                  {ui.webClipBridgeCopyEndpoint}
                </button>
                <button className="secondary-button" disabled={!webClipBridgeStatus?.token} onClick={onCopyWebClipBridgeToken} type="button">
                  {ui.webClipBridgeCopyToken}
                </button>
              </div>
            </div>
            <div
              className="settings-card"
            >
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
                <p className="settings-release-notes">
                  {appUpdateState?.releaseNotes ?? ui.noReleaseNotes}
                </p>
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
                <button className="primary-button" disabled={!appUpdateState?.canInstall} onClick={onInstallAppUpdate} type="button">
                  {ui.installUpdateNow}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </article>

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
    </section>
  )
}
