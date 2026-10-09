import { expect, test, type Page } from '@playwright/test'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { uiText, withElectronApp } from './helpers/electron'

async function createDocument(page: Page) {
  const id = await page.evaluate(async () => {
    const { id } = await window.knowbook.createDocument(null)
    const detail = (await window.knowbook.getDocumentDetail(id))!
    await window.knowbook.updateDocument(id, { ...detail, title: 'Attachment workspace', blocks: [{ ...detail.blocks[0], type: 'paragraph', content: 'Before  after' }] })
    return id
  })
  await page.reload()
  await page.locator('.tree-button', { hasText: 'Attachment workspace' }).click()
  await expect(page.locator('.block-inline-textarea').first()).toHaveValue('Before  after')
  return id
}

async function imageFixture(page: Page, size = { width: 640, height: 360 }): Promise<Buffer> {
  const base64 = await page.evaluate(size => {
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height
    const context = canvas.getContext('2d')!
    context.fillStyle = '#1e293b'; context.fillRect(0, 0, size.width, size.height)
    context.fillStyle = '#5eead4'; context.fillRect(40, 45, 560, 36)
    context.fillStyle = '#64748b'; context.fillRect(40, 110, 350, 18); context.fillRect(40, 150, 480, 18)
    context.fillStyle = '#3b82f6'; context.fillRect(40, 220, 120, 95); context.fillStyle = '#a78bfa'; context.fillRect(190, 195, 120, 120)
    return canvas.toDataURL('image/png').split(',')[1]
  }, size)
  return Buffer.from(base64, 'base64')
}

test('choose attachments, preview and zoom images, save copies, and keep media after backup restore @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ app, page, tempRoot }) => {
    const id = await createDocument(page), image = await imageFixture(page)
    await page.getByRole('button', { name: uiText('Images and attachments', '图片与附件'), exact: true }).click()
    const dialog = page.locator('.attachment-dialog')
    await dialog.locator('input[type=file]').setInputFiles([
      { name: '截图 [1] #100%.png', mimeType: 'image/png', buffer: image },
      { name: "合同 (1)'s.pdf", mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 attachment fixture') }
    ])
    await expect(dialog.locator('.attachment-card')).toHaveCount(2)
    await expect(dialog.locator('.attachment-card').first().getByRole('button', { name: uiText('Open', '打开'), exact: true })).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('attachment-manager.png') })
    await dialog.getByRole('button', { name: uiText('Preview', '预览'), exact: true }).click()
    const preview = page.locator('.attachment-image-dialog')
    await expect(preview.locator('img')).toBeVisible()
    await expect(preview.getByRole('status')).toContainText('640 × 360')
    await preview.getByRole('button', { name: uiText('Zoom in', '放大'), exact: true }).click()
    await expect(preview.getByRole('status')).toContainText('125%')
    await page.keyboard.press('Control+k'); await expect(page.locator('.global-search-modal')).toHaveCount(0)
    await page.setViewportSize({ width: 640, height: 740 })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    expect(await preview.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('image-preview-dark.png') })
    await page.keyboard.press('Escape'); await expect(preview).toHaveCount(0)
    const savedPath = join(tempRoot, 'saved-copy.pdf')
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }) })
    const pdfCard = dialog.locator('.attachment-card').filter({ hasText: "合同 (1)'s.pdf" })
    await pdfCard.getByRole('button', { name: uiText('Save as', '另存为'), exact: true }).click()
    expect(existsSync(savedPath)).toBe(false)
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, savedPath)
    await pdfCard.getByRole('button', { name: uiText('Save as', '另存为'), exact: true }).click()
    await expect.poll(() => existsSync(savedPath)).toBe(true)
    expect(readFileSync(savedPath, 'utf8')).toBe('%PDF-1.4 attachment fixture')
    await dialog.getByRole('button', { name: uiText('Close', '关闭'), exact: true }).click()
    await page.getByRole('button', { name: uiText('Save', '保存'), exact: true }).click()
    const imageUrl = await page.evaluate(async id => {
      await window.knowbook.triggerBackup()
      return (await window.knowbook.getDocumentDetail(id))!.blocks.find(block => block.content.startsWith('!['))!.content.match(/<([^>]+)>/)![1]
    }, id)
    rmSync(fileURLToPath(imageUrl))
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    await page.evaluate(async () => {
      const version = (await window.knowbook.listBackupVersions())[0]
      await window.knowbook.restoreBackupVersion(version.id)
    })
    expect(readFileSync(fileURLToPath(imageUrl))).toEqual(image)
    await page.reload(); await page.locator('.tree-button', { hasText: 'Attachment workspace' }).click()
    await expect(page.locator('.block-rich-media-image')).toBeVisible()
    expect(await page.locator('.block-rich-media-image').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(640)
  })
})

