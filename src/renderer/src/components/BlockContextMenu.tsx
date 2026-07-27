import type { DocumentBlock } from '@shared/contracts'
import { useViewportMenuPosition } from '../hooks/useViewportMenuPosition'

type BlockContextMenuProps = {
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
}

export function BlockContextMenu(props: BlockContextMenuProps) {
  const { x, y, blockType, onTypeChange, onDuplicate, onDelete, onClose, typeOptions, ui, isZh } = props
  const { menuRef, menuStyle } = useViewportMenuPosition<HTMLDivElement>(x, y)

  return (
    <>
      {/* 背景点击关闭 */}
      <div
        className="context-menu-overlay"
        onClick={onClose}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* 菜单面板 */}
      <div
        className="block-context-menu"
        ref={menuRef}
        onContextMenu={(e) => e.preventDefault()}
        style={menuStyle}
      >
        {/* 转换类型子菜单 */}
        <div className="context-menu-section">
          <p className="context-menu-label">{isZh ? '转换为' : 'Convert to'}</p>
          <div className="context-menu-group">
             {[
               { type: 'paragraph', label: typeOptions.paragraph },
               { type: 'heading-1', label: typeOptions['heading-1'] },
               { type: 'heading-2', label: typeOptions['heading-2'] },
               { type: 'todo', label: typeOptions.todo },
               { type: 'code', label: typeOptions.code },
               { type: 'math', label: typeOptions.math },
               { type: 'quote', label: typeOptions.quote },
               { type: 'bulleted-list', label: typeOptions['bulleted-list'] },
               { type: 'numbered-list', label: typeOptions['numbered-list'] },
               { type: 'table', label: typeOptions.table },
               { type: 'divider', label: typeOptions.divider }
             ].map((option) => (
              <button
                key={option.type}
                className={`context-menu-item${blockType === option.type ? ' context-menu-item-active' : ''}`}
                onClick={() => {
                  onTypeChange(option.type as DocumentBlock['type'])
                  onClose()
                }}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* 操作菜单 */}
        <div className="context-menu-section">
          <button className="context-menu-item" onClick={() => { onDuplicate(); onClose() }} type="button">
            {isZh ? '复制' : 'Duplicate'}
          </button>
          <button
            className="context-menu-item context-menu-item-danger"
            onClick={() => { onDelete(); onClose() }}
            type="button"
          >
            {isZh ? '删除' : 'Delete'}
          </button>
        </div>
      </div>
    </>
  )
}
