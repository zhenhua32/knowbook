import { useId, useRef, type ReactNode } from 'react'
import type { PluginDocumentAction, SemanticSearchResult } from '@shared/contracts'
import type { UiText } from '../i18n'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { AiAnswerCard } from './AiAnswerCard'
import { AiRequestError } from './AiRequestError'
import { useAuxiliaryFocusVisibility } from '../hooks/useAuxiliaryFocusVisibility'

type DocumentsAuxPanelProps = {
  ui: UiText
  isZh: boolean
  isOpen: boolean
  relationContent: ReactNode
  selectionAiContent?: ReactNode
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
  aiContextHasSearched: boolean
  onFindRelatedNotes: () => void
  aiAsking: boolean
  onAskAi: () => void
  aiContextError: string
  aiContextResults: SemanticSearchResult[]
  onOpenDocument: (documentId: string) => void
  aiAnswer: string
  aiAnsweredPrompt: string
  aiAnswerError: string
  aiFailedPrompt: string
  documentReady: boolean
  onRetryAi: () => void
  onOpenAiSettings: () => void
}

export function DocumentsAuxPanel(props: DocumentsAuxPanelProps) {
  const {
    ui,
    isZh,
    isOpen,
    relationContent,
    selectionAiContent,
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
    aiContextHasSearched,
    onFindRelatedNotes,
    aiAsking,
    onAskAi,
    aiContextError,
    aiContextResults,
    onOpenDocument,
    aiAnswer,
    aiAnsweredPrompt,
    aiAnswerError,
    aiFailedPrompt,
    documentReady,
    onRetryAi,
    onOpenAiSettings
  } = props
  const promptId = useId()
  const promptHintId = useId()
  const webClipUrlId = useId()
  const webClipHintId = useId()
  const webClipComposing = useRef(false)
  const composing = useRef(false)
  const canUseAi = documentReady && aiEnabled && hasApiKey
  const canAsk = canUseAi && !aiAsking && Boolean(aiPromptDraft.trim())
  const canFindRelated = documentReady && !aiContextSearching && Boolean(aiPromptDraft.trim())
  const canClip = documentReady && !webClipBusy && Boolean(webClipUrlDraft.trim())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useAuxiliaryFocusVisibility(scrollRef)

  if (!isOpen) {
    return (
      <div className="document-aux-sidebar-empty">
        <p className="mini-hint">
          {isZh
            ? '辅助区已收起：可点击“展开辅助区”查看关系、插件动作与 AI 面板。'
            : 'Auxiliary panel is hidden. Click "Show auxiliary" to open relations, plugin actions, and AI panel.'}
        </p>
      </div>
    )
  }

  return (
    <div className="document-aux-sidebar-content" data-testid="document-aux-scroll-region" ref={scrollRef}>
      {relationContent}
      {selectionAiContent ?? null}

      <div className="preview-section">
        <p className="panel-label">{ui.webClipLabel}</p>
        <div className="ai-panel document-aux-web-clip">
          <label className="document-aux-field-label" htmlFor={webClipUrlId}>{isZh ? '网页链接' : 'Webpage URL'}</label>
          <input
            id={webClipUrlId}
            aria-describedby={webClipHintId}
            className="editor-input"
            disabled={!documentReady}
            onChange={(event) => onWebClipUrlChange(event.target.value)}
            onCompositionStart={() => { webClipComposing.current = true }}
            onCompositionEnd={() => { webClipComposing.current = false }}
            onBlur={() => { webClipComposing.current = false }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && canClip
                && !isImeKeyboardEvent(event.nativeEvent, webClipComposing.current)) {
                event.preventDefault()
                onClipWebPage()
              }
            }}
            placeholder={ui.webClipPlaceholder}
            type="url"
            value={webClipUrlDraft}
          />
          <div className="toolbar-inline ai-actions">
            <button className="secondary-button" disabled={!canClip} onClick={onClipWebPage} type="button" aria-keyshortcuts="Enter">
              {webClipBusy ? ui.clippingWebPage : ui.clipWebPage}
            </button>
          </div>
          <p className="mini-hint" id={webClipHintId}>{ui.webClipHint}</p>
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

        <section className="document-aux-ai-section" aria-label={isZh ? '文档 AI 助手' : 'Document AI assistant'}>
          <p className="panel-label">{ui.askAiLabel}</p>
          <div className="ai-panel document-aux-ai">
            {!aiEnabled || !hasApiKey ? (
              <div className="document-aux-ai-readiness" role="status">
                <p>{isZh
                  ? '启用 AI 并保存 API Key 后即可提问。相关笔记仍可在本地查找。'
                  : 'Enable AI and save an API key to ask questions. Related-note search is available locally.'}</p>
                <button className="secondary-button" onClick={onOpenAiSettings} type="button">
                  {isZh ? '配置 AI' : 'Configure AI'}
                </button>
              </div>
            ) : null}
            {!documentReady ? <p className="mini-hint" role="status">{isZh ? '正在加载文档上下文…' : 'Loading document context…'}</p> : null}
            <label className="document-aux-ai-prompt-label" htmlFor={promptId}>{isZh ? '文档问题' : 'Document question'}</label>
            <textarea
              id={promptId}
              aria-describedby={promptHintId}
              className="editor-textarea document-aux-ai-prompt"
              disabled={!documentReady}
              onChange={(event) => onAiPromptChange(event.target.value)}
              onCompositionStart={() => { composing.current = true }}
              onCompositionEnd={() => { composing.current = false }}
              onBlur={() => { composing.current = false }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter'
                  && !isImeKeyboardEvent(event.nativeEvent, composing.current) && canAsk) {
                  event.preventDefault()
                  onAskAi()
                }
              }}
              placeholder={ui.askAiPlaceholder}
              rows={3}
              value={aiPromptDraft}
            />
            <div className="toolbar-inline ai-actions document-aux-ai-actions">
              <button className="primary-button" disabled={!canAsk} onClick={onAskAi} type="button" aria-keyshortcuts="Control+Enter Meta+Enter">
                {aiAsking ? ui.thinking : ui.askAiLabel}
              </button>
              <button className="secondary-button" disabled={!canFindRelated} onClick={onFindRelatedNotes} type="button">
                {aiContextSearching ? ui.searching : ui.findRelatedNotes}
              </button>
              <button
                className="secondary-button"
                disabled={aiAutomationsRunning || !canUseAi}
                onClick={onRunEnabledAutomations}
                type="button"
              >
                {aiAutomationsRunning ? ui.generatingSummary : ui.runEnabledAutomations}
              </button>
            </div>
            <p className="mini-hint document-aux-ai-shortcut" id={promptHintId}>{isZh ? 'Ctrl / ⌘ + Enter 发送' : 'Ctrl / ⌘ + Enter to send'}</p>
            {aiAsking ? <div className="document-aux-ai-pending" role="status">{isZh ? '正在结合文档思考…' : 'Thinking with your document…'}</div> : null}
            {aiAnswerError ? <AiRequestError isZh={isZh} error={aiAnswerError} failedPrompt={aiFailedPrompt}
              busy={aiAsking} canRetry={canUseAi} onRetry={onRetryAi} /> : null}
            {aiAnswer && !aiAnswerError && !aiAsking ? (
              <AiAnswerCard className="document-aux-ai-answer" content={aiAnswer} prompt={aiAnsweredPrompt} isZh={isZh} />
            ) : null}
            {aiContextSearching ? <p className="mini-hint" role="status">{isZh ? '正在检索本地笔记…' : 'Searching local notes…'}</p> : null}
            {aiContextError ? <div className="document-aux-ai-search-error" role="alert">
              <p>{aiContextError}</p>
              <button className="secondary-button" disabled={!canFindRelated} onClick={onFindRelatedNotes} type="button">
                {isZh ? '重试检索' : 'Retry search'}
              </button>
            </div> : null}
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
            ) : !aiContextSearching && !aiContextError && aiPromptDraft.trim() ? (
              <p className="mini-hint">{aiContextHasSearched
                ? (isZh ? '没有找到相关笔记。试试更具体的关键词。' : 'No related notes found. Try more specific keywords.')
                : ui.semanticHint}</p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
