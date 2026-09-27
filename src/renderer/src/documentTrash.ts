import type { UiText } from './i18n'
import { confirmAction } from './confirmAction'

export function confirmDocumentTrash(title: string, ui: UiText, flush: () => Promise<boolean>, remove: () => Promise<void>) {
  const zh = ui.language === 'zh-CN'
  return confirmAction({
    title: zh ? '删除文档' : 'Delete document',
    description: ui.confirmDeleteDocument(title),
    note: zh ? '文档将移入回收站，可随时恢复。子文档会保留并上移一级。' : 'The document will move to Trash and can be restored. Child documents will be kept one level up.',
    onConfirm: async () => {
      if (!await flush()) throw new Error(zh ? '请先解决文档保存错误。' : 'Resolve the document save error first.')
      await remove()
    }
  })
}
