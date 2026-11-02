import { serializeBlocksToMarkdown } from '@shared/markdown'
import type { DocumentBlockDraft, DocumentDetail } from '@shared/contracts'
import { normalizeComparableDocumentTitle } from './documentDraftComparison'

export type DocumentMarkdownExport = { fileName: string; markdown: string }

type MarkdownDocumentShape = {
  title: string
  path?: string
  blocks: Array<Pick<DocumentBlockDraft, 'type' | 'content' | 'checked' | 'depth' | 'id' | 'parentBlockId' | 'language' | 'listStart' | 'markdownFormat'>>
}

export function buildDocumentMarkdown(document: MarkdownDocumentShape): string {
  if (document.blocks.some(block => block.type === 'synced-block')) throw new Error('此文档包含同步块，单文件 Markdown 无法保留实例和 canonical 正文。请使用完整 V3 工作区备份。')
  const first = document.blocks[0]
  const header = first?.type === 'frontmatter' ? first.content + '\n\n' : ''
  const body = serializeBlocksToMarkdown(header ? document.blocks.slice(1) : document.blocks)
  return header + (body.trim() === '' ? `# ${document.title}\n` : `# ${document.title}\n\n${body}`)
}

export function getDocumentMarkdownFileName(document: Pick<DocumentDetail, 'path' | 'title'>): string {
  const baseName = document.path.split('/').filter(Boolean).at(-1) || document.title || 'document'
  return `${baseName}.md`
}

export function buildDraftMarkdownExport(document: MarkdownDocumentShape): DocumentMarkdownExport {
  const title = normalizeComparableDocumentTitle(document.title)
  return { fileName: `${title}.md`, markdown: buildDocumentMarkdown({ title, blocks: document.blocks }) }
}
