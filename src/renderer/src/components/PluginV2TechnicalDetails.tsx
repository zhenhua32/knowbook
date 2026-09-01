import type { PluginV2Details } from '@shared/contracts'

type PluginV2TechnicalDetailsProps = {
  details: PluginV2Details | null
  error: string | null
  isZh: boolean
  loading: boolean
  onReload: () => void
}

function compactRevision(revisionId: string): string {
  return revisionId.length > 22 ? `${revisionId.slice(0, 19)}…` : revisionId
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

export function PluginV2TechnicalDetails({
  details,
  error,
  isZh,
  loading,
  onReload
}: PluginV2TechnicalDetailsProps) {
  if (loading && !details) {
    return <p aria-live="polite" className="plugin-technical-loading">{isZh ? '正在读取权限、版本与运行日志…' : 'Loading permissions, revisions, and runtime logs…'}</p>
  }
  if (error) {
    return (
      <div className="plugin-technical-error" role="alert">
        <span>{error}</span>
        <button className="plugin-text-action" onClick={onReload} type="button">{isZh ? '重试' : 'Retry'}</button>
      </div>
    )
  }
  if (!details) return null

  return (
    <div className="plugin-technical-details">
      <details open>
        <summary>
          <span>{isZh ? '当前权限' : 'Current permissions'}</span>
          <strong>{details.permissions.length}</strong>
        </summary>
        {details.permissions.length > 0 ? (
          <div className="plugin-permission-list">
            {details.permissions.map((permission) => (
              <code key={`${permission.capability}@${permission.version}`}>{permission.capability}@{permission.version}</code>
            ))}
          </div>
        ) : <p>{isZh ? '此 revision 不请求宿主权限。' : 'This revision requests no host permissions.'}</p>}
      </details>
      <details open>
        <summary>
          <span>{isZh ? '版本历史' : 'Revision history'}</span>
          <strong>{details.revisions.length}</strong>
        </summary>
        <div className="plugin-revision-list">
          {details.revisions.map((revision) => (
            <div className={revision.current ? 'current' : ''} key={revision.id}>
              <i aria-hidden="true" />
              <div>
                <strong>{revision.version}</strong>
                <code title={revision.id}>{compactRevision(revision.id)}</code>
              </div>
              <span>{revision.current
                ? (isZh ? '当前' : 'Current')
                : revision.activated
                  ? (isZh ? '已运行' : 'Activated')
                  : revision.staticCheckStatus}</span>
            </div>
          ))}
        </div>
      </details>
      <details>
        <summary>
          <span>{isZh ? '最近运行日志' : 'Recent runtime logs'}</span>
          <strong>{details.recentLogs.length}</strong>
        </summary>
        {details.recentLogs.length > 0 ? (
          <div className="plugin-runtime-log-list">
            {details.recentLogs.map((entry) => (
              <div className={`level-${entry.level}`} key={entry.id}>
                <span>{entry.level}</span>
                <div><strong>{entry.event}</strong><p>{entry.message}</p></div>
                <time dateTime={entry.createdAt}>{formatUpdatedAt(entry.createdAt, isZh)}</time>
              </div>
            ))}
          </div>
        ) : <p>{isZh ? '暂无运行日志。' : 'No runtime logs yet.'}</p>}
      </details>
    </div>
  )
}
