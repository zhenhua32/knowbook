import { useId, useRef } from 'react'
import type { WebDavSyncConflict } from '@shared/webdav-sync'
import { useWebDavSettingsState } from '../hooks/useWebDavSettingsState'
import { useAsyncActionFocus } from '../hooks/useAsyncActionFocus'
import WebDavSyncProgress from './WebDavSyncProgress'
import WebDavSyncConflictCard from './WebDavSyncConflictCard'
import WebDavProtocol5DeletionReview from './WebDavProtocol5DeletionReview'

export default function WebDavSyncSettings({ isZh }: { isZh: boolean }) {
  const { status, config, password, clearPassword, intervalDraft, intervalError, dirty,
    readLoading, readError, actionError, actionErrorTarget, actionTarget, actionKind, working, canStop,
    edit, setProtocol5, protocol5, setPassword, setClearPassword, setIntervalDraft, refreshStatus, save, testConnection, syncNow,
    previewProtocol5, resolveProtocol5, previewProtocol5Deletions, resolveProtocol5Deletion, resolve, cancel
  } = useWebDavSettingsState(isZh)
  const intervalErrorId = useId()
  const sectionRef = useRef<HTMLElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const previewRef = useRef<HTMLButtonElement>(null)
  const runAction = useAsyncActionFocus(sectionRef)
  const t = (zh: string, en: string) => isZh ? zh : en
  const operationText = actionKind === 'save' ? t('正在保存同步设置…', 'Saving sync settings…')
    : actionKind === 'cancel' ? t('正在停止本次同步…', 'Stopping this sync…')
    : actionKind === 'test' ? t('正在测试连接…', 'Testing connection…')
    : actionKind === 'sync' ? t('正在启动同步…', 'Starting sync…') : ''
  const primaryError = actionErrorTarget ? '' : actionError
  const protocol5Preview = status?.protocol5Preview
  const matchesConflict = (target: typeof actionErrorTarget, conflict: WebDavSyncConflict) => Boolean(status && target
    && target.url === status.config.url && target.username === status.config.username && target.directory === status.config.directory
    && target.key === conflict.key && target.localHash === conflict.localHash && target.remoteHash === conflict.remoteHash)

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
    <div className="webdav-settings-form">
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
      <label className="toggle-row"><input type="checkbox" checked={protocol5} onChange={event => setProtocol5(event.target.checked)} />
        <span>{t('在此目录启用同步块协议', 'Enable synced-block protocol for this folder')}</span>
      </label>
      {protocol5 && <p className="mini-hint">{t('首次发布请选择独立空目录；加入已有同步块工作区须从新的空接收端开始。', 'Use an empty dedicated folder for the first publish. Joining requires a new empty receiving profile.')}</p>}
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
    </fieldset>
    <div className={`webdav-main-actions${working ? ' is-working' : ''}`}>
      <div className="webdav-action-feedback">
        {primaryError && <p className="webdav-settings-action-error" role="alert">{primaryError}</p>}
        {status?.progress && (status.phase === 'syncing' || status.phase === 'testing') && actionKind !== 'cancel'
          ? <WebDavSyncProgress progress={status.progress} isZh={isZh} />
          : !primaryError && status && <p role="status">{operationText || status.message || t('尚未配置同步', 'Sync is not configured')}</p>}
      </div>
      {dirty ? <p className="mini-hint">{t('请先保存设置，再测试连接或同步。', 'Save your settings before testing or syncing.')}</p> : null}
      <div className="settings-actions">
        <button aria-busy={actionKind === 'save'} className="primary-button" type="button" disabled={working || !status || Boolean(intervalError)} onClick={event => runAction(event.currentTarget, save)}>{actionKind === 'save' ? t('正在保存…', 'Saving…') : t('保存同步设置', 'Save sync settings')}</button>
        <button aria-busy={actionKind === 'test'} className="secondary-button" type="button" disabled={working || dirty || !status?.hasPassword} onClick={event => runAction(event.currentTarget, testConnection)}>{t('测试连接', 'Test connection')}</button>
        <button aria-busy={actionKind === 'sync'} className="secondary-button" type="button" disabled={working || dirty || !status?.hasPassword} onClick={event => runAction(event.currentTarget, syncNow)}>{t('立即同步', 'Sync now')}</button>
        {canStop || actionKind === 'cancel' ? <button aria-busy={actionKind === 'cancel'} className="secondary-button" type="button" disabled={actionKind === 'cancel'} onClick={event => runAction(event.currentTarget, cancel, () => urlRef.current)}>{actionKind === 'cancel' ? t('正在停止…', 'Stopping…') : t('停止本次同步', 'Stop this sync')}</button> : null}
      </div>
    </div>
    </div>
    {status?.lastSyncAt ? <p className="mini-hint">{t('上次同步：', 'Last sync: ')}{new Date(status.lastSyncAt).toLocaleString()}</p> : null}
    <p className="mini-hint">{t('密码由系统加密保存。AI 密钥、插件和本机设置不上传；历史与回收站保留在各设备。云端内容目前不提供端到端加密。', 'Passwords are protected by the OS. AI keys, plugins and device settings stay local; history and Trash remain on each device. Cloud content is not end-to-end encrypted.')}</p>
    {status?.protocol5 && status.lastSyncAt && <section aria-label={t('同步块冲突', 'Synced block conflicts')}>
      <h4>{t('同步块冲突', 'Synced block conflicts')}</h4>
      <button ref={previewRef} className="secondary-button" type="button" disabled={working || dirty || !status.hasPassword}
        onClick={event => runAction(event.currentTarget, previewProtocol5)}>{t('读取最新冲突', 'Read latest conflicts')}</button>
      {protocol5Preview?.components.map((component, index) => <details open key={component.componentId} className="webdav-conflict-card">
        <summary>{t('冲突组', 'Conflict group')} {index + 1}</summary>
        <div className="webdav-conflict-body">
        {component.records.map(record => <div key={record.key}>
          <p className="mini-hint">{record.key}</p>
          {record.parts.map(part => <dl key={part.id}>
            <dt>{t('共同版本', 'Common version')}</dt><dd><pre>{part.basePreview}</pre></dd>
            <dt>{t('本机版本', 'Local version')}</dt><dd><pre>{part.localPreview}</pre></dd>
            <dt>{t('远端版本', 'Remote version')}</dt><dd><pre>{part.remotePreview}</pre></dd>
          </dl>)}
        </div>)}
        {component.choices.length ? <>
          <p className="mini-hint">{t('选择将应用到整组相互关联的记录。', 'Your choice applies to the full group of related records.')}</p>
          <div className="settings-actions">{component.choices.map(choice => <button key={choice} className="secondary-button" type="button"
            disabled={working || dirty || !status.hasPassword} onClick={event => runAction(event.currentTarget, () => resolveProtocol5({
              previewId: protocol5Preview.previewId, previewHash: protocol5Preview.previewHash, componentId: component.componentId, choice
            }), () => previewRef.current)}>{choice === 'local' ? t('应用本机整组', 'Apply entire local group') : t('应用远端整组', 'Apply entire remote group')}</button>)}</div>
        </> : <p className="mini-hint">{t('此组暂不能整组选择，双方版本继续保留。', 'Both versions remain available while this group requires further review.')}</p>}
        </div>
      </details>)}
    </section>}
    {status?.protocol5 && status.lastSyncAt && <WebDavProtocol5DeletionReview preview={status.protocol5DeletionPreview}
      disabled={working || dirty || !status.hasPassword} isZh={isZh} onPreview={previewProtocol5Deletions} onResolve={resolveProtocol5Deletion} />}
    {status?.conflicts.length ? <div>
      <h4>{t('待处理冲突', 'Conflicts to resolve')} ({status.conflicts.filter(conflict => !conflict.resolution).length}) · {t('待同步应用', 'Pending sync')} ({status.conflicts.filter(conflict => conflict.resolution).length})</h4>
      {status.conflicts.map(conflict => <WebDavSyncConflictCard
        key={JSON.stringify([status.config.url, status.config.username, status.config.directory, conflict.key, conflict.localHash, conflict.remoteHash])}
        conflict={conflict} isZh={isZh} disabled={Boolean(working || dirty)} onResolve={resolve}
        resolutionFeedbackActive={matchesConflict(actionTarget, conflict) || matchesConflict(actionErrorTarget, conflict)}
        resolutionError={matchesConflict(actionErrorTarget, conflict) ? actionError : undefined} />)}
    </div> : null}
  </section>
}
