import { useEffect, useRef, useState } from 'react'
import { DEFAULT_WEBDAV_SYNC_CONFIG, type ResolveWebDavSyncConflict, type WebDavSyncConfig, type WebDavSyncStatus } from '@shared/webdav-sync'
import WebDavSyncProgress from './WebDavSyncProgress'
import WebDavSyncConflictCard from './WebDavSyncConflictCard'

export default function WebDavSyncSettings({ isZh }: { isZh: boolean }) {
  const [status, setStatus] = useState<WebDavSyncStatus | null>(null)
  const [config, setConfig] = useState<WebDavSyncConfig>({ ...DEFAULT_WEBDAV_SYNC_CONFIG })
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const statusRequest = useRef(0)
  const action = useRef(0)
  const t = (zh: string, en: string) => isZh ? zh : en

  useEffect(() => {
    let mounted = true
    let reading = false, initialized = false
    const refresh = async () => {
      if (reading) return
      reading = true
      const request = ++statusRequest.current
      try {
        const value = await window.knowbook.getWebDavSyncStatus()
        if (mounted && request === statusRequest.current) {
          setStatus(value)
          if (!initialized) { setConfig(value.config); initialized = true }
        }
      } catch (reason) { if (mounted && !initialized) setError(String(reason)) }
      finally { reading = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 1000)
    return () => { mounted = false; clearInterval(timer); statusRequest.current++ }
  }, [])

  const edit = (patch: Partial<WebDavSyncConfig>) => { setConfig(current => ({ ...current, ...patch })); setDirty(true) }
  const run = async (operation: () => Promise<WebDavSyncStatus>) => {
    const id = ++action.current
    statusRequest.current++
    setBusy(true); setError('')
    try {
      const value = await operation()
      if (id === action.current) { statusRequest.current++; setStatus(value); return true }
    }
    catch (reason) {
      if (id !== action.current) return false
      setError(reason instanceof Error ? reason.message : String(reason))
      const request = ++statusRequest.current
      const fresh = await window.knowbook.getWebDavSyncStatus().catch(() => null)
      if (fresh && id === action.current && request === statusRequest.current) setStatus(fresh)
    } finally { if (id === action.current) setBusy(false) }
    return false
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
      <p>{t('同步文档、目录、图片附件和数据库。独立改动自动合并；重叠改动保留双方版本，供逐项处理。', 'Sync documents, folders, attachments and databases. Independent changes merge automatically; overlapping changes retain both versions for review.')}</p>
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
    {status?.progress && (status.phase === 'syncing' || status.phase === 'testing')
      ? <WebDavSyncProgress progress={status.progress} isZh={isZh} />
      : <p role="status">{working ? t('正在启动操作…', 'Starting…') : status?.message || t('尚未配置同步', 'Sync is not configured')}</p>}
    {status?.lastSyncAt ? <p className="mini-hint">{t('上次同步：', 'Last sync: ')}{new Date(status.lastSyncAt).toLocaleString()}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <p className="mini-hint">{t('密码由系统加密保存。AI 密钥、插件和本机设置不上传；历史与回收站保留在各设备。云端内容目前不提供端到端加密。', 'Passwords are protected by the OS. AI keys, plugins and device settings stay local; history and Trash remain on each device. Cloud content is not end-to-end encrypted.')}</p>
    {status?.conflicts.length ? <div>
      <h4>{t('待处理冲突', 'Conflicts to resolve')} ({status.conflicts.filter(conflict => !conflict.resolution).length}) · {t('待同步应用', 'Pending sync')} ({status.conflicts.filter(conflict => conflict.resolution).length})</h4>
      {status.conflicts.map(conflict => <WebDavSyncConflictCard
        key={JSON.stringify([status.config.url, status.config.username, status.config.directory, conflict.key, conflict.localHash, conflict.remoteHash])}
        conflict={conflict} isZh={isZh} disabled={Boolean(working || dirty)} onResolve={resolve} />)}
    </div> : null}
  </section>
}
