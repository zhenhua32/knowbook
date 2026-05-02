import type { DocumentBlockDraft, DocumentSuggestion } from '@shared/contracts'

type LinkSuggestionPanelProps = {
  query: string
  blockSuggestions: DocumentBlockDraft[]
  linkSuggestions: DocumentSuggestion[]
  blocksLabel: string
  linkedDocsLabel: string
  queryLabel: (query: string) => string
  noMatchingLabel: string
  onSelectBlockSuggestion: (block: DocumentBlockDraft) => void
  onSelectLinkSuggestion: (suggestion: DocumentSuggestion) => void
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
    onSelectBlockSuggestion,
    onSelectLinkSuggestion
  } = props

  return (
    <div className="link-helper-panel">
      <p className="panel-label">{linkedDocsLabel}</p>
      <p className="mini-hint">{queryLabel(query)}</p>
      <div className="relation-list">
        {blockSuggestions.length > 0 && (
          <>
            <p className="panel-label" style={{ marginTop: '12px', fontSize: '0.85rem' }}>{blocksLabel}</p>
            {blockSuggestions.map((block) => (
              <button
                className="relation-chip"
                key={`block-suggestion-${block.id}`}
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
            <p className="panel-label" style={{ marginTop: '12px', fontSize: '0.85rem' }}>{linkedDocsLabel}</p>
            {linkSuggestions.map((suggestion) => (
              <button
                className="relation-chip"
                key={`suggestion-${suggestion.id}`}
                onClick={() => onSelectLinkSuggestion(suggestion)}
                type="button"
              >
                <strong>{suggestion.title}</strong>
                <span>{suggestion.path}</span>
              </button>
            ))}
          </>
        )}
        {blockSuggestions.length === 0 && linkSuggestions.length === 0 && (
          <p className="empty-text">{noMatchingLabel}</p>
        )}
      </div>
    </div>
  )
}
