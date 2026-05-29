import type { PluginDashboardCard, WorkspaceEventRecord, WorkspaceSummary } from '@shared/contracts'
import type { UiText } from '../i18n'

type WorkspaceDashboardSectionProps = {
  isAiEnabled: boolean
  onBackupNow: () => void
  onOpenDocument: (documentId: string) => void
  onRestoreBackup: () => void
  pluginDashboardCards: PluginDashboardCard[]
  recentEvents: WorkspaceEventRecord[]
  summary: WorkspaceSummary
  ui: UiText
}

export function WorkspaceDashboardSection({
  isAiEnabled,
  onBackupNow,
  onOpenDocument,
  onRestoreBackup,
  pluginDashboardCards,
  recentEvents,
  summary,
  ui
}: WorkspaceDashboardSectionProps) {
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">{ui.workspaceStatusEyebrow}</p>
          <h2>{ui.workspaceStatusTitle}</h2>
          <p className="hero-copy">{ui.workspaceStatusBody}</p>
        </div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <button className="secondary-button" onClick={onRestoreBackup} type="button">
            {ui.restoreBackup}
          </button>
          <button className="primary-button" onClick={onBackupNow} type="button">
            {ui.runBackupNow}
          </button>
        </div>
      </section>

      <section className="stats-grid">
        <article className="stat-card">
          <span className="stat-label">{ui.documentsLabel}</span>
          <strong>{summary.documents}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">{ui.blocksLabel}</span>
          <strong>{summary.blocks}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">{ui.linksLabel}</span>
          <strong>{summary.links}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">{ui.aiLabel}</span>
          <strong>{ui.aiReadyState(isAiEnabled)}</strong>
        </article>
      </section>

      <section className="detail-grid">
        <article className="panel large-panel">
          <div className="panel-head">
            <div>
              <p className="panel-label">{ui.automationFeedLabel}</p>
              <h3>{ui.recentEventsTitle}</h3>
            </div>
          </div>
          {recentEvents.length > 0 ? (
            <div className="event-feed">
              {recentEvents.map((event) => (
                <button
                  className="event-feed-item"
                  disabled={!event.documentId}
                  key={event.id}
                  onClick={() => {
                    if (event.documentId) {
                      onOpenDocument(event.documentId)
                    }
                  }}
                  type="button"
                >
                  <div className="event-feed-head">
                    <strong>{event.title}</strong>
                    <span>{new Date(event.createdAt).toLocaleTimeString(ui.locale, { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <span className="event-feed-description">{event.description}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="mini-hint">{ui.noAutomationEvents}</p>
          )}
        </article>
      </section>

      {pluginDashboardCards.length > 0 ? (
        <section className="plugin-dashboard-grid">
          {pluginDashboardCards.map((card) => (
            <article className="panel plugin-dashboard-card" key={`${card.pluginId}:${card.id}`}>
              <div className="plugin-dashboard-head">
                <p className="panel-label">{ui.pluginCardLabel}</p>
                <span className="pill">{card.pluginId}</span>
              </div>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </section>
      ) : null}
    </>
  )
}