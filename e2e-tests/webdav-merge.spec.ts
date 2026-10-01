import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { withElectronApp, uiText } from './helpers/electron'
import { createWebDavServer } from '../tests/helpers/webdav-server'
import { canonicalJson, type SyncDocument } from '../src/main/sync/model'

async function seed(page: Page, url: string, title: string) {
  return page.evaluate(async ({ url, title }) => {
    const document = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(document.id, {
      title, summary: 'base summary', blocks: ['base overlap', 'base remote field', 'base local field'].map(content => ({
        id: crypto.randomUUID(), type: 'paragraph', content, checked: false, depth: 0
      }))
    })
    await window.knowbook.saveWebDavSyncConfig({
      enabled: false, url, username: 'test', password: 'app-secret', directory: 'KnowBook', intervalMinutes: 5, allowInsecureHttp: true
    })
    await window.knowbook.syncWebDavNow()
    return document.id
  }, { url, title })
}

function publishRemote(server: Awaited<ReturnType<typeof createWebDavServer>>, id: string, change: (record: SyncDocument) => void) {
  const manifest = JSON.parse(server.files.get('/KnowBook/manifest.json')!.toString())
  const record = JSON.parse(server.files.get(`/KnowBook/objects/${manifest.entries[`doc:${id}`]}.json`)!.toString()) as SyncDocument
  change(record)
  const bytes = Buffer.from(canonicalJson(record)), hash = createHash('sha256').update(bytes).digest('hex')
  server.files.set(`/KnowBook/objects/${hash}.json`, bytes)
  manifest.entries[`doc:${id}`] = hash
  server.files.set('/KnowBook/manifest.json', Buffer.from(canonicalJson(manifest)))
  return hash
}

async function settings(page: Page) {
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
  const section = page.getByRole('region', { name: uiText('WebDAV sync', 'WebDAV 同步') })
  await expect(section).toBeVisible()
  return section
}

test('independent changes merge through sync settings and reopen as one complete document @electron', async () => {
  const server = await createWebDavServer()
  try {
    await withElectronApp(async ({ page }) => {
      const id = await seed(page, server.url, 'Automatic merge')
      publishRemote(server, id, record => { record.content.title = 'Merged remote title'; record.content.blocks[1].content = 'remote independent block' })
      await page.evaluate(async id => {
        const document = (await window.knowbook.getDocumentDetail(id))!
        await window.knowbook.updateDocument(id, { title: document.title, summary: 'local independent summary',
          blocks: document.blocks.map((block, index) => index === 2 ? { ...block, content: 'local independent block' } : block) })
      }, id)
      const section = await settings(page)
      await section.getByRole('button', { name: uiText('Sync now', '立即同步') }).click()
      await expect.poll(() => page.evaluate(() => window.knowbook.getWebDavSyncStatus())).toMatchObject({ phase: 'idle', merged: 1, conflicts: [] })
      await expect(section.locator('.webdav-conflict-card')).toHaveCount(0)
      const merged = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
      expect(merged).toMatchObject({ title: 'Merged remote title', summary: 'local independent summary' })
      expect(merged!.blocks.map(block => block.content)).toEqual(['base overlap', 'remote independent block', 'local independent block'])
      await page.getByTitle(uiText('Documents', '文档'), { exact: true }).click()
      await page.locator('.tree-button', { hasText: 'Merged remote title' }).first().click()
      await expect(page.locator('[data-block-index="1"] textarea')).toHaveValue('remote independent block')
      await expect(page.locator('[data-block-index="2"] textarea')).toHaveValue('local independent block')
    })
  } finally { await server.close() }
})

test('custom title and block choices preserve independent edits and a saved merge survives reopening @electron', async ({}, testInfo) => {
  const server = await createWebDavServer()
  try {
    await withElectronApp(async ({ page }) => {
      const id = await seed(page, server.url, 'Manual merge')
      publishRemote(server, id, record => {
        record.content.title = 'Remote title'; record.content.blocks[0].content = 'remote overlap'; record.content.blocks[1].content = 'remote independent block'
      })
      await page.evaluate(async id => {
        const document = (await window.knowbook.getDocumentDetail(id))!
        await window.knowbook.updateDocument(id, { title: 'Local title', summary: 'local independent summary', blocks: document.blocks.map((block, index) =>
          index === 0 ? { ...block, content: 'local overlap' } : index === 2 ? { ...block, content: 'local independent block' } : block) })
        await window.knowbook.syncWebDavNow()
      }, id)
      const section = await settings(page), card = section.locator('.webdav-conflict-card')
      await card.locator(':scope > summary').click()
      await card.getByRole('button', { name: uiText('Merge changes', '逐项合并'), exact: true }).click()
      const title = card.getByRole('group', { name: uiText('Title', '标题'), exact: true })
      const body = card.getByRole('group', { name: uiText('Block 1', '正文块 1'), exact: true })
      const save = card.getByRole('button', { name: uiText('Save merge plan', '保存合并方案') })
      await expect(save).toBeDisabled()
      await title.getByLabel(uiText('Custom merged text', '自定义合并内容')).check()
      await title.getByLabel(uiText('Title merged content', '标题合并内容')).fill('Reviewed merged title')
      await expect(save).toBeDisabled()
      await body.getByLabel(uiText('Keep remote change', '保留远端改动')).check()
      await card.getByRole('button', { name: uiText('Preview merge result', '预览合并结果') }).click()
      await expect(card.locator('.webdav-conflict-result')).toContainText('Reviewed merged title')
      await expect(card.locator('.webdav-conflict-result')).toContainText('remote independent block')
      await expect(card.locator('.webdav-conflict-result')).toContainText('local independent block')
      await save.click()
      await expect(card.locator('.webdav-conflict-pending').first()).toContainText(/待同步应用|Pending sync/)
      expect(await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.title, id)).toBe('Local title')
      await page.screenshot({ path: testInfo.outputPath('webdav-custom-merge.png') })
      await page.reload()
      const reopened = await settings(page)
      await expect(reopened.locator('.webdav-conflict-pending').first()).toContainText(/待同步应用|Pending sync/)
      const restoredCard = reopened.locator('.webdav-conflict-card')
      await restoredCard.locator(':scope > summary').click()
      await restoredCard.getByRole('button', { name: uiText('Merge changes', '逐项合并'), exact: true }).click()
      await expect(restoredCard.getByRole('group', { name: uiText('Title', '标题'), exact: true })
        .getByLabel(uiText('Title merged content', '标题合并内容'))).toHaveValue('Reviewed merged title')
      await expect(restoredCard.getByRole('group', { name: uiText('Block 1', '正文块 1'), exact: true })
        .getByLabel(uiText('Keep remote change', '保留远端改动'))).toBeChecked()
      await reopened.getByRole('button', { name: uiText('Sync now', '立即同步') }).click()
      await expect(reopened.locator('.webdav-conflict-card')).toHaveCount(0)
      const merged = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
      expect(merged).toMatchObject({ title: 'Reviewed merged title', summary: 'local independent summary' })
      expect(merged!.blocks.map(block => block.content)).toEqual(['remote overlap', 'remote independent block', 'local independent block'])
    })
  } finally { await server.close() }
})

