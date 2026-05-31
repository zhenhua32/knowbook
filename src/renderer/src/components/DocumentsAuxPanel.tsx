import type { ReactNode } from 'react'
import type { PluginDocumentAction, SemanticSearchResult } from '@shared/contracts'
import type { UiText } from '../i18n'

type DocumentsAuxPanelProps = {
  ui: UiText
  isZh: boolean
  isOpen: boolean
  relationContent: ReactNode
  webClipUrlDraft: string
  webClipBusy: boolean
  onWebClipUrlChange: (value: string) => void
  onClipWebPage: () => void
  pluginDocumentActions: PluginDocumentAction[]
  pluginActionBusyKey: string | null
  onRunPluginAction: (action: PluginDocumentAction) => void
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

export function DocumentsAuxPanel(props: DocumentsAuxPanelProps) {
  const {
    ui,
    isZh,
    isOpen,
    relationContent,
    webClipUrlDraft,
    webClipBusy,
    onWebClipUrlChange,
    onClipWebPage,
    pluginDocumentActions,
    pluginActionBusyKey,
    onRunPluginAction,
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
  } = props

  if (!isOpen) {
    return (
      <p className="mini-hint">
        {isZh
          ? '辅助区已收起：可点击“展开辅助区”查看关系、插件动作与 AI 面板。'
          : 'Auxiliary panel is hidden. Click "Show auxiliary" to open relations, plugin actions, and AI panel.'}
      </p>
    )
  }

  return (
    <>
      {relationContent}

      <div className="preview-section">
        <p className="panel-label">{ui.webClipLabel}</p>
        <div className="ai-panel">
          <input
            className="editor-input"
            onChange={(event) => onWebClipUrlChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                onClipWebPage()
              }
            }}
            placeholder={ui.webClipPlaceholder}
            type="url"
            value={webClipUrlDraft}
          />
          <div className="toolbar-inline ai-actions">
            <button className="secondary-button" disabled={webClipBusy || !webClipUrlDraft.trim()} onClick={onClipWebPage} type="button">
              {webClipBusy ? ui.clippingWebPage : ui.clipWebPage}
            </button>
          </div>
          <p className="mini-hint">{ui.webClipHint}</p>
        </div>

        {pluginDocumentActions.length > 0 ? (
          <>
            <p className="panel-label">{ui.pluginActionsLabel}</p>
            <div className="plugin-document-actions">
              {pluginDocumentActions.map((action) => {
                const actionKey = `${action.pluginId}:${action.id}`
                return (
                  <button
                    className="secondary-button plugin-action-button"
                    disabled={pluginActionBusyKey === actionKey}
                    key={actionKey}
                    onClick={() => onRunPluginAction(action)}
                    title={action.description}
                    type="button"
                  >
                    {pluginActionBusyKey === actionKey ? ui.runningAutomations : action.label}
                  </button>
                )
              })}
            </div>
            <p className="mini-hint">{ui.pluginActionsHint}</p>
          </>
        ) : null}

        <p className="panel-label">{ui.askAiLabel}</p>
        <div className="ai-panel">
          <textarea
            className="editor-textarea"
            onChange={(event) => onAiPromptChange(event.target.value)}
            placeholder={ui.askAiPlaceholder}
            rows={3}
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
      </div>
    </>
  )
}
