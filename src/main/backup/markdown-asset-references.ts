import { parseMarkdownBackupDocument } from '@shared/markdown'
import { extractMarkdownFrontmatter } from '@shared/markdownFrontmatter'
import { collectMarkdownDestinations, rewriteMarkdownDestinations } from '@shared/markdownLinks'

function metadataEnd(markdown: string): number {
  const header = extractMarkdownFrontmatter(markdown)
  return header && parseMarkdownBackupDocument(markdown).isKnowbookBackup ? header.end : 0
}

/** Only recognized backup metadata has non-Markdown asset fields. Ordinary
 * YAML, code, math and literal examples must never trigger asset IO or edits. */
export function collectBackupAssetReferences(markdown: string, metadataPattern: RegExp): string[] {
  const headerEnd = metadataEnd(markdown)
  return [...new Set([
    ...collectMarkdownDestinations(markdown).map((link) => link.url),
    ...markdown.slice(0, headerEnd).match(metadataPattern) ?? []
  ])]
}

export function rewriteBackupAssetReferences(markdown: string, metadataPattern: RegExp, rewrite: (url: string) => string | null | undefined): string {
  const headerEnd = metadataEnd(markdown)
  const rewritten = rewriteMarkdownDestinations(markdown, ({ url }) => rewrite(url))
  return rewritten.slice(0, headerEnd).replace(metadataPattern, (url) => rewrite(url) ?? url) + rewritten.slice(headerEnd)
}
