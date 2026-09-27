import { openShortcutHelp } from '../openShortcutHelp'
import './shortcut-help-button.css'

export default function ShortcutHelpButton({ isZh }: { isZh: boolean }) {
  const label = isZh ? '快捷键帮助' : 'Keyboard shortcuts'
  return <button type="button" className="shortcut-help-button" title={`${label} (F1)`} aria-label={label} aria-keyshortcuts="F1"
    onClick={() => { void openShortcutHelp() }}>
    <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 9h1m3 0h1m3 0h2M7 12h1m3 0h1m3 0h2M8 15h8" /></svg>
    <span>{label}</span><kbd>F1</kbd>
  </button>
}
