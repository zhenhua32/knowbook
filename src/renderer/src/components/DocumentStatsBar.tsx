type DocumentStatsBarProps = {
  blockCount: number
  wordCount: number
  charCount: number
  codeBlockCount: number
  todoCount: number
  blocksLabel: string
  wordsLabel: string
  charsLabel: string
  codeBlocksLabel: string
  todosLabel: string
}

export function DocumentStatsBar(props: DocumentStatsBarProps) {
  const {
    blockCount,
    wordCount,
    charCount,
    codeBlockCount,
    todoCount,
    blocksLabel,
    wordsLabel,
    charsLabel,
    codeBlocksLabel,
    todosLabel
  } = props

  return (
    <div className="doc-stats-bar">
      <span className="doc-stat"><strong>{blockCount}</strong> {blocksLabel}</span>
      <span className="doc-stat-divider">·</span>
      <span className="doc-stat"><strong>{wordCount}</strong> {wordsLabel}</span>
      <span className="doc-stat-divider">·</span>
      <span className="doc-stat"><strong>{charCount}</strong> {charsLabel}</span>
      {codeBlockCount > 0 ? (
        <>
          <span className="doc-stat-divider">·</span>
          <span className="doc-stat"><strong>{codeBlockCount}</strong> {codeBlocksLabel}</span>
        </>
      ) : null}
      {todoCount > 0 ? (
        <>
          <span className="doc-stat-divider">·</span>
          <span className="doc-stat"><strong>{todoCount}</strong> {todosLabel}</span>
        </>
      ) : null}
    </div>
  )
}
