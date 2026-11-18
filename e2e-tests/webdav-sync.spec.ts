import { expect, test } from '@playwright/test'
import { withElectronApp, uiText } from './helpers/electron'
import { createWebDavServer } from '../tests/helpers/webdav-server'
import { createHash } from 'node:crypto'
import { publishRemoteProtocol5Documents } from './helpers/webdav-protocol5'

test('sync shows live attachment progress, survives reopening settings, and clears after cancellation @electron', async ({}, testInfo) => {
  const server = await createWebDavServer()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let waiting = false
  try {
    await withElectronApp(async ({ page }) => {
      await page.evaluate(async url => {
        const [image, pdf] = await window.knowbook.importAttachments([
          { name: 'first.png', bytes: new TextEncoder().encode('first-image') },
          { name: 'second.pdf', bytes: new TextEncoder().encode('second-file') }
        ])
        const doc = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(doc.id, { title: 'Progress check', summary: '', blocks: [{ id: crypto.randomUUID(), type: 'paragraph',
          content: `![first](${image.url})\n[second](${pdf.url})`, checked: false, depth: 0 }] })
        await window.knowbook.saveWebDavSyncConfig({ enabled: false, url, username: 'test', password: 'app-secret', directory: 'KnowBook', intervalMinutes: 5, allowInsecureHttp: true })
        await window.knowbook.testWebDavConnection()
      }, server.url)
      // The manifest orders assets by digest. Pause the second transfer.
      const asset = createHash('sha256').update('first-image').digest('hex')
      server.setHook(async req => { if (req.method === 'PUT' && req.url!.endsWith(`/assets/${asset}`)) { waiting = true; await gate } })
      await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
      await page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
      const section = page.getByRole('region', { name: uiText('WebDAV sync', 'WebDAV 同步') })
      await section.getByRole('button', { name: uiText('Sync now', '立即同步') }).click()
      await expect.poll(() => waiting).toBe(true)
      await expect(section.getByRole('status')).toContainText(/正在上传|Uploading/)
      await expect(section.locator('.webdav-sync-progress-counts')).toContainText('1 / 2')
      await expect(section.locator('.webdav-sync-progress')).toContainText('first.png')
      const bar = section.getByRole('progressbar')
      await expect(bar).toBeVisible()
      expect(Number(await bar.getAttribute('value'))).toBeGreaterThan(0)
      await page.screenshot({ path: testInfo.outputPath('webdav-live-progress.png') })
      await page.reload()
      await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
      await page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
      await expect(section.getByRole('status')).toContainText(/正在上传|Uploading/)
      await expect(section.locator('.webdav-sync-progress')).toContainText('first.png')
      await section.getByRole('button', { name: uiText('Stop this sync', '停止本次同步') }).click()
      await expect(section.getByRole('status')).toContainText('已停止')
      await expect(bar).toHaveCount(0)
      await expect(section.getByRole('button', { name: uiText('Sync now', '立即同步') })).toBeEnabled()
      release(); server.setHook(undefined)
      await section.getByRole('button', { name: uiText('Sync now', '立即同步') }).click()
      await expect(section.getByRole('status')).toContainText(/同步完成|首次发布完成/)
      await expect(bar).toHaveCount(0)
      const manifest = JSON.parse(server.files.get('/KnowBook/manifest.json')!.toString())
      expect(manifest).toMatchObject({ version: 5, history: { previousHash: null } })
    })
  } finally { release(); await server.close() }
})

test('WebDAV settings validate, sync, preserve passwords, and surface recoverable errors @electron', async ({}, testInfo) => {
  const server = await createWebDavServer()
  server.setOptions({ etagHeaders: 'none', etagStyle: 'bare', ignoreIfNoneMatch: true, moveConflictStatus: 409 })
  try {
    await withElectronApp(async ({ page }) => {
      await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
      await page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
      const section = page.getByRole('region', { name: uiText('WebDAV sync', 'WebDAV 同步') })
      await expect(section).toBeVisible()
      await section.getByLabel(uiText('WebDAV URL', 'WebDAV 服务地址'), { exact: true }).fill(server.url)
      await section.getByLabel(uiText('Username', '用户名'), { exact: true }).fill('test')
      await section.getByLabel(uiText('App password', '应用密码'), { exact: true }).fill('app-secret')
      await section.getByRole('button', { name: uiText('Save sync settings', '保存同步设置') }).click()
      await expect(section.getByRole('alert')).toContainText('HTTPS')
      await section.getByLabel(/允许 HTTP|Allow HTTP/).check()
      await section.getByRole('button', { name: uiText('Save sync settings', '保存同步设置') }).click()
      await expect(section.getByLabel(uiText('App password', '应用密码'), { exact: true })).toHaveValue('')
      await section.getByRole('button', { name: uiText('Test connection', '测试连接') }).click()
      await expect(section.getByRole('status')).toContainText('连接成功')
      await section.getByRole('button', { name: uiText('Sync now', '立即同步') }).click()
      await expect(section.getByRole('status')).toContainText(/同步完成|首次发布完成/)
      const manifest = JSON.parse(server.files.get('/KnowBook/manifest.json')!.toString())
      expect(manifest).toMatchObject({ version: 5, history: { previousHash: null } })
      expect(server.requests.some(request => request.method === 'PROPFIND')).toBe(true)
      expect(server.requests.some(request => request.method === 'MOVE')).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('webdav-settings.png') })
      await page.reload()
      await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
      await page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
      await expect(section.getByLabel(uiText('WebDAV URL', 'WebDAV 服务地址'), { exact: true })).toHaveValue(server.url)
      await expect(section.getByLabel(uiText('App password', '应用密码'), { exact: true })).toHaveAttribute('placeholder', /已保存|Saved/)
      server.setHook(req => req.url!.endsWith('manifest.json') ? 503 : undefined)
      await section.getByRole('button', { name: uiText('Sync now', '立即同步') }).click()
      await expect(section.getByRole('alert')).toContainText('503')
      server.setHook(undefined)
      await section.getByRole('button', { name: uiText('Sync now', '立即同步') }).click()
      await expect(section.getByRole('status')).toContainText('同步完成')
    })
  } finally { await server.close() }
})

