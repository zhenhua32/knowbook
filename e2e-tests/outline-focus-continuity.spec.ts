import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type OutlineFocusCall = { preventScroll: boolean; beforeScroll: number | null; afterScroll: number | null }
type ProbeWindow = Window & { __knowbookOutlineFocusProbe?: { element: HTMLButtonElement; calls: OutlineFocusCall[] } }

function controls(page: Page) {
  const navigation = page.locator('.document-navigation-bar')
  const popover = page.locator('.document-outline-popover')
  return { popover, toggle: navigation.locator('.document-outline-control > button'),
    filter: popover.getByRole('searchbox', { name: uiText('Filter headings…', '筛选章节…'), exact: true }),
    foldAll: popover.getByRole('button', { name: uiText('Fold all', '全部折叠'), exact: true }),
    expandAll: popover.getByRole('button', { name: uiText('Expand all', '全部展开'), exact: true }),
    find: navigation.getByRole('button', { name: uiText('Find', '查找'), exact: true }),
    read: navigation.getByRole('button', { name: uiText('Read', '阅读'), exact: true }) }
}

async function watchToggleFocus(toggle: Locator) {
  await toggle.evaluate(element => {
    const button = element as HTMLButtonElement
    const nativeFocus = button.focus
    const probe = { element: button, calls: [] as OutlineFocusCall[] }
    ;(window as ProbeWindow).__knowbookOutlineFocusProbe = probe
    // Observe the real element and delegate unchanged to its native focus.
    // Actual Tab transitions and document navigation remain browser-driven.
    button.focus = options => {
      const canvas = button.closest<HTMLElement>('.preview-panel')
      const beforeScroll = canvas?.scrollTop ?? null
      nativeFocus.call(button, options)
      probe.calls.push({ preventScroll: options?.preventScroll === true, beforeScroll, afterScroll: canvas?.scrollTop ?? null })
    }
  })
}

async function focusCalls(page: Page) {
  return page.evaluate(() => (window as ProbeWindow).__knowbookOutlineFocusProbe!.calls)
}

async function tabInsideTo(page: Page, target: Locator) {
  const current = controls(page)
  for (let step = 0; step < 8; step++) {
    if (await target.evaluate(element => element === document.activeElement)) return
    await page.keyboard.press('Tab')
    await expect(current.popover).toBeVisible()
  }
  await expect(target).toBeFocused()
}

async function openOutline(page: Page) {
  const current = controls(page)
  await expect(current.popover).toHaveCount(0)
  await current.toggle.focus()
  await page.keyboard.press('Enter')
  await expect(current.popover).toBeVisible()
  await expect(current.toggle).toHaveAttribute('aria-expanded', 'true')
  return current
}

