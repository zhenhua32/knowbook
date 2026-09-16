import type { DocumentBlockDraft } from '@shared/contracts'
import { parseTaskListMarker } from '@shared/markdownExtensions'
import { parseMarkdownBlocks } from '@shared/markdown'

export function parsePastedMarkdown(text: string): DocumentBlockDraft[] {
  return parseMarkdownBlocks(text).map((block) => ({
    ...block, checked: Boolean(block.checked), depth: block.depth ?? 0,
    language: block.language ?? undefined
  }))
}

/** Shortcuts only add the interactive empty-prefix case to the shared grammar. */
export function getMarkdownShortcut(block: DocumentBlockDraft, content: string): DocumentBlockDraft | null {
  const task = parseTaskListMarker(content)
  if (['bulleted-list', 'numbered-list'].includes(block.type) && task && /\][ \t]/.test(content)) {
    return { ...block, type: block.type === 'numbered-list' ? 'numbered-todo' : 'todo', checked: task.checked, content: content.slice(task.length) }
  }
  if (['code', 'math', 'table', 'divider', 'quote'].includes(block.type)) return null
  if (/^\$\$ /.test(content)) return { ...block, type: 'math', content: content.slice(3) }
  const parsed = parsePastedMarkdown(content)
  if (parsed.length === 1 && parsed[0].type !== 'paragraph') {
    // A complete Markdown document permits empty markers, but interactive
    // typing must wait for the space so ### and --- can be entered normally.
    if (!content.includes('\n')) {
      if (parsed[0].type.startsWith('heading-') && !/^ {0,3}#{1,6}[ \t]/.test(content)) return null
      if (['todo', 'numbered-todo', 'bulleted-list', 'numbered-list'].includes(parsed[0].type) && !/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]/.test(content)) return null
      if (parsed[0].type === 'quote' && !/^ {0,3}>+[ \t]/.test(content)) return null
    }
    return { ...block, ...parsed[0], id: block.id, parentBlockId: block.parentBlockId, depth: block.depth }
  }
  return null
}
