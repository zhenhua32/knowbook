import { expect, test, type Page } from '@playwright/test'
import { ensureDocumentMetadataEditor, hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

function treeButton(page: Page, title: string) {
  return page.locator('.tree-button').filter({ has: page.locator('.tree-document-title', { hasText: new RegExp(`^${title}$`) }) })
}

function treeRow(page: Page, title: string) {
  return page.getByRole('treeitem').filter({ has: treeButton(page, title) })
}

async function seedTree(page: Page) {
  const ids = await page.evaluate(async () => {
    const create = async (title: string, parentId: string | null) => {
      const { id } = await window.knowbook.createDocument(parentId)
      await window.knowbook.updateDocument(id, {
        title, summary: '', blocks: [{ type: 'paragraph', content: `${title} body`, checked: false, depth: 0 }]
      })
      return id
    }
    const parent = await create('Tree parent', null)
    const child = await create('Tree child', parent)
    const leaf = await create('Tree leaf', child)
    const other = await create('Tree other', null)
    return { parent, child, leaf, other }
  })
  await page.reload()
  await expect(treeButton(page, 'Tree parent')).toBeVisible()
  return ids
}

test.describe('Document tree collapse @electron', () => {
  test('preserves nested collapse and reveals a hidden search result without changing the open document on toggle', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const ids = await seedTree(page)
      const parentToggle = treeRow(page, 'Tree parent').locator('.tree-expand-toggle')
      const childToggle = treeRow(page, 'Tree child').locator('.tree-expand-toggle')
      const previewTitle = page.locator('.preview-panel .panel-head h3')

      await expect(parentToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(treeRow(page, 'Tree leaf').locator('.tree-expand-toggle')).toHaveCount(0)
      await treeButton(page, 'Tree leaf').click()
      await expect(previewTitle).toHaveText('Tree leaf')

      await childToggle.click()
      await expect(treeButton(page, 'Tree leaf')).toHaveCount(0)
      await parentToggle.click()
      await expect(treeButton(page, 'Tree child')).toHaveCount(0)
      await expect(previewTitle).toHaveText('Tree leaf')
      await expect(treeButton(page, 'Tree other')).toBeVisible()

      await parentToggle.press('Enter')
      await expect(childToggle).toHaveAttribute('aria-expanded', 'false')
      await expect(treeButton(page, 'Tree leaf')).toHaveCount(0)
      await childToggle.press('Space')
      await expect(treeButton(page, 'Tree leaf')).toBeVisible()

      await parentToggle.click()
      await ensureDocumentMetadataEditor(page)
      await page.locator('.document-summary-card .editor-textarea').first().fill('Saved while the parent is collapsed')
      await page.getByRole('button', { name: uiText('Save', '保存') }).click()
      await expect.poll(() => page.evaluate(async (id) => {
        return (await window.knowbook.getDocumentDetail(id))?.summary
      }, ids.leaf)).toBe('Saved while the parent is collapsed')
      await expect(parentToggle).toHaveAttribute('aria-expanded', 'false')
      await expect(treeButton(page, 'Tree child')).toHaveCount(0)

      await parentToggle.click()
      await childToggle.click()
      await parentToggle.click()
      await treeButton(page, 'Tree other').click()
      await page.keyboard.press('Control+k')
      await page.locator('.global-search-input').fill('Tree leaf')
      await page.locator('.global-search-result', { hasText: 'Tree leaf' }).first().click()
      await expect(previewTitle).toHaveText('Tree leaf')
      await expect(parentToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(childToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(treeButton(page, 'Tree leaf')).toHaveClass(/tree-button-active/)
      await expect(treeButton(page, 'Tree leaf')).toBeVisible()
      await page.locator('.sidebar-combined').screenshot({ path: 'test-results/document-tree-expanded.png' })
      await parentToggle.click()
      await page.locator('.sidebar-combined').screenshot({ path: 'test-results/document-tree-collapsed.png' })
    })
  })

  test('opens a collapsed destination after dropping or creating a child document', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    await withElectronApp(async ({ page }) => {
      const ids = await seedTree(page)
      const parentToggle = treeRow(page, 'Tree parent').locator('.tree-expand-toggle')
      await parentToggle.click()
      await treeButton(page, 'Tree other').dragTo(treeButton(page, 'Tree parent'))
      await expect.poll(() => page.evaluate(async (id) => {
        const catalog = await window.knowbook.getDocumentCatalog()
        return catalog.find((document) => document.id === id)?.parentId
      }, ids.other)).toBe(ids.parent)
      await expect(parentToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(treeButton(page, 'Tree other')).toBeVisible()

      await treeButton(page, 'Tree parent').click()
      await parentToggle.click()
      await page.getByRole('button', { name: uiText('Add child', '新增子文档') }).click()
      await expect(parentToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(page.locator('.tree-button-active')).toContainText('Untitled')
      await expect(page.locator('.tree-button-active')).toBeVisible()
    })
  })
})
