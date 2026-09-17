import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KnowbookStore } from '../src/main/database/store.ts'
import { MarkdownRestoreService } from '../src/main/backup/importer.ts'
import { MarkdownBackupService } from '../src/main/backup/exporter.ts'
import { writeMarkdownFile } from '../src/main/backup/markdown-file.ts'
import { buildDraftMarkdownExport } from '../src/renderer/src/utils/documentMarkdown.ts'
import { collectMarkdownDestinations, parseLocalMarkdownUrl } from '../src/shared/markdownLinks.ts'

test('ordinary relative images, attachments and document links survive import, standalone export and backup on a new workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-markdown-links-'))
  const stores: KnowbookStore[] = []
  const file = (name: string, content: string | Buffer) => { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path }
  try {
    const originalImage = Buffer.from('image fixture')
    file('input/images/中文 图(1).png', originalImage)
    file('input/附件.pdf', 'attachment')
    file('input/Docs/Start.md', '# Start\n\n![图片](<../images/中文 图(1).png>)\n\n[附件](../附件.pdf)\n\n[下章](../Next.md#安装)\n\n![ref][picture]\n\n[picture]: ../images/中文%20图(1).png\n\n`![code](../images/中文%20图(1).png)`\n\n![missing](missing.png)')
    file('input/Next.md', '# Next\n\n## 安装\n\n[返回](Docs/Start.md#start)')
    const assetRoot = join(root, 'managed')
    const store = new KnowbookStore(join(root, 'original.sqlite')); stores.push(store)
    await new MarkdownRestoreService(store, assetRoot).restoreFromDirectory(join(root, 'input'))
    const detail = store.getDocumentDetail(store.getAllDocumentSnapshots().find((doc) => doc.path === 'Docs/Start')!.id)!
    const markdown = buildDraftMarkdownExport(detail).markdown
    const urls = collectMarkdownDestinations(markdown).map((entry) => entry.url)
    const imageUrl = urls.find((url) => url.startsWith('file:') && url.endsWith('.png'))!
    assert.deepEqual(readFileSync(fileURLToPath(imageUrl)), originalImage)
    assert.ok(markdown.includes('[下章](../Next.md#安装)'))
    assert.ok(markdown.includes('`![code](../images/中文%20图(1).png)`'))
    assert.ok(markdown.includes('![missing](missing.png)'))
    rmSync(join(root, 'input'), { recursive: true, force: true })
    assert.ok(existsSync(fileURLToPath(imageUrl)), 'import owns a persistent copy')

    const exported = join(root, 'export', 'Docs', 'Start.md')
    writeMarkdownFile(exported, markdown, assetRoot)
    const exportedMarkdown = readFileSync(exported, 'utf8')
    assert.ok(!exportedMarkdown.includes('file:///'))
    const image = collectMarkdownDestinations(exportedMarkdown).find((entry) => entry.kind === 'image' && entry.url.includes('.assets/'))!
    assert.deepEqual(readFileSync(join(dirname(exported), parseLocalMarkdownUrl(image.url)!.path)), originalImage)
    const next = store.getDocumentDetail(store.getAllDocumentSnapshots().find((doc) => doc.path === 'Next')!.id)!
    writeMarkdownFile(join(root, 'export', 'Next.md'), buildDraftMarkdownExport(next).markdown, assetRoot)
    const imported = new KnowbookStore(join(root, 'imported.sqlite')); stores.push(imported)
    await new MarkdownRestoreService(imported, join(root, 'managed-2')).restoreFromDirectory(join(root, 'export'))
    const importedDetail = imported.getDocumentDetail(imported.getAllDocumentSnapshots().find((doc) => doc.path === 'Docs/Start')!.id)!
    const restoredImage = collectMarkdownDestinations(buildDraftMarkdownExport(importedDetail).markdown).find((entry) => entry.kind === 'image' && entry.url.startsWith('file:'))!
    assert.deepEqual(readFileSync(fileURLToPath(restoredImage.url)), originalImage)

    await new MarkdownBackupService(store, join(root, 'backup'), assetRoot).exportAll()
    const restored = new KnowbookStore(join(root, 'restored.sqlite')); stores.push(restored)
    await new MarkdownRestoreService(restored, join(root, 'managed-3')).restoreFromDirectory(join(root, 'backup'))
    const restoredDetail = restored.getDocumentDetail(restored.getAllDocumentSnapshots().find((doc) => doc.path === 'Docs/Start')!.id)!
    assert.ok(buildDraftMarkdownExport(restoredDetail).markdown.includes('[下章](../Next.md#安装)'))
    const backupImage = collectMarkdownDestinations(buildDraftMarkdownExport(restoredDetail).markdown).find((entry) => entry.kind === 'image' && entry.url.startsWith('file:'))!
    assert.deepEqual(readFileSync(fileURLToPath(backupImage.url)), originalImage)
  } finally { stores.forEach((store) => store.destroy()); rmSync(root, { recursive: true, force: true }) }
})

