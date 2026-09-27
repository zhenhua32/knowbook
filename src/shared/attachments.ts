export const ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024
export const ATTACHMENT_MAX_BATCH_BYTES = 100 * 1024 * 1024
export const ATTACHMENT_MAX_FILES = 20

export type AttachmentInput = { name: string; bytes: Uint8Array }
export type ManagedAttachment = { url: string; name: string; size: number; kind: 'image' | 'file' }

export function isAttachmentImage(name: string): boolean {
  // SVG and HTML remain downloadable files, rather than active preview documents.
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(name)
}

export function attachmentMarkdown(attachment: ManagedAttachment): string {
  const label = attachment.name.replace(/[\r\n]/g, ' ').replace(/([\\`*_[\]<>])/g, '\\$1')
  return `${attachment.kind === 'image' ? '!' : ''}[${label}](<${attachment.url}>)`
}

export function formatAttachmentSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
