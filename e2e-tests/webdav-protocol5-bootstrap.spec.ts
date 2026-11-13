import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeElectronApp, launchElectronApp, uiText, type ElectronAppContext } from './helpers/electron'
import { createWebDavServer } from '../tests/helpers/webdav-server'
import { randomUUID } from 'node:crypto'
import { protocol5HistoryLink, publicationHash, publicationJson, validateInitialManifest5 } from '../src/main/sync/synced-publication-model'
import { validateSyncedProtocol5Snapshot } from '../src/main/sync/synced-protocol5-model'

function configure(page: Page, url: string, directory: string, protocol5: boolean) {
  return page.evaluate(input => window.knowbook.saveWebDavSyncConfig({ ...input,
    enabled: false, username: 'test', password: 'app-secret', intervalMinutes: 5, allowInsecureHttp: true
  }), { url, directory, protocol5 })
}

type SyncedAddress = { hostDocumentId: string; instanceId: string; groupId: string }

function editSharedBody(page: Page, address: SyncedAddress, content: string) {
  return page.evaluate(async ({ address: input, content }) => {
    const session = await window.knowbook.openSyncedEditingSession({ kind: 'instance', ...input })
    if (session.status !== 'ready' || !session.instance || !session.snapshot) throw new Error('The group is not editable in Main.')
    try {
      const { snapshot, instance } = session
      const result = await window.knowbook.invokeSyncedEditingSession({ sessionId: session.session.sessionId,
        method: 'updateSyncedBlockGroup', input: { clientOperationId: crypto.randomUUID(), groupId: input.groupId,
          expectedRevision: snapshot.revision, expectedTopologyRevision: snapshot.topologyRevision,
          expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
          blocks: snapshot.blocks.map(({ createdAt, ...block }) => ({ ...block, content })) } })
      if (result.status !== 'saved') throw new Error('The actual group edit was not committed.')
    } finally { await window.knowbook.releaseSyncedEditingSession(session.session.sessionId) }
  }, { address, content })
}

function readSharedBody(page: Page, address: SyncedAddress, blockId: string) {
  return page.evaluate(async ({ address, blockId }) => {
    const result = await window.knowbook.resolveSyncedInlineInstance(address)
    if (result.status !== 'ready') throw new Error('The exact host reference no longer resolves.')
    return { creationId: result.snapshot.creationId, content: result.snapshot.blocks.find(block => block.id === blockId)?.content }
  }, { address, blockId })
}

function editDocumentBody(page: Page, id: string, content: string) {
  return page.evaluate(async ({ id, content }) => {
    const doc = await window.knowbook.getDocumentDetail(id)
    if (!doc) throw new Error('The actual ordinary document is unavailable.')
    await window.knowbook.updateDocument(id, { title: doc.title, summary: doc.summary,
      blocks: doc.blocks.map(block => ({ ...block, content })) })
  }, { id, content })
}

/** Fixture peer. The desktop product only consumes this independently published valid tombstone. */
async function publishDocumentTombstone(server: Awaited<ReturnType<typeof createWebDavServer>>, directory: string, documentId: string) {
  const prefix = '/' + directory + '/', objectPath = (digest: string) => 'objects/' + digest + '.json'
  const manifestPath = 'manifest.json', original = server.files.get(prefix + manifestPath)!
  const manifest = validateInitialManifest5(JSON.parse(original.toString()))
  const key = 'doc:' + documentId, baseHash = manifest.entries[key], old = server.files.get(prefix + objectPath(baseHash))!
  expect(publicationHash(old)).toBe(baseHash)
  expect(JSON.parse(old.toString()).kind).toBe('document')
  const record = { kind: 'deleted', id: documentId }, bytes = publicationJson(record), digest = publicationHash(bytes)
  manifest.entries[key] = digest
  const beforeHash = publicationHash(original)
  if (manifest.history) manifest.history = protocol5HistoryLink(manifest.history.targetFingerprint, randomUUID(), beforeHash)
  validateSyncedProtocol5Snapshot(manifest, Object.entries(manifest.entries).map(([entry, hash]) => ({
    key: entry, record: hash === digest ? record : JSON.parse(server.files.get(prefix + objectPath(hash))!.toString())
  })))
  const authorization = 'Basic ' + Buffer.from('test:app-secret').toString('base64')
  const put = (path: string, body: string, condition: Record<string, string>) => fetch(new URL(directory + '/' + path, server.url),
    { method: 'PUT', headers: { authorization, ...condition }, body })
  expect((await put(objectPath(digest), bytes, { 'If-None-Match': '*' })).ok).toBe(true)
  if (manifest.history) expect((await put('objects/manifest-' + beforeHash + '.json', original.toString(), { 'If-None-Match': '*' })).ok).toBe(true)
  expect((await put(manifestPath, publicationJson(manifest), { 'If-Match': '"' + beforeHash + '"' })).ok).toBe(true)
  return Buffer.from(server.files.get(prefix + manifestPath)!)
}

