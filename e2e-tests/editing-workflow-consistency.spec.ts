import { expect, test, type Page } from '@playwright/test'
import { ensureDocumentMetadataEditor, uiText, withElectronApp } from './helpers/electron'

async function openWorkflowSample(page: Page, title: string) {
  const id = await page.evaluate(async title => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: 'Original summary', blocks: [
      { id: `${id}-body`, type: 'paragraph', content: 'Original body', checked: false, depth: 0 },
      { id: `${id}-task`, type: 'todo', content: 'Reading task', checked: false, depth: 0 }
    ] })
    return id
  }, title)
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
  return id
}

test('reading task menu and keyboard undo share one scoped history without reverting source edits @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await openWorkflowSample(page, 'Reading history consistency')
    const latest = 'Latest source remains when undoing reading tasks'
    await page.locator(`[data-block-id="${id}-body"] textarea`).fill(latest)
    await page.locator('.document-view-toggle').click()
    const body = page.locator(`.document-reading-row[data-block-id="${id}-body"]`)
    const task = page.locator(`.document-reading-row[data-block-id="${id}-task"]`).getByRole('checkbox')
    const menu = page.locator('.document-header-action-menu')
    const openMenu = async () => { await page.locator('.document-header-more-button').click(); await expect(menu).toBeVisible() }
    await openMenu()
    await expect(menu.getByRole('button', { name: uiText('Undo', '撤销'), exact: true })).toBeDisabled()
    await page.locator('.context-menu-overlay').click({ position: { x: 1, y: 1 } })
    await task.check()
    await openMenu()
    await menu.getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
    await expect(task).not.toBeChecked()
    await expect(body).toContainText(latest)
    await openMenu()
    await menu.getByRole('button', { name: uiText('Redo', '重做'), exact: true }).click()
    await expect(task).toBeChecked()
    await expect(body).toContainText(latest)
    await task.press('Control+z')
    await expect(task).not.toBeChecked()
    await task.press('Control+z')
    await expect(body).toContainText(latest)
    await expect(task).toBeVisible()
    await openMenu()
    await expect(menu.getByRole('button', { name: uiText('Undo', '撤销'), exact: true })).toBeDisabled()
    await page.locator('.context-menu-overlay').click({ position: { x: 1, y: 1 } })
    await task.press('Control+Shift+z')
    await expect(task).toBeChecked()
    await expect.poll(async () => (await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))?.blocks
      .map(block => ({ content: block.content, checked: block.checked }))).toEqual([
      { content: latest, checked: false }, { content: 'Reading task', checked: true }
    ])
    await page.locator('.document-view-toggle').click()
    await expect(page.locator(`[data-block-id="${id}-body"] textarea`)).toHaveValue(latest)
  })
})

test('document save shortcut works from body and metadata and retries failed saves without losing drafts @electron', async () => {
  await withElectronApp(async ({ page, app }) => {
    const id = await openWorkflowSample(page, 'Save shortcut consistency')
    await ensureDocumentMetadataEditor(page)
    // Pause autosave so an IPC attempt proves the shortcut actually ran.
    await page.clock.install({ time: new Date() })
    await page.clock.pauseAt(new Date())
    await app.evaluate(({ ipcMain }) => {
      process.env.KNOWBOOK_EDITING_SAVE_ATTEMPTS = '0'
      ipcMain.removeHandler('knowbook:update-document')
      ipcMain.handle('knowbook:update-document', () => {
        process.env.KNOWBOOK_EDITING_SAVE_ATTEMPTS = String(Number(process.env.KNOWBOOK_EDITING_SAVE_ATTEMPTS) + 1)
        throw new Error('Editing consistency: simulated save failure')
      })
    })
    const body = page.locator(`[data-block-id="${id}-body"] textarea`)
    const title = page.locator('.document-summary-card .editor-input').first()
    const summary = page.locator('.document-summary-card .editor-textarea').first()
    const values = ['Unsaved body from shortcut', 'Unsaved title from shortcut', 'Unsaved summary from shortcut']
    for (const [index, field] of [body, title, summary].entries()) {
      await field.fill(values[index])
      await field.press('Control+s')
      await expect.poll(() => app.evaluate(() => Number(process.env.KNOWBOOK_EDITING_SAVE_ATTEMPTS))).toBe(index + 1)
      await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
      await expect(field).toHaveValue(values[index])
      await expect(field).toBeFocused()
    }
    await summary.press('Control+s')
    await expect.poll(() => app.evaluate(() => Number(process.env.KNOWBOOK_EDITING_SAVE_ATTEMPTS))).toBe(4)
    await expect(page.locator('.document-save-status')).toHaveClass(/status-error/)
    await expect(body).toHaveValue(values[0])
    await expect(title).toHaveValue(values[1])
    await expect(summary).toHaveValue(values[2])
    expect((await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))?.blocks[0].content).toBe('Original body')
    await summary.press('F1')
    const help = page.locator('.shortcut-help-dialog')
    await help.getByRole('searchbox').fill('Ctrl+S')
    await expect(help.locator('[data-shortcut-id="document-save"]')).toBeVisible()
    await expect(help.locator('[data-shortcut-id="source-apply"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(summary).toBeFocused()
  })
})
