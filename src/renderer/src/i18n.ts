import type { DocumentDatabaseColumnType } from '@shared/contracts'

export type UiLanguage = 'zh-CN' | 'en-US'

export const UI_LANGUAGE_SETTING_KEY = 'ui.language'

const SUPPORTED_LANGUAGES: UiLanguage[] = ['zh-CN', 'en-US']

export function isUiLanguage(value: string | null | undefined): value is UiLanguage {
  return Boolean(value && SUPPORTED_LANGUAGES.includes(value as UiLanguage))
}

export function detectPreferredUiLanguage(): UiLanguage {
  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')) {
    return 'zh-CN'
  }

  return 'en-US'
}

let activeUiLanguage: UiLanguage = detectPreferredUiLanguage()
const cache = new Map<UiLanguage, UiText>()

export function setActiveUiLanguage(language: UiLanguage): void {
  activeUiLanguage = language
}

export function getActiveUiText(): UiText {
  return getUiText(activeUiLanguage)
}

export function getUiText(language: UiLanguage): UiText {
  const cached = cache.get(language)
  if (cached) {
    return cached
  }

  const created = createUiText(language)
  cache.set(language, created)
  return created
}

function createUiText(language: UiLanguage) {
  const zh = language === 'zh-CN'
  const locale = language

  const common = {
    save: zh ? '保存' : 'Save',
    saving: zh ? '保存中...' : 'Saving...',
    cancel: zh ? '取消' : 'Cancel',
    delete: zh ? '删除' : 'Delete',
    edit: zh ? '编辑' : 'Edit',
    move: zh ? '移动' : 'Move',
    loading: zh ? '加载中...' : 'Loading...',
    ready: zh ? '就绪' : 'Ready',
    enabled: zh ? '已启用' : 'Enabled',
    disabled: zh ? '已禁用' : 'Disabled',
    working: zh ? '处理中...' : 'Working...',
    reload: zh ? '重载' : 'Reload',
    reloading: zh ? '重载中...' : 'Reloading...',
    search: zh ? '搜索' : 'Search',
    title: zh ? '标题' : 'Title',
    path: zh ? '路径' : 'Path',
    summary: zh ? '摘要' : 'Summary',
    children: zh ? '子文档' : 'Children',
    updated: zh ? '更新时间' : 'Updated',
    columns: zh ? '列' : 'columns',
    rows: zh ? '行' : 'rows',
    root: zh ? '根目录' : 'Root',
    select: zh ? '选择...' : 'Select...',
    value: zh ? '值' : 'Value',
    none: zh ? '无' : 'None',
    noPreviewAvailable: zh ? '暂无预览。' : 'No preview available.',
    blocks: zh ? '块' : 'blocks',
    links: zh ? '链接' : 'links'
  }

  const databaseColumnTypes: Record<DocumentDatabaseColumnType, string> = {
    text: zh ? '文本' : 'Text',
    select: zh ? '单选' : 'Select',
    'multi-select': zh ? '多选' : 'Multi-select',
    date: zh ? '日期' : 'Date',
    checkbox: zh ? '复选框' : 'Checkbox'
  }

  const blockTypeBadges: Record<string, string> = {
    paragraph: zh ? '文本' : 'Text',
    'heading-1': zh ? '标题1' : 'H1',
    'heading-2': zh ? '标题2' : 'H2',
    todo: zh ? '待办' : 'Todo',
    code: zh ? '代码' : 'Code',
    math: zh ? '公式' : 'Math',
    quote: zh ? '引用' : 'Quote',
    'bulleted-list': zh ? '无序' : 'Bullet',
    'numbered-list': zh ? '有序' : 'Number',
    divider: zh ? '分隔线' : 'Divider'
  }

  const blockTypeOptions: Record<string, string> = {
    paragraph: zh ? '文本段落' : 'Paragraph',
    'heading-1': zh ? '一级标题' : 'Heading 1',
    'heading-2': zh ? '二级标题' : 'Heading 2',
    todo: zh ? '待办事项' : 'Todo',
    code: zh ? '代码块' : 'Code',
    math: zh ? '数学公式' : 'Math Formula',
    quote: zh ? '引用块' : 'Quote',
    'bulleted-list': zh ? '无序列表' : 'Bulleted List',
    'numbered-list': zh ? '有序列表' : 'Numbered List',
    divider: zh ? '分隔线' : 'Divider'
  }

  const conversionOptions: Record<string, string> = {
    paragraph: zh ? '转为文本' : 'As Text',
    todo: zh ? '转为待办' : 'As Todo',
    quote: zh ? '转为引用' : 'As Quote',
    'bulleted-list': zh ? '转为无序列表' : 'As Bullet',
    'numbered-list': zh ? '转为有序列表' : 'As Numbered'
  }

  return {
    language,
    locale,
    common,
    databaseColumnTypes,
    blockTypeBadges,
    blockTypeOptions,
    conversionOptions,
    languageSwitchLabel: zh ? '界面语言' : 'Interface language',
    languageOptionZh: '中文',
    languageOptionEn: 'English',
    brandEyebrow: zh ? '本地优先知识操作系统' : 'Local-first knowledge OS',
    implementationSliceLabel: zh ? '当前实现切片' : 'Implementation Slice',
    implementationSliceTitle: zh ? 'Phase 6 插件宿主' : 'Phase 6 plugin host',
    implementationSliceBody: zh
      ? '桌面端已经接入受限沙箱插件宿主，插件无需改动 renderer 主代码，就能贡献侧栏卡片、文档动作和生命周期监听。'
      : 'The desktop shell now hosts sandboxed workspace plugins that can contribute sidebar cards, document actions, and lifecycle listeners without changing renderer code.',
    nextUpLabel: zh ? '下一步' : 'Next up',
    nextUpItems: zh
      ? ['补齐插件安装/卸载打包流', '扩展卡片与文档动作之外的 UI 插槽', '提供第三方插件作者可用的类型化 SDK']
      : ['Packaged plugin install / uninstall flow', 'More UI slots beyond cards and document actions', 'Typed external SDK for third-party plugin authors'],
    aiSettingsLabel: zh ? 'AI 设置' : 'AI settings',
    aiSettingsTitle: zh ? '云端 API 配置' : 'Cloud API configuration',
    enableAiFeatures: zh ? '启用 AI 功能' : 'Enable AI features',
    autoSummaryWhenEmpty: zh ? '摘要为空时自动生成摘要' : 'Auto-generate summary when summary is empty',
    autoTagOnSave: zh ? '保存时自动补齐缺失的块标签' : 'Auto-generate missing block tags on save',
    autoHighlightOnSave: zh ? '保存时自动高亮重要块' : 'Auto-highlight important blocks on save',
    baseUrl: zh ? '基础地址' : 'Base URL',
    model: zh ? '模型' : 'Model',
    embeddingModel: zh ? '向量模型' : 'Embedding model',
    apiKeyLabel: zh ? 'API Key（留空表示保持当前值）' : 'API Key (leave blank to keep current)',
    currentKey: (configured: boolean) => zh
      ? `当前密钥：${configured ? '已配置' : '未配置'}`
      : `Current key: ${configured ? 'configured' : 'missing'}`,
    aiHintOverview: zh
      ? 'Chat 模型负责问答，Embedding 模型负责本地语义检索与 RAG 上下文缓存。'
      : 'Chat model answers questions. Embedding model powers local semantic retrieval and RAG context caching.',
    aiHintSummary: zh
      ? '自动摘要只会在文档保存时触发，并且仅在当前摘要为空或仍为默认占位内容时运行。'
      : 'Auto-summary runs only on document save when the current summary is empty or still using the default placeholder.',
    aiHintTags: zh
      ? '自动标签只会补齐当前还没有标签的块，手动标签不会被覆盖。'
      : 'Auto-tags only fill blocks that still have no tags, so manual tags stay untouched.',
    aiHintHighlights: zh
      ? '自动高亮只会补齐当前还没有背景色的块，手动高亮不会被覆盖。'
      : 'Auto-highlights only fill blocks that still have no background color, so manual highlight choices stay untouched.',
    saveAiSettings: zh ? '保存 AI 设置' : 'Save AI settings',
    automationFeedLabel: zh ? '自动化事件流' : 'Automation feed',
    recentEventsTitle: zh ? '最近事件' : 'Recent events',
    noAutomationEvents: zh ? '还没有自动化事件。' : 'No automation events yet.',
    pluginsLabel: zh ? '插件' : 'Plugins',
    pluginsTitle: zh ? '工作区扩展' : 'Workspace extensions',
    installFolder: zh ? '安装文件夹' : 'Install Folder',
    pluginRootsHint: zh
      ? '使用“重载”可在不重启的情况下重新扫描插件根目录；“安装文件夹”会把本地插件复制到用户数据可写目录，并可替换同 id 的用户级插件。'
      : 'Use Reload to rescan plugin roots without restarting. Install Folder copies a local plugin into the writable user-data root and can replace an existing user-data plugin with the same id.',
    pluginRecoverHint: zh
      ? '每个插件条目也支持单独重载；若插件处于错误状态，会显示 Recover。'
      : 'Each plugin row also supports Reload, and error-state plugins expose the same action as Recover.',
    writableInstallRoot: (root: string) => zh ? `可写安装目录：${root}` : `Writable install root: ${root}`,
    noPluginsDiscovered: zh ? '暂未发现任何插件。' : 'No plugins discovered yet.',
    pluginStatusLabel: (status: 'running' | 'error' | 'disabled') => {
      if (status === 'running') return zh ? '运行中' : 'Running'
      if (status === 'error') return zh ? '错误' : 'Error'
      return zh ? '已禁用' : 'Disabled'
    },
    pluginSourceLabel: (source: 'workspace' | 'user-data') => source === 'workspace'
      ? (zh ? '工作区' : 'workspace')
      : (zh ? '用户数据' : 'user-data'),
    pluginToggleLabel: (busy: boolean, enabled: boolean) => {
      if (busy) return zh ? '更新中...' : 'Updating...'
      return enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '已禁用' : 'Disabled')
    },
    recover: zh ? '恢复' : 'Recover',
    workspaceStatusEyebrow: zh ? '工作区状态' : 'Workspace status',
    workspaceStatusTitle: zh ? '工作区导航已打通' : 'Workspace navigation is alive',
    workspaceStatusBody: zh
      ? 'SQLite 仍是单一事实源，Markdown 备份会导出为树形目录，renderer 现在已经可以经由 preload bridge 浏览文档层级并检查文档关系。'
      : 'SQLite remains the source of truth, markdown backups export into a nested tree, and the renderer can now browse document hierarchy and inspect document relationships over the preload bridge.',
    runBackupNow: zh ? '立即执行备份' : 'Run backup now',
    documentsLabel: zh ? '文档数' : 'Documents',
    blocksLabel: zh ? '块数' : 'Blocks',
    linksLabel: zh ? '链接数' : 'Links',
    aiLabel: 'AI',
    aiReadyState: (enabled: boolean) => enabled ? (zh ? 'API 已就绪' : 'API ready') : (zh ? '已禁用' : 'Disabled'),
    pluginCardLabel: zh ? '插件卡片' : 'Plugin card',
    knowledgeGraphLabel: zh ? '知识图谱' : 'Knowledge graph',
    knowledgeGraphTitle: zh ? '工作区拓扑' : 'Workspace topology',
    databaseViewLabel: zh ? '数据库视图' : 'Database view',
    documentCatalogTitle: zh ? '文档目录' : 'Document catalog',
    addColumn: zh ? '新增列' : 'Add column',
    closeSchema: zh ? '关闭结构编辑' : 'Close schema',
    searchDocumentsPlaceholder: zh ? '搜索文档...' : 'Search documents...',
    customColumnsCount: (count: number) => zh ? `${count} 个自定义列` : `${count} custom columns`,
    rowsCount: (count: number) => zh ? `${count} 行` : `${count} rows`,
    columnName: zh ? '列名' : 'Column name',
    fieldType: zh ? '字段类型' : 'Field type',
    options: zh ? '选项' : 'Options',
    optionsCommaHint: zh ? '使用逗号分隔多个选项' : 'Separate options with commas',
    saveColumn: zh ? '保存列' : 'Save column',
    noCustomColumnsYet: zh
      ? '还没有自定义数据库列。先新增一列，再为每篇文档录入结构化元数据。'
      : 'No custom database columns yet. Add a column to start capturing structured metadata on each document.',
    boardViewLabel: zh ? '看板视图' : 'Board view',
    boardGroupedBy: (name: string | null) => name
      ? (zh ? `按 ${name} 分组` : `Grouped by ${name}`)
      : (zh ? '按父级桶分组' : 'Grouped by parent bucket'),
    parentBucket: zh ? '父级桶' : 'Parent bucket',
    boardColumnsCount: (count: number) => zh ? `${count} 列` : `${count} columns`,
    boardHintForColumn: (columnName: string, isMultiSelect: boolean) => {
      if (isMultiSelect) {
        return zh
          ? `把卡片拖入某一列会把该选项追加到“${columnName}”字段；拖到空列会清空全部值。`
          : `Dragging cards into a column will add that option to "${columnName}". Drop into the empty column to clear all values.`
      }

      return zh
        ? `在列之间拖拽卡片会更新“${columnName}”字段。`
        : `Dragging cards between columns will update the "${columnName}" field.`
    },
    boardHintForParent: zh ? '在列之间拖拽卡片会重新挂载文档父级。' : 'Dragging cards between columns will reparent documents.',
    workspaceTreeLabel: zh ? '工作区树' : 'Workspace tree',
    seededDocumentsTitle: zh ? '初始文档树' : 'Seeded documents',
    back: zh ? '后退' : 'Back',
    forward: zh ? '前进' : 'Forward',
    globalSearch: zh ? '全局搜索' : 'Global search',
    rootsCount: (count: number) => zh ? `${count} 个根文档` : `${count} roots`,
    newRoot: zh ? '新建根文档' : 'New root',
    dropToRoot: zh ? '拖到这里可把文档移到根目录' : 'Drop here to move document to root',
    pinnedSectionLabel: zh ? '★ 收藏' : '★ Pinned',
    documentPreviewLabel: zh ? '文档预览' : 'Document preview',
    selectDocument: zh ? '选择一个文档' : 'Select a document',
    unpinDocument: zh ? '取消收藏' : 'Unpin document',
    pinDocument: zh ? '收藏文档' : 'Pin document',
    autoSaved: zh ? '已自动保存' : 'Auto-saved',
    markdownCopied: zh ? '已复制 Markdown' : 'Markdown copied',
    copyMarkdown: zh ? '复制 Markdown' : 'Copy MD',
    saveMarkdown: zh ? '导出 Markdown' : 'Save MD',
    addChild: zh ? '新增子文档' : 'Add child',
    moveToPlaceholder: zh ? '移动到...' : 'Move to...',
    rootOption: zh ? '（根目录）' : '(Root)',
    readOnly: zh ? '只读' : 'Read only',
    editing: zh ? '编辑中' : 'Editing',
    updatedAt: (value: string) => zh ? `更新于 ${new Date(value).toLocaleString(locale)}` : `Updated ${new Date(value).toLocaleString(locale)}`,
    outlineLabel: zh ? '大纲' : 'Outline',
    blocksPanelLabel: zh ? '内容块' : 'Blocks',
    searchBlocksPlaceholder: zh ? '搜索块内容（按 Cmd/Ctrl+F 关闭）...' : 'Search blocks (Cmd+F to close)...',
    noBlocksMatchSearch: zh ? '没有匹配的块。' : 'No blocks match your search.',
    filterByTags: zh ? '按标签过滤' : 'Filter by tags',
    removeTag: zh ? '移除标签' : 'Remove tag',
    noHighlight: zh ? '无背景色' : 'No highlight',
    removeBlock: zh ? '删除块' : 'Remove',
    addBlock: zh ? '新增块' : 'Add block',
    slashCommandsLabel: zh ? 'Slash 命令' : 'Slash Commands',
    slashQuery: (query: string) => zh ? `当前查询：${query || '（全部命令）'}` : `Current query: ${query || '(all commands)'}`,
    noMatchingCommands: zh ? '没有匹配的命令。' : 'No matching commands.',
    slashCommandHint: zh ? '使用上下方向键导航，按 Tab 或 Enter 确认，按 Escape 关闭。' : 'Use Up/Down to navigate, Tab or Enter to confirm, and Escape to dismiss.',
    linkSuggestionsLabel: zh ? '链接建议' : 'Link Suggestions',
    linkQuery: (query: string) => zh ? `当前查询：${query || '（全部建议）'}` : `Current query: ${query || '(all suggestions)'}`,
    blocksInDocument: zh ? '当前文档中的块' : 'Blocks in this document',
    linkedDocuments: zh ? '可链接文档' : 'Linked documents',
    noMatchingSuggestions: zh ? '没有匹配的建议。' : 'No matching suggestions.',
    editorHelpText: zh
      ? '输入 / 可打开块命令；支持 # / ## / > / - / 1. / - [ ] / - [x] / $$ / --- / ``` 等 Markdown 快捷写法；粘贴多行文本会自动拆成多个块，也可以直接覆盖当前选区；先 Select 再 Shift + Select 可以选中连续块范围；可用工具栏把整段选区转换为同一块类型、复制块或纯文本、剪切/删除/复制整段；也支持 Ctrl/Cmd + C/X/Shift + D、Delete/Backspace、Alt + ArrowUp/ArrowDown、Tab / Shift+Tab 进行块级复制、剪切、复制副本、删除、键盘移动和层级调整；使用 /child 或 Child 按钮可插入子块；Enter 会续写标题/列表/待办；拖拽块时左右移动可预览新的父级与深度；在块首按 Backspace 可降级格式；Alt + Enter 可在光标处分裂块；使用 [[文档名]] 或 [[路径]] 创建双链；Ctrl/Cmd + Enter 可在下方插入新块。'
      : 'Type / for block commands, use # / ## / > / - / 1. / - [ ] / - [x] / $$ / --- / ``` for markdown shortcuts, paste multi-line text to split it into multiple blocks, or paste over a selected block range to replace the whole slice, use Select then Shift + Select to create a contiguous multi-block range, convert the selected slice from the toolbar, copy the selected slice as blocks or plain text from the toolbar, or use Ctrl/Cmd + C/X/Shift + D, Delete/Backspace, Alt + ArrowUp/ArrowDown, and Tab / Shift+Tab for block-sequence copy, cut, duplicate, delete, keyboard move, and keyboard nesting, use /child or the Child button to append nested child blocks, press Enter to continue headings/lists/todos, Tab or Shift+Tab to indent list-like blocks, drag blocks left or right while moving to adjust list nesting and preview the resulting parent/depth, Backspace at block start to downgrade format, Ctrl/Cmd + Shift + D to duplicate, Alt + Enter to split at cursor, [[文档名]] or [[路径]] to create a bidirectional link, and press Ctrl/Cmd + Enter to insert a block below.',
    relationChildrenTitle: zh ? '子文档' : 'Children',
    relationChildrenEmpty: zh ? '还没有子文档。' : 'No child documents yet',
    relationOutgoingTitle: zh ? '出链' : 'Outgoing links',
    relationOutgoingEmpty: zh ? '还没有出链。' : 'No outgoing links yet',
    relationBacklinksTitle: zh ? '反向链接' : 'Backlinks',
    relationBacklinksEmpty: zh ? '还没有反向链接。' : 'No backlinks yet',
    pluginActionsLabel: zh ? '插件动作' : 'Plugin actions',
    pluginActionsHint: zh
      ? '插件动作是针对“已保存版本”的文档执行的；如果希望插件读取到最新草稿，请先保存。'
      : 'Plugin actions run against the saved document. Finish editing first if you want the plugin to see your latest draft.',
    askAiLabel: zh ? '询问 AI' : 'Ask AI',
    askAiPlaceholder: zh ? '例如：基于当前文档，给我 3 条结构优化建议' : 'For example: give me 3 structural improvement ideas for this document.',
    runEnabledAutomations: zh ? '运行已启用自动化' : 'Run enabled automations',
    runningAutomations: zh ? '正在运行自动化...' : 'Running automations...',
    findRelatedNotes: zh ? '查找相关笔记' : 'Find related notes',
    searching: zh ? '搜索中...' : 'Searching...',
    thinking: zh ? '思考中...' : 'Thinking...',
    manualAiHint: zh ? '手动执行会立刻复用当前已启用的摘要、标签和高亮自动化。' : 'Manual run reuses the currently enabled summary, tag, and highlight automations for this document immediately.',
    matchPercent: (score: number) => zh ? `${score}% 匹配` : `${score}% match`,
    semanticHint: zh ? '语义检索会扫描工作区内其他文档，并将最相关的结果送入 AI 提示词。' : 'Semantic retrieval will search the rest of the workspace and feed the strongest matches into the AI prompt.',
    emptyDocumentState: zh ? '从左侧树或最近文档列表中选择一个文档，以查看它的块内容和关联关系。' : 'Select a document from the tree or recent list to inspect its blocks and relationships.',
    storageLabel: zh ? '存储' : 'Storage',
    storageTitle: zh ? 'SQLite 与树形 Markdown 备份' : 'SQLite and nested markdown backup',
    databasePath: zh ? '数据库路径' : 'Database path',
    backupRoot: zh ? '备份根目录' : 'Backup root',
    lastBackup: zh ? '上次备份' : 'Last backup',
    aiEndpoint: zh ? 'AI 端点' : 'AI endpoint',
    initializing: zh ? '初始化中...' : 'Initializing...',
    notYetExported: zh ? '尚未导出' : 'Not yet exported',
    recentDocumentsLabel: zh ? '最近文档' : 'Recent documents',
    recentDocumentsTitle: zh ? '来自初始化存储' : 'Seeded from the bootstrap store',
    globalSearchPlaceholder: zh ? '搜索所有文档...（Ctrl+K 关闭）' : 'Search all documents... (Ctrl+K to close)',
    graphLegendTree: zh ? '树结构边' : 'Tree edge',
    graphLegendLink: zh ? '引用链接边' : 'Reference link',
    tableHeaderBlocks: zh ? '块数' : 'Blocks',
    tableHeaderLinks: zh ? '链接数' : 'Links',
    tableHeaderChildren: zh ? '子文档数' : 'Children',
    tableHeaderUpdated: zh ? '更新时间' : 'Updated',
    optionPlaceholder: zh ? '选项 A, 选项 B' : 'Option A, Option B',
    left: zh ? '左移' : 'Left',
    right: zh ? '右移' : 'Right',
    boardDropHint: zh ? '把文档拖到这里' : 'Drop documents here',
    horizontalDivider: zh ? '水平分隔线' : 'Horizontal divider',
    emptyBlock: zh ? '（空块）' : '(empty block)',
    blockReference: zh ? '块引用' : 'Block reference',
    plainText: zh ? '纯文本' : 'Plain text',
    blockSelectionSummary: (input: {
      visibleCount: number
      selectedCount: number
      actionCount: number
      incoherent: boolean
      hasHiddenCollapsedContent: boolean
      selectedBlockInteractionIssue: string | null
      hasCrossParent: boolean
    }) => {
      const pieces = [
        zh
          ? `已选中 ${input.visibleCount} 个可见块`
          : `${input.visibleCount} visible block${input.visibleCount === 1 ? '' : 's'} selected`
      ]

      if (input.selectedCount > input.visibleCount) {
        pieces.push(zh ? `原始范围 ${input.selectedCount} 个（含隐藏块）` : `raw ${input.selectedCount} incl hidden`)
      }
      if (input.actionCount > input.selectedCount) {
        pieces.push(zh ? `子树影响 ${input.actionCount} 个块` : `subtree ${input.actionCount} blocks`)
      }
      if (input.incoherent) {
        pieces.push(zh ? '⚠ 深度混杂' : '⚠ Mixed depths (incoherent)')
      }
      if (input.hasHiddenCollapsedContent) {
        pieces.push(zh ? '包含折叠子树行' : 'includes folded subtree rows')
      }
      if (input.hasCrossParent) {
        pieces.push(zh ? '⚠ 跨父级选区' : '⚠ Cross-parent selection')
      }

      return pieces.join(zh ? ' · ' : ' · ')
    },
    blockSelectionHint: (input: {
      start: number
      end: number
      actionCount: number
      selectedCount: number
      incoherent: boolean
      hasHiddenCollapsedContent: boolean
      selectedBlockInteractionIssue: string | null
    }) => {
      const lines = [
        zh
          ? `当前行 ${input.start + 1}-${input.end + 1}。可用 Shift + Select 扩展连续范围，把整段选区统一转换为某一块类型，复制块或纯文本，对整段执行剪切、删除、复制副本，使用 Alt + ArrowUp/ArrowDown 移动，使用 Tab / Shift+Tab 调整层级，也可以用 Delete 或 Backspace 从键盘删除，或者直接粘贴替换。`
          : `Rows ${input.start + 1}-${input.end + 1}. Use Shift + Select to extend a contiguous range, convert the whole slice to a shared block type, copy blocks or plain text, cut/delete/duplicate the whole slice, use Alt + ArrowUp/ArrowDown to move it, Tab / Shift+Tab to adjust nesting, use Delete or Backspace to remove it from the keyboard, or paste to replace it.`
      ]

      if (input.actionCount > input.selectedCount) {
        lines.push(zh ? '如果当前只选中了一个父块，复制、剪切、复制副本、删除和粘贴替换会自动扩展到整个子树。' : 'For a single selected parent block, copy/cut/duplicate/delete and paste-replace expand to the full subtree.')
      }
      if (input.incoherent) {
        lines.push(zh ? '⚠ 当前选区包含不同嵌套层级的块，部分操作可能会产生意外结果。' : '⚠ This selection contains blocks at different nesting levels. Some operations may behave unexpectedly.')
      }
      if (input.hasHiddenCollapsedContent) {
        lines.push(zh ? '折叠子树中的后代块会被当作当前可见根片段的一部分。' : 'Folded subtree descendants are treated as part of the selected visible root slice.')
      }
      if (input.selectedBlockInteractionIssue) {
        lines.push(zh ? `⚠ ${input.selectedBlockInteractionIssue}` : `⚠ ${input.selectedBlockInteractionIssue}`)
      }

      return lines.join(' ')
    },
    convert: zh ? '转换' : 'Convert',
    copyBlocks: zh ? '复制块' : 'Copy Blocks',
    copyText: zh ? '复制文本' : 'Copy Text',
    cut: zh ? '剪切' : 'Cut',
    duplicate: zh ? '复制副本' : 'Duplicate',
    moveUp: zh ? '上移' : 'Move Up',
    moveDown: zh ? '下移' : 'Move Down',
    clear: zh ? '清空' : 'Clear',
    expandBlock: zh ? '展开块' : 'Expand block',
    collapseBlock: zh ? '折叠块' : 'Collapse block',
    dragBlock: zh ? '拖拽块' : 'Drag block',
    dividerBlock: zh ? '分隔线块' : 'Divider block',
    dropPreviewMeta: (depth: number, parentText: string | null) => zh
      ? `深度 ${depth} · ${parentText ? `父级：${parentText}` : '根级别'}`
      : `Depth ${depth} · ${parentText ? `Child of ${parentText}` : 'Root level'}`,
    backupExported: (count: number, at: string) => zh
      ? `已导出 ${count} 个 Markdown 文件，时间：${new Date(at).toLocaleString(locale)}。`
      : `Exported ${count} markdown files at ${new Date(at).toLocaleString(locale)}.`,
    cannotSaveInvalidBlockTree: (errors: string[]) => zh
      ? `无法保存：块树结构无效。${errors.join('；')}`
      : `Cannot save: invalid block tree structure. ${errors.join('; ')}`,
    markdownExportedPath: (path: string) => zh ? `已导出 Markdown：${path}` : `Markdown exported: ${path}`,
    todoUpdateFailed: zh ? '待办状态更新失败。' : 'Todo update failed.',
    confirmDeleteDocument: (title: string) => zh
      ? `确定删除“${title}”吗？它的子文档会被保留并重新挂到上级。`
      : `Delete "${title}"? Child documents will be kept and reparented.`,
    movedDocumentSuccess: (title: string) => zh ? `已移动文档“${title}”。` : `Moved "${title}" successfully.`,
    moveFailed: zh ? '移动失败。' : 'Move failed.',
    aiSettingsSaved: zh ? 'AI 设置已保存。' : 'AI settings saved.',
    pluginStatusUpdated: (name: string, enabled: boolean) => zh
      ? `${enabled ? '已启用' : '已禁用'}插件“${name}”。`
      : `${enabled ? 'Enabled' : 'Disabled'} plugin "${name}".`,
    pluginStatusUpdateFailed: zh ? '更新插件状态失败。' : 'Failed to update plugin status.',
    pluginsReloaded: zh ? '插件已重载。' : 'Plugins reloaded.',
    pluginsReloadFailed: zh ? '重载插件失败。' : 'Failed to reload plugins.',
    pluginUpdated: (name: string, previousVersion: string, nextVersion: string) => zh
      ? `插件“${name}”已从 ${previousVersion} 更新到 ${nextVersion}。`
      : `Updated plugin "${name}" from ${previousVersion} to ${nextVersion}.`,
    pluginReloadedFromFolder: (name: string) => zh ? `已从安装目录重新加载插件“${name}”。` : `Reloaded plugin "${name}" from its installed folder.`,
    pluginInstalled: (name: string) => zh ? `已安装插件“${name}”。` : `Installed plugin "${name}".`,
    pluginInstallFailed: zh ? '安装插件失败。' : 'Failed to install plugin.',
    confirmRemovePlugin: (name: string) => zh ? `确定从本地用户数据插件目录中移除“${name}”吗？` : `Remove plugin "${name}" from the local user-data plugin root?`,
    pluginRemoved: (name: string) => zh ? `已移除插件“${name}”。` : `Removed plugin "${name}".`,
    pluginRemoveFailed: zh ? '移除插件失败。' : 'Failed to remove plugin.',
    pluginMissingAfterReload: (name: string) => zh ? `插件“${name}”已重载，但列表中已找不到它。` : `Plugin "${name}" was reloaded, but it is no longer listed.`,
    pluginStillHasErrorsAfterReload: (name: string, error: string) => zh ? `插件“${name}”重载后仍有错误：${error}` : `Plugin "${name}" still has errors after reload: ${error}`,
    disabledPluginMetadataReloaded: (name: string) => zh ? `已刷新已禁用插件“${name}”的元数据。` : `Reloaded metadata for disabled plugin "${name}".`,
    pluginReloadedSingle: (name: string) => zh ? `已重载插件“${name}”。` : `Reloaded plugin "${name}".`,
    pluginReloadFailed: zh ? '重载单个插件失败。' : 'Failed to reload plugin.',
    databaseColumnAdded: (name: string) => zh ? `已新增数据库列“${name}”。` : `Added database column "${name}".`,
    databaseColumnCreateFailed: zh ? '创建数据库列失败。' : 'Failed to create database column.',
    databaseColumnRenamed: (name: string) => zh ? `已将列重命名为“${name}”。` : `Renamed column to "${name}".`,
    databaseColumnRenameFailed: zh ? '重命名数据库列失败。' : 'Failed to rename database column.',
    databaseColumnReorderFailed: zh ? '调整数据库列顺序失败。' : 'Failed to reorder database column.',
    databaseColumnOptionsUpdated: zh ? '列选项已更新。' : 'Updated column options.',
    databaseColumnOptionsUpdateFailed: zh ? '更新列选项失败。' : 'Failed to update database column options.',
    confirmDeleteDatabaseColumn: (name: string) => zh ? `确定删除数据库列“${name}”吗？该列已有值也会一并删除。` : `Delete database column "${name}"? Existing values in this column will be removed.`,
    databaseColumnDeleted: (name: string) => zh ? `已删除列“${name}”。` : `Deleted column "${name}".`,
    databaseColumnDeleteFailed: zh ? '删除数据库列失败。' : 'Failed to delete database column.',
    pluginActionFailed: zh ? '执行插件动作失败。' : 'Plugin action failed.',
    aiAutomationResult: (input: { summaryGenerated: boolean; taggedBlocks: number; highlightedBlocks: number }) => {
      const updates: string[] = []
      if (input.summaryGenerated) {
        updates.push(zh ? '摘要' : 'summary')
      }
      if (input.taggedBlocks > 0) {
        updates.push(zh ? `${input.taggedBlocks} 个区块标签` : `${input.taggedBlocks} tagged block${input.taggedBlocks === 1 ? '' : 's'}`)
      }
      if (input.highlightedBlocks > 0) {
        updates.push(zh ? `${input.highlightedBlocks} 个区块高亮` : `${input.highlightedBlocks} highlighted block${input.highlightedBlocks === 1 ? '' : 's'}`)
      }

      if (updates.length === 0) {
        return zh ? '已启用的 AI 自动化没有发现可更新内容。' : 'Enabled AI automations found nothing new to update.'
      }

      return zh ? `AI 自动化已更新：${updates.join('、')}。` : `AI automations updated ${updates.join(', ')}.`
    },
    aiAutomationFailed: zh ? 'AI 自动化运行失败。' : 'AI automation run failed.',
    invalidVisibleTreeSlice: zh ? '当前选区无法识别为可移动的可见树片段。' : 'The current selection cannot be interpreted as a movable visible tree slice.',
    convertedBlocks: (count: number, label: string) => zh ? `已将 ${count} 个块转换为${label}。` : `Converted ${count} blocks to ${label}.`,
    copiedBlocks: (count: number) => zh ? `已复制 ${count} 个块。` : `Copied ${count} blocks as block sequence.`,
    copiedPlainText: (count: number) => zh ? `已复制 ${count} 个块的纯文本。` : `Copied ${count} blocks as plain text.`,
    cutBlocks: (count: number) => zh ? `已剪切 ${count} 个块到剪贴板。` : `Cut ${count} blocks to clipboard.`,
    deletedBlocks: (count: number) => zh ? `已删除 ${count} 个块。` : `Deleted ${count} blocks.`,
    duplicatedBlocks: (count: number) => zh ? `已复制出 ${count} 个块。` : `Duplicated ${count} blocks.`
    ,
    docStatBlocks: zh ? '块' : 'blocks',
    docStatWords: zh ? '词' : 'words',
    docStatCharacters: zh ? '字符' : 'characters',
    docStatCodeBlocks: zh ? '代码块' : 'code blocks',
    docStatTodos: zh ? '待办' : 'todos',
    globalSearchLoading: zh ? '搜索中...' : 'Searching...',
    globalSearchNoResults: zh ? '没有找到匹配的内容。' : 'No matches found.',
    globalSearchPrompt: zh ? '输入关键字搜索所有文档标题和内容块。' : 'Type to search all document titles and blocks.',
    titleMatchLabel: zh ? '标题' : 'Title',
    blockMatchFallback: zh ? '块' : 'block',
    semanticSearchFailed: zh ? '语义检索失败。' : 'Semantic search failed.',
    aiRequestFailed: zh ? 'AI 请求失败。' : 'AI request failed.',
    copyFailed: zh ? '复制失败。' : 'Copy failed.',
    copyTextFailed: zh ? '复制文本失败。' : 'Copy text failed.',
    cutFailed: zh ? '剪切失败。' : 'Cut failed.',
    visibleSliceCrossParentGuard: zh ? '当前可见块片段跨越了不同父级或混合的同级层级，不能移动或拖拽。请只选择同一父级下的同级根块。' : 'Cannot move or drag a visible block slice across different parents or mixed sibling levels. Select sibling roots under the same parent.',
    blockTypeChangeHint: zh ? '改变块类型' : 'Change block type',
    blockToolbarDuplicate: zh ? '复制' : 'Duplicate',
    blockToolbarDelete: zh ? '删除' : 'Delete',
    codeBlockLanguageLabel: zh ? '语言' : 'Language',
    codeBlockLanguageHint: zh ? '点击修改代码块的编程语言' : 'Click to edit the programming language'
  }
}

export type UiText = ReturnType<typeof createUiText>