test('a changed document invalidates a pending custom merge rather than replacing the new draft @electron', async () => {
  const server = await createWebDavServer()
  try {
    await withElectronApp(async ({ page }) => {
      const id = await seed(page, server.url, 'Pending merge')
      publishRemote(server, id, record => { record.content.title = 'Remote title' })
      await page.evaluate(async id => {
        const document = (await window.knowbook.getDocumentDetail(id))!
        await window.knowbook.updateDocument(id, { title: 'Local title', summary: document.summary, blocks: document.blocks })
        await window.knowbook.syncWebDavNow()
      }, id)
      const section = await settings(page), card = section.locator('.webdav-conflict-card')
      await card.locator(':scope > summary').click()
      await card.getByRole('button', { name: uiText('Merge changes', '逐项合并'), exact: true }).click()
      const title = card.getByRole('group', { name: uiText('Title', '标题'), exact: true })
      await title.getByLabel(uiText('Custom merged text', '自定义合并内容')).check()
      await title.getByLabel(uiText('Title merged content', '标题合并内容')).fill('Obsolete custom title')
      await card.getByRole('button', { name: uiText('Save merge plan', '保存合并方案') }).click()
      await expect(card.locator('.webdav-conflict-pending').first()).toBeVisible()
      await page.evaluate(async id => {
        const document = (await window.knowbook.getDocumentDetail(id))!
        await window.knowbook.updateDocument(id, { title: 'Newest local draft', summary: document.summary, blocks: document.blocks })
      }, id)
      await section.getByRole('button', { name: uiText('Sync now', '立即同步') }).click()
      await expect.poll(() => page.evaluate(async () => (await window.knowbook.getWebDavSyncStatus()).conflicts[0]?.resolution)).toBe(null)
      expect(await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.title, id)).toBe('Newest local draft')
      await expect(card.locator('.webdav-conflict-pending')).toHaveCount(0)
      await card.locator(':scope > summary').click()
      await expect(card.locator('.webdav-conflict-comparison').first()).toContainText('Newest local draft')
      await expect(card.locator('.webdav-conflict-comparison').first()).toContainText('Remote title')
    })
  } finally { await server.close() }
})

test('automatic merge keeps an actively edited unsaved block intact when the remote version arrives @electron', async () => {
  const server = await createWebDavServer()
  let release!: () => void
  try {
    await withElectronApp(async ({ page }) => {
      const id = await seed(page, server.url, 'Active merge draft')
      await page.evaluate(async id => {
        const document = (await window.knowbook.getDocumentDetail(id))!
        await window.knowbook.updateDocument(id, { title: document.title, summary: document.summary,
          blocks: document.blocks.map((block, index) => index === 2 ? { ...block, content: 'stored local change' } : block) })
      }, id)
      await page.reload()
      await page.locator('.tree-button', { hasText: 'Active merge draft' }).first().click()
      const editor = page.locator('[data-block-index="2"] textarea')
      await expect(editor).toHaveValue('stored local change')
      const hash = publishRemote(server, id, record => { record.content.title = 'Received merged title' })
      let waiting = false
      const gate = new Promise<void>(resolve => { release = resolve })
      server.setHook(async request => { if (request.method === 'GET' && request.url!.endsWith(`${hash}.json`)) { waiting = true; await gate } })
      await page.evaluate(() => { void window.knowbook.syncWebDavNow().catch(() => {}) })
      await expect.poll(() => waiting).toBe(true)
      await editor.fill('unsaved newer draft survives auto merge')
      release()
      await expect.poll(() => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.title, id)).toBe('Received merged title')
      await expect(editor).toHaveValue('unsaved newer draft survives auto merge')
      await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
      const stored = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
      expect(stored!.blocks[2].content).toBe('stored local change')
      expect(await page.evaluate(async () => (await window.knowbook.getWebDavSyncStatus()).conflicts)).toHaveLength(0)
    })
  } finally { release?.(); await server.close() }
})
