import { useViewportMenuPosition } from '../hooks/useViewportMenuPosition'

type FloatingSlashCommandPanelProps = {
  x: number
  y: number
  query: string
  commands: Array<{
    id: string
    label: string
    description: string
  }>
  activeCommandId: string | null | undefined
  noMatchingLabel: string
  loadingLabel?: string
  errorLabel?: string | null
  retryLabel?: string
  onRetry?: () => void
  onSelectCommand: (command: { id: string; label: string; description: string }) => void
  onHoverCommand: (index: number) => void
}

export function FloatingSlashCommandPanel(props: FloatingSlashCommandPanelProps) {
  const {
    x,
    y,
    query,
    commands,
    activeCommandId,
    noMatchingLabel,
    loadingLabel,
    errorLabel,
    retryLabel,
    onRetry,
    onSelectCommand,
    onHoverCommand
  } = props
  const { menuRef, menuStyle } = useViewportMenuPosition<HTMLDivElement>(x, y)

  return (
    <div
      className="floating-slash-command-panel"
      aria-busy={Boolean(loadingLabel)}
      ref={menuRef}
      style={{ ...menuStyle, zIndex: 1001 }}
    >
      <div className="slash-command-search">
        <span className="slash-command-search-icon">/</span>
        <span className="slash-command-query">{query}</span>
      </div>

      <div className="slash-command-list">
        {loadingLabel ? <p className="slash-command-empty" role="status">{loadingLabel}</p>
          : errorLabel ? <div role="alert"><p className="slash-command-empty">{errorLabel}</p>
            {onRetry && <button onMouseDown={event => event.preventDefault()} onClick={onRetry} type="button">{retryLabel}</button>}
          </div>
          : commands.length > 0 ? (
          commands.map((command, commandIndex) => (
            <button
              className={`slash-command-item${activeCommandId === command.id ? ' slash-command-item-active' : ''}`}
              key={`slash-${command.id}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelectCommand(command)}
              onMouseEnter={() => onHoverCommand(commandIndex)}
              type="button"
            >
              <strong className="slash-command-id">/{command.id}</strong>
              <span className="slash-command-label">{command.label}</span>
              <small className="slash-command-description">{command.description}</small>
            </button>
          ))
        ) : (
          <p className="slash-command-empty">{noMatchingLabel}</p>
        )}
      </div>
    </div>
  )
}
