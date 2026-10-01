import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import { AttachmentStore } from '../src/main/attachments'
import { createEphemeralCredentialStorage } from '../src/main/credential-storage'
import { WebDavSyncService } from '../src/main/sync/service'
import { parseManifest } from '../src/main/sync/model'
import type { DocumentBlockDraft, UpdateDocumentInput } from '../src/shared/contracts'
import { attachmentMarkdown } from '../src/shared/attachments'
import { collectMarkdownDestinations } from '../src/shared/markdownLinks'
import { DEFAULT_WEBDAV_SYNC_CONFIG, type WebDavSyncConflictVersion, type WebDavSyncMergeChoice } from '../src/shared/webdav-sync'
import { createWebDavServer } from './helpers/webdav-server'

function device(root: string, name: string, url: string) {
  const store = new KnowbookStore(join(root, name, 'knowbook.db'))
  for (const document of store.getAllDocumentSnapshots().reverse()) store.deleteDocument(document.id)
  const assets = new AttachmentStore(join(root, name, 'assets'))
  const credentials = createEphemeralCredentialStorage(randomUUID)
  const sync = new WebDavSyncService(store, assets, credentials)
  sync.saveConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, url, username: 'test', password: 'app-secret', allowInsecureHttp: true })
  return { store, assets, credentials, sync }
}

