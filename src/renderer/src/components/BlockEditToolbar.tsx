import type { DocumentBlockDraft } from '@shared/contracts'

const BLOCK_HIGHLIGHT_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const

type BlockHighlightColor = typeof BLOCK_HIGHLIGHT_COLORS[number]

type BlockEditToolbarProps = {
  block: DocumentBlockDraft
  index: number
  isActive: boolean
  onTypeChange: (type: string) => void
  onHighlightChange?: (highlight: BlockHighlightColor | undefined) => void
  onDuplicate: () => void
  onDelete: () => void
  typeOptions: Record<string, string>
  ui: any
  isZh: boolean
}

export function BlockEditToolbar(props: BlockEditToolbarProps) {
  const { block, index, isActive, onTypeChange, onHighlightChange, onDuplicate, onDelete, typeOptions, ui, isZh } = props

  if (!isActive) {
    return null
  }

  // 获取当前块类型的标签
  const currentTypeLabel = typeOptions[block.type] || block.type
  const highlightTitle = isZh ? '块高亮' : 'Block highlight'
  const highlightLabels: Record<BlockHighlightColor, string> = isZh
    ? {
        red: '红色',
        orange: '橙色',
        yellow: '黄色',
        green: '绿色',
        blue: '蓝色',
        purple: '紫色',
        gray: '灰色'
      }
    : {
        red: 'Red',
        orange: 'Orange',
        yellow: 'Yellow',
        green: 'Green',
        blue: 'Blue',
        purple: 'Purple',
        gray: 'Gray'
      }

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

      {onHighlightChange ? (
        <div className="block-highlight-picker" aria-label={highlightTitle} title={highlightTitle}>
          <button
            aria-label={ui.noHighlight}
            className={`highlight-swatch${!block.highlight ? ' highlight-swatch-active' : ''}`}
            onClick={() => onHighlightChange(undefined)}
            title={ui.noHighlight}
            type="button"
          />
          {BLOCK_HIGHLIGHT_COLORS.map((color) => (
            <button
              aria-label={highlightLabels[color]}
              className={`highlight-swatch${block.highlight === color ? ' highlight-swatch-active' : ''}`}
              key={color}
              onClick={() => onHighlightChange(color)}
              style={{ background: `var(--highlight-${color})` }}
              title={highlightLabels[color]}
              type="button"
            />
          ))}
        </div>
      ) : null}

      {/* 操作按钮 */}
      <button
        className="block-toolbar-btn block-toolbar-duplicate"
        onClick={onDuplicate}
        title={isZh ? '复制块' : 'Duplicate block'}
        type="button"
      >
        📋
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
