import { expect, test } from '@playwright/test'
import { encodeDocumentIndexEntry } from '../src/shared/document-catalog-payload'
import { ensureDocumentMetadataEditor, uiText, withElectronApp } from './helpers/electron'

test('search and command shortcuts work on every page and restore focus @electron', async () => {
  await withElectronApp(async ({ page }) => {
    for (const [en, zh] of [['Documents', '文档'], ['Dashboard', '总览'], ['Database', '数据库'], ['AI Assistant', 'AI 助手'], ['Plugins', '插件中心'], ['Settings', '配置中心']]) {
      const nav = page.getByTitle(uiText(en, zh), { exact: true })
      await nav.click()
      await page.keyboard.press('Control+k')
      const palette = page.getByRole('dialog', { name: uiText('Search and commands', '搜索与命令') })
      await expect(palette.getByRole('combobox')).toBeFocused()
      await expect(palette.getByRole('option').first()).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(palette).toHaveCount(0)
      await expect(nav).toBeFocused()
      await page.keyboard.press('Control+Shift+p')
      await expect(palette.getByRole('combobox')).toHaveValue('>')
      await page.keyboard.press('Control+k')
      await expect(palette).toHaveCount(0)
    }
  })
})

test('content matches open their exact block even when absent from the cached document index @electron', async () => {
  await withElectronApp(async ({ page, app }) => {
    const target = await page.evaluate(async () => {
      const document = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(document.id, { title: 'Palette destination', summary: '', blocks: [
        { id: `${document.id}-intro`, type: 'paragraph', content: 'Introduction', checked: false, depth: 0 },
        { id: `${document.id}-needle`, type: 'paragraph', content: 'PaletteUniqueContentNeedle', checked: false, depth: 0 }
      ] })
      return document.id
    })
    const home = await page.evaluate(() => window.knowbook.getHomeData())
    const payload = { ...home, documentCatalog: home.documentCatalog.filter((document) => document.id !== target).map(encodeDocumentIndexEntry) }
    await app.evaluate(({ ipcMain }, serialized) => {
      const payload = JSON.parse(serialized)
      ipcMain.removeHandler('knowbook:get-home-data')
      ipcMain.handle('knowbook:get-home-data', () => payload)
    }, JSON.stringify(payload))
    await page.reload()
    await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
    await page.locator('.sidebar-search-button').click()
    const input = page.locator('.global-search-input')
    await input.fill('PaletteUniqueContentNeedle')
    await expect(page.locator('.global-search-result')).toHaveCount(1)
    await input.press('Enter')
    await expect(page.locator('.global-search-modal')).toHaveCount(0)
    await expect(page.locator('.document-header-title')).toHaveText('Palette destination')
    await expect(page.locator(`[data-block-id="${target}-needle"]`)).toBeInViewport()
    await expect(page.locator(`[data-block-id="${target}-needle"]`)).toHaveClass(/block-editor-row-highlighted/)
  })
})

test('command mode skips document search, navigates, and creates a document from settings @electron', async () => {
  await withElectronApp(async ({ page, app }) => {
    await app.evaluate(({ ipcMain }) => {
      process.env.KNOWBOOK_PALETTE_SEARCH_CALLS = '0'
      ipcMain.removeHandler('knowbook:search-documents')
      ipcMain.handle('knowbook:search-documents', () => {
        process.env.KNOWBOOK_PALETTE_SEARCH_CALLS = String(Number(process.env.KNOWBOOK_PALETTE_SEARCH_CALLS) + 1)
        throw new Error('Document search must not run for commands')
      })
    })
    await page.keyboard.press('Control+Shift+p')
    await page.locator('.global-search-input').fill('> settings')
    await expect(page.getByRole('option')).toHaveCount(1)
    await page.locator('.global-search-input').press('Enter')
    await expect(page.locator('.page-settings')).toBeVisible()
    const before = await page.evaluate(async () => (await window.knowbook.getHomeData()).summary.documents)
    await page.keyboard.press('Control+Shift+p')
    await page.locator('.global-search-input').fill('> new document')
    await page.locator('.global-search-input').press('Enter')
    await expect(page.locator('.page-documents')).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.knowbook.getHomeData()).summary.documents)).toBe(before + 1)
    expect(await app.evaluate(() => process.env.KNOWBOOK_PALETTE_SEARCH_CALLS)).toBe('0')
  })
})