async function settleFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const popover = document.querySelector('.document-outline-popover')
    const bounds = popover?.getBoundingClientRect()
    return { activeTag: document.activeElement?.tagName, activeLabel: document.activeElement?.getAttribute('aria-label'),
      activeText: document.activeElement?.tagName === 'BUTTON' ? document.activeElement.textContent : null,
      outlineOpen: Boolean(popover), findOpen: Boolean(document.querySelector('.block-find-panel')),
      toggleExpanded: document.querySelector('.document-outline-control > button')?.getAttribute('aria-expanded'),
      viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      outlineRect: bounds ? { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right } : null,
      focusCalls: (window as ProbeWindow).__knowbookOutlineFocusProbe!.calls }
  })
  await testInfo.attach(phase, { body: JSON.stringify({ windows, state }, null, 2), contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`outline closes when keyboard focus leaves and preserves the user's next focus (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const title = language === 'zh-CN' ? '大纲焦点连续性样本' : 'Outline focus continuity sample'
      const headings = language === 'zh-CN' ? ['第一章', '第二章', '第三章'] : ['First section', 'Second section', 'Third section']
      const blocks: DocumentBlockDraft[] = headings.flatMap<DocumentBlockDraft>((heading, section) => [
        { type: 'heading-1', content: heading, checked: false, depth: 0 },
        { type: 'paragraph', content: Array.from({ length: 24 }, (_, line) => `Section ${section + 1}, unchanged paragraph line ${line + 1}.`).join('\n'), checked: false, depth: 0 }
      ])
      const id = await page.evaluate(async ({ title, blocks, language }) => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        const { id } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(id, { title, summary: 'Three headings, no content edits.', blocks })
        return id
      }, { title, blocks, language })
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize({ width: 760, height: language === 'zh-CN' ? 850 : 640 })
      await page.locator('.tree-button', { hasText: title }).first().focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('.block-editor-row')).toHaveCount(6)
      const before = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
      expect(before).not.toBeNull()
      await watchToggleFocus(controls(page).toggle)

      let current = await openOutline(page)
      await expect(current.popover.locator('.toc-item')).toHaveCount(3)
      await page.keyboard.press('Tab'); await expect(current.foldAll).toBeFocused()
      await expect(current.popover).toBeVisible()
      await page.keyboard.press('Shift+Tab'); await expect(current.toggle).toBeFocused()
      await expect(current.popover).toBeVisible()
      await page.keyboard.press('Tab'); await expect(current.foldAll).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.expandAll).toBeFocused()
      await expect(current.popover).toBeVisible()
      await tabInsideTo(page, current.filter)
      await expect(current.filter).toBeFocused()
      await current.filter.fill('NoHeadingCanMatchThisFilter')
      await expect(current.popover.locator('.toc-item')).toHaveCount(0)
      await expect(current.popover.locator('.empty-text')).toHaveText(uiText('No matching headings', '没有匹配的章节'))
      let callsBefore = (await focusCalls(page)).length
      await record(page, app, testInfo, 'empty-outline-filter-before-tab')
      await page.keyboard.press('Tab')
      // Capture the actual old-build state before asserting automatic dismissal.
      await record(page, app, testInfo, 'tab-leaves-empty-outline-for-find')
      await expect(current.popover).toHaveCount(0)
      await expect(current.find).toBeFocused()
      await expect(current.toggle).toHaveAttribute('aria-expanded', 'false')
      expect((await focusCalls(page)).length).toBe(callsBefore)
      await page.keyboard.press('Tab'); await expect(current.read).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(current.find).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(current.toggle).toBeFocused()
      await expect(current.popover).toHaveCount(0)
      expect((await focusCalls(page)).length).toBe(callsBefore)

      current = await openOutline(page)
      await tabInsideTo(page, current.filter)
      callsBefore = (await focusCalls(page)).length
      await page.keyboard.press('Control+f')
      const findInput = page.locator('.block-find-input')
      await expect(findInput).toBeFocused()
      await record(page, app, testInfo, 'ctrl-find-from-outline-filter')
      await expect(current.popover).toHaveCount(0)
      await expect(page.locator('.block-find-panel')).toHaveCount(1)
      expect((await focusCalls(page)).length).toBe(callsBefore)
      await page.keyboard.press('Escape')
      await expect(page.locator('.block-find-panel')).toHaveCount(0)
      await expect(current.find).toBeFocused()
      expect((await focusCalls(page)).length).toBe(callsBefore)

      // Explicit Escape and heading selection keep their existing return path.
      current = await openOutline(page)
      await tabInsideTo(page, current.filter)
      callsBefore = (await focusCalls(page)).length
      await page.keyboard.press('Escape')
      await expect(current.popover).toHaveCount(0)
      await expect(current.toggle).toBeFocused()
      expect((await focusCalls(page)).length).toBe(callsBefore + 1)

      current = await openOutline(page)
      await tabInsideTo(page, current.filter)
      await current.filter.fill(headings[1])
      const secondHeading = current.popover.getByRole('button', { name: headings[1], exact: true })
      await expect(current.popover.locator('.toc-item')).toHaveCount(1)
      await tabInsideTo(page, secondHeading)
      callsBefore = (await focusCalls(page)).length
      await page.keyboard.press('Enter')
      await expect(current.popover).toHaveCount(0)
      await expect(current.toggle).toBeFocused()
      expect((await focusCalls(page)).length).toBe(callsBefore + 1)
      const selectionFocus = (await focusCalls(page)).at(-1)!
      expect(selectionFocus.preventScroll).toBe(true)
      expect(selectionFocus.afterScroll).toBe(selectionFocus.beforeScroll)
      await expect(page.locator('.document-current-heading')).toHaveText(headings[1])
      await record(page, app, testInfo, 'heading-selection-returns-to-toggle')

      // This is an explicit DOM focus move, not a claim of native Tab input.
      current = await openOutline(page)
      await tabInsideTo(page, current.filter)
      callsBefore = (await focusCalls(page)).length
      const editor = page.locator('.block-editor-row[data-block-index="5"] textarea')
      await editor.focus()
      await expect(current.popover).toHaveCount(0)
      await settleFrames(page)
      await expect(editor).toBeFocused()
      expect((await focusCalls(page)).length).toBe(callsBefore)
      await record(page, app, testInfo, 'external-editor-focus-kept')

      const after = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
      expect(after).toEqual(before)
    })
  })
}
