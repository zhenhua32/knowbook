import type MarkdownIt from 'markdown-it'
import { DEFAULT_TABLE_COLUMN_WIDTH, isTableLayoutDirectiveLine, parseTableColumnWidthsDirective, tableColumnWidths } from './markdownTableLayout'

/** A strict layout line belongs only to the immediately following real GFM table.
 * Upstream maps stay untouched so table-cell destinations retain their offsets. */
export function installMarkdownTableLayout(md: InstanceType<typeof MarkdownIt>): void {
  const tableRule = md.block.ruler.__rules__.find(entry => entry.name === 'table')!.fn
  md.block.ruler.before('table', 'knowbook_table_layout', (state, start, end, silent) => {
    if (state.sCount[start] < state.blkIndent || state.sCount[start] - state.blkIndent >= 4 || start + 2 >= end) return false
    const line = (index: number) => state.src.slice(state.bMarks[index] + state.tShift[index], state.eMarks[index])
    const widths = parseTableColumnWidthsDirective(line(start))
    if (!widths || start > 0 && isTableLayoutDirectiveLine(line(start - 1))
      || !tableRule(state, start + 1, end, true)) return false
    // The successful upstream lookahead proves this separator has exactly the
    // real header's column count, including escaped pipes in the header.
    const columns = line(start + 2).split('|').filter(part => part.trim()).length
    if (widths.length !== columns) return false
    if (silent) return true
    const token = state.push('knowbook_table_layout', '', 0)
    token.map = [start, start + 1]
    token.content = line(start)
    token.meta = { tableColumnWidths: widths }
    token.hidden = true
    state.line = start + 1
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.core.ruler.before('inline', 'bind_table_layout', state => {
    for (let index = 0; index < state.tokens.length; index++) {
      const layout = state.tokens[index], table = state.tokens[index + 1]
      if (layout.type !== 'knowbook_table_layout') continue
      const widths = tableColumnWidths(layout)
      const valid = table?.type === 'table_open' && widths && table.level === layout.level && table.map?.[0] === layout.map?.[1]
      if (valid) {
        table.meta = { ...table.meta, tableColumnWidths: widths, tableLayoutMap: layout.map }
        layout.meta = { ...layout.meta, boundTableLayout: true }
      } else layout.hidden = false
    }
  })
  md.renderer.rules.knowbook_table_layout = (tokens, index) => tokens[index].meta?.boundTableLayout
    ? '' : `<p>${md.utils.escapeHtml(tokens[index].content)}</p>\n`
  const renderTable = md.renderer.rules.table_open
  md.renderer.rules.table_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index], widths = tableColumnWidths(token)
    const opening = renderTable ? renderTable(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options)
    if (!widths) return opening
    const sum = widths.reduce<number>((total, width) => total + (width ?? DEFAULT_TABLE_COLUMN_WIDTH), 0)
    // Values above are finite validated integers. No raw styles or source HTML.
    return opening.replace(/<table(?=[\s>])/, `<table data-knowbook-table-layout="true" style="table-layout:fixed;width:${sum}px"`)
      + `<colgroup>${widths.map(width => `<col style="width:${width ?? DEFAULT_TABLE_COLUMN_WIDTH}px">`).join('')}</colgroup>\n`
  }
}
