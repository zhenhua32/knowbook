import { useEffect, useState } from 'react'
import { DEFAULT_WEBDAV_SYNC_CONFIG, type ResolveWebDavSyncConflict, type WebDavSyncConfig, type WebDavSyncStatus } from '@shared/webdav-sync'

export default function WebDavSyncSettings({ isZh }: { isZh: boolean }) {
  const [status, setStatus] = useState<WebDavSyncStatus | null>(null)
  const [config, setConfig] = useState<WebDavSyncConfig>({ ...DEFAULT_WEBDAV_SYNC_CONFIG })
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const t = (zh: string, en: string) => isZh ? zh : en

  useEffect(() => {
    let mounted = true
    window.knowbook.getWebDavSyncStatus().then(value => {
      if (mounted) { setStatus(value); setConfig(value.config) }
    }).catch(reason => { if (mounted) setError(String(reason)) })
    const timer = setInterval(() => {
      window.knowbook.getWebDavSyncStatus().then(value => { if (mounted) setStatus(value) }).catch(() => {})
    }, 3000)
    return () => { mounted = false; clearInterval(timer) }
  }, [])

  const edit = (patch: Partial<WebDavSyncConfig>) => { setConfig(current => ({ ...current, ...patch })); setDirty(true) }
  const run = async (operation: () => Promise<WebDavSyncStatus>) => {
    setBusy(true); setError('')
    try { setStatus(await operation()) }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      const fresh = await window.knowbook.getWebDavSyncStatus().catch(() => null)
      if (fresh) setStatus(fresh)
    } finally { setBusy(false) }
  }
  const save = () => run(async () => {
    const value = await window.knowbook.saveWebDavSyncConfig({ ...config, ...(clearPassword ? { password: '' } : password ? { password } : {}) })
    setConfig(value.config); setPassword(''); setClearPassword(false); setDirty(false)
    return value
  })
  const resolve = (input: ResolveWebDavSyncConflict) => run(() => window.knowbook.resolveWebDavSyncConflict(input))
  const working = busy || status?.phase === 'syncing' || status?.phase === 'testing'

  return <section className="settings-group" aria-label={t('WebDAV 同步', 'WebDAV sync')}>
    <div className="settings-group-heading">
      <h4>{t('WebDAV 跨设备同步', 'WebDAV device sync')}</h4>
      <p>{t('同步文档、目录、图片附件和数据库。首次连接合并两端内容；遇到冲突保留双方版本。', 'Sync documents, folders, attachments and databases. First sync merges both workspaces; conflicts retain both versions.')}</p>
    </div>
    <fieldset disabled={working || !status} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12 }}>
      <label className="editor-label">{t('WebDAV 服务地址', 'WebDAV URL')}
        <input className="editor-input" type="url" value={config.url} placeholder="https://dav.jianguoyun.com/dav/" onChange={event => edit({ url: event.target.value })} />
      </label>
      <label className="editor-label">{t('用户名', 'Username')}
        <input className="editor-input" autoComplete="off" value={config.username} onChange={event => edit({ username: event.target.value })} />
      </label>
      <label className="editor-label">{t('应用密码', 'App password')}
        <input className="editor-input" type="password" autoComplete="new-password" value={password}
          placeholder={status?.hasPassword ? t('已保存，留空保持原密码', 'Saved; leave blank to keep') : t('填写服务商生成的应用密码', 'App password from your provider')}
          onChange={event => { setPassword(event.target.value); setClearPassword(false); setDirty(true) }} />
      </label>
      <label className="toggle-row"><input type="checkbox" checked={clearPassword} onChange={event => { setClearPassword(event.target.checked); setPassword(''); setDirty(true) }} />
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
        <input className="editor-input" type="number" min={1} max={1440} value={config.intervalMinutes} onChange={event => edit({ intervalMinutes: Number(event.target.value) })} />
      </label>
      <label className="toggle-row"><input type="checkbox" checked={config.allowInsecureHttp} onChange={event => edit({ allowInsecureHttp: event.target.checked })} />
        <span>{t('允许 HTTP（连接不加密，仅用于可信网络）', 'Allow HTTP (unencrypted; trusted networks only)')}</span>
      </label>
      <div className="settings-actions">
        <button className="primary-button" type="button" onClick={save}>{t('保存同步设置', 'Save sync settings')}</button>
        <button className="secondary-button" type="button" disabled={dirty || !status?.hasPassword} onClick={() => run(() => window.knowbook.testWebDavConnection())}>{t('测试连接', 'Test connection')}</button>
        <button className="secondary-button" type="button" disabled={dirty || !status?.hasPassword} onClick={() => run(() => window.knowbook.syncWebDavNow())}>{t('立即同步', 'Sync now')}</button>
      </div>
    </fieldset>
    {working ? <button className="secondary-button" type="button" onClick={() => run(() => window.knowbook.cancelWebDavSync())}>{t('停止本次同步', 'Stop this sync')}</button> : null}
    {dirty ? <p className="mini-hint">{t('请先保存设置，再测试连接或同步。', 'Save your settings before testing or syncing.')}</p> : null}
    <p role="status">{working ? t('正在处理…', 'Working…') : status?.message || t('尚未配置同步', 'Sync is not configured')}</p>
    {status?.lastSyncAt ? <p className="mini-hint">{t('上次同步：', 'Last sync: ')}{new Date(status.lastSyncAt).toLocaleString()}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <p className="mini-hint">{t('密码由系统加密保存。AI 密钥、插件和本机设置不上传；历史与回收站保留在各设备。云端内容目前不提供端到端加密。', 'Passwords are protected by the OS. AI keys, plugins and device settings stay local; history and Trash remain on each device. Cloud content is not end-to-end encrypted.')}</p>
    {status?.conflicts.length ? <div>
      <h4>{t('待处理冲突', 'Conflicts to resolve')} ({status.conflicts.length})</h4>
      {status.conflicts.map(conflict => <details key={conflict.key}>
        <summary>{conflict.title}</summary>
        <p>{t('本地版本', 'Local version')}</p><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{conflict.localPreview}</pre>
        <p>{t('远端版本', 'Remote version')}</p><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{conflict.remotePreview}</pre>
        <div className="settings-actions">
          {conflict.canKeepBoth ? <button className="primary-button" type="button" disabled={working || dirty} onClick={() => resolve({ key: conflict.key, choice: 'both' })}>{t('两份都保留', 'Keep both')}</button> : null}
          <button className="secondary-button" type="button" disabled={working || dirty} onClick={() => resolve({ key: conflict.key, choice: 'local' })}>{t('使用本地版本', 'Use local version')}</button>
          <button className="secondary-button" type="button" disabled={working || dirty} onClick={() => resolve({ key: conflict.key, choice: 'remote' })}>{t('使用远端版本', 'Use remote version')}</button>
        </div>
      </details>)}
    </div> : null}
  </section>
}
