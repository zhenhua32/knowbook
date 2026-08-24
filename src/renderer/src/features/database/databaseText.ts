export function getDatabaseWorkspaceText(locale: string) {
  const zh = locale.toLowerCase().startsWith('zh')
  return zh ? {
    workspace: '数据库工作台', allDocuments: '全部文档', system: '系统', custom: '自定义数据库',
    searchDatabase: '搜索数据库…', newDatabase: '新建数据库', newDocument: '新建文档', newRecord: '新建记录',
    all: '全部', newView: '新建视图', table: '表格', board: '看板', cards: '卡片',
    search: '搜索记录…', filter: '筛选', sort: '排序', group: '分组', fields: '字段',
    records: (count: number) => `${count} 条记录`, saveChanges: '保存更改', saved: '已保存',
    noRecords: '当前视图没有记录', noRecordsHint: '调整搜索或筛选条件，或者新建一条记录。',
    untitledView: '未命名视图', viewName: '视图名称', create: '创建', cancel: '取消', save: '保存',
    editDatabase: '编辑数据库', rename: '重命名', delete: '删除', description: '描述', name: '名称',
    manageFields: '字段管理', visibleFields: (visible: number, total: number) => `显示 ${visible} / 共 ${total} 个字段`,
    addField: '新增字段', fieldType: '字段类型', options: '选项（逗号分隔）', hide: '隐藏', show: '显示',
    moveUp: '上移', moveDown: '下移', close: '关闭', title: '标题', linkedDocument: '关联文档',
    noLinkedDocument: '不关联文档', recordDetails: '记录详情', createRecord: '新建记录',
    deleteRecord: '删除记录', deleteField: '删除字段', deleteView: '删除视图', deleteDatabase: '删除数据库',
    dangerCannotUndo: '此操作会删除相关数据，且无法撤销；可从 Markdown 备份恢复。',
    confirm: '确认', selected: (count: number) => `已选 ${count} 条`, clearSelection: '清除选择',
    filterField: '筛选字段', operator: '条件', value: '值', addFilter: '添加筛选', clearFilters: '清除筛选',
    contains: '包含', notContains: '不包含', equals: '等于', notEquals: '不等于', isEmpty: '为空', isNotEmpty: '不为空', before: '早于', after: '晚于', checked: '已勾选', unchecked: '未勾选', containsAny: '包含任一', containsAll: '包含全部',
    ascending: '升序', descending: '降序', noGrouping: '不分组', layout: '布局',
    editRecord: '编辑记录', openDocument: '打开文档', requiredTitle: '请输入记录标题', loading: '正在加载数据库…',
    customDescription: '独立组织项目、资料与轻量业务记录。',
    catalogDescription: '工作区中的全部文档，可使用字段进行分类和组织。',
    createAndContinue: '创建并继续添加', databaseSettings: '数据库设置', viewMenu: '视图菜单',
    saveAsView: '另存为新视图', resetView: '重置更改', failed: '操作失败，请重试。'
  } : {
    workspace: 'Database workspace', allDocuments: 'All documents', system: 'System', custom: 'Custom databases',
    searchDatabase: 'Search databases…', newDatabase: 'New database', newDocument: 'New document', newRecord: 'New record',
    all: 'All', newView: 'New view', table: 'Table', board: 'Board', cards: 'Cards',
    search: 'Search records…', filter: 'Filter', sort: 'Sort', group: 'Group', fields: 'Fields',
    records: (count: number) => `${count} records`, saveChanges: 'Save changes', saved: 'Saved',
    noRecords: 'No records in this view', noRecordsHint: 'Adjust search or filters, or create a new record.',
    untitledView: 'Untitled view', viewName: 'View name', create: 'Create', cancel: 'Cancel', save: 'Save',
    editDatabase: 'Edit database', rename: 'Rename', delete: 'Delete', description: 'Description', name: 'Name',
    manageFields: 'Manage fields', visibleFields: (visible: number, total: number) => `${visible} of ${total} fields shown`,
    addField: 'Add field', fieldType: 'Field type', options: 'Options (comma separated)', hide: 'Hide', show: 'Show',
    moveUp: 'Move up', moveDown: 'Move down', close: 'Close', title: 'Title', linkedDocument: 'Linked document',
    noLinkedDocument: 'No linked document', recordDetails: 'Record details', createRecord: 'Create record',
    deleteRecord: 'Delete record', deleteField: 'Delete field', deleteView: 'Delete view', deleteDatabase: 'Delete database',
    dangerCannotUndo: 'This removes related data and cannot be undone. It can be recovered from a Markdown backup.',
    confirm: 'Confirm', selected: (count: number) => `${count} selected`, clearSelection: 'Clear selection',
    filterField: 'Filter field', operator: 'Condition', value: 'Value', addFilter: 'Add filter', clearFilters: 'Clear filters',
    contains: 'Contains', notContains: 'Does not contain', equals: 'Equals', notEquals: 'Does not equal', isEmpty: 'Is empty', isNotEmpty: 'Is not empty', before: 'Before', after: 'After', checked: 'Checked', unchecked: 'Unchecked', containsAny: 'Contains any', containsAll: 'Contains all',
    ascending: 'Ascending', descending: 'Descending', noGrouping: 'No grouping', layout: 'Layout',
    editRecord: 'Edit record', openDocument: 'Open document', requiredTitle: 'A record title is required', loading: 'Loading database…',
    customDescription: 'Organize projects, research, and lightweight business records.',
    catalogDescription: 'All workspace documents, organized with structured fields.',
    createAndContinue: 'Create and add another', databaseSettings: 'Database settings', viewMenu: 'View menu',
    saveAsView: 'Save as new view', resetView: 'Reset changes', failed: 'Something went wrong. Please try again.'
  }
}

export type DatabaseWorkspaceText = ReturnType<typeof getDatabaseWorkspaceText>
