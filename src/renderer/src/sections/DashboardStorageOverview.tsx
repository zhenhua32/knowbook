import type { RecentDocument, WorkspaceSummary } from '@shared/contracts'
import type { UiText } from '../i18n'
import './management-sections.css'

type Props = {
  ui: UiText
  loading: boolean
  summary: WorkspaceSummary
  aiEndpoint: string
  recentDocuments: RecentDocument[]
  onOpenDocument: (documentId: string) => void
}

/** Dashboard storage and recents need no settings state or settings IPC. */
export function DashboardStorageOverview({ ui, loading, summary, aiEndpoint, recentDocuments, onOpenDocument }: Props) {
  return <section className="detail-grid">
    <article className="panel large-panel">
      <div className="panel-head">
        <div>
          <p className="panel-label">{ui.storageLabel}</p>
          <h3>{ui.storageTitle}</h3>
        </div>
        {loading ? <span className="pill">{ui.common.loading}</span> : <span className="pill">{ui.common.ready}</span>}
      </div>
      <dl className="meta-grid">
        <div><dt>{ui.databasePath}</dt><dd>{summary.databasePath || ui.initializing}</dd></div>
        <div><dt>{ui.backupRoot}</dt><dd>{summary.backupRoot || ui.initializing}</dd></div>
        <div><dt>{ui.lastBackup}</dt><dd>{summary.lastBackupAt ? new Date(summary.lastBackupAt).toLocaleString(ui.locale) : ui.notYetExported}</dd></div>
        <div><dt>{ui.aiEndpoint}</dt><dd>{aiEndpoint}</dd></div>
      </dl>
    </article>
    <article className="panel large-panel">
      <div className="panel-head"><div>
        <p className="panel-label">{ui.recentDocumentsLabel}</p>
        <h3>{ui.recentDocumentsTitle}</h3>
      </div></div>
      <div className="document-list">
        {recentDocuments.map(document => <button className="document-row document-button" key={document.id} onClick={() => onOpenDocument(document.id)} type="button">
          <div><strong>{document.title}</strong><p>{document.path}</p></div>
          <div className="document-meta"><span>{document.blockCount} {ui.docStatBlocks}</span><span>{new Date(document.updatedAt).toLocaleDateString(ui.locale)}</span></div>
        </button>)}
      </div>
    </article>
  </section>
}
