import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownRestoreService } from '../src/main/backup/importer'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { WebDavSyncService } from '../src/main/sync/service'
import { createEphemeralCredentialStorage } from '../src/main/credential-storage'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../src/shared/webdav-sync'
import { buildDocumentMarkdown, readDocumentMarkdownExport } from '../src/renderer/src/utils/documentMarkdown'
import { writeMarkdownFile } from '../src/main/backup/markdown-file'
import { collectMarkdownDestinations } from '../src/shared/markdownLinks'
import type { ResolveSyncedInlineInstanceInput } from '../src/shared/workspace-search-occurrence'
import { addV3Assets, addV3SameGroupReference, withV3Fixture, allTables, randomUUID } from './helpers/synced-backup-v3-fixture'

test('the current WebDAV service reads and rejects obsolete remote manifests without mutation', t => withV3Fixture(async f => {
  const store = KnowbookStore.openCanonicalRuntime(f.file)
  const service = new WebDavSyncService(store, f.userDataRoot, createEphemeralCredentialStorage(randomUUID))
  let version = 1
  const requests: Array<{ path: string; method: string }> = []
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    requests.push({ path: new URL(input).pathname, method: init?.method ?? 'GET' })
    return new Response(JSON.stringify({ version }), { headers: { ETag: '"obsolete"' } })
  })
  try {
    service.saveConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, enabled: true, url: 'https://example.invalid/webdav/', username: 'personal', password: 'kept-password' })
    const config = service.getStatus().config
    const before = allTables(store.getUnsafeDatabaseHandle())
    for (version = 1; version <= 4; version++) {
      requests.length = 0
      await assert.rejects(service.testConnection(), /同步协议不受支持/)
      await assert.rejects(service.sync(), /同步协议不受支持/)
      assert.deepEqual(requests, Array.from({ length: 2 }, () => ({ path: '/webdav/KnowBook/manifest.json', method: 'GET' })))
      assert.deepEqual(service.getStatus().config, config)
      assert.equal(service.getStatus().hasPassword, true)
      assert.equal(service.getStatus().lastSyncAt, null)
      assert.deepEqual(allTables(store.getUnsafeDatabaseHandle()), before)
    }
    assert.throws(() => store.getSyncRecords(), /旧 WebDAV/)
    assert.throws(() => store.applySyncRecords([]), /旧 WebDAV/)
  } finally { await service.stop(); store.destroy() }
}))

test('legacy restore refuses a real V3 source and a current canonical target before parsing or publishing attachments', () => withV3Fixture(async f => {
  const current = KnowbookStore.openCanonicalRuntime(f.file), ordinary = new KnowbookStore(join(f.root, 'ordinary.db'))
  let parserCalls = 0
  const parser = async (): Promise<never> => { parserCalls++; throw new Error('Legacy parse must never run for this source or target.') }
  try {
    const archiveRoot = join(realpathSync(f.root), 'archive')
    const snapshotId = randomUUID()
    writeSyncedBackupV3(f.db, {userDataRoot:realpathSync(f.userDataRoot),destination:archiveRoot,snapshotId})
    assert.equal(readBackupV3Archive(archiveRoot).manifest.snapshotId, snapshotId, 'The rejection input is an independently parsed complete real Main archive')
    const beforeCurrent = allTables(current.getUnsafeDatabaseHandle()), beforeOrdinary = allTables(ordinary.getUnsafeDatabaseHandle())
    await assert.rejects(new MarkdownRestoreService(ordinary, undefined, {}, parser).previewFromDirectory(archiveRoot), /V3/)
    await assert.rejects(new MarkdownRestoreService(ordinary, undefined, {}, parser).restoreFromDirectory(archiveRoot), /V3/)
    await assert.rejects(new MarkdownRestoreService(current, undefined, {}, parser).restoreFromDirectory(archiveRoot), /V3|同步块/)
    assert.equal(parserCalls, 0)
    assert.deepEqual(allTables(current.getUnsafeDatabaseHandle()), beforeCurrent)
    assert.deepEqual(allTables(ordinary.getUnsafeDatabaseHandle()), beforeOrdinary)
    assert.equal(readBackupV3Archive(archiveRoot).manifest.snapshotId, snapshotId)
  } finally { ordinary.destroy(); current.destroy() }
}))