test('WebDAV conflicts can be previewed and kept as separate documents through the UI @electron', async () => {
  const server = await createWebDavServer()
  try {
    await withElectronApp(async ({ page }) => {
      const id = await page.evaluate(async url => {
        const doc = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(doc.id, { title: 'WebDAV Conflict', summary: '', blocks: [{ id: crypto.randomUUID(), type: 'paragraph', content: 'base content', checked: false, depth: 0 }] })
        await window.knowbook.saveWebDavSyncConfig({ enabled: false, url, username: 'test', password: 'app-secret', directory: 'KnowBook', intervalMinutes: 5, allowInsecureHttp: true })
        await window.knowbook.syncWebDavNow()
        return doc.id
      }, server.url)
      await publishRemoteProtocol5Documents(server, [{ id, edit: record => { record.content.blocks[0].content = 'remote edit' } }])
      await page.evaluate(async id => {
        const doc = (await window.knowbook.getDocumentDetail(id))!
        await window.knowbook.updateDocument(id, { title: doc.title, summary: '', blocks: doc.blocks.map(block => ({ ...block, content: 'local edit' })) })
        await window.knowbook.syncWebDavNow()
      }, id)
      await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
      await page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
      const section = page.getByRole('region', { name: uiText('WebDAV sync', 'WebDAV 同步') })
      const readConflicts = section.getByRole('button', { name: uiText('Read latest conflicts', '读取最新冲突'), exact: true })
      await readConflicts.click()
      const card = section.locator('.webdav-conflict-card').filter({ hasText: 'doc:' + id })
      await expect(card.locator('pre').filter({ hasText: 'local edit' })).toBeVisible()
      await expect(card.locator('pre').filter({ hasText: 'remote edit' })).toBeVisible()
      await card.getByRole('button', { name: uiText('Keep both versions', '同时保留本机和远端'), exact: true }).click()
      await expect.poll(() => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks[0].content, id)).toBe('remote edit')
      const copy = await page.evaluate(async id => {
        const { documentCatalog } = await window.knowbook.getHomeData()
        const copies = await Promise.all(documentCatalog.filter(doc => doc.id !== id).map(doc => window.knowbook.getDocumentDetail(doc.id)))
        return copies.find(doc => doc?.blocks[0]?.content === 'local edit')
      }, id)
      expect(copy).toBeTruthy()
      await readConflicts.click()
      await expect(card).toHaveCount(0)
    })
  } finally { await server.close() }
})

test('a remote update preserves an active unsaved draft and rejects its stale autosave @electron', async () => {
  const server = await createWebDavServer()
  let releaseDownload: (() => void) | undefined
  try {
    await withElectronApp(async ({ page }) => {
      const id = await page.evaluate(async url => {
        const doc = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(doc.id, { title: 'WebDAV Active Draft', summary: '', blocks: [{ id: crypto.randomUUID(), type: 'paragraph', content: 'original body', checked: false, depth: 0 }] })
        await window.knowbook.saveWebDavSyncConfig({ enabled: false, url, username: 'test', password: 'app-secret', directory: 'KnowBook', intervalMinutes: 5, allowInsecureHttp: true })
        await window.knowbook.syncWebDavNow()
        return doc.id
      }, server.url)
      await page.reload()
      await page.locator('.tree-button', { hasText: 'WebDAV Active Draft' }).first().click()
      const editor = page.locator('[data-block-index="0"] textarea')
      await expect(editor).toHaveValue('original body')

      const hashes = await publishRemoteProtocol5Documents(server, [{ id, edit: record => {
        record.content.blocks[0].content = 'remote update while editing'
      } }])
      const hash = hashes.get(id)!
      const downloadGate = new Promise<void>(resolve => { releaseDownload = resolve })
      let waiting = false
      server.setHook(async req => {
        if (req.method === 'GET' && req.url!.endsWith(`${hash}.json`)) { waiting = true; await downloadGate }
      })
      await page.evaluate(() => { void window.knowbook.syncWebDavNow().catch(() => {}) })
      await expect.poll(() => waiting).toBe(true)
      await editor.fill('unsaved local draft stays here')
      releaseDownload!()
      await expect.poll(() => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks[0].content, id)).toBe('remote update while editing')
      await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
      await expect(editor).toHaveValue('unsaved local draft stays here')
      expect(await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks[0].content, id)).toBe('remote update while editing')
    }, {}, { editorMode: 'markdown' })
  } finally { releaseDownload?.(); await server.close() }
})
