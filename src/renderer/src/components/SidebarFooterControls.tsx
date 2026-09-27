import ShortcutHelpButton from './ShortcutHelpButton'

export default function SidebarFooterControls({ isZh, disabled }: { isZh: boolean; disabled: boolean }) {
  const label = isZh ? '回收站' : 'Trash'
  return <>
    <button type="button" className="shortcut-help-button sidebar-trash-button" aria-label={label} title={label}
      disabled={disabled} onClick={() => window.dispatchEvent(new Event('knowbook:open-trash'))}>
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" /></svg>
      <span>{label}</span>
    </button>
    <ShortcutHelpButton isZh={isZh} />
  </>
}
