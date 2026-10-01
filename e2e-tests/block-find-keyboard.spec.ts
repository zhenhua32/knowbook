import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

const needle = 'KeyboardNeedle'
const contents = [
  `${needle} — first matching paragraph / 第一处匹配`,
  Array.from({ length: 24 }, (_, index) => `First intervening paragraph, line ${index + 1}.`).join('\n'),
  `${needle} — second matching paragraph / 第二处匹配`,
  Array.from({ length: 24 }, (_, index) => `Second intervening paragraph, line ${index + 1}.`).join('\n'),
  `${needle} — third matching paragraph / 第三处匹配`,
  Array.from({ length: 32 }, (_, index) => `Trailing paragraph, line ${index + 1}.`).join('\n')
]

function controls(page: Page) {
  const panel = page.locator('.block-find-panel')
  return { panel, input: panel.locator('.block-find-input'), count: panel.locator('.block-find-count'),
    previous: panel.getByRole('button', { name: uiText('Previous match', '上一个匹配'), exact: true }),
    next: panel.getByRole('button', { name: uiText('Next match', '下一个匹配'), exact: true }),
    close: panel.getByRole('button', { name: uiText('Close find', '关闭查找'), exact: true }),
    result: (index: number) => panel.locator(`.block-find-result[data-result-index="${index}"]`) }
}

async function openFind(page: Page, query = needle) {
  const current = controls(page)
  await expect(current.panel).toHaveCount(0)
  await page.keyboard.press('Control+f')
  await expect(current.input).toBeFocused()
  await expect(current.input).toHaveAccessibleName(uiText('Search blocks (Cmd+F to close)...', '搜索块内容（按 Cmd/Ctrl+F 关闭）...'))
  await current.input.fill(query)
  return current
}

