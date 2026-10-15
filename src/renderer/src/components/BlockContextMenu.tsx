import type { DocumentBlock } from '@shared/contracts'
import { useViewportMenuPosition } from '../hooks/useViewportMenuPosition'
import { usePopupKeyboard } from '../hooks/usePopupKeyboard'
import { BLOCK_CONVERSION_TYPES } from '../utils/blockConversionTypes'

export type BlockContextMenuProps = {
  x: number
  y: number
  blockType: string
  onTypeChange: (type: DocumentBlock['type']) => void
  onDuplicate: () => void
  onDelete: () => void
  onClose: () => void
  typeOptions: Record<string, string>
  ui: any
  isZh: boolean
  canOpen?: () => boolean
  canReturnFocus?: () => boolean
  selectedBlockCount?: number
  disabled?: boolean
  disabledReason?: string | null
  onCopyBlockLinks?: () => void
  onMoveToDocument?: () => void
  moveDisabledReason?: string | null
  onOpenAiEdit?: () => void
  currentHighlight?: string
  onHighlightChange?: (color: string | undefined) => void
  onWrapInColumns?: () => void
}

export function BlockContextMenu({ x, y, blockType, onTypeChange, onDuplicate, onDelete, onClose,
  typeOptions, isZh, canOpen, canReturnFocus, selectedBlockCount = 1, disabled = false, disabledReason,
  onCopyBlockLinks, onMoveToDocument, moveDisabledReason, onOpenAiEdit, currentHighlight, onHighlightChange, onWrapInColumns }: BlockContextMenuProps) {
  const { menuRef, menuStyle } = useViewportMenuPosition<HTMLDivElement>(x, y)
  usePopupKeyboard(menuRef, onClose, canOpen, canReturnFocus)
  const run = (action: () => void) => { if (!disabled) { action(); onClose() } }
  const highlightColors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray']
  const highlightNames = isZh ? ['红色', '橙色', '黄色', '绿色', '蓝色', '紫色', '灰色'] : ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Gray']

  return <>
    <div className="context-menu-overlay" onClick={onClose} onContextMenu={event => event.preventDefault()} />
    <div className="block-context-menu" role="dialog" aria-modal="true" data-block-shortcuts
      aria-label={isZh ? '内容块操作' : 'Block actions'} tabIndex={-1} ref={menuRef}
      onContextMenu={event => event.preventDefault()} style={menuStyle}>
      <p className="context-menu-label">{isZh ? `已选 ${selectedBlockCount} 个内容块` : `${selectedBlockCount} block${selectedBlockCount === 1 ? '' : 's'} selected`}</p>
      {disabledReason ? <p className="context-menu-label" role="status">{disabledReason}</p> : null}
      <div className="context-menu-section">
        <p className="context-menu-label">{isZh ? '转换为' : 'Convert to'}</p>
        <div className="context-menu-group">
          {BLOCK_CONVERSION_TYPES.map(type => <button key={type} type="button" disabled={disabled}
            className={`context-menu-item${blockType === type ? ' context-menu-item-active' : ''}`}
            aria-pressed={blockType === type} onClick={() => run(() => onTypeChange(type))}>
            {typeOptions[type] ?? type}
          </button>)}
        </div>
      </div>
      {onHighlightChange ? <div className="context-menu-section">
        <p className="context-menu-label">{isZh ? '块高亮' : 'Block highlight'}</p>
        <div className="block-highlight-picker" role="group" aria-label={isZh ? '块高亮' : 'Block highlight'}>
          <button type="button" disabled={disabled} className={`highlight-swatch${!currentHighlight ? ' highlight-swatch-active' : ''}`}
            aria-label={isZh ? '无高亮' : 'No highlight'} onClick={() => run(() => onHighlightChange(undefined))} />
          {highlightColors.map((color, index) => <button key={color} type="button" disabled={disabled}
            className={`highlight-swatch${currentHighlight === color ? ' highlight-swatch-active' : ''}`} aria-label={highlightNames[index]}
            style={{ background: `var(--highlight-${color})` }} onClick={() => run(() => onHighlightChange(color))} />)}
        </div>
      </div> : null}
      <div className="context-menu-section context-menu-group">
        {onWrapInColumns ? <button className="context-menu-item" disabled={disabled} onClick={() => run(onWrapInColumns)} type="button">
          {isZh ? '放入两列分栏' : 'Wrap in two columns'}
        </button> : null}
        {onCopyBlockLinks ? <button className="context-menu-item" disabled={disabled} onClick={() => run(onCopyBlockLinks)} type="button">
          {isZh ? '复制块链接' : 'Copy block links'}
        </button> : null}
        {onMoveToDocument ? <button className="context-menu-item" disabled={disabled || Boolean(moveDisabledReason)} title={moveDisabledReason ?? undefined} onClick={() => { if (!moveDisabledReason) run(onMoveToDocument) }} type="button">
          {isZh ? '移动到文档…' : 'Move to document…'}
        </button> : null}
        {onOpenAiEdit ? <button className="context-menu-item" disabled={disabled} onClick={() => run(onOpenAiEdit)} type="button">{isZh ? 'AI 编辑' : 'AI edit'}</button> : null}
        <button className="context-menu-item" disabled={disabled} onClick={() => run(onDuplicate)} type="button">{isZh ? '复制' : 'Duplicate'}</button>
        <button className="context-menu-item context-menu-item-danger" disabled={disabled} onClick={() => run(onDelete)} type="button">{isZh ? '删除' : 'Delete'}</button>
      </div>
    </div>
  </>
}
