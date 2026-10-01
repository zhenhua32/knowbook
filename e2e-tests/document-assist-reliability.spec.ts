import { expect, test, type Locator, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function seedEditors(page: Page) {
  const ids = await page.evaluate(async () => {
    const create = async (title: string, content: string) => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title, summary: '', blocks: [
        { id: `${id}-body`, type: 'paragraph', content, depth: 0, checked: false }
      ] })
      return id
    }
    const source = await create('Assist source A', 'Original A text')
    const other = await create('Assist source B', 'Original B text')
    const alpha = await create('AlphaTarget', 'Alpha target notes')
    const beta = await create(`BetaTarget ${'知识管理与编辑体验改进'.repeat(6)}`, 'Beta target notes')
    return { source, other, alpha, beta, betaPath: (await window.knowbook.getDocumentDetail(beta))!.path }
  })
  await page.reload()
  await openEditor(page, 'Assist source A')
  return ids
}

async function openEditor(page: Page, title: string) {
  await page.locator('.tree-button').filter({ has: page.locator('.tree-document-title', { hasText: title }) }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
  await expect(page.locator('.block-inline-textarea').first()).toBeVisible()
}

async function expectReadable(locator: Locator) {
  await expect(locator).toBeVisible()
  const ratio = await locator.evaluate(element => {
    const rgba = (color: string) => color.match(/[\d.]+/g)!.map(Number)
    const over = (front: number[], back: number[]) => front.slice(0, 3).map((value, i) => value * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)))
    const layers: number[][] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = rgba(getComputedStyle(node).backgroundColor)
      layers.push(color)
      if ((color[3] ?? 1) === 1) break
    }
    if ((layers.at(-1)?.[3] ?? 1) !== 1) throw new Error('Missing opaque background')
    const background = layers.reverse().reduce((back, front) => over(front, back), [255, 255, 255])
    const foreground = over(rgba(getComputedStyle(element).color), background)
    const luminance = (color: number[]) => color.map(channel => {
      const value = channel / 255
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
    }).reduce((total, value, i) => total + value * [.2126, .7152, .0722][i], 0)
    const a = luminance(foreground), b = luminance(background)
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
  })
  expect(ratio).toBeGreaterThanOrEqual(4.5)
}

