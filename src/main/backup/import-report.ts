import { lstatSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import type { MarkdownImportReport, MarkdownImportFileResult, MarkdownImportIssueReason } from '@shared/contracts'
import { collectDocumentMarkdownCompatibility } from '@shared/markdownCompatibility'
import { parseLocalMarkdownUrl } from '@shared/markdownLinks'
import { collectDocumentMarkdownLinks } from '@shared/markdownLinkMaintenance'
import type { KnowbookStore } from '../database/store'
import { checkMarkdownAttachment } from '../markdown-attachment-check'

export type ImportedMarkdownFile = { sourceFilePath: string; documentId: string; status: 'created' | 'updated' }

/** Runs after all documents and assets have been restored, inside the transaction. */
export function createMarkdownImportReport(store: KnowbookStore, files: ImportedMarkdownFile[], root: string, assetRoot?: string, wikiAssets = new Map<string, string[]>()): MarkdownImportReport {
  const report: MarkdownImportReport = { files: [], issueCount: 0, ignoredExternalCount: 0 }
  const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  let remaining = 2000
  for (const file of files) {
    const document = store.getDocumentDetail(file.documentId)!
    const links = store.checkDocumentLinks(file.documentId, (url) => assetRoot ? checkMarkdownAttachment(url, assetRoot) : 'unmanaged-attachment')
    const sources = new Map(collectDocumentMarkdownLinks(document.blocks).map((link) => [`${link.blockId}:${link.start}`, link]))
    const issues = links.issues.map((issue) => {
      let reason: MarkdownImportIssueReason = issue.reason
      const local = parseLocalMarkdownUrl(issue.url)
      if (reason === 'unmanaged-attachment' && local?.path) {
        const source = sources.get(`${issue.blockId}:${issue.offset}`)
        const wiki = source?.kind === 'image' && source.syntax === 'wiki'
        const path = local.path.startsWith('/') || wiki && !/^\.\.?\//.test(local.path)
          ? resolve(root, local.path.replace(/^\//, '')) : resolve(dirname(file.sourceFilePath), local.path)
        if (normalize(path) !== normalize(root) && !normalize(path).startsWith(normalize(root) + sep)) reason = 'outside-import-root'
        else if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) reason = wiki && !local.path.includes('/') && (wikiAssets.get(local.path.toLowerCase())?.length ?? 0) > 1 ? 'ambiguous-reference' : 'missing-attachment'
      }
      return { reason, blockId: issue.blockId, offset: issue.offset, source: issue.url.slice(0, 240) }
    })
    const syntax = collectDocumentMarkdownCompatibility(document.blocks)
    // Unsupported embeds or external block syntax already explain the failure.
    const combined = [...issues.filter((issue) => !syntax.some((finding) => finding.reason === 'wiki-syntax'
      && finding.blockId === issue.blockId && issue.offset >= finding.offset && issue.offset <= finding.offset + finding.source.length)), ...syntax]
    const shown = combined.slice(0, Math.min(100, remaining))
    remaining -= shown.length
    const result: MarkdownImportFileResult = {
      sourcePath: relative(root, file.sourceFilePath).replace(/\\/g, '/'), documentPath: document.path,
      documentId: document.id, status: file.status, issues: shown, omittedIssueCount: combined.length - shown.length
    }
    report.files.push(result)
    report.issueCount += combined.length
    report.ignoredExternalCount += links.ignoredExternalCount
  }
  return report
}
