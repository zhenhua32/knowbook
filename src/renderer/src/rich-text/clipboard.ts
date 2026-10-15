import { Fragment, type Node, type Slice } from 'prosemirror-model'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { richDocToDraftBlocks } from './model'
import { richTextSchema } from './schema'

/** A partial PM slice can retain an open columns shell. Its surviving columns
 * form a new, complete copied group; source IDs are discarded by the Markdown exporter. */
export function richTextSliceMarkdown(slice: Slice): string {
  const close = (fragment: Fragment): Node[] => {
    const result: Node[] = [], loose: Node[] = []
    const group = (columns: Node[], attrs: Record<string, unknown> = {}) => {
      const weights = columns.map(column => column.attrs.block?.markdownFormat?.columnWeight ?? 1)
      const total = weights.reduce((sum, weight) => sum + weight, 0)
      const available = 10000 - columns.length
      const scaled = weights.map(weight => Math.floor(weight * available / total) + 1)
      let remainder = 10000 - scaled.reduce((sum, weight) => sum + weight, 0)
      for (let index = 0; remainder > 0; index = (index + 1) % columns.length, remainder--) scaled[index]++
      // A complete group keeps its authored integers exactly.
      const exact = total === 10000 ? weights : scaled
      return richTextSchema.nodes.columns_block.create({ ...attrs,
        block: { type: 'columns', content: '', checked: false, depth: 0, parentBlockId: null, ...(attrs.block as object ?? {}) }
      }, columns.map((column, index) => richTextSchema.nodes.column_block.create({ ...column.attrs,
        block: { ...column.attrs.block, markdownFormat: { columnWeight: exact[index] } }
      }, close(column.content))))
    }
    const flush = () => { if (loose.length) result.push(group(loose.splice(0))) }
    fragment.forEach(node => {
      if (node.type === richTextSchema.nodes.column_block) { loose.push(node); return }
      flush()
      if (node.type === richTextSchema.nodes.columns_block) {
        const columns: Node[] = []
        node.forEach(column => columns.push(column))
        if (columns.length) result.push(group(columns, node.attrs))
      } else if (node.isInline) {
        const previous = result.at(-1)
        if (previous?.type === richTextSchema.nodes.text_block && !previous.attrs.block) result[result.length - 1] = previous.copy(previous.content.append(Fragment.from(node)))
        else result.push(richTextSchema.nodes.text_block.create(null, node))
      } else result.push(node)
    })
    flush()
    return result
  }
  return serializeBlocksToMarkdown(richDocToDraftBlocks(richTextSchema.nodes.doc.create(null, close(slice.content))))
}