test('single Markdown export requires actual snapshots and ordinary Markdown keeps its existing serialization', () => {
  const block = { id: randomUUID(), type: 'synced-block', content: JSON.stringify({ version: 1, groupId: randomUUID() }), checked: false, depth: 0 }
  assert.throws(() => buildDocumentMarkdown({ title: 'Shared', blocks: [block] }), /同步块快照/)
  assert.equal(buildDocumentMarkdown({title:'Ordinary',blocks:[{id:'ordinary',type:'paragraph',content:'normal text',checked:false,depth:0,parentBlockId:null}]}), '# Ordinary\n\nnormal text')
})

test('single Markdown export expands actual repeated references and independently imports their links and attachments', () => withV3Fixture(async f => {
  const parent = f.store.createDocument(null), documentId = f.store.createDocument(parent)
  f.store.updateDocument(parent, { title: 'Folder', summary: '', blocks: [] })
  f.store.updateDocument(documentId, { title: 'Portable reader', summary: '', blocks: [] })
  addV3SameGroupReference(f, documentId)
  addV3SameGroupReference(f, documentId)
  const assetGroup = await addV3Assets(f)
  addV3SameGroupReference({ ...f, groupId: assetGroup.groupId }, documentId)
  const stored = f.store.getDocumentDetail(documentId)!
  const before = allTables(f.db), originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const ordinary = new KnowbookStore(join(f.root, 'plain-import.db'))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { knowbook: {
    resolveSyncedInlineInstance: async (input: ResolveSyncedInlineInstanceInput) => f.store.resolveSyncedInlineInstance(input),
    getDocumentDetail: async (id: string) => f.store.getDocumentDetail(id),
    resolveSyncedStoredBlockLink: async (input: unknown) => f.store.resolveSyncedStoredBlockLink(input)
  } } })
  try {
    const exported = await readDocumentMarkdownExport(stored)
    const link = '[target](../V3%20Target.md#target-heading)'
    assert.equal(exported.fileName, 'Portable reader.md')
    assert.equal(exported.markdown.split(link).length - 1 >= 2, true)
    assert.equal(exported.markdown.includes(f.groupId), false)
    const output = join(f.root, 'portable'), file = join(output, exported.fileName)
    writeMarkdownFile(file, exported.markdown, join(f.userDataRoot, 'storage', 'assets'))
    const attachment = collectMarkdownDestinations(readFileSync(file, 'utf8')).find(item => item.url.startsWith('./Portable%20reader.assets/'))
    assert.ok(attachment, 'The real file export copied an actual canonical attachment')
    assert.deepEqual(readFileSync(join(output, decodeURIComponent(attachment.url.split(/[?#]/, 1)[0]))), assetGroup.bytes)
    await new MarkdownRestoreService(ordinary, join(f.root, 'ordinary-assets')).restoreFromDirectory(output)
    const imported = ordinary.getAllDocumentSnapshots().find(document => document.title === 'Portable reader')
    const restored = imported && ordinary.getDocumentDetail(imported.id)
    assert.ok(restored)
    assert.ok(restored.blocks.every(block => block.type !== 'synced-block'))
    const repeated = restored.blocks.filter(block => block.content === link)
    assert.equal(repeated.length, 2)
    assert.notEqual(repeated[0].id, repeated[1].id)
    const forged = { ...stored, blocks: stored.blocks.map(block => block.type === 'synced-block'
      ? { ...block, content: JSON.stringify({ version: 1, groupId: randomUUID() }) } : block) }
    await assert.rejects(readDocumentMarkdownExport(forged), /同步块快照已变化或不可用/)
    assert.deepEqual(allTables(f.db), before)

    f.store.deleteDocument(f.targetId)
    assert.equal(f.store.getDocumentDetail(f.targetId), null)
    const missingLinkTarget = await readDocumentMarkdownExport(f.store.getDocumentDetail(documentId)!)
    assert.equal(missingLinkTarget.markdown.split(f.raw).length - 1, 3)
  } finally {
    ordinary.destroy()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}))
