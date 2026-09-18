import type { MarkdownRenderableBlock, MarkdownBlockSourceRange } from './markdown'
import { isTaskBlockType } from './blockTypes'
import type { MarkdownNode } from './markdownEngine'

export type MarkdownTaskTarget = { index: number; blockId?: string; content: string; offset: number | null }

export function collectMarkdownTaskTargets(nodes: MarkdownNode[], source: string, ranges: MarkdownBlockSourceRange[], blocks: MarkdownRenderableBlock[]): Map<number, MarkdownTaskTarget> {
  const lines = source.split('\n')
  const offsets: number[] = []
  let position = 0
  for (const line of lines) { offsets.push(position); position += line.length + 1 }
  const targets = new Map<number, MarkdownTaskTarget>()
  const visit = (items: MarkdownNode[]) => {
    for (const { token, children } of items) {
      if (token.type === 'task_checkbox' && typeof token.meta?.sourceOffset === 'number') {
        const offset = token.meta.sourceOffset as number
        let low = 0, high = ranges.length
        while (low < high) {
          const middle = (low + high) >>> 1
          if ((offsets[ranges[middle].endLine] ?? source.length + 1) <= offset) low = middle + 1
          else high = middle
        }
        const range = ranges[low], block = blocks[low]
        if (range && block && offset >= offsets[range.startLine]) {
          const blockLines = block.content.split('\n')
          let line = range.startLine
          while (line + 1 < offsets.length && offsets[line + 1] <= offset) line++
          const localLine = line - range.startLine
          const local = blockLines[localLine]
          const column = offset - offsets[line]
          const prefix = local === undefined ? -1 : lines[line].length - local.length
          if (isTaskBlockType(block.type) && line === range.startLine && column < prefix) {
            targets.set(offset, { index: low, blockId: block.id, content: block.content, offset: null })
          } else if (local !== undefined && prefix >= 0 && lines[line].endsWith(local) && column >= prefix) {
            const contentOffset = blockLines.slice(0, localLine).reduce((length, text) => length + text.length + 1, 0) + column - prefix
            if (/^\[[ xX\t\n\f\v]\]/.test(block.content.slice(contentOffset - 1))) {
              targets.set(offset, { index: low, blockId: block.id, content: block.content, offset: contentOffset })
            }
          }
        }
      }
      visit(children)
    }
  }
  visit(nodes)
  return targets
}

export function markdownTaskPatch(block: MarkdownRenderableBlock | undefined, target: MarkdownTaskTarget, checked: boolean): { checked: boolean } | { content: string } | null {
  if (!block || block.id !== target.blockId || block.content !== target.content) return null
  if (target.offset === null) return isTaskBlockType(block.type) ? { checked } : null
  return { content: block.content.slice(0, target.offset) + (checked ? 'x' : ' ') + block.content.slice(target.offset + 1) }
}
