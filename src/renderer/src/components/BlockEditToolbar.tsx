import type { DocumentBlockDraft } from '@shared/contracts'

type BlockEditToolbarProps = {
  block: DocumentBlockDraft
  index: number
  isActive: boolean
  onTypeChange: (type: string) => void
  onDuplicate: () => void
  onDelete: () => void
  typeOptions: Record<string, string>
  ui: any
  isZh: boolean
}

export function BlockEditToolbar(props: BlockEditToolbarProps) {
  const { block, index, isActive, onTypeChange, onDuplicate, onDelete, typeOptions, ui, isZh } = props

  if (!isActive) {
    return null
  }

  // 获取当前块类型的标签
  const currentTypeLabel = typeOptions[block.type] || block.type

  return (
    <div className="block-edit-toolbar" title={ui.blockTypeChangeHint || 'Change block type'}>
      {/* 块类型选择器 */}
      <select
        className="block-type-selector"
        onChange={(e) => onTypeChange(e.target.value)}
        value={block.type}
        title={isZh ? '改变块类型' : 'Change block type'}
        style={{ display: 'inline-block', visibility: 'visible' }}
      >
        <option value="paragraph">{typeOptions.paragraph}</option>
        <option value="heading-1">{typeOptions['heading-1']}</option>
        <option value="heading-2">{typeOptions['heading-2']}</option>
        <option value="todo">{typeOptions.todo}</option>
        <option value="code">{typeOptions.code}</option>
        <option value="math">{typeOptions.math}</option>
        <option value="quote">{typeOptions.quote}</option>
        <option value="bulleted-list">{typeOptions['bulleted-list']}</option>
        <option value="numbered-list">{typeOptions['numbered-list']}</option>
        <option value="divider">{typeOptions.divider}</option>
      </select>

      {/* 操作按钮 */}
      <button
        className="block-toolbar-btn block-toolbar-duplicate"
        onClick={onDuplicate}
        title={isZh ? '复制块' : 'Duplicate block'}
        type="button"
      >
        ✕✕
      </button>

      <button
        className="block-toolbar-btn block-toolbar-delete"
        onClick={onDelete}
        title={isZh ? '删除块' : 'Delete block'}
        type="button"
      >
        🗑
      </button>
    </div>
  )
}
