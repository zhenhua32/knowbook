import { lstatSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import type { MarkdownImportReport, MarkdownImportFileResult, MarkdownImportIssueReason } from '@shared/contracts'
import { collectDocumentMarkdownCompatibility } from '@shared/markdownCompatibility'
import { parseLocalMarkdownUrl } from '@shared/markdownLinks'
import type { KnowbookStore } from '../database/store'
import { checkMarkdownAttachment } from '../markdown-attachment-check'

export type ImportedMarkdownFile = { sourceFilePath: string; documentId: string; status: 'created' | 'updated' }

/** Runs after all documents and assets have been restored, inside the transaction. */
export function createMarkdownImportReport(store: KnowbookStore, files: ImportedMarkdownFile[], root: string, assetRoot?: string): MarkdownImportReport {
  const report: MarkdownImportReport = { files: [], issueCount: 0, ignoredExternalCount: 0 }
  const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  let remaining = 2000
  for (const file of files) {
    const document = store.getDocumentDetail(file.documentId)!
    const links = store.checkDocumentLinks(file.documentId, (url) => assetRoot ? checkMarkdownAttachment(url, assetRoot) : 'unmanaged-attachment')
    const issues = links.issues.map((issue) => {
      let reason: MarkdownImportIssueReason = issue.reason
      const local = parseLocalMarkdownUrl(issue.url)
      if (reason === 'unmanaged-attachment' && local?.path) {
        const path = local.path.startsWith('/') ? resolve(root, local.path.slice(1)) : resolve(dirname(file.sourceFilePath), local.path)
        if (normalize(path) !== normalize(root) && !normalize(path).startsWith(normalize(root) + sep)) reason = 'outside-import-root'
        else if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) reason = 'missing-attachment'
      }
      return { reason, blockId: issue.blockId, offset: issue.offset, source: issue.url.slice(0, 240) }
    })
    const syntax = collectDocumentMarkdownCompatibility(document.blocks).filter((finding) => finding.reason !== 'wiki-syntax'
      || finding.source.startsWith('!') || links.issues.some((issue) => issue.blockId === finding.blockId
        && issue.offset >= finding.offset && issue.offset <= finding.offset + finding.source.length))
    // A foreign wiki alias/embed already explains why that same reference fails.
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
