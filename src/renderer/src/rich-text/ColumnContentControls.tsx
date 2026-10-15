import type { DocumentBlockDraft } from '@shared/contracts'
import { moveBlockToColumn } from '../utils/columnOperations'

export default function ColumnContentControls({ blocks, blockId, isZh, onApplyBlocks }: {
  blocks: DocumentBlockDraft[]; blockId: string; isZh: boolean; onApplyBlocks: (next: DocumentBlockDraft[]) => void
}) {
  const current = blocks.find(block => block.id === blockId)
  if (!current || ['columns', 'column', 'frontmatter'].includes(current.type)) return null
  const columns = blocks.filter(block => block.type === 'column')
  const choices = columns.flatMap((column, index) => {
    if (column.id === current.parentBlockId || !moveBlockToColumn(blocks, blockId, column.id!)) return []
    return [{ id: column.id!, label: isZh ? `第 ${index + 1} 列` : `Column ${index + 1}` }]
  })
  if (!choices.length) return null
  return <label className="column-content-move"><span>{isZh ? '移动到列' : 'Move to column'}</span>
    <select aria-label={isZh ? '移动到列' : 'Move to column'} value="" onChange={event => {
      const next = moveBlockToColumn(blocks, blockId, event.target.value)
      if (next) onApplyBlocks(next)
    }}><option value="">{isZh ? '选择目标列' : 'Choose target column'}</option>
      {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
    </select>
  </label>
}
