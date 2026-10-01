export type ShortcutText = readonly [zh: string, en: string]
export const shortcutGroups = [
  { id: 'global', title: ['全局与导航', 'Global and navigation'], scope: ['主界面；确认弹窗内暂停', 'Main interface; paused in confirmation dialogs'] },
  { id: 'search', title: ['搜索与命令', 'Search and commands'], scope: ['全局搜索输入框内', 'In the global search input'] },
  { id: 'document', title: ['文档', 'Documents'], scope: ['文档页面', 'On the Documents page'] },
  { id: 'tree', title: ['文档树', 'Document tree'], scope: ['焦点位于侧栏文档树；方向键移动焦点，不切换正文', 'With focus in the sidebar document tree; arrow keys move focus without opening a document'] },
  { id: 'block', title: ['块编辑', 'Block editing'], scope: ['焦点位于正文块编辑框内', 'When a block editor has focus'] },
  { id: 'format', title: ['文字格式', 'Text formatting'], scope: ['可格式化正文、表格单元格或 Markdown 源码中', 'In formattable text, table cells, or Markdown source'] },
  { id: 'source', title: ['Markdown 源码', 'Markdown source'], scope: ['Markdown 源码弹窗内', 'In the Markdown source dialog'] },
  { id: 'database', title: ['数据库', 'Database'], scope: ['数据库工作台内', 'In the database workspace'] },
  { id: 'assistant', title: ['AI 问答与对话', 'AI questions and conversations'], scope: ['文档问题和应用扩展对话使用不同的发送按键，见各项说明', 'Document questions and extension conversations use different send keys, as described below'] }
] as const
export type ShortcutGroup = typeof shortcutGroups[number]['id']
export type Shortcut = { id: string; group: ShortcutGroup; title: ShortcutText; keys: string[][]; note?: ShortcutText }

const pageShortcuts = [
  ['documents', '文档', 'Documents'], ['dashboard', '总览', 'Dashboard'], ['database', '数据库', 'Database'],
  ['ai', 'AI 助手', 'AI Assistant'], ['plugins', '插件中心', 'Plugins'], ['settings', '配置中心', 'Settings']
] as const