test('large image zoom follows its displayed fit size after resizing the preview @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 880 })
    await createDocument(page)
    const image = await imageFixture(page, { width: 4000, height: 2400 })
    await page.getByRole('button', { name: uiText('Images and attachments', '图片与附件'), exact: true }).click()
    const dialog = page.locator('.attachment-dialog')
    await dialog.locator('input[type=file]').setInputFiles({ name: 'large-preview.png', mimeType: 'image/png', buffer: image })
    await expect(dialog.locator('.attachment-card')).toHaveCount(1)
    await dialog.getByRole('button', { name: uiText('Preview', '预览'), exact: true }).click()
    const preview = page.locator('.attachment-image-dialog'), picture = preview.locator('img')
    await expect(picture).toBeVisible()
    await expect(preview.getByRole('status')).toContainText('4000 × 2400')
    const displayedSize = () => picture.evaluate((node: HTMLImageElement) => {
      const bounds = node.getBoundingClientRect()
      return { width: bounds.width, height: bounds.height }
    })
    const fit = preview.getByRole('button', { name: uiText('Fit to window', '适应窗口'), exact: true })
    const observations: Record<string, unknown> = {}

    const checkZoomFromFit = async (viewport: string) => {
      await expect(preview.getByRole('status')).toContainText(/Fit|自适应/)
      const fitted = await displayedSize()
      expect(fitted.width).toBeGreaterThan(0)
      expect(fitted.width).toBeLessThan(2000)
      await expect.poll(() => preview.locator('.attachment-image-stage').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await preview.getByRole('button', { name: uiText('Zoom out', '缩小'), exact: true }).click()
      await expect.poll(async () => (await displayedSize()).width).toBeLessThan(fitted.width - 1)
      const smaller = await displayedSize()
      expect(smaller.height).toBeLessThan(fitted.height)
      expect(smaller.width).toBeGreaterThan(fitted.width / 2)
      await fit.click()
      await expect.poll(async () => Math.abs((await displayedSize()).width - fitted.width)).toBeLessThan(1)
      await preview.getByRole('button', { name: uiText('Zoom in', '放大'), exact: true }).click()
      await expect.poll(async () => (await displayedSize()).width).toBeGreaterThan(fitted.width + 1)
      const larger = await displayedSize()
      expect(larger.height).toBeGreaterThan(fitted.height)
      expect(larger.width).toBeLessThanOrEqual(fitted.width * 1.5)
      await page.screenshot({ path: testInfo.outputPath(`large-image-zoom-${viewport}.png`) })
      await fit.click()
      await expect.poll(async () => Math.abs((await displayedSize()).width - fitted.width)).toBeLessThan(1)
      observations[viewport] = { fitted, smaller, larger }
      return fitted
    }

    const wide = await checkZoomFromFit('wide')
    await page.setViewportSize({ width: 760, height: 880 })
    await expect.poll(async () => (await displayedSize()).width).toBeLessThan(wide.width * .9)
    await checkZoomFromFit('narrow')
    await page.setViewportSize({ width: 1360, height: 880 })
    await expect.poll(async () => Math.abs((await displayedSize()).width - wide.width)).toBeLessThan(1)
    await testInfo.attach('large-image-displayed-sizes', { body: Buffer.from(JSON.stringify(observations, null, 2)), contentType: 'application/json' })
  })
})

