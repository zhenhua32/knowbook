import type { DocumentBlockDraft, DocumentTemplate } from './contracts'

/** Replace each token once, so a title containing a token cannot recurse. */
export function expandDocumentTemplateVariables(value: string, title: string, date: string): string {
  return value.replace(/\{\{(date|title)\}\}/g, (_match, variable: string) => variable === 'date' ? date : title)
}

export function documentTemplateDate(now = new Date()): string {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
}

export function builtInDocumentTemplates(language: 'zh-CN' | 'en-US' = 'zh-CN'): DocumentTemplate[] {
  const zh = language === 'zh-CN'
  const definitions = [
    {
      id: 'builtin:meeting', name: zh ? '会议纪要' : 'Meeting notes',
      description: zh ? '记录议题、决策与后续行动。' : 'Capture the agenda, decisions and follow-up actions.',
      sections: zh ? ['参会人员', '议题', '讨论与决策', '后续行动'] : ['Attendees', 'Agenda', 'Discussion and decisions', 'Follow-up actions']
    },
    {
      id: 'builtin:reading', name: zh ? '读书笔记' : 'Reading notes',
      description: zh ? '整理核心观点、摘录与思考。' : 'Organize key ideas, quotations and reflections.',
      sections: zh ? ['书籍信息', '核心观点', '摘录', '我的思考'] : ['Book details', 'Key ideas', 'Quotations', 'My reflections']
    },
    {
      id: 'builtin:review', name: zh ? '项目复盘' : 'Project retrospective',
      description: zh ? '回顾目标、结果、经验和改进计划。' : 'Review goals, outcomes, lessons and next steps.',
      sections: zh ? ['目标与结果', '做得好的地方', '问题与原因', '改进计划'] : ['Goals and outcomes', 'What worked', 'Problems and causes', 'Improvement plan']
    }
  ]
  return definitions.map((definition) => {
    const blocks: DocumentBlockDraft[] = [
      { id: `${definition.id}:title`, type: 'heading-1', content: '{{title}}', checked: false, depth: 0 },
      { id: `${definition.id}:date`, type: 'paragraph', content: `${zh ? '日期' : 'Date'}：{{date}}`, checked: false, depth: 0 }
    ]
    for (const [index, section] of definition.sections.entries()) {
      blocks.push({ id: `${definition.id}:heading:${index}`, type: 'heading-2', content: section, checked: false, depth: 0 })
      blocks.push({ id: `${definition.id}:body:${index}`, type: index === definition.sections.length - 1 ? 'todo' : 'paragraph', content: '', checked: false, depth: 0 })
    }
    return { id: definition.id, name: definition.name, description: definition.description,
      title: `${definition.name} {{date}}`, summary: '', blocks, builtIn: true }
  })
}
