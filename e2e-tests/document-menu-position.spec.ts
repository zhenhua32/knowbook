import { expect, test, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

function getTitleInput(page: Page) {
  return page.locator('.document-summary-card .editor-input').first()
}

function getSummaryInput(page: Page) {
  return page.locator('.document-summary-card .editor-textarea').first()
}

async function createRootDocument(page: Page, title: string) {
  await page.getByTitle(uiText('New root', '新建根文档')).click()
  await expect(getTitleInput(page)).toHaveValue(/Untitled/i)
  await getTitleInput(page).fill(title)
  await getSummaryInput(page).fill(`Menu summary ${title}`)
  await page.getByRole('button', { name: uiText('Save', '保存') }).click()
  await expect(page.locator('.preview-panel .panel-head h3')).toHaveText(title)
  await expect(page.locator('.document-path')).toContainText(title)
}

async function getViewportSize(page: Page) {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
}

async function expectMenuWithinViewport(page: Page, selector: string) {
  await expect.poll(async () => {
    const box = await page.locator(selector).boundingBox()
    if (!box) {
      return false
    }

    const viewport = await getViewportSize(page)
    return box.x >= 0
      && box.y >= 0
      && box.x + box.width <= viewport.width + 1
      && box.y + box.height <= viewport.height + 1
  }).toBe(true)
}

test.describe('Document menu positioning @electron', () => {
  test('keeps the document header menu inside the viewport when opened from the header edge', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    const uniqueSuffix = Date.now().toString(36)
    const targetTitle = `E2E Menu ${uniqueSuffix}`

    await withElectronApp(async ({ page }) => {
      await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()

      await createRootDocument(page, targetTitle)

      const viewport = await getViewportSize(page)
      const moreButton = page.getByRole('button', { name: uiText('More actions', '更多操作') })

      await expect(moreButton).toBeVisible()

      const moreButtonBox = await moreButton.boundingBox()

      expect(moreButtonBox).not.toBeNull()
      expect(viewport.width - (moreButtonBox!.x + moreButtonBox!.width)).toBeLessThan(240)

      await moreButton.click()

      await expect(page.locator('.document-header-action-menu')).toBeVisible()
      await expectMenuWithinViewport(page, '.document-header-action-menu')
    })
  })
})
