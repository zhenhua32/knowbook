import { parseMarkdownBackupDocument, renderMarkdownFrontmatter } from '@shared/markdown'
import { extractMarkdownFrontmatter, KNOWBOOK_BACKUP_MARKER } from '@shared/markdownFrontmatter'
import { collectMarkdownDestinations, rewriteMarkdownDestinations } from '@shared/markdownLinks'
import { backupJson, parseBackupJson, readV2Header } from './v2-format'

/** V2 source configs are opaque data. Only actual typed field values carry
 * portable assets, never queries, filter strings, options or source IDs. */
function v2AssetFields(markdown: string, visit: (value: string) => string): string | null {
  const header = readV2Header(markdown)
  if (!header) return null
  const values = (input: unknown): unknown => {
    if (typeof input === 'string') return visit(input)
    if (Array.isArray(input)) return input.map(value => typeof value === 'string' ? visit(value) : value)
    return input
  }
  const fieldValues = (input: unknown): unknown => input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).map(([key, value]) => [key, values(value)])) : input
  if (header.documentDatabaseFieldValues !== undefined) header.documentDatabaseFieldValues = backupJson(fieldValues(parseBackupJson(header.documentDatabaseFieldValues)))
  if (header.databaseEntities !== undefined) {
    const entities = parseBackupJson(header.databaseEntities)
    if (Array.isArray(entities)) header.databaseEntities = backupJson(entities.map(value => value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, fieldValues: fieldValues((value as Record<string, unknown>).fieldValues) } : value))
  }
  const old = extractMarkdownFrontmatter(markdown)!
  return renderMarkdownFrontmatter(header) + old.body.slice(KNOWBOOK_BACKUP_MARKER.length).replace(/^\r?\n/, '')
}

function metadataEnd(markdown: string): number {
  const header = extractMarkdownFrontmatter(markdown)
  return header && parseMarkdownBackupDocument(markdown).isKnowbookBackup ? header.end : 0
}

/** Only recognized backup metadata has non-Markdown asset fields. Ordinary
 * YAML, code, math and literal examples must never trigger asset IO or edits. */
export function collectBackupAssetReferences(markdown: string, metadataPattern: RegExp): string[] {
  const metadata: string[] = []
  const strict = v2AssetFields(markdown, value => { metadata.push(...value.match(metadataPattern) ?? []); return value })
  const headerEnd = metadataEnd(markdown)
  return [...new Set([
    ...collectMarkdownDestinations(markdown).map((link) => link.url),
    ...(strict === null ? markdown.slice(0, headerEnd).match(metadataPattern) ?? [] : metadata)
  ])]
}

export function rewriteBackupAssetReferences(markdown: string, metadataPattern: RegExp, rewrite: (url: string) => string | null | undefined): string {
  const strict = v2AssetFields(markdown, value => value.replace(metadataPattern, url => rewrite(url) ?? url))
  if (strict !== null) return rewriteMarkdownDestinations(strict, ({ url }) => rewrite(url))
  const headerEnd = metadataEnd(markdown)
  const rewritten = rewriteMarkdownDestinations(markdown, ({ url }) => rewrite(url))
  return rewritten.slice(0, headerEnd).replace(metadataPattern, (url) => rewrite(url) ?? url) + rewritten.slice(headerEnd)
}