test('the global shortcut takes priority over editor bindings while respecting IME composition @electron', async () => {
  await withElectronApp(async ({ page }) => {
    await ensureDocumentMetadataEditor(page)
    const title = page.locator('.document-summary-card .editor-input').first()
    await title.focus()
    await title.evaluate((element) => {
      element.addEventListener('keydown', (event) => {
        const key = event as KeyboardEvent
        if (key.ctrlKey && key.key.toLowerCase() === 'k') {
          event.preventDefault()
          event.stopPropagation()
          element.setAttribute('data-editor-shortcut-fired', 'true')
        }
      })
    })
    await title.dispatchEvent('compositionstart')
    await title.dispatchEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true })
    await expect(page.locator('.global-search-modal')).toHaveCount(0)
    await title.dispatchEvent('compositionend')
    await title.evaluate((element) => element.removeAttribute('data-editor-shortcut-fired'))
    await page.keyboard.press('Control+k')
    await expect(page.locator('.global-search-input')).toBeFocused()
    expect(await title.getAttribute('data-editor-shortcut-fired')).toBeNull()
    await page.keyboard.press('Escape')
    await expect(title).toBeFocused()
  })
})

test('keyboard selection, IME, focus trapping and cancellation preserve the editor draft @electron', async () => {
  await withElectronApp(async ({ page }) => {
    await ensureDocumentMetadataEditor(page)
    const title = page.locator('.document-summary-card .editor-input').first()
    await title.fill('Palette draft remains intact')
    await page.keyboard.press('Control+Shift+p')
    const input = page.locator('.global-search-input')
    const selected = page.locator('[role="option"][aria-selected="true"]')
    const first = await selected.getAttribute('id')
    await input.press('ArrowDown')
    await expect(selected).not.toHaveAttribute('id', first!)
    await input.press('ArrowUp')
    await expect(selected).toHaveAttribute('id', first!)
    await input.dispatchEvent('compositionstart')
    await input.press('Enter')
    await input.press('Escape')
    await expect(page.locator('.global-search-modal')).toBeVisible()
    await input.dispatchEvent('compositionend')
    await input.fill('> new document')
    await input.press('Control+z')
    await expect(title).toHaveValue('Palette draft remains intact')
    for (let count = 0; count < 6; count++) {
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.global-search-modal')))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(title).toBeFocused()
    await expect(title).toHaveValue('Palette draft remains intact')
  })
})

test('commands remain usable when document search fails and action errors use notifications @electron', async () => {
  await withElectronApp(async ({ page, app }) => {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('knowbook:search-documents')
      ipcMain.handle('knowbook:search-documents', () => { throw new Error('Palette search unavailable') })
      ipcMain.removeHandler('knowbook:write-clipboard-text')
      ipcMain.handle('knowbook:write-clipboard-text', () => { throw new Error('Palette clipboard unavailable') })
    })
    await page.keyboard.press('Control+k')
    await page.locator('.global-search-input').fill('settings')
    await expect(page.locator('.global-search-modal .recovery-state')).toBeVisible()
    await page.locator('.global-search-input').press('Enter')
    await expect(page.locator('.page-settings')).toBeVisible()
    await page.keyboard.press('Control+Shift+p')
    await page.locator('.global-search-input').fill('> copy markdown')
    await page.locator('.global-search-input').press('Enter')
    await expect(page.locator('.global-search-modal')).toHaveCount(0)
    await expect(page.locator('.app-notifications')).toContainText('Palette clipboard unavailable')
  })
})

