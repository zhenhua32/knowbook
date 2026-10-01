import type { PluginDashboardCard, WorkspaceEventRecord, WorkspaceSummary } from '@shared/contracts'
import type { UiText } from '../i18n'
import { formatWorkspaceEvent, formatWorkspaceEventTime, type WorkspaceActivityIcon } from './workspace-event-presentation'
import './management-sections.css'
import './workspace-dashboard.css'

type WorkspaceDashboardSectionProps = {
  isAiEnabled: boolean
  hasAiApiKey: boolean
  onBackupNow: () => void
  onOpenDocument: (documentId: string) => void
  onRestoreBackup: () => void
  pluginDashboardCards: PluginDashboardCard[]
  recentEvents: WorkspaceEventRecord[]
  summary: WorkspaceSummary
  ui: UiText
}

function ActivityIcon({ kind }: { kind: WorkspaceActivityIcon }) {
  return (
    <span className="dashboard-activity-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        {kind === 'ai' || kind === 'summary' ? (
          <path d="m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8L12 3Z" />
        ) : kind === 'move' ? (
          <><path d="M3 7h7l2 3h9v9H3Z" /><path d="M13 5h7m-3-3 3 3-3 3" /></>
        ) : kind === 'delete' ? (
          <><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6" /></>
        ) : kind === 'plugin' ? (
          <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>
        ) : (
          <><path d="M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6" /></>
        )}
      </svg>
    </span>
  )
}

export function WorkspaceDashboardSection({
  isAiEnabled,
  hasAiApiKey,
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
        <div className="settings-actions">
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
          <strong>{ui.aiReadyState(isAiEnabled, hasAiApiKey)}</strong>
        </article>
      </section>

      <section className="detail-grid single-column">
        <article className={`panel dashboard-activity-panel${recentEvents.length === 0 ? ' dashboard-events-empty' : ''}`}>
          <div className="panel-head">
            <div>
              <p className="panel-label">{ui.automationFeedLabel}</p>
              <h3>{ui.recentEventsTitle}</h3>
            </div>
          </div>
          {recentEvents.length > 0 ? (
            <ol className="dashboard-activity-list" aria-label={ui.recentEventsTitle}>
              {recentEvents.map((event) => {
                const activity = formatWorkspaceEvent(event, ui.locale)
                const time = formatWorkspaceEventTime(event.createdAt, ui.locale)
                const documentId = event.documentId
                const openLabel = ui.locale === 'zh-CN' ? '打开文档' : 'Open document'
                return (
                  <li className="dashboard-activity-row" key={event.id}>
                    <ActivityIcon kind={activity.icon} />
                    <div className="dashboard-activity-copy">
                      <div className="dashboard-activity-heading">
                        <strong>{activity.title}</strong>
                        {time.dateTime ? (
                          <time className="dashboard-activity-time" dateTime={time.dateTime} title={time.title}>{time.text}</time>
                        ) : <span className="dashboard-activity-time">{time.text}</span>}
                      </div>
                      {activity.description ? <p className="dashboard-activity-description">{activity.description}</p> : null}
                      {activity.path ? <p className="dashboard-activity-path">{activity.path}</p> : null}
                    </div>
                    {documentId ? (
                      <button className="dashboard-activity-open" type="button"
                        aria-label={activity.documentTitle ? `${openLabel}${ui.locale === 'zh-CN' ? '：' : ': '}${activity.documentTitle}` : openLabel}
                        onClick={() => onOpenDocument(documentId)}>{openLabel}</button>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          ) : (
            <p className="dashboard-activity-empty">{ui.noAutomationEvents}</p>
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
