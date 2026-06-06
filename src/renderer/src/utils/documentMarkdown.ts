import { serializeBlocksToMarkdown } from '@shared/markdown'
import type { DocumentBlock, DocumentDetail } from '@shared/contracts'

type MarkdownDocumentShape = {
  title: string
  path?: string
  blocks: Array<Pick<DocumentBlock, 'type' | 'content' | 'checked' | 'depth' | 'parentBlockId' | 'language'>>
}

export function buildDocumentMarkdown(document: MarkdownDocumentShape): string {
  const body = serializeBlocksToMarkdown(document.blocks)
  return body.trim() === '' ? `# ${document.title}\n` : `# ${document.title}\n\n${body}`
}

export function getDocumentMarkdownFileName(document: Pick<DocumentDetail, 'path' | 'title'>): string {
  const baseName = document.path.split('/').filter(Boolean).at(-1) || document.title || 'document'
  return `${baseName}.md`
}