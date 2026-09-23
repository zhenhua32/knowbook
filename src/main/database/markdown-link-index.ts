import type Database from 'better-sqlite3'
import type { DocumentBlockDraft, DocumentLinkCheck, DocumentLinkIssueReason } from '@shared/contracts'
import { decodeMarkdownFormat } from '@shared/markdownFormat'
import { collectDocumentMarkdownLinks, getMarkdownHeadingRewrites, getMarkdownHeadingTargets, rewriteDocumentMarkdownLinks, rewriteLocalMarkdownLink, type MarkdownPathChange } from '@shared/markdownLinkMaintenance'
import { parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '@shared/markdownLinks'
import { findWikiHeading, parseWikiReference, resolveWikiDocument, rewriteWikiReference, wikiDocumentPaths } from '@shared/markdownWiki'

export type MarkdownIndexedDocument = { id: string; path: string; title: string; blocks: DocumentBlockDraft[] }
export type MarkdownIndexedPathChange = MarkdownPathChange & { id: string }

/** Derived source index. Keep it in the same SQLite transaction as document
 * edits so a crash cannot leave link maintenance using stale destinations. */
export class MarkdownLinkIndex {
  constructor(private readonly db: Database.Database) {}

  resolveWiki(token: string, sourcePath: string, headings = new Map<string, ReturnType<typeof getMarkdownHeadingTargets>>()) {
    type Target = { id: string; path: string }
    const resolved = resolveWikiDocument(token, sourcePath, {
      byPath: (name) => (this.db.prepare('SELECT id, path FROM documents WHERE path = ?').get(name)
        ?? this.db.prepare('SELECT id, path FROM documents WHERE path = ? COLLATE NOCASE LIMIT 1').get(name)) as Target | undefined,
      byTitle: (name) => this.db.prepare('SELECT id, path FROM documents WHERE title = ? COLLATE NOCASE LIMIT 2').all(name) as Target[]
    })
    if (!resolved) return null
    const { document, reference } = resolved
    if (!reference.fragment) return { ...document, reference, fragment: '', kind: 'document' as const, exists: true }
    if (this.db.prepare('SELECT 1 FROM blocks WHERE document_id = ? AND id = ?').get(document.id, reference.fragment)) {
      return { ...document, reference, fragment: reference.fragment, kind: 'block' as const, exists: true }
    }
    let targets = headings.get(document.id)
    if (!targets) {
      const detail = this.readDocument(document.id)!
      targets = getMarkdownHeadingTargets(detail.blocks, detail.title); headings.set(document.id, targets)
    }
    const heading = findWikiHeading(reference.fragment, targets)
    const legacyBlock = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(reference.fragment) || reference.fragment.startsWith('^')
    return { ...document, reference, fragment: heading?.slug ?? reference.fragment,
      kind: legacyBlock ? 'block' as const : 'heading' as const, exists: Boolean(heading) }
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
    const headings = new Map<string, ReturnType<typeof getMarkdownHeadingTargets>>()
    for (const link of collectDocumentMarkdownLinks(document.blocks)) {
      if (link.kind !== 'wiki' && !parseLocalMarkdownUrl(link.url) && !link.url.startsWith('file:')) continue
      const wiki = link.kind === 'wiki' ? this.resolveWiki(link.url, document.path, headings) : null
      const target = link.kind === 'wiki' ? wiki : link.kind === 'image' ? null : resolveMarkdownDocumentPath(document.path, link.url)
      insert.run(id, link.blockId, link.start, link.url, wiki?.kind === 'heading' ? 'wiki-heading' : link.kind, target?.path ?? null, target?.fragment ?? null)
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
    const wikiHeadings = new Map<string, ReturnType<typeof getMarkdownHeadingTargets>>()
    const byPath = this.db.prepare('SELECT id FROM documents WHERE path = ?')
    const blockExists = this.db.prepare('SELECT 1 FROM blocks WHERE document_id = ? AND id = ?')
    for (const link of collectDocumentMarkdownLinks(document.blocks)) {
      let reason: DocumentLinkIssueReason | null = null
      if (link.kind === 'wiki') {
        const reference = parseWikiReference(link.url)
        const target = this.resolveWiki(link.url, document.path, wikiHeadings)
        if (target) {
          if (!target.exists) reason = target.kind === 'block' ? 'missing-block' : 'missing-heading'
        } else if (!reference.hasFragment && blockExists.get(documentId, reference.target)) {
          // A bare block ID is a valid local block reference.
        } else if ((this.db.prepare('SELECT id FROM documents WHERE title = ? COLLATE NOCASE LIMIT 2').all(reference.path.replace(/\.md$/i, ''))).length > 1) {
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

  maintain(changes: MarkdownIndexedPathChange[], changedSources: Iterable<string>, now: string, authoritativeSources: ReadonlySet<string> = new Set(), syncedSources: Set<string> = new Set()): string[] {
    const byOldPath = new Map(changes.map((change) => [change.before, change]))
    const oldSourcePaths = new Map(changes.map((change) => [change.id, change.before]))
    const sources = new Set(changedSources)
    const incoming = this.db.prepare('SELECT DISTINCT source_document_id AS id FROM markdown_link_sources WHERE target_path = ?')
    const incomingHeadings = this.db.prepare(`SELECT DISTINCT source_document_id AS id FROM markdown_link_sources
      WHERE target_path = ? AND (kind = 'wiki-heading' OR (kind != 'wiki' AND fragment IN (SELECT value FROM json_each(?))))`)
    for (const change of changes) {
      sources.add(change.id)
      // A heading edit cannot change links to the document top, stable headings
      // or Wiki block IDs. Path moves still visit every incoming source.
      const candidates = change.before !== change.after ? incoming.all(change.before)
        : change.headings?.size ? incomingHeadings.all(change.before, JSON.stringify([...change.headings.keys()].filter(Boolean))) : []
      for (const { id } of candidates as Array<{ id: string }>) sources.add(id)
    }
    const updateBlock = this.db.prepare('UPDATE blocks SET content = ?, updated_at = ? WHERE id = ? AND document_id = ?')
    const touchDocument = this.db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?')
    const affected: string[] = []
    const changedHeadingLabels: MarkdownIndexedPathChange[] = []
    for (const id of sources) {
      if (authoritativeSources.has(id)) { this.syncDocument(id); syncedSources.add(id); continue }
      const document = this.readDocument(id)
      if (!document) continue
      const wikiBindings = new Map((this.db.prepare(`SELECT source_block_id, url, target_path, fragment, kind FROM markdown_link_sources
        WHERE source_document_id = ? AND kind IN ('wiki', 'wiki-heading')`).all(id) as Array<{ source_block_id: string; url: string; target_path: string | null; fragment: string | null; kind: string }>)
        .map((row) => [JSON.stringify([row.source_block_id, row.url]), row]))
      let wikiChanged = false
      const rewritten = changes.length ? rewriteDocumentMarkdownLinks(document.blocks, (link) => {
        if (link.kind === 'image') return null
        if (link.kind === 'wiki') {
          const binding = wikiBindings.get(JSON.stringify([link.blockId, link.url]))
          let reference = parseWikiReference(link.url)
          if (binding?.target_path === link.url) reference = { target: link.url, path: link.url, fragment: '', hasFragment: false, alias: null }
          else if (binding?.target_path && /[#|]/.test(binding.target_path) && link.url.startsWith(binding.target_path + '#')) {
            const tail = parseWikiReference(link.url.slice(binding.target_path.length + 1))
            reference = { target: link.url, path: binding.target_path, fragment: tail.target, hasFragment: true, alias: tail.alias }
          }
          const oldTarget = binding?.target_path ?? wikiDocumentPaths(reference.path, oldSourcePaths.get(id) ?? document.path).find((path) => byOldPath.has(path))
          const target = oldTarget ? byOldPath.get(oldTarget) : undefined
          const fragment = binding?.kind === 'wiki-heading' ? target?.headings?.get(binding.fragment ?? '') : undefined
          const movedSource = /^\.\.?\//.test(reference.path) && oldSourcePaths.has(id)
          if ((!target || target.before === target.after && fragment === undefined) && !movedSource) return null
          if (!oldTarget) return null
          wikiChanged = true
          const path = !reference.path ? '' : target?.before !== target?.after || movedSource ? target?.after ?? oldTarget : reference.path
          return rewriteWikiReference(reference, path, fragment ?? reference.fragment)
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
      syncedSources.add(id)
    }
    // Rewriting a Wiki link can also change the visible text of a heading in
    // its source. Propagate that anchor change after the path pass completes.
    const cascaded = changedHeadingLabels.length ? this.maintain(changedHeadingLabels, [], now, authoritativeSources, syncedSources) : []
    return [...new Set([...affected, ...cascaded])]
  }
}