async function expectMatch(page: Page, resultIndex: number) {
  const current = controls(page)
  await expect(current.count).toHaveText(`${resultIndex + 1} / 3`)
  await expect(current.result(resultIndex)).toHaveClass(/block-find-result-active/)
  const blockIndex = resultIndex * 2
  await expect(current.result(resultIndex).locator('.block-find-result-preview')).toHaveText(contents[blockIndex])
  await expect(current.input).toBeFocused()
  const row = page.locator(`.block-editor-row[data-block-index="${blockIndex}"]`)
  await expect(row.locator('textarea')).toHaveValue(contents[blockIndex])
  // Verify actual document navigation, not just the count/list highlight.
  await expect.poll(() => row.evaluate(element => {
    const canvas = element.closest('.preview-panel')!
    return element.getBoundingClientRect().top - canvas.querySelector('.document-sticky-header')!.getBoundingClientRect().bottom
  })).toBeGreaterThanOrEqual(10)
  await expect.poll(() => row.evaluate(element => {
    const canvas = element.closest('.preview-panel')!
    return element.getBoundingClientRect().top - canvas.querySelector('.document-sticky-header')!.getBoundingClientRect().bottom
  })).toBeLessThan(20)
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => ({ count: document.querySelector('.block-find-count')?.textContent ?? null,
    activeTag: document.activeElement?.tagName, activeLabel: document.activeElement?.getAttribute('aria-label'),
    activeResult: document.querySelector('.block-find-result-active')?.getAttribute('data-result-index') ?? null,
    findOpen: Boolean(document.querySelector('.block-find-panel')) }))
  await testInfo.attach(phase, { body: JSON.stringify({ windows, state }, null, 2), contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`document find buttons retain native keyboard activation and do not change content (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const title = language === 'zh-CN' ? '文内查找键盘样本' : 'Document find keyboard sample'
      const blocks: DocumentBlockDraft[] = contents.map(content => ({ type: 'paragraph', content, checked: false, depth: 0 }))
      const id = await page.evaluate(async ({ title, blocks, language }) => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        const { id } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(id, { title, summary: 'Three separated matches / 三个分散匹配', blocks })
        return id
      }, { title, blocks, language })
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize({ width: 1080, height: 850 })
      const documentButton = page.locator('.tree-button', { hasText: title }).first()
      await documentButton.focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('.block-editor-row')).toHaveCount(contents.length)
      const before = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
      expect(before).not.toBeNull()

      // The old container handler prevents Enter on Close and selects a match.
      // Save the actual post-Enter state before asserting, for the old-build run.
      let current = await openFind(page)
      await expect(current.count).toHaveText('1 / 3')
      await expect(current.panel.locator('.block-find-result')).toHaveCount(3)
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await record(page, app, testInfo, 'close-with-results-focused')
      await page.keyboard.press('Enter')
      await record(page, app, testInfo, 'close-with-results-after-enter')
      await expect(current.panel).toHaveCount(0)

      current = await openFind(page, 'ThisQueryHasNoMatchingBlocks')
      await expect(current.previous).toBeDisabled()
      await expect(current.next).toBeDisabled()
      await expect(current.count).toHaveText(uiText('No blocks match your search.', '没有匹配的块。'))
      await expect(current.panel.locator('.block-find-result')).toHaveCount(0)
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(current.input).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Enter')
      await record(page, app, testInfo, 'close-with-no-results-after-enter')
      await expect(current.panel).toHaveCount(0)

      current = await openFind(page)
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Enter'); await expectMatch(page, 2)
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Enter'); await expectMatch(page, 0)
      // Space continues to use the native button click behavior.
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Space'); await expectMatch(page, 1)
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Space'); await expectMatch(page, 0)
      await page.keyboard.press('Escape')
      await expect(current.panel).toHaveCount(0)

      // Choose a non-active result via actual forward/backward Tab navigation.
      current = await openFind(page)
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.result(0)).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.result(1)).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.result(2)).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(current.result(1)).toBeFocused()
      await expect(current.result(1)).not.toHaveClass(/block-find-result-active/)
      await page.keyboard.press('Enter'); await expectMatch(page, 1)
      await record(page, app, testInfo, 'specific-result-enter-selected-second-block')
      await page.keyboard.press('Escape')
      await expect(current.panel).toHaveCount(0)

      current = await openFind(page)
      await page.keyboard.press('Enter'); await expectMatch(page, 0)
      await page.keyboard.press('Enter'); await expectMatch(page, 1)
      await page.keyboard.press('Shift+Enter'); await expectMatch(page, 0)
      await page.keyboard.press('Shift+Enter'); await expectMatch(page, 2)
      await page.keyboard.press('ArrowDown'); await expectMatch(page, 0)
      await page.keyboard.press('ArrowUp'); await expectMatch(page, 2)
      await page.keyboard.press('ArrowUp'); await expectMatch(page, 1)

      await current.input.dispatchEvent('compositionstart', { data: 'zhong' })
      await page.keyboard.press('Enter')
      await page.keyboard.press('Escape')
      await page.keyboard.press('ArrowDown')
      await expect(current.input).toBeFocused()
      await expect(current.count).toHaveText('2 / 3')
      await current.input.dispatchEvent('compositionend', { data: '' })
      const acceptedImeEvents = await current.input.evaluate(input => [
        { key: 'Enter', isComposing: true }, { key: 'Escape', isComposing: true },
        { key: 'ArrowDown', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'Escape', keyCode: 229 }
      ].map(event => input.dispatchEvent(new KeyboardEvent('keydown', { ...event, bubbles: true, cancelable: true }))))
      expect(acceptedImeEvents.every(Boolean)).toBe(true)
      await expect(current.count).toHaveText('2 / 3')
      await expect(current.input).toHaveValue(needle)
      await page.keyboard.press('Enter'); await expectMatch(page, 2)
      // Blurring during a composition also releases the input's composition ref.
      await current.input.dispatchEvent('compositionstart', { data: 'zhong' })
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(current.input).toBeFocused()
      await page.keyboard.press('Enter'); await expectMatch(page, 0)
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Space')
      await expect(current.panel).toHaveCount(0)

      const after = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
      expect(after).not.toBeNull()
      expect(after).toEqual(before)
      await record(page, app, testInfo, 'keyboard-find-complete-content-unchanged')
    })
  })
}
