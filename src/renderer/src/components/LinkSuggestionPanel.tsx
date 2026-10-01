import type { DocumentBlockDraft, DocumentSuggestion } from '@shared/contracts'

type LinkSuggestionPanelProps = {
  query: string
  blockSuggestions: DocumentBlockDraft[]
  linkSuggestions: DocumentSuggestion[]
  blocksLabel: string
  linkedDocsLabel: string
  queryLabel: (query: string) => string
  noMatchingLabel: string
  titleLabel?: string
  linkSuggestionsLoading?: boolean
  linkSuggestionsError?: string | null
  loadingLabel?: string
  retryLabel?: string
  onRetry?: () => void
  onSelectBlockSuggestion: (block: DocumentBlockDraft) => void
  onSelectLinkSuggestion: (suggestion: DocumentSuggestion) => void
  activeSuggestionKey?: string
  onHoverSuggestion?: (key: string) => void
}

export function LinkSuggestionPanel(props: LinkSuggestionPanelProps) {
  const {
    query,
    blockSuggestions,
    linkSuggestions,
    blocksLabel,
    linkedDocsLabel,
    queryLabel,
    noMatchingLabel,
    titleLabel = linkedDocsLabel,
    linkSuggestionsLoading = false,
    linkSuggestionsError,
    loadingLabel,
    retryLabel,
    onRetry,
    onSelectBlockSuggestion,
    onSelectLinkSuggestion,
    activeSuggestionKey,
    onHoverSuggestion
  } = props

  return (
    <div className="link-helper-panel">
      <p className="panel-label">{titleLabel}</p>
      <p className="mini-hint">{queryLabel(query)}</p>
      <div className="relation-list">
        {blockSuggestions.length > 0 && (
          <>
            <p className="panel-label link-helper-section-label">{blocksLabel}</p>
            {blockSuggestions.map((block) => (
              <button
                className={`relation-chip${activeSuggestionKey === `block-${block.id}` ? ' relation-chip-active' : ''}`}
                key={`block-suggestion-${block.id}`}
                aria-current={activeSuggestionKey === `block-${block.id}` ? 'true' : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHoverSuggestion?.(`block-${block.id}`)}
                onClick={() => onSelectBlockSuggestion(block)}
                type="button"
              >
                <strong>{block.type}</strong>
                <span>{block.content.slice(0, 60)}{block.content.length > 60 ? '...' : ''}</span>
              </button>
            ))}
          </>
        )}
        {linkSuggestions.length > 0 && (
          <>
            <p className="panel-label link-helper-section-label">{linkedDocsLabel}</p>
            {linkSuggestions.map((suggestion) => (
              <button
                className={`relation-chip${activeSuggestionKey === `document-${suggestion.id}` ? ' relation-chip-active' : ''}`}
                key={`suggestion-${suggestion.id}`}
                aria-current={activeSuggestionKey === `document-${suggestion.id}` ? 'true' : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHoverSuggestion?.(`document-${suggestion.id}`)}
                onClick={() => onSelectLinkSuggestion(suggestion)}
                type="button"
              >
                <strong>{suggestion.title}</strong>
                <span>{suggestion.path}</span>
              </button>
            ))}
          </>
        )}
        {linkSuggestionsLoading && <p className="mini-hint" role="status">{loadingLabel}</p>}
        {linkSuggestionsError && (
          <div className="link-helper-feedback">
            <p className="mini-hint" role="alert">{linkSuggestionsError}</p>
            {onRetry && <button
              className={`secondary-button link-suggestions-retry${activeSuggestionKey === 'retry' ? ' relation-chip-active' : ''}`}
              aria-current={activeSuggestionKey === 'retry' ? 'true' : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHoverSuggestion?.('retry')}
              onClick={onRetry}
              type="button"
            >{retryLabel}</button>}
          </div>
        )}
        {!linkSuggestionsLoading && !linkSuggestionsError && blockSuggestions.length === 0 && linkSuggestions.length === 0 && (
          <p className="empty-text">{noMatchingLabel}</p>
        )}
      </div>
    </div>
  )
}
