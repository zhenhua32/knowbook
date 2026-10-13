import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { AttachmentStore } from '../src/main/attachments'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownBackupService } from '../src/main/backup/exporter'
import { MarkdownRestoreService } from '../src/main/backup/importer'
import { writeMarkdownFile } from '../src/main/backup/markdown-file'
import { serializeBlocksToMarkdown } from '../src/shared/markdown'
import { collectMarkdownImageOccurrences } from '../src/shared/markdownMediaOccurrences'
import { serializeImageFigure, type ImagePresentation } from '../src/shared/markdownMedia'
import type { DocumentDetail } from '../src/shared/contracts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6lp9sAAAAASUVORK5CYII=', 'base64')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const noteTitle = '图像呈现往返'

function document(store: KnowbookStore): DocumentDetail {
  const snapshot = store.getAllDocumentSnapshots().find(note => note.title === noteTitle)
  assert.ok(snapshot, 'The image presentation note must exist in the restored workspace.')
  return store.getDocumentDetail(snapshot.id)!
}

function presentationValues(values: ImagePresentation[]) {
  return values.map(({ src: _source, ...presentation }) => presentation)
}

test('duplicate original PNG images retain independent presentation through three portable and backup workspace restores', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-img-')), stores: KnowbookStore[] = []
  const makeStore = (name: string) => { const store = new KnowbookStore(join(root, name, 'knowbook.db')); stores.push(store); return store }
  try {
    const originalAssets = new AttachmentStore(join(root, 'a'))
    const [attachment] = await originalAssets.import([{ name: '原图.png', bytes: png }])
    assert.equal(attachment.kind, 'image')
    const originalHash = hash(png), originalPath = originalAssets.resolve(attachment.url)
    const expected: ImagePresentation[] = [
      { src: attachment.url, alt: '首图的替代说明 " & < > 中文', title: '图片 title " &', caption: '第一张独立图注 <标签> & "引用"\n第二行',
        width: 640, height: 560, align: 'center', crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.7 } },
      { src: attachment.url, alt: '第二张替代说明，与 caption 不同', caption: '第二张图注 & <说明> "中文"',
        width: 200, height: 400, align: 'right', crop: { x: 0.25, y: 0, width: 0.5, height: 1 } }
    ]
    const original = makeStore('original'), id = original.createDocument(null)
    original.updateDocument(id, { title: noteTitle, summary: 'Same immutable image, two independent presentations.', blocks: expected.map((image, index) => ({
      id: `presented-image-${index}`, type: 'html', content: serializeImageFigure(image), checked: false, depth: 0,
      tags: [`image-${index}`], highlight: index === 0 ? 'blue' : undefined
    })) })
    const originalMetadata = document(original).blocks.map(({ id, type, tags, highlight }) => ({ id, type, tags, highlight }))

    const verifyManaged = (store: KnowbookStore, assetRoot: string, label: string) => {
      const note = document(store), markdown = serializeBlocksToMarkdown(note.blocks), occurrences = collectMarkdownImageOccurrences(markdown)
      const actual = occurrences.map(occurrence => occurrence.presentation)
      const evidence = JSON.stringify({ label, expected: presentationValues(expected), actual: presentationValues(actual), markdown }, null, 2)
      assert.equal(actual.length, 2, evidence)
      assert.deepEqual(presentationValues(actual), presentationValues(expected), evidence)
      assert.equal(new Set(actual.map(image => image.src)).size, 1, `${label}: both occurrences must still share one original asset`)
      const assets = new AttachmentStore(assetRoot)
      for (const [index, image] of actual.entries()) {
        const path = assets.resolve(image.src)
        assert.ok(existsSync(path), `${label}: occurrence ${index} local asset must exist: ${path}`)
        const bytes = readFileSync(path)
        assert.deepEqual(bytes, png, `${label}: occurrence ${index} original PNG bytes changed`)
        assert.equal(hash(bytes), originalHash, `${label}: occurrence ${index} original PNG hash changed`)
      }
      return note
    }

    let plainStore = original, plainAssetRoot = originalAssets.root
    let backupStore = original, backupAssetRoot = originalAssets.root
    for (let round = 0; round < 3; round++) {
      const plainLabel = `plain round ${round}`, beforePlain = verifyManaged(plainStore, plainAssetRoot, `${plainLabel} before export`)
      const plainRoot = join(root, `portable-${round}`), markdownPath = join(plainRoot, `${noteTitle}.md`)
      writeMarkdownFile(markdownPath, serializeBlocksToMarkdown(beforePlain.blocks), plainAssetRoot)
      const exported = readFileSync(markdownPath, 'utf8'), portable = collectMarkdownImageOccurrences(exported).map(image => image.presentation)
      assert.deepEqual(presentationValues(portable), presentationValues(expected), JSON.stringify({ plainLabel, portable, expected, exported }, null, 2))
      for (const [index, image] of portable.entries()) {
        assert.equal(image.src.startsWith('file:'), false, `${plainLabel}: occurrence ${index} must use a portable source`)
        const assetPath = resolve(dirname(markdownPath), decodeURIComponent(image.src))
        assert.ok(existsSync(assetPath), `${plainLabel}: exported local asset must exist: ${assetPath}`)
        assert.equal(hash(readFileSync(assetPath)), originalHash, `${plainLabel}: exported image changed`)
      }
      const plainDestination = makeStore(`p${round}`), plainAssets = join(root, `p${round}`, 'a')
      await new MarkdownRestoreService(plainDestination, plainAssets).restoreFromDirectory(plainRoot)
      verifyManaged(plainDestination, plainAssets, `${plainLabel} after restore`)
      plainStore = plainDestination; plainAssetRoot = plainAssets

      const backupLabel = `backup round ${round}`
      verifyManaged(backupStore, backupAssetRoot, `${backupLabel} before export`)
      const backupRoot = join(root, `backup-${round}`)
      await new MarkdownBackupService(backupStore, backupRoot, backupAssetRoot).exportAll(true)
      const backupDestination = makeStore(`b${round}`), backupAssets = join(root, `b${round}`, 'a')
      await new MarkdownRestoreService(backupDestination, backupAssets).restoreFromDirectory(backupRoot)
      const recovered = verifyManaged(backupDestination, backupAssets, `${backupLabel} after restore`)
      assert.deepEqual(recovered.blocks.map(({ id, type, tags, highlight }) => ({ id, type, tags, highlight })), originalMetadata,
        `${backupLabel}: image block identities and metadata must survive the archive`)
      backupStore = backupDestination; backupAssetRoot = backupAssets
      assert.equal(hash(readFileSync(originalPath)), originalHash, `${round}: presentation must never modify the original imported file`)
    }
  } finally {
    stores.forEach(store => store.destroy())
    rmSync(root, { recursive: true, force: true })
  }
})
