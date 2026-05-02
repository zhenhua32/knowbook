type SlashCommandPanelProps = {
  query: string
  commands: Array<{
    id: string
    label: string
    description: string
  }>
  activeCommandId: string | null | undefined
  commandsLabel: string
  queryLabel: (query: string) => string
  noMatchingLabel: string
  hintLabel: string
  onSelectCommand: (command: { id: string; label: string; description: string }) => void
  onHoverCommand: (index: number) => void
}

export function SlashCommandPanel(props: SlashCommandPanelProps) {
  const {
    query,
    commands,
    activeCommandId,
    commandsLabel,
    queryLabel,
    noMatchingLabel,
    hintLabel,
    onSelectCommand,
    onHoverCommand
  } = props

  return (
    <div className="link-helper-panel">
      <p className="panel-label">{commandsLabel}</p>
      <p className="mini-hint">{queryLabel(query)}</p>
      <div className="relation-list">
        {commands.length > 0 ? (
          commands.map((command, commandIndex) => (
            <button
              className={`relation-chip${activeCommandId === command.id ? ' relation-chip-active' : ''}`}
              key={`slash-${command.id}`}
              onClick={() => onSelectCommand(command)}
              onMouseEnter={() => onHoverCommand(commandIndex)}
              type="button"
            >
              <strong>/{command.id}</strong>
              <span>{command.label}</span>
              <small>{command.description}</small>
            </button>
          ))
        ) : (
          <p className="empty-text">{noMatchingLabel}</p>
        )}
      </div>
      <p className="mini-hint">{hintLabel}</p>
    </div>
  )
}
