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
    clear: zh ? '清空' : 'Clear',
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
    divider: zh ? '分隔线' : 'Divider',
    table: zh ? '表格' : 'Table'
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
    divider: zh ? '分隔线' : 'Divider',
    table: zh ? '表格' : 'Table'
  }

  const conversionOptions: Record<string, string> = {
    paragraph: zh ? '转为文本' : 'As Text',
    todo: zh ? '转为待办' : 'As Todo',
    quote: zh ? '转为引用' : 'As Quote',
    'bulleted-list': zh ? '转为无序列表' : 'As Bullet',
    'numbered-list': zh ? '转为有序列表' : 'As Numbered',
    table: zh ? '转为表格' : 'As Table'
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
     relatedNotesOnAsk: zh ? '询问 AI 时检索相关笔记' : 'Retrieve related notes when asking AI',
    baseUrl: zh ? '基础地址' : 'Base URL',
    model: zh ? '模型' : 'Model',
    apiKeyLabel: zh ? 'API Key（留空表示保持当前值）' : 'API Key (leave blank to keep current)',
    currentKey: (configured: boolean) => zh
      ? `当前密钥：${configured ? '已配置' : '未配置'}`
      : `Current key: ${configured ? 'configured' : 'missing'}`,
    aiHintOverview: zh
      ? 'Chat 模型负责问答、自动摘要和相关笔记检索增强。'
      : 'Chat models power Q&A, auto-summary, and related-note retrieval enhancements.',
    aiHintSummary: zh
      ? '自动摘要只会在文档保存时触发，并且仅在当前摘要为空或仍为默认占位内容时运行。'
      : 'Auto-summary runs only on document save when the current summary is empty or still using the default placeholder.',
    saveAiSettings: zh ? '保存 AI 设置' : 'Save AI settings',
    appUpdateLabel: zh ? '应用更新' : 'App updates',
    appUpdateTitle: zh ? '桌面版本更新' : 'Desktop version updates',
    appUpdateDescription: zh
      ? '打包后的应用会在启动后后台检查 GitHub Releases；发现新版本后会自动下载，并在下载完成后提供安装入口。'
      : 'Packaged builds check GitHub Releases after startup, download new versions in the background, and expose an install action once the update is ready.',
    currentVersionLabel: zh ? '当前版本' : 'Current version',
    availableVersionLabel: zh ? '可用版本' : 'Available version',
    updateStatusField: zh ? '更新状态' : 'Update status',
    lastCheckedLabel: zh ? '最近检查' : 'Last checked',
    releaseNotesLabel: zh ? '更新说明' : 'Release notes',
    notCheckedYet: zh ? '尚未检查' : 'Not checked yet',
    noReleaseNotes: zh ? '当前没有可展示的更新说明。' : 'No release notes are available right now.',
    checkForUpdates: zh ? '检查更新' : 'Check for updates',
    checkingForUpdates: zh ? '检查中...' : 'Checking...',
    installUpdateNow: zh ? '安装更新并重启' : 'Install update and restart',
    updateStatusIdle: zh ? '已就绪，可手动检查更新。' : 'Ready to check for updates.',
    updateStatusChecking: zh ? '正在检查新版本...' : 'Checking for a newer version...',
    updateStatusAvailable: (version: string | null) => zh
      ? `发现新版本${version ? ` ${version}` : ''}，正在后台下载。`
      : `Update${version ? ` ${version}` : ''} found. Downloading in background.`,
    updateStatusDownloading: (progress: number | null) => zh
      ? `正在下载更新${progress !== null ? `（${progress}%）` : ''}。`
      : `Downloading update${progress !== null ? ` (${progress}%)` : ''}.`,
    updateStatusDownloaded: (version: string | null) => zh
      ? `新版本${version ? ` ${version}` : ''}已下载，安装后会重启应用。`
      : `Update${version ? ` ${version}` : ''} is downloaded and ready to install.`,
    updateStatusNotAvailable: zh ? '当前已经是最新版本。' : 'You already have the latest version.',
    updateStatusUnsupported: zh ? '自动更新只在打包后的桌面应用中可用。' : 'Auto updates are only available in packaged desktop builds.',
    updateStatusError: (message: string | null) => zh
      ? `更新检查失败${message ? `：${message}` : '。'}`
      : `Update check failed${message ? `: ${message}` : '.'}`,
    appUpdateCheckStarted: zh ? '已开始检查更新。' : 'Started checking for updates.',
    appUpdateCheckFailed: zh ? '检查更新失败。' : 'Failed to check for updates.',
    appUpdateInstallFailed: zh ? '安装更新失败。' : 'Failed to install the downloaded update.',
    automationFeedLabel: zh ? '自动化事件流' : 'Automation feed',
    recentEventsTitle: zh ? '最近事件' : 'Recent events',
    noAutomationEvents: zh ? '还没有自动化事件。' : 'No automation events yet.',
    pluginsLabel: zh ? '插件' : 'Plugins',
    pluginsTitle: zh ? '工作区扩展' : 'Workspace extensions',
    installFolder: zh ? '安装文件夹' : 'Install Folder',
    pluginSettingsLabel: zh ? '插件设置' : 'Plugin settings',
    noPluginSettings: zh ? '这个插件当前没有暴露可编辑设置。' : 'This plugin does not expose editable settings right now.',
    savePluginSetting: (label: string) => zh ? `保存“${label}”` : `Save ${label}`,
    pluginSettingDefault: (value: string | boolean) => zh ? `默认值：${String(value)}` : `Default: ${String(value)}`,
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
    restoreBackup: zh ? '恢复备份' : 'Restore backup',
    documentsLabel: zh ? '文档数' : 'Documents',
    blocksLabel: zh ? '块数' : 'Blocks',
    linksLabel: zh ? '链接数' : 'Links',
    aiLabel: 'AI',
    aiReadyState: (enabled: boolean) => enabled ? (zh ? 'API 已就绪' : 'API ready') : (zh ? '已禁用' : 'Disabled'),
    pluginCardLabel: zh ? '插件卡片' : 'Plugin card',
    knowledgeGraphLabel: zh ? '知识图谱' : 'Knowledge graph',
    treeView: zh ? '树视图' : 'Tree view',
    graphView: zh ? '图谱视图' : 'Graph view',
    knowledgeGraphTitle: zh ? '工作区拓扑' : 'Workspace topology',
    workspaceTopology: zh ? '工作区拓扑' : 'Workspace topology',
    databaseViewLabel: zh ? '数据库视图' : 'Database view',
    documentCatalogTitle: zh ? '文档目录' : 'Document catalog',
    standaloneDatabasesTitle: zh ? '独立数据库' : 'Standalone databases',
    documentCatalogHint: zh
      ? '这里管理默认文档数据库的字段、表格和看板；结构化字段会直接写回文档目录。'
      : 'Manage the default document database here. Fields added in this view are written back into the document catalog table and board.',
    standaloneDatabasesHint: zh
      ? '这里专门管理独立 database 的 schema 与实体行，不再和文档 catalog 混排。'
      : 'Manage standalone database schemas and entity rows here, separate from the document catalog.',
    addColumn: zh ? '新增列' : 'Add column',
    addDatabase: zh ? '新增数据库' : 'Add database',
    addEntity: zh ? '新增实体' : 'Add entity',
    closeSchema: zh ? '关闭结构编辑' : 'Close schema',
    searchDocumentsPlaceholder: zh ? '搜索文档...' : 'Search documents...',
    searchDatabaseEntitiesPlaceholder: zh ? '搜索实体或字段值...' : 'Search entities or field values...',
    customColumnsCount: (count: number) => zh ? `${count} 个自定义列` : `${count} custom columns`,
    rowsCount: (count: number) => zh ? `${count} 行` : `${count} rows`,
    filteredRowsCount: (visibleCount: number, totalCount: number) => zh ? `${visibleCount} / ${totalCount} 行` : `${visibleCount} / ${totalCount} rows`,
    columnName: zh ? '列名' : 'Column name',
    databaseName: zh ? '数据库名称' : 'Database name',
    databaseDescription: zh ? '描述' : 'Description',
    createDatabase: zh ? '创建数据库' : 'Create database',
    fieldType: zh ? '字段类型' : 'Field type',
    options: zh ? '选项' : 'Options',
    optionsCommaHint: zh ? '使用逗号分隔多个选项' : 'Separate options with commas',
    saveColumn: zh ? '保存列' : 'Save column',
    selectDatabasePlaceholder: zh ? '选择数据库...' : 'Select a database...',
    linkToDocumentOptional: zh ? '关联文档（可选）' : 'Link to Document (optional)',
    createEntity: zh ? '创建实体' : 'Create Entity',
    noCustomColumnsYet: zh
      ? '还没有自定义数据库列。先新增一列，再为每篇文档录入结构化元数据。'
      : 'No custom database columns yet. Add a column to start capturing structured metadata on each document.',
    noIndependentDatabasesYet: zh
      ? '还没有独立数据库。如需使用独立 database 实体，请先创建一个数据库。'
      : 'No independent databases yet. Create one first if you want to use standalone database entities.',
    noStandaloneDatabaseColumnsYet: (name: string) => zh
      ? `数据库“${name}”还没有字段。先新增一列，再开始录入实体。`
      : `${name} does not have any fields yet. Add a column before entering entity data.`,
    noDatabaseEntitiesYet: (name: string) => zh
      ? `数据库“${name}”下还没有实体。可以先创建一条关联文档的记录，或录入独立行。`
      : `No entities yet for ${name}. Create one to link a document or store standalone rows.`,
    noFilteredDatabaseEntitiesYet: (name: string) => zh
      ? `数据库“${name}”里没有匹配当前过滤条件的实体。`
      : `No entities in ${name} match the current filters.`,
    databaseEntityFilterAllFields: zh ? '全部字段' : 'All fields',
    databaseEntityFilterLinkedDocument: zh ? '关联文档' : 'Linked document',
    databaseEntityFilterField: (name: string) => zh ? `字段：${name}` : `Field: ${name}`,
    databaseSavedViewsLabel: zh ? '已保存视图' : 'Saved views',
    databaseSavedViewDraftOption: zh ? '当前未保存视图' : 'Current unsaved view',
    databaseSavedViewDefaultName: (index: number) => zh ? `视图 ${index}` : `View ${index}`,
    databaseSavedViewNamePrompt: zh ? '输入视图名称' : 'Name this view',
    saveCurrentDatabaseView: zh ? '保存当前视图' : 'Save current view',
    updateCurrentDatabaseView: zh ? '更新已选视图' : 'Update selected view',
    deleteCurrentDatabaseView: zh ? '删除已选视图' : 'Delete selected view',
    deleteCurrentDatabase: zh ? '删除当前数据库' : 'Delete current database',
    databaseSavedViewCreated: (name: string) => zh ? `已保存视图“${name}”。` : `Saved view "${name}" saved.`,
    databaseSavedViewUpdated: (name: string) => zh ? `已更新视图“${name}”。` : `Saved view "${name}" updated.`,
    databaseSavedViewDeleted: (name: string) => zh ? `已删除视图“${name}”。` : `Saved view "${name}" deleted.`,
    databaseSavedViewCreateFailed: zh ? '保存视图失败。' : 'Failed to save view.',
    databaseSavedViewUpdateFailed: zh ? '更新视图失败。' : 'Failed to update view.',
    databaseSavedViewDeleteFailed: zh ? '删除视图失败。' : 'Failed to delete view.',
    confirmDeleteDatabaseSavedView: (name: string) => zh ? `确定删除视图“${name}”吗？` : `Delete saved view "${name}"?`,
    confirmDeleteDatabase: (name: string) => zh ? `确定删除数据库“${name}”吗？其中的字段、实体和已保存视图也会一并删除。` : `Delete database "${name}"? Its fields, entities, and saved views will also be removed.`,
    databaseEntitySortUpdatedDesc: zh ? '最近更新优先' : 'Recently updated first',
    databaseEntitySortUpdatedAsc: zh ? '最早更新优先' : 'Oldest update first',
    databaseEntitySortCreatedDesc: zh ? '最新创建优先' : 'Newest created first',
    databaseEntitySortCreatedAsc: zh ? '最早创建优先' : 'Oldest created first',
    databaseEntityViewModeLabel: zh ? '视图' : 'View',
    databaseEntityCardsView: zh ? '卡片' : 'Cards',
    databaseEntityTableView: zh ? '表格' : 'Table',
    databaseEntityCardsHint: zh ? '卡片视图更适合逐条浏览实体、编辑字段和处理关联文档。' : 'Cards are better for browsing entities one by one, editing fields, and managing linked documents.',
    databaseEntityTableHint: zh ? '表格视图更适合横向比较多条实体，并在同一屏内批量核对字段值。' : 'The table view is better for comparing many entities side by side and checking field values in one screen.',
    selectedDatabaseEntitiesCount: (count: number) => zh ? `已选 ${count} 条` : `${count} selected`,
    selectVisibleDatabaseEntities: zh ? '选择可见项' : 'Select visible',
    databaseEntityBulkEditLabel: zh ? '批量编辑' : 'Bulk edit',
    databaseEntityBulkEditTitle: (count: number) => zh ? `批量编辑已选实体（${count}）` : `Bulk edit selected entities (${count})`,
    databaseEntityBulkEditHint: zh
      ? '在字段中输入草稿后点击“应用”，会把该值批量写入当前已选实体；点击“清空字段”会批量移除该字段值。关联文档支持对已选实体统一解绑。'
      : 'Enter a draft value and click Apply to write it to the current selection. Clear field removes that column value from the selected entities. Linked documents can be cleared for the whole selection.',
    deleteSelectedDatabaseEntities: (count: number) => zh ? `删除已选（${count}）` : `Delete selected (${count})`,
    applySelectedDatabaseEntityField: (name: string, count: number) => zh ? `应用字段“${name}”（${count}）` : `Apply ${name} (${count})`,
    clearSelectedDatabaseEntityField: (name: string, count: number) => zh ? `清空字段“${name}”（${count}）` : `Clear ${name} (${count})`,
    clearSelectedDatabaseEntityDocuments: (count: number) => zh ? `清空关联文档（${count}）` : `Clear linked documents (${count})`,
    selectDatabaseEntity: (name: string) => zh ? `选择数据库实体：${name}` : `Select database entity: ${name}`,
    databaseEntityTableEntity: zh ? '实体' : 'Entity',
    databaseEntityTableActions: zh ? '操作' : 'Actions',
    noLinkedDocument: zh ? '未关联文档' : 'No linked document',
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
    nodes: zh ? '节点' : 'nodes',
    edges: zh ? '边' : 'edges',
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
    moreActions: zh ? '更多操作' : 'More actions',
    addChild: zh ? '新增子文档' : 'Add child',
    auxiliaryPanelShort: zh ? '辅助区' : 'Aux',
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
    blockReferenceNotFound: zh ? '未找到引用目标。' : 'Reference target not found.',
    editorHelpText: zh
      ? '输入 / 可打开块命令；支持 # / ## / > / - / 1. / - [ ] / - [x] / $$ / --- / ``` 等 Markdown 快捷写法；粘贴多行文本会自动拆成多个块，也可以直接覆盖当前选区；先 Select 再 Shift + Select 可以选中连续块范围；可用工具栏把整段选区转换为同一块类型、复制块或纯文本、剪切/删除/复制整段；也支持 Ctrl/Cmd + C/X/Shift + D、Delete/Backspace、Alt + ArrowUp/ArrowDown、Tab / Shift+Tab 进行块级复制、剪切、复制副本、删除、键盘移动和层级调整；使用 /child 或 Child 按钮可插入子块；Enter 会续写标题/列表/待办；拖拽块时左右移动可预览新的父级与深度；在块首按 Backspace 可降级格式；Alt + Enter 可在光标处分裂块；使用 [[文档名]]、[[路径]] 或 [[路径#块ID]] 创建引用；按住 Ctrl/Cmd 并点击引用可跳转；Ctrl/Cmd + Enter 可在下方插入新块。'
      : 'Type / for block commands, use # / ## / > / - / 1. / - [ ] / - [x] / $$ / --- / ``` for markdown shortcuts, paste multi-line text to split it into multiple blocks, or paste over a selected block range to replace the whole slice, use Select then Shift + Select to create a contiguous multi-block range, convert the selected slice from the toolbar, copy the selected slice as blocks or plain text from the toolbar, or use Ctrl/Cmd + C/X/Shift + D, Delete/Backspace, Alt + ArrowUp/ArrowDown, and Tab / Shift+Tab for block-sequence copy, cut, duplicate, delete, keyboard move, and keyboard nesting, use /child or the Child button to append nested child blocks, press Enter to continue headings/lists/todos, Tab or Shift+Tab to indent list-like blocks, drag blocks left or right while moving to adjust list nesting and preview the resulting parent/depth, Backspace at block start to downgrade format, Ctrl/Cmd + Shift + D to duplicate, Alt + Enter to split at cursor, use [[title]], [[path]], or [[path#blockId]] references, hold Ctrl/Cmd and click a reference to jump, and press Ctrl/Cmd + Enter to insert a block below.',
    relationChildrenTitle: zh ? '子文档' : 'Children',
    relationChildrenEmpty: zh ? '还没有子文档。' : 'No child documents yet',
    relationOutgoingTitle: zh ? '出链' : 'Outgoing links',
    relationOutgoingEmpty: zh ? '还没有出链。' : 'No outgoing links yet',
    relationBacklinksTitle: zh ? '反向链接' : 'Backlinks',
    relationBacklinksEmpty: zh ? '还没有反向链接。' : 'No backlinks yet',
    webClipLabel: zh ? '网页剪藏' : 'Web clip',
    webClipPlaceholder: zh ? '粘贴网页 URL，例如 https://example.com/article' : 'Paste a webpage URL, for example https://example.com/article',
    clipWebPage: zh ? '剪藏网页' : 'Clip webpage',
    clippingWebPage: zh ? '剪藏中...' : 'Clipping...',
    webClipHint: zh ? '会把目标网页提取为当前文档下的新子文档，并自动记录来源字段。' : 'This creates a new child document under the current note and stores source metadata automatically.',
    webClipBridgeLabel: zh ? '浏览器桥接' : 'Browser bridge',
    webClipBridgeTitle: zh ? '扩展本地剪藏入口' : 'Local browser clip bridge',
    webClipBridgeDescription: zh ? '浏览器扩展可以把当前页面内容直接 POST 到本机 KnowBook，再导入为文档。' : 'A browser extension can POST the current page payload directly to the local KnowBook app and import it as a document.',
    webClipBridgeEnabledLabel: zh ? '启用本地网页剪藏桥接服务' : 'Enable local web clip bridge service',
    webClipBridgePortLabel: zh ? '监听端口' : 'Listening port',
    webClipBridgeTokenLabel: zh ? '授权令牌' : 'Authorization token',
    webClipBridgeEndpointLabel: zh ? '扩展提交地址' : 'Extension endpoint',
    webClipBridgeStatusLabel: zh ? '桥接状态' : 'Bridge status',
    webClipBridgeStatusRunning: zh ? '运行中' : 'Running',
    webClipBridgeStatusStopped: zh ? '未运行' : 'Stopped',
    webClipBridgeErrorLabel: zh ? '最近错误' : 'Last error',
    webClipBridgeHint: zh ? '扩展需要把 Bearer Token 和提交地址一起配置。修改端口或重新生成令牌后，记得同步更新扩展。' : 'Configure the extension with both the Bearer token and the endpoint. If you change the port or regenerate the token, update the extension too.',
    webClipBridgeSave: zh ? '保存桥接设置' : 'Save bridge settings',
    webClipBridgeRegenerateToken: zh ? '重新生成令牌' : 'Regenerate token',
    webClipBridgeCopyEndpoint: zh ? '复制提交地址' : 'Copy endpoint',
    webClipBridgeCopyToken: zh ? '复制令牌' : 'Copy token',
    webClipBridgeUnavailable: zh ? '尚未启动' : 'Not running yet',
    blockPreviewImagesLabel: zh ? '图片预览' : 'Image previews',
    blockPreviewLinksLabel: zh ? '链接预览' : 'Link previews',
    openExternalLink: zh ? '打开' : 'Open',
    pluginActionsLabel: zh ? '插件动作' : 'Plugin actions',
    pluginActionsHint: zh
      ? '插件动作是针对“已保存版本”的文档执行的；如果希望插件读取到最新草稿，请先保存。'
      : 'Plugin actions run against the saved document. Finish editing first if you want the plugin to see your latest draft.',
    aiEditSelection: zh ? 'AI 编辑' : 'AI edit',
    askAiLabel: zh ? '询问 AI' : 'Ask AI',
    askAiPlaceholder: zh ? '例如：基于当前文档，给我 3 条结构优化建议' : 'For example: give me 3 structural improvement ideas for this document.',
    aiSelectionLabel: zh ? 'AI 编辑选区' : 'AI edit selection',
    aiSelectionModeSummarize: zh ? '总结' : 'Summarize',
    aiSelectionModeRewrite: zh ? '润色改写' : 'Rewrite',
    aiSelectionModeTable: zh ? '转成表格' : 'Table',
    aiSelectionModeCustom: zh ? '自定义指令' : 'Custom',
    aiSelectionCustomPlaceholder: zh ? '例如：改成会议纪要、压缩成 3 条、翻译成英文' : 'For example: rewrite as meeting notes, compress into 3 bullets, or translate to English',
    aiSelectionGeneratePreview: zh ? '生成预览' : 'Generate preview',
    aiSelectionGeneratingPreview: zh ? '生成中...' : 'Generating...',
    aiSelectionPreviewLabel: zh ? '预览结果' : 'Preview',
    aiSelectionApplyPreview: zh ? '应用到文档' : 'Apply to document',
    aiSelectionDiscardPreview: zh ? '丢弃预览' : 'Discard preview',
    aiSelectionDisabledHint: zh ? '当前未启用 AI。请先在设置里开启 AI 功能。' : 'AI is currently disabled. Enable AI in settings first.',
    aiSelectionMissingApiKeyHint: zh ? '当前未保存 API Key。请先在设置里保存后再生成预览。' : 'No API key is saved yet. Save one in settings before generating a preview.',
    aiSelectionPreviewStale: zh ? '当前预览已经过期：你修改了标题、摘要或选区内容，请重新生成。' : 'This preview is stale because the title, summary, or selected blocks changed. Generate it again.',
    aiSelectionSummary: (selectedCount: number, actionCount: number) => zh
      ? `当前选区 ${selectedCount} 个块，实际会替换 ${actionCount} 个块。`
      : `${selectedCount} selected block${selectedCount === 1 ? '' : 's'}, replacing ${actionCount} block${actionCount === 1 ? '' : 's'} when applied.`,
    aiSelectionHint: (actionCount: number) => zh
      ? `预览会基于当前草稿选区生成；确认应用后，会用结果替换这 ${actionCount} 个块。`
      : `The preview uses the current draft selection. Applying it will replace these ${actionCount} block${actionCount === 1 ? '' : 's'}.`,
    runEnabledAutomations: zh ? '运行已启用自动化' : 'Run enabled automations',
    runningAutomations: zh ? '正在运行自动化...' : 'Running automations...',
    findRelatedNotes: zh ? '查找相关笔记' : 'Find related notes',
    searching: zh ? '搜索中...' : 'Searching...',
    thinking: zh ? '思考中...' : 'Thinking...',
    manualAiHint: zh ? '手动执行会立刻复用当前已启用的摘要自动化。' : 'Manual run reuses the currently enabled summary automation for this document immediately.',
    matchPercent: (score: number) => zh ? `${score}% 匹配` : `${score}% match`,
    semanticHint: zh ? '相关笔记检索会基于标题、摘要与正文关键词在工作区内查找上下文。' : 'Related-note retrieval searches workspace titles, summaries, and block content with local keyword matching.',
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
    backupRestored: (restored: number, created: number, updated: number, deleted: number, conflicts: number, placeholders: number, at: string) => zh
      ? `已恢复 ${restored} 个备份文档（新建 ${created}，更新 ${updated}，删除过期文档 ${deleted}，解决路径冲突 ${conflicts}，补父级占位 ${placeholders}），时间：${new Date(at).toLocaleString(locale)}。`
      : `Restored ${restored} backup documents (${created} created, ${updated} updated, ${deleted} stale deleted, ${conflicts} conflicts resolved, ${placeholders} parent placeholders) at ${new Date(at).toLocaleString(locale)}.`,
    backupRestoreFailed: zh ? '恢复备份失败。' : 'Failed to restore backup.',
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
    webClipImported: (title: string) => zh ? `已剪藏网页并创建文档“${title}”。` : `Clipped webpage into "${title}".`,
    webClipImportedWithWarnings: (title: string, count: number) => zh ? `已剪藏网页并创建文档“${title}”，有 ${count} 条提示。` : `Clipped webpage into "${title}" with ${count} warning${count === 1 ? '' : 's'}.`,
    webClipOpenedExisting: (title: string) => zh ? `已打开已有剪藏文档“${title}”。` : `Opened existing clipped document "${title}".`,
    webClipFailed: zh ? '网页剪藏失败。' : 'Web clipping failed.',
    webClipBridgeSaved: (running: boolean) => zh ? `网页剪藏桥接设置已保存${running ? '，服务已启动。' : '。'}` : `Web clip bridge settings saved${running ? ', service started.' : '.'}`,
    webClipBridgeSaveFailed: zh ? '保存网页剪藏桥接设置失败。' : 'Failed to save web clip bridge settings.',
    webClipBridgeTokenRefreshed: zh ? '网页剪藏桥接令牌已刷新。' : 'Web clip bridge token refreshed.',
    webClipBridgeEndpointCopied: zh ? '网页剪藏提交地址已复制。' : 'Web clip bridge endpoint copied.',
    webClipBridgeTokenCopied: zh ? '网页剪藏令牌已复制。' : 'Web clip bridge token copied.',
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
    pluginSettingSaved: (pluginName: string, settingLabel: string) => zh ? `已保存插件“${pluginName}”的设置“${settingLabel}”。` : `Saved ${settingLabel} for plugin "${pluginName}".`,
    pluginSettingUpdateFailed: zh ? '保存插件设置失败。' : 'Failed to save plugin setting.',
    pluginMissingAfterReload: (name: string) => zh ? `插件“${name}”已重载，但列表中已找不到它。` : `Plugin "${name}" was reloaded, but it is no longer listed.`,
    pluginStillHasErrorsAfterReload: (name: string, error: string) => zh ? `插件“${name}”重载后仍有错误：${error}` : `Plugin "${name}" still has errors after reload: ${error}`,
    disabledPluginMetadataReloaded: (name: string) => zh ? `已刷新已禁用插件“${name}”的元数据。` : `Reloaded metadata for disabled plugin "${name}".`,
    pluginReloadedSingle: (name: string) => zh ? `已重载插件“${name}”。` : `Reloaded plugin "${name}".`,
    pluginReloadFailed: zh ? '重载单个插件失败。' : 'Failed to reload plugin.',
    databaseColumnAdded: (name: string) => zh ? `已新增数据库列“${name}”。` : `Added database column "${name}".`,
    databaseColumnCreateFailed: zh ? '创建数据库列失败。' : 'Failed to create database column.',
    databaseCreated: (name: string) => zh ? `已创建数据库“${name}”。` : `Database "${name}" created successfully.`,
    databaseCreateFailed: zh ? '创建数据库失败。' : 'Failed to create database.',
    databaseDeleted: (name: string) => zh ? `已删除数据库“${name}”。` : `Database "${name}" deleted.`,
    databaseDeleteFailed: zh ? '删除数据库失败。' : 'Failed to delete database.',
    databaseColumnRenamed: (name: string) => zh ? `已将列重命名为“${name}”。` : `Renamed column to "${name}".`,
    databaseColumnRenameFailed: zh ? '重命名数据库列失败。' : 'Failed to rename database column.',
    databaseColumnReorderFailed: zh ? '调整数据库列顺序失败。' : 'Failed to reorder database column.',
    databaseColumnOptionsUpdated: zh ? '列选项已更新。' : 'Updated column options.',
    databaseColumnOptionsUpdateFailed: zh ? '更新列选项失败。' : 'Failed to update database column options.',
    confirmDeleteDatabaseColumn: (name: string) => zh ? `确定删除数据库列“${name}”吗？该列已有值也会一并删除。` : `Delete database column "${name}"? Existing values in this column will be removed.`,
    databaseColumnDeleted: (name: string) => zh ? `已删除列“${name}”。` : `Deleted column "${name}".`,
    databaseColumnDeleteFailed: zh ? '删除数据库列失败。' : 'Failed to delete database column.',
    databaseEntityCreated: zh ? '数据库实体已创建。' : 'Database entity created successfully.',
    databaseEntityCreateFailed: zh ? '创建数据库实体失败。' : 'Failed to create database entity.',
    databaseEntityUpdated: zh ? '数据库实体已更新。' : 'Database entity updated.',
    databaseEntityUpdateFailed: zh ? '更新数据库实体失败。' : 'Failed to update database entity.',
    databaseEntitiesUpdated: (count: number) => zh ? `已更新 ${count} 条数据库实体。` : `Updated ${count} database entities.`,
    databaseEntitiesUpdateFailed: zh ? '批量更新数据库实体失败。' : 'Failed to update selected database entities.',
    confirmDeleteDatabaseEntity: zh ? '确定删除这条数据库实体吗？' : 'Are you sure you want to delete this database entity?',
    confirmDeleteDatabaseEntities: (count: number) => zh ? `确定删除这 ${count} 条数据库实体吗？` : `Delete these ${count} database entities?`,
    databaseEntityDeleted: zh ? '数据库实体已删除。' : 'Database entity deleted.',
    databaseEntitiesDeleted: (count: number) => zh ? `已删除 ${count} 条数据库实体。` : `Deleted ${count} database entities.`,
    databaseEntityDeleteFailed: zh ? '删除数据库实体失败。' : 'Failed to delete database entity.',
    databaseEntitiesDeleteFailed: zh ? '批量删除数据库实体失败。' : 'Failed to delete selected database entities.',
    pluginActionFailed: zh ? '执行插件动作失败。' : 'Plugin action failed.',
    aiAutomationResult: (input: { summaryGenerated: boolean }) => {
      if (input.summaryGenerated) {
        return zh ? 'AI 自动化已更新摘要。' : 'AI automation updated the summary.'
      }

      return zh ? '摘要自动化没有发现可更新内容。' : 'Summary automation found nothing new to update.'
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
    semanticSearchFailed: zh ? '相关笔记检索失败。' : 'Related note search failed.',
    aiRequestFailed: zh ? 'AI 请求失败。' : 'AI request failed.',
    copyFailed: zh ? '复制失败。' : 'Copy failed.',
    copyTextFailed: zh ? '复制文本失败。' : 'Copy text failed.',
    cutFailed: zh ? '剪切失败。' : 'Cut failed.',
    visibleSliceCrossParentGuard: zh ? '当前可见块片段跨越了不同父级或混合的同级层级，不能移动或拖拽。请只选择同一父级下的同级根块。' : 'Cannot move or drag a visible block slice across different parents or mixed sibling levels. Select sibling roots under the same parent.',
    blockTypeChangeHint: zh ? '改变块类型' : 'Change block type',
    blockToolbarDuplicate: zh ? '复制' : 'Duplicate',
    blockToolbarDelete: zh ? '删除' : 'Delete',
    blockToolbarAiEdit: zh ? 'AI 编辑' : 'AI edit',
    codeBlockLanguageLabel: zh ? '语言' : 'Language',
    codeBlockLanguageHint: zh ? '点击修改代码块的编程语言' : 'Click to edit the programming language'
  }
}

export type UiText = ReturnType<typeof createUiText>
