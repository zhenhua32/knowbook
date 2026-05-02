import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MarkdownBackupService } from '../src/main/backup/exporter.ts'

test('MarkdownBackupService exports nested markdown files and persists backup timestamp', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-backup-test-'))
  const backupRoot = join(tempRoot, 'backup')

  const savedSettings: Array<{ key: string; value: string }> = []
  const store = {
    getExportDocuments: () => [
      {
        id: 'doc-1',
        title: 'Root',
        path: 'Root',
        summary: 'Root summary',
        updatedAt: '2026-05-02T00:00:00.000Z',
        blocks: [
          { id: 'b1', type: 'heading-1', content: 'Root', checked: false, depth: 0, parentBlockId: null, sortOrder: 0 },
          { id: 'b2', type: 'code', content: 'SELECT 1', checked: false, depth: 0, parentBlockId: null, sortOrder: 1 }
        ]
      },
      {
        id: 'doc-2',
        title: 'Child',
        path: 'Root/Child',
        summary: 'Child summary',
        updatedAt: '2026-05-02T00:00:00.000Z',
        blocks: [
          { id: 'b3', type: 'bulleted-list', content: 'Item', checked: false, depth: 0, parentBlockId: null, sortOrder: 0 },
          { id: 'b4', type: 'bulleted-list', content: 'Nested', checked: false, depth: 0, parentBlockId: 'b3', sortOrder: 1 }
        ]
      }
    ],
    saveSetting: (key: string, value: string) => {
      savedSettings.push({ key, value })
    }
  }

  try {
    const service = new MarkdownBackupService(store as never, backupRoot)
    const result = service.exportAll()

    assert.equal(result.exported, 2)
    assert.equal(result.root, backupRoot)
    assert.equal(savedSettings.length, 1)
    assert.equal(savedSettings[0]?.key, 'backup.lastRunAt')
    assert.equal(/^\d{4}-\d{2}-\d{2}T/.test(savedSettings[0]?.value ?? ''), true)

    const rootFile = join(backupRoot, 'Root.md')
    const childFile = join(backupRoot, 'Root', 'Child.md')

    assert.equal(statSync(rootFile).isFile(), true)
    assert.equal(statSync(childFile).isFile(), true)

    const rootContent = readFileSync(rootFile, 'utf8')
    const childContent = readFileSync(childFile, 'utf8')

    assert.equal(rootContent.includes('id: doc-1'), true)
    assert.equal(rootContent.includes('summary: Root summary'), true)
    assert.equal(rootContent.includes('```txt\nSELECT 1\n```'), true)

    assert.equal(childContent.includes('- Item\n\n  - Nested'), true)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
