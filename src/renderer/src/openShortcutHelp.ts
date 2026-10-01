import { notify } from './notify'
import { getActiveUiText } from './i18n'
import { hasVisibleShortcutBlocker } from './utils/shortcutBlocker'

let pending = false

export async function openShortcutHelp(): Promise<void> {
  if (pending || hasVisibleShortcutBlocker()) return
  pending = true
  const previous = document.activeElement as HTMLElement | null
  try {
    const { showShortcutHelp } = await import('./components/ShortcutHelpDialog')
    if (!hasVisibleShortcutBlocker()) await showShortcutHelp(previous?.isConnected ? previous : document.activeElement as HTMLElement | null)
  } catch (error) {
    notify(getActiveUiText().language === 'zh-CN' ? '快捷键帮助未能打开，请重试。' : 'Keyboard shortcuts could not be opened. Please retry.', 'error')
    console.error('Failed to open keyboard shortcuts.', error)
  } finally { pending = false }
}
