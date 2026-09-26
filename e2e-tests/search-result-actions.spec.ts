import { expect, test } from '@playwright/test'
import { uiText, withElectronApp } from './helpers/electron'

test('results highlight literal matches, name block types, copy links and open the whole document @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ page, app }) => {
    const target = await page.evaluate(async () => {
      const document = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(document.id, { title: '[Palette] C# (设计)', summary: '', blocks: [
        { id: `${document.id}-intro`, type: 'paragraph', content: 'Introduction', checked: false, depth: 0 },
        { id: `${document.id}-match`, type: 'paragraph', content: 'SearchDetailNeedle ' + '内容 preview '.repeat(12), checked: false, depth: 0 }
      ] })
      return (await window.knowbook.getDocumentDetail(document.id))!
    })
    await page.keyboard.press('Control+k')
    const input = page.locator('.global-search-input')
    await input.fill('SearchDetailNeedle')
    const result = page.locator('.global-search-result')
    await expect(result).toHaveCount(1)
    await expect(result.locator('mark')).toHaveText('SearchDetailNeedle')
    await expect(result.locator('.global-search-match-badge')).toHaveText(uiText('Text', '文本'))
    const actions = page.getByRole('group', { name: uiText('Selected result actions', '所选搜索结果操作') })
    await expect(actions.getByRole('button', { name: uiText('Go to block', '定位内容块') })).toBeVisible()
    await actions.getByRole('button', { name: uiText('Copy document link', '复制文档链接') }).click()
    await expect(page.locator('.palette-action-feedback')).toContainText(/Document link copied|文档链接已复制/)
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(copied).toContain('%5BPalette%5D%20C%23%20%28')
    expect(copied).toContain('.md)')
    expect(copied).not.toContain(target.blocks[1].id)
    await expect(input).toHaveValue('SearchDetailNeedle')
    await page.setViewportSize({ width: 620, height: 640 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, theme)
      const palette = page.locator('.global-search-modal')
      expect(await palette.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
      await expect(actions.getByRole('button', { name: uiText('Open document', '打开文档'), exact: true })).toBeInViewport()
      await palette.screenshot({ path: testInfo.outputPath(`search-actions-${theme}.png`) })
    }
    await input.focus()
    await input.press('Control+Enter')
    await expect(page.locator('.global-search-modal')).toHaveCount(0)
    await expect(page.locator('.document-header-title')).toHaveText(target.title)
    await expect(page.locator(`[data-block-id="${target.blocks[1].id}"]`)).not.toHaveClass(/block-editor-row-highlighted/)
  })
})

test('clipboard errors stay in the palette and retry does not open the result @electron', async () => {
  await withElectronApp(async ({ page, app }) => {
    await app.evaluate(({ ipcMain, clipboard }) => {
      let fail = true
      ipcMain.removeHandler('knowbook:write-clipboard-text')
      ipcMain.handle('knowbook:write-clipboard-text', (_event, text) => {
        if (fail) { fail = false; throw new Error('Search clipboard busy') }
        clipboard.writeText(text)
      })
    })
    const before = await page.locator('.document-header-title').textContent()
    await page.keyboard.press('Control+k')
    const copy = page.getByRole('button', { name: uiText('Copy document link', '复制文档链接'), exact: true })
    await copy.click()
    await expect(page.locator('.palette-action-feedback')).toHaveAttribute('role', 'alert')
    await expect(page.locator('.palette-action-feedback')).toContainText('Search clipboard busy')
    await copy.click()
    await expect(page.locator('.palette-action-feedback')).toContainText(/Document link copied|文档链接已复制/)
    await expect(page.locator('.global-search-modal')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.document-header-title')).toHaveText(before!)
  })
})

test('an in-flight result action reports progress and ignores repeated activation @electron', async () => {
  await withElectronApp(async ({ page, app }) => {
    await app.evaluate(({ ipcMain }) => {
      let calls = 0
      ipcMain.removeHandler('knowbook:write-clipboard-text')
      ipcMain.handle('knowbook:write-clipboard-text', async () => {
        process.env.KNOWBOOK_SEARCH_COPY_CALLS = String(++calls)
        await new Promise((resolve) => setTimeout(resolve, 600))
      })
    })
    await page.keyboard.press('Control+k')
    const before = await page.locator('.document-header-title').textContent()
    const copy = page.getByRole('button', { name: uiText('Copy document link', '复制文档链接'), exact: true })
    await copy.click()
    await expect(copy).toBeDisabled()
    await expect(page.locator('.palette-action-feedback')).toContainText(/Copying|正在复制/)
    await page.locator('.global-search-input').press('Enter')
    await page.locator('.global-search-input').press('Enter')
    await expect(page.locator('.palette-action-feedback')).toContainText(/Document link copied|文档链接已复制/)
    expect(await app.evaluate(() => process.env.KNOWBOOK_SEARCH_COPY_CALLS)).toBe('1')
    await expect(page.locator('.global-search-modal')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.document-header-title')).toHaveText(before!)
  })
})