test('very tall images retain usable zoom below one percent and preserve manual zoom on resize @electron', async ({}, testInfo) => {
  test.setTimeout(90_000)
  await withElectronApp(async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 400 })
    await createDocument(page)
    const image = await imageFixture(page, { width: 160, height: 32000 })
    await page.getByRole('button', { name: uiText('Images and attachments', '图片与附件'), exact: true }).click()
    const dialog = page.locator('.attachment-dialog')
    await dialog.locator('input[type=file]').setInputFiles({ name: 'tall-preview.png', mimeType: 'image/png', buffer: image })
    await expect(dialog.locator('.attachment-card')).toHaveCount(1)
    await dialog.getByRole('button', { name: uiText('Preview', '预览'), exact: true }).click()
    const preview = page.locator('.attachment-image-dialog'), picture = preview.locator('img'), status = preview.getByRole('status')
    const fit = preview.getByRole('button', { name: uiText('Fit to window', '适应窗口'), exact: true })
    const zoomOut = preview.getByRole('button', { name: uiText('Zoom out', '缩小'), exact: true })
    const zoomIn = preview.getByRole('button', { name: uiText('Zoom in', '放大'), exact: true })
    const actualSize = preview.getByRole('button', { name: uiText('Actual size', '原始大小'), exact: true })
    const displayedHeight = () => picture.evaluate((node: HTMLImageElement) => node.getBoundingClientRect().height)
    const displayedPercent = async () => Number((await status.innerText()).match(/^([\d.]+)%/)?.[1])
    await expect(status).toContainText('160 × 32000')
    const fittedHeight = await displayedHeight()
    expect(fittedHeight).toBeGreaterThan(10)
    expect(fittedHeight).toBeLessThan(320)
    await zoomOut.click()
    await expect.poll(displayedHeight).toBeLessThan(fittedHeight - 1)
    const manualHeight = await displayedHeight()
    expect(await displayedPercent()).toBeGreaterThan(0)
    expect(await displayedPercent()).toBeLessThan(1)
    await page.screenshot({ path: testInfo.outputPath('tall-image-small-zoom.png') })

    await page.setViewportSize({ width: 1360, height: 880 })
    await expect.poll(async () => Math.abs(await displayedHeight() - manualHeight)).toBeLessThan(1)
    await actualSize.click()
    await expect(status).toContainText(/^100%/)
    await expect.poll(displayedHeight).toBe(32000)
    await fit.click()
    await expect(status).toContainText(/Fit|自适应/)
    await expect.poll(displayedHeight).toBeGreaterThan(fittedHeight * 1.5)
    await page.setViewportSize({ width: 760, height: 400 })
    await expect.poll(async () => Math.abs(await displayedHeight() - fittedHeight)).toBeLessThan(1)

    let shrinkSteps = 0
    while (await zoomOut.isEnabled() && shrinkSteps < 64) {
      const before = await displayedHeight(), previousStatus = await status.innerText()
      await zoomOut.click()
      await expect(status).not.toHaveText(previousStatus)
      expect(await displayedHeight()).toBeLessThanOrEqual(before)
      shrinkSteps++
    }
    await expect(zoomOut).toBeDisabled()
    const minimumHeight = await displayedHeight()
    expect(minimumHeight).toBeGreaterThan(0)
    expect(await displayedPercent()).toBeGreaterThan(0)
    await zoomIn.click()
    await expect.poll(displayedHeight).toBeGreaterThan(minimumHeight)
    await expect(zoomOut).toBeEnabled()

    await actualSize.click()
    await expect(status).toContainText(/^100%/)
    await expect.poll(displayedHeight).toBe(32000)
    let enlargeSteps = 0
    while (await zoomIn.isEnabled() && enlargeSteps < 16) {
      const before = await displayedHeight(), previousStatus = await status.innerText()
      await zoomIn.click()
      await expect(status).not.toHaveText(previousStatus)
      expect(await displayedHeight()).toBeGreaterThan(before)
      enlargeSteps++
    }
    await expect(zoomIn).toBeDisabled()
    await expect(status).toContainText(/^400%/)
    await expect.poll(displayedHeight).toBe(128000)
    await fit.click()
    await expect(status).toContainText(/Fit|自适应/)
    await expect.poll(async () => Math.abs(await displayedHeight() - fittedHeight)).toBeLessThan(1)
    await expect(zoomOut).toBeEnabled()
    await expect(zoomIn).toBeEnabled()
    await testInfo.attach('tall-image-zoom-observations', {
      body: Buffer.from(JSON.stringify({ fittedHeight, manualHeight, minimumHeight, shrinkSteps, enlargeSteps }, null, 2)),
      contentType: 'application/json'
    })
  })
})

