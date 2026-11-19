import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeElectronApp, launchElectronApp, relaunchElectronApp, uiText, type ElectronAppContext } from './helpers/electron'
import { createWebDavServer } from '../tests/helpers/webdav-server'
import { publicationHash } from '../src/main/sync/synced-publication-model'

function configure(page: Page, url: string, directory: string) {
  return page.evaluate(input => window.knowbook.saveWebDavSyncConfig({ ...input,
    enabled: false, username: 'test', password: 'app-secret', intervalMinutes: 5, allowInsecureHttp: true
  }), { url, directory })
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

test('production WebDAV publishes ordinary notes, joins a later version and resolves offline competition and deletion @electron', async () => {
  // Keep the loopback connection available while Main revalidates the SQLite snapshot.
  const server = await createWebDavServer({ keepAliveTimeout: 0 }), receiverRoot = mkdtempSync(join(tmpdir(), 'kb-webdav-receiver-'))
  let sender: ElectronAppContext | null = null, receiver: ElectronAppContext | null = null
  let receiverLaunchStarted = false
  let receiverLaunch: Promise<ElectronAppContext> | null = null
  try {
    sender = await launchElectronApp({ KNOWBOOK_E2E_SEED_EXAMPLES: '0' }, { editorMode: 'markdown' })
    receiverLaunchStarted = true
    receiverLaunch = launchElectronApp({ KNOWBOOK_E2E_SEED_EXAMPLES: '0' }, { userDataRoot: receiverRoot })
    // Observe a launch failure even while the sender is still publishing.
    void receiverLaunch.catch(() => undefined)
    const { page } = sender
    const original = await page.evaluate(async () => {
      const doc = await window.knowbook.createDocument(null), blockId = crypto.randomUUID()
      const title = 'Protocol 5 ordinary seed', content = 'Original shared text 中文'
      await window.knowbook.updateDocument(doc.id, { title, summary: '', blocks: [{ id: blockId, type: 'paragraph', content, checked: false, depth: 0 }] })
      const database = await window.knowbook.createDocumentDatabase({ name: 'Protocol 5 user database', description: '' })
      const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
      const databaseValue = 'First published notes 中文'
      const record = await window.knowbook.createDatabaseEntity({ databaseId: database.id, title: 'Synced user record',
        fieldValues: { [field.id]: databaseValue } })
      return { docId: doc.id, blockId, title, content, record, fieldId: field.id, databaseValue }
    })
    const { record, fieldId, databaseValue } = original
    const recordAddress = { databaseId: record.databaseId, id: record.id }
    const recordIdentity = { ...recordAddress, title: record.title, createdAt: record.createdAt }
    const readRecord = (target: Page) => target.evaluate(async ({ databaseId, id }) =>
      (await window.knowbook.getDatabaseEntities(databaseId)).find(entity => entity.id === id), recordAddress)
    const legacyManifest = Buffer.from(JSON.stringify({ version: 1, workspaceId: 'unsupported', entries: {} }))
    server.files.set('/legacy-keep/manifest.json', legacyManifest)
    await configure(page, server.url, 'legacy-keep')
    const requestStart = server.requests.length
    await expect(page.evaluate(() => window.knowbook.syncWebDavNow())).rejects.toThrow(/协议不受支持/)
    expect(server.files.get('/legacy-keep/manifest.json')).toEqual(legacyManifest)
    expect(server.requests.slice(requestStart).every(request => ['GET', 'HEAD', 'PROPFIND'].includes(request.method))).toBe(true)

    await configure(page, server.url, 'protocol5-test')
    await page.evaluate(() => window.knowbook.syncWebDavNow())
    const genesis = Buffer.from(server.files.get('/protocol5-test/manifest.json')!)
    const genesisManifest = JSON.parse(genesis.toString())
    expect(genesisManifest).toMatchObject({ version: 5, history: { previousHash: null }, syncedInstances: [],
      entries: { databases: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    const catalog = JSON.parse(server.files.get(`/protocol5-test/objects/${genesisManifest.entries.databases}.json`)!.toString())
    expect(catalog).toMatchObject({ kind: 'databases', tables: {
      database_entities: expect.arrayContaining([expect.objectContaining({ id: record.id, database_id: record.databaseId, title: record.title })]),
      database_entity_values: expect.arrayContaining([expect.objectContaining({ entity_id: record.id, column_id: fieldId, value_text: databaseValue })])
    } })

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

    await page.evaluate(() => window.knowbook.syncWebDavNow())
    const manifest = JSON.parse(server.files.get('/protocol5-test/manifest.json')!.toString())
    expect(manifest.version).toBe(5)
    expect(manifest.history.previousHash).toBe(publicationHash(genesis))
    expect(manifest.entries[`group:${address.groupId}`]).toMatch(/^[a-f0-9]{64}$/)

    receiver = await receiverLaunch
    receiverLaunch = null
    expect(await receiver.page.evaluate(async () => (await window.knowbook.getHomeData()).documentCatalog.length)).toBe(0)
    await configure(receiver.page, server.url, 'protocol5-test')
    const incoming = await receiver.page.evaluate(() => window.knowbook.syncWebDavNow())
    expect(incoming.downloaded).toBeGreaterThan(0)
    await closeElectronApp(receiver, { preserveUserData: true })
    receiver = null
    receiver = await relaunchElectronApp({ userDataRoot: receiverRoot })
    expect((await receiver.page.evaluate(() => window.knowbook.getWebDavSyncStatus())).lastSyncAt).toBeTruthy()
    expect(await readRecord(receiver.page)).toMatchObject({ ...recordIdentity, fieldValues: { [fieldId]: databaseValue } })
    const resolved = await receiver.page.evaluate(input => window.knowbook.resolveSyncedInlineInstance(input), address)
    expect(resolved.status).toBe('ready')
    if (resolved.status !== 'ready') throw new Error('The independently reopened Main could not resolve the imported instance.')
    expect(resolved.snapshot.blocks.find(block => block.id === original.blockId)?.content).toBe(original.content)
    // The default E2E credential backend is intentionally per process.
    // Re-enter the fixture password while preserving the actual sync route.
    await configure(receiver.page, server.url, 'protocol5-test')
    const common = 'Shared body updated on B'
    await editSharedBody(receiver.page, address, common)
    const updatedValue = 'Notes edited on the joined profile 中文'
    const edited = await receiver.page.evaluate(async ({ entityId, fieldId, value }) => {
      await window.knowbook.updateDatabaseEntity({ entityId, fieldValues: { [fieldId]: value } })
      const doc = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(doc.id, { title: 'From independent receiver', summary: '', blocks: [
        { id: crypto.randomUUID(), type: 'paragraph', content: 'B to A', checked: false, depth: 0 }
      ] })
      await window.knowbook.syncWebDavNow()
      return doc.id
    }, { entityId: record.id, fieldId, value: updatedValue })
    await page.evaluate(() => window.knowbook.syncWebDavNow())
    expect((await page.evaluate(id => window.knowbook.getDocumentDetail(id), edited))?.title).toBe('From independent receiver')
    expect(await readRecord(page)).toMatchObject({ ...recordIdentity, fieldValues: { [fieldId]: updatedValue } })
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
    await page.evaluate(async id => {
      await window.knowbook.deleteDocument(id)
      await window.knowbook.syncWebDavNow()
    }, edited)
    const tombstone = Buffer.from(server.files.get('/protocol5-test/manifest.json')!)
    const deletedHash = JSON.parse(tombstone.toString()).entries[`doc:${edited}`]
    expect(JSON.parse(server.files.get(`/protocol5-test/objects/${deletedHash}.json`)!.toString())).toMatchObject({ kind: 'deleted', id: edited })
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
