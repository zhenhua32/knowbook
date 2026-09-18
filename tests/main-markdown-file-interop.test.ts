import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KnowbookStore } from '../src/main/database/store.ts'
import { MarkdownRestoreService } from '../src/main/backup/importer.ts'
import { MarkdownBackupService } from '../src/main/backup/exporter.ts'
import { writeMarkdownFile } from '../src/main/backup/markdown-file.ts'
import { checkMarkdownAttachment } from '../src/main/markdown-attachment-check.ts'
import { buildDraftMarkdownExport } from '../src/renderer/src/utils/documentMarkdown.ts'
import { collectMarkdownDestinations, resolveMarkdownDocumentPath } from '../src/shared/markdownLinks.ts'

test('linked files and multiple attachments survive rename, move, three portable exports and cross-directory backup recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-interop-')), stores: KnowbookStore[] = []
  const file = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
  const lookup = (store: KnowbookStore, path: string) => store.getDocumentDetail(store.getAllDocumentSnapshots().find((doc) => doc.path === path)!.id)!
  try {
    let input = join(root, 'input')
    file(join(input, 'Docs', 'Start.md'), '# Start\n\n[目标](Next.md?view=1#安装-1)\n\n![图](../assets/中文%20图.png)\n\n- [x] Task[^a]\n\n[^a]: [文件](../assets/report.pdf#page=2)\n\n[再次访问][next]\n\n[next]: Next.md#安装 "保留标题"\n\n`[代码](Next.md#安装)`')
    file(join(input, 'Docs', 'Next.md'), '# Next\n\n[返回](Start.md#start)\n\n## 安装\n\nFirst\n\n## 安装\n\nSecond')
    file(join(input, 'assets', '中文 图.png'), 'png fixture')
    file(join(input, 'assets', 'report.pdf'), 'pdf fixture')
    let expectedLinks: string[] | undefined
    let last: KnowbookStore | undefined, lastAssets = ''
    for (let cycle = 0; cycle < 3; cycle++) {
      const store = new KnowbookStore(join(root, `workspace-${cycle}.sqlite`)); stores.push(store)
      const assets = join(root, `assets-${cycle}`)
      await new MarkdownRestoreService(store, assets).restoreFromDirectory(input)
      rmSync(input, { recursive: true, force: true })
      if (cycle === 0) {
        const target = lookup(store, 'Docs/Next')
        let ordinal = 0
        store.updateDocument(target.id, { ...target, title: '新 章', blocks: target.blocks.map((block) => block.type === 'heading-2' && ordinal++ === 1 ? { ...block, content: '下一步' } : block) })
        const archive = store.createDocument(null)
        store.updateDocument(archive, { title: '归档', summary: '', blocks: [] })
        store.moveDocument(target.id, archive)
        const source = lookup(store, 'Docs/Start')
        const managedUrl = collectMarkdownDestinations(buildDraftMarkdownExport(source).markdown).find((link) => link.url.startsWith('file:') && link.url.includes('.pdf'))!.url
        store.updateDocument(source.id, { ...source, blocks: [...source.blocks, { type: 'paragraph', content: `<${managedUrl}>`, checked: false, depth: 0 }] })
      }
      for (const path of ['Docs/Start', '归档/新 章']) {
        const document = lookup(store, path)
        assert.deepEqual(store.checkDocumentLinks(document.id, (url) => checkMarkdownAttachment(url, assets)).issues, [], `${cycle}: ${path}`)
      }
      const source = lookup(store, 'Docs/Start'), markdown = buildDraftMarkdownExport(source).markdown
      const links = collectMarkdownDestinations(markdown)
      const targets = links.map((link) => resolveMarkdownDocumentPath(source.path, link.url)).filter(Boolean).map((target) => JSON.stringify(target))
      if (!expectedLinks) expectedLinks = targets
      else assert.deepEqual(targets, expectedLinks)
      assert.ok(markdown.includes('?view=1#'))
      assert.ok(markdown.includes('"保留标题"'))
      assert.ok(markdown.includes('`[代码](Next.md#安装)`'))
      assert.deepEqual(new Set(links.filter((link) => link.url.startsWith('file:')).map((link) => readFileSync(fileURLToPath(link.url), 'utf8'))), new Set(['png fixture', 'pdf fixture']))
      const output = join(root, `export-${cycle}`)
      for (const path of ['Docs/Start', '归档/新 章']) {
        const document = lookup(store, path)
        writeMarkdownFile(join(output, `${path}.md`), buildDraftMarkdownExport(document).markdown, assets)
      }
      input = output; last = store; lastAssets = assets
    }
    const backup = join(root, 'backup')
    await new MarkdownBackupService(last!, backup, lastAssets).exportAll()
    const restored = new KnowbookStore(join(root, 'recovered.sqlite')); stores.push(restored)
    const recoveredAssets = join(root, 'recovered', 'assets')
    await new MarkdownRestoreService(restored, recoveredAssets).restoreFromDirectory(backup)
    rmSync(backup, { recursive: true, force: true }); rmSync(lastAssets, { recursive: true, force: true })
    for (const path of ['Docs/Start', '归档/新 章']) {
      const detail = lookup(restored, path)
      assert.deepEqual(restored.checkDocumentLinks(detail.id, (url) => checkMarkdownAttachment(url, recoveredAssets)).issues, [])
      assert.deepEqual(detail.blocks.map((block) => block.id), lookup(last!, path).blocks.map((block) => block.id))
    }
  } finally { stores.forEach((store) => store.destroy()); rmSync(root, { recursive: true, force: true }) }
})
