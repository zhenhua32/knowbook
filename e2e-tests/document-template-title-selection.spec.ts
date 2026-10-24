import { expect, test } from '@playwright/test'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { withElectronFailureTrace } from './helpers/electron-failure-trace'

type TitleSelectionProbe = { selected: boolean; selection: { value: string; start: number | null; end: number | null } | null }

for (const language of ['en-US', 'zh-CN']) {
  test(`template title is committed before native selection and replacement in ${language} @electron`, async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
    await withElectronFailureTrace(info, async ({ page }) => {
      await page.evaluate(language => window.knowbook.saveSetting('ui.language', language), language)
      await page.reload()
      await expect(page.getByRole('button', { name: language === 'zh-CN' ? '从模板新建' : 'New from template', exact: true })).toBeVisible()
      const template = await page.evaluate(() => window.knowbook.saveDocumentTemplate({
        name: 'Native title selection', title: '尚未保存的模板标题', summary: 'Native title selection summary',
        blocks: [{ type: 'paragraph', content: 'Independent template {{title}}', checked: false, depth: 0 }]
      }))
      await page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true }).click()
      const dialog = page.getByRole('dialog', { name: uiText('From template', '从模板新建') })
      const item = dialog.getByRole('button', { name: /Native title selection/ })
      await expect(item).toHaveAttribute('aria-pressed', 'false')
      const input = dialog.locator('[name="document-title"]')
      await expect(input).not.toHaveValue(template.title)

      // Select immediately after the actual selected-item DOM commit. A late
      // passive default-title update used to replace this value and collapse
      // the native range before insertText, causing the old title to prefix it.
      await page.evaluate(() => {
        const state = window as typeof window & { __templateTitleSelection?: TitleSelectionProbe }
        const dialog = document.querySelector<HTMLDialogElement>('.document-template-dialog')!
        const input = dialog.querySelector<HTMLInputElement>('[name="document-title"]')!
        const item = [...dialog.querySelectorAll<HTMLButtonElement>('.document-template-item')]
          .find(button => button.textContent?.includes('Native title selection'))!
        const probe: TitleSelectionProbe = { selected: false, selection: null }
        state.__templateTitleSelection = probe
        const observer = new MutationObserver(() => {
          if (item.getAttribute('aria-pressed') !== 'true' || probe.selected) return
          probe.selected = true
          input.focus()
          input.select()
          probe.selection = { value: input.value, start: input.selectionStart, end: input.selectionEnd }
          observer.disconnect()
        })
        observer.observe(item, { attributes: true, attributeFilter: ['aria-pressed'] })
      })
      await item.click()
      const selection = await page.evaluate(() => {
        const state = window as typeof window & { __templateTitleSelection?: TitleSelectionProbe }
        const probe = state.__templateTitleSelection!
        delete state.__templateTitleSelection
        return probe
      })
      expect(selection).toEqual({ selected: true, selection: { value: template.title, start: 0, end: template.title.length } })
      const title = language === 'en-US' ? 'Independent native copy B' : '草稿模板副本 B'
      await page.keyboard.insertText(title)
      await expect(input).toHaveValue(title)
      await dialog.getByRole('button', { name: uiText('Create document', '创建文档'), exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.locator('.document-header-title')).toHaveText(title)
      const persisted = await page.evaluate(async title => {
        const document = (await window.knowbook.getDocumentCatalog()).find(document => document.title === title)
        return document ? window.knowbook.getDocumentDetail(document.id) : null
      }, title)
      expect(persisted?.title).toBe(title)
      expect(persisted?.summary).toBe(template.summary)
      expect(persisted?.blocks[0].content).toBe(`Independent template ${title}`)
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