test('link suggestions follow the current query and document with retry, keyboard acceptance and readable themes @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1180, height: 900 })
    const ids = await seedEditors(page)
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: unknown, query: string, excludeId: string | null) => unknown
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get('knowbook:get-document-suggestions')!
      const pending: Array<{ event: unknown; query: string; excludeId: string | null; resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
      process.env.KNOWBOOK_ASSIST_REQUESTS = '[]'
      ipcMain.removeHandler('knowbook:get-document-suggestions')
      ipcMain.handle('knowbook:get-document-suggestions', (event, query: string, excludeId: string | null) => new Promise((resolve, reject) => {
        pending.push({ event, query, excludeId, resolve, reject })
        process.env.KNOWBOOK_ASSIST_REQUESTS = JSON.stringify(pending.map(({ query, excludeId }) => ({ query, excludeId })))
      }))
      ipcMain.on('knowbook:test-assist-settle', (_event, result: { index: number; fail: boolean }) => {
        const request = pending[result.index]
        if (result.fail) request.reject(new Error('The isolated document suggestion service failed.'))
        else Promise.resolve(original(request.event, request.query, request.excludeId)).then(request.resolve, request.reject)
      })
    })
    const requests = () => app.evaluate(() => JSON.parse(process.env.KNOWBOOK_ASSIST_REQUESTS!))
    const settle = (index: number, fail = false) => app.evaluate(({ ipcMain }, result) => { ipcMain.emit('knowbook:test-assist-settle', null, result) }, { index, fail })
    const editor = page.locator('.block-inline-textarea').first()
    const panel = page.locator('.link-helper-panel')
    const expectNeutralPanel = async () => {
      const colors = await panel.evaluate(element => {
        const probe = document.createElement('span')
        probe.style.backgroundColor = 'var(--kb-canvas)'
        element.append(probe)
        const expected = getComputedStyle(probe).backgroundColor
        probe.remove()
        return { actual: getComputedStyle(element).backgroundColor, expected }
      })
      expect(colors.actual).toBe(colors.expected)
    }
    const alpha = panel.locator('.relation-chip').filter({ has: page.locator('strong', { hasText: /^AlphaTarget$/ }) })
    const beta = panel.locator('.relation-chip').filter({ has: page.locator('strong', { hasText: /^BetaTarget/ }) })
    const query = async (value: string) => { await editor.fill(`[[${value}`); await editor.press('End') }
    await query('AlphaTarget')
    await expect.poll(requests).toEqual([{ query: 'AlphaTarget', excludeId: ids.source }])
    await settle(0)
    await expect(alpha).toHaveCount(1)
    await query('BetaTarget')
    await expect(alpha).toHaveCount(0)
    await expect(panel.getByRole('status')).toHaveText(uiText('Finding documents…', '正在查找文档…'))
    await expect.poll(requests).toHaveLength(2)
    await query('AlphaTarget')
    await expect.poll(requests).toHaveLength(3)
    await settle(2)
    await expect(alpha).toHaveCount(1)
    await settle(1)
    await expect(beta).toHaveCount(0)
    await expect(alpha).toHaveCount(1)
    await query('BetaTarget')
    await expect.poll(requests).toHaveLength(4)
    await settle(3, true)
    await expect(panel.getByRole('alert')).toBeVisible()
    await expectNeutralPanel()
    await expect(panel.locator('.empty-text')).toHaveCount(0)
    await expect(editor).toHaveValue('[[BetaTarget')
    await expectReadable(panel.getByRole('alert'))
    await expectReadable(panel.getByRole('button', { name: uiText('Retry', '重试'), exact: true }))
    await panel.screenshot({ path: testInfo.outputPath('link-suggestions-retry-light.png') })
    await editor.press('ArrowDown')
    await expect(panel.locator('.link-suggestions-retry')).toHaveAttribute('aria-current', 'true')
    await expectReadable(panel.locator('.link-suggestions-retry'))
    await editor.press('Enter')
    await expect.poll(requests).toHaveLength(5)
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue('[[BetaTarget')
    await settle(4)
    await expect(beta).toHaveCount(1)
    await editor.press('ArrowDown')
    await expect(beta).toHaveAttribute('aria-current', 'true')
    await editor.press('Tab')
    await expect(editor).toHaveValue(`[[${ids.betaPath}]]`)
    await expect(editor).toBeFocused()
    await expect(panel).toHaveCount(0)
    await page.keyboard.press('Control+s')
    await expect.poll(() => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks[0].content, ids.source)).toBe(`[[${ids.betaPath}]]`)

    await page.evaluate(() => window.knowbook.saveSetting('appearance.theme', 'dark'))
    await page.reload()
    await openEditor(page, 'Assist source A')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await query('BetaTarget')
    await expect.poll(requests).toHaveLength(6)
    await expectReadable(panel.getByRole('status'))
    await settle(5, true)
    await expect(panel.getByRole('alert')).toBeVisible()
    await expectNeutralPanel()
    await expectReadable(panel.getByRole('alert'))
    const retry = panel.getByRole('button', { name: uiText('Retry', '重试'), exact: true })
    await expectReadable(retry)
    await panel.screenshot({ path: testInfo.outputPath('link-suggestions-retry-dark.png') })
    await retry.click()
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue('[[BetaTarget')
    await expect.poll(requests).toHaveLength(7)
    await settle(6)
    await expect(beta).toHaveCount(1)
    await beta.hover()
    await expectReadable(beta.locator('strong'))
    await expectReadable(beta.locator('span'))
    expect(await panel.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
    await panel.screenshot({ path: testInfo.outputPath('link-suggestions-results-dark.png') })

    await query('AlphaTarget')
    await expect.poll(requests).toHaveLength(8)
    await openEditor(page, 'Assist source B')
    await query('AlphaTarget')
    await expect.poll(requests).toHaveLength(9)
    await settle(7)
    await expect(alpha).toHaveCount(0)
    await expect(panel.getByRole('status')).toBeVisible()
    await settle(8)
    await expect(alpha).toHaveCount(1)
    await alpha.click()
    await expect(editor).toHaveValue('[[AlphaTarget]]')
    await expect(editor).toBeFocused()
    expect(errors).toEqual([])
  })
})

