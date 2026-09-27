import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { AttachmentStore, attachmentFileName } from '../src/main/attachments'
import { ATTACHMENT_MAX_FILE_BYTES, attachmentMarkdown } from '../src/shared/attachments'
import { collectMarkdownDestinations } from '../src/shared/markdownLinks'
import { serializeBlocksToMarkdown } from '../src/shared/markdown'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownBackupService } from '../src/main/backup/exporter'
import { MarkdownRestoreService } from '../src/main/backup/importer'
import { writeMarkdownFile } from '../src/main/backup/markdown-file'

const input = (name: string, content = 'test content') => ({ name, bytes: Buffer.from(content) })
async function fixture(run: (assets: AttachmentStore, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-attachments-'))
  try { await run(new AttachmentStore(join(root, 'assets')), root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('attachments preserve names, bytes and extensions; concurrent identical imports share one immutable file', () => fixture(async assets => {
  const file = input('合同 [初稿] (1) #100%.pdf')
  const [[first], [same], [different]] = await Promise.all([assets.import([file]), assets.import([file]), assets.import([input(file.name, 'changed bytes')])])
  assert.equal(first.url, same.url)
  assert.notEqual(first.url, different.url)
  assert.equal(first.name, file.name)
  assert.equal(first.kind, 'file')
  assert.equal(first.size, file.bytes.length)
  assert.deepEqual(readFileSync(assets.resolve(first.url)), file.bytes)
  assert.equal(collectMarkdownDestinations(attachmentMarkdown(first))[0].url, first.url)
  assert.equal(assets.get(first.url).url, first.url)
  const [image, svg, empty] = await assets.import([input('截图.png'), input('drawing.svg'), input('empty.txt', '')])
  assert.equal(image.kind, 'image'); assert.equal(svg.kind, 'file'); assert.equal(empty.size, 0)
  assert.equal(attachmentFileName('CON.txt'), '_CON.txt')
  assert.equal(attachmentFileName('../../invalid?.txt').includes('/'), false)
}))

test('invalid payloads and size limits reject the whole batch before writing', () => fixture(async (assets, root) => {
  await assert.rejects(assets.import([]), /1–20/)
  await assert.rejects(assets.import(Array.from({ length: 21 }, () => input('a'))), /1–20/)
  await assert.rejects(assets.import([{ name: 'a', bytes: [] as unknown as Uint8Array }]), /Invalid/)
  await assert.rejects(assets.import([input('good.txt'), { name: 'too-large', bytes: new Uint8Array(ATTACHMENT_MAX_FILE_BYTES + 1) }]), /25 MB/)
  const bytes = new Uint8Array(ATTACHMENT_MAX_FILE_BYTES)
  await assert.rejects(assets.import(Array.from({ length: 5 }, () => ({ name: 'large', bytes }))), /100 MB/)
  assert.equal(existsSync(join(root, 'assets')), false)
}))

test('managed reads reject outside paths, directories and symlink/junction escapes', () => fixture(async (assets, root) => {
  const [file] = await assets.import([input('note.txt')])
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'private')
  assert.throws(() => assets.resolve(pathToFileURL(join(outside, 'secret.txt')).href), /outside/)
  assert.throws(() => assets.resolve(pathToFileURL(assets.root).href), /outside/)
  assert.throws(() => assets.resolve('https://example.com/a.png'), /managed local/)
  assert.throws(() => assets.resolve('file://server/share/a.txt'), /managed local/)
  const junction = join(assets.root, 'escape')
  symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => assets.resolve(pathToFileURL(join(junction, 'secret.txt')).href), /symbolic/)
  rmSync(fileURLToPath(file.url))
  assert.throws(() => assets.get(file.url))
}))

test('failed imports roll back new files and do not overwrite a damaged existing attachment', () => fixture(async assets => {
  const [original] = await assets.import([input('old.txt')])
  writeFileSync(assets.resolve(original.url), 'damaged')
  await assert.rejects(assets.import([input('new.txt', 'new'), input('old.txt')]), /damaged/)
  const files = readdirSync(assets.root, { recursive: true }).map(String).filter(name => /\.txt$/.test(name))
  assert.equal(files.length, 1)
  assert.equal(readFileSync(fileURLToPath(original.url), 'utf8'), 'damaged')
  const [retry] = await assets.import([input('new.txt', 'new')])
  assert.equal(readFileSync(assets.resolve(retry.url), 'utf8'), 'new')
}))

test('local images and attachments survive history, Trash, portable Markdown and archived backup restore in another workspace', () => fixture(async (assets, root) => {
  const store = new KnowbookStore(join(root, 'original.db')), restored = new KnowbookStore(join(root, 'restored.db'))
  try {
    const files = await assets.import([input('截图.png', 'png fixture'), input("合同 [初稿] (1)'s #100%.pdf", 'pdf fixture')])
    const id = store.createDocument(null)
    store.updateDocument(id, { ...store.getDocumentDetail(id)!, title: 'Attachments', blocks: files.map(file => ({ type: 'paragraph', content: attachmentMarkdown(file), checked: false, depth: 0 })) })
    store.documentRecovery.checkpoint(id, 'restore')
    const version = store.documentRecovery.listHistory(id)[0]
    store.updateDocument(id, { ...store.getDocumentDetail(id)!, blocks: [] })
    store.restoreDocumentHistory(id, version.id, store.getDocumentDetail(id)!.updatedAt)
    store.deleteDocument(id); store.restoreTrashedDocument(id)
    const markdown = serializeBlocksToMarkdown(store.getDocumentDetail(id)!.blocks)
    assert.deepEqual(collectMarkdownDestinations(markdown).map(link => link.url), files.map(file => file.url))
    const exported = join(root, 'export', 'Attachments.md')
    writeMarkdownFile(exported, markdown, assets.root)
    assert.equal(readFileSync(exported, 'utf8').includes('file:'), false)
    assert.equal(readdirSync(join(root, 'export', 'Attachments.assets')).length, 2)
    const backup = new MarkdownBackupService(store, join(root, 'backups', 'markdown'), assets.root)
    await backup.exportAll(true)
    const selected = backup.listVersions()[0].id
    store.updateDocument(id, { ...store.getDocumentDetail(id)!, blocks: [] })
    await backup.exportAll(true)
    const destination = join(root, 'new-workspace', 'assets')
    await new MarkdownRestoreService(restored, destination).restoreFromDirectory(backup.resolveVersion(selected))
    rmSync(assets.root, { recursive: true, force: true })
    const recovered = restored.getDocumentDetail(restored.getAllDocumentSnapshots().find(document => document.title === 'Attachments')!.id)!
    const links = collectMarkdownDestinations(serializeBlocksToMarkdown(recovered.blocks))
    assert.equal(links.length, 2)
    const restoredAssets = new AttachmentStore(destination)
    assert.deepEqual(links.map(link => readFileSync(restoredAssets.resolve(link.url), 'utf8')), ['png fixture', 'pdf fixture'])
  } finally { store.destroy(); restored.destroy() }
}))