// List only bindings implemented by the application; Mod is Ctrl on Windows/Linux and Cmd on macOS.
export const shortcuts: Shortcut[] = [
  { id: 'help', group: 'global', title: ['打开或关闭快捷键帮助', 'Open or close keyboard shortcuts'], keys: [['F1']] },
  { id: 'search', group: 'global', title: ['打开或关闭全局搜索', 'Toggle global search'], keys: [['Mod', 'K']] },
  { id: 'workspace-search', group: 'global', title: ['打开完整搜索', 'Open full search'], keys: [['Mod', 'Shift', 'F']] },
  { id: 'commands', group: 'global', title: ['打开命令面板', 'Open command palette'], keys: [['Mod', 'Shift', 'P']] },
  { id: 'quick-capture', group: 'global', title: ['打开快速记录', 'Open quick capture'], keys: [['Mod', 'Shift', 'N']] },
  { id: 'quick-capture-save', group: 'global', title: ['保存快速记录', 'Save quick capture'], keys: [['Mod', 'Enter']], note: ['快速记录弹窗内；输入法组合输入时暂停。', 'In the quick capture dialog; paused during IME composition.'] },
  ...pageShortcuts.map(([page, zh, en], index) => ({
    id: `page-${page}`, group: 'global' as const, keys: [['Mod', String(index + 1)]],
    title: [zh, en] as ShortcutText
  })),
  { id: 'search-select', group: 'search', title: ['选择上一个或下一个结果', 'Select the previous or next result'], keys: [['↑'], ['↓']] },
  { id: 'search-open', group: 'search', title: ['打开结果或执行命令', 'Open a result or run a command'], keys: [['Enter']], note: ['内容匹配会定位到对应块。', 'Content matches jump to the matching block.'] },
  { id: 'search-document', group: 'search', title: ['打开结果所在文档', 'Open the result’s document'], keys: [['Mod', 'Enter']], note: ['适用于文档和内容块结果。', 'For document and block results.'] },
  { id: 'search-close', group: 'search', title: ['关闭搜索', 'Close search'], keys: [['Esc']] },
  { id: 'document-find', group: 'document', title: ['打开或关闭文档内搜索', 'Toggle search within the document'], keys: [['Mod', 'F']] },
  { id: 'document-save', group: 'document', title: ['保存当前文档', 'Save current document'], keys: [['Mod', 'S']], note: ['标题、摘要、正文和阅读模式共用保存操作；输入法组合输入时暂停。', 'Shared by title, summary, body, and reading mode; paused during IME composition.'] },
  { id: 'document-back', group: 'document', title: ['后退到上一篇文档', 'Go back to the previous document'], keys: [['Alt', '←']] },
  { id: 'document-forward', group: 'document', title: ['前进到下一篇文档', 'Go forward to the next document'], keys: [['Alt', '→']] },
  { id: 'document-undo', group: 'document', title: ['撤销编辑', 'Undo edits'], keys: [['Mod', 'Z']], note: ['文档处于编辑模式时。', 'While editing a document.'] },
  { id: 'document-redo', group: 'document', title: ['重做编辑', 'Redo edits'], keys: [['Mod', 'Shift', 'Z'], ['Mod', 'Y']], note: ['文档处于编辑模式时。', 'While editing a document.'] },
  { id: 'tree-select', group: 'tree', title: ['聚焦上一个或下一个文档', 'Focus the previous or next document'], keys: [['↑'], ['↓']], note: ['只移动焦点；按 Enter 或空格打开文档。', 'Move focus only; press Enter or Space to open the document.'] },
  { id: 'tree-boundary', group: 'tree', title: ['聚焦第一个或最后一个可见文档', 'Focus the first or last visible document'], keys: [['Home'], ['End']] },
  { id: 'tree-expand', group: 'tree', title: ['展开目录或进入首个子文档', 'Expand a folder or focus its first child'], keys: [['→']] },
  { id: 'tree-collapse', group: 'tree', title: ['收起目录或返回父文档', 'Collapse a folder or focus its parent'], keys: [['←']] },
  { id: 'tree-open', group: 'tree', title: ['打开聚焦文档', 'Open the focused document'], keys: [['Enter'], ['Space']], note: ['Enter 或空格打开，方向键保留当前正文。', 'Enter or Space opens the document; arrow keys keep the current document open.'] },
  { id: 'tree-context-menu', group: 'tree', title: ['打开文档操作菜单', 'Open document actions'], keys: [['Shift', 'F10']], note: ['键盘菜单键也可打开；关闭菜单后返回同一文档。', 'The keyboard Menu key also opens actions; closing the menu returns focus to the same document.'] },
  { id: 'block-select-all', group: 'block', title: ['选择所有块', 'Select all blocks'], keys: [['Mod', 'A']], note: ['当前块为空或文字已全选时；首次按下通常选择文字。', 'When the block is empty or its text is already selected; the first press usually selects text.'] },
  { id: 'block-select-range', group: 'block', title: ['扩展块选区', 'Extend block selection'], keys: [['Shift', '↑'], ['Shift', '↓']], note: ['光标位于块的首尾，或已选择多个块时。', 'At a block boundary, or with multiple blocks selected.'] },
  { id: 'block-clear', group: 'block', title: ['清除块选区', 'Clear block selection'], keys: [['Esc']] },
  { id: 'block-move', group: 'block', title: ['上移或下移块', 'Move blocks up or down'], keys: [['Alt', '↑'], ['Alt', '↓']] },
  { id: 'block-indent', group: 'block', title: ['增加或减少列表层级', 'Indent or outdent a list'], keys: [['Tab'], ['Shift', 'Tab']], note: ['列表、待办或多个选中块；普通文本中的 Tab 插入空格。', 'Lists, tasks, or selected blocks; Tab inserts spaces in ordinary text.'] },
  { id: 'block-duplicate', group: 'block', title: ['复制块', 'Duplicate blocks'], keys: [['Mod', 'Shift', 'D']], note: ['复制当前块或选中的多个块。', 'Duplicate the current block or the selected blocks.'] },
  { id: 'block-split', group: 'block', title: ['在光标位置拆分块', 'Split the block at the cursor'], keys: [['Alt', 'Enter']] },
  { id: 'block-insert', group: 'block', title: ['在下方插入块', 'Insert a block below'], keys: [['Mod', 'Enter']] },
  { id: 'block-continue', group: 'block', title: ['继续列表、待办或标题后的内容', 'Continue a list, task, or heading'], keys: [['Enter']], note: ['在列表、待办和标题中生效。Shift+Enter 插入换行。', 'In lists, tasks, and headings. Shift+Enter inserts a line break.'] },
  { id: 'block-remove', group: 'block', title: ['删除选中的多个块', 'Delete multiple selected blocks'], keys: [['Delete'], ['Backspace']], note: ['有多个选中块且没有文字选区时。', 'With multiple blocks selected and no text selection.'] },
  { id: 'format-bold', group: 'format', title: ['加粗', 'Bold'], keys: [['Mod', 'B']] },
  { id: 'format-italic', group: 'format', title: ['斜体', 'Italic'], keys: [['Mod', 'I']] },
  { id: 'format-code', group: 'format', title: ['行内代码', 'Inline code'], keys: [['Mod', 'E']] },
  { id: 'format-strike', group: 'format', title: ['删除线', 'Strikethrough'], keys: [['Mod', 'Shift', 'X']] },
  { id: 'format-highlight', group: 'format', title: ['高亮', 'Highlight'], keys: [['Mod', 'Shift', 'H']] },
  { id: 'format-link', group: 'format', title: ['插入链接', 'Insert a link'], keys: [['Mod', 'Shift', 'K']] },
  { id: 'format-toolbar', group: 'format', title: ['聚焦格式工具栏', 'Focus the formatting toolbar'], keys: [['Alt', 'F10']], note: ['工具栏内用左右方向键移动，Esc 返回编辑框。', 'Use Left/Right arrows within the toolbar; Esc returns to the editor.'] },
  { id: 'source-apply', group: 'source', title: ['应用源码更改', 'Apply source changes'], keys: [['Mod', 'S']], note: ['将源码应用到当前文档草稿并关闭弹窗。', 'Apply source to the current document draft and close the dialog.'] },
  { id: 'source-undo', group: 'source', title: ['撤销源码更改', 'Undo source changes'], keys: [['Mod', 'Z']] },
  { id: 'source-redo', group: 'source', title: ['重做源码更改', 'Redo source changes'], keys: [['Mod', 'Shift', 'Z'], ['Mod', 'Y']] },
  { id: 'database-search', group: 'database', title: ['聚焦记录搜索', 'Focus record search'], keys: [['/']], note: ['没有在输入框内输入时。', 'When not typing in a field.'] },
  { id: 'database-select', group: 'database', title: ['聚焦数据库选择器', 'Focus the database selector'], keys: [['Mod', 'Shift', 'L']] },
  { id: 'database-view', group: 'database', title: ['聚焦新建视图', 'Focus new view'], keys: [['Mod', 'Shift', 'V']] },
  { id: 'database-delete', group: 'database', title: ['删除选中记录', 'Delete selected records'], keys: [['Delete']], note: ['自定义数据库中，未在输入框内输入时；会先要求确认。', 'In a custom database, outside text fields; asks for confirmation first.'] },
  { id: 'assistant-document-send', group: 'assistant', title: ['发送文档问题', 'Send a document question'], keys: [['Mod', 'Enter']], note: ['文档智能助手和文档辅助区；Enter 换行，输入法组合输入时暂停发送。', 'Document AI assistant and document auxiliary panel; Enter inserts a line break, and sending pauses during IME composition.'] },
  { id: 'assistant-send', group: 'assistant', title: ['发送扩展对话消息', 'Send an extension message'], keys: [['Enter']], note: ['应用扩展助手和插件定制对话；输入法组合输入时暂停。', 'App extension assistant and plugin customization conversations; paused during IME composition.'] },
  { id: 'assistant-newline', group: 'assistant', title: ['扩展对话消息内换行', 'Insert an extension message line break'], keys: [['Shift', 'Enter']], note: ['应用扩展助手和插件定制对话。', 'App extension assistant and plugin customization conversations.'] }
]

