import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BackupResult } from '@shared/contracts'
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
    const frontmatter = [
      '---',
      `id: ${document.id}`,
      `title: ${document.title}`,
      `path: ${document.path}`,
      `updatedAt: ${document.updatedAt}`,
      `summary: ${document.summary}`,
      '---',
      ''
    ].join('\n')

    const body = document.blocks
      .map((block) => this.renderBlock(block.type, block.content))
      .join('\n\n')

    return `${frontmatter}${body}\n`
  }

  private renderBlock(type: string, content: string): string {
    if (type === 'heading-1') {
      return `# ${content}`
    }

    if (type === 'heading-2') {
      return `## ${content}`
    }

    if (type === 'todo') {
      return `- [ ] ${content}`
    }

    if (type === 'quote') {
      return `> ${content}`
    }

    if (type === 'bulleted-list') {
      return `- ${content}`
    }

    if (type === 'numbered-list') {
      return `1. ${content}`
    }

    if (type === 'divider') {
      return '---'
    }

    if (type === 'code') {
      return ['```txt', content, '```'].join('\n')
    }

    return content
  }
}