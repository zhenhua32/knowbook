import { serializeBlocksToMarkdown } from '@shared/markdown'
import type { DocumentBlockDraft, DocumentDetail } from '@shared/contracts'
import { normalizeComparableDocumentTitle } from './documentDraftComparison'

export type DocumentMarkdownExport = { fileName: string; markdown: string }
export type DocumentMarkdownSource = Pick<DocumentDetail, 'id' | 'path' | 'title' | 'updatedAt'> & { blocks: DocumentBlockDraft[] }
export type DraftMarkdownSource = DocumentMarkdownSource & { isCurrent: () => boolean }

type MarkdownDocumentShape = {
  title: string
  path?: string
  blocks: Array<Pick<DocumentBlockDraft, 'type' | 'content' | 'checked' | 'depth' | 'id' | 'parentBlockId' | 'language' | 'listStart' | 'markdownFormat'>>
}

export function buildDocumentMarkdown(document: MarkdownDocumentShape): string {
  if (document.blocks.some(block => block.type === 'synced-block')) throw new Error('此文档需要完整的同步块快照才能导出 Markdown。')
  const first = document.blocks[0]
  const header = first?.type === 'frontmatter' ? first.content + '\n\n' : ''
  const body = serializeBlocksToMarkdown(header ? document.blocks.slice(1) : document.blocks)
  return formatDocumentMarkdown(document.title, body, header)
}

function formatDocumentMarkdown(title: string, body: string, header: string): string {
  return header + (body.trim() === '' ? `# ${title}\n` : `# ${title}\n\n${body}`)
}

export function getDocumentMarkdownFileName(document: Pick<DocumentDetail, 'path' | 'title'>): string {
  const baseName = document.path.split('/').filter(Boolean).at(-1) || document.title || 'document'
  return `${baseName}.md`
}

export function buildDraftMarkdownExport(document: MarkdownDocumentShape): DocumentMarkdownExport {
  const title = normalizeComparableDocumentTitle(document.title)
  return { fileName: `${title}.md`, markdown: buildDocumentMarkdown({ title, blocks: document.blocks }) }
}

export async function readDocumentMarkdownExport(document: DocumentMarkdownSource | DraftMarkdownSource): Promise<DocumentMarkdownExport> {
  const draft = 'isCurrent' in document
  if (!document.blocks.some(block => block.type === 'synced-block')) return draft ? buildDraftMarkdownExport(document)
    : { fileName: getDocumentMarkdownFileName(document), markdown: buildDocumentMarkdown(document) }
  const title = draft ? normalizeComparableDocumentTitle(document.title) : document.title
  const first = document.blocks[0]
  const header = first?.type === 'frontmatter' ? first.content + '\n\n' : ''
  const { readSyncedDocumentMarkdownBody } = await import('../features/synced-blocks/documentMarkdownExport')
  const body = await readSyncedDocumentMarkdownBody(document, header ? document.blocks.slice(1) : document.blocks)
  return { fileName: draft ? `${title}.md` : getDocumentMarkdownFileName(document), markdown: formatDocumentMarkdown(title, body, header) }
}
