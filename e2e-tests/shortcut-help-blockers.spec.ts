import { expect, test } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

test('retained hidden or inert drafts permit shortcut help while visible dialogs remain protected @electron', async () => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async ({ page }) => {
    const trigger = page.getByRole('button', { name: uiText('Keyboard shortcuts', '快捷键帮助'), exact: true })
    const help = page.getByRole('dialog', { name: uiText('Keyboard shortcuts', '快捷键帮助'), exact: true })
    // Settings retain conflict editors while another category is shown.
    await page.evaluate(() => {
      const panel = document.createElement('section')
      panel.id = 'retained-shortcut-panel'
      panel.hidden = true
      const editor = document.createElement('div')
      editor.setAttribute('data-block-shortcuts', '')
      const input = document.createElement('textarea')
      input.value = 'Retained conflict draft'
      editor.append(input); panel.append(editor); document.body.append(panel)
    })
    const panel = page.locator('#retained-shortcut-panel')
    for (const mode of ['hidden', 'inert']) {
      await panel.evaluate((element, mode) => {
        element.toggleAttribute('hidden', mode === 'hidden')
        element.toggleAttribute('inert', mode === 'inert')
      }, mode)
      await trigger.click(); await expect(help).toBeVisible()
      await page.keyboard.press('Escape'); await expect(help).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await page.keyboard.press('F1'); await expect(help).toBeVisible()
      await page.keyboard.press('Escape'); await expect(help).toHaveCount(0)
      await expect(panel.locator('textarea')).toHaveValue('Retained conflict draft')
    }
    await panel.evaluate(element => { element.removeAttribute('hidden'); element.removeAttribute('inert') })
    await trigger.click(); await expect(help).toHaveCount(0)
    await page.keyboard.press('F1'); await expect(help).toHaveCount(0)
    await expect(panel.locator('textarea')).toHaveValue('Retained conflict draft')
    await panel.evaluate(element => element.remove())
    await page.getByRole('button', { name: uiText('More actions', '更多操作'), exact: true }).click()
    await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Delete', '删除'), exact: true }).click()
    const confirmation = page.getByRole('alertdialog', { name: uiText('Delete document', '删除文档'), exact: true })
    await expect(confirmation).toBeVisible()
    await page.keyboard.press('F1'); await expect(help).toHaveCount(0)
    await expect(confirmation).toBeVisible()
    await page.keyboard.press('Escape'); await expect(confirmation).toHaveCount(0)
    await trigger.click(); await expect(help).toBeVisible()
  })
})
