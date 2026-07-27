import type { UiText } from '../i18n'
import { useViewportMenuPosition } from '../hooks/useViewportMenuPosition'

type DocumentTreeContextMenuProps = {
  x: number
  y: number
  ui: UiText
  isZh: boolean
  documentTitle: string
  isPinned: boolean
  canSave: boolean
  isSaving: boolean
  onTogglePin: () => void
  onCopyMarkdown: () => void
  onSaveMarkdown: () => void
  onAddChild: () => void
  onSave: () => void
  onDelete: () => void
  onClose: () => void
}

export function DocumentTreeContextMenu(props: DocumentTreeContextMenuProps) {
  const {
    x,
    y,
    ui,
    isZh,
    documentTitle,
    isPinned,
    canSave,
    isSaving,
    onTogglePin,
    onCopyMarkdown,
    onSaveMarkdown,
    onAddChild,
    onSave,
    onDelete,
    onClose
  } = props

  const runAndClose = (action: () => void) => {
    onClose()
    action()
  }

  const { menuRef, menuStyle } = useViewportMenuPosition<HTMLDivElement>(x, y)

  return (
    <>
      <div
        className="context-menu-overlay"
        onClick={onClose}
        onContextMenu={(event) => event.preventDefault()}
      />

      <div
        className="block-context-menu document-tree-context-menu"
        ref={menuRef}
        onContextMenu={(event) => event.preventDefault()}
        style={menuStyle}
      >
        <div className="context-menu-section">
          <p className="document-tree-context-title" title={documentTitle}>{documentTitle}</p>
        </div>

        <div className="context-menu-section">
          <div className="context-menu-group">
            <button className="context-menu-item" onClick={() => runAndClose(onTogglePin)} type="button">
              {isPinned ? ui.unpinDocument : ui.pinDocument}
            </button>
            <button className="context-menu-item" onClick={() => runAndClose(onCopyMarkdown)} type="button">
              {ui.copyMarkdown}
            </button>
            <button className="context-menu-item" onClick={() => runAndClose(onSaveMarkdown)} type="button">
              {ui.saveMarkdown}
            </button>
            <button className="context-menu-item" onClick={() => runAndClose(onAddChild)} type="button">
              {ui.addChild}
            </button>
            <button className="context-menu-item" disabled={!canSave} onClick={() => runAndClose(onSave)} type="button">
              {isSaving ? ui.common.saving : ui.common.save}
            </button>
            <button className="context-menu-item context-menu-item-danger" onClick={() => runAndClose(onDelete)} type="button">
              {ui.common.delete}
            </button>
          </div>
        </div>

        <div className="context-menu-section">
          <p className="context-menu-label">{isZh ? '提示' : 'Hint'}</p>
          <p className="document-tree-context-hint">
            {isZh ? '“保存”只会保存当前已打开文档的编辑草稿。' : 'Save only applies to the currently opened document draft.'}
          </p>
        </div>
      </div>
    </>
  )
}
