import type { WorkspaceEventRecord } from '@shared/contracts'
import type { UiLanguage } from '../i18n'

export type WorkspaceActivityIcon = 'document' | 'summary' | 'move' | 'delete' | 'ai' | 'plugin'

export interface WorkspaceEventPresentation {
  title: string
  description: string
  path: string
  documentTitle?: string
  icon: WorkspaceActivityIcon
}

function meaningfulText(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** Host events use versioned facts; plugin text and legacy descriptions are never parsed. */
export function formatWorkspaceEvent(event: WorkspaceEventRecord, locale: UiLanguage): WorkspaceEventPresentation {
  const isZh = locale === 'zh-CN'
  const details = event.details?.schemaVersion === 1 ? event.details : undefined
  const documentTitle = meaningfulText(details?.documentTitle)
  const path = meaningfulText(details?.path)
  const previousPath = meaningfulText(details?.previousPath)
  const count = positiveCount(details?.affectedDocumentCount)
  const result = (title: string, icon: WorkspaceActivityIcon, description = '', location = path
    ? `${isZh ? '位置：' : 'Location: '}${path}` : ''): WorkspaceEventPresentation => ({
    title, description, path: location, documentTitle, icon
  })
  const target = documentTitle ? (isZh ? `「${documentTitle}」` : `“${documentTitle}”`) : ''

  switch (event.type) {
    case 'document.created':
      return result(target ? (isZh ? `已创建${target}` : `Created ${target}`) : (isZh ? '文档已创建' : 'Document created'), 'document')
    case 'document.updated':
      return result(target ? (isZh ? `已保存${target}` : `Saved ${target}`) : (isZh ? '文档已保存' : 'Document saved'), 'document',
        details?.pathChanged && count > 0
          ? (isZh ? `已更新 ${count} 个子文档的路径。` : `Updated paths for ${count} ${count === 1 ? 'nested document' : 'nested documents'}.`)
          : '')
    case 'document.summary.generated':
      return result(target ? (isZh ? `已生成${target}的 AI 摘要` : `Generated an AI summary for ${target}`)
        : (isZh ? 'AI 摘要已生成' : 'AI summary generated'), 'summary')
    case 'document.moved':
      return result(target ? (isZh ? `已移动${target}` : `Moved ${target}`) : (isZh ? '文档已移动' : 'Document moved'), 'move',
        count > 0 ? (isZh ? `连同 ${count} 个子文档一起移动。`
          : `Moved ${count} ${count === 1 ? 'nested document' : 'nested documents'} with it.`) : '',
        path ? `${isZh ? '位置：' : 'Location: '}${previousPath ? `${previousPath} → ` : ''}${path}` : '')
    case 'document.deleted':
      return result(target ? (isZh ? `已删除${target}` : `Deleted ${target}`) : (isZh ? '文档已删除' : 'Document deleted'), 'delete',
        count > 0 ? (isZh ? `已保留并调整 ${count} 个子文档的位置。`
          : `Kept and relocated ${count} ${count === 1 ? 'nested document' : 'nested documents'}.`) : '',
        path ? `${isZh ? '原位置：' : 'Previous location: '}${path}` : '')
    case 'ai.config.updated': {
      const model = meaningfulText(details?.model)
      const status = typeof details?.aiEnabled === 'boolean'
        ? (isZh ? (details.aiEnabled ? 'AI 已启用' : 'AI 已关闭') : (details.aiEnabled ? 'AI enabled' : 'AI disabled'))
        : ''
      return result(isZh ? 'AI 设置已更新' : 'AI settings updated', 'ai',
        [status, model ? `${isZh ? '模型：' : 'Model: '}${model}` : ''].filter(Boolean).join(' · '), '')
    }
    default:
      return { title: event.title, description: event.description, path: '', icon: 'plugin' }
  }
}

export interface WorkspaceEventTime {
  text: string
  title: string
  dateTime?: string
}

export function formatWorkspaceEventTime(createdAt: string, locale: UiLanguage, now = new Date()): WorkspaceEventTime {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.getTime())) {
    const text = locale === 'zh-CN' ? '时间未知' : 'Time unavailable'
    return { text, title: text }
  }
  const dayKey = (value: Date) => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const day = dayKey(date) === dayKey(now) ? (locale === 'zh-CN' ? '今天' : 'Today')
    : dayKey(date) === dayKey(yesterday) ? (locale === 'zh-CN' ? '昨天' : 'Yesterday')
      : date.toLocaleDateString(locale, {
        month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {})
      })
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  return {
    text: `${day} ${time}`,
    title: date.toLocaleString(locale, { dateStyle: 'full', timeStyle: 'short' }),
    dateTime: date.toISOString()
  }
}
