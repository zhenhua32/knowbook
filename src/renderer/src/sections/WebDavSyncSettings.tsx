import { useId, useRef } from 'react'
import { useWebDavSettingsState } from '../hooks/useWebDavSettingsState'
import { useAsyncActionFocus } from '../hooks/useAsyncActionFocus'
import WebDavSyncProgress from './WebDavSyncProgress'
import WebDavSyncConflictCard from './WebDavSyncConflictCard'

export default function WebDavSyncSettings({ isZh }: { isZh: boolean }) {
  const { status, config, password, clearPassword, intervalDraft, intervalError, dirty,
    readLoading, readError, actionError, actionKind, working, canStop,
    edit, setPassword, setClearPassword, setIntervalDraft, refreshStatus, save, testConnection, syncNow, resolve, cancel
  } = useWebDavSettingsState(isZh)
  const intervalErrorId = useId()
  const sectionRef = useRef<HTMLElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const runAction = useAsyncActionFocus(sectionRef)
  const t = (zh: string, en: string) => isZh ? zh : en
  const operationText = actionKind === 'save' ? t('正在保存同步设置…', 'Saving sync settings…')
    : actionKind === 'resolve' ? t('正在保存冲突处理方式…', 'Saving conflict resolution…')
    : actionKind === 'cancel' ? t('正在停止本次同步…', 'Stopping this sync…')
    : actionKind === 'test' ? t('正在测试连接…', 'Testing connection…')
    : actionKind === 'sync' ? t('正在启动同步…', 'Starting sync…') : ''

  return <section ref={sectionRef} className="settings-group webdav-settings" aria-label={t('WebDAV 同步', 'WebDAV sync')}>
    <div className="settings-group-heading">
      <h4>{t('WebDAV 跨设备同步', 'WebDAV device sync')}</h4>
      <p>{t('同步文档、目录、图片附件和数据库。独立改动自动合并；重叠改动保留双方版本，供逐项处理。', 'Sync documents, folders, attachments and databases. Independent changes merge automatically; overlapping changes retain both versions for review.')}</p>
    </div>
    {!status && <p role="status">{readLoading ? t('正在加载同步设置…', 'Loading sync settings…')
      : t('同步设置未加载，请重试。', 'Sync settings are unavailable. Reload to retry.')}</p>}
    {readError && <div className="webdav-settings-read-error">
      <p role="alert">{readError}</p>
      {status && <p className="mini-hint">{t('显示上次读取的状态，可重新加载以获取最新状态。', 'Showing the last known status. Reload to get the latest status.')}</p>}
      <button className="secondary-button" type="button" disabled={readLoading || actionKind === 'save' || actionKind === 'resolve' || actionKind === 'cancel'} onClick={event => runAction(event.currentTarget, refreshStatus, () => urlRef.current)}>{t('重新加载', 'Reload')}</button>
    </div>}
    <fieldset aria-busy={working} disabled={working || !status} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12 }}>
      <label className="editor-label">{t('WebDAV 服务地址', 'WebDAV URL')}
        <input ref={urlRef} className="editor-input" type="url" value={config.url} placeholder="https://dav.jianguoyun.com/dav/" onChange={event => edit({ url: event.target.value })} />
      </label>
      <label className="editor-label">{t('用户名', 'Username')}
        <input className="editor-input" autoComplete="off" value={config.username} onChange={event => edit({ username: event.target.value })} />
      </label>
      <label className="editor-label">{t('应用密码', 'App password')}
        <input className="editor-input" type="password" autoComplete="new-password" value={password}
          placeholder={status?.hasPassword ? t('已保存，留空保持原密码', 'Saved; leave blank to keep') : t('填写服务商生成的应用密码', 'App password from your provider')}
          onChange={event => setPassword(event.target.value)} />
      </label>
      <label className="toggle-row"><input type="checkbox" checked={clearPassword} onChange={event => setClearPassword(event.target.checked)} />
        <span>{t('清除已保存的应用密码（请同时关闭自动同步）', 'Clear saved password (disable automatic sync first)')}</span>
      </label>
      <label className="editor-label">{t('远端同步目录', 'Remote sync folder')}
        <input className="editor-input" value={config.directory} onChange={event => edit({ directory: event.target.value })} />
      </label>
      <p className="mini-hint">{t('同一工作区的设备填写相同地址、账号和目录。请使用 KnowBook 专用目录。', 'Use the same URL, account and folder on each device. Choose a folder dedicated to KnowBook.')}</p>
      <label className="toggle-row"><input type="checkbox" checked={config.enabled} onChange={event => edit({ enabled: event.target.checked })} />
        <span>{t('启用自动同步（应用运行时）', 'Automatic sync while the app is running')}</span>
      </label>
      <label className="editor-label">{t('同步间隔（分钟）', 'Sync interval (minutes)')}
        <input aria-describedby={intervalError ? intervalErrorId : undefined} aria-invalid={Boolean(intervalError)} className="editor-input" type="text" inputMode="numeric" pattern="[0-9]*" value={intervalDraft} onChange={event => setIntervalDraft(event.target.value)} />
      </label>
      {intervalError && <p className="webdav-settings-interval-error" id={intervalErrorId} role="alert">{intervalError}</p>}
      <label className="toggle-row"><input type="checkbox" checked={config.allowInsecureHttp} onChange={event => edit({ allowInsecureHttp: event.target.checked })} />
        <span>{t('允许 HTTP（连接不加密，仅用于可信网络）', 'Allow HTTP (unencrypted; trusted networks only)')}</span>
      </label>
      <div className="settings-actions">
        <button aria-busy={actionKind === 'save'} className="primary-button" type="button" disabled={Boolean(intervalError)} onClick={event => runAction(event.currentTarget, save)}>{actionKind === 'save' ? t('正在保存…', 'Saving…') : t('保存同步设置', 'Save sync settings')}</button>
        <button aria-busy={actionKind === 'test'} className="secondary-button" type="button" disabled={dirty || !status?.hasPassword} onClick={event => runAction(event.currentTarget, testConnection)}>{t('测试连接', 'Test connection')}</button>
        <button aria-busy={actionKind === 'sync'} className="secondary-button" type="button" disabled={dirty || !status?.hasPassword} onClick={event => runAction(event.currentTarget, syncNow)}>{t('立即同步', 'Sync now')}</button>
      </div>
    </fieldset>
    {canStop || actionKind === 'cancel' ? <button aria-busy={actionKind === 'cancel'} className="secondary-button" type="button" disabled={actionKind === 'cancel'} onClick={event => runAction(event.currentTarget, cancel, () => urlRef.current)}>{actionKind === 'cancel' ? t('正在停止…', 'Stopping…') : t('停止本次同步', 'Stop this sync')}</button> : null}
    {dirty ? <p className="mini-hint">{t('请先保存设置，再测试连接或同步。', 'Save your settings before testing or syncing.')}</p> : null}
    {status?.progress && (status.phase === 'syncing' || status.phase === 'testing') && actionKind !== 'cancel'
      ? <WebDavSyncProgress progress={status.progress} isZh={isZh} />
      : status && <p role="status">{operationText || status.message || t('尚未配置同步', 'Sync is not configured')}</p>}
    {status?.lastSyncAt ? <p className="mini-hint">{t('上次同步：', 'Last sync: ')}{new Date(status.lastSyncAt).toLocaleString()}</p> : null}
    {actionError && <p className="webdav-settings-action-error" role="alert">{actionError}</p>}
    <p className="mini-hint">{t('密码由系统加密保存。AI 密钥、插件和本机设置不上传；历史与回收站保留在各设备。云端内容目前不提供端到端加密。', 'Passwords are protected by the OS. AI keys, plugins and device settings stay local; history and Trash remain on each device. Cloud content is not end-to-end encrypted.')}</p>
    {status?.conflicts.length ? <div>
      <h4>{t('待处理冲突', 'Conflicts to resolve')} ({status.conflicts.filter(conflict => !conflict.resolution).length}) · {t('待同步应用', 'Pending sync')} ({status.conflicts.filter(conflict => conflict.resolution).length})</h4>
      {status.conflicts.map(conflict => <WebDavSyncConflictCard
        key={JSON.stringify([status.config.url, status.config.username, status.config.directory, conflict.key, conflict.localHash, conflict.remoteHash])}
        conflict={conflict} isZh={isZh} disabled={Boolean(working || dirty)} onResolve={resolve} />)}
    </div> : null}
  </section>
}
