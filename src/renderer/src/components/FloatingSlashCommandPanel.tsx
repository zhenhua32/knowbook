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
    onSelectCommand,
    onHoverCommand
  } = props
  const { menuRef, menuStyle } = useViewportMenuPosition<HTMLDivElement>(x, y)

  return (
    <div
      className="floating-slash-command-panel"
      ref={menuRef}
      style={{ ...menuStyle, zIndex: 1001 }}
    >
      <div className="slash-command-search">
        <span className="slash-command-search-icon">/</span>
        <span className="slash-command-query">{query}</span>
      </div>

      <div className="slash-command-list">
        {commands.length > 0 ? (
          commands.map((command, commandIndex) => (
            <button
              className={`slash-command-item${activeCommandId === command.id ? ' slash-command-item-active' : ''}`}
              key={`slash-${command.id}`}
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
