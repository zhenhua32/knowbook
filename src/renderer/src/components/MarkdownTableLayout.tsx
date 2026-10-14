import type { ReactNode } from 'react'
import { DEFAULT_TABLE_COLUMN_WIDTH, type MarkdownTableColumnWidth } from '@shared/markdownTableLayout'
import '../styles/markdown-table-layout.css'

export function MarkdownTableLayout({ widths, children }: { widths: MarkdownTableColumnWidth[]; children: ReactNode }) {
  return <table className="block-markdown-table" data-knowbook-table-layout="true" style={{ tableLayout: 'fixed', width: widths.reduce<number>((total, width) => total + (width ?? DEFAULT_TABLE_COLUMN_WIDTH), 0) }}>
    <colgroup>{widths.map((width, index) => <col key={index} style={{ width: width ?? DEFAULT_TABLE_COLUMN_WIDTH }} />)}</colgroup>{children}
  </table>
}
