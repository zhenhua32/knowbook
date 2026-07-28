import { parseMarkdownTable } from '../utils/markdownTable'

type MarkdownTablePreviewProps = {
  content: string
  label: string
}

export function MarkdownTablePreview({ content, label }: MarkdownTablePreviewProps) {
  const parsedTable = parseMarkdownTable(content)
  if (!parsedTable) {
    return null
  }

  return (
    <div aria-label={label} className="block-table-content" role="region">
      <table className="block-markdown-table">
        <thead>
          <tr>
            {parsedTable.headers.map((header, columnIndex) => (
              <th
                key={`header-${columnIndex}`}
                style={parsedTable.alignments[columnIndex] ? { textAlign: parsedTable.alignments[columnIndex] ?? undefined } : undefined}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {parsedTable.rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {row.map((cell, columnIndex) => (
                <td
                  key={`cell-${rowIndex}-${columnIndex}`}
                  style={parsedTable.alignments[columnIndex] ? { textAlign: parsedTable.alignments[columnIndex] ?? undefined } : undefined}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
