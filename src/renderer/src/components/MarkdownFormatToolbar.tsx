import type { MarkdownFormat } from '../utils/markdownFormatting'
import '../styles/markdown-editing.css'

export function MarkdownFormatToolbar({ onFormat, onReturnToEditor, isZh }: {
  onFormat: (format: MarkdownFormat) => void
  onReturnToEditor: () => void
  isZh: boolean
}) {
  const formats: Array<[MarkdownFormat, string, string, string, string]> = [
    ['bold', 'B', '粗体', 'Bold', 'B'], ['italic', 'I', '斜体', 'Italic', 'I'],
    ['strike', 'S̶', '删除线', 'Strikethrough', 'Shift+X'], ['highlight', 'H', '文本高亮', 'Highlight text', 'Shift+H'],
    ['code', '<>', '行内代码', 'Inline code', 'E'], ['link', '↗', '插入链接', 'Insert link', 'Shift+K']
  ]
  return <div className="markdown-format-toolbar" role="toolbar" aria-label={isZh ? '文本格式' : 'Text formatting'} aria-keyshortcuts="Alt+F10"
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onReturnToEditor(); return }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const buttons = [...event.currentTarget.querySelectorAll('button')]
      const index = buttons.indexOf(event.target as HTMLButtonElement)
      if (index < 0) return
      event.preventDefault()
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length]?.focus()
    }}>
    {formats.map(([format, icon, zh, en, shortcut]) => <button key={format} type="button"
      aria-label={isZh ? zh : en} title={`${isZh ? zh : en} · Ctrl/⌘+${shortcut}`}
      aria-keyshortcuts={`Control+${shortcut} Meta+${shortcut}`} onMouseDown={(event) => event.preventDefault()}
      onClick={() => onFormat(format)}>{icon}</button>)}
  </div>
}
