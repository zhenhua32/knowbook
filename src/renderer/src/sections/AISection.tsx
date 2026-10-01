import { useId, useRef, type ReactNode } from 'react'
import type { DocumentDetail, SemanticSearchResult } from '@shared/contracts'
import type { UiText } from '../i18n'
import { AssistantConversation } from '../components/AssistantConversation'
import { AiTaskSwitcher } from '../components/AiTaskSwitcher'
import { AiAnswerContent } from '../components/AiAnswerContent'
import { AiRequestError } from '../components/AiRequestError'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import './management-sections.css'
import './ai-workspace.css'
import '../components/AiAnswerContent.css'
import '../components/AiRequestError.css'

type AISectionProps = {
  ui: UiText
  isZh: boolean
  selectedDocument: DocumentDetail | null
  documentOptions: Array<{ id: string; title: string; path: string }>
  contextDocumentId: string | null
  contextDocumentLoading: boolean
  onSelectContextDocument: (documentId: string) => void
  onOpenAiSettings: () => void
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
  aiAnswerError: string
  aiFailedPrompt: string
  onRetryAi: () => void
  extensionTools?: ReactNode
  extensionMessageCards?: ReactNode
}

export function AISection(props: AISectionProps) {
  const { ui, isZh, selectedDocument, documentOptions, contextDocumentId, contextDocumentLoading,
    onSelectContextDocument, onOpenAiSettings, aiPromptDraft, onAiPromptChange, aiAutomationsRunning,
    aiEnabled, hasApiKey, onRunEnabledAutomations, aiContextSearching, aiContextHasSearched, onFindRelatedNotes,
    aiAsking, onAskAi, aiContextError, aiContextResults, onOpenDocument, aiAnswer, aiAnswerError, aiFailedPrompt, onRetryAi, extensionTools, extensionMessageCards } = props
  const promptId = useId()
  const contextId = useId()
  const composing = useRef(false)
  const canUseAi = aiEnabled && hasApiKey
  const documentReady = Boolean(selectedDocument && selectedDocument.id === contextDocumentId && !contextDocumentLoading)
  const canAsk = documentReady && canUseAi && !aiAsking && Boolean(aiPromptDraft.trim())
  const suggestions = isZh ? ['总结这篇文档的要点', '解释文档中的核心概念', '给出 3 条改进建议']
    : ['Summarize the key points', 'Explain the core concepts', 'Suggest 3 improvements']

  return <>
    <header className="management-page-header">
      <div className="management-page-heading">
        <p className="management-page-kicker">{isZh ? '智能工作台' : 'Intelligence workspace'}</p>
        <h2>{isZh ? 'AI 助手' : 'AI assistant'}</h2>
        <p className="management-page-description">{isZh ? '理解与整理文档，或创建适合你的应用扩展。' : 'Understand your documents or create an extension for your workflow.'}</p>
      </div>
    </header>
    {!canUseAi ? <div className="ai-readiness" role="status">
      <div><strong>{isZh ? '连接 AI 后即可开始' : 'Connect AI to get started'}</strong>
        <p>{isZh ? '请在设置中启用 AI 并保存 API Key。相关笔记检索仍可在本地使用。' : 'Enable AI and save an API key in Settings. Related-note search is available locally.'}</p></div>
      <button type="button" className="secondary-button" onClick={onOpenAiSettings}>{isZh ? '配置 AI' : 'Configure AI'}</button>
    </div> : null}
    <AiTaskSwitcher isZh={isZh} documentContent={
      <article className="panel ai-document-workspace">
        <div className="ai-context-picker">
          <label htmlFor={contextId}>{isZh ? '文档上下文' : 'Document context'}</label>
          <select id={contextId} className="editor-select" value={contextDocumentId ?? ''}
            onChange={event => { if (event.target.value) onSelectContextDocument(event.target.value) }}>
            <option value="" disabled>{isZh ? '选择一篇文档' : 'Choose a document'}</option>
            {documentOptions.map(document => <option key={document.id} value={document.id}>
              {document.path || document.title}
            </option>)}
          </select>
          {documentReady ? <button type="button" className="ai-context-open" onClick={() => onOpenDocument(selectedDocument!.id)}>
            {isZh ? '打开文档' : 'Open document'} <span aria-hidden="true">↗</span>
          </button> : null}
        </div>
        {contextDocumentLoading ? <p className="ai-context-loading" role="status">{isZh ? '正在加载文档上下文…' : 'Loading document context…'}</p>
          : documentReady ? <p className="ai-context-description">{isZh ? '围绕' : 'Working with'} <strong>{selectedDocument!.title}</strong> {isZh ? '提问，回答会参考这篇文档。' : '— answers use this document as context.'}</p>
            : <div className="ai-context-empty"><strong>{isZh ? '先选择一篇文档' : 'Choose a document first'}</strong>
              <p>{isZh ? '在上方选择文档，即可总结要点、解释内容或寻找改进方向。' : 'Select a document above to summarize, explain, or explore improvements.'}</p></div>}
        <div className="ai-panel">
          <label className="ai-prompt-label" htmlFor={promptId}>{isZh ? '你想了解什么？' : 'What would you like to know?'}</label>
          <textarea id={promptId} className="editor-textarea ai-document-prompt" rows={3}
            value={aiPromptDraft} onChange={event => onAiPromptChange(event.target.value)}
            disabled={!documentReady} placeholder={ui.askAiPlaceholder}
            onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
            onBlur={() => { composing.current = false }} onKeyDown={event => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !isImeKeyboardEvent(event.nativeEvent, composing.current) && canAsk) {
                event.preventDefault(); onAskAi()
              }
            }} />
          {!aiPromptDraft.trim() && documentReady ? <div className="ai-prompt-suggestions">
            {suggestions.map(prompt => <button key={prompt} type="button" onClick={() => onAiPromptChange(prompt)}>{prompt}</button>)}
          </div> : null}
          <div className="ai-document-actions">
            <button className="primary-button" disabled={!canAsk} onClick={onAskAi} type="button" aria-keyshortcuts="Control+Enter Meta+Enter">
              {aiAsking ? ui.thinking : ui.askAiLabel}
            </button>
            <span className="ai-send-shortcut">{isZh ? 'Ctrl / ⌘ + Enter 发送' : 'Ctrl / ⌘ + Enter to send'}</span>
            <button className="secondary-button ai-summary-action" disabled={!documentReady || aiAutomationsRunning || !canUseAi}
              onClick={onRunEnabledAutomations} type="button">{aiAutomationsRunning ? ui.generatingSummary : ui.runEnabledAutomations}</button>
          </div>
          {aiAsking ? <div className="ai-answer-pending" role="status"><span className="ai-thinking-dot" aria-hidden="true" />{isZh ? '正在结合文档思考…' : 'Thinking with your document…'}</div> : null}
          {aiAnswerError ? <AiRequestError isZh={isZh} error={aiAnswerError} failedPrompt={aiFailedPrompt}
            busy={aiAsking} canRetry={documentReady && canUseAi} onRetry={onRetryAi} /> : null}
          {aiAnswer && !aiAnswerError && !aiAsking ? <section className="ai-answer" aria-label={isZh ? 'AI 回答' : 'AI answer'}>
            <p className="ai-answer-label">{isZh ? 'AI 回答' : 'AI answer'}</p><AiAnswerContent content={aiAnswer} />
          </section> : null}
          <details className="ai-related-notes" key={contextDocumentId ?? 'none'}>
            <summary>{isZh ? '相关笔记' : 'Related notes'}{aiContextResults.length > 0 ? <span>{aiContextResults.length}</span> : null}</summary>
            <div className="ai-related-notes-content">
              <p>{isZh ? '按问题中的关键词检索本地笔记，打开后可查看原文。' : 'Search local notes using the keywords in your question, then open the source.'}</p>
              <button className="secondary-button" disabled={!documentReady || aiContextSearching || !aiPromptDraft.trim()} onClick={onFindRelatedNotes} type="button">
                {aiContextSearching ? ui.searching : ui.findRelatedNotes}
              </button>
              {aiContextSearching ? <p role="status">{isZh ? '正在检索本地笔记…' : 'Searching local notes…'}</p>
                : aiContextError ? <p className="ai-context-error" role="alert">{aiContextError}</p>
                  : aiContextResults.length > 0 ? <div className="ai-context-list">
                    {aiContextResults.map(result => <button className="ai-context-card" key={result.documentId + '-' + result.path} onClick={() => onOpenDocument(result.documentId)} type="button">
                      <div className="ai-context-head"><strong className="ai-context-title">{result.title}</strong><span className="ai-context-score">{ui.matchPercent(Math.round(result.score * 100))}</span></div>
                      <span className="ai-context-path">{result.path}</span><span className="ai-context-snippet">{result.snippet || result.summary || ui.common.noPreviewAvailable}</span>
                    </button>)}
                  </div> : <p className="ai-related-empty">{aiContextHasSearched
                    ? (isZh ? '没有找到相关笔记。试试更具体的关键词，或换一种说法。' : 'No related notes found. Try more specific keywords or rephrase your question.')
                    : aiPromptDraft.trim() ? (isZh ? '点击“查找相关笔记”查看可参考的内容。' : 'Select Find related notes to see relevant sources.')
                      : (isZh ? '先写下问题，再查找可参考的笔记。' : 'Write a question first, then search for useful notes.')}</p>}
            </div>
          </details>
        </div>
      </article>
    } extensionContent={
      <article className="panel ai-extension-workspace">
        <div className="ai-extension-heading"><h3>{isZh ? '为你的工作方式添加能力' : 'Add a capability to your workflow'}</h3>
          <p>{isZh ? '描述想要的扩展或自动化。助手会准备实现，并在启用前让你确认。' : 'Describe an extension or automation. The assistant prepares it for your review before activation.'}</p></div>
        {extensionTools}
        <AssistantConversation activeDocumentId={documentReady ? selectedDocument!.id : null} aiEnabled={aiEnabled} hasApiKey={hasApiKey} isZh={isZh} showConfigurationHint={false} />
        {extensionMessageCards}
      </article>
    } />
  </>
}
