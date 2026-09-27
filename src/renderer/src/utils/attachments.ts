import { ATTACHMENT_MAX_BATCH_BYTES, ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_FILES, attachmentMarkdown, type ManagedAttachment } from '@shared/attachments'
import type { DocumentBlockDraft } from '@shared/contracts'

export async function importAttachmentFiles(files: File[]): Promise<ManagedAttachment[]> {
  if (!files.length || files.length > ATTACHMENT_MAX_FILES) throw new Error('一次最多导入 20 个文件。Import up to 20 files at a time.')
  if (files.some(file => file.size > ATTACHMENT_MAX_FILE_BYTES)) throw new Error('单个附件不能超过 25 MB。Each attachment must be at most 25 MB.')
  if (files.reduce((sum, file) => sum + file.size, 0) > ATTACHMENT_MAX_BATCH_BYTES) throw new Error('附件总大小不能超过 100 MB。Attachments must total at most 100 MB.')
  const inputs = []
  for (const file of files) inputs.push({ name: file.name || 'image.png', bytes: new Uint8Array(await file.arrayBuffer()) })
  return window.knowbook.importAttachments(inputs)
}

export type AttachmentInsertion = { blockId: string; content: string; start: number; end: number }

export function insertAttachmentBlocks(blocks: DocumentBlockDraft[], attachments: ManagedAttachment[], target?: AttachmentInsertion): DocumentBlockDraft[] {
  const markdown = attachments.map(attachmentMarkdown)
  const index = target ? blocks.findIndex(block => block.id === target.blockId) : -1
  if (target && (index < 0 || blocks[index].content !== target.content)) throw new Error('正文已变化，附件尚未插入，请重试。The text changed; retry inserting the attachments.')
  if (target && !['code', 'math', 'table', 'frontmatter', 'html', 'divider'].includes(blocks[index].type)) {
    return blocks.map((block, position) => position === index ? { ...block, content: block.content.slice(0, target.start) + markdown.join('\n') + block.content.slice(target.end) } : block)
  }
  const additions: DocumentBlockDraft[] = markdown.map(content => ({ id: crypto.randomUUID(), type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null }))
  const insertionIndex = target ? index + 1 : blocks.length
  return [...blocks.slice(0, insertionIndex), ...additions, ...blocks.slice(insertionIndex)]
}
