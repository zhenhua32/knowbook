import type Database from 'better-sqlite3'
import type { DocumentBlockDraft, DocumentLinkCheck, DocumentLinkIssueReason } from '@shared/contracts'
import { decodeMarkdownFormat } from '@shared/markdownFormat'
import { collectDocumentMarkdownLinks, getMarkdownHeadingRewrites, getMarkdownHeadingTargets, rewriteDocumentMarkdownLinks, rewriteLocalMarkdownLink, type MarkdownPathChange } from '@shared/markdownLinkMaintenance'
import { parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '@shared/markdownLinks'

export type MarkdownIndexedDocument = { id: string; path: string; title: string; blocks: DocumentBlockDraft[] }
export type MarkdownIndexedPathChange = MarkdownPathChange & { id: string }

/** Derived source index. Keep it in the same SQLite transaction as document
 * edits so a crash cannot leave link maintenance using stale destinations. */
export class MarkdownLinkIndex {
  constructor(private readonly db: Database.Database) {}

  resolveWiki(token: string): { path: string; fragment: string } | null {
    const separator = token.lastIndexOf('#')
    const name = separator < 0 ? token : token.slice(0, separator).trim()
    if (!name) return null
    const byPath = this.db.prepare('SELECT path FROM documents WHERE path = ?').get(name) as { path: string } | undefined
    if (byPath) return { path: byPath.path, fragment: separator < 0 ? '' : token.slice(separator + 1).trim() }
    if (separator >= 0) return null
    const byTitle = this.db.prepare('SELECT path FROM documents WHERE title = ? LIMIT 2').all(name) as Array<{ path: string }>
    return byTitle.length === 1 ? { path: byTitle[0].path, fragment: '' } : null
  }

  readDocument(id: string): MarkdownIndexedDocument | null {
    const document = this.db.prepare('SELECT id, path, title FROM documents WHERE id = ?').get(id) as Omit<MarkdownIndexedDocument, 'blocks'> | undefined
    if (!document) return null
    const rows = this.db.prepare(`SELECT id, type, content, checked, depth, parent_block_id, language, list_start, markdown_format_json
      FROM blocks WHERE document_id = ? ORDER BY sort_order ASC`).all(id) as Array<{
        id: string; type: string; content: string; checked: number; depth: number; parent_block_id: string | null
        language: string | null; list_start: number | null; markdown_format_json: string | null
      }>
    return { ...document, blocks: rows.map((row) => ({ id: row.id, type: row.type, content: row.content,
      checked: Boolean(row.checked), depth: row.depth, parentBlockId: row.parent_block_id,
      language: row.language ?? undefined, listStart: row.list_start ?? undefined,
      markdownFormat: decodeMarkdownFormat(row.type, row.markdown_format_json) })) }
  }

  syncDocument(id: string): void {
    const document = this.readDocument(id)
    this.db.prepare('DELETE FROM markdown_link_sources WHERE source_document_id = ?').run(id)
    if (!document) return
    const insert = this.db.prepare(`INSERT INTO markdown_link_sources
      (source_document_id, source_block_id, source_offset, url, kind, target_path, fragment) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    for (const link of collectDocumentMarkdownLinks(document.blocks)) {
      if (link.kind !== 'wiki' && !parseLocalMarkdownUrl(link.url) && !link.url.startsWith('file:')) continue
      const target = link.kind === 'wiki' ? this.resolveWiki(link.url) : link.kind === 'image' ? null : resolveMarkdownDocumentPath(document.path, link.url)
      insert.run(id, link.blockId, link.start, link.url, link.kind, target?.path ?? null, target?.fragment ?? null)
    }
  }

  rebuild(): void {
    this.db.prepare('DELETE FROM markdown_link_sources').run()
    for (const { id } of this.db.prepare('SELECT id FROM documents').all() as Array<{ id: string }>) this.syncDocument(id)
  }

  check(documentId: string, attachmentCheck: (url: string) => DocumentLinkIssueReason | null): DocumentLinkCheck {
    const document = this.readDocument(documentId)
    if (!document) throw new Error('Document not found')
    const report: DocumentLinkCheck = { documentId, checkedAt: new Date().toISOString(), checkedCount: 0, ignoredExternalCount: 0, issues: [] }
    const headings = new Map<string, Set<string>>()
    const byPath = this.db.prepare('SELECT id FROM documents WHERE path = ?')
    const blockExists = this.db.prepare('SELECT 1 FROM blocks WHERE document_id = ? AND id = ?')
    for (const link of collectDocumentMarkdownLinks(document.blocks)) {
      let reason: DocumentLinkIssueReason | null = null
      if (link.kind === 'wiki') {
        const target = this.resolveWiki(link.url)
        if (target) {
          const id = (byPath.get(target.path) as { id: string }).id
          if (link.url.includes('#') && !blockExists.get(id, target.fragment)) reason = 'missing-block'
        } else if (!link.url.includes('#') && blockExists.get(documentId, link.url)) {
          // A bare block ID is a valid local block reference.
        } else if (!link.url.includes('#') && (this.db.prepare('SELECT id FROM documents WHERE title = ? LIMIT 2').all(link.url)).length > 1) {
          reason = 'ambiguous-reference'
        } else reason = 'missing-document'
      } else if (/^file:/i.test(link.url)) {
        reason = attachmentCheck(link.url)
      } else if (/^[a-z][a-z\d+.-]*:/i.test(link.url) || link.url.startsWith('//')) {
        report.ignoredExternalCount++; continue
      } else {
        const local = parseLocalMarkdownUrl(link.url)
        const target = link.kind === 'image' ? null : resolveMarkdownDocumentPath(document.path, link.url)
        if (!local || (!target && /\.md$/i.test(local.path) && link.kind !== 'image')) reason = 'invalid-path'
        else if (!target) reason = 'unmanaged-attachment'
        else {
          const row = byPath.get(target.path) as { id: string } | undefined
          if (!row) reason = 'missing-document'
          else if (target.fragment) {
            let slugs = headings.get(row.id)
            if (!slugs) {
              const detail = this.readDocument(row.id)!
              slugs = new Set(getMarkdownHeadingTargets(detail.blocks, detail.title).map((heading) => heading.slug))
              headings.set(row.id, slugs)
            }
            if (!slugs.has(target.fragment)) reason = 'missing-heading'
          }
        }
      }
      report.checkedCount++
      if (reason) report.issues.push({ blockId: link.blockId!, offset: link.start, url: link.url, reason })
    }
    return report
  }

  maintain(changes: MarkdownIndexedPathChange[], changedSources: Iterable<string>, now: string, authoritativeSources: ReadonlySet<string> = new Set()): string[] {
    const byOldPath = new Map(changes.map((change) => [change.before, change]))
    const oldSourcePaths = new Map(changes.map((change) => [change.id, change.before]))
    const sources = new Set(changedSources)
    const incoming = this.db.prepare('SELECT DISTINCT source_document_id AS id FROM markdown_link_sources WHERE target_path = ?')
    for (const change of changes) {
      sources.add(change.id)
      for (const { id } of incoming.all(change.before) as Array<{ id: string }>) sources.add(id)
    }
    const updateBlock = this.db.prepare('UPDATE blocks SET content = ?, updated_at = ? WHERE id = ? AND document_id = ?')
    const touchDocument = this.db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?')
    const affected: string[] = []
    const changedHeadingLabels: MarkdownIndexedPathChange[] = []
    for (const id of sources) {
      if (authoritativeSources.has(id)) { this.syncDocument(id); continue }
      const document = this.readDocument(id)
      if (!document) continue
      const wikiBindings = new Map((this.db.prepare(`SELECT source_block_id, url, target_path FROM markdown_link_sources
        WHERE source_document_id = ? AND kind = 'wiki'`).all(id) as Array<{ source_block_id: string; url: string; target_path: string | null }>)
        .map((row) => [JSON.stringify([row.source_block_id, row.url]), row.target_path]))
      let wikiChanged = false
      const rewritten = changes.length ? rewriteDocumentMarkdownLinks(document.blocks, (link) => {
        if (link.kind === 'image') return null
        if (link.kind === 'wiki') {
          const separator = link.url.lastIndexOf('#'), label = separator < 0 ? link.url : link.url.slice(0, separator).trim()
          const oldTarget = wikiBindings.get(JSON.stringify([link.blockId, link.url])) ?? (byOldPath.has(label) ? label : null)
          const target = oldTarget && byOldPath.get(oldTarget)
          if (!target || target.before === target.after) return null
          wikiChanged = true
          return target.after + (separator < 0 ? '' : link.url.slice(separator))
        }
        return rewriteLocalMarkdownLink(link.url, oldSourcePaths.get(id) ?? document.path, document.path, byOldPath)
      }) : document.blocks
      let changed = false
      for (let index = 0; index < rewritten.length; index++) {
        if (rewritten[index].content === document.blocks[index].content) continue
        updateBlock.run(rewritten[index].content, now, rewritten[index].id, id); changed = true
      }
      if (changed) { touchDocument.run(now, id); affected.push(id) }
      if (changed && wikiChanged) {
        const headings = getMarkdownHeadingRewrites(getMarkdownHeadingTargets(document.blocks, document.title), getMarkdownHeadingTargets(rewritten, document.title))
        if (headings.size) changedHeadingLabels.push({ id, before: document.path, after: document.path, headings })
      }
      this.syncDocument(id)
    }
    // Rewriting a Wiki link can also change the visible text of a heading in
    // its source. Propagate that anchor change after the path pass completes.
    const cascaded = changedHeadingLabels.length ? this.maintain(changedHeadingLabels, [], now, authoritativeSources) : []
    return [...new Set([...affected, ...cascaded])]
  }
}
