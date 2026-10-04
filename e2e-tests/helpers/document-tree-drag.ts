import { expect, type Locator, type Page } from '@playwright/test'

export async function dragTreeDocument(page: Page, title: string, destination: Locator): Promise<void> {
  const row = page.getByRole('treeitem', { name: title, exact: true })
  const source = row.locator('.tree-button')
  const sourceId = await page.evaluate(async title =>
    (await window.knowbook.getDocumentCatalog()).find(document => document.title === title)?.id, title)
  expect(sourceId).toBeTruthy()
  await source.click()
  await expect(row).toBeFocused()
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  try {
    // Native drag loops can wait for OS input in an offscreen Electron window.
    // Deliver the browser drag lifecycle to the real tree handlers instead.
    await source.dispatchEvent('dragstart', { dataTransfer })
    await expect(source).toHaveClass(/tree-button-dragging/)
    expect(await dataTransfer.evaluate(transfer => transfer.getData('text/plain'))).toBe(sourceId)
    await expect(destination).toBeVisible()
    await destination.dispatchEvent('dragover', { dataTransfer })
    await expect(destination).toHaveClass(/tree-button-drag-over|root-drop-zone-active/)
    await destination.dispatchEvent('drop', { dataTransfer })
    await source.dispatchEvent('dragend', { dataTransfer })
    await expect(source).not.toHaveClass(/tree-button-dragging/)
    await expect(page.locator('[role="treeitem"]:focus')).toHaveCount(1)
  } finally {
    await dataTransfer.dispose()
  }
}
