import type { UiText } from '../i18n'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useViewportMenuPosition } from '../hooks/useViewportMenuPosition'

type MoveOption = {
  id: string
  label: string
}

type DocumentHeaderActionMenuProps = {
  x: number
  y: number
  ui: UiText
  isZh: boolean
  canUndo: boolean
  canRedo: boolean
  documentsAuxPanelOpen: boolean
  documentsWideMode: boolean
  moveTargetId: string
  moveOptions: MoveOption[]
  onClose: () => void
  onCopyMarkdown: () => void
  onSaveMarkdown: () => void
  onCheckLinks?: () => void
  onEditMarkdownSource?: () => void
  onUndo: () => void
  onRedo: () => void
  onMoveTargetChange: (value: string) => void
  onMove: () => void
  onToggleAuxPanel: () => void
  onToggleWideMode: () => void
  onDelete: () => void
  pluginMenuContent?: ReactNode
}

export function DocumentHeaderActionMenu(props: DocumentHeaderActionMenuProps) {
  const {
    x,
    y,
    ui,
    isZh,
    canUndo,
    canRedo,
    documentsAuxPanelOpen,
    documentsWideMode,
    moveTargetId,
    moveOptions,
    onClose,
    onCopyMarkdown,
    onSaveMarkdown,
    onCheckLinks,
    onEditMarkdownSource,
    onUndo,
    onRedo,
    onMoveTargetChange,
    onMove,
    onToggleAuxPanel,
    onToggleWideMode,
    onDelete,
    pluginMenuContent
  } = props

  const auxLabel = documentsAuxPanelOpen
    ? (isZh ? '收起辅助区' : 'Hide auxiliary')
    : (isZh ? '展开辅助区' : 'Show auxiliary')
  const wideModeLabel = documentsWideMode ? ui.wideModeDisable : ui.wideModeEnable

  const runAndClose = (action: () => void) => {
    onClose()
    action()
  }

  const { menuRef, menuStyle } = useViewportMenuPosition<HTMLDivElement>(x, y)

  return createPortal((
    <>
      <div
        className="context-menu-overlay"
        onClick={onClose}
        onContextMenu={(event) => event.preventDefault()}
      />

      <div
        className="block-context-menu document-header-action-menu"
        ref={menuRef}
        onContextMenu={(event) => event.preventDefault()}
        style={menuStyle}
      >
        <div className="context-menu-section">
          <div className="context-menu-group">
            {onEditMarkdownSource && <button className="context-menu-item" onClick={() => runAndClose(onEditMarkdownSource)} type="button">
              {isZh ? '编辑 Markdown 源码' : 'Edit Markdown source'}
            </button>}
            <button className="context-menu-item" onClick={() => runAndClose(onCopyMarkdown)} type="button">
              {ui.copyMarkdown}
            </button>
            <button className="context-menu-item" onClick={() => runAndClose(onSaveMarkdown)} type="button">
              {ui.saveMarkdown}
            </button>
            {onCheckLinks && <button className="context-menu-item" onClick={() => runAndClose(onCheckLinks)} type="button">
              {isZh ? '检查链接' : 'Check links'}
            </button>}
            <button
              className="context-menu-item"
              disabled={!canUndo}
              onClick={() => runAndClose(onUndo)}
              title={isZh ? '撤销 (Ctrl+Z)' : 'Undo (Ctrl+Z)'}
              type="button"
            >
              {isZh ? '撤销' : 'Undo'}
            </button>
            <button
              className="context-menu-item"
              disabled={!canRedo}
              onClick={() => runAndClose(onRedo)}
              title={isZh ? '重做 (Ctrl+Y)' : 'Redo (Ctrl+Y)'}
              type="button"
            >
              {isZh ? '重做' : 'Redo'}
            </button>
            <button className="context-menu-item" onClick={() => runAndClose(onToggleAuxPanel)} type="button">
              {auxLabel}
            </button>
            <button className="context-menu-item" onClick={() => runAndClose(onToggleWideMode)} type="button">
              {wideModeLabel}
            </button>
          </div>
        </div>

        <div onClick={(event) => {
          if ((event.target as Element).closest('button.context-menu-item:not(:disabled)')) onClose()
        }}>
          {pluginMenuContent}
        </div>

        <div className="context-menu-section">
          <p className="context-menu-label">{ui.common.move}</p>
          <div className="document-header-menu-move">
            <select
              className="editor-select compact-select document-header-menu-select"
              onChange={(event) => onMoveTargetChange(event.target.value)}
              value={moveTargetId}
            >
              <option value="">{ui.moveToPlaceholder}</option>
              <option value="__root__">{ui.rootOption}</option>
              {moveOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              className="secondary-button document-header-menu-move-button"
              disabled={!moveTargetId}
              onClick={() => runAndClose(onMove)}
              type="button"
            >
              {ui.common.move}
            </button>
          </div>
        </div>

        <div className="context-menu-section">
          <button
            className="context-menu-item context-menu-item-danger"
            onClick={() => runAndClose(onDelete)}
            type="button"
          >
            {ui.common.delete}
          </button>
        </div>
      </div>
    </>
  ), document.body)
}
