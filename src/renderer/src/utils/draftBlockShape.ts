import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'

export function isNestableBlock(type: string) {
  return ['todo', 'numbered-todo', 'bulleted-list', 'numbered-list'].includes(type)
}

export function normalizeBlockDepth(type: string, depth: number) {
  return isNestableBlock(type) ? Math.max(0, Math.min(6, Math.trunc(depth))) : 0
}

export function toDraftBlock(
  block: Pick<DocumentBlock, 'id' | 'type' | 'content' | 'checked' | 'depth' | 'parentBlockId' | 'tags' | 'language' | 'listStart' | 'markdownFormat' | 'highlight'>
): DocumentBlockDraft {
  return {
    id: block.id,
    type: block.type,
    content: block.content,
    checked: Boolean(block.checked),
    depth: normalizeBlockDepth(block.type, block.depth),
    parentBlockId: block.parentBlockId ?? null,
    tags: block.tags ? [...block.tags] : undefined,
    language: block.language,
    ...(block.listStart === undefined ? {} : { listStart: block.listStart }),
    ...(block.markdownFormat === undefined ? {} : { markdownFormat: { ...block.markdownFormat } }),
    highlight: block.highlight
  }
}
