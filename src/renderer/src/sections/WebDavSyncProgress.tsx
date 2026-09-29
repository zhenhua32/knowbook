import type { WebDavSyncProgress as Progress } from '@shared/webdav-sync'
import './webdav-sync.css'

export default function WebDavSyncProgress({ progress, isZh, now = Date.now() }: { progress: Progress; isZh: boolean; now?: number }) {
  const t = (zh: string, en: string) => isZh ? zh : en
  const stages: Record<Progress['stage'], string> = {
    checking: t('正在验证连接与读写能力', 'Checking connection and read/write access'),
    preparing: t('正在整理本地文档与附件', 'Preparing local documents and attachments'),
    comparing: t('正在比对云端版本', 'Comparing cloud versions'),
    uploading: t('正在上传文档与附件', 'Uploading documents and attachments'),
    downloading: t('正在下载文档与附件', 'Downloading documents and attachments'),
    publishing: t('正在保存云端同步结果', 'Saving cloud sync results'),
    applying: t('正在保存本地同步结果', 'Saving local sync results')
  }
  const total = progress.total === null ? 0 : progress.total + progress.attachmentsTotal
  const completed = progress.completed + progress.attachmentsCompleted
  const elapsed = Math.max(0, Math.floor((now - Date.parse(progress.startedAt)) / 1000))
  const duration = elapsed < 60 ? t(`${elapsed} 秒`, `${elapsed}s`) : t(`${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`, `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`)
  const waiting = progress.waitingUntil ? Math.max(0, Math.ceil((Date.parse(progress.waitingUntil) - now) / 1000)) : 0

  return <div className="webdav-sync-progress">
    <p role="status">{stages[progress.stage]}</p>
    <progress aria-label={t('本阶段进度', 'Current stage progress')} max={total || 1} value={total ? Math.min(completed, total) : undefined} />
    {progress.total !== null ? <div className="webdav-sync-progress-counts">
      <span>{t('本阶段：文档与数据库', 'Current stage: documents and databases')} {progress.completed} / {progress.total}</span>
      {progress.attachmentsTotal > 0 ? <span>{t('附件已处理', 'Attachments processed')} {progress.attachmentsCompleted} / {progress.attachmentsTotal}</span> : null}
    </div> : null}
    {progress.currentItem ? <p className="webdav-sync-progress-item">{t('当前文档：', 'Current document: ')}{progress.currentItem}</p> : null}
    {progress.currentAttachment ? <p className="webdav-sync-progress-item">{t('当前附件：', 'Current attachment: ')}{progress.currentAttachment}</p> : null}
    <p className="mini-hint">{t('已用时 ', 'Elapsed ')}{duration} · {t(`已完成 ${progress.requestsCompleted} 次请求`, `${progress.requestsCompleted} requests completed`)}</p>
    {waiting > 0 ? <p className="mini-hint">{t(`正在按服务频率限制等待，约 ${waiting} 秒后继续。`, `Waiting for the service rate limit; continuing in about ${waiting}s.`)}</p> : null}
  </div>
}