test('unavailable document commands explain why and cannot execute @electron', async () => {
  await withElectronApp(async ({ page, app }) => {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('knowbook:get-document-detail')
      ipcMain.handle('knowbook:get-document-detail', () => null)
      ipcMain.removeHandler('knowbook:update-document')
      ipcMain.handle('knowbook:update-document', () => { throw new Error('Disabled command executed') })
    })
    await page.reload()
    await expect(page.locator('.page-documents .recovery-state')).toBeVisible()
    await page.keyboard.press('Control+Shift+p')
    await page.locator('.global-search-input').fill('> save current document')
    await expect(page.getByRole('option')).toBeDisabled()
    await expect(page.getByRole('option').locator('.global-search-snippet')).toContainText(uiText('Open a document first', '请先打开一个文档'))
    await page.locator('.global-search-input').press('Enter')
    await expect(page.locator('.global-search-modal')).toBeVisible()
  })
})

test('a failed draft save blocks a search jump without losing the draft or changing the target @electron', async () => {
  await withElectronApp(async ({ page, app }) => {
    const home = await page.evaluate(() => window.knowbook.getHomeData())
    const target = home.documentCatalog.find((document) => document.id !== home.initialDocumentId)!
    await app.evaluate(({ ipcMain }) => {
      process.env.KNOWBOOK_SEARCH_SAVE_ATTEMPTS = '0'
      ipcMain.removeHandler('knowbook:update-document')
      ipcMain.handle('knowbook:update-document', () => {
        process.env.KNOWBOOK_SEARCH_SAVE_ATTEMPTS = String(Number(process.env.KNOWBOOK_SEARCH_SAVE_ATTEMPTS) + 1)
        throw new Error('Palette draft save blocked')
      })
    })
    await ensureDocumentMetadataEditor(page)
    const title = page.locator('.document-summary-card .editor-input').first()
    await title.fill('Do not discard this palette draft')
    await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
    await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
    await page.keyboard.press('Control+k')
    await page.locator('.global-search-input').fill(target.title)
    await page.locator('.global-search-result').filter({ has: page.locator('.global-search-doc-title', { hasText: target.title }) }).first().click()
    await expect(page.locator('.global-search-modal')).toBeVisible()
    await expect(page.locator('.global-search-input')).toHaveValue(target.title)
    await expect(page.locator('.palette-action-feedback')).toContainText(/draft and search are preserved|草稿和搜索已保留/)
    // A second attempt must execute again, rather than getting stuck in a busy state.
    const attempts = await app.evaluate(() => Number(process.env.KNOWBOOK_SEARCH_SAVE_ATTEMPTS))
    await page.locator('.global-search-input').press('Enter')
    await expect.poll(() => app.evaluate(() => Number(process.env.KNOWBOOK_SEARCH_SAVE_ATTEMPTS))).toBeGreaterThan(attempts)
    await expect(page.locator('.palette-action-feedback')).toHaveAttribute('role', 'alert')
    await page.keyboard.press('Escape')
    await expect(page.locator('.page-settings')).toBeVisible()
    await expect(page.locator('.app-notifications')).toContainText('Palette draft save blocked')
    await page.getByTitle(uiText('Documents', '文档'), { exact: true }).click()
    await ensureDocumentMetadataEditor(page)
    await expect(title).toHaveValue('Do not discard this palette draft')
    expect(await page.evaluate(async (id) => (await window.knowbook.getDocumentDetail(id))?.title, target.id)).toBe(target.title)
  })
})

test('collapsed sidebar keeps search available and the palette fits light and dark narrow windows @electron', async ({}, testInfo) => {
  await withElectronApp(async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 640 })
    await page.getByRole('button', { name: uiText('Collapse sidebar', '收起左侧栏'), exact: true }).click()
    await page.locator('.brand-mini').getByRole('button', { name: /Global search|全局搜索/ }).click()
    await expect(page.locator('.global-search-input')).toBeFocused()
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, theme)
      await page.locator('.global-search-input').fill('>')
      const palette = page.locator('.global-search-modal')
      expect(await palette.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
      await expect(palette).toBeInViewport()
      await palette.screenshot({ path: testInfo.outputPath(`palette-${theme}.png`) })
    }
    await page.keyboard.press('Escape')
    await expect(page.locator('.global-search-modal')).toHaveCount(0)
  })
})
