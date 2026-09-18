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
  const body = serializeBlocksToMarkdown(document.blocks)
  return body.trim() === '' ? `# ${document.title}\n` : `# ${document.title}\n\n${body}`
}

export function getDocumentMarkdownFileName(document: Pick<DocumentDetail, 'path' | 'title'>): string {
  const baseName = document.path.split('/').filter(Boolean).at(-1) || document.title || 'document'
  return `${baseName}.md`
}

export function buildDraftMarkdownExport(document: MarkdownDocumentShape): DocumentMarkdownExport {
  const title = normalizeComparableDocumentTitle(document.title)
  return { fileName: `${title}.md`, markdown: buildDocumentMarkdown({ title, blocks: document.blocks }) }
}
