import type { DocumentBlockAiEditMode } from '@shared/contracts'
import type { UiText } from '../i18n'

type DocumentSelectionAiPanelProps = {
  aiEnabled: boolean
  canApplyPreview: boolean
  canGeneratePreview: boolean
  customInstruction: string
  hasApiKey: boolean
  isPreviewStale: boolean
  mode: DocumentBlockAiEditMode
  onApplyPreview: () => void
  onClearPreview: () => void
  onCustomInstructionChange: (value: string) => void
  onGeneratePreview: () => void
  onModeChange: (mode: DocumentBlockAiEditMode) => void
  previewBusy: boolean
  previewError: string
  previewText: string
  selectedBlockActionCount: number
  selectedBlockCount: number
  ui: UiText
}

const MODE_ORDER: DocumentBlockAiEditMode[] = ['summarize', 'rewrite', 'table', 'custom']

export function DocumentSelectionAiPanel({
  aiEnabled,
  canApplyPreview,
  canGeneratePreview,
  customInstruction,
  hasApiKey,
  isPreviewStale,
  mode,
  onApplyPreview,
  onClearPreview,
  onCustomInstructionChange,
  onGeneratePreview,
  onModeChange,
  previewBusy,
  previewError,
  previewText,
  selectedBlockActionCount,
  selectedBlockCount,
  ui
}: DocumentSelectionAiPanelProps) {
  const modeLabels: Record<DocumentBlockAiEditMode, string> = {
    summarize: ui.aiSelectionModeSummarize,
    rewrite: ui.aiSelectionModeRewrite,
    table: ui.aiSelectionModeTable,
    custom: ui.aiSelectionModeCustom
  }

  const statusText = !aiEnabled
    ? ui.aiSelectionDisabledHint
    : !hasApiKey
      ? ui.aiSelectionMissingApiKeyHint
      : isPreviewStale
        ? ui.aiSelectionPreviewStale
        : ui.aiSelectionHint(selectedBlockActionCount)

  return (
    <div className="preview-section">
      <p className="panel-label">{ui.aiSelectionLabel}</p>
      <div className="ai-panel ai-selection-panel">
        <div className="ai-selection-summary">
          <strong>{ui.aiSelectionSummary(selectedBlockCount, selectedBlockActionCount)}</strong>
        </div>

        <div className="toolbar-inline ai-actions ai-selection-mode-grid">
          {MODE_ORDER.map((candidateMode) => (
            <button
              className={candidateMode === mode ? 'primary-button' : 'secondary-button'}
              key={candidateMode}
              onClick={() => onModeChange(candidateMode)}
              type="button"
            >
              {modeLabels[candidateMode]}
            </button>
          ))}
        </div>

        {mode === 'custom' ? (
          <textarea
            className="editor-textarea"
            onChange={(event) => onCustomInstructionChange(event.target.value)}
            placeholder={ui.aiSelectionCustomPlaceholder}
            rows={3}
            value={customInstruction}
          />
        ) : null}

        <div className="toolbar-inline ai-actions">
          <button className="secondary-button" disabled={!canGeneratePreview} onClick={onGeneratePreview} type="button">
            {previewBusy ? ui.aiSelectionGeneratingPreview : ui.aiSelectionGeneratePreview}
          </button>
          {previewText ? (
            <button className="secondary-button" onClick={onClearPreview} type="button">
              {ui.aiSelectionDiscardPreview}
            </button>
          ) : null}
        </div>

        <p className="mini-hint">{statusText}</p>
        {previewError ? <p className="mini-hint ai-context-error">{previewError}</p> : null}

        {previewText ? (
          <>
            <p className="panel-label">{ui.aiSelectionPreviewLabel}</p>
            <pre className="ai-answer ai-selection-preview">{previewText}</pre>
            <div className="toolbar-inline ai-actions">
              <button className="primary-button" disabled={!canApplyPreview} onClick={onApplyPreview} type="button">
                {ui.aiSelectionApplyPreview}
              </button>
              <button className="secondary-button" onClick={onClearPreview} type="button">
                {ui.common.cancel}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}