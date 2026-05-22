import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BackupResult } from '@shared/contracts'
import { renderMarkdownFrontmatter, serializeBlocksToMarkdown } from '@shared/markdown'
import type { ExportDocument, KnowbookStore } from '../database/store'

export class MarkdownBackupService {
  constructor(
    private readonly store: KnowbookStore,
    private readonly backupRoot: string
  ) {}

  exportAll(): BackupResult {
    const documents = this.store.getExportDocuments()
    for (const document of documents) {
      this.writeDocument(document)
    }

    const at = new Date().toISOString()
    this.store.saveSetting('backup.lastRunAt', at)

    return {
      exported: documents.length,
      root: this.backupRoot,
      at
    }
  }

  private writeDocument(document: ExportDocument): void {
    const filePath = join(this.backupRoot, ...document.path.split('/')) + '.md'
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, this.renderMarkdown(document), 'utf8')
  }

  private renderMarkdown(document: ExportDocument): string {
    const frontmatter = renderMarkdownFrontmatter({
      id: document.id,
      title: document.title,
      path: document.path,
      updatedAt: document.updatedAt,
      summary: document.summary
    })

    const body = serializeBlocksToMarkdown(document.blocks, {
      fallbackCodeLanguage: 'txt',
      includeBlockMetadata: true
    })

    return `${frontmatter}${body}\n`
  }
}