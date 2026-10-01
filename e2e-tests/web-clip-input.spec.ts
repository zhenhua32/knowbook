import { expect, test } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

test('web clipping ignores IME confirmation, recovers from failure and preserves the next URL draft @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const ids = await page.evaluate(async () => {
      const create = async (title: string, parent: string | null) => {
        const { id } = await window.knowbook.createDocument(parent)
        await window.knowbook.updateDocument(id, { title, summary: '', blocks: [
          { type: 'paragraph', content: 'Isolated web clipping input fixture.', depth: 0, checked: false }
        ] })
        return id
      }
      const parent = await create('Clip input parent', null)
      return { parent, child: await create('Clip input child', parent) }
    })
    await app.evaluate(({ ipcMain }, ids) => {
      type Pending = { input: { url: string; parentId: string }; resolve: (result: unknown) => void; reject: (error: Error) => void }
      const requests: Pending[] = []
      process.env.KNOWBOOK_CLIP_INPUT_REQUESTS = '[]'
      ipcMain.removeHandler('knowbook:clip-web-page')
      ipcMain.handle('knowbook:clip-web-page', (_event, input: Pending['input']) => new Promise((resolve, reject) => {
        requests.push({ input, resolve, reject })
        process.env.KNOWBOOK_CLIP_INPUT_REQUESTS = JSON.stringify(requests.map(request => request.input))
      }))
      ipcMain.on('knowbook:test-clip-input-settle', (_event, input: { index: number; fail: boolean }) => {
        const request = requests[input.index]
        if (input.fail) request.reject(new Error('The clipping source is temporarily unavailable.'))
        else request.resolve({ documentId: ids.child, title: 'Clip input child', created: input.index === 1, warnings: [] })
      })
    }, ids)
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Clip input parent' }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText('Clip input parent')
    const input = page.getByLabel(uiText('Webpage URL', '网页链接'), { exact: true })
    if (!await input.isVisible()) await page.getByRole('button', { name: uiText('Show auxiliary', '展开辅助区') }).click()
    const button = page.getByRole('button', { name: uiText('Clip webpage', '剪藏网页'), exact: true })
    const requests = () => app.evaluate(() => JSON.parse(process.env.KNOWBOOK_CLIP_INPUT_REQUESTS!))
    const settle = (index: number, fail: boolean) => app.evaluate(({ ipcMain }, result) => {
      ipcMain.emit('knowbook:test-clip-input-settle', null, result)
    }, { index, fail })

    await input.fill('https://example.invalid/ime-confirmation')
    await input.dispatchEvent('compositionstart')
    await input.press('Enter')
    await input.dispatchEvent('compositionend')
    const firstUrl = 'https://example.invalid/first-article'
    await input.fill(firstUrl)
    await input.press('Enter')
    await expect.poll(requests).toEqual([{ url: firstUrl, parentId: ids.parent }])
    await expect(page.getByRole('button', { name: uiText('Clipping...', '剪藏中...'), exact: true })).toBeDisabled()
    const nextUrl = 'https://example.invalid/next-article'
    await input.fill(nextUrl)
    await input.press('Enter')
    await settle(0, true)
    await expect(page.locator('.app-notifications')).toContainText('The clipping source is temporarily unavailable.')
    await expect(button).toBeEnabled()
    await expect(input).toHaveValue(nextUrl)
    await expect.poll(requests).toEqual([{ url: firstUrl, parentId: ids.parent }])

    await button.click()
    await expect.poll(requests).toEqual([{ url: firstUrl, parentId: ids.parent }, { url: nextUrl, parentId: ids.parent }])
    const thirdUrl = 'https://example.invalid/third-article'
    await input.fill(thirdUrl)
    await settle(1, false)
    await expect(page.locator('.document-header-title')).toHaveText('Clip input child')
    await expect(input).toHaveValue(thirdUrl)
    await expect(button).toBeEnabled()
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(36)
    await page.locator('.document-aux-web-clip').screenshot({ path: testInfo.outputPath('web-clip-next-draft.png') })
    await input.press('Enter')
    await expect.poll(requests).toEqual([
      { url: firstUrl, parentId: ids.parent }, { url: nextUrl, parentId: ids.parent }, { url: thirdUrl, parentId: ids.child }
    ])
    await settle(2, false)
    await expect(input).toHaveValue('')
    await expect(button).toBeDisabled()
    expect(errors).toEqual([])
  })
})

test('a failed document save cancels clipping without clearing its URL draft @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page, app }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const id = await page.evaluate(async () => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: 'Clip save guard', summary: '', blocks: [
        { type: 'paragraph', content: 'Original clipping parent.', depth: 0, checked: false }
      ] })
      return id
    })
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Clip save guard' }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText('Clip save guard')
    const input = page.getByLabel(uiText('Webpage URL', '网页链接'), { exact: true })
    if (!await input.isVisible()) await page.getByRole('button', { name: uiText('Show auxiliary', '展开辅助区') }).click()
    await app.evaluate(({ ipcMain }, id) => {
      process.env.KNOWBOOK_CLIP_SAVE_GUARD_CALLS = '0'
      ipcMain.removeHandler('knowbook:update-document')
      ipcMain.handle('knowbook:update-document', () => { throw new Error('The document could not be saved for isolated verification.') })
      ipcMain.removeHandler('knowbook:clip-web-page')
      ipcMain.handle('knowbook:clip-web-page', () => {
        process.env.KNOWBOOK_CLIP_SAVE_GUARD_CALLS = String(Number(process.env.KNOWBOOK_CLIP_SAVE_GUARD_CALLS) + 1)
        return { documentId: id, title: 'Clip save guard', created: false, warnings: [] }
      })
    }, id)
    const url = 'https://example.invalid/keep-after-save-failure'
    await input.fill(url)
    await page.locator('.document-title-input').fill('Unsaveable clipping parent')
    await input.press('Enter')
    await expect(page.locator('.app-notifications')).toContainText('The document could not be saved for isolated verification.')
    await expect(page.getByRole('button', { name: uiText('Clip webpage', '剪藏网页'), exact: true })).toBeEnabled()
    await expect(input).toHaveValue(url)
    expect(await app.evaluate(() => process.env.KNOWBOOK_CLIP_SAVE_GUARD_CALLS)).toBe('0')
    expect(errors).toEqual([])
  })
})