test('relative asset import cannot read outside the selected directory and applies asset size limits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-relative-boundary-'))
  const store = new KnowbookStore(join(root, 'store.sqlite'))
  try {
    const input = join(root, 'input'); mkdirSync(input)
    writeFileSync(join(root, 'outside.png'), 'outside')
    writeFileSync(join(input, 'Test.md'), '![outside](../outside.png)\n\n![encoded](%2e%2e/outside.png)')
    await new MarkdownRestoreService(store, join(root, 'assets')).restoreFromDirectory(input)
    const markdown = store.getDocumentDetail(store.getAllDocumentSnapshots().find((doc) => doc.path === 'Test')!.id)!.blocks.map((block) => block.content).join('\n')
    assert.ok(!markdown.includes('file:'))
    assert.equal(existsSync(join(root, 'assets')), false)
    writeFileSync(join(input, 'large.png'), 'too large')
    writeFileSync(join(input, 'Test.md'), '![large](large.png)')
    await assert.rejects(new MarkdownRestoreService(store, join(root, 'assets'), { maxAssetFileBytes: 2 }).restoreFromDirectory(input), /asset exceeds/)
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('backup filename escaping and document metadata preserve cross-file targets through restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-linked-paths-'))
  const stores: KnowbookStore[] = []
  try {
    const input = join(root, 'input'); mkdirSync(input)
    writeFileSync(join(input, 'Start.md'), '---\npath: Docs?/入口\n---\n\n[目标](Target.md#section)\n\n[定义][ref]\n\n[ref]: Target.md#section')
    writeFileSync(join(input, 'Target.md'), '---\npath: Other?/目标\n---\n\n## Section\n\n[返回](Start.md)')
    const store = new KnowbookStore(join(root, 'store.sqlite')); stores.push(store)
    await new MarkdownRestoreService(store).restoreFromDirectory(input)
    const body = (db: KnowbookStore, path: string) => buildDraftMarkdownExport(db.getDocumentDetail(db.getAllDocumentSnapshots().find((doc) => doc.path === path)!.id)!).markdown
    const original = body(store, 'Docs?/入口')
    assert.ok(original.includes('../Other%3F/%E7%9B%AE%E6%A0%87.md#section'))
    await new MarkdownBackupService(store, join(root, 'backup')).exportAll()
    const restored = new KnowbookStore(join(root, 'restored.sqlite')); stores.push(restored)
    await new MarkdownRestoreService(restored).restoreFromDirectory(join(root, 'backup'))
    assert.equal(body(restored, 'Docs?/入口'), original)
    assert.equal(body(restored, 'Other?/目标'), body(store, 'Other?/目标'))
  } finally { stores.forEach((store) => store.destroy()); rmSync(root, { recursive: true, force: true }) }
})