async function fixture(run: (a: ReturnType<typeof device>, b: ReturnType<typeof device>, server: Awaited<ReturnType<typeof createWebDavServer>>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-webdav-merge-'))
  const server = await createWebDavServer()
  const a = device(root, 'a', server.url), b = device(root, 'b', server.url)
  try { await run(a, b, server) }
  finally {
    await a.sync.stop(); await b.sync.stop()
    a.store.destroy(); b.store.destroy()
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
}

function block(content: string): DocumentBlockDraft {
  return { id: randomUUID(), type: 'paragraph', content, checked: false, depth: 0 }
}
function create(store: KnowbookStore, text = 'base body', title = 'Merge document') {
  const id = store.createDocument(null)
  store.updateDocument(id, { title, summary: 'base summary', blocks: [block(text), block('second base')] })
  return id
}
function update(store: KnowbookStore, id: string, patch: Partial<UpdateDocumentInput>) {
  return store.updateDocument(id, { ...store.documentRecovery.readContent(id), ...patch })
}
function textAt(store: KnowbookStore, id: string, index = 0) { return store.getDocumentDetail(id)!.blocks[index].content }
function editBlock(store: KnowbookStore, id: string, index: number, content: string) {
  const draft = store.documentRecovery.readContent(id)
  update(store, id, { blocks: draft.blocks.map((item, position) => position === index ? { ...item, content } : item) })
}
function version(sync: WebDavSyncService, id: string): WebDavSyncConflictVersion {
  const conflict = sync.getStatus().conflicts.find(item => item.key === `doc:${id}`)!
  assert.ok(conflict, 'expected an unresolved document conflict')
  return { key: conflict.key, localHash: conflict.localHash, remoteHash: conflict.remoteHash }
}
async function restart(current: ReturnType<typeof device>) {
  await current.sync.stop()
  current.sync = new WebDavSyncService(current.store, current.assets, current.credentials)
}

test('three-way merging combines separate fields and stable blocks after restart, then converges without uploads', () => fixture(async (a, b, server) => {
  const id = create(a.store), ids = a.store.getDocumentDetail(id)!.blocks.map(item => item.id)
  await a.sync.sync(); await b.sync.sync()
  update(a.store, id, { title: 'Remote title' }); editBlock(a.store, id, 0, 'remote first block')
  update(b.store, id, { summary: 'local summary' }); editBlock(b.store, id, 1, 'local second block')
  await a.sync.sync(); await restart(b)
  const status = await b.sync.sync()
  assert.equal(status.merged, 1)
  assert.equal(status.conflicts.length, 0)
  const merged = b.store.getDocumentDetail(id)!
  assert.equal(merged.title, 'Remote title'); assert.equal(merged.summary, 'local summary')
  assert.deepEqual(merged.blocks.map(item => item.id), ids)
  assert.deepEqual(merged.blocks.map(item => item.content), ['remote first block', 'local second block'])
  await a.sync.sync()
  assert.equal(a.store.getDocumentDetail(id)!.summary, 'local summary')
  assert.equal(textAt(a.store, id, 1), 'local second block')
  const before = server.requests.length
  await a.sync.sync(); await b.sync.sync()
  assert.ok(!server.requests.slice(before).some(request => request.method === 'PUT'), 'a settled merge must not be repeatedly published')
}))

test('different positions in one block merge without discarding its unchanged Markdown', () => fixture(async (a, b) => {
  const id = create(a.store, 'alpha\n\n**middle**\n\nomega')
  await a.sync.sync(); await b.sync.sync()
  editBlock(a.store, id, 0, 'remote alpha\n\n**middle**\n\nomega')
  editBlock(b.store, id, 0, 'alpha\n\n**middle**\n\nlocal omega')
  await a.sync.sync(); const result = await b.sync.sync(); await a.sync.sync()
  assert.equal(result.merged, 1); assert.equal(result.conflicts.length, 0)
  assert.equal(textAt(b.store, id), 'remote alpha\n\n**middle**\n\nlocal omega')
  assert.equal(textAt(a.store, id), textAt(b.store, id))
}))

test('merged documents localize both newly added remote and local attachments before applying', () => fixture(async (a, b) => {
  const id = create(a.store)
  await a.sync.sync(); await b.sync.sync()
  const [remote] = await a.assets.import([{ name: '远端截图 [1].png', bytes: Buffer.from('remote attachment') }])
  const [local] = await b.assets.import([{ name: '本地资料.pdf', bytes: Buffer.from('local attachment') }])
  editBlock(a.store, id, 0, attachmentMarkdown(remote)); editBlock(b.store, id, 1, attachmentMarkdown(local))
  await a.sync.sync(); const status = await b.sync.sync(); await a.sync.sync()
  assert.equal(status.merged, 1); assert.equal(status.conflicts.length, 0)
  for (const current of [a, b]) {
    const urls = current.store.getDocumentDetail(id)!.blocks.flatMap(item => collectMarkdownDestinations(item.content).map(link => link.url))
    assert.equal(urls.length, 2)
    assert.deepEqual(urls.map(url => readFileSync(current.assets.resolve(url), 'utf8')), ['remote attachment', 'local attachment'])
  }
}))

test('attachment conflict previews and merge choices remain usable after service restart', () => fixture(async (a, b) => {
  const id = create(a.store)
  const [attachment] = await a.assets.import([{ name: '共同附件.png', bytes: Buffer.from('shared attachment') }])
  editBlock(a.store, id, 1, attachmentMarkdown(attachment))
  await a.sync.sync(); await b.sync.sync()
  editBlock(a.store, id, 0, 'remote overlap'); editBlock(b.store, id, 0, 'local overlap')
  await a.sync.sync(); await b.sync.sync()
  const pair = version(b.sync, id)
  await restart(b)
  const details = b.sync.getConflictDetails(pair)
  assert.ok(details.merge)
  b.sync.resolveConflict({ ...pair, choice: 'merge', mergeChoices: Object.fromEntries(details.merge.conflicts.map(part => [part.id, { choice: 'local' }])) })
  await b.sync.sync(); await a.sync.sync()
  assert.equal(b.sync.getStatus().conflicts.length, 0)
  const url = collectMarkdownDestinations(textAt(b.store, id, 1))[0].url
  assert.equal(readFileSync(b.assets.resolve(url), 'utf8'), 'shared attachment')
  assert.equal(textAt(a.store, id), 'local overlap')
}))

test('a block choice resolves only its overlap while retaining independently changed title and summary', () => fixture(async (a, b) => {
  const id = create(a.store)
  await a.sync.sync(); await b.sync.sync()
  update(a.store, id, { title: 'Remote heading' }); editBlock(a.store, id, 0, 'remote body')
  update(b.store, id, { summary: 'Local summary' }); editBlock(b.store, id, 0, 'local body')
  await a.sync.sync(); await b.sync.sync()
  const pair = version(b.sync, id), details = b.sync.getConflictDetails(pair)
  assert.ok(details.merge)
  assert.match(details.basePreview!, /base body/)
  assert.equal(details.merge.document.title, 'Remote heading')
  assert.equal(details.merge.document.summary, 'Local summary')
  assert.equal(details.merge.conflicts.length, 1)
  const part = details.merge.conflicts[0]
  assert.equal(part.field, 'block-content')
  b.sync.resolveConflict({ ...pair, choice: 'merge', mergeChoices: { [part.id]: { choice: 'local' } } })
  assert.equal(b.sync.getStatus().conflicts[0].resolution, 'merge')
  assert.equal(textAt(b.store, id), 'local body', 'choosing a merge must leave stored content untouched until sync')
  await b.sync.sync(); await a.sync.sync()
  assert.equal(b.sync.getStatus().conflicts.length, 0)
  for (const current of [a, b]) {
    assert.equal(current.store.getDocumentDetail(id)!.title, 'Remote heading')
    assert.equal(current.store.getDocumentDetail(id)!.summary, 'Local summary')
    assert.equal(textAt(current.store, id), 'local body')
  }
}))

test('custom title merge and block selections survive restart and preserve separate block edits', () => fixture(async (a, b) => {
  const id = create(a.store)
  const initial = a.store.documentRecovery.readContent(id)
  update(a.store, id, { blocks: [...initial.blocks, block('third base')] })
  await a.sync.sync(); await b.sync.sync()
  update(a.store, id, { title: 'Remote title' }); editBlock(a.store, id, 0, 'remote overlap'); editBlock(a.store, id, 1, 'remote independent')
  update(b.store, id, { title: 'Local title' }); editBlock(b.store, id, 0, 'local overlap'); editBlock(b.store, id, 2, 'local independent')
  await a.sync.sync(); await b.sync.sync()
  const pair = version(b.sync, id), details = b.sync.getConflictDetails(pair)
  assert.ok(details.merge)
  const title = details.merge.conflicts.find(part => part.field === 'title')!
  const body = details.merge.conflicts.find(part => part.field === 'block-content')!
  assert.ok(title.canEditText); assert.ok(body.canEditText)
  const choices: Record<string, WebDavSyncMergeChoice> = {
    [title.id]: { choice: 'custom', text: 'Reviewed merged title' }, [body.id]: { choice: 'remote' }
  }
  b.sync.resolveConflict({ ...pair, choice: 'merge', mergeChoices: choices })
  await restart(b)
  assert.equal(b.sync.getStatus().conflicts[0].resolution, 'merge')
  const restored = b.sync.getConflictDetails(pair)
  assert.deepEqual(restored.savedChoices, choices)
  assert.equal(restored.merge!.document.title, 'Reviewed merged title')
  assert.deepEqual(restored.merge!.document.blocks.map(item => item.content), ['remote overlap', 'remote independent', 'local independent'])
  assert.deepEqual(restored.merge!.unresolvedIds, [])
  await b.sync.sync(); await a.sync.sync()
  for (const current of [a, b]) {
    assert.equal(current.store.getDocumentDetail(id)!.title, 'Reviewed merged title')
    assert.deepEqual(current.store.getDocumentDetail(id)!.blocks.map(item => item.content), ['remote overlap', 'remote independent', 'local independent'])
  }
}))

test('partial merge choices and malformed custom titles are rejected before saving a resolution', () => fixture(async (a, b) => {
  const id = create(a.store)
  await a.sync.sync(); await b.sync.sync()
  update(a.store, id, { title: 'Remote title' }); editBlock(a.store, id, 0, 'remote body')
  update(b.store, id, { title: 'Local title' }); editBlock(b.store, id, 0, 'local body')
  await a.sync.sync(); await b.sync.sync()
  const pair = version(b.sync, id), details = b.sync.getConflictDetails(pair)
  assert.ok(details.merge)
  const title = details.merge.conflicts.find(part => part.field === 'title')!
  assert.throws(() => b.sync.resolveConflict({ ...pair, choice: 'merge', mergeChoices: { [title.id]: { choice: 'local' } } }))
  const choices = Object.fromEntries(details.merge.conflicts.map(part => [part.id, { choice: 'local' } as const])) as Record<string, WebDavSyncMergeChoice>
  choices[title.id] = { choice: 'custom', text: 'invalid/title' }
  assert.throws(() => b.sync.resolveConflict({ ...pair, choice: 'merge', mergeChoices: choices }))
  assert.equal(b.sync.getStatus().conflicts[0].resolution, null)
  assert.equal(b.store.getDocumentDetail(id)!.title, 'Local title')
}))

test('full three-way previews include content beyond the status preview limit', () => fixture(async (a, b) => {
  const prefix = '共同正文'.repeat(3_500), id = create(a.store, `${prefix}\nbase ending`)
  await a.sync.sync(); await b.sync.sync()
  editBlock(a.store, id, 0, `${prefix}\nremote ending`); editBlock(b.store, id, 0, `${prefix}\nlocal ending`)
  await a.sync.sync(); await b.sync.sync()
  const conflict = b.sync.getStatus().conflicts[0]
  assert.ok(!conflict.remotePreview.includes('remote ending'), 'the status response should remain bounded')
  const details = b.sync.getConflictDetails(version(b.sync, id))
  assert.match(details.localPreview, /local ending/)
  assert.match(details.remotePreview, /remote ending/)
  assert.match(details.basePreview!, /base ending/)
  assert.ok(details.merge)
  assert.equal(details.merge.conflicts.length, 1)
}))

test('manifest races recompute an automatic merge against the newest remote changes', () => fixture(async (a, b, server) => {
  const id = create(a.store)
  await a.sync.sync(); await b.sync.sync()
  update(a.store, id, { title: 'Remote heading' }); update(b.store, id, { summary: 'Local summary' })
  await a.sync.sync()
  let raced = false
  server.setHook(async request => {
    if (!raced && request.method === 'PUT' && request.url!.endsWith('manifest.json')) {
      raced = true
      editBlock(a.store, id, 1, 'newest remote block during publication')
      await a.sync.sync()
    }
  })
  await b.sync.sync(); server.setHook(undefined); await a.sync.sync()
  assert.equal(raced, true)
  assert.equal(b.sync.getStatus().conflicts.length, 0)
  for (const current of [a, b]) {
    assert.equal(current.store.getDocumentDetail(id)!.title, 'Remote heading')
    assert.equal(current.store.getDocumentDetail(id)!.summary, 'Local summary')
    assert.equal(textAt(current.store, id, 1), 'newest remote block during publication')
  }
}))

test('outdated conflict versions cannot replace a newer conflict selection', () => fixture(async (a, b) => {
  const id = create(a.store)
  await a.sync.sync(); await b.sync.sync()
  editBlock(a.store, id, 0, 'remote first'); editBlock(b.store, id, 0, 'local first')
  await a.sync.sync(); await b.sync.sync()
  const old = version(b.sync, id)
  editBlock(a.store, id, 0, 'remote newest'); await a.sync.sync(); await b.sync.sync()
  const newest = version(b.sync, id)
  assert.notEqual(newest.remoteHash, old.remoteHash)
  assert.throws(() => b.sync.resolveConflict({ ...old, choice: 'remote' }), /变化|过期|刷新/)
  assert.throws(() => b.sync.getConflictDetails(old), /变化|过期|刷新/)
  assert.equal(b.sync.getStatus().conflicts[0].resolution, null)
  assert.equal(textAt(b.store, id), 'local first')
}))

test('a selected merge is invalidated when the remote changes before publication', () => fixture(async (a, b) => {
  const id = create(a.store)
  await a.sync.sync(); await b.sync.sync()
  editBlock(a.store, id, 0, 'remote first'); editBlock(b.store, id, 0, 'local first')
  await a.sync.sync(); await b.sync.sync()
  const pair = version(b.sync, id), details = b.sync.getConflictDetails(pair)
  assert.ok(details.merge)
  b.sync.resolveConflict({ ...pair, choice: 'merge', mergeChoices: Object.fromEntries(details.merge.conflicts.map(part => [part.id, { choice: 'remote' }])) })
  editBlock(a.store, id, 0, 'remote newest'); await a.sync.sync(); await b.sync.sync()
  assert.equal(textAt(b.store, id), 'local first')
  assert.equal(b.sync.getStatus().conflicts.length, 1)
  assert.match(b.sync.getStatus().conflicts[0].remotePreview, /remote newest/)
  assert.equal(b.sync.getStatus().conflicts[0].resolution, null)
}))

test('missing ancestors degrade to explicit conflict without losing either version', () => fixture(async (a, b, server) => {
  const id = create(a.store)
  await a.sync.sync(); await b.sync.sync()
  const ancestorHash = parseManifest(server.files.get('/KnowBook/manifest.json')!).entries[`doc:${id}`]
  update(a.store, id, { title: 'Remote title' }); update(b.store, id, { summary: 'Local summary' })
  await a.sync.sync(); await restart(b)
  server.files.delete(`/KnowBook/objects/${ancestorHash}.json`)
  const status = await b.sync.sync()
  assert.equal(status.conflicts.length, 1)
  assert.equal(status.conflicts[0].reason, 'no-base')
  assert.equal(status.conflicts[0].canMerge, false)
  assert.equal(b.sync.getConflictDetails(version(b.sync, id)).basePreview, null)
  assert.equal(b.store.getDocumentDetail(id)!.title, 'Merge document')
  assert.equal(b.store.getDocumentDetail(id)!.summary, 'Local summary')
}))

test('local deletion versus remote editing can preserve deletion and recover the remote version as a copy', () => fixture(async (a, b) => {
  const id = create(a.store)
  await a.sync.sync(); await b.sync.sync()
  editBlock(a.store, id, 0, 'edited remotely after local delete'); b.store.deleteDocument(id)
  await a.sync.sync(); await b.sync.sync()
  const conflict = b.sync.getStatus().conflicts[0]
  assert.equal(conflict.reason, 'delete-edit'); assert.equal(conflict.localDeleted, true)
  assert.equal(conflict.canKeepBoth, true); assert.equal(conflict.canMerge, false)
  b.sync.resolveConflict({ ...version(b.sync, id), choice: 'both' })
  await b.sync.sync(); await a.sync.sync()
  for (const current of [a, b]) {
    assert.equal(current.store.getDocumentSnapshot(id), null)
    const copy = current.store.getExportDocuments().find(document => document.id !== id && document.title.includes('同步冲突副本'))
    assert.ok(copy); assert.equal(copy.blocks[0].content, 'edited remotely after local delete')
  }
}))

test('repeating the same conflict versions creates a new copy without overwriting an edited earlier copy', () => fixture(async (a, b) => {
  const id = create(a.store)
  await a.sync.sync(); await b.sync.sync()
  editBlock(a.store, id, 0, 'version A'); editBlock(b.store, id, 0, 'version B')
  await a.sync.sync(); await b.sync.sync()
  const first = version(b.sync, id)
  b.sync.resolveConflict({ ...first, choice: 'both' })
  await b.sync.sync(); await a.sync.sync()
  const oldCopy = b.store.getExportDocuments().find(document => document.id !== id && document.title.includes('同步冲突副本'))!
  assert.ok(oldCopy)
  update(b.store, oldCopy.id, { title: 'User reviewed copy', summary: 'Keep this review' })
  editBlock(b.store, oldCopy.id, 0, 'user edited earlier conflict copy')
  await b.sync.sync(); await a.sync.sync()

  editBlock(a.store, id, 0, 'common third version')
  await a.sync.sync(); await b.sync.sync()
  editBlock(a.store, id, 0, 'version A'); editBlock(b.store, id, 0, 'version B')
  await a.sync.sync(); await b.sync.sync()
  const repeated = version(b.sync, id)
  assert.deepEqual(repeated, first, 'the original stable IDs and exact version hashes must reproduce the copy-ID collision')
  b.sync.resolveConflict({ ...repeated, choice: 'both' })
  await b.sync.sync(); await a.sync.sync()

  for (const current of [a, b]) {
    const preserved = current.store.getDocumentDetail(oldCopy.id)!
    assert.equal(preserved.title, 'User reviewed copy')
    assert.equal(preserved.summary, 'Keep this review')
    assert.equal(preserved.blocks[0].content, 'user edited earlier conflict copy')
    const newest = current.store.getExportDocuments().find(document => document.id !== id && document.id !== oldCopy.id && document.title.includes('同步冲突副本'))
    assert.ok(newest, 'repeating a conflict must allocate another recoverable copy')
    assert.notEqual(newest.id, oldCopy.id)
    assert.equal(newest.blocks[0].content, 'version B')
    assert.equal(textAt(current.store, id), 'version A')
  }
}))

test('repeating a conflict does not resurrect its earlier copy when that copy was deleted locally', () => fixture(async (a, b) => {
  const id = create(a.store)
  await a.sync.sync(); await b.sync.sync()
  editBlock(a.store, id, 0, 'version A'); editBlock(b.store, id, 0, 'version B')
  await a.sync.sync(); await b.sync.sync()
  const first = version(b.sync, id)
  b.sync.resolveConflict({ ...first, choice: 'both' })
  await b.sync.sync(); await a.sync.sync()
  const oldCopy = b.store.getExportDocuments().find(document => document.id !== id && document.title.includes('同步冲突副本'))!
  assert.ok(oldCopy)

  editBlock(a.store, id, 0, 'common third version')
  await a.sync.sync(); await b.sync.sync()
  editBlock(a.store, id, 0, 'version A'); editBlock(b.store, id, 0, 'version B')
  await a.sync.sync(); await b.sync.sync()
  const repeated = version(b.sync, id)
  assert.deepEqual(repeated, first)
  // Delete after comparison: the server still has the exact original copy hash.
  b.store.deleteDocument(oldCopy.id)
  b.sync.resolveConflict({ ...repeated, choice: 'both' })
  await b.sync.sync(); await a.sync.sync()

  for (const current of [a, b]) {
    assert.equal(current.store.getDocumentSnapshot(oldCopy.id), null)
    assert.ok(current.store.documentRecovery.listTrash().some(document => document.id === oldCopy.id))
    const newest = current.store.getExportDocuments().find(document => document.id !== id && document.title.includes('同步冲突副本'))
    assert.ok(newest); assert.notEqual(newest.id, oldCopy.id)
    assert.equal(newest.blocks[0].content, 'version B')
    assert.equal(textAt(current.store, id), 'version A')
  }
}))

test('a document move merges with separate remote content and recomputes descendant paths', () => fixture(async (a, b) => {
  const parent = create(a.store, 'parent body', 'Destination')
  const id = create(a.store, 'child body', 'Move child')
  const child = a.store.createDocument(id)
  await a.sync.sync(); await b.sync.sync()
  editBlock(a.store, id, 0, 'remote child body'); b.store.moveDocument(id, parent)
  await a.sync.sync(); const status = await b.sync.sync(); await a.sync.sync()
  assert.equal(status.conflicts.length, 0)
  for (const current of [a, b]) {
    assert.equal(current.store.getDocumentSnapshot(id)!.parentId, parent)
    assert.equal(current.store.getDocumentSnapshot(id)!.path, 'Destination/Move child')
    assert.equal(current.store.getDocumentSnapshot(child)!.path, 'Destination/Move child/Untitled')
    assert.equal(textAt(current.store, id), 'remote child body')
  }
}))

test('edits during a merge download stay local and participate in a later safe merge', () => fixture(async (a, b, server) => {
  const id = create(a.store)
  await a.sync.sync(); await b.sync.sync()
  update(a.store, id, { title: 'Remote title' }); editBlock(b.store, id, 1, 'first local draft')
  await a.sync.sync()
  const hash = parseManifest(server.files.get('/KnowBook/manifest.json')!).entries[`doc:${id}`]
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  server.setHook(async request => { if (request.method === 'GET' && request.url!.endsWith(`${hash}.json`)) { enter(); await gate } })
  const pending = b.sync.sync()
  try {
    await entered
    editBlock(b.store, id, 1, 'newer local draft during download')
    release(); await pending
    assert.equal(textAt(b.store, id, 1), 'newer local draft during download')
  } finally { release(); server.setHook(undefined); await pending.catch(() => {}) }
  await b.sync.sync(); await a.sync.sync()
  assert.equal(b.sync.getStatus().conflicts.length, 0)
  assert.equal(textAt(b.store, id, 1), 'newer local draft during download')
  assert.equal(textAt(a.store, id, 1), 'newer local draft during download')
  assert.equal(b.store.getDocumentDetail(id)!.title, 'Remote title')
}))
