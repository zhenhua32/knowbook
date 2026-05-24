import type { AppUpdateState, RecentDocument, WorkspaceSummary } from '@shared/contracts'
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
  aiBaseUrlDraft: string
  onAiBaseUrlChange: (value: string) => void
  aiModelDraft: string
  onAiModelChange: (value: string) => void
  aiApiKeyDraft: string
  onAiApiKeyChange: (value: string) => void
  aiEmbeddingBaseUrlDraft: string
  onAiEmbeddingBaseUrlChange: (value: string) => void
  aiEmbeddingModelDraft: string
  onAiEmbeddingModelChange: (value: string) => void
  aiEmbeddingApiKeyDraft: string
  onAiEmbeddingApiKeyChange: (value: string) => void
  aiSaving: boolean
  onSaveAiConfig: () => void
  onOpenPlugins: () => void
  onRestoreBackup: () => void
  onBackupNow: () => void
  appUpdateState: AppUpdateState | null
  appUpdateRefreshing: boolean
  onCheckForAppUpdates: () => void
  onInstallAppUpdate: () => void
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
  aiBaseUrlDraft,
  onAiBaseUrlChange,
  aiModelDraft,
  onAiModelChange,
  aiApiKeyDraft,
  onAiApiKeyChange,
  aiEmbeddingBaseUrlDraft,
  onAiEmbeddingBaseUrlChange,
  aiEmbeddingModelDraft,
  onAiEmbeddingModelChange,
  aiEmbeddingApiKeyDraft,
  onAiEmbeddingApiKeyChange,
  aiSaving,
  onSaveAiConfig,
  onOpenPlugins,
  onRestoreBackup,
  onBackupNow,
  appUpdateState,
  appUpdateRefreshing,
  onCheckForAppUpdates,
  onInstallAppUpdate
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
          <div className="editor-fields" style={{ marginTop: '16px' }}>
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
            <label className="editor-label">
              {ui.embeddingBaseUrl}
              <input
                className="editor-input"
                onChange={(event) => onAiEmbeddingBaseUrlChange(event.target.value)}
                placeholder={isZh ? '留空则自动推导' : 'Leave blank to auto-derive'}
                type="text"
                value={aiEmbeddingBaseUrlDraft}
              />
            </label>
            <label className="editor-label">
              {ui.embeddingModel}
              <input className="editor-input" onChange={(event) => onAiEmbeddingModelChange(event.target.value)} type="text" value={aiEmbeddingModelDraft} />
            </label>
            <label className="editor-label">
              {ui.embeddingApiKeyLabel}
              <input
                className="editor-input"
                onChange={(event) => onAiEmbeddingApiKeyChange(event.target.value)}
                placeholder={isZh ? '留空则使用上述 Key' : 'Leave blank to use above key'}
                type="password"
                value={aiEmbeddingApiKeyDraft}
              />
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
            <div
              style={{
                marginTop: '8px',
                padding: '16px',
                borderRadius: '18px',
                border: '1px solid rgba(91, 72, 44, 0.18)',
                background: 'rgba(255, 252, 246, 0.86)',
                display: 'grid',
                gap: '12px'
              }}
            >
              <div>
                <p className="panel-label">{ui.appUpdateLabel}</p>
                <h3 style={{ margin: '4px 0 0' }}>{ui.appUpdateTitle}</h3>
                <p style={{ margin: '8px 0 0', color: 'rgba(91, 72, 44, 0.76)' }}>{ui.appUpdateDescription}</p>
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
                <p style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', color: 'rgba(91, 72, 44, 0.8)' }}>
                  {appUpdateState?.releaseNotes ?? ui.noReleaseNotes}
                </p>
              </div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
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