test('production WebDAV preserves legacy data, joins a fresh independent profile and resolves offline competition @electron', async () => {
  // Keep the loopback connection available while Main revalidates the SQLite snapshot.
  const server = await createWebDavServer({ keepAliveTimeout: 0 }), receiverRoot = mkdtempSync(join(tmpdir(), 'kb-webdav-receiver-'))
  let sender: ElectronAppContext | null = null, receiver: ElectronAppContext | null = null
  let receiverLaunchStarted = false
  let receiverLaunch: Promise<ElectronAppContext> | null = null
  try {
    sender = await launchElectronApp({}, { editorMode: 'markdown' })
    receiverLaunchStarted = true
    receiverLaunch = launchElectronApp({}, { userDataRoot: receiverRoot, startupArgs: [
      `--knowbook-user-data-dir=${receiverRoot}`, '--knowbook-initialize-sync-receiver'
    ] })
    // Observe a launch failure even while the sender is still publishing.
    void receiverLaunch.catch(() => undefined)
    const { page } = sender
    const original = await page.evaluate(async () => {
      const doc = await window.knowbook.createDocument(null), blockId = crypto.randomUUID()
      const title = 'Protocol 5 ordinary seed', content = 'Original shared text 中文'
      await window.knowbook.updateDocument(doc.id, { title, summary: '', blocks: [{ id: blockId, type: 'paragraph', content, checked: false, depth: 0 }] })
      return { docId: doc.id, blockId, title, content }
    })
    await configure(page, server.url, 'legacy-keep', false)
    await page.evaluate(() => window.knowbook.syncWebDavNow())
    const legacyManifest = Buffer.from(server.files.get('/legacy-keep/manifest.json')!)
    expect(JSON.parse(legacyManifest.toString()).version).toBe(1)

    await page.reload()
    await page.locator('.tree-button', { hasText: original.title }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText(original.title)
    const row = page.locator(`.block-editor-row[data-block-id="${original.blockId}"]`)
    await row.hover(); await row.locator('.block-drag-handle').click()
    await page.getByRole('dialog', { name: uiText('Block actions', '内容块操作'), exact: true })
      .getByRole('button', { name: uiText('Create synced block…', '创建同步块…'), exact: true }).click()
    const dialog = page.getByRole('dialog', { name: uiText('Create synced block', '创建同步块'), exact: true })
    await dialog.getByRole('button', { name: uiText('Create synced block', '创建同步块'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const address = await page.evaluate(async hostDocumentId => {
      const host = await window.knowbook.getDocumentDetail(hostDocumentId)
      const ref = host?.blocks.find(block => block.type === 'synced-block')
      if (!ref) throw new Error('Main did not create the actual synced reference.')
      return { hostDocumentId, instanceId: ref.id, groupId: JSON.parse(ref.content).groupId as string }
    }, original.docId)

    await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
    await page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
    const settings = page.getByRole('region', { name: uiText('WebDAV sync', 'WebDAV 同步') })
    const mode = settings.getByRole('checkbox', { name: uiText('Enable synced-block protocol for this folder', '在此目录启用同步块协议') })
    await mode.check()
    await settings.getByRole('button', { name: uiText('Save sync settings', '保存同步设置') }).click()
    await expect.poll(() => page.evaluate(async () => (await window.knowbook.getWebDavSyncStatus()).protocol5)).toBe(true)
    const requestStart = server.requests.length
    await expect(page.evaluate(() => window.knowbook.syncWebDavNow())).rejects.toThrow(/旧版 KnowBook 同步/)
    expect(server.files.get('/legacy-keep/manifest.json')).toEqual(legacyManifest)
    expect(server.requests.slice(requestStart).every(request => ['GET', 'HEAD', 'PROPFIND'].includes(request.method))).toBe(true)
    await configure(page, server.url, 'protocol5-test', true)
    await page.evaluate(() => window.knowbook.syncWebDavNow())
    const manifest = JSON.parse(server.files.get('/protocol5-test/manifest.json')!.toString())
    expect(manifest.version).toBe(5)
    expect(manifest.history.previousHash).toBeNull()
    expect(manifest.entries[`group:${address.groupId}`]).toMatch(/^[a-f0-9]{64}$/)

    receiver = await receiverLaunch
    receiverLaunch = null
    expect(await receiver.page.evaluate(async () => (await window.knowbook.getHomeData()).documentCatalog.length)).toBe(0)
    await configure(receiver.page, server.url, 'protocol5-test', true)
    const incoming = await receiver.page.evaluate(() => window.knowbook.syncWebDavNow())
    expect(incoming.downloaded).toBeGreaterThan(0)
    await closeElectronApp(receiver, { preserveUserData: true })
    receiver = null
    receiver = await launchElectronApp({}, { userDataRoot: receiverRoot })
    expect((await receiver.page.evaluate(() => window.knowbook.getWebDavSyncStatus())).protocol5).toBe(true)
    const resolved = await receiver.page.evaluate(input => window.knowbook.resolveSyncedInlineInstance(input), address)
    expect(resolved.status).toBe('ready')
    if (resolved.status !== 'ready') throw new Error('The independently reopened Main could not resolve the imported instance.')
    expect(resolved.snapshot.blocks.find(block => block.id === original.blockId)?.content).toBe(original.content)
    // The default E2E credential backend is intentionally per process.
    // Re-enter the fixture password while preserving the actual sync route.
    await configure(receiver.page, server.url, 'protocol5-test', true)
    const common = 'Shared body updated on B'
    await editSharedBody(receiver.page, address, common)
    const edited = await receiver.page.evaluate(async () => {
      const doc = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(doc.id, { title: 'From independent receiver', summary: '', blocks: [
        { id: crypto.randomUUID(), type: 'paragraph', content: 'B to A', checked: false, depth: 0 }
      ] })
      await window.knowbook.syncWebDavNow()
      return doc.id
    })
    await page.evaluate(() => window.knowbook.syncWebDavNow())
    expect((await page.evaluate(id => window.knowbook.getDocumentDetail(id), edited))?.title).toBe('From independent receiver')
    const creationId = resolved.snapshot.creationId
    expect(await readSharedBody(page, address, original.blockId)).toEqual({ creationId, content: common })

    const localA = 'Offline text from profile A', localB = 'Offline text from profile B', laterB = 'Profile B edit after preview'
    server.setHook(() => 403)
    await expect(page.evaluate(() => window.knowbook.testWebDavConnection())).rejects.toThrow(/WebDAV/)
    await expect(receiver.page.evaluate(() => window.knowbook.testWebDavConnection())).rejects.toThrow(/WebDAV/)
    const offlineStart = server.requests.length, beforeOffline = Buffer.from(server.files.get('/protocol5-test/manifest.json')!)
    await editSharedBody(page, address, localA)
    await editSharedBody(receiver.page, address, localB)
    expect(server.requests).toHaveLength(offlineStart)
    expect(server.files.get('/protocol5-test/manifest.json')).toEqual(beforeOffline)
    server.setHook(undefined)
    await page.evaluate(() => window.knowbook.syncWebDavNow())
    const beforeResolve = Buffer.from(server.files.get('/protocol5-test/manifest.json')!)
    expect(beforeResolve).not.toEqual(beforeOffline)
    const conflicted = await receiver.page.evaluate(() => window.knowbook.syncWebDavNow())
    expect(conflicted.message).toMatch(/冲突仍保留/)
    expect(await readSharedBody(receiver.page, address, original.blockId)).toEqual({ creationId, content: localB })

    await receiver.page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
    await receiver.page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
    const conflicts = receiver.page.getByRole('region', { name: uiText('Synced block conflicts', '同步块冲突') })
    const preview = conflicts.getByRole('button', { name: uiText('Read latest conflicts', '读取最新冲突') })
    const useLocal = conflicts.getByRole('button', { name: uiText('Apply entire local group', '应用本机整组') })
    const beforePreview = server.requests.length
    await preview.click()
    await expect(useLocal).toBeEnabled()
    for (const text of [common, localA, localB]) await expect(conflicts.locator('pre').filter({ hasText: text })).toBeVisible()
    expect(server.requests.slice(beforePreview).every(request => ['GET', 'HEAD', 'PROPFIND'].includes(request.method))).toBe(true)
    expect(server.files.get('/protocol5-test/manifest.json')).toEqual(beforeResolve)
    await expect(receiver.page.evaluate(async () => {
      const preview = (await window.knowbook.getWebDavSyncStatus()).protocol5Preview!
      return window.knowbook.resolveWebDavProtocol5Conflict({ previewId: preview.previewId, previewHash: '0'.repeat(64),
        componentId: preview.components[0].componentId, choice: 'local' })
    })).rejects.toThrow(/预览已失效/)

    await editSharedBody(receiver.page, address, laterB)
    await useLocal.click()
    await expect(preview).toBeEnabled()
    expect(server.files.get('/protocol5-test/manifest.json')).toEqual(beforeResolve)
    expect(await readSharedBody(receiver.page, address, original.blockId)).toEqual({ creationId, content: laterB })
    await preview.click()
    await expect(conflicts.locator('pre').filter({ hasText: laterB })).toBeVisible()
    await useLocal.click()
    await expect(preview).toBeEnabled()
    expect(server.files.get('/protocol5-test/manifest.json')).not.toEqual(beforeResolve)
    await page.evaluate(() => window.knowbook.syncWebDavNow())
    expect(await readSharedBody(page, address, original.blockId)).toEqual({ creationId, content: laterB })
    expect(await readSharedBody(receiver.page, address, original.blockId)).toEqual({ creationId, content: laterB })

    const editedBeforeDeletion = 'Local document edited before the deletion arrived'
    const editedAfterDeletionPreview = 'Local document edited after the deletion preview'
    await editDocumentBody(receiver.page, edited, editedBeforeDeletion)
    const tombstone = await publishDocumentTombstone(server, 'protocol5-test', edited)
    const deletionConflict = await receiver.page.evaluate(() => window.knowbook.syncWebDavNow())
    expect(deletionConflict.message).toMatch(/冲突仍保留/)
    const deletionRegion = receiver.page.getByRole('region', { name: uiText('Synced block deletion conflicts', '同步块删除冲突') })
    const readDeletions = deletionRegion.getByRole('button', { name: uiText('Read deletion conflicts', '读取删除冲突') })
    const beforeDeletionPreview = server.requests.length
    await readDeletions.click()
    await expect(deletionRegion.getByText(uiText('Remote version · Deleted', '远端版本 · 已删除'), { exact: true })).toBeVisible()
    await expect(deletionRegion.locator('pre').filter({ hasText: 'B to A' })).toBeVisible()
    await expect(deletionRegion.locator('pre').filter({ hasText: editedBeforeDeletion })).toBeVisible()
    expect(server.requests.slice(beforeDeletionPreview).every(request => ['GET', 'HEAD', 'PROPFIND'].includes(request.method))).toBe(true)
    expect(server.files.get('/protocol5-test/manifest.json')).toEqual(tombstone)
    const keepDelete = deletionRegion.getByRole('button', { name: uiText('Keep deletion', '保留删除'), exact: true })
    const confirmDelete = deletionRegion.getByRole('button', { name: uiText('Confirm permanent deletion', '确认保留永久删除'), exact: true })
    await editDocumentBody(receiver.page, edited, editedAfterDeletionPreview)
    await keepDelete.click()
    await expect(confirmDelete).toBeEnabled()
    expect((await receiver.page.evaluate(id => window.knowbook.getDocumentDetail(id), edited))?.blocks[0].content).toBe(editedAfterDeletionPreview)
    expect(server.files.get('/protocol5-test/manifest.json')).toEqual(tombstone)
    await confirmDelete.click()
    await expect(readDeletions).toBeEnabled()
    expect((await receiver.page.evaluate(id => window.knowbook.getDocumentDetail(id), edited))?.blocks[0].content).toBe(editedAfterDeletionPreview)
    expect(server.files.get('/protocol5-test/manifest.json')).toEqual(tombstone)
    await readDeletions.click()
    await expect(deletionRegion.locator('pre').filter({ hasText: editedAfterDeletionPreview })).toBeVisible()
    await keepDelete.click()
    await confirmDelete.click()
    await expect(readDeletions).toBeEnabled()
    const finalDeletion = await receiver.page.evaluate(async id => {
      const [document, status] = await Promise.all([
        window.knowbook.getDocumentDetail(id),
        window.knowbook.getWebDavSyncStatus()
      ])
      return { document, phase: status.phase, message: status.message }
    }, edited)
    expect(finalDeletion.document, `WebDAV deletion status (${finalDeletion.phase}): ${finalDeletion.message}`).toBeNull()
    expect(server.files.get('/protocol5-test/manifest.json')).toEqual(tombstone)
  } finally {
    const closeReceiver = async () => {
      if (receiverLaunch) receiver = await receiverLaunch.catch(() => null)
      await closeElectronApp(receiver, { preserveUserData: true })
    }
    const hosts = await Promise.allSettled([
      closeReceiver(),
      closeElectronApp(sender)
    ])
    // A failed launch without an app handle may leave a host using this root.
    const canRemoveReceiver = hosts[0].status === 'fulfilled' && (receiver !== null || !receiverLaunchStarted)
    const resources = await Promise.allSettled([
      server.close(),
      canRemoveReceiver ? rm(receiverRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) : undefined
    ])
    const errors = [...hosts, ...resources].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'WebDAV fixture cleanup failed.')
  }
})
