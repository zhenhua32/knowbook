import type { UiText } from '../i18n'

type MoveOption = {
  id: string
  label: string
}

type DocumentPreviewHeaderProps = {
  ui: UiText
  isZh: boolean
  selectedDocumentTitle: string | null
  selectedDocumentId: string | null
  isPinned: boolean
  onTogglePin: () => void
  autoSaveFlash: boolean
  mdCopyFlash: boolean
  onCopyMarkdown: () => void
  onSaveMarkdown: () => void
  onAddChild: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  isSaving: boolean
  onSave: () => void
  onDelete: () => void
  moveTargetId: string
  moveOptions: MoveOption[]
  onMoveTargetChange: (value: string) => void
  onMove: () => void
  documentsAuxPanelOpen: boolean
  onToggleAuxPanel: () => void
  detailLoading: boolean
}

export function DocumentPreviewHeader(props: DocumentPreviewHeaderProps) {
  const {
    ui,
    isZh,
    selectedDocumentTitle,
    selectedDocumentId,
    isPinned,
    onTogglePin,
    autoSaveFlash,
    mdCopyFlash,
    onCopyMarkdown,
    onSaveMarkdown,
    onAddChild,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    isSaving,
    onSave,
    onDelete,
    moveTargetId,
    moveOptions,
    onMoveTargetChange,
    onMove,
    documentsAuxPanelOpen,
    onToggleAuxPanel,
    detailLoading
  } = props

  const hasDocument = Boolean(selectedDocumentId)

  return (
    <div className="panel-head">
      <div>
        <p className="panel-label">{ui.documentPreviewLabel}</p>
        <h3>{selectedDocumentTitle ?? ui.selectDocument}</h3>
      </div>
      <div className="toolbar-inline">
        {hasDocument ? (
          <button
            className={`secondary-button pin-button${isPinned ? ' pin-button-active' : ''}`}
            onClick={onTogglePin}
            type="button"
            title={isPinned ? ui.unpinDocument : ui.pinDocument}
          >
            {isPinned ? '★' : '☆'}
          </button>
        ) : null}
        {autoSaveFlash ? <span className="autosave-flash">{ui.autoSaved}</span> : null}
        {mdCopyFlash ? <span className="autosave-flash">{ui.markdownCopied}</span> : null}
        {hasDocument ? (
          <button className="secondary-button" onClick={onCopyMarkdown} type="button" title={ui.copyMarkdown}>
            {ui.copyMarkdown}
          </button>
        ) : null}
        {hasDocument ? (
          <button className="secondary-button" onClick={onSaveMarkdown} type="button" title={ui.saveMarkdown}>
            {ui.saveMarkdown}
          </button>
        ) : null}
        {hasDocument ? (
          <button className="secondary-button" onClick={onAddChild} type="button">
            {ui.addChild}
          </button>
        ) : null}
        {hasDocument ? (
          <>
            <button className="secondary-button" disabled={!canUndo} onClick={onUndo} type="button" title="撤销 (Ctrl+Z)">↩</button>
            <button className="secondary-button" disabled={!canRedo} onClick={onRedo} type="button" title="重做 (Ctrl+Y)">↪</button>
            <button className="secondary-button" disabled={isSaving} onClick={onSave} type="button">
              {isSaving ? ui.common.saving : ui.common.save}
            </button>
          </>
        ) : null}
        {hasDocument ? (
          <button className="danger-button" onClick={onDelete} type="button">
            {ui.common.delete}
          </button>
        ) : null}
        {hasDocument ? (
          <>
            <select className="editor-select compact-select" onChange={(event) => onMoveTargetChange(event.target.value)} value={moveTargetId}>
              <option value="">{ui.moveToPlaceholder}</option>
              <option value="__root__">{ui.rootOption}</option>
              {moveOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <button className="secondary-button" disabled={!moveTargetId} onClick={onMove} type="button">
              {ui.common.move}
            </button>
            <button className="secondary-button" onClick={onToggleAuxPanel} type="button">
              {documentsAuxPanelOpen
                ? (isZh ? '收起辅助区' : 'Hide auxiliary')
                : (isZh ? '展开辅助区' : 'Show auxiliary')}
            </button>
          </>
        ) : null}
        {detailLoading ? <span className="pill">{ui.common.loading}</span> : null}
      </div>
    </div>
  )
}
