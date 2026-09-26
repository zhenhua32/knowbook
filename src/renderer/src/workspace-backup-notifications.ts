import type { AppNotificationInput } from '@shared/app-notification'
import type { MarkdownImportReport } from '@shared/contracts'
import type { UiText } from './i18n'
import { runNotificationTask } from './notification-task'

export interface WorkspaceBackupContext {
  flushPendingDocumentChanges: () => Promise<boolean>
  refreshWorkspaceAfterStorageMutation: () => Promise<void>
  reloadDatabaseDomain: () => void
  ui: UiText
}

export async function runWorkspaceBackup(restore: boolean, latest: { current: WorkspaceBackupContext },
  setImportReport: (report: MarkdownImportReport | null) => void, setImportReportOpen: (open: boolean) => void): Promise<void> {
  const isZh = latest.current.ui.language === 'zh-CN'
  const title = restore ? (isZh ? '导入备份' : 'Import backup') : (isZh ? '导出备份' : 'Export backup')
  await runNotificationTask({ key: 'workspace-backup', title, isZh, work: async (update) => {
    if (!await latest.current.flushPendingDocumentChanges()) return null
    const ui = latest.current.ui
    let message: string
    let actions: AppNotificationInput['actions']
    if (restore) {
      const result = await window.knowbook.restoreBackupFromFolder()
      if (!result) return null
      setImportReport(result.importReport ?? null)
      setImportReportOpen(Boolean(result.importReport))
      if (result.importReport) {
        const report = result.importReport
        actions = [{ label: isZh ? '查看导入报告' : 'View import report', closeNotificationCenter: true, run: () => {
          setImportReport(report)
          setImportReportOpen(true)
        } }]
      }
      const restoredMessage = ui.backupRestored(
        result.restored,
        result.created,
        result.updated,
        result.deleted,
        result.conflictsResolved,
        result.placeholdersCreated,
        result.at
      )
      message = result.safetyBackupPath
        ? `${restoredMessage} ${ui.backupSafetyCopyCreated(result.safetyBackupPath)}`
        : restoredMessage
    } else {
      const result = await window.knowbook.triggerBackup()
      message = ui.backupExported(result.exported, result.at)
    }
    const refresh = async () => {
      await latest.current.refreshWorkspaceAfterStorageMutation()
      if (restore) latest.current.reloadDatabaseDomain()
    }
    const completed: AppNotificationInput = { title: isZh ? `${title}完成` : `${title} completed`, message, level: 'success', actions }
    try { await refresh() } catch {
      // The storage operation already succeeded. Retrying must only refresh the UI.
      return { title: isZh ? `${title}已完成` : `${title} completed`, level: 'warning',
        message: `${message}\n${isZh ? '界面刷新失败，请刷新后查看。' : 'The view could not be refreshed. Refresh to see the result.'}`,
        actions: [{ label: isZh ? '刷新' : 'Refresh', run: async () => { await refresh(); update(completed) } }] }
    }
    return completed
  } })
}
