import { getUiText, type UiLanguage } from '../i18n'
import type { BlockSlashCommand } from './slashCommandCatalog'

export function buildBlockSlashCommands(language: UiLanguage): BlockSlashCommand[] {
  const ui = getUiText(language)

  return [
    {
      id: 'text',
      label: ui.blockTypeOptions.paragraph,
      description: language === 'zh-CN' ? '把当前块转换为普通段落。' : 'Convert the current block into a plain paragraph.',
      keywords: ['paragraph', 'plain', 'p', 'text', '文本', '段落'],
      kind: 'type',
      type: 'paragraph'
    },
    {
      id: 'h1',
      label: ui.blockTypeOptions['heading-1'],
      description: language === 'zh-CN' ? '把当前块提升为一级标题。' : 'Promote this block to a top-level heading.',
      keywords: ['title', 'heading-1', 'header', '标题', '一级'],
      kind: 'type',
      type: 'heading-1'
    },
    {
      id: 'h2',
      label: ui.blockTypeOptions['heading-2'],
      description: language === 'zh-CN' ? '把当前块转换为二级标题。' : 'Convert this block to a section heading.',
      keywords: ['subtitle', 'heading-2', 'section', '标题', '二级'],
      kind: 'type',
      type: 'heading-2'
    },
    ...[3, 4, 5, 6].map((level): BlockSlashCommand => ({
      id: 'h' + level, label: ui.blockTypeOptions['heading-' + level],
      description: language === 'zh-CN' ? '转换为标题 ' + level : 'Convert to heading ' + level,
      keywords: ['heading', 'heading-' + level, '标题', level + '级'],
      kind: 'type', type: 'heading-' + level
    })),
    {
      id: 'todo',
      label: ui.blockTypeOptions.todo,
      description: language === 'zh-CN' ? '把当前块转换为未勾选的待办项。' : 'Turn this block into an unchecked todo item.',
      keywords: ['task', 'checkbox', 'checklist', 'todo', '待办'],
      kind: 'type',
      type: 'todo'
    },
    {
      id: 'numbered-todo', label: ui.blockTypeOptions['numbered-todo'],
      description: language === 'zh-CN' ? '转换为带编号的待办事项。' : 'Convert to a numbered task.',
      keywords: ['ordered', 'task', 'checkbox', '编号', '待办'], kind: 'type', type: 'numbered-todo'
    },
    {
      id: 'code',
      label: ui.blockTypeOptions.code,
      description: language === 'zh-CN' ? '把当前块切换成代码块。' : 'Switch this block into a code block.',
      keywords: ['snippet', 'pre', 'terminal', 'code', '代码'],
      kind: 'type',
      type: 'code'
    },
    {
      id: 'math',
      label: ui.blockTypeOptions.math,
      description: language === 'zh-CN' ? '把当前块渲染为 KaTeX 公式。' : 'Render this block as a KaTeX display equation.',
      keywords: ['latex', 'equation', 'formula', 'katex', '公式'],
      kind: 'type',
      type: 'math'
    },
    {
      id: 'quote',
      label: ui.blockTypeOptions.quote,
      description: language === 'zh-CN' ? '把当前块转换为引用块。' : 'Convert this block into a quote.',
      keywords: ['blockquote', 'cite', 'quote', '引用'],
      kind: 'type',
      type: 'quote'
    },
    {
      id: 'bullet',
      label: ui.blockTypeOptions['bulleted-list'],
      description: language === 'zh-CN' ? '把当前块转换为无序列表项。' : 'Turn this block into a bulleted list item.',
      keywords: ['unordered', 'list', 'dash', 'bullet', '列表', '无序'],
      kind: 'type',
      type: 'bulleted-list'
    },
    {
      id: 'numbered',
      label: ui.blockTypeOptions['numbered-list'],
      description: language === 'zh-CN' ? '把当前块转换为有序列表项。' : 'Turn this block into an ordered list item.',
      keywords: ['ordered', 'list', 'number', '列表', '有序'],
      kind: 'type',
      type: 'numbered-list'
    },
    {
      id: 'divider',
      label: ui.blockTypeOptions.divider,
      description: language === 'zh-CN' ? '插入一个水平分隔线块。' : 'Insert a horizontal divider block.',
      keywords: ['separator', 'rule', 'hr', 'divider', '分隔线'],
      kind: 'type',
      type: 'divider'
    },
    {
      id: 'table', label: ui.blockTypeOptions.table,
      description: language === 'zh-CN' ? '插入可直接编辑的表格。' : 'Insert a table with editable cells.',
      keywords: ['grid', 'table', '表格'], kind: 'type', type: 'table',
      templateContent: language === 'zh-CN' ? '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |' : '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |'
    },
    {
      id: 'mermaid', label: language === 'zh-CN' ? 'Mermaid 图表' : 'Mermaid diagram',
      description: language === 'zh-CN' ? '插入图表并编辑源码。' : 'Insert a diagram and edit its source.',
      keywords: ['diagram', 'flowchart', '图表', '流程图'], kind: 'type', type: 'code', templateLanguage: 'mermaid',
      templateContent: language === 'zh-CN' ? 'flowchart LR\n  A[开始] --> B[完成]' : 'flowchart LR\n  A[Start] --> B[Done]'
    },
    {
      id: 'callout', label: language === 'zh-CN' ? '提示块' : 'Callout',
      description: language === 'zh-CN' ? '创建可添加独立子块的提示块。' : 'Create a callout with independently editable children.',
      keywords: ['note', 'tip', 'warning', 'callout', '提示', '警告'], kind: 'type', type: 'callout'
    },
    {
      id: 'toggle', label: language === 'zh-CN' ? '折叠块' : 'Toggle',
      description: language === 'zh-CN' ? '创建可展开与折叠子块的标题。' : 'Create a title with expandable child blocks.',
      keywords: ['toggle', 'details', 'collapse', '折叠', '展开'], kind: 'type', type: 'toggle'
    },
    {
      id: 'columns', label: language === 'zh-CN' ? '两列分栏' : 'Two columns',
      description: language === 'zh-CN' ? '创建可调整宽度的两列布局。' : 'Create two columns with adjustable widths.',
      keywords: ['columns', 'layout', '分栏', '两列'], kind: 'action', action: 'columns'
    },
    {
      id: 'toc', label: language === 'zh-CN' ? '文内目录' : 'Table of contents',
      description: language === 'zh-CN' ? '插入自动更新的章节目录。' : 'Insert an automatically updated heading index.',
      keywords: ['outline', 'contents', '目录'], kind: 'type', type: 'paragraph', templateContent: '[TOC]'
    },
    {
      id: 'above',
      label: language === 'zh-CN' ? '在上方插入' : 'Insert Above',
      description: language === 'zh-CN' ? '在当前块上方插入一个同级块。' : 'Insert a new sibling block above the current block.',
      keywords: ['insert', 'before', 'up', '上方', '插入'],
      kind: 'action',
      action: 'insert-above'
    },
    {
      id: 'below',
      label: language === 'zh-CN' ? '在下方插入' : 'Insert Below',
      description: language === 'zh-CN' ? '在当前块下方插入一个同级块。' : 'Insert a new sibling block below the current block.',
      keywords: ['insert', 'after', 'down', '下方', '插入'],
      kind: 'action',
      action: 'insert-below'
    },
    {
      id: 'child',
      label: language === 'zh-CN' ? '插入子块' : 'Insert Child',
      description: language === 'zh-CN' ? '在当前子树下方插入一个嵌套子块。' : 'Insert a nested child block below the current subtree.',
      keywords: ['child', 'sub-block', 'nested', 'descendant', '子块', '嵌套'],
      kind: 'action',
      action: 'insert-child'
    },
    {
      id: 'up',
      label: ui.moveUp,
      description: language === 'zh-CN' ? '把当前块子树移动到上一个同级子树之前。' : 'Move the current block subtree above the previous sibling subtree.',
      keywords: ['reorder', 'before', 'raise', '上移', '移动'],
      kind: 'action',
      action: 'move-up'
    },
    {
      id: 'down',
      label: ui.moveDown,
      description: language === 'zh-CN' ? '把当前块子树移动到下一个同级子树之后。' : 'Move the current block subtree below the next sibling subtree.',
      keywords: ['reorder', 'after', 'lower', '下移', '移动'],
      kind: 'action',
      action: 'move-down'
    },
    {
      id: 'indent',
      label: language === 'zh-CN' ? '增加缩进' : 'Indent Block',
      description: language === 'zh-CN' ? '增加待办和列表块的嵌套层级。' : 'Increase nesting for todo and list blocks.',
      keywords: ['nest', 'tab', 'right', 'depth', '缩进', '嵌套'],
      kind: 'action',
      action: 'indent'
    },
    {
      id: 'outdent',
      label: language === 'zh-CN' ? '减少缩进' : 'Outdent Block',
      description: language === 'zh-CN' ? '降低待办和列表块的嵌套层级。' : 'Decrease nesting for todo and list blocks.',
      keywords: ['shift-tab', 'left', 'unnest', 'depth', '取消缩进', '提升'],
      kind: 'action',
      action: 'outdent'
    },
    {
      id: 'duplicate',
      label: ui.duplicate,
      description: language === 'zh-CN' ? '在原块下方复制一份当前块子树。' : 'Clone the current block subtree below the original.',
      keywords: ['copy', 'clone', 'repeat', '复制', '克隆'],
      kind: 'action',
      action: 'duplicate'
    },
    {
      id: 'delete',
      label: ui.common.delete,
      description: language === 'zh-CN' ? '删除当前块子树。' : 'Remove the current block subtree.',
      keywords: ['remove', 'trash', 'del', 'delete', '删除'],
      kind: 'action',
      action: 'delete'
    }
  ]
}
