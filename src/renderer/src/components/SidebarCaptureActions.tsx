import { openDocumentTemplates, openQuickCapture } from '../documentCapture'
import './sidebar-capture-actions.css'

export type SidebarCaptureActionsProps = { isZh: boolean; disabled: boolean; collapsed?: boolean }

export default function SidebarCaptureActions({ isZh, disabled, collapsed = false }: SidebarCaptureActionsProps) {
  const templateLabel = isZh ? '从模板新建' : 'New from template'
  const captureLabel = isZh ? '快速记录' : 'Quick capture'
  const buttons = <>
    <button type="button" className={collapsed ? 'nav-icon-btn' : undefined} disabled={disabled}
      title={templateLabel} aria-label={templateLabel} onClick={() => openDocumentTemplates()}>
      <svg aria-hidden="true" className="sidebar-icon-svg" viewBox="0 0 20 20"><path d="M4 3h12v14H4zM7 7h6M7 10h6M7 13h3" /></svg>
      {!collapsed && <span>{templateLabel}</span>}
    </button>
    <button type="button" className={collapsed ? 'nav-icon-btn' : undefined} disabled={disabled}
      title={isZh ? '快速记录 (Ctrl+Shift+N)' : 'Quick capture (Ctrl/Cmd+Shift+N)'} aria-label={captureLabel} onClick={openQuickCapture}>
      <svg aria-hidden="true" className="sidebar-icon-svg" viewBox="0 0 20 20"><path d="m11 3-7 8h6l-1 6 7-8h-6z" /></svg>
      {!collapsed && <span>{captureLabel}</span>}
    </button>
  </>
  return collapsed ? buttons : <div className="sidebar-capture-actions">{buttons}</div>
}