test('outline filtering leaves IME Escape intact and restores the toggle on normal Escape @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page }) => {
    await page.evaluate(async () => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: 'Outline IME sample', summary: '', blocks: [
        { type: 'heading-1', content: '第一章', depth: 0, checked: false },
        { type: 'heading-2', content: '第一节', depth: 0, checked: false },
        { type: 'heading-1', content: '第二章', depth: 0, checked: false }
      ] })
    })
    await page.reload()
    await openEditor(page, 'Outline IME sample')
    const toggle = page.locator('.document-outline-control > button')
    await toggle.click()
    const popover = page.locator('.document-outline-popover')
    const filter = popover.locator('.outline-filter')
    await filter.fill('第一')
    await expect(popover.locator('.toc-item')).toHaveCount(2)
    await filter.dispatchEvent('compositionstart')
    await filter.dispatchEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await expect(popover).toBeVisible()
    await expect(filter).toHaveValue('第一')
    await expect(filter).toBeFocused()
    await filter.dispatchEvent('compositionend')
    await filter.dispatchEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })
    await filter.dispatchEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, keyCode: 229 })
    await expect(popover).toBeVisible()
    await expect(filter).toHaveValue('第一')
    await filter.press('Escape')
    await expect(popover).toHaveCount(0)
    await expect(toggle).toBeFocused()
  })
})

test('an attachment import finishing after a document switch cannot show its failure in the new document @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const ids = await seedEditors(page)
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: unknown, input: unknown) => unknown
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get('knowbook:import-attachments')!
      const pending: Array<{ event: unknown; input: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
      process.env.KNOWBOOK_ASSIST_IMPORT_COUNT = '0'
      ipcMain.removeHandler('knowbook:import-attachments')
      ipcMain.handle('knowbook:import-attachments', (event, input) => new Promise((resolve, reject) => {
        pending.push({ event, input, resolve, reject })
        process.env.KNOWBOOK_ASSIST_IMPORT_COUNT = String(pending.length)
      }))
      ipcMain.on('knowbook:test-assist-import-settle', (_event, result: { index: number; fail: boolean }) => {
        const request = pending[result.index]
        if (result.fail) request.reject(new Error('Failure belonging to document A'))
        else Promise.resolve(original(request.event, request.input)).then(request.resolve, request.reject)
      })
    })
    const count = () => app.evaluate(() => Number(process.env.KNOWBOOK_ASSIST_IMPORT_COUNT))
    const settle = (index: number, fail: boolean) => app.evaluate(({ ipcMain }, result) => { ipcMain.emit('knowbook:test-assist-import-settle', null, result) }, { index, fail })
    await page.locator('.block-inline-textarea').first().evaluate(element => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['old document file'], 'old-A.txt', { type: 'text/plain' }))
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    })
    await expect.poll(count).toBe(1)
    await openEditor(page, 'Assist source B')
    await page.getByRole('button', { name: uiText('Images and attachments', '图片与附件'), exact: true }).click()
    const dialog = page.locator('.attachment-dialog')
    await settle(0, true)
    await expect(dialog.locator('input[type=file]')).toBeEnabled()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.app-notification-error')).toHaveCount(0)
    await expect(page.locator('.block-inline-textarea').first()).toHaveValue('Original B text')
    await dialog.locator('input[type=file]').setInputFiles({ name: 'current-B.txt', mimeType: 'text/plain', buffer: Buffer.from('current document file') })
    await expect.poll(count).toBe(2)
    await settle(1, false)
    await expect(dialog.locator('.attachment-card')).toContainText('current-B.txt')
    await dialog.getByRole('button', { name: uiText('Close', '关闭'), exact: true }).click()
    await page.keyboard.press('Control+s')
    await expect.poll(() => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks.some(block => block.content.includes('current-B.txt')), ids.other)).toBe(true)
    expect((await page.evaluate(id => window.knowbook.getDocumentDetail(id), ids.source))!.blocks[0].content).toBe('Original A text')
  })
})