export function shortcutKeyLabel(key: string, mac: boolean): string {
  return key === 'Mod' ? (mac ? '⌘' : 'Ctrl') : key === 'Alt' && mac ? '⌥' : key
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/⌘/g, ' mod ').replace(/⌥/g, ' alt ').replace(/⇧/g, ' shift ').replace(/⌃/g, ' mod ')
    .replace(/\b(command|cmd|control|ctrl)\b/g, 'mod').replace(/\boption\b/g, 'alt').replace(/\bescape\b/g, 'esc')
    .replace(/\b(up|arrowup)\b/g, '↑').replace(/\b(down|arrowdown)\b/g, '↓')
    .replace(/\b(left|arrowleft)\b/g, '←').replace(/\b(right|arrowright)\b/g, '→')
    .replace(/\+/g, ' ').trim().replace(/\s+/g, ' ')
}

export function filterShortcuts(query: string, group: ShortcutGroup | '' = ''): Shortcut[] {
  const normalized = normalize(query)
  const keysOnly = /[+⌘⌥⇧⌃]/.test(query) || /^(mod|alt|shift)\s+\S/.test(normalized)
  return shortcuts.filter((shortcut) => {
    if (group && shortcut.group !== group) return false
    if (/^f\d+$/.test(normalized)) return shortcut.keys.some((keys) => keys.some((key) => normalize(key) === normalized))
    if (keysOnly) return shortcut.keys.some((keys) => normalize(keys.join('+')) === normalized)
    const section = shortcutGroups.find((item) => item.id === shortcut.group)!
    const haystack = normalize([...shortcut.title, ...(shortcut.note ?? []), ...section.title,
      ...shortcut.keys.map((keys) => keys.join('+'))].join(' '))
    return normalized.split(' ').every((term) => haystack.includes(term))
  })
}
