import { expect, test } from '@playwright/test'
import { withElectronApp, uiText } from './helpers/electron'
import { createWebDavServer } from '../tests/helpers/webdav-server'
import { createHash } from 'node:crypto'

test('WebDAV settings validate, sync, preserve passwords, and surface recoverable errors @electron', async ({}, testInfo) => {
  const server = await createWebDavServer()
  try {
    await withElectronApp(async ({ page }) => {
      await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
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
      await expect(section.getByRole('status')).toContainText('同步完成')
      expect(server.files.has('/KnowBook/manifest.json')).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('webdav-settings.png') })
      await page.reload()
      await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
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
      const manifest = JSON.parse(server.files.get('/KnowBook/manifest.json')!.toString())
      const original = JSON.parse(server.files.get(`/KnowBook/objects/${manifest.entries[`doc:${id}`]}.json`)!.toString())
      original.content.blocks[0].content = 'remote edit'
      const bytes = Buffer.from(JSON.stringify(original)), hash = createHash('sha256').update(bytes).digest('hex')
      server.files.set(`/KnowBook/objects/${hash}.json`, bytes)
      manifest.entries[`doc:${id}`] = hash
      server.files.set('/KnowBook/manifest.json', Buffer.from(JSON.stringify(manifest)))
      await page.evaluate(async id => {
        const doc = (await window.knowbook.getDocumentDetail(id))!
        await window.knowbook.updateDocument(id, { title: doc.title, summary: '', blocks: doc.blocks.map(block => ({ ...block, content: 'local edit' })) })
        await window.knowbook.syncWebDavNow()
      }, id)
      await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
      const section = page.getByRole('region', { name: uiText('WebDAV sync', 'WebDAV 同步') })
      await section.locator('summary', { hasText: 'WebDAV Conflict' }).click()
      await expect(section.locator('pre').first()).toContainText('local edit')
      await expect(section.locator('pre').last()).toContainText('remote edit')
      await section.getByRole('button', { name: uiText('Keep both', '两份都保留') }).click()
      await section.getByRole('button', { name: uiText('Sync now', '立即同步') }).click()
      await expect(section.locator('details')).toHaveCount(0)
      const docs = await page.evaluate(async () => (await window.knowbook.getHomeData()).documentCatalog)
      expect(docs.some(doc => doc.title.includes('同步冲突副本'))).toBe(true)
      expect(await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks[0].content, id)).toBe('remote edit')
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

      const manifest = JSON.parse(server.files.get('/KnowBook/manifest.json')!.toString())
      const remote = JSON.parse(server.files.get(`/KnowBook/objects/${manifest.entries[`doc:${id}`]}.json`)!.toString())
      remote.content.blocks[0].content = 'remote update while editing'
      const bytes = Buffer.from(JSON.stringify(remote)), hash = createHash('sha256').update(bytes).digest('hex')
      server.files.set(`/KnowBook/objects/${hash}.json`, bytes)
      manifest.entries[`doc:${id}`] = hash
      server.files.set('/KnowBook/manifest.json', Buffer.from(JSON.stringify(manifest)))
      const downloadGate = new Promise<void>(resolve => { releaseDownload = resolve })
      let waiting = false
      server.setHook(async req => {
        if (req.method === 'GET' && req.url!.endsWith(`${hash}.json`)) { waiting = true; await downloadGate }
      })
      await page.evaluate(() => { void window.knowbook.syncWebDavNow() })
      await expect.poll(() => waiting).toBe(true)
      await editor.fill('unsaved local draft stays here')
      releaseDownload!()
      await expect.poll(() => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks[0].content, id)).toBe('remote update while editing')
      await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
      await expect(editor).toHaveValue('unsaved local draft stays here')
      expect(await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks[0].content, id)).toBe('remote update while editing')
    })
  } finally { releaseDownload?.(); await server.close() }
})
