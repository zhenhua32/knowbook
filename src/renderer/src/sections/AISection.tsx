import type { DocumentDetail, SemanticSearchResult } from '@shared/contracts'
import type { UiText } from '../i18n'

type AISectionProps = {
  ui: UiText
  isZh: boolean
  selectedDocument: DocumentDetail | null
  aiPromptDraft: string
  onAiPromptChange: (value: string) => void
  aiAutomationsRunning: boolean
  aiEnabled: boolean
  hasApiKey: boolean
  onRunEnabledAutomations: () => void
  aiContextSearching: boolean
  onFindRelatedNotes: () => void
  aiAsking: boolean
  onAskAi: () => void
  aiContextError: string
  aiContextResults: SemanticSearchResult[]
  onOpenDocument: (documentId: string) => void
  aiAnswer: string
}

export function AISection({
  ui,
  isZh,
  selectedDocument,
  aiPromptDraft,
  onAiPromptChange,
  aiAutomationsRunning,
  aiEnabled,
  hasApiKey,
  onRunEnabledAutomations,
  aiContextSearching,
  onFindRelatedNotes,
  aiAsking,
  onAskAi,
  aiContextError,
  aiContextResults,
  onOpenDocument,
  aiAnswer
}: AISectionProps) {
  return (
    <section className="detail-grid single-column">
      <article className="panel large-panel">
        <div className="panel-head">
          <div>
            <p className="panel-label">{ui.askAiLabel}</p>
            <h3>{isZh ? '文档智能助手' : 'Document AI assistant'}</h3>
          </div>
          {selectedDocument ? <span className="pill">{selectedDocument.title}</span> : null}
        </div>
        {selectedDocument ? (
          <div className="ai-panel">
            <textarea
              className="editor-textarea"
              onChange={(event) => onAiPromptChange(event.target.value)}
              placeholder={ui.askAiPlaceholder}
              rows={4}
              value={aiPromptDraft}
            />
            <div className="toolbar-inline ai-actions">
              <button
                className="secondary-button"
                disabled={aiAutomationsRunning || !aiEnabled || !hasApiKey}
                onClick={onRunEnabledAutomations}
                type="button"
              >
                {aiAutomationsRunning ? ui.runningAutomations : ui.runEnabledAutomations}
              </button>
              <button className="secondary-button" disabled={aiContextSearching || !aiPromptDraft.trim()} onClick={onFindRelatedNotes} type="button">
                {aiContextSearching ? ui.searching : ui.findRelatedNotes}
              </button>
              <button className="secondary-button" disabled={aiAsking || !aiPromptDraft.trim()} onClick={onAskAi} type="button">
                {aiAsking ? ui.thinking : ui.askAiLabel}
              </button>
            </div>
            <p className="mini-hint">{ui.manualAiHint}</p>
            {aiContextError ? <p className="mini-hint ai-context-error">{aiContextError}</p> : null}
            {aiContextResults.length > 0 ? (
              <div className="ai-context-list">
                {aiContextResults.map((result) => (
                  <button
                    className="ai-context-card"
                    key={`${result.documentId}-${result.path}`}
                    onClick={() => onOpenDocument(result.documentId)}
                    type="button"
                  >
                    <div className="ai-context-head">
                      <strong className="ai-context-title">{result.title}</strong>
                      <span className="ai-context-score">{ui.matchPercent(Math.round(result.score * 100))}</span>
                    </div>
                    <span className="ai-context-path">{result.path}</span>
                    <span className="ai-context-snippet">{result.snippet || result.summary || ui.common.noPreviewAvailable}</span>
                  </button>
                ))}
              </div>
            ) : aiPromptDraft.trim() ? (
              <p className="mini-hint">{ui.semanticHint}</p>
            ) : null}
            {aiAnswer ? <pre className="ai-answer">{aiAnswer}</pre> : null}
          </div>
        ) : (
          <p className="mini-hint">{isZh ? '请先在文档页选择一个文档。' : 'Please select a document from the documents page first.'}</p>
        )}
      </article>
    </section>
  )
}