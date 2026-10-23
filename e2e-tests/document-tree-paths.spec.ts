import { expect, test } from '@playwright/test'
import { ensureDocumentMetadataEditor, hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

test('parent rename preserves Unicode child paths and a promoted case-distinct sibling tree @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  await withElectronApp(async ({ page }) => {
    const fixture = await page.evaluate(async () => {
      async function create(title: string, parent: string | null = null) {
        const { id } = await window.knowbook.createDocument(parent)
        const detail = (await window.knowbook.getDocumentDetail(id))!
        await window.knowbook.updateDocument(id, { ...detail, title })
        return id
      }
      const root = await create('Case😀'), child = await create('A🧑‍💻子', root)
      const wrapper = await create('Promotion wrapper'), other = await create('case😀', wrapper)
      await window.knowbook.deleteDocument(wrapper)
      const otherChild = await create('Other child', other)
      return { root, child, other, otherChild }
    })
    await page.reload()
    await expect(page.locator('[data-testid="workspace-grid"]')).toBeVisible()
    await page.locator('.tree-button').filter({ has: page.getByText('Case😀', { exact: true }) }).click()
    await ensureDocumentMetadataEditor(page)
    await page.locator('.document-summary-card .editor-input').first().fill('Renamed🦊')
    await page.getByRole('button', { name: uiText('Save', '保存') }).click()
    await expect(page.locator('.preview-panel .document-header-title')).toHaveText('Renamed🦊')
    await page.locator('.tree-button').filter({ has: page.getByText('A🧑‍💻子', { exact: true }) }).click()
    await expect(page.locator('.document-path')).toContainText('Renamed🦊/A🧑‍💻子')
    await page.locator('.tree-button').filter({ has: page.getByText('Other child', { exact: true }) }).click()
    await expect(page.locator('.document-path')).toContainText('case😀/Other child')
    const persisted = await page.evaluate(async ids => Promise.all(ids.map(async id => {
      const detail = (await window.knowbook.getDocumentDetail(id))!
      return { id: detail.id, path: detail.path }
    })), [fixture.root, fixture.child, fixture.other, fixture.otherChild])
    expect(persisted).toEqual([
      { id: fixture.root, path: 'Renamed🦊' }, { id: fixture.child, path: 'Renamed🦊/A🧑‍💻子' },
      { id: fixture.other, path: 'case😀' }, { id: fixture.otherChild, path: 'case😀/Other child' }
    ])
  })
})
