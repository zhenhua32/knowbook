import { useRef } from 'react'
import { useAsyncActionFocus } from '../hooks/useAsyncActionFocus'
import { useWebClipExtensionSetup } from '../hooks/useWebClipExtensionSetup'
import './web-clip-extension-setup.css'

export function WebClipExtensionSetup({ isZh, active }: { isZh: boolean; active: boolean }) {
  const scopeRef = useRef<HTMLElement>(null)
  const runWithFocus = useAsyncActionFocus(scopeRef)
  const { exportedExtension, pending, error, completed, exportExtension, openDirectory } = useWebClipExtensionSetup({ isZh, active })
  return <section ref={scopeRef} className="web-clip-extension-setup" hidden={!active}
    aria-label={isZh ? '浏览器扩展安装文件' : 'Browser extension files'}>
    <p className="web-clip-extension-description">{isZh
      ? '导出此版本随附的浏览器扩展，供 Chrome 或 Edge 加载。'
      : 'Export the browser extension included with this version for Chrome or Edge.'}</p>
    <div className="web-clip-extension-actions">
      <button className="secondary-button web-clip-extension-export" type="button" disabled={!active || pending !== null}
        aria-busy={pending === 'export'} onClick={event => runWithFocus(event.currentTarget, exportExtension)}>
        {pending === 'export' ? (isZh ? '正在导出…' : 'Exporting…')
          : exportedExtension ? (isZh ? '重新导出扩展' : 'Export extension again') : (isZh ? '导出浏览器扩展' : 'Export browser extension')}
      </button>
      {exportedExtension && <button className="secondary-button web-clip-extension-open" type="button" disabled={!active || pending !== null}
        aria-busy={pending === 'open'} onClick={event => runWithFocus(event.currentTarget, openDirectory)}>
        {pending === 'open' ? (isZh ? '正在打开…' : 'Opening…') : (isZh ? '打开导出目录' : 'Open export folder')}
      </button>}
    </div>
    <div className="web-clip-extension-feedback">
      {pending && <p role="status">{pending === 'export'
        ? (isZh ? '在文件夹选择窗口中选择导出位置。' : 'Choose an export location in the folder picker.')
        : (isZh ? '正在打开已导出的扩展目录。' : 'Opening the exported extension folder.')}</p>}
      {error && <p className="web-clip-extension-error" data-action-kind={error.kind} role="alert">{error.message}</p>}
      {!pending && !error && completed && <p role="status">{completed === 'export'
        ? (isZh ? '扩展已导出，可以打开目录查看安装文件。' : 'Extension exported. Open the folder to see its files.')
        : (isZh ? '导出目录已打开。' : 'Export folder opened.')}</p>}
    </div>
    {exportedExtension && <dl className="web-clip-extension-result">
      <div><dt>{isZh ? '最近导出目录' : 'Last export folder'}</dt><dd>{exportedExtension.directory}</dd></div>
      <div><dt>{isZh ? '扩展版本' : 'Extension version'}</dt><dd>{exportedExtension.version}</dd></div>
    </dl>}
  </section>
}