test('paste screenshots and drop attachments into the body, undo insertion, and persist across reload @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    const id = await createDocument(page), image = await imageFixture(page)
    await app.evaluate(({ clipboard, nativeImage }, data) => { clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(data))) }, [...image])
    const editor = page.locator('.block-inline-textarea').first()
    await editor.focus(); await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(7, 7))
    await page.keyboard.press('Control+v')
    await expect(editor).toHaveValue(/Before !\[.*\.png\].* after/s)
    await expect(page.locator('.block-rich-media-image')).toBeVisible()
    await editor.focus(); await page.keyboard.press('Control+z')
    await expect(editor).toHaveValue('Before  after')
    await page.keyboard.press('Control+y')
    await expect(editor).toHaveValue(/file:.*\.png/s)
    await editor.evaluate((node: HTMLTextAreaElement) => {
      node.setSelectionRange(node.value.length, node.value.length)
      const transfer = new DataTransfer(); transfer.items.add(new File(['drop attachment'], '拖拽.txt', { type: 'text/plain' }))
      node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    })
    await expect(editor).toHaveValue(/拖拽\.txt/)
    await expect(page.locator('.attachment-card')).toContainText('拖拽.txt')
    await page.getByRole('button', { name: uiText('Save', '保存'), exact: true }).click()
    await expect.poll(async () => (await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))!.blocks[0].content).toContain('拖拽.txt')
    await page.reload(); await page.locator('.tree-button', { hasText: 'Attachment workspace' }).click()
    await expect(page.locator('.block-rich-media-image')).toBeVisible()
    await expect(page.locator('.attachment-card')).toContainText('拖拽.txt')
  })
})

test('source editor inserts attachments at the cursor, supports undo and displays actionable failures @electron', async () => {
  await withElectronApp(async ({ page }) => {
    await createDocument(page)
    await page.getByRole('button', { name: uiText('More actions', '更多操作') }).click()
    await page.getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true }).click()
    const source = page.locator('.document-markdown-source'), editor = source.locator('.cm-content')
    await editor.click(); await page.keyboard.press('Control+End')
    await source.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') })
    await expect(editor).toContainText('notes.txt')
    await source.getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click(); await expect(editor).not.toContainText('notes.txt')
    await source.getByRole('button', { name: uiText('Redo', '重做'), exact: true }).click(); await expect(editor).toContainText('notes.txt')
    await source.getByRole('button', { name: uiText('Apply changes', '应用更改'), exact: true }).click()
    await expect(page.locator('.attachment-card')).toContainText('notes.txt')
    await page.getByRole('button', { name: uiText('Images and attachments', '图片与附件'), exact: true }).click()
    await page.locator('.attachment-dialog input[type=file]').setInputFiles({ name: 'too-large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(25 * 1024 * 1024 + 1) })
    await expect(page.locator('.attachment-dialog [role=alert]')).toContainText('25 MB')
    await expect(page.locator('.attachment-dialog .attachment-card')).toHaveCount(1)
  })
})

test('attachment actions validate managed paths and executable opening requires confirmation @electron', async () => {
  await withElectronApp(async ({ app, page, tempRoot }) => {
    await createDocument(page)
    await page.getByRole('button', { name: uiText('Images and attachments', '图片与附件'), exact: true }).click()
    const dialog = page.locator('.attachment-dialog')
    await dialog.locator('input[type=file]').setInputFiles({ name: 'example.cmd', mimeType: 'text/plain', buffer: Buffer.from('exit 0') })
    const card = dialog.locator('.attachment-card')
    await expect(card.getByRole('button', { name: uiText('Open', '打开'), exact: true })).toBeEnabled()
    await app.evaluate(({ dialog, shell }) => {
      const state = globalThis as unknown as { attachmentOpened: string[]; attachmentRevealed: string[] }
      state.attachmentOpened = []; state.attachmentRevealed = []
      shell.openPath = async path => { state.attachmentOpened.push(path); return '' }
      shell.showItemInFolder = path => { state.attachmentRevealed.push(path) }
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    await card.getByRole('button', { name: uiText('Open', '打开'), exact: true }).click()
    await expect(card).toHaveAttribute('aria-busy', 'false')
    expect(await app.evaluate(() => (globalThis as unknown as { attachmentOpened: string[] }).attachmentOpened)).toEqual([])
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await card.getByRole('button', { name: uiText('Open', '打开'), exact: true }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { attachmentOpened: string[] }).attachmentOpened.length)).toBe(1)
    await card.getByRole('button', { name: uiText('Show in folder', '在文件夹中显示'), exact: true }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { attachmentRevealed: string[] }).attachmentRevealed.length)).toBe(1)
    const outsideUrl = pathToFileURL(join(tempRoot, 'private.txt')).href
    const rejection = await page.evaluate(async url => {
      try { await window.knowbook.getAttachment(url); return '' } catch (error) { return String(error) }
    }, outsideUrl)
    expect(rejection).toContain('outside the workspace')
    const response = await app.evaluate(async ({ net }, url) => (await net.fetch('knowbook-asset://preview/?source=' + encodeURIComponent(url))).status, outsideUrl)
    expect(response).toBe(404)
  })
})
