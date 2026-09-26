import type { DocumentsDomainState } from '../types/appDomains'
import type { AppShellState } from '../types/appShell'
import type { WorkspaceOperationsState } from '../types/appComposition'

export type PaletteCommand = {
  id: string
  title: string
  description: string
  keywords: string
  shortcut?: string
  disabledReason?: string
  run: () => void | Promise<void>
}

export function matchPaletteCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const terms = query.trim().replace(/^>/, '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return commands.filter((command) => terms.every((term) =>
    `${command.title} ${command.description} ${command.keywords}`.toLocaleLowerCase().includes(term)))
}

export function createPaletteCommands(documents: DocumentsDomainState, shell: AppShellState, workspace: WorkspaceOperationsState): PaletteCommand[] {
  const zh = shell.isZh
  const unavailable = shell.workspaceReady ? undefined : (zh ? '请先加载工作区' : 'Load the workspace first')
  const noDocument = unavailable || (documents.selectedDocument?.id === documents.selectedDocumentId && !documents.detailLoading && !documents.documentLoadError
    ? undefined : (zh ? '请先打开一个文档' : 'Open a document first'))
  const currentTitle = documents.draftTitle || documents.selectedDocument?.title || ''
  const pageKeywords = { documents: '文档', dashboard: '总览 仪表盘', database: '数据库', ai: 'assistant chat 助手 问答', plugins: '插件 中心', settings: 'preferences 配置 设置' }
  return [
    { id: 'new-document', title: zh ? '新建文档' : 'New document', description: zh ? '在根目录创建文档' : 'Create a document at the workspace root', keywords: 'new create document 新建 创建 文档', disabledReason: unavailable,
      run: async () => { await workspace.handleCreateDocument(null); shell.setActivePage('documents') } },
    ...shell.pageItems.map((page, index) => ({ id: `page-${page.id}`, title: page.label, description: page.description,
      keywords: `go open page ${page.id} ${pageKeywords[page.id]} 跳转 页面 打开`, shortcut: `Ctrl/Cmd+${index + 1}`,
      run: () => shell.setActivePage(page.id) })),
    { id: 'save-document', title: zh ? '保存当前文档' : 'Save current document', description: currentTitle, keywords: 'save current document 保存 当前 文档',
      disabledReason: noDocument || (documents.isSaving ? (zh ? '正在保存' : 'Saving') : undefined), run: documents.saveDocument },
    { id: 'copy-markdown', title: zh ? '复制文档 Markdown' : 'Copy document Markdown', description: currentTitle, keywords: 'copy document clipboard markdown 复制 文档 剪贴板', disabledReason: noDocument, run: documents.copyDocumentAsMarkdown },
    { id: 'export-markdown', title: zh ? '导出文档 Markdown' : 'Export document Markdown', description: currentTitle, keywords: 'export document markdown file 导出 文档 文件', disabledReason: noDocument, run: documents.saveDocumentAsMarkdown },
    { id: 'backup', title: zh ? '立即备份工作区' : 'Back up workspace now', description: zh ? '导出所有文档，进度显示在通知中' : 'Export all documents; follow progress in notifications', keywords: 'backup back up workspace now export 备份 导出 工作区', disabledReason: unavailable, run: workspace.handleBackup },
    { id: 'import-backup', title: zh ? '导入 Markdown 备份' : 'Import Markdown backup', description: zh ? '选择备份文件夹，导入后查看报告' : 'Choose a backup folder and review the import report', keywords: 'import restore markdown backup 导入 恢复 备份', disabledReason: unavailable, run: workspace.handleRestoreBackup },
    { id: 'toggle-sidebar', title: shell.isNavCollapsed ? (zh ? '展开侧栏' : 'Expand sidebar') : (zh ? '收起侧栏' : 'Collapse sidebar'),
      description: zh ? '调整工作区布局' : 'Adjust the workspace layout', keywords: 'sidebar navigation collapse expand 侧栏 导航 展开 收起', run: shell.toggleNavCollapse },
    ...(shell.workspaceError ? [{ id: 'retry-workspace', title: zh ? '重新加载工作区数据' : 'Retry workspace loading', description: zh ? '保留编辑草稿并重新读取工作区' : 'Keep editor drafts and reload workspace data', keywords: 'retry reload refresh 重试 刷新 恢复', run: shell.retryWorkspace }] : [])
  ]
}
